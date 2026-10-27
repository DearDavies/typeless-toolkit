'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { localizedContext, sourcePage } = require('./helpers/i18n');

const root = path.join(__dirname, '..');
const html = sourcePage(fs.readFileSync(path.join(root, 'manager.html'), 'utf8'));
const manager = fs.readFileSync(path.join(root, 'manager.js'), 'utf8');

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
    } else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(match.index, i + 1);
    }
  }
  assert.fail(`${name}() body is not balanced`);
}

test('批量移除走一次写入，并保留单账号删除', () => {
  assert.match(manager, /function removeManagedAccounts\(ids\)/);
  assert.match(manager, /p === '\/api\/accounts\/batch-delete'/);
  assert.match(manager, /removeManagedAccounts\(\[deleteAccountId\]\)/);
  assert.match(manager, /ids\.length > 200/);
});

test('首页可以多选，并单独清除凭据失效的账号', () => {
  assert.match(html, /id="clearBrokenBtn"/);
  assert.match(html, /id="clearSelectedBtn"/);
  assert.match(html, /function accountIsBroken\(account\)/);
  assert.match(html, /onclick="event\.stopPropagation\(\)"/);
  assert.match(html, /\/api\/accounts\/batch-delete/);
  assert.match(html, /appearance:none/);
});

test('失效只认过期和刷新失败，读取中的账号不算', () => {
  const context = vm.createContext(localizedContext({}));
  vm.runInContext(extractFunction('accountIsBroken'), context);
  assert.equal(context.accountIsBroken({ live: { credential_state: 'refresh_error' } }), true);
  assert.equal(context.accountIsBroken({ live: { credential_state: 'expired' } }), true);
  assert.equal(context.accountIsBroken({ live: { credential_state: 'ready', loading: true } }), false);
  assert.equal(context.accountIsBroken({ live: { credential_state: 'api_error', token_valid: false } }), false);
  assert.equal(context.accountIsBroken({}), false);
});
