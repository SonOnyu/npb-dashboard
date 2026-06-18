const https = require('https');

function fetchUrl(url, referer) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get({
      hostname: u.hostname, path: u.pathname + u.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html', 'Accept-Language': 'ja',
        'Referer': referer || `https://${u.hostname}/`,
      }
    }, (res) => {
      if ([301,302].includes(res.statusCode))
        return fetchUrl(res.headers.location, referer).then(resolve).catch(reject);
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

  // 12구단 선수 목록 페이지에서 NPB 선수 ID 링크 찾기
  const TEAM_URLS = {
    T:  'https://hanshintigers.jp/team/players/',
    DB: 'https://www.baystars.co.jp/team/player/',
    G:  'https://www.giants.jp/team/player/',
    D:  'https://dragons.jp/team/player/',
    C:  'https://www.carp.co.jp/team/player/',
    Sw: 'https://www.yakult-swallows.co.jp/team/player/',
    H:  'https://www.softbankhawks.co.jp/team/player/',
    F:  'https://www.fighters.co.jp/team/player/',
    Bs: 'https://www.buffaloes.co.jp/team/player/',
    E:  'https://www.rakuteneagles.jp/team/player/',
    L:  'https://www.seibulions.jp/team/player/',
    M:  'https://www.marines.co.jp/team/player/',
  };

  const results = {};
  await Promise.allSettled(Object.entries(TEAM_URLS).map(async ([team, url]) => {
    try {
      const html = await fetchUrl(url);
      // NPB player 링크 패턴
      const npbLinks = [...html.matchAll(/\/bis\/players\/(\d+)\.html/g)].map(m => m[1]);
      // 구단 자체 선수 URL 패턴 (ID 추출)
      const ownLinks = [...html.matchAll(/href="([^"]*player[^"]*detail[^"]*)"[^>]*>/gi)]
        .map(m => m[1]).slice(0, 3);
      results[team] = {
        ok: true, len: html.length,
        npbLinks: [...new Set(npbLinks)].slice(0, 3),
        ownLinks,
      };
    } catch(e) {
      results[team] = { ok: false, error: e.message };
    }
  }));

  return { statusCode: 200, headers: cors, body: JSON.stringify(results, null, 2) };
};
