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
          .replace(/[\s　\r\n\t]+/g,' ').trim();
}

// npb.jp/scores/2026/MMDD/ 파싱
function parseScores(html, dateStr) {
  const games = [];

  // 각 경기 블록: <section class="gm-summary"> 또는 <div class="col-game">
  // NPB는 테이블 기반 — <table class="score-table"> 패턴 사용
  const gameBlocks = html.match(/<(?:section|div)[^>]+class="[^"]*(?:gm-summary|col-game|score)[^"]*"[^>]*>[\s\S]*?<\/(?:section|div)>/gi) || [];

  // 대안: 링크 기반 파싱 (더 안정적)
  // https://npb.jp/scores/2026/0611/g-h-01/ 형태
  const scoreLinks = html.match(/href="\/scores\/\d{4}\/\d{4}\/[a-z]+-[a-z]+-\d+\/"/gi) || [];
  const uniqueLinks = [...new Set(scoreLinks.map(l => l.replace(/href="|"/g, '')))];

  // 팀 이름 → 약자 매핑
  const TEAM_ABBR = {
    '読売':'G','巨人':'G','ジャイアンツ':'G',
    'ヤクルト':'Sw','スワローズ':'Sw',
    'DeNA':'DB','ベイスターズ':'DB','横浜':'DB',
    '中日':'D','ドラゴンズ':'D',
    '阪神':'T','タイガース':'T',
    '広島':'C','カープ':'C',
    'ソフトバンク':'H','ホークス':'H','福岡':'H',
    '日本ハム':'F','ファイターズ':'F','北海道':'F',
    'オリックス':'Bs','バファローズ':'Bs',
    '楽天':'E','イーグルス':'E','東北':'E',
    '西武':'L','ライオンズ':'L','埼玉':'L',
    'ロッテ':'M','マリーンズ':'M','千葉':'M',
  };

  function teamKey(name) {
    for (const [k,v] of Object.entries(TEAM_ABBR)) {
      if (name.includes(k)) return v;
    }
    return name.slice(0,2);
  }

  // URL에서 팀 약자 추출: /g-h-01/ → home=G, away=H
  const URL_TEAM = { g:'G', h:'H', s:'Sw', db:'DB', d:'D', t:'T', c:'C',
                     f:'F', b:'Bs', e:'E', l:'L', m:'M' };

  if (uniqueLinks.length > 0) {
    uniqueLinks.forEach(link => {
      const m = link.match(/\/scores\/\d{4}\/(\d{4})\/([a-z]+)-([a-z]+)-(\d+)\//);
      if (!m) return;
      const [,date, away, home, gnum] = m;
      games.push({
        date,
        away: URL_TEAM[away] || away.toUpperCase(),
        home: URL_TEAM[home] || home.toUpperCase(),
        gameNum: parseInt(gnum),
        link: `https://npb.jp${link}`,
        score: null, // 상세 파싱은 별도
      });
    });
  }

  return games;
}

// 날짜별 스코어 페이지 파싱
async function fetchDayGames(dateStr) {
  // dateStr: "20260611"
  const mmdd = dateStr.slice(4,8);
  const yyyy = dateStr.slice(0,4);
  const url = `https://npb.jp/scores/${yyyy}/${mmdd}/`;

  const html = await fetchUrl(url);

  // 스코어 테이블에서 팀명/점수 파싱
  const games = [];

  // 패턴: 팀명 숫자 vs 팀명 숫자
  // NPB 스코어 페이지는 <table>로 각 경기 표시
  const tableBlocks = [...html.matchAll(/<table[^>]*>[\s\S]*?<\/table>/gi)];

  // 경기 링크에서 팀 추출
  const links = [...html.matchAll(/href="(\/scores\/\d{4}\/\d{4}\/[^"]+)"/gi)];
  const seen = new Set();

  for (const [, path] of links) {
    if (seen.has(path)) continue;
    seen.add(path);
    const m = path.match(/\/scores\/(\d{4})\/(\d{4})\/([a-z]+)-([a-z]+)-(\d+)\//);
    if (!m) continue;
    const [, yyyy2, mmdd2, away, home, gnum] = m;
    const URL_TEAM = { g:'G', h:'H', s:'Sw', db:'DB', d:'D', t:'T', c:'C',
                       f:'F', b:'Bs', e:'E', l:'L', m:'M' };

    // 해당 경기 점수 찾기 — 링크 주변 텍스트에서 스코어 추출
    const linkIdx = html.indexOf(`"${path}"`);
    const surrounding = html.slice(Math.max(0, linkIdx-500), linkIdx+500);

    // 스코어 패턴 추출 (숫자-숫자)
    const scoreMatch = surrounding.match(/(\d+)\s*[−\-–]\s*(\d+)/);
    const timeMatch  = surrounding.match(/(\d{1,2}):(\d{2})/);

    // 구장 이름 추출
    const venueMatch = surrounding.match(/（([^）]+)）|【([^】]+)】/);

    games.push({
      date: `${yyyy2}-${mmdd2.slice(0,2)}-${mmdd2.slice(2,4)}`,
      away: URL_TEAM[away] || away.toUpperCase(),
      home: URL_TEAM[home] || home.toUpperCase(),
      awayScore: scoreMatch ? parseInt(scoreMatch[1]) : null,
      homeScore: scoreMatch ? parseInt(scoreMatch[2]) : null,
      time: timeMatch ? `${timeMatch[1]}:${timeMatch[2]}` : null,
      venue: venueMatch ? (venueMatch[1]||venueMatch[2]) : null,
      link: `https://npb.jp${path}`,
    });
  }

  return { date: dateStr, games };
}

// 월별 스케줄 파싱
async function fetchMonthSchedule(yyyy, mm) {
  const url = `https://npb.jp/games/${yyyy}/schedule_${mm}_detail.html`;
  const html = await fetchUrl(url).catch(() => null);
  if (!html) {
    // fallback: 메인 스케줄
    const html2 = await fetchUrl(`https://npb.jp/games/${yyyy}/schedule.html`);
    return parseScheduleHtml(html2, yyyy, mm);
  }
  return parseScheduleHtml(html, yyyy, mm);
}

function parseScheduleHtml(html, yyyy, mm) {
  const gameDays = {};
  // href="/scores/2026/0612/..." 패턴에서 경기 있는 날짜 추출
  const links = [...html.matchAll(/href="\/scores\/\d{4}\/(\d{2})(\d{2})\/"/gi)];
  for (const [, m, d] of links) {
    const key = `${yyyy}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
    gameDays[key] = true;
  }
  // 직접 날짜 링크도
  const links2 = [...html.matchAll(/href="\/scores\/(\d{4})\/(\d{4})\/[^"]+"/gi)];
  for (const [, y, mmdd] of links2) {
    const key = `${y}-${mmdd.slice(0,2)}-${mmdd.slice(2,4)}`;
    gameDays[key] = true;
  }
  return { yyyy, mm, gameDays: Object.keys(gameDays) };
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const action = params.action || 'day';

  try {
    let data;

    if (action === 'day') {
      // ?action=day&date=20260611
      const date = params.date || new Date().toISOString().slice(0,10).replace(/-/g,'');
      data = await fetchDayGames(date);

    } else if (action === 'month') {
      // ?action=month&yyyy=2026&mm=06
      const yyyy = params.yyyy || '2026';
      const mm   = params.mm || '06';
      data = await fetchMonthSchedule(yyyy, mm);

    } else {
      return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action' }) };
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=1800',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
