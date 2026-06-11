const https = require('https');

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ja,en;q=0.9',
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
    }).on('error', reject);
  });
}

function clean(s) {
  return s.replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&')
          .replace(/[\r\n\t]+/g,' ').replace(/\s{2,}/g,' ').trim();
}

const URL_TEAM = {
  g:'G',h:'H',s:'Sw',db:'DB',d:'D',t:'T',
  c:'C',f:'F',b:'Bs',e:'E',l:'L',m:'M'
};
const NAME_TEAM = {
  '読売':'G','巨人':'G','ヤクルト':'Sw','スワローズ':'Sw',
  'DeNA':'DB','ベイスターズ':'DB','横浜DeNA':'DB',
  '中日':'D','ドラゴンズ':'D','阪神':'T','タイガース':'T',
  '広島':'C','カープ':'C','ソフトバンク':'H','ホークス':'H',
  '日本ハム':'F','ファイターズ':'F','オリックス':'Bs','バファローズ':'Bs',
  '楽天':'E','イーグルス':'E','西武':'L','ライオンズ':'L',
  'ロッテ':'M','マリーンズ':'M',
};

function nameToKey(n) {
  for (const [k,v] of Object.entries(NAME_TEAM)) if (n.includes(k)) return v;
  return null;
}

function jstNow() {
  const d = new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Tokyo'}));
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  return { mm, dd, mmdd: mm+dd };
}

function addDays(mmdd, n) {
  const m = parseInt(mmdd.slice(0,2)), d = parseInt(mmdd.slice(2,4));
  const dt = new Date(2026, m-1, d+n);
  return String(dt.getMonth()+1).padStart(2,'0') + String(dt.getDate()).padStart(2,'0');
}

// ── 핵심: 테이블 행 파싱 ──
// schedule_MM_detail.html의 <tr> 행을 파싱
// 결과 있는 경기: /scores/2026/MMDD/x-y-01/ 링크 있음
// 예정 경기: 링크 없고 팀명만 텍스트로 존재
function parseScheduleRows(html) {
  const games = [];
  const seen  = new Set();
  let curDate = '';  // 현재 파싱 중인 날짜 (MMDD)

  // <tr> 행 전체 추출
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let tr;

  while ((tr = trRe.exec(html)) !== null) {
    const row = tr[1];
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
                    .map(c => clean(c[1]));

    if (cells.length < 2) continue;

    // ── 날짜 셀 파싱: "6/12（金）" 패턴 ──
    const dateCellM = cells[0].match(/^(\d{1,2})\/(\d{1,2})[（(]/);
    if (dateCellM) {
      const mm = String(dateCellM[1]).padStart(2,'0');
      const dd = String(dateCellM[2]).padStart(2,'0');
      curDate = mm + dd;
    }

    if (!curDate) continue;

    // ── 대전카드 셀 파싱 ──
    // 결과 있는 경기: "/scores/2026/0611/f-db-03/" 링크 포함
    const linkM = row.match(/href="(\/scores\/2026\/(\d{4})\/([a-z]+)-([a-z]+)-(\d+)\/)"/);

    if (linkM) {
      // ── 결과 있는 경기 ──
      const [, path, mmdd, awayC, homeC] = linkM;
      const key = path;
      if (seen.has(key)) continue;
      seen.add(key);

      const away = URL_TEAM[awayC] || awayC.toUpperCase();
      const home = URL_TEAM[homeC] || homeC.toUpperCase();

      // 스코어
      const ctx    = cells.join(' ');
      const scoreM = ctx.match(/(\d+)\s*[-−–]\s*(\d+)/);
      const cancelled = ctx.includes('中止') || ctx.includes('中断');
      const venueM = ctx.match(/([^\s]{2,15}(?:ドーム|スタジアム|球場|マツダ|神宮|甲子園|ZOZOマリン|エスコン|ペイペイ|楽天モバイル|ベルーナ|バンテリン|東京ドーム))/);
      const timeM  = ctx.match(/(\d{1,2}:\d{2})/);
      const wpM    = ctx.match(/勝[：:]\s*([^\s　敗]{2,8})/);
      const lpM    = ctx.match(/敗[：:]\s*([^\s　勝]{2,8})/);

      games.push({
        path, mmdd: curDate,
        date: `2026-${curDate.slice(0,2)}-${curDate.slice(2,4)}`,
        away, home,
        awayScore:   scoreM ? parseInt(scoreM[1]) : null,
        homeScore:   scoreM ? parseInt(scoreM[2]) : null,
        venue:       venueM ? venueM[1] : null,
        time:        timeM  ? timeM[1]  : '18:00',
        status:      cancelled ? 'cancelled' : scoreM ? 'finished' : 'live',
        cancelled,
        winPitcher:  wpM ? wpM[1].trim() : '',
        losePitcher: lpM ? lpM[1].trim() : '',
        link:        `https://npb.jp${path}`,
      });

    } else {
      // ── 예정 경기 (링크 없음) ──
      // 대전카드 셀에서 팀명 2개 추출
      const ctx = cells.join(' ');
      if (ctx.includes('中止') || ctx.includes('休')) continue;

      // 팀명 추출: NAME_TEAM 키로 매칭
      const foundTeams = [];
      for (const [name, key] of Object.entries(NAME_TEAM)) {
        if (ctx.includes(name) && !foundTeams.includes(key)) {
          foundTeams.push(key);
        }
      }

      if (foundTeams.length < 2) continue;

      // 첫 번째가 홈, 두 번째가 원정 (NPB 테이블: 홈 vs 원정 순)
      // 실제로는 "홈팀 스코어-스코어 원정팀" 이지만 예정경기는 순서 불명확
      // 구장명으로 홈 추정
      const [team1, team2] = foundTeams;
      const venueM2 = ctx.match(/([^\s]{2,15}(?:ドーム|スタジアム|球場|マツダ|神宮|甲子園|ZOZOマリン|エスコン|ペイペイ|楽天モバイル|ベルーナ|バンテリン|東京ドーム))/);
      const timeM2  = ctx.match(/(\d{1,2}:\d{2})/);
      const gameKey = `${curDate}-${team1}-${team2}`;
      if (seen.has(gameKey)) continue;
      seen.add(gameKey);

      games.push({
        path:        null,
        mmdd:        curDate,
        date:        `2026-${curDate.slice(0,2)}-${curDate.slice(2,4)}`,
        away:        team2,   // NPB 테이블: 왼쪽=홈, 오른쪽=원정
        home:        team1,
        awayScore:   null,
        homeScore:   null,
        venue:       venueM2 ? venueM2[1] : null,
        time:        timeM2  ? timeM2[1]  : '18:00',
        status:      'scheduled',
        cancelled:   false,
        winPitcher:  '',
        losePitcher: '',
        link:        null,
      });
    }
  }

  return games;
}

// 예고선발 파싱
function parseStarters(html) {
  const starters = {};
  const idx = html.indexOf('予告先発');
  if (idx < 0) return starters;
  const section = html.slice(idx, idx + 6000);

  // 테이블에서 팀명 + 선수명 추출
  const rows = [...section.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  for (const [, row] of rows) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
                    .map(c => clean(c[1]));
    if (cells.length < 2) continue;

    // 팀명 셀
    const tk = nameToKey(cells[0]);
    if (!tk) continue;

    // 선수명 셀 — 한자 이름 패턴
    for (let i = 1; i < cells.length; i++) {
      const nm = cells[i].match(/([\u4E00-\u9FFF]{1,4}[\s　][\u4E00-\u9FFF\u30A0-\u30FF]{1,6})/);
      if (nm && !starters[tk]) {
        starters[tk] = nm[1].trim();
        break;
      }
    }
  }
  return starters;
}

function ok(data) {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=600',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(data),
  };
}

