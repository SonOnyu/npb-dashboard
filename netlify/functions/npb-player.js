// NPB 선수 개인 연도별 성적 페이지 파싱
const https = require('https');

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
  const cors = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  };

  const playerId = (event.queryStringParameters || {}).id;
  if (!playerId || !/^\d+$/.test(playerId)) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'invalid id' }) };
  }

  try {
    const url  = `https://npb.jp/bis/players/${playerId}.html`;
    const html = await fetchUrl(url);

    // 선수 이름
    const nameMatch = html.match(/<h1[^>]*>\s*([\s\S]*?)\s*<\/h1>/i);
    const name = nameMatch ? clean(nameMatch[1]) : '';

    // 포지션/배번
    const posMatch = html.match(/背番号.*?(\d+)|(\d+)\s*番/);

    // 연도별 성적 테이블 파싱
    // NPB 선수 페이지: <table>...</table> 여러 개 중 연도(年度) 컬럼 있는 것
    const tables = [];
    const tblRe  = /<table[\s\S]*?<\/table>/gi;
    let tm;
    while ((tm = tblRe.exec(html)) !== null) tables.push(tm[0]);

    // 연도 컬럼 있는 테이블 찾기
    let target = null;
    for (const t of tables) {
      if (t.includes('年度') || t.includes('year') || />\s*20\d{2}\s*</.test(t)) {
        target = t;
        break;
      }
    }

    if (!target) {
      return {
        statusCode: 200,
        headers: cors,
        body: JSON.stringify({ playerId, name, tables: tables.length, error: 'no_stats_table' }),
      };
    }

    // 헤더 파싱
    const headers = [];
    const thRe = /<th[^>]*>([\s\S]*?)<\/th>/gi;
    let m;
    while ((m = thRe.exec(target)) !== null) {
      const t = clean(m[1]);
      if (t) headers.push(t);
    }

    // 행 파싱
    const rows = [];
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    while ((m = trRe.exec(target)) !== null) {
      const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)];
      if (tds.length < 3) continue;
      const cells = tds.map(td => clean(td[1]));
      // 연도 행 판별: 첫 번째 셀이 4자리 연도이거나 팀명
      if (cells[0] && (cells[0].length > 0)) rows.push(cells);
    }

    // 프로필 정보 (포지션, 투타, 생년월일 등)
    const profileMatch = html.match(/(?:投打|位置|ポジション|生年月日|身長|体重)[^<]{1,100}/g);
    const profile = profileMatch ? profileMatch.slice(0, 6).map(s => clean(s)) : [];

    return {
      statusCode: 200,
      headers: { ...cors, 'Cache-Control': 'public, max-age=3600' },
      body: JSON.stringify({ playerId, name, headers, rows, profile }),
    };
  } catch (err) {
    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({ playerId, error: err.message }),
    };
  }
};
