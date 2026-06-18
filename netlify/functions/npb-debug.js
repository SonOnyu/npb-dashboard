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

function clean(s) {
  return s.replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').replace(/[\r\n\t]+/g,' ').replace(/\s{2,}/g,' ').trim();
}

exports.handler = async () => {
  const cors = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' };
  const results = {};

  const urls = {
    'players_index': 'https://npb.jp/bis/players/',
    'players_b':     'https://npb.jp/bis/players/b.html',
    'players_2026b': 'https://npb.jp/bis/2026/players/b.html',
    'players_search':'https://npb.jp/bis/players/?name=%E6%A3%AE%E5%8F%8B%E5%93%89', // 森友哉
  };

  for (const [key, url] of Object.entries(urls)) {
    try {
      const html = await fetchUrl(url);
      const links = [...html.matchAll(/\/bis\/players\/(\d+)\.html/g)].map(m => m[1]);
      // 선수명+링크 패턴 찾기
      const playerEntries = [...html.matchAll(/<a[^>]+href="\/bis\/players\/(\d+)\.html"[^>]*>([\s\S]*?)<\/a>/g)]
        .slice(0,5).map(m => ({ id: m[1], name: clean(m[2]) }));
      results[key] = { ok: true, len: html.length, uniqueLinks: [...new Set(links)].length, playerEntries };
    } catch(e) {
      results[key] = { ok: false, error: e.message };
    }
  }

  return { statusCode: 200, headers: cors, body: JSON.stringify(results, null, 2) };
};
