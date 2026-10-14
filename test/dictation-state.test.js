const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { dictationDbPath, readDictationState, createDictationWatcher, RECORDING_LOOKBACK_MS, STALE_RECORD_MAX_MS } =
  require('../lib/dictation-state');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (e) { /* Node 23.4 以下需要 flag */ }
const skip = sqlite ? false : 'node:sqlite 不可用';

/** 建一个只含 history_v2 的临时库,模拟 Typeless 的历史表 */
function tempDb(rows) {
  const file = path.join(os.tmpdir(), `dict_${process.pid}_${Math.random().toString(36).slice(2)}.db`);
  const db = new sqlite.DatabaseSync(file);
  db.exec('CREATE TABLE history_v2 (id TEXT PRIMARY KEY, status TEXT, created_at TEXT, updated_at TEXT, duration REAL)');
  const ins = db.prepare('INSERT INTO history_v2 (id,status,created_at,updated_at,duration) VALUES (?,?,?,?,?)');
  for (const row of rows) ins.run(row.id, row.status ?? null, row.created_at, row.updated_at ?? null, row.duration ?? null);
  db.close();
  return file;
}

const iso = ms => new Date(ms).toISOString();
/** 用假时钟建监听器:setTimer 返回 null 表示只跑一次 poll,便于精确断言 */
function watcherOn(dbPath, clock, idleMs = 5000) {
  return createDictationWatcher({ dbPath, pollMs: 1000, idleMs, now: () => clock.t,
    setTimer: () => null, clearTimer: () => {} });
}
/** start() 在已启动时不会重复轮询,手动推进需要先停再起 */
const poll = w => { w.stop(); w.start(); };

test('dictationDbPath 指向 userData 下的主库', () => {
  assert.equal(dictationDbPath('C:/data/Typeless.exe'), path.join('C:/data/Typeless.exe', 'typeless.db'));
  assert.equal(dictationDbPath(''), '');
});

test('数据库不存在或缺少 sqlite 时给出明确错误', { skip }, () => {
  const missing = readDictationState(path.join(os.tmpdir(), 'definitely-missing-typeless.db'));
  assert.equal(missing.recording, false);
  assert.equal(missing.error, 'no-db');
});

test('时间窗内的未完成记录判定为正在听写', { skip }, () => {
  const now = Date.now();
  const db = tempDb([
    // 刚刚开始、尚未 finalize
    { id: 'live', status: null, created_at: iso(now - 3000), updated_at: iso(now - 3000) },
    { id: 'done', status: 'completed', created_at: iso(now - 60000), duration: 12.5 },
  ]);
  try {
    assert.deepEqual(readDictationState(db, () => now), { recording: true, error: null });
  } finally { fs.unlinkSync(db); }
});

test('时间窗外的陈旧未完成记录不会被误判为正在听写', { skip }, () => {
  const now = Date.now();
  const db = tempDb([
    // 历史遗留:几个月前留下、始终没有 finalize 的占位行(超出 30 分钟上界)
    { id: 'stale', status: null, created_at: iso(now - STALE_RECORD_MAX_MS - 60000) },
    { id: 'older', status: null, created_at: iso(now - 86400_000 * 30) },
  ]);
  try {
    const result = readDictationState(db, () => now);
    assert.deepEqual(result, { recording: false, error: null });
    // ambiguous 是非枚举属性,deepEqual 看不见它,必须单独断言。
    // 这正是旧回归能溜过测试的原因:库里只要有任意一条历史 NULL 行,
    // ambiguous 就为真,上层永远无法判定空闲,并误报「检测到正在听写」。
    assert.equal(result.ambiguous, false, '历史残留不应让状态变成无法判定');
  } finally { fs.unlinkSync(db); }
});

test('刚过回溯窗口、仍可能在进行中的未完成记录才判为歧义', { skip }, () => {
  const now = Date.now();
  const db = tempDb([
    // 比 5 分钟窗口早一点,但仍在 30 分钟上界内:无法区分是超长录音还是废弃。
    // duration 必须为 null —— 有 duration 说明录音已结束(见下一条测试)。
    { id: 'recent-unfinished', status: null, created_at: iso(now - RECORDING_LOOKBACK_MS - 1000) },
  ]);
  try {
    const result = readDictationState(db, () => now);
    assert.equal(result.recording, false);
    assert.equal(result.ambiguous, true, '窗口边缘的未完成记录应保守判为无法判定');
  } finally { fs.unlinkSync(db); }
});

