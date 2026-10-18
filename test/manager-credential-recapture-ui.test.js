/**
 * 凭据自愈入口(issue #57)的界面契约:
 * 服务端轮换 refresh token 后,本地副本失效会让卡片标红,但切号链路不写回凭据,
 * 于是「切换成功」和「卡片失败」同时出现。这里锁定三件事:
 *   1. 卡片把「当前登录态」与「凭据可用性」分开表达,不再只给一句「失效」;
 *   2. 「登录有效期」在凭据失效时不再显示 JWT 的几百天,避免误导;
 *   3. 重新收录复用 /api/capture + /api/accounts,且抓到的账号不一致时必须拒绝。
 */
const { localizedContext, sourcePage } = require('./helpers/i18n');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = sourcePage(fs.readFileSync(path.join(__dirname, '..', 'manager.html'), 'utf8'));

// 从页面源码里取出一个完整函数体(按花括号配对,跳过字符串)
function extractFunction(name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(html);
  assert.ok(match, `${name}() must exist`);
  const start = html.indexOf('{', match.index);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = start; i < html.length; i += 1) {
    const char = html[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
    } else if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(match.index, i + 1);
    }
  }
  assert.fail(`${name}() body is not balanced`);
}

function harness({ confirmed = true, capture = { status: 'OK', data: { user_id: 'u1', token: 'a', refresh_token: 'r' } }, save = { status: 'OK' } } = {}) {
  const confirmations = [];
  const requests = [];
  const notices = [];
  const timers = [];
  const context = vm.createContext(localizedContext({
    ACCOUNTS: [{ user_id: 'u1', nickname: '甲', email: 'a@example.com', role: 'free' }],
    appConfirm(message) { confirmations.push(message); return confirmed; },
    apiTimed(route, options, timeout) {
      requests.push({ route, options, timeout });
      return capture;
    },
    api(route, options) {
      requests.push({ route, options: { ...options, body: JSON.parse(options.body) } });
      return save;
    },
    toast(message, type) { notices.push({ message, type }); },
    loadAccounts() {},
    detectCurrent() {},
    setTimeout(fn) { timers.push(fn); },
  }));
  vm.runInContext(extractFunction('recaptureCredential'), context);
  return { context, confirmations, requests, notices, timers };
}

test('卡片把当前登录态与凭据可用性分开表达', () => {
  // 凭据失效不再直接落到「失效」徽章,而是单独一条「凭据需重新收录」
  assert.match(html, /credentialBroken\s*=\s*\[['"]expired['"],\s*['"]refresh_error['"]\]\.includes/);
  assert.match(html, /使用中 · 凭据需重新收录/);
  assert.match(html, /凭据需重新收录/);
  // 徽章区改为接收拼装好的 badges,不再是写死的单个 span
  assert.match(html, /account-badges\\">\{p26\}<\/div>/);
  assert.match(html, /<\/button>`,badges\]\)/);
});

test('凭据失效时「登录有效期」改为需更新,不再显示 JWT 剩余天数', () => {
  assert.match(html, /credentialBroken\?i18nText\("ui\.d2b913994fef","需更新"\)/);
  assert.match(html, /\(credentialNeedsUpdate\|\|credentialBroken\)\?'warn'/);
});

test('凭据失效的卡片提供重新收录入口', () => {
  assert.match(html, /credentialBroken\?`<button class="btn small" onclick="event\.stopPropagation\(\);recaptureCredential\('\$\{a\.user_id\}'\)"/);
});

test('重新收录复用 capture + accounts 并写回同一账号', async () => {
  const h = harness();
  await h.context.recaptureCredential('u1');
  assert.equal(h.confirmations.length, 1);
  assert.deepEqual(h.requests.map(r => r.route), ['/api/capture', '/api/accounts']);
  assert.equal(h.requests[0].timeout, 45000, '抓取会临时重启 Typeless,超时需要放宽');
  const saved = h.requests[1].options.body;
  assert.equal(saved.user_id, 'u1');
  assert.equal(saved.token, 'a');
  assert.equal(saved.refresh_token, 'r');
  assert.equal(saved.nickname, '甲', '未提供昵称时保留原记录,避免覆盖成空');
  // 第一条是进入流程时的进度提示,最后一条才是结果
  assert.equal(h.notices.at(-1).type, 'ok');
});

test('抓到的账号与目标不一致时拒绝写入', async () => {
  const h = harness({ capture: { status: 'OK', data: { user_id: 'other', token: 'a', refresh_token: 'r' } } });
  await h.context.recaptureCredential('u1');
  assert.deepEqual(h.requests.map(r => r.route), ['/api/capture'], '账号不一致时不得写 accounts');
  assert.match(h.notices.at(-1).message, /未登录该账号/);
  assert.equal(h.notices.at(-1).type, 'err');
});

test('取消确认后不发任何请求', async () => {
  const h = harness({ confirmed: false });
  await h.context.recaptureCredential('u1');
  assert.deepEqual(h.requests, []);
  assert.deepEqual(h.notices, []);
});

test('保存失败时提示错误且不谎报成功', async () => {
  const h = harness({ save: { status: 'FAIL', msg: '账号已记录,但快照未写入' } });
  await h.context.recaptureCredential('u1');
  assert.equal(h.notices.at(-1).type, 'err');
  assert.match(h.notices.at(-1).message, /快照未写入/);
});
