const https = require('https');

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html', 'Accept-Language': 'ja', 'Referer': 'https://www.buffaloes.co.jp/',
      }
    }, (res) => {
      if ([301,302].includes(res.statusCode))
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      if (res.statusCode !== 200)
        return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

function clean(s) {
  return s.replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').replace(/[\r\n\t]+/g,' ').replace(/\s{2,}/g,' ').trim();
}

exports.handler = async () => {
  const cors = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' };

  try {
    const url  = 'https://www.buffaloes.co.jp/team/player/detail/2026_00001169.html';
    const html = await fetchUrl(url);

    // 성적 테이블 찾기
    const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map(m => m[0]);

    // 선수 이름
    const nameMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const name = nameMatch ? clean(nameMatch[1]) : '';

    // 각 테이블 헤더 + 첫 행
    const tableInfo = tables.map((t, i) => {
      const headers = [...t.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map(m => clean(m[1])).filter(Boolean);
      const firstRow = [...t.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].slice(0,8).map(m => clean(m[1]));
      return { i, headers: headers.slice(0,8), firstRow };
    });

    return {
      statusCode: 200, headers: cors,
      body: JSON.stringify({ ok: true, len: html.length, name, tableCount: tables.length, tableInfo }, null, 2)
    };
  } catch(e) {
    return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
