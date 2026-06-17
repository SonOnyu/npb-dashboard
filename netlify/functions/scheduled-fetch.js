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

function nameToKey(name) {
  for (const [k, v] of Object.entries(NAME_TEAM)) {
    if (name.includes(k)) return v;
  }
  return null;
}

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
function subDay(mmdd) {
  const m = parseInt(mmdd.slice(0,2)), d = parseInt(mmdd.slice(2,4));
  const dt = new Date(2026, m-1, d-1);
  return String(dt.getMonth()+1).padStart(2,'0') + String(dt.getDate()).padStart(2,'0');
}

// ── 스케줄 페이지 파싱 — 예고선발도 함께 추출 ──
function parseSchedule(html) {
  const games = [];
  const seen  = new Set();
  // 날짜별 예고선발 맵: {mmdd: {teamKey: pitcherName}}
  const startersByDate = {};
  let curMmdd = '';

  const tableM = html.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableM) return { games, startersByDate };
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

    // 예고선발 추출 — 마지막 컬럼에서 한자 이름 2개 추출
    // 형식: "才木　武内" (전각 스페이스 구분, 원정-홈 순서)
    // 또는 "勝：才木　敗：渡邉" (종료 경기)
    const starterCell = cells[cells.length - 1] || '';
    if (starterCell.includes('予告先発')) {
      if (!startersByDate[curMmdd]) startersByDate[curMmdd] = {};
      // "予告先発：隅田" 또는 "勝：X　敗：Y" 형태
      const starterM = starterCell.match(/予告先発[：:]\s*(\S+)/g);
      if (starterM) {
        // 이 행의 팀 파악
        for (const s of starterM) {
          const pitcherName = s.replace(/予告先発[：:]\s*/, '').trim();
          // 같은 행에서 팀 찾기
          for (const [name, key] of Object.entries(NAME_TEAM)) {
            if (rowText.includes(name)) {
              if (!startersByDate[curMmdd][key]) {
                startersByDate[curMmdd][key] = pitcherName;
              }
              break;
            }
          }
        }
      }
    }

    const linkM = row.match(/href="(\/scores\/2026\/(\d{4})\/([a-z]+)-([a-z]+)-\d+\/)"/);

    // 예고선발 — linkM 여부와 관계없이 마지막 컬럼에서 추출
    // 실제 형식: "先発：才木 先発：武内" (원정선발 홈선발 순서)
    let starterAway = '', starterHome = '';
    {
      const scoreCheck = rowText.match(/(\d+)\s*[-−–]\s*(\d+)/);
      if (starterCell && !scoreCheck) {
        const starterNames = [...starterCell.matchAll(/先発[：:]\s*([^\s　先発]+)/g)].map(m => m[1].trim()).filter(n => n.length > 0);
        if (starterNames.length >= 2) {
          starterHome = starterNames[0];  // 첫번째 = 홈팀 선발
          starterAway = starterNames[1];  // 두번째 = 원정팀 선발
        } else if (starterNames.length === 1) {
          starterHome = starterNames[0];
        }
      }
    }

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
        status: cancelled?'cancelled':scoreM?'finished':'scheduled', cancelled,
        winPitcher: wpM?wpM[1]:'', losePitcher: lpM?lpM[1]:'',
        link: `https://npb.jp${path}`, path,
        starterHome, starterAway,
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
      status: 'scheduled', cancelled: false, winPitcher: '', losePitcher: '',
      link: null, path: null, starterHome, starterAway,
    });
  }
  return { games, startersByDate };
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

const STANDINGS_URLS = {
  cl: 'https://npb.jp/bis/2026/stats/std_c.html',
  pl: 'https://npb.jp/bis/2026/stats/std_p.html',
  inter: 'https://npb.jp/bis/2026/stats/std_inter.html',
};

