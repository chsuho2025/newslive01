export default async function handler(req, res) {
  // CORS 허용
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return res.status(500).json({ error: 'API 키가 설정되지 않았습니다.' });
  }

  // 여러 키워드로 최신 뉴스 수집
  const keywords = ['속보', '오늘 뉴스', '한국 이슈', '경제 뉴스', '사회 뉴스'];
  let allNews = [];

  try {
    for (const keyword of keywords) {
      const response = await fetch(
        `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(keyword)}&display=5&sort=date`,
        {
          headers: {
            'X-Naver-Client-Id': clientId,
            'X-Naver-Client-Secret': clientSecret,
          },
        }
      );
      const data = await response.json();
      if (data.items) {
        allNews = allNews.concat(data.items);
      }
    }

    // 중복 제거 (제목 기준)
    const seen = new Set();
    const unique = allNews.filter(item => {
      const clean = item.title.replace(/<[^>]*>/g, '');
      if (seen.has(clean)) return false;
      seen.add(clean);
      return true;
    });

    // 최신순 상위 20개만
    const top20 = unique.slice(0, 20).map(item => ({
      title: item.title.replace(/<[^>]*>/g, ''),
      description: item.description.replace(/<[^>]*>/g, ''),
      pubDate: item.pubDate,
      link: item.link,
    }));

    return res.status(200).json({ items: top20 });

  } catch (error) {
    return res.status(500).json({ error: '뉴스를 가져오는데 실패했습니다.' });
  }
}
