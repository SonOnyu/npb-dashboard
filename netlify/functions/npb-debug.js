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
  try {
    // 森友哉 선수 페이지에서 사진 URL 패턴 확인
    const html = await fetchUrl('https://npb.jp/bis/players/91495139.html');
    const imgs = [...html.matchAll(/src="([^"]+)"/g)].map(m=>m[1])
      .filter(s => s.includes('photo') || s.includes('player') || s.includes('p.npb'));
    // title, img 태그 전체
    const allImgs = [...html.matchAll(/<img[^>]+>/gi)].map(m=>m[0]).slice(0,10);
    return { statusCode:200, headers:cors, body:JSON.stringify({ imgs, allImgs }, null, 2) };
  } catch(e) {
    return { statusCode:200, headers:cors, body:JSON.stringify({ error:e.message }) };
  }
};
