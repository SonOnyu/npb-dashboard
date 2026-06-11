const https = require('https');

function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
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

exports.handler = async (event) => {
  const params = event.queryStringParameters||{};
  const mode = params.mode||'predict';

  // POST body도 허용
  let bodyData = {};
  if (event.body) {
    try { bodyData = JSON.parse(event.body); } catch(e) {}
  }

  try {
    let prompt = '';
    let result = {};

    if (mode === 'predict') {
      // 다음 경기 분석 — 예고선발 + 팀 현황 → 심층 예측
      const { games, starters, stats } = bodyData;

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
- DeNA(DB): CL 4위 .431 원정 3연패 중
- 히로시마(C): CL 5위 .389 선발 부상이탈 다수
- 닛폰햄(F): PL 4위 .532 에스콘 홈 5연승
- 롯데(M): PL 중위권 홈 강세
- 주니치(D): CL 최하위 .356 불펜 柳裕也 복귀
- 라쿠텐(E): PL 하위권 득점력 저조

각 경기마다 다음 JSON 구조로 분석하세요 (JSON 배열, 마크다운 없이 순수 JSON만):
[
  {
    "gameId": "경기 식별자 (예: F-DB)",
    "homeTeam": "홈팀 키(G/H/T/DB 등)",
    "awayTeam": "원정팀 키",
    "starter": {
      "home": "홈 예고선발 선수명(없으면 미정)",
      "away": "원정 예고선발 선수명(없으면 미정)"
    },
    "keyBatters": [
      {"name":"선수명(한국어)", "team":"팀키", "stat":"타율/OPS 등", "note":"한 줄 포인트"}
    ],
    "keyPitchers": [
      {"name":"선수명(한국어)", "team":"팀키", "role":"선발/중계/마무리", "era":"방어율", "note":"한 줄 포인트"}
    ],
    "winProb": {"home": 55, "away": 45},
    "favorTeam": "홈 또는 원정",
    "confidence": "high/medium/low",
    "핵심근거": "2~3문장 핵심 분석 (선발 방어율·타선 OPS 수치 포함)",
    "변수": "경기 흐름 바꿀 변수 1~2문장",
    "이슈": "최근 부상·이적·컨디션 이슈",
    "판정": "최종 한 줄 판정"
  }
]`;

      const raw = await callClaude(prompt);
      // JSON 파싱
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        try { result = { analyses: JSON.parse(jsonMatch[0]) }; }
        catch(e) { result = { raw, error: 'parse_failed' }; }
      } else {
        result = { raw, error: 'no_json' };
      }

    } else if (mode === 'review') {
      // 이전 경기 결과 리뷰 — 예측 vs 실제 비교
      const { predictions, actualResults, boxScores } = bodyData;

      prompt = `당신은 NPB 애널리스트입니다. 어제 경기 예측과 실제 결과를 비교 분석해주세요.

## 어제 예측
${JSON.stringify(predictions, null, 2)}

## 실제 결과
${JSON.stringify(actualResults, null, 2)}

## 박스스코어 요약
${JSON.stringify(boxScores, null, 2)}

각 경기마다 다음 JSON으로 반환 (순수 JSON 배열만):
[
  {
    "gameId": "F-DB 등",
    "homeTeam": "팀키",
    "awayTeam": "팀키",
    "predictedWinner": "예측한 우세팀",
    "actualWinner": "실제 승팀",
    "correct": true,
    "score": "3-0 형태",
    "predictionAccuracy": "적중/미적중",
    "hitReasons": ["맞은 근거 1", "맞은 근거 2"],
    "missReasons": ["틀린 이유 (미적중 시)"],
    "mvp": {
      "name": "MVP 선수명(한국어 병기)",
      "team": "팀키",
      "performance": "활약 내용 (안타수/타점/방어율 등)",
      "reason": "MVP 선정 이유"
    },
    "worst": {
      "name": "최악의 선수명(한국어 병기)",
      "team": "팀키",
      "performance": "부진 내용 (실책/0안타/홈런허용 등)",
      "reason": "최악 선정 이유"
    },
    "highlight": "경기 하이라이트 한 문장"
  }
]`;

      const raw = await callClaude(prompt);
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        try { result = { reviews: JSON.parse(jsonMatch[0]) }; }
        catch(e) { result = { raw, error: 'parse_failed' }; }
      } else {
        result = { raw, error: 'no_json' };
      }
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: JSON.stringify(result),
    };
  } catch(err) {
    return {
      statusCode: 500,
      headers: {'Access-Control-Allow-Origin':'*'},
      body: JSON.stringify({error: err.message}),
    };
  }
};
