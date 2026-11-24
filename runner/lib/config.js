'use strict';
const fs = require('fs');
const path = require('path');
// 선택자 설정 파일 읽기. SELECTORS_FILE 환경변수가 있으면 그 파일을 사용합니다. (시험용)
function loadConfig() {
  const file = process.env.SELECTORS_FILE ? path.resolve(process.env.SELECTORS_FILE) : path.join(__dirname, '..', 'selectors.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.login = cfg.login || {};
  cfg.search = cfg.search || {};
  cfg.cart = cfg.cart || {};
  cfg.afterAdd = cfg.afterAdd || {};
  return cfg;
}
module.exports = { loadConfig };