exports.handler = async (event) => {
  const p = event.queryStringParameters || {};
  const action = p.action || 'today';

  try {
    const { mm, dd, mmdd } = jstNow();
    const tmrMmdd = addDays(mmdd, 1);
    const tmrMm   = tmrMmdd.slice(0, 2);

    // 필요한 월 스케줄 페이지 로드
    const months = new Set([mm]);
    if (action === 'day' && p.mmdd) months.add(p.mmdd.slice(0,2));
    if (action === 'today') months.add(tmrMm);
    if (action === 'schedule' && p.mm) months.add(p.mm);

    const htmlMap = {};
    await Promise.all([...months].map(async mo => {
      const url = `https://npb.jp/games/2026/schedule_${mo}_detail.html`;
      htmlMap[mo] = await fetchUrl(url).catch(() => '');
    }));

    // 예고선발
    const starterHtml = await fetchUrl('https://npb.jp/announcement/starter/').catch(() => '');
    const starters = parseStarters(starterHtml);

    if (action === 'today') {
      const thisGames = parseScheduleRows(htmlMap[mm] || '');
      const nextGames = mm !== tmrMm
        ? parseScheduleRows(htmlMap[tmrMm] || '')
        : thisGames;

      const todayGames    = thisGames.filter(g => g.mmdd === mmdd);
      const tomorrowGames = (mm !== tmrMm ? nextGames : thisGames)
                              .filter(g => g.mmdd === tmrMmdd);

      return ok({ mmdd, tmrMmdd, todayGames, tomorrowGames, starters });

    } else if (action === 'day') {
      const target = p.mmdd || mmdd;
      const mo     = target.slice(0, 2);
      const html   = htmlMap[mo] || await fetchUrl(
        `https://npb.jp/games/2026/schedule_${mo}_detail.html`
      ).catch(() => '');
      const games = parseScheduleRows(html).filter(g => g.mmdd === target);
      return ok({ mmdd: target, games });

    } else if (action === 'schedule') {
      const mo   = p.mm || mm;
      const html = htmlMap[mo] || '';
      const all  = parseScheduleRows(html);
      const byDate = {};
      for (const g of all) {
        if (!byDate[g.mmdd]) byDate[g.mmdd] = [];
        byDate[g.mmdd].push(g);
      }
      return ok({ mm: mo, byDate });
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action' }) };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
