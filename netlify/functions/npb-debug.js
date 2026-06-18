const https = require('https');
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':'text/html','Accept-Language':'ja','Referer':'https://npb.jp/',
      }
    }, (res) => {
      if ([301,302].includes(res.statusCode)) return fetchUrl(res.headers.location).then(resolve).catch(reject);
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}
exports.handler = async () => {
  const cors = { 'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':'*' };
  const results = {};

  // 50음 인덱스 페이지 접근 테스트
  const suffixes = ['a','ka','sa','ta','na','ha','ma','ya','ra','wa'];
  for (const s of suffixes.slice(0,3)) {
    try {
      const html = await fetchUrl(`https://npb.jp/bis/players/all/index_${s}.html`);
      const links = [...html.matchAll(/\/bis\/players\/(\d+)\.html"[^>]*>([^<]+)</g)]
        .map(m => ({ id: m[1], name: m[2].trim() }));
      results[`index_${s}`] = { ok:true, len:html.length, playerCount:links.length, sample:links.slice(0,3) };
    } catch(e) {
      results[`index_${s}`] = { ok:false, error:e.message };
    }
  }

  // 森友哉 사진 URL 확인
  try {
    const html = await fetchUrl('https://npb.jp/bis/players/91495139.html');
    const imgs = [...html.matchAll(/<img[^>]+src="([^"]+)"/gi)].map(m=>m[1])
      .filter(s => s.includes('photo') || s.includes('p.npb') || /\d{8}/.test(s));
    results.photoTest = { ok:true, imgs };
  } catch(e) {
    results.photoTest = { ok:false, error:e.message };
  }

  return { statusCode:200, headers:cors, body:JSON.stringify(results, null,2) };
};
