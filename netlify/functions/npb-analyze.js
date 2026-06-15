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

function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    console.log('[npb-analyze] API key present:', !!process.env.ANTHROPIC_API_KEY, 'length:', (process.env.ANTHROPIC_API_KEY||'').length);
    const body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
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

    // ── 캐시 확인 (predict 모드만 — 매일 한번 분석하면 충분) ──
    if (mode === 'predict') {
      const cached = await store.get('predict-analysis', { type: 'json' });
      const gamesCache = await store.get('games', { type: 'json' });

      // 캐시가 오늘 내일 경기 기준으로 유효한지 확인
      if (cached && gamesCache && cached.tmrMmdd === gamesCache.tmrMmdd) {
        return ok({ analyses: cached.analyses, cached: true });
      }
    }

    if (mode === 'review') {
      const cached = await store.get('review-analysis', { type: 'json' });
      const targetMmdd = bodyData.actualResults?.[0]?.mmdd;
      if (cached && cached.mmdd === targetMmdd) {
        return ok({ reviews: cached.reviews, cached: true });
      }
    }

    // ── 캐시 없음 → 실시간 분석 ──
    let prompt = '';
    let result = {};

    if (mode === 'predict') {
      const { games, starters } = bodyData;

      prompt = `당신은 NPB(일본프로야구) 전문 애널리스트입니다.
아래 경기 데이터를 기반으로 각 경기의 심층 분석을 JSON으로만 반환하세요.

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

각 경기마다 다음 JSON 구조로 분석하세요 (JSON 배열, 마크다운 없이 순수 JSON만):
[
  {
    "gameId": "F-DB",
    "homeTeam": "팀키",
    "awayTeam": "팀키",
    "starter": {"home":"선수명(없으면 미정)","away":"선수명(없으면 미정)"},
    "keyBatters": [{"name":"선수명(한국어)","team":"팀키","stat":"수치","note":"한줄"}],
    "keyPitchers": [{"name":"선수명(한국어)","team":"팀키","role":"선발/중계/마무리","era":"방어율","note":"한줄"}],
    "winProb": {"home": 55, "away": 45},
    "favorTeam": "홈 또는 원정",
    "confidence": "high/medium/low",
    "핵심근거": "2~3문장",
    "변수": "1~2문장",
    "이슈": "최근 이슈",
    "판정": "최종 한줄"
  }
]`;

      const raw = await callClaude(prompt);
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        try {
          const analyses = JSON.parse(jsonMatch[0]);
          result = { analyses };
          // 캐시 저장
          const gamesCache = await store.get('games', { type: 'json' });
          await store.setJSON('predict-analysis', {
            tmrMmdd: gamesCache?.tmrMmdd, analyses, savedAt: new Date().toISOString(),
          });
        } catch(e) { result = { raw, error: 'parse_failed' }; }
      } else {
        result = { raw, error: 'no_json' };
      }

    } else if (mode === 'review') {
      const { predictions, actualResults, boxScores } = bodyData;

      prompt = `당신은 NPB 애널리스트입니다. 어제 경기 예측과 실제 결과를 비교 분석해주세요.

## 어제 예측
${JSON.stringify(predictions, null, 2)}

## 실제 결과
${JSON.stringify(actualResults, null, 2)}

각 경기마다 다음 JSON으로 반환 (순수 JSON 배열만):
[
  {
    "gameId": "F-DB",
    "homeTeam": "팀키", "awayTeam": "팀키",
    "predictedWinner": "예측한 우세팀",
    "actualWinner": "실제 승팀",
    "correct": true,
    "score": "3-0",
    "predictionAccuracy": "적중/미적중",
    "hitReasons": ["근거1"],
    "missReasons": ["미스 이유"],
    "mvp": {"name":"선수명(한국어 병기)","team":"팀키","performance":"내용","reason":"이유"},
    "worst": {"name":"선수명(한국어 병기)","team":"팀키","performance":"내용","reason":"이유"},
    "highlight": "한 문장"
  }
]`;

      const raw = await callClaude(prompt);
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        try {
          const reviews = JSON.parse(jsonMatch[0]);
          result = { reviews };
          const targetMmdd = actualResults?.[0]?.mmdd;
          await store.setJSON('review-analysis', { mmdd: targetMmdd, reviews, savedAt: new Date().toISOString() });
        } catch(e) { result = { raw, error: 'parse_failed' }; }
      } else {
        result = { raw, error: 'no_json' };
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
