// 임시 디버그: NPB HTML에 선수 링크가 있는지 확인
const https = require('https');

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html', 'Accept-Language': 'ja', 'Referer': 'https://npb.jp/',
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

exports.handler = async () => {
  const cors = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' };
  const results = {};

  const urls = {
    'bat_c':    'https://npb.jp/bis/2026/stats/bat_c.html',
    'idb1_b':   'https://npb.jp/bis/2026/stats/idb1_b.html',
    'teams_b':  'https://npb.jp/bis/teams/2026_b.html',
    'player':   'https://npb.jp/bis/players/91495139.html',
  };

  for (const [key, url] of Object.entries(urls)) {
    try {
      const html = await fetchUrl(url);
      const links = [...html.matchAll(/\/bis\/players\/(\d+)\.html/g)].map(m => m[1]);
      results[key] = { ok: true, len: html.length, playerLinks: [...new Set(links)].slice(0, 5) };
    } catch(e) {
      results[key] = { ok: false, error: e.message };
    }
  }

  return { statusCode: 200, headers: cors, body: JSON.stringify(results, null, 2) };
};
