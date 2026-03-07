module.exports = async function handler(req, res) {
res.setHeader('Access-Control-Allow-Origin', '*');
res.setHeader('Access-Control-Allow-Methods', 'GET');
const naverClientId = process.env.NAVER_CLIENT_ID;
const naverClientSecret = process.env.NAVER_CLIENT_SECRET;
const clovaApiKey = process.env.CLOVA_API_KEY;
if (!naverClientId || !naverClientSecret) {
return res.status(500).json({ error: '네이버 API 키가 설정되지 않았습니다.' });
}
try {
// ── 1차: 구글 트렌드 RSS → 실시간 키워드 추출 ──
let trendKeywords = [];
try {
const rssRes = await fetch(
'https://trends.google.com/trends/trendingsearches/daily/rss?geo=KR',
{ headers: { 'User-Agent': 'Mozilla/5.0' } }
);
const rssText = await rssRes.text();
const matches = rssText.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/g) || [];
trendKeywords = matches
.map(m => m.replace(/<title><!\[CDATA\[/, '').replace(/\]\]><\/title>/, '').trim())
.filter(k => k && k !== '대한민국의 인기 검색어')
.slice(0, 10);
} catch (e) {
console.error('구글 트렌드 RSS 실패:', e);
}
// 트렌드 키워드 없으면 기본 키워드 사용 (fallback)
if (trendKeywords.length === 0) {
trendKeywords = ['속보', '정치', '경제', '국제', '사회'];
}
// ── 2차: 네이버 뉴스 API → 키워드별 뉴스 수집 ──
let allNews = [];
for (const keyword of trendKeywords) {
try {
const response = await fetch(
`https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(keyword)}
{
headers: {
'X-Naver-Client-Id': naverClientId,
'X-Naver-Client-Secret': naverClientSecret,
},
}
);
const data = await response.json();
if (data.items) {
allNews = allNews.concat(data.items);
}
} catch (e) {
console.error(`키워드 뉴스 수집 실패:`, e);
}
}
// 서버에서 1차 정제 (AI 없이)
const decodeHtml = (str) => str
.replace(/&quot;/g, '"')
.replace(/&amp;/g, '&')
.replace(/&lt;/g, '<')
.replace(/&gt;/g, '>')
.replace(/&#39;/g, "'")
.replace(/<[^>]*>/g, '')
.trim();
// 중복 제거
const seen = new Set();
const unique = allNews.filter(item => {
const clean = decodeHtml(item.title);
if (seen.has(clean)) return false;
seen.add(clean);
return true;
});
// 정제된 20개
const cleaned = unique.slice(0, 20).map((item, idx) => ({
no: idx + 1,
title: decodeHtml(item.title),
description: decodeHtml(item.description),
pubDate: item.pubDate,
link: item.link,
}));
// HyperCLOVA X 없으면 정제된 데이터 그대로 반환
if (!clovaApiKey) {
return res.status(200).json({
items: cleaned.slice(0, 5),
source: 'naver-only',
keywords: trendKeywords,
});
}
// ── 3차: HyperCLOVA X → TOP 5 선별 + 타이틀 정제 ──
const newsListText = cleaned
.map(n => `${n.no}. ${n.title}`)
.join('\n');
const clovaRes = await fetch(
'https://clovastudio.stream.ntruss.com/v1/api-tools/openai/chat/completions',
{
method: 'POST',
headers: {
'Content-Type': 'application/json',
'Authorization': `Bearer ${clovaApiKey}`,
},
body: JSON.stringify({
model: 'HCX-DASH-002',
max_tokens: 500,
temperature: 0.3,
top_p: 0.8,
messages: [
{
role: 'system',
content: `당신은 한국 뉴스 큐레이터입니다.
번호가 붙은 뉴스 제목 목록을 받으면 가장 중요한 5개의 번호와 다듬은 제목만 반환하세요.
다른 말은 절대 하지 마세요.
출력 형식 (반드시 이 JSON만 출력):
{"top5":[{"rank":1,"no":3,"title":"다듬은 제목"},{"rank":2,"no":7,"title":"다듬은 제목"}]}
규칙:
- 광고, 연예, 스포츠, 낚시성 기사 제외
- 정치, 경제, 사회, 국제 이슈 우선
- title은 30자 이내로 자연스럽게 다듬기
- no는 반드시 입력받은 번호 그대로 사용`,
},
{
role: 'user',
content: `다음 뉴스 목록에서 TOP 5를 선별해줘:\n\n${newsListText}`,
},
],
}),
}
);
const clovaData = await clovaRes.json();
const rawText = clovaData?.choices?.[0]?.message?.content || '';
// JSON 파싱
let top5 = [];
try {
const jsonMatch = rawText.match(/\{[\s\S]*\}/);
if (jsonMatch) {
const parsed = JSON.parse(jsonMatch[0]);
top5 = parsed.top5 || [];
}
} catch (e) {
console.error('JSON 파싱 실패:', e);
}
// no 기준으로 원문 description 매칭
const result = top5.map(item => {
const original = cleaned.find(n => n.no === item.no);
return {
rank: item.rank,
title: item.title,
description: original?.description || '',
link: original?.link || '',
pubDate: original?.pubDate || '',
};
});
// HyperCLOVA X 실패 시 fallback
if (result.length === 0) {
return res.status(200).json({
items: cleaned.slice(0, 5).map((n, i) => ({
rank: i + 1,
title: n.title,
description: n.description,
link: n.link,
pubDate: n.pubDate,
})),
source: 'fallback',
keywords: trendKeywords,
});
}
return res.status(200).json({
items: result,
source: 'hyperclovax',
keywords: trendKeywords,
});
}
} catch (error) {
console.error('전체 오류:', error);
return res.status(500).json({ error: '뉴스를 가져오는데 실패했습니다.' });module.exports = async function handler(req, res) {
res.setHeader('Access-Control-Allow-Origin', '*');
res.setHeader('Access-Control-Allow-Methods', 'GET');
const naverClientId = process.env.NAVER_CLIENT_ID;
const naverClientSecret = process.env.NAVER_CLIENT_SECRET;
const clovaApiKey = process.env.CLOVA_API_KEY;
if (!naverClientId || !naverClientSecret) {
return res.status(500).json({ error: '네이버 API 키가 설정되지 않았습니다.' });
}
try {
// ── 1차: 구글 트렌드 RSS → 실시간 키워드 추출 ──
let trendKeywords = [];
try {
const rssRes = await fetch(
'https://trends.google.com/trends/trendingsearches/daily/rss?geo=KR',
{ headers: { 'User-Agent': 'Mozilla/5.0' } }
);
const rssText = await rssRes.text();
const matches = rssText.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/g) || [];
trendKeywords = matches
.map(m => m.replace(/<title><!\[CDATA\[/, '').replace(/\]\]><\/title>/, '').trim())
.filter(k => k && k !== '대한민국의 인기 검색어')
.slice(0, 10);
} catch (e) {
console.error('구글 트렌드 RSS 실패:', e);
}
// 트렌드 키워드 없으면 기본 키워드 사용 (fallback)
if (trendKeywords.length === 0) {
trendKeywords = ['속보', '정치', '경제', '국제', '사회'];
}
// ── 2차: 네이버 뉴스 API → 키워드별 뉴스 수집 ──
let allNews = [];
for (const keyword of trendKeywords) {
try {
const response = await fetch(
`https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(keyword)}
{
headers: {
'X-Naver-Client-Id': naverClientId,
'X-Naver-Client-Secret': naverClientSecret,
},
}
);
const data = await response.json();
if (data.items) {
allNews = allNews.concat(data.items);
}
} catch (e) {
console.error(`키워드 뉴스 수집 실패:`, e);
}
}
// 서버에서 1차 정제 (AI 없이)
const decodeHtml = (str) => str
.replace(/&quot;/g, '"')
.replace(/&amp;/g, '&')
.replace(/&lt;/g, '<')
.replace(/&gt;/g, '>')
.replace(/&#39;/g, "'")
.replace(/<[^>]*>/g, '')
.trim();
// 중복 제거
const seen = new Set();
const unique = allNews.filter(item => {
const clean = decodeHtml(item.title);
if (seen.has(clean)) return false;
seen.add(clean);
return true;
});
// 정제된 20개
const cleaned = unique.slice(0, 20).map((item, idx) => ({
no: idx + 1,
title: decodeHtml(item.title),
description: decodeHtml(item.description),
pubDate: item.pubDate,
link: item.link,
}));
// HyperCLOVA X 없으면 정제된 데이터 그대로 반환
if (!clovaApiKey) {
return res.status(200).json({
items: cleaned.slice(0, 5),
source: 'naver-only',
keywords: trendKeywords,
});
}
// ── 3차: HyperCLOVA X → TOP 5 선별 + 타이틀 정제 ──
const newsListText = cleaned
.map(n => `${n.no}. ${n.title}`)
.join('\n');
const clovaRes = await fetch(
'https://clovastudio.stream.ntruss.com/v1/api-tools/openai/chat/completions',
{
method: 'POST',
headers: {
'Content-Type': 'application/json',
'Authorization': `Bearer ${clovaApiKey}`,
},
body: JSON.stringify({
model: 'HCX-DASH-002',
max_tokens: 500,
temperature: 0.3,
top_p: 0.8,
messages: [
{
role: 'system',
content: `당신은 한국 뉴스 큐레이터입니다.
번호가 붙은 뉴스 제목 목록을 받으면 가장 중요한 5개의 번호와 다듬은 제목만 반환하세요.
다른 말은 절대 하지 마세요.
출력 형식 (반드시 이 JSON만 출력):
{"top5":[{"rank":1,"no":3,"title":"다듬은 제목"},{"rank":2,"no":7,"title":"다듬은 제목"}]}
규칙:
- 광고, 연예, 스포츠, 낚시성 기사 제외
- 정치, 경제, 사회, 국제 이슈 우선
- title은 30자 이내로 자연스럽게 다듬기
- no는 반드시 입력받은 번호 그대로 사용`,
},
{
role: 'user',
content: `다음 뉴스 목록에서 TOP 5를 선별해줘:\n\n${newsListText}`,
},
],
}),
}
);
const clovaData = await clovaRes.json();
const rawText = clovaData?.choices?.[0]?.message?.content || '';
// JSON 파싱
let top5 = [];
try {
const jsonMatch = rawText.match(/\{[\s\S]*\}/);
if (jsonMatch) {
const parsed = JSON.parse(jsonMatch[0]);
top5 = parsed.top5 || [];
}
} catch (e) {
console.error('JSON 파싱 실패:', e);
}
// no 기준으로 원문 description 매칭
const result = top5.map(item => {
const original = cleaned.find(n => n.no === item.no);
return {
rank: item.rank,
title: item.title,
description: original?.description || '',
link: original?.link || '',
pubDate: original?.pubDate || '',
};
});
// HyperCLOVA X 실패 시 fallback
if (result.length === 0) {
return res.status(200).json({
items: cleaned.slice(0, 5).map((n, i) => ({
rank: i + 1,
title: n.title,
description: n.description,
link: n.link,
pubDate: n.pubDate,
})),
source: 'fallback',
keywords: trendKeywords,
});
}
return res.status(200).json({
items: result,
source: 'hyperclovax',
keywords: trendKeywords,
});
}
} catch (error) {
console.error('전체 오류:', error);
return res.status(500).json({ error: '뉴스를 가져오는데 실패했습니다.' });
