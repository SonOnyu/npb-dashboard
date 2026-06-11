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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en-US;q=0.9',
        'Referer': 'https://npb.jp/',
      }
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    }).on('error', reject);
  });
}

function parseNPBTable(html) {
  const dateMatch = html.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*現在/);
  const updatedAt = dateMatch
    ? `${dateMatch[1]}.${String(dateMatch[2]).padStart(2,'0')}.${String(dateMatch[3]).padStart(2,'0')}`
    : null;

  const tableMatch = html.match(/<table[\s\S]*?<\/table>/i);
  if (!tableMatch) return { headers: [], rows: [], updatedAt };
  const tableHtml = tableMatch[0];

  // 헤더
  const headers = [];
  const thRegex = /<th[^>]*>([\s\S]*?)<\/th>/gi;
  let m;
  while ((m = thRegex.exec(tableHtml)) !== null) {
    const t = m[1].replace(/<[^>]+>/g,'').replace(/&nbsp;/g,'').replace(/[\s　]+/g,'').trim();
    if (t) headers.push(t);
  }

  // 데이터 행
  const rows = [];
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  while ((m = trRegex.exec(tableHtml)) !== null) {
    const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)];
    if (tds.length < 3) continue;
    const cells = tds.map(t =>
      t[1].replace(/<[^>]+>/g,'').replace(/&nbsp;/g,'').replace(/[\s　]+/g,' ').trim()
    );
    if (/^\d+$/.test(cells[0])) rows.push(cells);
  }

  return { headers, rows, updatedAt };
}

exports.handler = async (event) => {
  const type = (event.queryStringParameters || {}).type || 'bat_c';
  const url = STAT_URLS[type];
  if (!url) return { statusCode: 400, body: JSON.stringify({ error: `Unknown type: ${type}` }) };

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
