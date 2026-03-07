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
    // 1차: 실시간 키워드 (구글 트렌드 RSS → 실패시 네이버 뉴스 인기 카테고리)
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
        .filter(function(k) {
          return k && k !== '대한민국의 인기 검색어';
        })
        .slice(0, 10);
      console.log('구글 트렌드 성공:', trendKeywords.length + '개');
    } catch (e) {
      console.error('구글 트렌드 RSS 실패:', e.message);
    }

    // 구글 트렌드 실패시 네이버 카테고리별 키워드 사용
    if (trendKeywords.length === 0) {
      trendKeywords = ['이스라엘 이란', '한동훈', '코스피', '주한미군', '미국 관세', '부동산', '대선', '환율', '북한', '경제'];
      console.log('기본 키워드 사용');
    }

    // 2차: 네이버 뉴스 API
    var allNews = [];
    for (var i = 0; i < trendKeywords.length; i++) {
      var keyword = trendKeywords[i];
      try {
        var naverUrl = 'https://openapi.naver.com/v1/search/news.json?query=' + encodeURIComponent(keyword) + '&display=2&sort=date';
        var response = await fetch(naverUrl, {
          headers: {
            'X-Naver-Client-Id': naverClientId,
            'X-Naver-Client-Secret': naverClientSecret
          }
        });
        var data = await response.json();
        if (data.items) {
          allNews = allNews.concat(data.items);
        }
      } catch (e) {
        console.error('키워드 뉴스 수집 실패:', e.message);
      }
    }

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

    if (!clovaApiKey) {
      return res.status(200).json({
        items: cleaned.slice(0, 10).map(function(n, i) {
          return { rank: i + 1, title: n.title, description: n.description, link: n.link, pubDate: n.pubDate };
        }),
        source: 'naver-only',
        keywords: trendKeywords
      });
    }

    var newsListText = cleaned.map(function(n) {
      return n.no + '. ' + n.title;
    }).join('\n');

    var systemPrompt = '뉴스 큐레이터입니다. 아래 규칙을 반드시 지키세요.\n\n[출력 규칙]\n- 숫자 10개만 골라서 쉼표로 구분해 출력\n- 예시: 3,7,1,12,5,8,2,15,11,6\n- 다른 말 절대 금지. 숫자 10개와 쉼표만 출력\n\n[선택 기준]\n- 정치, 경제, 사회, 국제 이슈 우선\n- 광고, 연예, 스포츠 제외';

    var userPrompt = '다음 뉴스 목록에서 가장 중요한 10개의 번호를 골라줘:\n\n' + newsListText;

    var requestId = Date.now().toString(16) + Math.random().toString(16).slice(2);

    var clovaRes = await fetch(
      'https://clovastudio.stream.ntruss.com/v3/chat-completions/HCX-DASH-002',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + clovaApiKey,
          'X-NCP-CLOVASTUDIO-REQUEST-ID': requestId
        },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          topP: 0.8,
          topK: 0,
          maxTokens: 20,
          temperature: 0.1,
          repetitionPenalty: 1.2,
          stop: [],
          seed: 0,
          includeAiFilters: true
        })
      }
    );

    var clovaText = await clovaRes.text();
    console.log('CLOVA 응답:', clovaText.slice(0, 300));

    var rawText = '';
    try {
      var clovaJson = JSON.parse(clovaText);
      if (clovaJson.result && clovaJson.result.message && clovaJson.result.message.content) {
        rawText = clovaJson.result.message.content.trim();
      }
    } catch (e) {
      console.error('CLOVA JSON 파싱 실패:', e.message);
    }

    console.log('rawText:', rawText);

    // 숫자 5개 추출 → 원문 데이터 매칭
    var result = [];
    try {
      var nums = rawText.match(/\d+/g) || [];
      var rank = 1;
      for (var k = 0; k < nums.length && result.length < 10; k++) {
        var no = parseInt(nums[k]);
        var original = cleaned.find(function(n) { return n.no === no; });
        if (original) {
          result.push({
            rank: rank,
            title: original.title,
            description: original.description,
            link: original.link,
            pubDate: original.pubDate
          });
          rank++;
        }
      }
    } catch (e) {
      console.error('파싱 실패:', e.message);
    }

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