test('已写入 duration 的残留记录不再触发歧义', { skip }, () => {
  // 官方在录音结束时才写 duration。误触录音会留下 duration 很小、status 仍为 null
  // 的残留;这种行其实已经结束,若参与歧义判定会让自动切号长期失效。
  const now = Date.now();
  const db = tempDb([
    { id: 'accidental-1', status: null, created_at: iso(now - 14 * 60_000), duration: 0.376 },
    { id: 'accidental-2', status: null, created_at: iso(now - 16 * 60_000), duration: 0.168 },
  ]);
  try {
    const result = readDictationState(db, () => now);
    assert.equal(result.recording, false);
    assert.equal(result.ambiguous, false, '有 duration 的残留说明录音已结束,不该判为无法判定');
  } finally { fs.unlinkSync(db); }
});

test('超过 30 分钟的未完成记录一律视为废弃,不阻塞状态判定', { skip }, () => {
  const now = Date.now();
  const db = tempDb([
    { id: 'way-old', status: null, created_at: iso(now - STALE_RECORD_MAX_MS - 60000) },
  ]);
  try {
    const result = readDictationState(db, () => now);
    assert.equal(result.ambiguous, false, '超过上界的记录必然是废弃占位行');
    assert.equal(result.recording, false);
  } finally { fs.unlinkSync(db); }
});

test('有活跃录音 ID 时不再做歧义检查,历史残留不影响录音识别', { skip }, () => {
  const now = Date.now();
  const db = tempDb([
    { id: 'live', status: null, created_at: iso(now - 2000) },
    { id: 'ancient', status: null, created_at: iso(now - 86400_000 * 90) },
  ]);
  try {
    const result = readDictationState(db, () => now, 'live');
    assert.equal(result.recording, true);
    assert.equal(result.ambiguous, false);
  } finally { fs.unlinkSync(db); }
});

test('只有已完成记录时判定为空闲', { skip }, () => {
  const now = Date.now();
  const db = tempDb([{ id: 'a', status: 'completed', created_at: iso(now - 5000), duration: 3 }]);
  try {
    assert.deepEqual(readDictationState(db, () => now), { recording: false, error: null });
  } finally { fs.unlinkSync(db); }
});

test('从未录音时立即进入空闲窗口', { skip }, () => {
  const clock = { t: Date.now() };
  const db = tempDb([]);
  try {
    const idle = [];
    const w = watcherOn(db, clock);
    w.on('idle', () => idle.push(clock.t));
    w.start();
    assert.deepEqual(idle, [clock.t]);
  } finally { fs.unlinkSync(db); }
});

test('录音中不触发空闲,说完并静默足够久后才触发', { skip }, () => {
  const clock = { t: Date.now() };
  const db = tempDb([]);
  const { DatabaseSync } = sqlite;
  try {
    const events = [];
    const w = watcherOn(db, clock, 5000);
    w.on('recording', () => events.push('recording'));
    w.on('idle', () => events.push('idle'));
    poll(w); // 一开始没有记录 → 空闲
    assert.deepEqual(events, ['idle']);

    // 开始录音:插入占位行
    let handle = new DatabaseSync(db);
    handle.prepare('INSERT INTO history_v2 (id,status,created_at) VALUES (?,?,?)')
      .run('live', null, iso(clock.t));
    handle.close();
    clock.t += 1000;
    events.length = 0;
    poll(w);
    assert.deepEqual(events, ['recording']);

    // 说完:finalize 该行
    handle = new DatabaseSync(db);
    handle.prepare('UPDATE history_v2 SET status=?, duration=? WHERE id=?').run('completed', 3.2, 'live');
    handle.close();
    clock.t += 1000;
    events.length = 0;
    poll(w);
    assert.deepEqual(events, [], '刚说完还没到静默阈值');

    clock.t += 5000;
    poll(w);
    assert.deepEqual(events, ['idle'], '静默足够久后进入空闲窗口');
  } finally { fs.unlinkSync(db); }
});

test('读取失败时只在错误内容变化时派发一次', { skip }, () => {
  const clock = { t: Date.now() };
  const missing = path.join(os.tmpdir(), 'no-such-typeless-' + process.pid + '.db');
  const errors = [];
  const w = watcherOn(missing, clock);
  w.on('error', e => errors.push(e));
  w.start();
  w.start();
  w.start();
  assert.deepEqual(errors, ['no-db']);
});
