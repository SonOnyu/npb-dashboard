// 매일 KST 05:00 (UTC 20:00) 자동 실행
// NPB 공식에서 데이터 수집 → Netlify Blobs에 저장
const { schedule } = require('@netlify/functions');
const { getStore } = require('@netlify/blobs');

function npbStore() {
  // 명시적 환경변수 fallback (직접 호출 시에도 동작하도록)
  const opts = { name: 'npb-data', consistency: 'strong' };
  if (process.env.NETLIFY_SITE_ID && process.env.NETLIFY_AUTH_TOKEN) {
    opts.siteID = process.env.NETLIFY_SITE_ID;
    opts.token  = process.env.NETLIFY_AUTH_TOKEN;
  }
  return getStore(opts);
}
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
    req.setTimeout(7000, () => { req.destroy(); reject(new Error('timeout')); });
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

// ── 스케줄 페이지 파싱 ──
function parseSchedule(html) {
  const games = [];
  const seen  = new Set();
  let curMmdd = '';

  const tableM = html.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableM) return games;
  const tableHtml = tableM[1];

  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let tr;
  while ((tr = trRe.exec(tableHtml)) !== null) {
    const row = tr[1];
    const dateM = row.match(/(\d{1,2})\/(\d{1,2})[（(][日月火水木金土]/);
    if (dateM) curMmdd = String(dateM[1]).padStart(2,'0') + String(dateM[2]).padStart(2,'0');
    if (!curMmdd) continue;

    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c => clean(c[1]));
    if (cells.length < 2) continue;
    const rowText = cells.join(' ');
    if (rowText.trim().length < 3) continue;

    const linkM = row.match(/href="(\/scores\/2026\/(\d{4})\/([a-z]+)-([a-z]+)-\d+\/)"/);
    if (linkM) {
      const [, path, , awayC, homeC] = linkM;
      if (seen.has(path)) continue;
      seen.add(path);
      const scoreM = rowText.match(/(\d+)\s*[-−–]\s*(\d+)/);
      const venueM = rowText.match(/(東京ドーム|神宮|横浜|マツダ|甲子園|バンテリン|ZOZOマリン|エスコン|ベルーナ|京セラ|楽天モバイル|みずほPayPay|ほっと神戸)/);
      const timeM  = rowText.match(/(\d{1,2}:\d{2})/);
      const cancelled = rowText.includes('中止');
      const wpM = rowText.match(/勝[：:]\s*(\S{2,8})/);
      const lpM = rowText.match(/敗[：:]\s*(\S{2,8})/);
      games.push({
        mmdd: curMmdd, date: `2026-${curMmdd.slice(0,2)}-${curMmdd.slice(2,4)}`,
        away: URL_TEAM[awayC]||awayC.toUpperCase(), home: URL_TEAM[homeC]||homeC.toUpperCase(),
        awayScore: scoreM&&!cancelled?parseInt(scoreM[1]):null,
        homeScore: scoreM&&!cancelled?parseInt(scoreM[2]):null,
        venue: venueM?venueM[1]:null, time: timeM?timeM[1]:'18:00',
        status: cancelled?'cancelled':scoreM?'finished':'live', cancelled,
        winPitcher: wpM?wpM[1]:'', losePitcher: lpM?lpM[1]:'',
        link: `https://npb.jp${path}`, path,
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
    const usedKeys = new Set(); const teams = [];
    for (const tp of teamPositions) if (!usedKeys.has(tp.key)) { usedKeys.add(tp.key); teams.push(tp.key); }
    if (teams.length < 2) continue;
    const gameKey = `${curMmdd}-${teams[0]}-${teams[1]}`;
    if (seen.has(gameKey)) continue;
    seen.add(gameKey);
    const venueM2 = rowText.match(/(東京ドーム|神宮|横浜|マツダ|甲子園|バンテリン|ZOZOマリン|エスコン|ベルーナ|京セラ|楽天モバイル|みずほPayPay|ほっと神戸)/);
    const timeM2  = rowText.match(/(\d{1,2}:\d{2})/);
    games.push({
      mmdd: curMmdd, date: `2026-${curMmdd.slice(0,2)}-${curMmdd.slice(2,4)}`,
      away: teams[1], home: teams[0], awayScore: null, homeScore: null,
      venue: venueM2?venueM2[1]:null, time: timeM2?timeM2[1]:'18:00',
      status: 'scheduled', cancelled: false, winPitcher: '', losePitcher: '', link: null, path: null,
    });
  }
  return games;
}

// 예고선발 파싱
function parseStarters(html) {
  const starters = {};
  const idx = html.indexOf('予告先発');
  if (idx < 0) return starters;
  const section = html.slice(idx, idx + 6000);
  const rows = [...section.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  for (const [, row] of rows) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c => clean(c[1]));
    if (cells.length < 2) continue;
    let tk = null;
    for (const [name, key] of Object.entries(NAME_TEAM)) {
      if (cells[0].includes(name)) { tk = key; break; }
    }
    if (!tk) continue;
    for (let i=1; i<cells.length; i++) {
      const nm = cells[i].match(/([\u4E00-\u9FFF]{1,4}[\s　][\u4E00-\u9FFF\u30A0-\u30FF]{1,6})/);
      if (nm && !starters[tk]) { starters[tk] = nm[1].trim(); break; }
    }
  }
  return starters;
}

// ── NPB 리그 성적 파싱 (npb-stats용) ──
const STAT_URLS = {
  bat_c: 'https://npb.jp/bis/2026/stats/bat_c.html',
  bat_p: 'https://npb.jp/bis/2026/stats/bat_p.html',
  pit_c: 'https://npb.jp/bis/2026/stats/pit_c.html',
  pit_p: 'https://npb.jp/bis/2026/stats/pit_p.html',
  bat_inter: 'https://npb.jp/bis/2026/stats/bat_inter.html',
  pit_inter: 'https://npb.jp/bis/2026/stats/pit_inter.html',
  bat_op: 'https://npb.jp/bis/2026/stats/bat_op.html',
  pit_op: 'https://npb.jp/bis/2026/stats/pit_op.html',
};

function parseNPBStatsTable(html) {
  const dateMatch = html.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*現在/);
  const updatedAt = dateMatch ? `${dateMatch[1]}.${String(dateMatch[2]).padStart(2,'0')}.${String(dateMatch[3]).padStart(2,'0')}` : null;

  const tables = [];
  const tblRe = /<table[\s\S]*?<\/table>/gi;
  let tm;
  while ((tm = tblRe.exec(html)) !== null) tables.push(tm[0]);

  let target = null;
  for (const t of tables) {
    if (/<td[^>]*>\s*1\s*<\/td>/i.test(t)) { target = t; break; }
  }
  if (!target) return { headers:[], rows:[], updatedAt };

  const headers = [];
  const thRe = /<th[^>]*>([\s\S]*?)<\/th>/gi;
  let m;
  while ((m = thRe.exec(target)) !== null) {
    const t = clean(m[1]);
    if (t) headers.push(t);
  }

  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  while ((m = trRe.exec(target)) !== null) {
    const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)];
    if (tds.length < 5) continue;
    const cells = tds.map(t => clean(t[1]));
    if (/^\d+$/.test(cells[0])) rows.push(cells);
  }
  return { headers, rows, updatedAt };
}

