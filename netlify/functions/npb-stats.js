// Blobs에서 캐시된 리그 성적 데이터를 읽기만 함
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

exports.handler = async (event) => {
  const type = (event.queryStringParameters || {}).type || 'bat_c';

  try {
    const store = npbStore();

    if (type === 'playerIdMap') {
      const map = await store.get('playerIdMap', { type: 'json' });
      return {
        statusCode: 200,
        headers: { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'public, max-age=3600', 'Access-Control-Allow-Origin':'*' },
        body: JSON.stringify(map || {}),
      };
    }

    if (type === 'standings') {
      const cached = await store.get('standings', { type: 'json' });
      if (!cached) {
        return {
          statusCode: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
          },
          body: JSON.stringify({ type, cl:{rows:[],updatedAt:null}, pl:{rows:[],updatedAt:null}, error:'no_cache' }),
        };
      }
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({ type, ...cached }),
      };
    }

    const cached = await store.get('stats', { type: 'json' });

    // 팀별 성적 쿼리: type=team_bat_t, team_pit_l 등
    const key = type;

    if (!cached || !cached[key]) {
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({ type, headers:[], rows:[], updatedAt:null, error:'no_cache' }),
      };
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ type, ...cached[key] }),
    };
  } catch(err) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
