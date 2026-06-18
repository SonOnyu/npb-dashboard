// NPB 선수 프로필 + 연도별 성적
// GET /.netlify/functions/npb-player?id=91495139
const { getStore } = require('@netlify/blobs');
const https = require('https');

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ja-JP,ja;q=0.9',
        'Referer': 'https://npb.jp/bis/players/',
      }
    }, (res) => {
      if ([301, 302].includes(res.statusCode))
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      if (res.statusCode !== 200)
        return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

function clean(s) {
  return (s||'').replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&')
    .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/[\r\n\t]+/g,' ').replace(/\s{2,}/g,' ').trim();
}

function attr(html, tag, attrName) {
  const m = html.match(new RegExp(`<${tag}[^>]+${attrName}="([^"]+)"`, 'i'));
  return m ? m[1] : '';
}

const NPB_TEAM_KO = {
  '東京ヤクルトスワローズ':'야쿠르트 스왈로즈','ヤクルト':'야쿠르트 스왈로즈',
  '広島東洋カープ':'히로시마 카프','広島':'히로시마 카프',
  '読売ジャイアンツ':'요미우리 자이언츠','巨人':'요미우리 자이언츠',
  '中日ドラゴンズ':'주니치 드래곤즈','中日':'주니치 드래곤즈',
  '横浜DeNAベイスターズ':'DeNA 베이스타즈','DeNA':'DeNA 베이스타즈','横浜':'DeNA 베이스타즈',
  '阪神タイガース':'한신 타이거즈','阪神':'한신 타이거즈',
  '福岡ソフトバンクホークス':'소프트뱅크 호크스','ソフトバンク':'소프트뱅크 호크스','Hawks':'소프트뱅크 호크스',
  '北海道日本ハムファイターズ':'닛폰햄 파이터즈','日本ハム':'닛폰햄 파이터즈',
  '東北楽天ゴールデンイーグルス':'라쿠텐 이글스','楽天':'라쿠텐 이글스',
  '千葉ロッテマリーンズ':'롯데 마린스','ロッテ':'롯데 마린스',
  'オリックス・バファローズ':'ORIX 버팔로즈','オリックス':'ORIX 버팔로즈','ORIX':'ORIX 버팔로즈',
  '埼玉西武ライオンズ':'세이부 라이온즈','西武':'세이부 라이온즈',
};
function teamKo(jp) {
  if (!jp) return jp;
  const norm = s => s.replace(/[\s\u3000]/g,'');
  const entry = Object.entries(NPB_TEAM_KO)
    .sort((a,b)=>b[0].length-a[0].length)
    .find(([k]) => norm(jp).includes(norm(k)) || norm(k).includes(norm(jp)));
  return entry ? entry[1] : jp;
}