const task = async () => {
  console.log('[scheduled-fetch] Starting NPB data collection...');
  const store = npbStore();
  const { mm, mmdd } = jstNow();
  const tmrMmdd = addDay(mmdd);
  const tmrMm = tmrMmdd.slice(0,2);

  // ── 1. 경기 스케줄 (시즌 시작 3월 ~ 다음날이 속한 월까지 전체) ──
  try {
    const months = new Set();
    const curMonthNum = parseInt(tmrMm); // 다음날 달까지 포함
    for (let mo = 3; mo <= Math.max(curMonthNum, parseInt(mm)); mo++) {
      months.add(String(mo).padStart(2,'0'));
    }

    // 병렬로 가져오기 (월별 페이지 수가 많아도 빠르게)
    const monthResults = await Promise.all([...months].map(async mo => {
      try {
        const html = await fetchUrl(`https://npb.jp/games/2026/schedule_${mo}_detail.html`);
        return parseSchedule(html);
      } catch(e) {
        console.error(`[scheduled-fetch] Month ${mo} fetch failed:`, e.message);
        return [];
      }
    }));
    const allGames = monthResults.flat();

    const starterHtml = await fetchUrl('https://npb.jp/announcement/starter/').catch(()=>'');
    const starters = parseStarters(starterHtml);

    const gamesData = {
      mmdd, tmrMmdd,
      todayGames: allGames.filter(g => g.mmdd === mmdd),
      tomorrowGames: allGames.filter(g => g.mmdd === tmrMmdd),
      starters,
      allGames, // 캘린더용 전체 데이터
      updatedAt: new Date().toISOString(),
    };

    await store.setJSON('games', gamesData);
    console.log(`[scheduled-fetch] Games saved: today=${gamesData.todayGames.length}, tmr=${gamesData.tomorrowGames.length}, total=${allGames.length}`);
  } catch(e) {
    console.error('[scheduled-fetch] Games fetch failed:', e.message);
  }

  // ── 2. 리그 개인 성적 ──
  try {
    const statsData = {};
    for (const [type, url] of Object.entries(STAT_URLS)) {
      try {
        const html = await fetchUrl(url);
        statsData[type] = parseNPBStatsTable(html);
      } catch(e) {
        console.error(`[scheduled-fetch] Stats ${type} failed:`, e.message);
        statsData[type] = { headers:[], rows:[], updatedAt:null };
      }
    }
    statsData.updatedAt = new Date().toISOString();
    await store.setJSON('stats', statsData);
    console.log('[scheduled-fetch] Stats saved');
  } catch(e) {
    console.error('[scheduled-fetch] Stats fetch failed:', e.message);
  }

  console.log('[scheduled-fetch] Done.');
};

// KST 05:00 = UTC 20:00 → "0 20 * * *"
module.exports.handler = schedule('0 20 * * *', task);
