// Blobs에서 캐시된 리그 성적 데이터를 읽기만 함
const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  const type = (event.queryStringParameters || {}).type || 'bat_c';

  try {
    const store = getStore('npb-data');
    const cached = await store.get('stats', { type: 'json' });

    if (!cached || !cached[type]) {
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
      body: JSON.stringify({ type, ...cached[type] }),
    };
  } catch(err) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