exports.handler = async (event) => {
  const cors = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' };
  const p    = event.queryStringParameters || {};
  const playerId = p.id;
  if (!playerId || !/^\d+$/.test(playerId)) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'invalid id' }) };
  }

  try {
    const html = await fetchUrl(`https://npb.jp/bis/players/${playerId}.html`);

    // ── 이름 ──
    const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const titleText = clean(titleM?.[1] || '');
    const fullName = titleText.split(/[（|]/)[0].trim().replace(/\u3000/g,' ');

    // ── li 목록 파싱 (배번/팀/선수명/요미가나) ──
    const liMatches = [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)];
    const allLis = liMatches.map(m => clean(m[1]));
    const jerseyIdx = allLis.findIndex(l => /^\d{1,3}$/.test(l));
    const backNo  = jerseyIdx >= 0 ? allLis[jerseyIdx] : '';
    const teamRaw = jerseyIdx >= 0 ? (allLis[jerseyIdx+1]||'') : '';
    let yomi      = jerseyIdx >= 0 ? (allLis[jerseyIdx+3]||'') : '';

    // ── 선수 사진 ──
    const photoM = html.match(/src="((?:https?:)?\/\/[^"]*players_photo[^"]+)"/i)
                || html.match(/src="([^"]*p\.npb\.jp[^"]*\d{8}[^"]+)"/i);
    let photoUrl = photoM?.[1] || '';
    if (photoUrl.startsWith('//')) photoUrl = 'https:' + photoUrl;

    // ── 바이오 (body 텍스트 패턴 매칭) ──
    const bTxt = html.replace(/<[^>]+>/g,' ').replace(/\s{2,}/g,' ');
    const bioMatch = (pattern) => (bTxt.match(pattern)||[])[1]?.trim() || '';

    // dl/dt/dd 구조
    const bioMap = {};
    const dlRe = /<dl[^>]*>([\s\S]*?)<\/dl>/gi;
    let dlM;
    while ((dlM = dlRe.exec(html)) !== null) {
      const dts = [...dlM[1].matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>/gi)].map(m=>clean(m[1]));
      const dds = [...dlM[1].matchAll(/<dd[^>]*>([\s\S]*?)<\/dd>/gi)].map(m=>clean(m[1]));
      dts.forEach((dt,i)=>{ if(dds[i]) bioMap[dt]=dds[i]; });
    }
    // table th/td 구조 (바이오 테이블)
    const tblRe = /<table[\s\S]*?<\/table>/gi;
    let tM;
    while ((tM = tblRe.exec(html)) !== null) {
      if (/打率|防御率/.test(tM[0])) continue; // 성적 테이블 스킵
      const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      let trM;
      while ((trM = trRe.exec(tM[0])) !== null) {
        const cs = [...trM[1].matchAll(/<(?:th|td)[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)].map(m=>clean(m[1]));
        if (cs.length >= 2) bioMap[cs[0]] = cs[1];
      }
    }
    const getBio = (...ks) => { for (const k of ks) if (bioMap[k]) return bioMap[k]; return ''; };

    const position  = getBio('ポジション','守備位置') || bioMatch(/ポジション[\s\u3000：:]*([^\n\r\t:　]{1,20})/);
    const handInfo  = getBio('投打') || bioMatch(/投打[\s\u3000：:]*([右左両]\s*投\s*[右左]?\s*打)/);
    const hwRaw     = getBio('身長／体重','身長/体重') || bioMatch(/身長[／/]体重[\s\u3000：:]*(\d+cm[^\n\r\t　:]{0,20})/);
    const birthRaw  = getBio('生年月日') || bioMatch(/生年月日[\s\u3000：:]*(\d{4}年\d{1,2}月\d{1,2}日)/);
    const birthM2   = birthRaw.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    const birthDate = birthM2 ? `${birthM2[1]}-${birthM2[2].padStart(2,'0')}-${birthM2[3].padStart(2,'0')}` : birthRaw;
    const careerHist = getBio('経歴') || bioMatch(/経歴[\s\u3000：:]*([^\n\r\t:　]{3,40})/);
    const draftInfo  = getBio('ドラフト') || bioMatch(/ドラフト[\s\u3000：:]*(\d{4}年[^\n\r\t:　]{0,30})/);

    // ── 성적 테이블 파싱 ──
    const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map(m=>m[0]);
    let statsTable = null;
    for (const t of tables) {
      if (/年度/.test(t) && (/打率|防御率/.test(t))) { statsTable = t; break; }
    }

    let isBatter = !position.includes('投手');
    let headers = [];
    const seasonRows = [];
    let careerRow = null;

    if (statsTable) {
      // 헤더
      const thRe = /<th[^>]*>([\s\S]*?)<\/th>/gi;
      let thM;
      while ((thM = thRe.exec(statsTable)) !== null) {
        const t = clean(thM[1]);
        if (t) headers.push(t);
      }
      const hdrTxt = headers.join('');
      isBatter = hdrTxt.includes('打率') || hdrTxt.includes('安打');

      // tbody + tfoot 행
      const tbodyM  = statsTable.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
      const tfootM  = statsTable.match(/<tfoot[^>]*>([\s\S]*?)<\/tfoot>/i);
      const bodyHtml = (tbodyM?.[1]||'') + (tfootM?.[1]||'');

      const trRe2 = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      let trM;
      while ((trM = trRe2.exec(bodyHtml)) !== null) {
        const tdRe = /<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;
        const tds = [];
        let tdM;
        while ((tdM = tdRe.exec(trM[1])) !== null) {
          // table.table_inning 처리
          const inner = tdM[1];
          const innTbl = inner.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
          tds.push(innTbl ? innTbl[1].replace(/<[^>]+>/g,'').replace(/\s/g,'').trim() : clean(inner));
        }
        if (tds.length < 3) continue;
        const yr   = tds[0] || '';
        if (!yr || yr === '年度') continue;
        const isCareer = /通[\s\u3000]*算/.test(yr) || /通[\s\u3000]*算/.test(tds[1]||'');
        const row = { yr, team: teamKo(tds[1]||''), tds, isCareer };
        if (isCareer) careerRow = row;
        else seasonRows.push(row);
      }
    }

    // 통산 지표 맵
    const careerStats = {};
    if (careerRow) headers.forEach((h,i) => { careerStats[h] = careerRow.tds[i]||'-'; });

    return {
      statusCode: 200,
      headers: { ...cors, 'Cache-Control': 'public, max-age=7200' },
      body: JSON.stringify({
        playerId, fullName, backNo, teamRaw, teamKo: teamKo(teamRaw),
        yomi, position, handInfo, hwRaw, birthDate, careerHist, draftInfo,
        photoUrl, isBatter, headers, seasonRows: seasonRows.map(r=>r.tds),
        careerRow: careerRow?.tds || null, careerStats,
      }),
    };
  } catch(err) {
    return { statusCode: 200, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
