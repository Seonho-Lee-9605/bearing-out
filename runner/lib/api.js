'use strict';
// 구글 Apps Script 웹앱 호출. PIN이 아니라 전용 토큰(AUTO_TOKEN)만 사용합니다.
function makeApi(url, token) {
  if (!url || !/^https?:\/\//.test(url)) throw new Error('API_URL 비밀 값이 비어 있거나 주소 형식이 아닙니다.');
  if (!token) throw new Error('AUTO_TOKEN 비밀 값이 비어 있습니다.');
  return async function api(action, extra) {
    let lastErr;
    for (let i = 0; i < 2; i++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(Object.assign({ action, token }, extra || {})),
          redirect: 'follow',
          signal: AbortSignal.timeout(60000)
        });
        const text = await res.text();
        let j;
        try { j = JSON.parse(text); } catch (e) { throw new Error('시트 서버가 JSON이 아닌 응답을 보냈습니다 (HTTP ' + res.status + '). 배포 설정(액세스: 모든 사용자)과 API_URL을 확인하세요.'); }
        if (!j.ok) throw new Error('시트 서버 오류: ' + (j.error || '알 수 없음') + (j.error === 'TOKEN' ? ' (AUTO_TOKEN 비밀 값이 스크립트 속성과 다릅니다)' : ''));
        return j;
      } catch (e) { lastErr = e; if (/TOKEN|JSON/.test(String(e.message))) break; await new Promise(r => setTimeout(r, 1500)); }
    }
    throw lastErr;
  };
}
module.exports = { makeApi };
