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
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
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

const URL_TEAM = { g:'G',h:'H',s:'Sw',db:'DB',d:'D',t:'T',c:'C',f:'F',b:'Bs',e:'E',l:'L',m:'M' };
const NAME_TEAM = {
  '読売':'G','巨人':'G','ヤクルト':'Sw','スワローズ':'Sw',
  'DeNA':'DB','ベイスターズ':'DB','横浜':'DB',
  '中日':'D','ドラゴンズ':'D','阪神':'T','タイガース':'T',
  '広島':'C','カープ':'C','ソフトバンク':'H','ホークス':'H',
  '日本ハム':'F','ファイターズ':'F','オリックス':'Bs','バファローズ':'Bs',
  '楽天':'E','イーグルス':'E','西武':'L','ライオンズ':'L',
  'ロッテ':'M','マリーンズ':'M',
};
const TEAM_FULL = {
  G:'読売ジャイアンツ',Sw:'東京ヤクルトスワローズ',DB:'横浜DeNAベイスターズ',
  D:'中日ドラゴンズ',T:'阪神タイガース',C:'広島東洋カープ',
  H:'福岡ソフトバンクホークス',F:'北海道日本ハムファイターズ',
  Bs:'オリックス・バファローズ',E:'東北楽天ゴールデンイーグルス',
  L:'埼玉西武ライオンズ',M:'千葉ロッテマリーンズ',
};

function nameToKey(n) {
  for (const [k,v] of Object.entries(NAME_TEAM)) if(n.includes(k)) return v;
  return null;
}

// JST 날짜
function jstToday() {
  const jst = new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Tokyo'}));
  const m = String(jst.getMonth()+1).padStart(2,'0');
  const d = String(jst.getDate()).padStart(2,'0');
  return { yyyy:'2026', mmdd:`${m}${d}`, display:`${m}/${d}` };
}
function addDay(mmdd, n=1) {
  const m = parseInt(mmdd.slice(0,2)), d = parseInt(mmdd.slice(2,4));
  const dt = new Date(2026,m-1,d+n);
  return String(dt.getMonth()+1).padStart(2,'0')+String(dt.getDate()).padStart(2,'0');
}

// NPB 홈에서 경기 링크 + 스코어 파싱
function parseHomeGames(html) {
  const games = [];
  const seen = new Set();
  const re = /href="(\/scores\/2026\/(\d{4})\/([a-z]+)-([a-z]+)-(\d+)\/)"[^>]*>([^<]*)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const [,path,mmdd,awayC,homeC,,linkText] = m;
    if (seen.has(path)) continue; seen.add(path);

    const away = URL_TEAM[awayC]||awayC.toUpperCase();
    const home = URL_TEAM[homeC]||homeC.toUpperCase();
    const txt  = clean(linkText+' '+(html.slice(html.indexOf(`"${path}"`)-400, html.indexOf(`"${path}"`)+400)));

    const scoreM  = txt.match(/(\d+)[−\-–](\d+)/);
    const venueM  = txt.match(/[（(]([^）)]{2,15})[）)]/);
    const timeM   = txt.match(/(\d{1,2}:\d{2})/);
    const status  = txt.includes('試合終了') ? 'finished' : txt.includes('試合中') ? 'live' : 'scheduled';

    games.push({
      path, mmdd,
      date: `2026-${mmdd.slice(0,2)}-${mmdd.slice(2,4)}`,
      away, home,
      awayScore: scoreM ? parseInt(scoreM[1]) : null,
      homeScore: scoreM ? parseInt(scoreM[2]) : null,
      venue: venueM ? venueM[1] : null,
      time: timeM ? timeM[1] : '18:00',
      status,
      link: `https://npb.jp${path}`,
    });
  }
  return games;
}

