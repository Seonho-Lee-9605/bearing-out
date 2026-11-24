'use strict';
/*
 * IMKmall 장바구니 자동 담기 (구글 시트 구매요청 → IMKmall 장바구니)
 *
 * 실행 방식(MODE)
 *   discover   : 로그인 전·후 화면, 검색 결과, 장바구니 화면의 구조를 저장 (선택자 설정용 진단. 장바구니는 건드리지 않음)
 *   logincheck : 로그인만 해 보고 결과를 시트에 기록
 *   dryrun     : 대기 중인 요청을 검색만 해서 무엇을 담을지 보여 줌 (장바구니·시트 상태 변경 없음)
 *   run        : 실제로 장바구니에 담고 결과(담김/미등록/확인필요)를 시트에 기록
 *
 * 안전 장치
 *  · 아이디·비밀번호는 환경변수(GitHub 비밀 저장칸)로만 받고 어디에도 출력·저장하지 않습니다.
 *  · 로그인에 실패하면 같은 시도를 되풀이하지 않도록 시트에 멈춤(hold)을 걸어 둡니다. (계정 잠김 방지)
 *  · 주문·결제 버튼은 누르지 않습니다. 장바구니에 담기까지만 합니다.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { makeApi } = require('./lib/api');
const { loadConfig } = require('./lib/config');

const MODE = (process.env.MODE || 'run').trim();
const CODE = (process.env.CODE || '').trim();
const LIMIT = 20;
const OUT = path.join(__dirname, 'out');
const nc = s => String(s == null ? '' : s).replace(/\s+/g, '').toUpperCase();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const short = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n || 120);
const won = n => Number(n).toLocaleString('ko-KR');
const log = (...a) => console.log(...a);
function parsePrice(t) { const d = String(t == null ? '' : t).replace(/[^\d]/g, ''); return d ? Number(d) : NaN; }
function ensureOut() { fs.mkdirSync(OUT, { recursive: true }); }

async function visible(page, sel) {
  if (!sel) return false;
  try { return await page.locator(sel).first().isVisible(); } catch (e) { return false; }
}
async function textOf(scope, sel) {
  if (!sel) return '';
  try { return await scope.locator(sel).first().innerText({ timeout: 2000 }); } catch (e) { return ''; }
}
async function bodyText(page) { try { return await page.locator('body').innerText({ timeout: 3000 }); } catch (e) { return ''; } }

// ------------------------------------------------------------------ 로그인
async function detectExtraAuth(page, L) {
  for (const s of L.extraAuthSelectors || []) if (s && await visible(page, s)) return s;
  const t = await bodyText(page);
  for (const w of L.extraAuthTexts || []) if (w && t.indexOf(w) >= 0) return '화면에 "' + w + '" 문구';
  return '';
}

// 반환: {ok:true} 또는 {ok:false, kind:'CRED'|'EXTRA'|'UNKNOWN'|'NET', msg}
async function login(page, cfg, state) {
  const L = cfg.login;
  const id = process.env.IMK_ID, pw = process.env.IMK_PW;
  if (!id || !pw) return { ok: false, kind: 'CRED', msg: 'IMK_ID / IMK_PW 비밀 값이 등록되어 있지 않습니다.' };
  for (const k of ['url', 'idSelector', 'pwSelector', 'submitSelector', 'loggedInSelector']) {
    if (!L[k]) return { ok: false, kind: 'CRED', msg: 'selectors.json 의 login.' + k + ' 가 비어 있습니다. (진단 결과로 채워야 합니다)' };
  }
  try {
    await page.goto(L.url, { waitUntil: 'domcontentloaded' });
    state.dialogs.length = 0;
    await page.fill(L.idSelector, id);
    await page.fill(L.pwSelector, pw);
    await page.click(L.submitSelector);
  } catch (e) {
    return { ok: false, kind: 'NET', msg: 'IMKmall 로그인 화면을 열지 못했습니다: ' + short(e.message, 80) };
  }
  const end = Date.now() + 25000;
  while (Date.now() < end) {
    if (await visible(page, L.loggedInSelector)) return { ok: true };
    if (L.failureSelector && await visible(page, L.failureSelector)) return { ok: false, kind: 'CRED', msg: '로그인 실패: 아이디·비밀번호가 맞지 않거나 계정 상태를 확인하세요.' };
    const dlg = state.dialogs.join(' ');
    if (dlg && (L.failureTexts || []).some(w => w && dlg.indexOf(w) >= 0)) return { ok: false, kind: 'CRED', msg: '로그인 실패: 사이트 안내 "' + short(dlg, 60) + '"' };
    const extra = await detectExtraAuth(page, L);
    if (extra) return { ok: false, kind: 'EXTRA', msg: '로그인 중 추가 인증이 요구되었습니다 (' + short(extra, 60) + '). 클라우드 자동 담기로는 진행할 수 없습니다.' };
    await sleep(500);
  }
  return { ok: false, kind: 'UNKNOWN', msg: '로그인 결과를 확인하지 못했습니다. (로그인 성공 표시를 찾지 못함)' };
}

// ------------------------------------------------------------------ 장바구니
async function readCart(page, cfg) {
  const C = cfg.cart;
  await page.goto(C.url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  const map = new Map();
  const rows = await page.locator(C.rowSelector).all();
  for (const r of rows) {
    const code = nc(await textOf(r, C.rowCodeSelector));
    if (!code) continue;
    let qty = NaN;
    try { qty = Number(await r.locator(C.rowQtyInputSelector).first().inputValue({ timeout: 2000 })); } catch (e) {}
    if (!map.has(code)) map.set(code, { qty });
  }
  return map;
}

async function findCartRow(page, cfg, code) {
  const C = cfg.cart;
  const rows = await page.locator(C.rowSelector).all();
  for (const r of rows) if (nc(await textOf(r, C.rowCodeSelector)) === code) return r;
  return null;
}

async function settle(page, cfg) {
  await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
  await sleep(cfg.afterAdd.waitMs || 800);
}

// 이미 담긴 상품의 수량을 요청 수량으로 맞춤
async function setCartQty(page, cfg, job) {
  const C = cfg.cart;
  await page.goto(C.url, { waitUntil: 'domcontentloaded' }); // 다른 화면에 있었을 수 있으므로 장바구니를 다시 연다
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  const row = await findCartRow(page, cfg, nc(job.imk));
  if (!row) throw new Error('장바구니 목록에서 상품을 찾지 못했습니다');
  await row.locator(C.rowQtyInputSelector).first().fill(String(job.qty));
  if (C.rowUpdateButtonSelector) await row.locator(C.rowUpdateButtonSelector).first().click();
  await settle(page, cfg);
}

// ------------------------------------------------------------------ 검색
async function searchRows(page, cfg, code) {
  const S = cfg.search;
  if (S.url) await page.goto(S.url.replace('{code}', encodeURIComponent(code)), { waitUntil: 'domcontentloaded' });
  else {
    await page.goto(S.pageUrl || cfg.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.fill(S.inputSelector, code);
    if (S.submitSelector) await page.click(S.submitSelector); else await page.press(S.inputSelector, 'Enter');
  }
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const n = await page.locator(S.resultRowSelector).count().catch(() => 0);
    if (n > 0) break;
    if (S.noResultSelector && await visible(page, S.noResultSelector)) return [];
    if (S.noResultText && (await bodyText(page)).indexOf(S.noResultText) >= 0) return [];
    await sleep(400);
  }
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  const handles = await page.locator(S.resultRowSelector).all();
  if (!handles.length) throw new Error('검색 결과 화면을 읽지 못했습니다 (시간 초과)');
  const rows = [];
  for (const h of handles) {
    rows.push({
      h,
      code: S.rowCodeSelector ? nc(await textOf(h, S.rowCodeSelector)) : null,
      name: short(await textOf(h, S.rowNameSelector), 60),
      price: S.rowPriceSelector ? parsePrice(await textOf(h, S.rowPriceSelector)) : NaN
    });
  }
  return rows;
}

// 후보 고르기: {kind:'none'|'pick'|'check', row, note}
function choose(rows, job, cfg) {
  const target = nc(job.imk);
  if (!rows.length) return { kind: 'none', note: '검색 결과 없음' };
  const hasCode = !!cfg.search.rowCodeSelector;
  const cand = hasCode ? rows.filter(r => r.code === target) : rows;
  if (!cand.length) return { kind: 'check', note: '검색 결과 ' + rows.length + '건이지만 코드가 일치하는 상품이 없음 (' + rows.slice(0, 3).map(r => r.code || '?').join(', ') + ')' };
  if (cand.length === 1) return { kind: 'pick', row: cand[0], note: '' };
  if (cand.some(r => !Number.isFinite(r.price))) return { kind: 'check', note: '같은 코드 ' + cand.length + '건의 가격을 읽지 못해 최저가를 고를 수 없음' };
  const best = cand.reduce((a, b) => (b.price < a.price ? b : a));
  return { kind: 'pick', row: best, note: '같은 코드 ' + cand.length + '건 중 최저가', multi: true };
}

async function addToCart(page, cfg, row, qty) {
  const S = cfg.search;
  if (S.rowQtyInputSelector) await row.h.locator(S.rowQtyInputSelector).first().fill(String(qty));
  await row.h.locator(S.rowCartButtonSelector).first().click();
  for (const sel of cfg.afterAdd.confirmSelectors || []) {
    await sleep(300);
    if (sel && await visible(page, sel)) await page.locator(sel).first().click().catch(() => {});
  }
  await settle(page, cfg);
}

// ------------------------------------------------------------------ 브라우저
async function launch() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'ko-KR', timezoneId: 'Asia/Seoul', viewport: { width: 1366, height: 900 } });
  context.setDefaultTimeout(20000);
  const page = await context.newPage();
  const state = { dialogs: [] };
  page.on('dialog', async d => { state.dialogs.push(d.message()); await d.accept().catch(() => {}); }); // 사이트의 alert/confirm 은 확인으로 처리하고 문구를 기록
  return { browser, context, page, state };
}

async function shot(page, name) {
  try { ensureOut(); await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true }); } catch (e) {}
}

// ------------------------------------------------------------------ 진단 (discover)
function sanitizeHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '<script>…</script>')
    .replace(/<style[\s\S]*?<\/style>/gi, '<style>…</style>')
    .replace(/(<input[^>]*type=["']?password["']?[^>]*?)\svalue=("[^"]*"|'[^']*'|[^\s>]*)/gi, '$1 value="•"')
    .slice(0, 1500000);
}
async function inventory(page) {
  const res = [];
  for (const f of page.frames()) {
    try {
      const data = await f.evaluate(() => {
        const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const attrs = e => ({ tag: e.tagName.toLowerCase(), type: e.type || '', id: e.id || '', name: e.getAttribute('name') || '', cls: String(e.className || '').slice(0, 60), ph: e.getAttribute('placeholder') || '', text: (e.innerText || e.value || '').trim().slice(0, 40), href: (e.getAttribute('href') || '').slice(0, 80), visible: vis(e) });
        return {
          inputs: [...document.querySelectorAll('input,select,textarea')].slice(0, 80).map(attrs),
          buttons: [...document.querySelectorAll('button,[role=button],input[type=button],input[type=submit]')].slice(0, 80).map(attrs),
          links: [...document.querySelectorAll('a')].filter(a => /장바구니|cart|로그아웃|logout|검색|주문|my|마이/i.test(a.innerText + a.getAttribute('href'))).slice(0, 40).map(attrs)
        };
      });
      res.push({ frame: f.url().split('?')[0], ...data });
    } catch (e) {}
  }
  return res;
}
async function dumpPage(page, name, report) {
  ensureOut();
  const frames = page.frames();
  for (let i = 0; i < frames.length; i++) {
    try { fs.writeFileSync(path.join(OUT, name + (i ? '_frame' + i : '') + '.html'), sanitizeHtml(await frames[i].content())); } catch (e) {}
  }
  await shot(page, name);
  report.pages[name] = { url: page.url().split('?')[0], title: await page.title().catch(() => ''), frames: frames.map(f => f.url().split('?')[0]), elements: await inventory(page) };
}

async function discover() {
  const cfg = loadConfig();
  const { browser, context, page, state } = await launch();
  const report = { mode: 'discover', at: new Date().toISOString(), pages: {}, requests: [], dialogs: [], notes: [] };
  const seen = new Set();
  page.on('request', r => { // 주소의 경로와 항목 이름만 기록 (값은 기록하지 않음)
    if (!['xhr', 'fetch', 'document'].includes(r.resourceType())) return;
    try { const u = new URL(r.url()); const k = r.method() + ' ' + u.origin + u.pathname + (u.search ? '?' + [...u.searchParams.keys()].join('&') : ''); if (!seen.has(k) && seen.size < 150) { seen.add(k); report.requests.push(k); } } catch (e) {}
  });
  try {
    await page.goto(cfg.login.url || cfg.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await dumpPage(page, '01_login_page', report);
    const id = process.env.IMK_ID, pw = process.env.IMK_PW, L = cfg.login;
    if (id && pw && L.idSelector && L.pwSelector && L.submitSelector) {
      await page.fill(L.idSelector, id); await page.fill(L.pwSelector, pw); await page.click(L.submitSelector);
      await sleep(4000); await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await dumpPage(page, '02_after_login', report);
      const extra = await detectExtraAuth(page, L);
      if (extra) report.notes.push('로그인 후 추가 인증으로 보이는 요소: ' + extra);
    } else {
      report.notes.push('로그인 선택자(idSelector/pwSelector/submitSelector)가 비어 있어 로그인 전 화면만 저장했습니다. 01_login_page 결과로 선택자를 채운 뒤 다시 진단하세요.');
    }
    if (CODE) {
      const S = cfg.search;
      if (S.url) await page.goto(S.url.replace('{code}', encodeURIComponent(CODE)), { waitUntil: 'domcontentloaded' });
      else if (S.inputSelector) { await page.fill(S.inputSelector, CODE); if (S.submitSelector) await page.click(S.submitSelector); else await page.press(S.inputSelector, 'Enter'); }
      else {
        const guess = page.locator('input[type=search],input[name*=search i],input[name*=keyword i],input[placeholder*=검색]').first();
        if (await guess.isVisible().catch(() => false)) { await guess.fill(CODE); await guess.press('Enter'); } else report.notes.push('검색창을 찾지 못해 검색 결과를 저장하지 못했습니다.');
      }
      await sleep(3500); await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await dumpPage(page, '03_search_result', report);
    }
    if (cfg.cart.url) { await page.goto(cfg.cart.url, { waitUntil: 'domcontentloaded' }); await sleep(2500); }
    else {
      const link = page.locator('a:has-text("장바구니"), a:has-text("Cart")').first();
      if (await link.isVisible().catch(() => false)) { await link.click().catch(() => {}); await sleep(3000); } else report.notes.push('장바구니 링크를 찾지 못했습니다.');
    }
    await dumpPage(page, '04_cart', report);
  } catch (e) { report.notes.push('진단 중 오류: ' + short(e.message, 160)); }
  report.dialogs = state.dialogs.map(d => short(d, 100));
  ensureOut(); fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  log('진단 파일을 runner/out 에 저장했습니다. (Actions 실행 화면의 imk-out 에서 내려받으세요)');
  log(report.notes.join('\n'));
  await browser.close();
}

// ------------------------------------------------------------------ 본 실행
async function reportRun(api, run, results) {
  try { await api('autoResult', { results: results || [], run }); } catch (e) { log('시트에 결과를 기록하지 못했습니다:', e.message); }
}

async function main() {
  if (MODE === 'discover') return discover();
  const cfg = loadConfig();
  const api = makeApi(process.env.API_URL, process.env.AUTO_TOKEN);
  if (!['run', 'dryrun', 'logincheck'].includes(MODE)) throw new Error('알 수 없는 MODE: ' + MODE);
  if (MODE === 'run' && cfg.verified !== true) { log('verified 가 true 가 아니어서 종료합니다. (dryrun 으로 시험한 뒤 true 로 바꿉니다)'); return; }
  for (const k of ['url', 'rowSelector', 'rowCodeSelector', 'rowQtyInputSelector']) if (MODE !== 'logincheck' && !cfg.cart[k]) throw new Error('selectors.json 의 cart.' + k + ' 가 비어 있습니다.');
  for (const k of ['resultRowSelector', 'rowCartButtonSelector']) if (MODE !== 'logincheck' && !cfg.search[k]) throw new Error('selectors.json 의 search.' + k + ' 가 비어 있습니다.');
  if (MODE !== 'logincheck' && !cfg.search.url && !(cfg.search.inputSelector)) throw new Error('selectors.json 의 search.url 또는 search.inputSelector 가 필요합니다.');

  const { browser, page, state } = await launch();
  let exitCode = 0;
  let jobs = [];
  const results = new Map();            // id → {st, note}
  try {
    // 1) 로그인 (요청을 가져오기 전에 먼저: 실패해도 요청 상태는 그대로)
    const lg = await login(page, cfg, state);
    if (!lg.ok) {
      log('로그인 실패:', lg.msg);
      await shot(page, 'login_failed');
      const hold = lg.kind !== 'NET';
      if (MODE !== 'dryrun') await reportRun(api, { ok: false, msg: lg.msg, hold }, []);
      process.exitCode = 1; return;
    }
    log('로그인 확인');
    if (MODE === 'logincheck') { await reportRun(api, { ok: true, msg: '로그인 확인 완료' }, []); return; }

    // 2) 담을 요청 받기 (dryrun 은 상태를 바꾸지 않음)
    const q = await api('autoQueue', MODE === 'dryrun' ? { limit: LIMIT, dry: true } : { limit: LIMIT });
    if (q.hold) { log('시트에서 멈춤 상태입니다. 마스터 화면에서 [다시 켜기]를 눌러야 합니다.'); return; }
    jobs = q.jobs || [];
    log('처리할 요청:', jobs.length, q.noCode ? '(IMK 코드 없음 ' + q.noCode + '건은 미등록 처리)' : '');
    if (!jobs.length) { if (MODE === 'run') await reportRun(api, { ok: true, msg: '담을 요청 없음' }, []); return; }

    const processed = [];                  // 장바구니에 담거나 수량을 바꾼 요청 (마지막에 한 번에 검증)
    let cart = await readCart(page, cfg);

    for (const job of jobs) {
      const code = nc(job.imk);
      try {
        const have = cart.get(code);
        if (have) {                        // 이미 담겨 있음 → 이번 요청 수량으로 맞춤
          if (MODE === 'dryrun') { log('[dryrun] ' + job.imk + ' 이미 장바구니에 ' + have.qty + '개 → ' + job.qty + '개로 맞춤 예정'); continue; }
          if (have.qty === job.qty) { results.set(job.id, { st: '담김', note: job.imk + ' · 이미 ' + job.qty + '개 담겨 있음' }); continue; }
          await setCartQty(page, cfg, job);
          processed.push({ job, how: '수량 ' + have.qty + '→' + job.qty + '개로 맞춤' });
          continue;
        }
        const rows = await searchRows(page, cfg, job.imk);
        const pick = choose(rows, job, cfg);
        if (pick.kind === 'none') { results.set(job.id, { st: '미등록', note: 'IMKmall에서 ' + job.imk + ' 검색 결과가 없습니다. 신규품목 요청 후 [다시 담기]' }); log(job.imk, '→ 미등록'); continue; }
        if (pick.kind === 'check') { results.set(job.id, { st: '확인필요', note: pick.note }); log(job.imk, '→ 확인필요:', pick.note); continue; }
        const priceTxt = Number.isFinite(pick.row.price) ? won(pick.row.price) + '원' : '가격 미확인';
        if (MODE === 'dryrun') { log('[dryrun] ' + job.imk + ' → ' + (pick.note || '1건') + ', ' + priceTxt + ' × ' + job.qty + '개 담을 예정'); continue; }
        await addToCart(page, cfg, pick.row, job.qty);
        processed.push({ job, how: (pick.multi ? '최저가 ' : '') + priceTxt + ' × ' + job.qty + '개' });
        await sleep(700);
      } catch (e) {
        log(job.imk, '→ 오류:', short(e.message, 100));
        results.set(job.id, { st: '확인필요', note: '처리 중 오류: ' + short(e.message, 100) });
        await shot(page, 'error_' + String(job.id).slice(0, 8));
      }
    }
    if (MODE === 'dryrun') { log('dryrun 끝. 장바구니와 시트는 바꾸지 않았습니다.'); return; }

    // 3) 검증: 장바구니를 다시 읽어 수량이 요청과 같은지 확인
    if (processed.length) {
      cart = await readCart(page, cfg);
      for (const p of processed) {
        const got = cart.get(nc(p.job.imk));
        if (got && got.qty === p.job.qty) results.set(p.job.id, { st: '담김', note: p.job.imk + ' · ' + p.how });
        else { results.set(p.job.id, { st: '확인필요', note: got ? '장바구니 수량 ' + got.qty + '개 (요청 ' + p.job.qty + '개)' : '담았지만 장바구니에서 찾지 못함' }); await shot(page, 'verify_' + String(p.job.id).slice(0, 8)); }
      }
    }
    const arr = jobs.filter(j => results.has(j.id)).map(j => Object.assign({ id: j.id }, results.get(j.id)));
    // 처리 못 한 요청(없어야 정상)은 대기로 되돌림
    jobs.filter(j => !results.has(j.id)).forEach(j => arr.push({ id: j.id, st: '복귀', note: '' }));
    const cnt = st => arr.filter(x => x.st === st).length;
    const msg = '담김 ' + cnt('담김') + ' · 미등록 ' + cnt('미등록') + ' · 확인필요 ' + cnt('확인필요');
    await reportRun(api, { ok: true, msg }, arr);
    log('결과:', msg);
  } catch (e) {
    log('실행 오류:', short(e.message, 160));
    await shot(page, 'run_error');
    if (MODE === 'run') {
      // 이미 얻은 결과는 기록하고, 처리 못 한 요청은 대기로 되돌려 다음 실행에서 다시 시도
      const arr = jobs.filter(j => results.has(j.id)).map(j => Object.assign({ id: j.id }, results.get(j.id)));
      jobs.filter(j => !results.has(j.id)).forEach(j => arr.push({ id: j.id, st: '복귀', note: '' }));
      await reportRun(api, { ok: false, msg: 'IMKmall 처리 중 오류: ' + short(e.message, 100) }, arr);
    }
    exitCode = 1;
  } finally {
    await browser.close();
    if (exitCode) process.exitCode = exitCode;
  }
}

main().catch(e => { console.error('오류:', e.message); process.exitCode = 1; });
