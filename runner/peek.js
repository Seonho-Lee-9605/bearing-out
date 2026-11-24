'use strict';
// 담을 요청이 있는지만 확인합니다. (브라우저 설치 없이 몇 초 안에 끝남)
// 결과를 GITHUB_OUTPUT 의 has_work 로 알려서, 요청이 없으면 무거운 단계를 건너뜁니다.
const fs = require('fs');
const { makeApi } = require('./lib/api');
const { loadConfig } = require('./lib/config');

function out(v) {
  console.log('has_work=' + v);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'has_work=' + v + '\n');
}

(async () => {
  const mode = (process.env.MODE || 'run').trim();
  if (mode === 'discover' || mode === 'logincheck') { out('true'); return; }
  let cfg;
  try { cfg = loadConfig(); } catch (e) { console.error('selectors.json 을 읽지 못했습니다:', e.message); process.exit(1); }
  const api = makeApi(process.env.API_URL, process.env.AUTO_TOKEN);
  const r = await api('autoPeek'); // 확인 시각이 시트에 기록되어 마스터 화면에 표시됩니다
  console.log('대기 요청:', r.n, r.hold ? '(로그인 실패로 멈춤 상태)' : '');
  if (r.hold) { out('false'); return; }
  if (r.n > 0 && mode === 'run' && cfg.verified !== true) {
    console.log('selectors.json 의 verified 가 true 가 아니어서 장바구니 담기를 건너뜁니다. (dryrun 으로 시험을 마친 뒤 true 로 바꿉니다)');
    out('false'); return;
  }
  out(r.n > 0 ? 'true' : 'false');
})().catch(e => { console.error('확인 실패:', e.message); process.exit(1); });
