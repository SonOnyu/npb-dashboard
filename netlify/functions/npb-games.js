// Blobs에서 캐시된 데이터를 읽기만 함 (NPB 직접 호출 없음)
const { getStore } = require('@netlify/blobs');

function ok(data) {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(data),
  };
}

exports.handler = async (event) => {
  const p = event.queryStringParameters || {};
  const action = p.action || 'today';

  try {
    const store = getStore('npb-data');
    const cached = await store.get('games', { type: 'json' });

    if (!cached) {
      return ok({ error: 'no_cache', message: '데이터가 아직 수집되지 않았습니다. 잠시 후 다시 시도해주세요.' });
    }

    if (action === 'today') {
      return ok({
        mmdd: cached.mmdd,
        tmrMmdd: cached.tmrMmdd,
        todayGames: cached.todayGames,
        tomorrowGames: cached.tomorrowGames,
        starters: cached.starters,
        updatedAt: cached.updatedAt,
      });

    } else if (action === 'day') {
      const target = p.mmdd || cached.mmdd;
      const games = (cached.allGames || []).filter(g => g.mmdd === target);
      return ok({ mmdd: target, games, updatedAt: cached.updatedAt });

    } else if (action === 'schedule') {
      const mo = p.mm;
      const byDate = {};
      for (const g of (cached.allGames || [])) {
        if (mo && g.mmdd.slice(0,2) !== mo) continue;
        if (!byDate[g.mmdd]) byDate[g.mmdd] = [];
        byDate[g.mmdd].push(g);
      }
      return ok({ mm: mo, byDate, updatedAt: cached.updatedAt });
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action' }) };

  } catch(err) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
