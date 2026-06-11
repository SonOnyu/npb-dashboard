const https = require('https');

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ja,en;q=0.9',
        'Referer': 'https://npb.jp/',
      }
    }, (res) => {
      if ([301,302].includes(res.statusCode)) return fetchUrl(res.headers.location).then(resolve).catch(reject);
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
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

const URL_TEAM = {g:'G',h:'H',s:'Sw',db:'DB',d:'D',t:'T',c:'C',f:'F',b:'Bs',e:'E',l:'L',m:'M'};
const NAME_TEAM = {
  '読売':'G','巨人':'G','ヤクルト':'Sw','スワローズ':'Sw',
  'DeNA':'DB','ベイスターズ':'DB','横浜':'DB',
  '中日':'D','ドラゴンズ':'D','阪神':'T','タイガース':'T',
  '広島':'C','カープ':'C','ソフトバンク':'H','ホークス':'H',
  '日本ハム':'F','ファイターズ':'F','オリックス':'Bs','バファローズ':'Bs',
  '楽天':'E','イーグルス':'E','西武':'L','ライオンズ':'L',
  'ロッテ':'M','マリーンズ':'M',
};

function nameToKey(n) {
  for (const [k,v] of Object.entries(NAME_TEAM)) if(n.includes(k)) return v;
  return null;
}

function jstNow() {
  const jst = new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Tokyo'}));
  const mm  = String(jst.getMonth()+1).padStart(2,'0');
  const dd  = String(jst.getDate()).padStart(2,'0');
  return { yyyy:'2026', mm, dd, mmdd:`${mm}${dd}` };
}

// schedule_MM_detail.html 파싱 → 모든 경기 추출
function parseSchedulePage(html) {
  const games = [];
  const seen  = new Set();

  // 경기 링크 패턴: /scores/2026/0611/f-db-03/
  const linkRe = /href="(\/scores\/2026\/(\d{4})\/([a-z]+)-([a-z]+)-(\d+)\/)"/g;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const [, path, mmdd, awayC, homeC] = m;
    if (seen.has(path)) continue;
    seen.add(path);

    const away = URL_TEAM[awayC] || awayC.toUpperCase();
    const home = URL_TEAM[homeC] || homeC.toUpperCase();

    // 링크 주변 컨텍스트 (테이블 행 전체)
    const idx = html.indexOf(`"${path}"`);
    const ctx = clean(html.slice(Math.max(0,idx-600), idx+600));

    // 스코어: "3 - 2" 또는 "3-2"
    const scoreM  = ctx.match(/(\d+)\s*[-−–]\s*(\d+)/);
    // 중지
    const cancelled = ctx.includes('中止') || ctx.includes('中断');
    // 구장 (球場)
    const venueM  = ctx.match(/([^\s]{2,10}(?:ドーム|スタジアム|球場|マツダ|神宮|甲子園|ZOZOマリン|エスコン|ペイペイ|楽天モバイル|ベルーナ|バンテリン))/);
    // 시간
    const timeM   = ctx.match(/(\d{1,2}:\d{2})/);
    // 상태
    const status  = cancelled ? 'cancelled' :
                    (scoreM ? 'finished' :
                    (ctx.includes('試合中') ? 'live' : 'scheduled'));
    // 예고선발 / 책임투수
    const starterM = ctx.match(/(?:予告先発|勝：|敗：)([^\s　]{2,6})/g);

    // 날짜 추출 (테이블 행에서 "6/2（火）" 패턴)
    const dateM = ctx.match(/(\d{1,2})\/(\d{1,2})[（(]/);
    const rowMm = dateM ? String(dateM[1]).padStart(2,'0') : mmdd.slice(0,2);
    const rowDd = dateM ? String(dateM[2]).padStart(2,'0') : mmdd.slice(2,4);

    // 책임투수
    let winPitcher='', losePitcher='';
    const wpM  = ctx.match(/勝[：:]\s*([^\s　敗]{2,6})/);
    const lpM  = ctx.match(/敗[：:]\s*([^\s　勝]{2,6})/);
    if (wpM) winPitcher  = wpM[1].trim();
    if (lpM) losePitcher = lpM[1].trim();

    games.push({
      path,
      mmdd,
      date: `2026-${rowMm}-${rowDd}`,
      away, home,
      awayScore: scoreM ? parseInt(scoreM[1]) : null,
      homeScore: scoreM ? parseInt(scoreM[2]) : null,
      venue: venueM ? venueM[1] : null,
      time:  timeM  ? timeM[1]  : '18:00',
      status,
      cancelled,
      winPitcher,
      losePitcher,
      link: `https://npb.jp${path}`,
    });
  }
  return games;
}

// 예고선발 페이지 파싱
function parseStarters(html) {
  const starters = {};
  const idx = html.indexOf('予告先発');
  if (idx < 0) return starters;
  const section = html.slice(idx, idx+5000);

  // "チーム名　選手名" 패턴
  const lines = section.split('\n').map(l=>clean(l)).filter(l=>l.length>1&&l.length<60);
  let curTeam = null;
  for (const line of lines) {
    const tk = nameToKey(line);
    if (tk) { curTeam = tk; continue; }
    if (curTeam && /[\u4E00-\u9FFF\u30A0-\u30FF]{1,4}[\s　][\u4E00-\u9FFF\u30A0-\u30FF]{1,6}/.test(line)) {
      const nm = line.match(/([\u4E00-\u9FFF\u30A0-\u30FF]{1,4}[\s　][\u4E00-\u9FFF\u30A0-\u30FF]{1,6})/);
      if (nm && !starters[curTeam]) starters[curTeam] = nm[1].trim();
    }
  }
  return starters;
}

exports.handler = async (event) => {
  const p = event.queryStringParameters || {};
  const action = p.action || 'today';

  try {
    const { yyyy, mm, mmdd } = jstNow();

    // 내일 날짜 계산
    const today = new Date(2026, parseInt(mm)-1, parseInt(mmdd.slice(2,4)));
    const tmr   = new Date(today); tmr.setDate(tmr.getDate()+1);
    const tmrMm = String(tmr.getMonth()+1).padStart(2,'0');
    const tmrDd = String(tmr.getDate()).padStart(2,'0');
    const tmrMmdd = `${tmrMm}${tmrDd}`;

    // 필요한 월 목록
    const months = new Set([mm, tmrMm]);
    if (p.mmdd) months.add(p.mmdd.slice(0,2));

    // 월별 스케줄 페이지 병렬 로드
    const scheduleHtmls = {};
    await Promise.all([...months].map(async mo => {
      const url = `https://npb.jp/games/2026/schedule_${mo}_detail.html`;
      scheduleHtmls[mo] = await fetchUrl(url).catch(() => '');
    }));

    // 예고선발 (NPB 공식 예고선발 페이지)
    const starterHtml = await fetchUrl('https://npb.jp/announcement/starter/').catch(()=>'');
    const starters = parseStarters(starterHtml);

    if (action === 'today') {
      // 오늘 결과 + 내일 예정
      const allThisMon  = parseSchedulePage(scheduleHtmls[mm]||'');
      const allNextMon  = mm !== tmrMm ? parseSchedulePage(scheduleHtmls[tmrMm]||'') : [];
      const allGames    = [...allThisMon, ...allNextMon];

      const todayGames    = allGames.filter(g => g.mmdd === mmdd);
      const tomorrowGames = allGames.filter(g => g.mmdd === tmrMmdd);

      return ok({ mmdd, tmrMmdd, todayGames, tomorrowGames, starters });

    } else if (action === 'day') {
      // ?action=day&mmdd=0602
      const target = p.mmdd || mmdd;
      const mo     = target.slice(0,2);
      const html   = scheduleHtmls[mo] || await fetchUrl(`https://npb.jp/games/2026/schedule_${mo}_detail.html`).catch(()=>'');
      const all    = parseSchedulePage(html);
      const games  = all.filter(g => g.mmdd === target);
      return ok({ mmdd: target, games });

    } else if (action === 'schedule') {
      // ?action=schedule&mm=06  → 해당 월 전체 반환
      const mo   = p.mm || mm;
      const html = scheduleHtmls[mo] || '';
      const all  = parseSchedulePage(html);
      // 날짜별 그룹핑
      const byDate = {};
      for (const g of all) {
        if (!byDate[g.mmdd]) byDate[g.mmdd] = [];
        byDate[g.mmdd].push(g);
      }
      return ok({ mm: mo, byDate });
    }

    return { statusCode:400, body: JSON.stringify({error:'Unknown action'}) };

  } catch(err) {
    return {
      statusCode: 500,
      headers: {'Access-Control-Allow-Origin':'*'},
      body: JSON.stringify({error: err.message}),
    };
  }
};

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