// 순위표(チーム勝敗表) 파싱 — 行: チーム名 | 試合 | 勝利 | 敗北 | 引分 | 勝率 | 差 | ホーム | ロード | ...対戦成績 | 交流戦
function parseStandingsTable(html) {
  const dateMatch = html.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*現在/);
  const updatedAt = dateMatch ? `${dateMatch[1]}.${String(dateMatch[2]).padStart(2,'0')}.${String(dateMatch[3]).padStart(2,'0')}` : null;

  const tables = [];
  const tblRe = /<table[\s\S]*?<\/table>/gi;
  let tm;
  while ((tm = tblRe.exec(html)) !== null) tables.push(tm[0]);

  // 순위표는 "チーム勝敗表" 직후 첫 테이블. 헤더에 "勝率"이 포함된 첫 테이블을 찾음
  let target = null;
  for (const t of tables) {
    if (t.includes('勝率') && t.includes('試合')) { target = t; break; }
  }
  if (!target) return { rows: [], updatedAt };

  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  let rank = 0;
  while ((m = trRe.exec(target)) !== null) {
    const cells = [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => clean(c[1]));
    if (cells.length < 6) continue;

    const teamKey = nameToKey(cells[0]);
    if (!teamKey) continue; // 헤더 행 등 스킵

    rank++;
    rows.push({
      rank,
      team: teamKey,
      g: cells[1] || '',
      w: cells[2] || '',
      l: cells[3] || '',
      draw: cells[4] || '',
      pct: cells[5] || '',
      gb: cells[6] || '',
      home: cells[7] || '',
      away: cells[8] || '',
    });
  }
  return { rows, updatedAt };
}

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


// ── Claude API 호출 ──
function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      messages: [{ role:'user', content: prompt }],
    });
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          const text = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
          resolve(text);
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// JSON 파싱 실패 시 자동 복구: 문자열 내부의 줄바꿈/탭 이스케이프
function tryFixJson(str) {
  let result = '';
  let inString = false;
  let escapeNext = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (escapeNext) { result += ch; escapeNext = false; continue; }
    if (ch === '\\') { result += ch; escapeNext = true; continue; }
    if (ch === '"') { inString = !inString; result += ch; continue; }
    if (inString) {
      if (ch === '\n') { result += '\\n'; continue; }
      if (ch === '\r') { continue; }
      if (ch === '\t') { result += '\\t'; continue; }
    }
    result += ch;
  }
  return result;
}

function parseAIJson(raw) {
  const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const m = cleaned.match(/\[[\s\S]*\]/);
  if (!m) return null;
  try { return JSON.parse(m[0]); }
  catch(e) {
    try { return JSON.parse(tryFixJson(m[0])); }
    catch(e2) { return null; }
  }
}

const TEAM_CONTEXT = `## 팀 시즌 성적 컨텍스트 (2026 현재)
- 세이부(L): PL 1위 .627 득실+54, 선발 평균자책 2.3
- 소프트뱅크(H): PL 2위 .593 득실+51, 타선 평균득점 4.44
- 한신(T): CL 2위 .561 득실+22, 佐藤輝明 WAR4.2
- 요미우리(G): CL 1위 .569 득실+6
- 오릭스(Bs): PL 3위 .542 宮城大弥 FIP-63
- 야쿠르트(Sw): CL 3위 .542 무라카미 6월 부활
- DeNA(DB): CL 4위 .431 원정 부진
- 히로시마(C): CL 5위 .389 선발 부상이탈 다수
- 닛폰햄(F): PL 4위 .532 에스콘 홈 강세
- 롯데(M): PL 중위권 홈 강세
- 주니치(D): CL 최하위 .356 불펜 柳裕也 복귀
- 라쿠텐(E): PL 하위권 득점력 저조`;

