// AI 분석 — 캐시 우선, 없으면 실시간 호출 (사용자 요청 기반이라 호출 빈도 낮음)
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


// JSON 파싱 실패 시 자동 복구: 문자열 내부의 줄바꿈/탭을 이스케이프
// 상태머신 방식으로 문자열 내부/외부를 정확히 추적
function tryFixJson(str) {
  let result = '';
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];

    if (escapeNext) {
      result += ch;
      escapeNext = false;
      continue;
    }

    if (ch === '\\') {
      result += ch;
      escapeNext = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }

    if (inString) {
      // 문자열 내부의 실제 줄바꿈/탭/CR을 이스케이프 시퀀스로 변환
      if (ch === '\n') { result += '\\n'; continue; }
      if (ch === '\r') { continue; } // CR 제거
      if (ch === '\t') { result += '\\t'; continue; }
    }

    result += ch;
  }

  return result;
}

function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    console.log('[npb-analyze] API key present:', !!process.env.ANTHROPIC_API_KEY, 'length:', (process.env.ANTHROPIC_API_KEY||'').length);
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
        const raw = Buffer.concat(chunks).toString();
        console.log('[npb-analyze] HTTP status:', res.statusCode, 'raw (first 300):', raw.slice(0,300));
        try {
          const data = JSON.parse(raw);
          const text = (data.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
          resolve(text);
        } catch(e) {
          console.error('[npb-analyze] JSON parse error:', e.message);
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  const params = event.queryStringParameters||{};
  const mode = params.mode||'predict';

  let bodyData = {};
  if (event.body) {
    try { bodyData = JSON.parse(event.body); } catch(e) {}
  }

  try {
    const store = npbStore();

    const force = params.force === '1' || bodyData.force === true;

    // ── 캐시 삭제 모드 ──
    if (mode === 'clear') {
      await store.delete('predict-analysis');
      await store.delete('review-analysis');
      return ok({ cleared: true, message: 'predict-analysis, review-analysis 캐시 삭제 완료' });
    }

    // ── 캐시 확인 (predict 모드만 — 매일 한번 분석하면 충분) ──
    if (mode === 'predict' && !force) {
      const cached = await store.get('predict-analysis', { type: 'json' });
      const gamesCache = await store.get('games', { type: 'json' });

      // 캐시가 오늘/내일 경기 기준으로 유효한지 확인
      if (cached && gamesCache) {
        const todayScheduled = (gamesCache.todayGames||[]).some(g => g.status === 'scheduled' || g.status === 'live');
        const cacheKey = todayScheduled ? gamesCache.mmdd : gamesCache.tmrMmdd;
        if (cached.tmrMmdd === cacheKey) {
          return ok({ analyses: cached.analyses, cached: true });
        }
      }
      // 캐시 없음 → 즉시 반환 (실시간 호출 시 26초 타임아웃 위험)
      return ok({ analyses: [], error: 'no_cache', message: 'AI 분석 준비 중입니다. KST 05:00 자동 갱신 시 생성됩니다.' });
    }

    if (mode === 'review' && !force) {
      const cached = await store.get('review-analysis', { type: 'json' });
      const targetMmdd = bodyData.actualResults?.[0]?.mmdd;
      if (cached && cached.mmdd === targetMmdd) {
        return ok({ reviews: cached.reviews, cached: true });
      }
      // 캐시 없음 → 실시간 호출 시 타임아웃/토큰 낭비 위험이 크므로 스킵
      return ok({ reviews: [], error: 'no_cache', message: '아직 AI 분석이 준비되지 않았습니다.' });
    }

    // ── 캐시 없음 → 실시간 분석 ──
    let prompt = '';
    let result = {};

    if (mode === 'predict') {
      const { games, starters } = bodyData;

      prompt = `당신은 NPB(일본프로야구) 전문 애널리스트입니다.
아래 경기 데이터를 기반으로 각 경기의 매우 상세한 심층 분석을 JSON으로만 반환하세요.
당신의 NPB 지식(2026 시즌 각 팀의 최근 선발 로테이션, 타선 구성, 불펜 운용, 최근 부상/이적/컨디션 뉴스 등)을 최대한 활용해 구체적인 수치와 근거를 제시하세요.

## 경기 데이터
${JSON.stringify(games, null, 2)}

## 예고선발
${JSON.stringify(starters, null, 2)}

## 팀 시즌 성적 컨텍스트 (2026 현재)
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
- 라쿠텐(E): PL 하위권 득점력 저조

각 경기마다 다음 JSON 구조로 분석하세요. 정확히 이 키 이름과 순서를 사용하세요 (JSON 배열, 마크다운 없이 순수 JSON만):
[
  {
    "gameId": "F-DB",
    "homeTeam": "팀키",
    "awayTeam": "팀키",
    "starterHome": "홈 예고선발 선수명 또는 미정",
    "starterAway": "원정 예고선발 선수명 또는 미정",
    "batter1Name": "주목 타자1 이름(한국어) — 반드시 野手(타자/야수)만. 투수 절대 불가.",
    "batter1Team": "팀키",
    "batter1Stat": "타율/OPS 등 타격 수치",
    "batter1Note": "한줄 설명",
    "batter2Name": "주목 타자2 이름(한국어) — 반드시 野手(타자/야수)만. 투수 절대 불가.",
    "batter2Team": "팀키",
    "batter2Stat": "타율/OPS 등 타격 수치",
    "batter2Note": "한줄 설명",
    "pitcher1Name": "주목 투수1 이름(한국어) — 반드시 投手(투수)만. 타자 절대 불가.",
    "pitcher1Team": "팀키",
    "pitcher1Role": "선발 또는 중계 또는 마무리",
    "pitcher1Era": "방어율",
    "pitcher1Note": "한줄 설명",
    "pitcher2Name": "주목 투수2 이름(한국어) — 반드시 投手(투수)만. 타자 절대 불가.",
    "pitcher2Team": "팀키",
    "pitcher2Role": "선발 또는 중계 또는 마무리",
    "pitcher2Era": "방어율",
    "pitcher2Note": "한줄 설명",
    "winProbHome": 55,
    "winProbAway": 45,
    "confidence": "high 또는 medium 또는 low",
    "lineupAnalysis": "선발 라인업 분석 2~3문장. 양팀 선발투수 방어율, 핵심 타자 타율/OPS 비교.",
    "newsAnalysis": "최근 동향 1~2문장. 부상·컨디션 이슈 등.",
    "coreReason": "핵심 근거 1~2문장.",
    "variable": "변수 1문장",
    "issue": "최근 이슈 1문장",
    "verdict": "최종 판정 한 문장"
  }
]

매우 중요한 규칙:
1. 출력은 순수 JSON 배열 하나만. 코드블록 마커(백틱) 쓰지 말 것.
2. 모든 문자열 값은 줄바꿈 없이 한 줄로 작성.
3. 문자열 내부에 쌍따옴표(") 절대 쓰지 말 것. 필요하면 따옴표 없이 표현.
4. 위에 나열된 모든 키를 빠짐없이 포함할 것. 정보가 없으면 빈 문자열 ""을 넣을 것.
5. 각 문자열 값은 간결하게 한 줄로 작성할 것. 총 응답이 2000토큰을 넘지 않도록 할 것.
6. batter1Name/batter2Name에는 반드시 타자(野手)만 입력할 것. 투수를 타자 슬롯에 넣는 것은 절대 금지.
7. pitcher1Name/pitcher2Name에는 반드시 투수(投手)만 입력할 것. 타자를 투수 슬롯에 넣는 것은 절대 금지.`;

      const raw = await callClaude(prompt);
      const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      console.log('[npb-analyze] cleaned (first 200):', cleaned.slice(0,200));
      console.log('[npb-analyze] cleaned (last 200):', cleaned.slice(-200));
      const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
      console.log('[npb-analyze] jsonMatch found:', !!jsonMatch);
      if (jsonMatch) {
        try {
          const analyses = JSON.parse(jsonMatch[0]);
          result = { analyses };
          // 캐시 저장
          const gamesCache = await store.get('games', { type: 'json' });
          await store.setJSON('predict-analysis', {
            tmrMmdd: gamesCache?.tmrMmdd, analyses, savedAt: new Date().toISOString(),
          });
        } catch(e) {
          console.error('[npb-analyze] JSON.parse failed, attempting fix:', e.message);
          try {
            const fixed = tryFixJson(jsonMatch[0]);
            const analyses = JSON.parse(fixed);
            result = { analyses };
            const gamesCache = await store.get('games', { type: 'json' });
            await store.setJSON('predict-analysis', {
              tmrMmdd: gamesCache?.tmrMmdd, analyses, savedAt: new Date().toISOString(),
            });
            console.log('[npb-analyze] Fixed and parsed successfully');
          } catch(e2) {
            console.error('[npb-analyze] Fix also failed:', e2.message);
            // 실패 위치 주변 텍스트 출력
            const posMatch = e.message.match(/position (\d+)/);
            if (posMatch) {
              const pos = parseInt(posMatch[1]);
              console.error('[npb-analyze] Context around error:', JSON.stringify(jsonMatch[0].slice(Math.max(0,pos-50), pos+50)));
            }
            result = { raw: cleaned, error: 'parse_failed', parseError: e.message };
          }
        }
      } else {
        result = { raw: cleaned, error: 'no_json' };
      }

    } else if (mode === 'review') {
      const { predictions, actualResults, boxScores } = bodyData;

      prompt = `당신은 NPB 애널리스트입니다. 아래에 주어진 실제 경기 데이터(팀 키, 점수)를 기반으로 분석해주세요.

## 절대 규칙 (매우 중요)
- "실제 결과"에 주어진 homeTeam, awayTeam 팀 키(G/Sw/DB/D/T/C/H/F/Bs/E/L/M)와 점수만을 사실로 취급할 것.
- 주어진 팀 키 외의 다른 팀 이름(예: DeNA, 소프트뱅크 등)을 임의로 등장시키지 말 것. gameId의 팀 키와 homeTeam/awayTeam 필드를 그대로 사용할 것.
- "예측 당시 분석"이 빈 배열이거나 해당 경기 정보가 없으면, predictedWinner는 빈 문자열로, predictionAccuracy는 "예측 없음"으로, hitAnalysis와 missAnalysis는 빈 문자열로 둘 것. 가상의 예측 근거를 만들어내지 말 것.
- 박스스코어가 제공되지 않으면 MVP/최악 선수의 이름을 "정보 없음"으로 표기하고, 가상의 선수명이나 활약상을 지어내지 말 것. 대신 mvpPerformance/worstPerformance에는 "박스스코어 미제공"이라고만 적을 것.
- highlight는 주어진 팀 키와 점수를 사실대로만 서술할 것 (예: "F가 D를 9-5로 이겼다" 등 팀 키 기반 서술, 임의의 팀명 사용 금지).

## 예측 당시 분석
${JSON.stringify(predictions, null, 2)}

## 실제 결과
${JSON.stringify(actualResults, null, 2)}

## 박스스코어 (있는 경우)
${JSON.stringify(boxScores||[], null, 2)}

각 경기마다 다음 JSON 구조로 분석하세요. 정확히 이 키 이름과 순서를 사용하세요 (JSON 배열, 마크다운 없이 순수 JSON만):
[
  {
    "gameId": "F-DB",
    "homeTeam": "팀키",
    "awayTeam": "팀키",
    "predictedWinner": "예측한 우세팀(팀키)",
    "actualWinner": "실제 승팀(팀키)",
    "correct": true,
    "score": "원정팀점수-홈팀점수 형식, 예: awayScore가 5이고 homeScore가 9면 5-9",
    "predictionAccuracy": "적중 또는 미적중",
    "hitAnalysis": "예측이 적중했다면 어떤 분석 근거(선발 방어율, 타선 OPS, 최근 흐름 등)가 실제로 작용했는지 2~3문장으로 구체적으로 설명. 미적중이면 빈 문자열.",
    "missAnalysis": "예측이 빗나갔다면 어떤 부분에서 미스가 있었는지 2~3문장으로 구체적으로 설명. 적중이면 빈 문자열.",
    "unexpectedEvents": "예측 당시 예상하지 못했던 경기 중 변수(부상, 급격한 컨디션 저하, 깜짝 선발 교체, 결정적 실책, 폭투, 끝내기 등) 1~3문장. 없으면 빈 문자열.",
    "mvpName": "최고 활약 선수명(한국어 병기)",
    "mvpTeam": "팀키",
    "mvpPerformance": "구체적 활약 내용 (예: 4타수 3안타 2타점 1홈런)",
    "mvpReason": "MVP 선정 이유 1문장",
    "worstName": "최악 활약 선수명(한국어 병기)",
    "worstTeam": "팀키",
    "worstPerformance": "구체적 부진 내용 (예: 4타수 무안타, 실책 2개, 5이닝 6실점 등)",
    "worstReason": "최악 선정 이유 1문장",
    "highlight": "경기 하이라이트 한 문장"
  }
]

매우 중요한 규칙:
1. 출력은 순수 JSON 배열 하나만. 코드블록 마커(백틱) 쓰지 말 것.
2. 모든 문자열 값은 줄바꿈 없이 한 줄로 작성.
3. 문자열 내부에 쌍따옴표(") 절대 쓰지 말 것.
4. 위에 나열된 모든 키를 빠짐없이 포함할 것. 정보가 없으면 빈 문자열 ""을 넣을 것.`;

      const raw = await callClaude(prompt);
      const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      console.log('[npb-analyze] review cleaned length:', cleaned.length);
      console.log('[npb-analyze] review cleaned (last 300):', cleaned.slice(-300));
      const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
      console.log('[npb-analyze] review jsonMatch found:', !!jsonMatch);
      if (jsonMatch) {
        try {
          const reviews = JSON.parse(jsonMatch[0]);
          result = { reviews };
          const targetMmdd = actualResults?.[0]?.mmdd;
          await store.setJSON('review-analysis', { mmdd: targetMmdd, reviews, savedAt: new Date().toISOString() });
        } catch(e) {
          console.error('[npb-analyze] review JSON.parse failed, attempting fix:', e.message);
          try {
            const fixed = tryFixJson(jsonMatch[0]);
            const reviews = JSON.parse(fixed);
            result = { reviews };
            const targetMmdd = actualResults?.[0]?.mmdd;
            await store.setJSON('review-analysis', { mmdd: targetMmdd, reviews, savedAt: new Date().toISOString() });
          } catch(e2) {
            const posMatch = e.message.match(/position (\d+)/);
            if (posMatch) {
              const pos = parseInt(posMatch[1]);
              console.error('[npb-analyze] review context around error:', JSON.stringify(jsonMatch[0].slice(Math.max(0,pos-50), pos+50)));
            }
            result = { raw: cleaned, error: 'parse_failed', parseError: e.message };
          }
        }
      } else {
        result = { raw: cleaned, error: 'no_json' };
      }
    }

    return ok(result);
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
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
    body: JSON.stringify(data),
  };
}
