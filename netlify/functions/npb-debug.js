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

  // teams URL 패턴 탐색
  const urls = {
    'teams_index':    'https://npb.jp/bis/teams/',
    'teams_b_2026':   'https://npb.jp/bis/teams/2026_b.html',
    'teams_b_no_yr':  'https://npb.jp/bis/teams/b.html',
    'buffaloes':      'https://www.buffaloes.co.jp/team/player/',
    'idb1_b_snippet': 'https://npb.jp/bis/2026/stats/idb1_b.html',
  };

  for (const [key, url] of Object.entries(urls)) {
    try {
      const html = await fetchUrl(url);
      const links = [...html.matchAll(/\/bis\/players\/(\d+)\.html/g)].map(m => m[1]);
      // idb1_b의 첫 번째 <a> 태그들 확인
      const atags = [...html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([^<]{1,20})<\/a>/g)]
        .slice(0, 5).map(m => ({href: m[1], text: m[2]}));
      results[key] = { ok: true, len: html.length, playerLinks: [...new Set(links)].slice(0,5), atags };
    } catch(e) {
      results[key] = { ok: false, error: e.message };
    }
  }

  return { statusCode: 200, headers: cors, body: JSON.stringify(results, null, 2) };
};