// 박스스코어 파싱 (선수별 성적)
function parseBoxScore(html, gamePath) {
  const result = { batters:{away:[],home:[]}, pitchers:{away:[],home:[]}, mvp:null, notes:[] };

  // 테이블 전체
  const tables = [...html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)];
  let batAwayDone = false, batHomeDone = false;

  for (const [,tbody] of tables) {
    const rows = [...tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
    const dataRows = rows.filter(([,r]) => r.includes('<td'));
    if (dataRows.length < 3) continue;

    // 각 행 파싱
    const parsed = dataRows.map(([,r]) => {
      const cells = [...r.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(([,c]) => clean(c));
      return cells;
    }).filter(c => c.length >= 4);

    if (parsed.length === 0) continue;

    // 타자 테이블 판별: 첫 셀이 포지션(捕/一/二/三/遊/左/中/右/指/打)
    const isPosRow = parsed[0][0] && /^[捕一二三遊左中右指打投]$/.test(parsed[0][0]);
    const isNameRow = parsed[0][1] && /^[\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF]+/.test(parsed[0][1]);

    if (isPosRow && isNameRow) {
      const batters = parsed.map(c => ({
        pos: c[0], name: c[1],
        ab: c[2]||'', r: c[3]||'', h: c[4]||'', rbi: c[5]||'',
        bb: c[6]||'', k: c[7]||'', avg: c[c.length-1]||'',
      }));
      if (!batAwayDone) { result.batters.away = batters; batAwayDone = true; }
      else if (!batHomeDone) { result.batters.home = batters; batHomeDone = true; }
    }

    // 투수 테이블: 승/敗/S/H 패턴
    const firstRow = parsed[0];
    if (firstRow && firstRow.some(c => ['勝','敗','Ｓ','Ｈ','S','H'].includes(c.trim()))) {
      const pitchers = parsed.map(c => ({
        name: c[0], ip: c[1]||'', bf: c[2]||'', np: c[3]||'',
        h: c[4]||'', hr: c[5]||'', bb: c[6]||'', k: c[7]||'',
        r: c[8]||'', er: c[9]||'', era: c[c.length-1]||'',
        result: firstRow.findIndex(h=>['勝','敗','S','H','Ｓ','Ｈ'].includes(h))>=0
          ? c[firstRow.findIndex(h=>['勝','敗','S','H','Ｓ','Ｈ'].includes(h))]||'' : '',
      }));
      if (result.pitchers.away.length===0) result.pitchers.away = pitchers;
      else result.pitchers.home = pitchers;
    }
  }

  // 최다 안타/타점 선수 → MVP 후보
  const allBatters = [...result.batters.away,...result.batters.home];
  if (allBatters.length > 0) {
    const mvpCandidate = allBatters.reduce((best,b) => {
      const score = parseInt(b.h||0)*2 + parseInt(b.rbi||0)*3 + parseInt(b.r||0);
      const bScore = parseInt(best.h||0)*2+parseInt(best.rbi||0)*3+parseInt(best.r||0);
      return score > bScore ? b : best;
    }, allBatters[0]);
    result.mvp = mvpCandidate;
  }

  return result;
}

// 예고선발 파싱
function parseStarters(html) {
  const starters = {};
  // "明日の予告先発" 섹션 찾기
  const idx = html.indexOf('予告先発');
  if (idx < 0) return starters;
  const section = html.slice(idx, idx+4000);
  // 팀명 + 선수명 추출
  const lines = section.split('\n').map(l=>clean(l)).filter(l=>l.length>1 && l.length<50);
  let currentTeam = null;
  for (const line of lines) {
    const teamKey = nameToKey(line);
    if (teamKey) { currentTeam = teamKey; continue; }
    // 선수명: 한자+공백+한자 패턴
    if (currentTeam && /[\u4E00-\u9FFF]{1,4}[\s　][\u4E00-\u9FFF\u30A0-\u30FF]{1,5}/.test(line)) {
      const m = line.match(/([^\s]{1,4}[\s　][^\s]{1,5})/);
      if (m && !starters[currentTeam]) starters[currentTeam] = m[1].trim();
    }
  }
  return starters;
}

exports.handler = async (event) => {
  const params = event.queryStringParameters||{};
  const action = params.action||'today';

  try {
    let data = {};
    const {yyyy, mmdd} = jstToday();
    const tmrMmdd = addDay(mmdd, 1);

    if (action === 'today') {
      // NPB 홈에서 오늘/내일 데이터 한번에 수집
      const homeHtml = await fetchUrl('https://npb.jp/');
      const allGames = parseHomeGames(homeHtml);
      const starters = parseStarters(homeHtml);

      const todayGames   = allGames.filter(g => g.mmdd === mmdd);
      const tomorrowGames= allGames.filter(g => g.mmdd === tmrMmdd);

      data = { mmdd, tmrMmdd, todayGames, tomorrowGames, starters };

    } else if (action === 'boxscore') {
      // ?action=boxscore&path=/scores/2026/0611/f-db-03/
      const path = params.path;
      if (!path) return {statusCode:400, body:JSON.stringify({error:'No path'})};
      const boxHtml = await fetchUrl(`https://npb.jp${path}box.html`);
      const box = parseBoxScore(boxHtml, path);
      // 이닝별 스코어도 수집
      const mainHtml = await fetchUrl(`https://npb.jp${path}`);
      const scoreM = mainHtml.match(/<table[^>]*class="[^"]*score[^"]*"[^>]*>([\s\S]*?)<\/table>/i);
      data = { path, box, rawSnippet: scoreM ? clean(scoreM[1]).slice(0,500) : '' };

    } else if (action === 'day') {
      // ?action=day&mmdd=0611 (과거 날짜)
      const targetMmdd = params.mmdd || mmdd;
      // 해당날 경기 페이지 샘플 하나 가져오기
      const homeHtml = await fetchUrl('https://npb.jp/');
      const allGames = parseHomeGames(homeHtml);
      let dayGames = allGames.filter(g => g.mmdd === targetMmdd);

      // 홈에 없으면 (오래된 날짜) 개별 경기 URL 패턴으로 시도
      if (dayGames.length === 0) {
        // 알려진 팀 코드로 브루트포스
        const codes = ['g','h','s','db','d','t','c','f','b','e','l','m'];
        const attempts = [];
        for (let i=0; i<codes.length; i++) {
          for (let j=0; j<codes.length; j++) {
            if (i===j) continue;
            attempts.push(`/scores/2026/${targetMmdd}/${codes[i]}-${codes[j]}-01/`);
          }
        }
        // 병렬로 4개씩 시도
        for (let i=0; i<attempts.length && dayGames.length===0; i+=4) {
          const batch = attempts.slice(i,i+4).map(path =>
            fetchUrl(`https://npb.jp${path}`).then(h => ({path, html:h})).catch(()=>null)
          );
          const results = await Promise.all(batch);
          for (const r of results) {
            if (r && r.html) {
              const games = parseHomeGames(r.html).filter(g=>g.mmdd===targetMmdd);
              dayGames = [...dayGames, ...games];
              if (dayGames.length > 0) break;
            }
          }
        }
      }
      data = { mmdd: targetMmdd, games: dayGames };
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type':'application/json; charset=utf-8',
        'Cache-Control':'public, max-age=600',
        'Access-Control-Allow-Origin':'*',
      },
      body: JSON.stringify(data),
    };
  } catch(err) {
    return {
      statusCode: 500,
      headers: {'Access-Control-Allow-Origin':'*'},
      body: JSON.stringify({error: err.message}),
    };
  }
};
