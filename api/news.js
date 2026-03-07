module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  var naverClientId = process.env.NAVER_CLIENT_ID;
  var naverClientSecret = process.env.NAVER_CLIENT_SECRET;
  var clovaApiKey = process.env.CLOVA_API_KEY;

  if (!naverClientId || !naverClientSecret) {
    return res.status(500).json({ error: 'API 키가 설정되지 않았습니다.' });
  }

  try {
    // 1차: 구글 트렌드 RSS -> 실시간 키워드 추출
    var trendKeywords = [];
    try {
      var rssRes = await fetch(
        'https://trends.google.com/trends/trendingsearches/daily/rss?geo=KR',
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      var rssText = await rssRes.text();
      var matches = rssText.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/g) || [];
      trendKeywords = matches
        .map(function(m) {
          return m.replace(/<title><!\[CDATA\[/, '').replace(/\]\]><\/title>/, '').trim();
        })
        .filter(function(k) {
          return k && k !== '대한민국의 인기 검색어';
        })
        .slice(0, 10);
    } catch (e) {
      console.error('구글 트렌드 RSS 실패:', e);
    }

    if (trendKeywords.length === 0) {
      trendKeywords = ['속보', '정치', '경제', '국제', '사회'];
    }

    // 2차: 네이버 뉴스 API -> 키워드별 뉴스 수집
    var allNews = [];
    for (var i = 0; i < trendKeywords.length; i++) {
      var keyword = trendKeywords[i];
      try {
        var naverUrl = 'https://openapi.naver.com/v1/search/news.json?query=' + encodeURIComponent(keyword) + '&display=2&sort=date';
        var response = await fetch(naverUrl, {
          headers: {
            'X-Naver-Client-Id': naverClientId,
            'X-Naver-Client-Secret': naverClientSecret,
          },
        });
        var data = await response.json();
        if (data.items) {
          allNews = allNews.concat(data.items);
        }
      } catch (e) {
        console.error('키워드 뉴스 수집 실패:', e);
      }
    }

    // HTML 특수문자 변환 함수
    function decodeHtml(str) {
      if (!str) return '';
      return str
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
        .replace(/<[^>]*>/g, '')
        .trim();
    }

    // 중복 제거
    var seen = new Set();
    var unique = allNews.filter(function(item) {
      var clean = decodeHtml(item.title);
      if (seen.has(clean)) return false;
      seen.add(clean);
      return true;
    });

    // 정제된 20개
    var cleaned = unique.slice(0, 20).map(function(item, idx) {
      return {
        no: idx + 1,
        title: decodeHtml(item.title),
        description: decodeHtml(item.description),
        pubDate: item.pubDate,
        link: item.link,
      };
    });

    // HyperCLOVA X 없으면 그대로 반환
    if (!clovaApiKey) {
      return res.status(200).json({
        items: cleaned.slice(0, 5),
        source: 'naver-only',
        keywords: trendKeywords,
      });
    }

    // 3차: HyperCLOVA X -> TOP 5 선별
    var newsListText = cleaned.map(function(n) {
      return n.no + '. ' + n.title;
    }).join('\n');

    var systemPrompt = '당신은 한국 뉴스 큐레이터입니다.\n번호가 붙은 뉴스 제목 목록을 받으면 가장 중요한 5개의 번호와 다듬은 제목만 반환하세요.\n다른 말은 절대 하지 마세요.\n\n출력 형식 (반드시 이 JSON만 출력):\n{"top5":[{"rank":1,"no":3,"title":"다듬은 제목"},{"rank":2,"no":7,"title":"다듬은 제목"}]}\n\n규칙:\n- 광고, 연예, 스포츠, 낚시성 기사 제외\n- 정치, 경제, 사회, 국제 이슈 우선\n- title은 30자 이내로 자연스럽게 다듬기\n- no는 반드시 입력받은 번호 그대로 사용';

    var userPrompt = '다음 뉴스 목록에서 TOP 5를 선별해줘:\n\n' + newsListText;

    var clovaRes = await fetch(
      'https://clovastudio.stream.ntruss.com/v1/api-tools/openai/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + clovaApiKey,
        },
        body: JSON.stringify({
          model: 'HCX-DASH-002',
          max_tokens: 500,
          temperature: 0.3,
          top_p: 0.8,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        }),
      }
    );

    var clovaData = await clovaRes.json();
    var rawText = (clovaData && clovaData.choices && clovaData.choices[0] && clovaData.choices[0].message && clovaData.choices[0].message.content) ? clovaData.choices[0].message.content : '';

    // JSON 파싱
    var top5 = [];
    try {
      var jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        var parsed = JSON.parse(jsonMatch[0]);
        top5 = parsed.top5 || [];
      }
    } catch (e) {
      console.error('JSON 파싱 실패:', e);
    }

    // 원문 description 매칭
    var result = top5.map(function(item) {
      var original = cleaned.find(function(n) { return n.no === item.no; });
      return {
        rank: item.rank,
        title: item.title,
        description: original ? original.description : '',
        link: original ? original.link : '',
        pubDate: original ? original.pubDate : '',
      };
    });

    // fallback
    if (result.length === 0) {
      return res.status(200).json({
        items: cleaned.slice(0, 5).map(function(n, i) {
          return {
            rank: i + 1,
            title: n.title,
            description: n.description,
            link: n.link,
            pubDate: n.pubDate,
          };
        }),
        source: 'fallback',
        keywords: trendKeywords,
      });
    }

    return res.status(200).json({
      items: result,
      source: 'hyperclovax',
      keywords: trendKeywords,
    });

  } catch (error) {
    console.error('전체 오류:', error);
    return res.status(500).json({ error: '뉴스를 가져오는데 실패했습니다.' });
  }
};