function buildPredictPrompt(games, starters) {
  return `당신은 NPB(일본프로야구) 전문 애널리스트입니다.
아래 경기 데이터를 기반으로 각 경기의 매우 상세한 심층 분석을 JSON으로만 반환하세요.
당신의 NPB 지식(2026 시즌 각 팀의 최근 선발 로테이션, 타선 구성, 불펜 운용, 최근 부상/이적/컨디션 뉴스 등)을 최대한 활용해 구체적인 수치와 근거를 제시하세요.

## 경기 데이터
${JSON.stringify(games, null, 2)}

## 예고선발
${JSON.stringify(starters, null, 2)}

${TEAM_CONTEXT}

각 경기마다 다음 JSON 구조로 분석하세요. 정확히 이 키 이름과 순서를 사용하세요 (JSON 배열, 마크다운 없이 순수 JSON만):
[
  {
    "gameId": "F-DB",
    "homeTeam": "팀키",
    "awayTeam": "팀키",
    "starterHome": "홈 예고선발 선수명 또는 미정",
    "starterAway": "원정 예고선발 선수명 또는 미정",
    "batter1Name": "주목 타자1 이름(한국어) — 반드시 타자 포지션 선수만. 선발투수(starterHome/starterAway)는 절대 타자로 넣지 말 것",
    "batter1Team": "팀키",
    "batter1Stat": "타율/OPS 등 수치",
    "batter1Note": "한줄 설명",
    "batter2Name": "주목 타자2 이름(한국어) — 반드시 타자 포지션 선수만. 선발투수는 절대 타자로 넣지 말 것",
    "batter2Team": "팀키",
    "batter2Stat": "수치",
    "batter2Note": "한줄 설명",
    "pitcher1Name": "주목 투수1 이름(한국어)",
    "pitcher1Team": "팀키",
    "pitcher1Role": "선발 또는 중계 또는 마무리",
    "pitcher1Era": "방어율",
    "pitcher1Note": "한줄 설명",
    "pitcher2Name": "주목 투수2 이름(한국어)",
    "pitcher2Team": "팀키",
    "pitcher2Role": "선발 또는 중계 또는 마무리",
    "pitcher2Era": "방어율",
    "pitcher2Note": "한줄 설명",
    "winProbHome": 55,
    "winProbAway": 45,
    "confidence": "high 또는 medium 또는 low",
    "lineupAnalysis": "선발 라인업 분석 2~3문장. 친절하고 자연스러운 한국어 문장으로 작성. 수치나 기록처럼 중요한 정보는 **굵게** 표시 (예: **최근 3연속 퀄리티스타트**, **ERA 2.15**). 독자가 쉽게 읽을 수 있도록 부드럽고 생동감 있게 서술.",
    "newsAnalysis": "최근 동향 1~2문장. 친절한 말투로, 팀/선수 상황을 독자에게 설명하듯 자연스럽게. 중요 키워드는 **굵게**.",
    "coreReason": "핵심 근거 1~2문장. 판단의 가장 중요한 이유를 쉽고 명확하게. 수치는 **굵게**.",
    "variable": "경기 흐름을 바꿀 수 있는 변수 1문장. 구체적이고 생동감 있게.",
    "issue": "최근 주목할 이슈 1문장. 중요 정보는 **굵게**.",
    "verdict": "최종 판정 한 문장. 자신감 있고 명확하게."
  }
]

매우 중요한 규칙:
1. 출력은 순수 JSON 배열 하나만. 코드블록 마커(백틱) 쓰지 말 것.
2. 모든 문자열 값은 줄바꿈 없이 한 줄로 작성.
3. 문자열 내부에 쌍따옴표(") 절대 쓰지 말 것. 필요하면 따옴표 없이 표현.
4. 위에 나열된 모든 키를 빠짐없이 포함할 것. 정보가 없으면 빈 문자열 ""을 넣을 것.
5. batter1/2는 반드시 야수(타자) 포지션 선수만. starterHome/starterAway에 적힌 선발투수는 batter가 아닌 pitcher에만 넣을 것.
5. 각 문자열 값은 간결하게 한 줄로 작성할 것. 총 응답이 2000토큰을 넘지 않도록 할 것.
6. 분석 텍스트는 딱딱한 보고서체가 아닌, 친절하고 자연스러운 한국어 문장으로 작성. 독자에게 설명하듯 부드럽게.
7. 수치, 기록, 중요 키워드(예: 연속 퀄리티스타트, 홈런왕, 방어율 1위 등)는 **텍스트** 형식으로 Bold 마킹할 것.`;
}

