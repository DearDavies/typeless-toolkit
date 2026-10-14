'use strict';
/**
 * 功能快捷键规范化:单键 / 双键,拒绝三键与非法键名;
 * 支持只设置部分功能,以及显式解绑(空绑定)。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 隔离运行时数据:把 app-settings.json 指向临时目录,避免读写真机 Typeless 配置
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'typeless-shortcuts-'));
process.env.TYPELESS_DATA_DIR = dataRoot;
process.env.TYPELESS_EXE = path.join(dataRoot, 'missing-app');
fs.writeFileSync(path.join(dataRoot, 'config.local.json'), JSON.stringify({
  userdata_dir: path.join(dataRoot, 'userdata'),
}), 'utf8');

const C = require('../lib/common');

describe('feature shortcuts', () => {
  it('exports helpers and feature defs', () => {
    assert.equal(typeof C.normalizeShortcutBinding, 'function');
    assert.equal(typeof C.parseShortcutBinding, 'function');
    assert.equal(typeof C.getFeatureShortcuts, 'function');
    assert.equal(typeof C.setFeatureShortcuts, 'function');
    assert.ok(Array.isArray(C.FEATURE_SHORTCUT_DEFS));
    assert.equal(C.FEATURE_SHORTCUT_DEFS.length, 4);
    assert.equal(C.SHORTCUT_MAX_PARTS, 2);
  });

  it('normalizes single and dual key bindings', () => {
    assert.equal(C.normalizeShortcutBinding('RightCtrl'), 'RightCtrl');
    assert.equal(C.normalizeShortcutBinding(['RightCtrl', 'RightShift']), 'RightCtrl+RightShift');
    assert.equal(C.normalizeShortcutBinding('LeftCtrl+Space'), 'LeftCtrl+Space');
    assert.equal(C.normalizeShortcutBinding('  Insert  '), 'Insert');
  });

  it('rejects empty, oversized, or invalid names', () => {
    assert.throws(() => C.normalizeShortcutBinding(''), /不能为空/);
    assert.throws(() => C.normalizeShortcutBinding('A+B+C'), /最多 2/);
    assert.throws(() => C.normalizeShortcutBinding('Right Ctrl'), /无法识别/);
    assert.throws(() => C.normalizeShortcutBinding('Ctrl+@'), /无法识别/);
  });

  it('parses plus-joined bindings', () => {
    assert.deepEqual(C.parseShortcutBinding('RightCtrl+RightShift'), ['RightCtrl', 'RightShift']);
    assert.deepEqual(C.parseShortcutBinding('Insert'), ['Insert']);
  });

  it('reads current feature shortcuts without throwing', () => {
    const data = C.getFeatureShortcuts();
    assert.equal(typeof data.bindings, 'object');
    assert.ok(data.path.includes('app-settings.json'));
    for (const def of C.FEATURE_SHORTCUT_DEFS) {
      assert.ok(Array.isArray(data.bindings[def.id]));
    }
  });

  it('allows setting only some features', async () => {
    // 只给一个功能设键:未下发的功能保持不变,不再要求四个全填
    const single = await C.setFeatureShortcuts({ dictationMode: 'RightCtrl' }, { restart: false });
    assert.deepEqual(single.changed.dictationMode, ['RightCtrl']);
    assert.ok(!('askAnythingMode' in single.changed));
  });

  it('unbinds a feature when given an empty binding', async () => {
    // 空字符串与空数组都表示解绑,该功能保存后不再占用快捷键
    const byString = await C.setFeatureShortcuts({ askAnythingMode: '' }, { restart: false });
    assert.deepEqual(byString.changed.askAnythingMode, []);
    const byArray = await C.setFeatureShortcuts({ translationMode: [] }, { restart: false });
    assert.deepEqual(byArray.changed.translationMode, []);
    // 解绑后写盘结果里该功能为空
    assert.deepEqual(C.getFeatureShortcuts().bindings.translationMode, []);
  });
});
