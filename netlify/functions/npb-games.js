const https = require('https');

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'ja',
        'Referer': 'https://npb.jp/',
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
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

function clean(s) {
  return s.replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&')
          .replace(/[\r\n\t]+/g,' ').replace(/\s{2,}/g,' ').trim();
}

const URL_TEAM = {g:'G',h:'H',s:'Sw',db:'DB',d:'D',t:'T',c:'C',f:'F',b:'Bs',e:'E',l:'L',m:'M'};
const NAME_TEAM = {
  '読売':'G','巨人':'G','ヤクルト':'Sw','DeNA':'DB','横浜DeNA':'DB',
  '中日':'D','阪神':'T','広島':'C','ソフトバンク':'H',
  '日本ハム':'F','オリックス':'Bs','楽天':'E','西武':'L','ロッテ':'M',
};

function jstNow() {
  const d = new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Tokyo'}));
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  return { mm, mmdd: mm+dd };
}
function addDay(mmdd) {
  const m = parseInt(mmdd.slice(0,2)), d = parseInt(mmdd.slice(2,4));
  const dt = new Date(2026, m-1, d+1);
  return String(dt.getMonth()+1).padStart(2,'0') + String(dt.getDate()).padStart(2,'0');
}

function parseSchedule(html, debugTarget) {
  const games = [];
  const seen  = new Set();
  let curMmdd = '';
  const debugLog = [];

  // 테이블 찾기
  const tableM = html.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableM) {
    debugLog.push('NO_TABLE_FOUND');
    return { games, debugLog };
  }
  const tableHtml = tableM[1];
  debugLog.push(`table_len:${tableHtml.length}`);

  // 날짜 패턴 검색
  const dateMatches = [...tableHtml.matchAll(/(\d{1,2})\/(\d{1,2})[（(][日月火水木金土]/g)];
  debugLog.push(`date_matches:${dateMatches.length}`);
  dateMatches.slice(0,5).forEach(m => debugLog.push(`date:${m[1]}/${m[2]}`));

  // 6/12 텍스트 직접 검색
  const idx612 = tableHtml.indexOf('6/12');
  debugLog.push(`6/12_idx:${idx612}`);
  if (idx612 >= 0) {
    debugLog.push(`6/12_ctx:${clean(tableHtml.slice(idx612, idx612+200))}`);
  }

  // <tr> 파싱
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let tr;
  let trCount = 0;
  while ((tr = trRe.exec(tableHtml)) !== null) {
    trCount++;
    const row = tr[1];
    const dateM = row.match(/(\d{1,2})\/(\d{1,2})[（(][日月火水木金土]/);
    if (dateM) {
      curMmdd = String(dateM[1]).padStart(2,'0') + String(dateM[2]).padStart(2,'0');
      if (debugTarget && curMmdd === debugTarget) {
        debugLog.push(`TARGET_DATE_ROW:${clean(row).slice(0,200)}`);
      }
    }
    if (!curMmdd) continue;

    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c => clean(c[1]));
    if (cells.length < 2) continue;
    const rowText = cells.join(' ');

    // 대상 날짜 행 디버그
    if (debugTarget && curMmdd === debugTarget) {
      debugLog.push(`ROW[${curMmdd}]:${rowText.slice(0,150)}`);
    }

    const linkM = row.match(/href="(\/scores\/2026\/(\d{4})\/([a-z]+)-([a-z]+)-\d+\/)"/);
    if (linkM) {
      const [, path, , awayC, homeC] = linkM;
      if (seen.has(path)) continue;
      seen.add(path);
      const scoreM = rowText.match(/(\d+)\s*[-−–]\s*(\d+)/);
      const venueM = rowText.match(/(東京ドーム|神宮|横浜|マツダ|甲子園|バンテリン|ZOZOマリン|エスコン|ベルーナ|京セラ|楽天モバイル|みずほPayPay)/);
      const timeM  = rowText.match(/(\d{1,2}:\d{2})/);
      const cancelled = rowText.includes('中止');
      const wpM = rowText.match(/勝[：:]\s*(\S{2,8})/);
      const lpM = rowText.match(/敗[：:]\s*(\S{2,8})/);
      games.push({
        mmdd: curMmdd,
        date: `2026-${curMmdd.slice(0,2)}-${curMmdd.slice(2,4)}`,
        away: URL_TEAM[awayC]||awayC.toUpperCase(),
        home: URL_TEAM[homeC]||homeC.toUpperCase(),
        awayScore: scoreM&&!cancelled?parseInt(scoreM[1]):null,
        homeScore: scoreM&&!cancelled?parseInt(scoreM[2]):null,
        venue: venueM?venueM[1]:null, time: timeM?timeM[1]:'18:00',
        status: cancelled?'cancelled':scoreM?'finished':'live',
        cancelled, winPitcher: wpM?wpM[1]:'', losePitcher: lpM?lpM[1]:'',
        link: `https://npb.jp${path}`,
      });
      continue;
    }

    if (rowText.includes('中止')||rowText.includes('休')) continue;
    const teamPositions = [];
    for (const [name, key] of Object.entries(NAME_TEAM)) {
      const idx = rowText.indexOf(name);
      if (idx >= 0) teamPositions.push({idx, key});
    }
    teamPositions.sort((a,b) => a.idx-b.idx);
    const usedKeys = new Set();
    const teams = [];
    for (const tp of teamPositions) {
      if (!usedKeys.has(tp.key)) { usedKeys.add(tp.key); teams.push(tp.key); }
    }
    if (teams.length < 2) continue;
    const gameKey = `${curMmdd}-${teams[0]}-${teams[1]}`;
    if (seen.has(gameKey)) continue;
    seen.add(gameKey);
    const venueM2 = rowText.match(/(東京ドーム|神宮|横浜|マツダ|甲子園|バンテリン|ZOZOマリン|エスコン|ベルーナ|京セラ|楽天モバイル|みずほPayPay)/);
    const timeM2  = rowText.match(/(\d{1,2}:\d{2})/);
    games.push({
      mmdd: curMmdd,
      date: `2026-${curMmdd.slice(0,2)}-${curMmdd.slice(2,4)}`,
      away: teams[1], home: teams[0],
      awayScore: null, homeScore: null,
      venue: venueM2?venueM2[1]:null, time: timeM2?timeM2[1]:'18:00',
      status: 'scheduled', cancelled: false,
      winPitcher: '', losePitcher: '', link: null,
    });
  }
  debugLog.push(`total_tr:${trCount} total_games:${games.length}`);
  return { games, debugLog };
}

function ok(data) {
  return {
    statusCode: 200,
    headers: { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-cache', 'Access-Control-Allow-Origin':'*' },
    body: JSON.stringify(data),
  };
}

exports.handler = async (event) => {
  const p = event.queryStringParameters || {};
  const action = p.action || 'today';
  const { mm, mmdd } = jstNow();
  const tmrMmdd = addDay(mmdd);
  const tmrMm   = tmrMmdd.slice(0,2);

  try {
    if (action === 'today') {
      const html = await fetchUrl(`https://npb.jp/games/2026/schedule_${mm}_detail.html`);
      const { games, debugLog } = parseSchedule(html, tmrMmdd);
      return ok({
        mmdd, tmrMmdd,
        htmlLen: html.length,
        debugLog,
        todayGames:    games.filter(g => g.mmdd === mmdd),
        tomorrowGames: games.filter(g => g.mmdd === tmrMmdd),
        allDates: [...new Set(games.map(g=>g.mmdd))].sort(),
        starters: {},
      });
    }
    return { statusCode:400, body:JSON.stringify({error:'Unknown action'}) };
  } catch(err) {
    return { statusCode:500, headers:{'Access-Control-Allow-Origin':'*'}, body:JSON.stringify({error:err.message}) };
  }
};