function buildReviewPrompt(predictions, actualResults) {
  return `당신은 NPB 애널리스트입니다. 아래에 주어진 실제 경기 데이터를 기반으로 분석해주세요.

## 절대 규칙
- homeTeam/awayTeam 팀 키(G/Sw/DB/D/T/C/H/F/Bs/E/L/M)와 점수만을 사실로 취급할 것.
- 예측 당시 분석이 없으면 predictedWinner 빈 문자열, predictionAccuracy "예측 없음", hitAnalysis/missAnalysis 빈 문자열.
- 박스스코어(allBatters, topBatter, winPitcher 등)가 제공된 경우 반드시 실제 데이터 기반으로 MVP/최악 선정.
- 박스스코어가 없으면 스코어와 선발투수 기준으로 합리적 추론.
- mvpName/worstName에 "정보 없음" 절대 금지. 반드시 실존 선수명 기재.
- MVP는 타자/투수 모두 고려 (타자 우선: 타점, 결승타, 안타 기준. 투수: 완봉, 완투, 구원 성공).
- 최악은 패전투수, 무안타 타자, 실책 선수 등 구체적으로.
- 분석은 친절하고 자연스러운 한국어로. 중요 수치는 **굵게** 표시.

## 예측 당시 분석
${JSON.stringify(predictions, null, 2)}

## 실제 결과 (allBatters: 타자성적 배열, topBatter: 최다타점/안타 타자, winPitcher/losePitcher 포함)
${JSON.stringify(actualResults, null, 2)}

각 경기마다 JSON 구조로 분석 (JSON 배열, 순수 JSON만, 백틱 금지):
[
  {
    "gameId": "L-T",
    "homeTeam": "팀키",
    "awayTeam": "팀키",
    "predictedWinner": "예측 우세팀(팀키) 또는 빈 문자열",
    "actualWinner": "실제 승팀(팀키)",
    "correct": true,
    "score": "원정점수-홈점수",
    "predictionAccuracy": "적중 또는 미적중 또는 예측 없음",
    "hitAnalysis": "적중 근거 2~3문장. 미적중이면 빈 문자열.",
    "missAnalysis": "빗나간 이유 2~3문장. 적중이면 빈 문자열.",
    "unexpectedEvents": "예상 못한 변수 1~2문장. 없으면 빈 문자열.",
    "mvpName": "최고 활약 선수명(한국어 병기) — 타자 우선",
    "mvpTeam": "팀키",
    "mvpPerformance": "구체적 활약 (예: 4타수 2안타 1타점, 완봉승 9이닝 1실점)",
    "mvpReason": "MVP 선정 이유 1문장",
    "worstName": "최악 활약 선수명(한국어 병기)",
    "worstTeam": "팀키",
    "worstPerformance": "구체적 부진 내용 (예: 4타수 0안타, 5이닝 4실점)",
    "worstReason": "최악 선정 이유 1문장",
    "highlight": "경기 하이라이트 한 문장"
  }
]

규칙: 1)순수 JSON만 2)한 줄로 3)쌍따옴표 금지 4)모든 키 포함 5)mvpName/worstName 반드시 실존 선수명`;
}


// ── 스코어보드 페이지에서 최종 점수 파싱 ──
// 팀키 → URL코드 역방향 맵
const TEAM_URL = {G:'g',Sw:'s',DB:'db',D:'d',T:'t',C:'c',H:'h',F:'f',Bs:'b',E:'e',L:'l',M:'m'};

