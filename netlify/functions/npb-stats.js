const https = require('https');

const STAT_URLS = {
  bat_c:     'https://npb.jp/bis/2026/stats/bat_c.html',
  bat_p:     'https://npb.jp/bis/2026/stats/bat_p.html',
  pit_c:     'https://npb.jp/bis/2026/stats/pit_c.html',
  pit_p:     'https://npb.jp/bis/2026/stats/pit_p.html',
  bat_inter: 'https://npb.jp/bis/2026/stats/bat_inter.html',
  pit_inter: 'https://npb.jp/bis/2026/stats/pit_inter.html',
  bat_op:    'https://npb.jp/bis/2026/stats/bat_op.html',
  pit_op:    'https://npb.jp/bis/2026/stats/pit_op.html',
};

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ja,en;q=0.9',
        'Referer': 'https://npb.jp/bis/',
      }
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    }).on('error', reject);
  });
}

function clean(str) {
  return str
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, '')
    .replace(/&amp;/g, '&')
    .replace(/[\s　\r\n\t]+/g, ' ')
    .trim();
}

function parseNPBTable(html) {
  // 업데이트 날짜
  const dateMatch = html.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*現在/);
  const updatedAt = dateMatch
    ? `${dateMatch[1]}.${String(dateMatch[2]).padStart(2,'0')}.${String(dateMatch[3]).padStart(2,'0')}`
    : null;

  // 성적 테이블 찾기 (순위가 들어있는 테이블)
  // NPB 페이지엔 테이블이 여러 개 있으므로 순위(数字)가 있는 것만 찾음
  const tables = [];
  const tblRe = /<table[\s\S]*?<\/table>/gi;
  let tm;
  while ((tm = tblRe.exec(html)) !== null) tables.push(tm[0]);

  let targetTable = null;
  for (const t of tables) {
    // td에 숫자만 있는 셀이 있으면 성적 테이블
    if (/<td[^>]*>\s*1\s*<\/td>/i.test(t)) {
      targetTable = t;
      break;
    }
  }

  if (!targetTable) return { headers: [], rows: [], updatedAt };

  // 헤더 파싱 — th 요소 전부
  const headers = [];
  const thRe = /<th[^>]*>([\s\S]*?)<\/th>/gi;
  let m;
  while ((m = thRe.exec(targetTable)) !== null) {
    const t = clean(m[1]);
    if (t) headers.push(t);
  }

  // 데이터 행 파싱
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  while ((m = trRe.exec(targetTable)) !== null) {
    const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)];
    if (tds.length < 5) continue;
    const cells = tds.map(t => clean(t[1]));
    // 첫 셀이 숫자(순위)인 행만
    if (/^\d+$/.test(cells[0])) rows.push(cells);
  }

  return { headers, rows, updatedAt };
}

exports.handler = async (event) => {
  const type = (event.queryStringParameters || {}).type || 'bat_c';
  const url = STAT_URLS[type];
  if (!url) return {
    statusCode: 400,
    body: JSON.stringify({ error: `Unknown type: ${type}` })
  };

  try {
    const html = await fetchUrl(url);
    const data = parseNPBTable(html);
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ type, ...data }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
