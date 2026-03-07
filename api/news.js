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
      console.error('구글 트렌드 RSS 실패:', e.message);
    }

    if (trendKeywords.length === 0) {
      trendKeywords = ['속보', '정치', '경제', '국제', '사회'];
    }

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
        items: cleaned.slice(0, 5).map(function(n, i) {
          return { rank: i + 1, title: n.title, description: n.description, link: n.link, pubDate: n.pubDate };
        }),
        source: 'naver-only',
        keywords: trendKeywords
      });
    }

    var newsListText = cleaned.map(function(n) {
      return n.no + '. ' + n.title;
    }).join('\n');

    var systemPrompt = '당신은 한국 뉴스 큐레이터입니다.\n뉴스 목록에서 정치, 경제, 사회, 국제 이슈 중 중요한 5개를 골라 아래 형식으로만 답하세요.\n광고, 연예, 스포츠는 제외하세요.\n반드시 아래 형식 한 줄만 출력하세요. 다른 말 금지:\nRANK1:번호:제목|RANK2:번호:제목|RANK3:번호:제목|RANK4:번호:제목|RANK5:번호:제목\n제목은 30자 이내로 다듬으세요.';

    var userPrompt = '다음 뉴스 목록에서 TOP 5를 선별해줘:\n\n' + newsListText;

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
          maxTokens: 300,
          temperature: 0.1,
          repetitionPenalty: 1.2,
          stop: [],
          seed: 0,
          includeAiFilters: true
        })
      }
    );

    var clovaText = await clovaRes.text();
    console.log('CLOVA 응답:', clovaText.slice(0, 500));

    var rawText = '';
    try {
      var clovaJson = JSON.parse(clovaText);
      if (clovaJson.result && clovaJson.result.message && clovaJson.result.message.content) {
        rawText = clovaJson.result.message.content;
      }
    } catch (e) {
      console.error('CLOVA JSON 파싱 실패:', e.message);
    }

    console.log('rawText:', rawText);

    var top5 = [];
    try {
      var rankMatches = rawText.match(/RANK\d+:(\d+):([^|\n]+)/g) || [];
      for (var k = 0; k < rankMatches.length; k++) {
        var parts = rankMatches[k].split(':');
        if (parts.length >= 3) {
          top5.push({ rank: k + 1, no: parseInt(parts[1]), title: parts.slice(2).join(':').trim() });
        }
      }
    } catch (e) {
      console.error('파싱 실패:', e.message);
    }

    var result = top5.map(function(item) {
      var original = cleaned.find(function(n) { return n.no === item.no; });
      return {
        rank: item.rank,
        title: item.title,
        description: original ? original.description : '',
        link: original ? original.link : '',
        pubDate: original ? original.pubDate : ''
      };
    });

    if (result.length === 0) {
      return res.status(200).json({
        items: cleaned.slice(0, 5).map(function(n, i) {
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