async function fetchGameScore(away, home, mmdd) {
  const awayCode = TEAM_URL[away] || away.toLowerCase();
  const homeCode = TEAM_URL[home] || home.toLowerCase();
  for (let n = 1; n <= 6; n++) {
    const path = `/scores/2026/${mmdd}/${homeCode}-${awayCode}-0${n}/`;
    try {
      const html = await fetchUrl(`https://npb.jp${path}`);
      if (!html.includes('試合終了')) continue;

      // 페이지 내 모든 score div 추출
      const allScores = [...html.matchAll(/<div class="score">(\d+)-(\d+)<\/div>/g)];
      // 페이지 내 모든 경기 링크 추출 (내비게이션 순서, 중복 제거)
      const uniqueLinks = [...new Set([...html.matchAll(/href="(\/scores\/2026\/\d{4}\/[a-z]+-[a-z]+-\d+\/)"/g)].map(m => m[1]))];
      // 현재 path의 인덱스로 해당 경기 스코어 선택
      const myIdx = uniqueLinks.findIndex(l => l === path);

      let homeScore = null, awayScore = null;
      if (myIdx >= 0 && allScores[myIdx]) {
        homeScore = parseInt(allScores[myIdx][1]);
        awayScore = parseInt(allScores[myIdx][2]);
      } else if (allScores.length > 0) {
        homeScore = parseInt(allScores[0][1]);
        awayScore = parseInt(allScores[0][2]);
      }
      if (homeScore === null) continue;

      console.log(`[fetchGameScore] ${path}: home=${homeScore} away=${awayScore}`);

      // 박스스코어에서 승투/패전 투수 파싱
      let boxData = {};
      try {
        const boxHtml = await fetchUrl(`https://npb.jp${path}box.html`);
        // 승투/패전/세이브 투수 — "勝利 武内夏暉 3勝0敗" 형태
        const wpM = boxHtml.match(/勝利\s+([\u4E00-\u9FFF\u30A0-\u30FF]{2,8})\s*\d+勝/);
        const lpM = boxHtml.match(/敗戦\s+([\u4E00-\u9FFF\u30A0-\u30FF]{2,8})\s*\d+敗/);
        const svM = boxHtml.match(/セーブ\s+([\u4E00-\u9FFF\u30A0-\u30FF]{2,8})\s*\d+S/);

        // 타자 성적 파싱 — 표에서 이름/타수/득점/안타/타점 추출
        // 패턴: "桑原" 링크 텍스트 + 이어지는 숫자 셀들
        const batRows = [...boxHtml.matchAll(/\[([^\]]{2,8})\]\(https:\/\/npb\.jp\/bis\/players\/[^)]+\)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)/g)];
        const batters = batRows
          .map(m => ({name: m[1].trim(), ab: parseInt(m[2]), r: parseInt(m[3]), h: parseInt(m[4]), rbi: parseInt(m[5])}))
          .filter(b => b.ab > 0);

        // 최고 타자 (타점 → 안타 순으로 정렬)
        const topBatter = batters.sort((a,b) => (b.rbi - a.rbi) || (b.h - a.h))[0] || null;
        // 최악 타자 (안타 없고 타수 많은 선수)
        const worstBatter = [...batters].sort((a,b) => (a.h - b.h) || (b.ab - a.ab))[0] || null;

        boxData = {
          winPitcher:  wpM ? wpM[1].trim() : '',
          losePitcher: lpM ? lpM[1].trim() : '',
          savePitcher: svM ? svM[1].trim() : '',
          topBatter,
          worstBatter,
          allBatters: batters,
        };
        console.log(`[fetchGameScore] box: wp=${boxData.winPitcher} lp=${boxData.losePitcher} topBat=${topBatter?.name}(${topBatter?.h}H${topBatter?.rbi}RBI) worstBat=${worstBatter?.name}(${worstBatter?.h}H/${worstBatter?.ab}AB)`);
      } catch(e) {
        console.log(`[fetchGameScore] box.html error: ${e.message}`);
      }

      return { awayScore, homeScore, finished: true, path, ...boxData };
    } catch(e) {
      if (!e.message.includes('404')) console.log(`[fetchGameScore] error: ${e.message}`);
    }
  }
  return null;
}

