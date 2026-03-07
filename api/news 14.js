module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  var naverClientId = process.env.NAVER_CLIENT_ID;
  var naverClientSecret = process.env.NAVER_CLIENT_SECRET;
  var clovaApiKey = process.env.CLOVA_API_KEY;

  if (!naverClientId || !naverClientSecret) {
    return res.status(500).json({ error: '네이버 API 키가 설정되지 않았습니다.' });
  }

  try {
    // 1차: 구글 트렌드 RSS → 실패시 기본 키워드
    var trendKeywords = [];
    try {
      var rssRes = await fetch(
        'https://trends.google.com/trends/trendingsearches/daily/rss?geo=KR',
        { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }, signal: AbortSignal.timeout(3000) }
      );
      var rssText = await rssRes.text();
      var matches = rssText.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/g) || [];
      trendKeywords = matches
        .map(function(m) {
          return m.replace(/<title><!\[CDATA\[/, '').replace(/\]\]><\/title>/, '').trim();
        })
        .filter(function(k) { return k && k !== '대한민국의 인기 검색어'; })
        .slice(0, 10);
      console.log('구글 트렌드 성공:', trendKeywords.length + '개');
    } catch (e) {
      console.error('구글 트렌드 RSS 실패:', e.message);
    }

    if (trendKeywords.length === 0) {
      trendKeywords = ['이스라엘 이란', '한동훈', '코스피', '주한미군', '미국 관세', '부동산', '대선', '환율', '북한', '경제'];
      console.log('기본 키워드 사용');
    }

    // 2차: 네이버 뉴스 API
    var allNews = [];
    for (var i = 0; i < trendKeywords.length; i++) {
      try {
        var naverUrl = 'https://openapi.naver.com/v1/search/news.json?query=' + encodeURIComponent(trendKeywords[i]) + '&display=2&sort=date';
        var response = await fetch(naverUrl, {
          headers: {
            'X-Naver-Client-Id': naverClientId,
            'X-Naver-Client-Secret': naverClientSecret
          }
        });
        var data = await response.json();
        if (data.items) allNews = allNews.concat(data.items);
      } catch (e) {
        console.error('키워드 뉴스 수집 실패:', e.message);
      }
    }

    function decodeHtml(str) {
      if (!str) return '';
      return str
        .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'").replace(/<[^>]*>/g, '').trim();
    }

    var seen = new Set();
    var unique = allNews.filter(function(item) {
      var clean = decodeHtml(item.title);
      if (seen.has(clean)) return false;
      seen.add(clean);
      return true;
    });

    var cleaned = unique.slice(0, 20).map(function(item, idx) {
      return {
        no: idx + 1,
        title: decodeHtml(item.title),
        description: decodeHtml(item.description),
        pubDate: item.pubDate,
        link: item.link
      };
    });

    // CLOVA 없으면 원문 그대로 반환
    if (!clovaApiKey) {
      return res.status(200).json({
        items: cleaned.slice(0, 10).map(function(n, i) {
          return { rank: i + 1, title: n.title, description: n.description, link: n.link, pubDate: n.pubDate };
        }),
        source: 'naver-only',
        keywords: trendKeywords
      });
    }

    // 3차: HyperCLOVA X 1단계 — 번호+점수만 받기 (15개)
    var newsListText = cleaned.map(function(n) {
      return n.no + '. ' + n.title;
    }).join('\n');

    var systemPrompt1 = [
      '뉴스 편집장입니다. 아래 규칙을 반드시 따르세요.',
      '',
      '[필터링]',
      '- 광고성, 낚시성, 어뷰징 기사 제외',
      '- 연예/스포츠/날씨 제외 (사회적 파장 큰 경우 포함)',
      '- 같은 사건 중복 시 1개만',
      '',
      '[출력 규칙]',
      '- JSON 배열만 출력. 다른 말 금지.',
      '- 형식: [{"no":번호,"score":점수},...]',
      '- score: 1~10 정수. 사회적 파장 클수록 높게.',
      '- 정확히 15개 출력.'
    ].join('\n');

    var requestId1 = Date.now().toString(16) + Math.random().toString(16).slice(2);

    var clovaRes1 = await fetch(
      'https://clovastudio.stream.ntruss.com/v3/chat-completions/HCX-DASH-002',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + clovaApiKey,
          'X-NCP-CLOVASTUDIO-REQUEST-ID': requestId1
        },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: systemPrompt1 },
            { role: 'user', content: '다음 뉴스에서 중요한 15개를 골라 점수를 매겨줘:\n\n' + newsListText }
          ],
          topP: 0.8, topK: 0, maxTokens: 200,
          temperature: 0.1, repetitionPenalty: 1.2,
          stop: [], seed: 0, includeAiFilters: true
        })
      }
    );

    var rawText1 = '';
    try {
      var clovaJson1 = JSON.parse(await clovaRes1.text());
      if (clovaJson1.result && clovaJson1.result.message) {
        rawText1 = clovaJson1.result.message.content.trim();
      }
    } catch(e) { console.error('1단계 파싱 실패:', e.message); }

    console.log('1단계 응답:', rawText1.slice(0, 300));

    // score 내림차순 정렬 → 상위 10개 원문 추출
    var top10 = [];
    try {
      var json1 = rawText1.replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/\s*```$/,'').trim();
      var scored = JSON.parse(json1);
      if (Array.isArray(scored)) {
        scored.sort(function(a,b){ return (b.score||0)-(a.score||0); });
        top10 = scored.slice(0,10).map(function(item) {
          return cleaned.find(function(n){ return n.no === item.no; }) || null;
        }).filter(Boolean);
      }
    } catch(e) { console.error('1단계 결과 파싱 실패:', e.message); }

    // 1단계 실패 시 원문 상위 10개로 fallback
    if (top10.length === 0) {
      return res.status(200).json({
        items: cleaned.slice(0,10).map(function(n,i){
          return { rank:i+1, title:n.title, description:n.description, link:n.link, pubDate:n.pubDate };
        }),
        source: 'fallback',
        keywords: trendKeywords
      });
    }

    // 4차: HyperCLOVA X 2단계 — 선별된 10개만 제목+요약 가공
    var top10Text = top10.map(function(n, i) {
      return (i+1) + '. [제목] ' + n.title + '\n   [설명] ' + (n.description||'').slice(0,80);
    }).join('\n');

    var systemPrompt2 = [
      '방송 뉴스 편집장입니다. 아래 규칙을 반드시 따르세요.',
      '',
      '[제목 작성]',
      '- 방송 뉴스 1보 헤드라인처럼 작성',
      '- 예시: "한동훈, 코스피 발언 논란에 직접 해명", "미군 수송기, 오산기지 전격 출격"',
      '- 주어+동사 구조로 사건 명확히 전달',
      '- 25자 이내, 특수문자/대괄호/따옴표 사용 금지',
      '',
      '[출력 규칙]',
      '- JSON 배열만 출력. 다른 말 절대 금지.',
      '- 형식: [{"idx":순번,"title":"헤드라인","summary":"핵심요약(30자이내)"},...]',
      '- 정확히 10개 출력.'
    ].join('\n');

    var requestId2 = Date.now().toString(16) + Math.random().toString(16).slice(2);

    var clovaRes2 = await fetch(
      'https://clovastudio.stream.ntruss.com/v3/chat-completions/HCX-DASH-002',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + clovaApiKey,
          'X-NCP-CLOVASTUDIO-REQUEST-ID': requestId2
        },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: systemPrompt2 },
            { role: 'user', content: '다음 뉴스 10개의 제목과 요약을 만들어줘:\n\n' + top10Text }
          ],
          topP: 0.8, topK: 0, maxTokens: 800,
          temperature: 0.1, repetitionPenalty: 1.2,
          stop: [], seed: 0, includeAiFilters: true
        })
      }
    );

    var rawText2 = '';
    try {
      var clovaJson2 = JSON.parse(await clovaRes2.text());
      if (clovaJson2.result && clovaJson2.result.message) {
        rawText2 = clovaJson2.result.message.content.trim();
      }
    } catch(e) { console.error('2단계 파싱 실패:', e.message); }

    console.log('2단계 응답:', rawText2.slice(0, 400));

    // 최종 결과 조합
    var result = [];
    try {
      var json2 = rawText2.replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/\s*```$/,'').trim();
      var polished = JSON.parse(json2);
      if (Array.isArray(polished)) {
        result = polished.slice(0,10).map(function(item, i) {
          var original = top10[item.idx - 1] || top10[i] || {};
          return {
            rank: i + 1,
            title: item.title || original.title || '',
            description: item.summary || original.description || '',
            link: original.link || '',
            pubDate: original.pubDate || ''
          };
        });
      }
    } catch(e) { console.error('2단계 결과 파싱 실패:', e.message); }

    // 파싱 실패 시 원문 fallback
    if (result.length === 0) {
      return res.status(200).json({
        items: cleaned.slice(0, 10).map(function(n, i) {
          return { rank: i + 1, title: n.title, description: n.description, link: n.link, pubDate: n.pubDate };
        }),
        source: 'fallback',
        keywords: trendKeywords
      });
    }

    return res.status(200).json({
      items: result,
      source: 'hyperclovax',
      keywords: trendKeywords
    });

  } catch (error) {
    console.error('전체 오류:', error.message);
    return res.status(500).json({ error: '뉴스를 가져오는데 실패했습니다.' });
  }
}
