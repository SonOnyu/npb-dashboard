netlify/
  functions/
    npb-stats.js

const https = require('https');

// NPB 공식 URL 목록
const STAT_URLS = {
  'bat_c':     'https://npb.jp/bis/2026/stats/bat_c.html',
  'bat_p':     'https://npb.jp/bis/2026/stats/bat_p.html',
  'pit_c':     'https://npb.jp/bis/2026/stats/pit_c.html',
  'pit_p':     'https://npb.jp/bis/2026/stats/pit_p.html',
  'bat_inter': 'https://npb.jp/bis/2026/stats/bat_inter.html',
  'pit_inter': 'https://npb.jp/bis/2026/stats/pit_inter.html',
  'bat_op':    'https://npb.jp/bis/2026/stats/bat_op.html',
  'pit_op':    'https://npb.jp/bis/2026/stats/pit_op.html',
};

// HTML에서 테이블 파싱
function parseTable(html) {
  const rows = [];

  // 업데이트 날짜 추출
  const dateMatch = html.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*現在/);
  const updatedAt = dateMatch
    ? `${dateMatch[1]}.${dateMatch[2].padStart(2,'0')}.${dateMatch[3].padStart(2,'0')}`
    : null;

  // <tr> 행 추출
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let trMatch;
  let isHeader = true;
  let headers = [];

  while ((trMatch = trRegex.exec(html)) !== null) {
    const rowHtml = trMatch[1];

    // th 파싱 (헤더)
    const thMatches = [...rowHtml.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)];
    if (thMatches.length > 3) {
      headers = thMatches.map(m => m[1].replace(/<[^>]+>/g, '').replace(/[\s　]+/g, '').trim());
      continue;
    }

    // td 파싱 (데이터)
    const tdMatches = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)];
    if (tdMatches.length > 3) {
      const cells = tdMatches.map(m => m[1].replace(/<[^>]+>/g, '').replace(/[\s　]+/g, ' ').trim());
      if (cells[0] && !isNaN(cells[0])) { // 순위 숫자로 시작하는 행만
        rows.push(cells);
      }
    }
  }

  return { headers, rows, updatedAt };
}

// HTTP GET
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NPBDashboard/1.0)',
        'Accept-Charset': 'utf-8',
      }
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        // NPB 사이트는 UTF-8
        resolve(buf.toString('utf-8'));
      });
    }).on('error', reject);
  });
}

exports.handler = async (event) => {
  const type = event.queryStringParameters?.type || 'bat_c';
  const url = STAT_URLS[type];

  if (!url) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: `Unknown type: ${type}` }),
    };
  }

  try {
    const html = await fetchUrl(url);
    const data = parseTable(html);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600', // 1시간 캐시
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ type, ...data }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