// ── 박스스코어 전용 파싱 (스코어는 이미 알고있을 때) ──
async function fetchBoxScore(away, home, mmdd) {
  const awayCode = TEAM_URL[away] || away.toLowerCase();
  const homeCode = TEAM_URL[home] || home.toLowerCase();
  for (let n = 1; n <= 6; n++) {
    const path = `/scores/2026/${mmdd}/${homeCode}-${awayCode}-0${n}/box.html`;
    try {
      const boxHtml = await fetchUrl(`https://npb.jp${path}`);
      if (!boxHtml.includes('試合終了')) continue;

      // 승투/패전 투수
      const wpM = boxHtml.match(/勝利\s+([\u4E00-\u9FFF\u30A0-\u30FF]{2,8})\s*\d+勝/);
      const lpM = boxHtml.match(/敗戦\s+([\u4E00-\u9FFF\u30A0-\u30FF]{2,8})\s*\d+敗/);
      const svM = boxHtml.match(/セーブ\s+([\u4E00-\u9FFF\u30A0-\u30FF]{2,8})\s*\d+S/);

      // 타자 성적 — 마크다운 링크 형태: [桑原](url) | 5 | 0 | 1 | 1
      const batRows = [...boxHtml.matchAll(/\[([^\]]{2,8})\]\(https:\/\/npb\.jp\/bis\/players\/[^)]+\)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)/g)];
      const batters = batRows
        .map(m => ({name: m[1].trim(), ab: parseInt(m[2]), r: parseInt(m[3]), h: parseInt(m[4]), rbi: parseInt(m[5])}))
        .filter(b => b.ab > 0);

      const topBatter   = batters.length ? [...batters].sort((a,b) => (b.rbi-a.rbi)||(b.h-a.h))[0] : null;
      const worstBatter = batters.length ? [...batters].sort((a,b) => (a.h-b.h)||(b.ab-a.ab))[0] : null;

      const result = {
        winPitcher:  wpM ? wpM[1].trim() : '',
        losePitcher: lpM ? lpM[1].trim() : '',
        savePitcher: svM ? svM[1].trim() : '',
        topBatter, worstBatter, allBatters: batters,
      };
      console.log(`[fetchBoxScore] ${path}: wp=${result.winPitcher} lp=${result.losePitcher} topBat=${topBatter?.name}(${topBatter?.h}H${topBatter?.rbi}RBI)`);
      return result;
    } catch(e) {
      if (!e.message.includes('404')) console.log(`[fetchBoxScore] error: ${e.message}`);
    }
  }
  return null;
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
        return { games: [], startersByDate: {} };
      }
    }));
    const allGames = monthResults.flatMap(r => r.games);


    // 오늘/내일 경기의 예고선발을 날짜별로 분리하여 추출
    const todayGamesRaw = allGames.filter(g => g.mmdd === mmdd);
    const tmrGames      = allGames.filter(g => g.mmdd === tmrMmdd);

    // 오늘 선발 (표시용은 아니고 AI 리뷰용)
    const startersToday = {};
    for (const g of todayGamesRaw) {
      if (g.starterHome) startersToday[g.home] = g.starterHome;
      if (g.starterAway) startersToday[g.away] = g.starterAway;
    }
    // 내일 선발 (다음 경기 분석 표시용)
    const startersTmr = {};
    for (const g of tmrGames) {
      if (g.starterHome) startersTmr[g.home] = g.starterHome;
      if (g.starterAway) startersTmr[g.away] = g.starterAway;
    }
    // starters = 내일 선발만 저장 (프론트에서 다음 경기 분석에 사용)
    const starters = startersTmr;
    console.log('[scheduled-fetch] Starters today:', JSON.stringify(startersToday));
    console.log('[scheduled-fetch] Starters tmr:', JSON.stringify(startersTmr));

    // 오늘 경기 중 status=scheduled인 경우 스코어보드에서 실제 결과 확인
    for (const g of todayGamesRaw) {
      if (g.status === 'scheduled') {
        const result = await fetchGameScore(g.away, g.home, mmdd);
        if (result) {
          g.status = 'finished';
          g.awayScore = result.awayScore;
          g.homeScore = result.homeScore;
          if (result.winPitcher) g.winPitcher = result.winPitcher;
          if (result.losePitcher) g.losePitcher = result.losePitcher;
          if (result.path) g.path = result.path;
          console.log(`[scheduled-fetch] Score updated: ${g.away} ${g.awayScore}-${g.homeScore} ${g.home} (${result.path})`);
        }
      }
    }

    const gamesData = {
      mmdd, tmrMmdd,
      todayGames: todayGamesRaw,
      tomorrowGames: tmrGames,
      starters,
      allGames,
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

  // ── 2.5. 순위표 (CL/PL 順位表) ──
  try {
    const standingsData = {};
    for (const [league, url] of Object.entries(STANDINGS_URLS)) {
      try {
        const html = await fetchUrl(url);
        standingsData[league] = parseStandingsTable(html);
      } catch(e) {
        console.error(`[scheduled-fetch] Standings ${league} failed:`, e.message);
        standingsData[league] = { rows: [], updatedAt: null };
      }
    }
    standingsData.updatedAt = new Date().toISOString();
    await store.setJSON('standings', standingsData);
    console.log(`[scheduled-fetch] Standings saved: cl=${standingsData.cl.rows.length}, pl=${standingsData.pl.rows.length}, inter=${standingsData.inter?.rows.length||0}`);
  } catch(e) {
    console.error('[scheduled-fetch] Standings fetch failed:', e.message);
  }

  // ── 3. 다음 경기 AI 예측 분석 ──
  // ── 3. 다음 경기 AI 예측 분석 ──
  let predictRanThisRun = false;
  try {
    const gamesData = await store.get('games', { type: 'json' });
    if (gamesData) {
      const todayScheduled = (gamesData.todayGames||[]).filter(g => g.status === 'scheduled');
      const useToday = todayScheduled.length > 0;
      const targetGames = useToday ? todayScheduled : (gamesData.tomorrowGames || []);
      const targetMmdd  = useToday ? gamesData.mmdd : gamesData.tmrMmdd;

      if (targetGames.length > 0) {
        const existingPredict = await store.get('predict-analysis', { type: 'json' });
        if (!existingPredict || existingPredict.tmrMmdd !== targetMmdd) {
          console.log(`[scheduled-fetch] Running predict analysis for ${targetGames.length} games (${targetMmdd})...`);
          const prompt = buildPredictPrompt(targetGames, gamesData.starters || {});
          const raw = await callClaude(prompt);
          const analyses = parseAIJson(raw);
          if (analyses) {
            await store.setJSON('predict-analysis', {
              tmrMmdd: targetMmdd, analyses, savedAt: new Date().toISOString(),
            });
            console.log(`[scheduled-fetch] Predict analysis saved: ${analyses.length} games`);
            predictRanThisRun = true;
          } else {
            console.error('[scheduled-fetch] Predict analysis JSON parse failed');
          }
        } else {
          console.log('[scheduled-fetch] Predict analysis already up to date');
        }
      }
    }
  } catch(e) {
    console.error('[scheduled-fetch] Predict analysis failed:', e.message);
  }

  // ── 4. 어제 경기 결과 리뷰 분석 ──
  try {
    const gamesData = await store.get('games', { type: 'json' });
    if (gamesData) {
      const yestMmdd = subDay(gamesData.mmdd);
      const finishedGames = (gamesData.allGames || []).filter(g => g.mmdd === yestMmdd && g.status === 'finished');
      if (finishedGames.length > 0) {
        const existingReview = await store.get('review-analysis', { type: 'json' });
        if (!existingReview || existingReview.mmdd !== yestMmdd) {
          // 어제 경기 box.html에서 타자/투수 성적 보강 (path 없어도 팀코드로 직접 조회)
          for (const g of finishedGames) {
            if (!g.allBatters) {
              const boxResult = await fetchBoxScore(g.away, g.home, yestMmdd).catch(() => null);
              if (boxResult) {
                g.winPitcher  = boxResult.winPitcher  || g.winPitcher;
                g.losePitcher = boxResult.losePitcher || g.losePitcher;
                g.topBatter   = boxResult.topBatter;
                g.worstBatter = boxResult.worstBatter;
                g.allBatters  = boxResult.allBatters;
                console.log(`[scheduled-fetch] Box loaded: ${g.away}vs${g.home} wp=${g.winPitcher} topBat=${g.topBatter?.name}`);
              }
            }
          }
          const predictCache = await store.get('predict-analysis', { type: 'json' });
          const predictions = (predictCache && predictCache.tmrMmdd === yestMmdd)
            ? predictCache.analyses : [];
          console.log(`[scheduled-fetch] Running review analysis for ${finishedGames.length} games (${yestMmdd})...`);
          const prompt = buildReviewPrompt(predictions, finishedGames);
          const raw = await callClaude(prompt);
          const reviews = parseAIJson(raw);
          if (reviews) {
            await store.setJSON('review-analysis', {
              mmdd: yestMmdd, reviews, savedAt: new Date().toISOString(),
            });
            console.log(`[scheduled-fetch] Review analysis saved: ${reviews.length} games`);
          } else {
            console.error('[scheduled-fetch] Review analysis JSON parse failed');
          }
        } else {
          console.log('[scheduled-fetch] Review analysis already up to date');
        }
      } else {
        console.log(`[scheduled-fetch] No finished games for review (${yestMmdd})`);
      }
    }
  } catch(e) {
    console.error('[scheduled-fetch] Review analysis failed:', e.message);
  }

  console.log('[scheduled-fetch] Done.');
};

// KST 05:00 = UTC 20:00
module.exports.handler = schedule('0 20 * * *', task);
