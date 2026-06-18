// NPB 선수 개인 연도별 성적 파싱
// GET /.netlify/functions/npb-player?name=森友哉  → playerIdMap에서 조회 후 성적 반환
// GET /.netlify/functions/npb-player?id=91495139  → 직접 ID로 조회
const { getStore } = require('@netlify/blobs');
const https = require('https');

function npbStore() {
  const opts = { name: 'npb-data', consistency: 'strong' };
  if (process.env.NETLIFY_SITE_ID && process.env.NETLIFY_AUTH_TOKEN) {
    opts.siteID = process.env.NETLIFY_SITE_ID;
    opts.token  = process.env.NETLIFY_AUTH_TOKEN;
  }
  return getStore(opts);
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'ja',
        'Referer': 'https://npb.jp/bis/players/',
      }
    }, (res) => {
      if ([301, 302].includes(res.statusCode))
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
  return s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
          .replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

exports.handler = async (event) => {
  const cors = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' };
  const p = event.queryStringParameters || {};

  let playerId = p.id;

  // 이름으로 조회
  if (!playerId && p.name) {
    try {
      const store = npbStore();
      const map   = await store.get('playerIdMap', { type: 'json' });
      if (map) {
        const name    = p.name.replace(/\u3000/g, ' ').trim();
        playerId = map[name] || map[name.replace(/\s/g, '\u3000')] || null;
        // 부분 일치 fallback
        if (!playerId) {
          const key = Object.keys(map).find(k => k.replace(/\u3000|\s/g,'').includes(name.replace(/\s/g,'')));
          if (key) playerId = map[key];
        }
      }
    } catch(e) {}
  }

  if (!playerId) {
    return { statusCode: 200, headers: cors, body: JSON.stringify({ error: 'player_not_found', name: p.name }) };
  }

  try {
    const html = await fetchUrl(`https://npb.jp/bis/players/${playerId}.html`);

    // 연도별 성적 테이블 파싱
    const tables = [];
    const tblRe  = /<table[\s\S]*?<\/table>/gi;
    let tm;
    while ((tm = tblRe.exec(html)) !== null) tables.push(tm[0]);

    let target = null;
    for (const t of tables) {
      if (t.includes('年度') || />\s*20\d{2}\s*</.test(t) || t.includes('打率') || t.includes('防御率')) {
        target = t;
        break;
      }
    }

    if (!target) {
      return { statusCode: 200, headers: cors, body: JSON.stringify({ playerId, error: 'no_stats_table' }) };
    }

    // 헤더
    const headers = [];
    const thRe = /<th[^>]*>([\s\S]*?)<\/th>/gi;
    let m;
    while ((m = thRe.exec(target)) !== null) {
      const t = clean(m[1]);
      if (t) headers.push(t);
    }

    // 행
    const rows = [];
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    while ((m = trRe.exec(target)) !== null) {
      const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)];
      if (tds.length < 3) continue;
      const cells = tds.map(td => clean(td[1]));
      if (cells[0] && cells[0].length > 0 && !/^選手|投手|打者/.test(cells[0])) rows.push(cells);
    }

    return {
      statusCode: 200,
      headers: { ...cors, 'Cache-Control': 'public, max-age=3600' },
      body: JSON.stringify({ playerId, headers, rows }),
    };
  } catch(err) {
    return { statusCode: 200, headers: cors, body: JSON.stringify({ playerId, error: err.message }) };
  }
};
