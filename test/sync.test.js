"use strict";
/*
 * 离线合并引擎测试：node test/sync.test.js
 * 覆盖：离线合并收敛、操作号幂等、墓碑（迟到编辑不复活）、字段冲突挂起与解决、
 *       导入崩溃续导、旧数据升级补来源、乱序批次暂存补齐。
 */
const assert = require("assert");
const { SyncStore, checksum, MAIN_KEY, LEGACY_KEY } = require("../js/sync.js");

function mem() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
    _map: m,
  };
}
const mk = storage => new SyncStore(storage || mem(), { seed: false });
const exchange = (from, to) => to.importBatch(from.exportBatch()); // 拷批次文件并导入
const bothWays = (a, b) => { exchange(a, b); exchange(b, a); };
const vals = e => { const o = {}; for (const [k, v] of Object.entries(e.fields)) o[k] = v.value; return o; };

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("✓ " + name); }
  catch (err) { console.error("✗ " + name); console.error(err); process.exit(1); }
}

// 1) 两边离线各改各的，回码头合并后收敛，互不盖掉
test("离线各自修改，合并后双方收敛", () => {
  const a = mk(), b = mk();
  const dive = a.upsertDive(null, { code: "DIVE-01", date: "", vessel: "分队船一", note: "" }).op.entityId;
  const m = a.upsertMark(null, { code: "A-001", type: "ceramic", diveId: dive, depth: "18m", x: 10, y: 10 }).op.entityId;
  exchange(a, b); // 出发前的基线一致

  b.upsertMark(m, { depth: "20.5m" });          // 船上改了深度
  a.upsertMark(m, { note: "岸基补充描述" });      // 岸基同时改了备注
  const moved = a.upsertMark(null, { code: "A-002", type: "wood", diveId: dive, depth: "19m", x: 20, y: 20 }).op.entityId;
  bothWays(a, b);

  for (const s of [a, b]) {
    const e = s.getEntity(m);
    assert.equal(e.depth, "20.5m", "深度修改不能被盖回去");
    assert.equal(e.note, "岸基补充描述", "备注修改不能被盖回去");
    assert.equal(s.getEntity(moved).code, "A-002", "新移入的标记不能丢");
    assert.equal(s.listConflicts().length, 0);
  }
  assert.deepEqual(vals(b.state.entities[m]), vals(a.state.entities[m]), "两端字段完全一致");
});

// 2) 同一操作号重传只认首次结果
test("同一操作号重传只认首次结果（幂等）", () => {
  const a = mk(), b = mk();
  a.upsertMark(null, { code: "A-001", type: "ceramic", depth: "18m", x: 1, y: 1 });
  const batch = a.exportBatch();

  const r1 = b.importBatch(batch);
  assert.equal(r1.applied, 1);
  const before = JSON.stringify(b.state.entities);

  const r2 = b.importBatch(batch); // 整个批次重传
  assert.ok(r2.duplicateBatch, "整包重传按首次结果为准");
  assert.equal(JSON.stringify(b.state.entities), before, "状态不变");

  const replay = Object.assign({}, batch, { batchId: "batch_换个批次号再传" }); // 换批次号、操作号不变
  const r3 = b.importBatch(replay);
  assert.equal(r3.applied, 0);
  assert.equal(r3.duplicate, 1, "同一操作号只认首次结果");
  assert.equal(JSON.stringify(b.state.entities), before, "状态仍不变");
});

// 3) 已撤掉的标记不能因迟到编辑重新出现
test("墓碑：撤掉后迟到的编辑/创建不能复活标记", () => {
  const a = mk(), b = mk();
  const m = a.upsertMark(null, { code: "A-001", type: "ceramic", depth: "18m", x: 1, y: 1 }).op.entityId;
  exchange(a, b);

  b.deleteEntity(m);                 // 船上撤掉
  a.upsertMark(m, { depth: "21m" }); // 岸基不知情，同时改了深度（迟到编辑）
  bothWays(a, b);

  for (const s of [a, b]) {
    assert.equal(s.getEntity(m).status, "deleted", "撤掉后不能复活");
    assert.equal(s.listMarks().length, 0);
  }

  // 传递场景：第三台设备先收到删除、后收到创建，创建也必须被墓碑挡住
  const c = mk();
  const deleteOnly = {
    format: "zfl30-batch/1", batchId: "batch_只有删除",
    sourceDevice: b.deviceInfo().deviceId, deviceName: "B", createdAt: new Date().toISOString(),
    ops: b.state.oplog.filter(o => o.deviceId === b.deviceInfo().deviceId),
  };
  deleteOnly.checksum = checksum(JSON.stringify(deleteOnly.ops));
  c.importBatch(deleteOnly);          // 删除先到：立墓碑
  exchange(a, c);                     // 创建与迟到编辑随后才到
  assert.equal(c.getEntity(m).status, "deleted", "删除先到时迟到的创建也被挡住");
  assert.equal(c.listMarks().length, 0);
});

// 4) 两边改同一字段：保留两份现场值并挂起；解决后收敛
test("同字段并发修改挂起，保留两份现场值，解决后收敛", () => {
  const a = mk(), b = mk();
  const m = a.upsertMark(null, { code: "A-001", type: "ceramic", depth: "18m", x: 1, y: 1 }).op.entityId;
  exchange(a, b);

  a.upsertMark(m, { depth: "19m" });
  b.upsertMark(m, { depth: "20m" });
  exchange(a, b); // b 收到 a 的 19m：与本地 20m 并发 → 挂起

  let cfl = b.listConflicts();
  assert.equal(cfl.length, 1, "应挂起一条冲突");
  assert.equal(cfl[0].liveValue, "20m", "本地现场值保留");
  assert.equal(cfl[0].conflict.remote.value, "19m", "对方现场值保留");
  assert.equal(b.getEntity(m).depth, "20m", "挂起期间本地值不被覆盖");

  exchange(b, a); // a 也挂起
  assert.equal(a.listConflicts().length, 1);

  b.resolveConflict(m, b.listConflicts()[0].conflict.id, "remote"); // b 采用对方值
  assert.equal(b.getEntity(m).depth, "19m");
  assert.equal(b.listConflicts().length, 0);
  exchange(b, a); // 解决结果同步回 a
  assert.equal(a.getEntity(m).depth, "19m", "解决操作干净落账");
  assert.equal(a.listConflicts().length, 0, "对端挂起被解决操作了结");

  // 两边改成同一个值：不算冲突
  a.upsertMark(m, { condition: "稳定" });
  b.upsertMark(m, { condition: "稳定" });
  bothWays(a, b);
  assert.equal(a.listConflicts().length, 0, "同值并发不挂起");
  assert.equal(b.listConflicts().length, 0);
});

// 5) 导入崩溃后能恢复未完成批次
test("导入中途崩溃，重启后从断点续导", () => {
  const a = mk();
  const dive = a.upsertDive(null, { code: "DIVE-09", date: "", vessel: "", note: "" }).op.entityId;
  for (let i = 1; i <= 5; i++) a.upsertMark(null, { code: "A-00" + i, type: "ceramic", diveId: dive, depth: "18m", x: i, y: i });
  const batch = a.exportBatch();

  const ctrl = mk(); // 对照组：一次性导入
  ctrl.importBatch(batch);

  const backing = mem();
  let writes = 0, armed = false;
  const crashy = { // 第 3 次主状态落盘时模拟断电
    getItem: k => backing.getItem(k),
    removeItem: k => backing.removeItem(k),
    setItem(k, v) {
      if (armed && k === MAIN_KEY && ++writes === 3) { armed = false; throw new Error("模拟断电"); }
      backing.setItem(k, v);
    },
  };
  const victim = mk(crashy);
  armed = true;
  assert.throws(() => victim.importBatch(batch), /模拟断电/);

  const rec = JSON.parse(backing.getItem(MAIN_KEY)).batches[batch.batchId];
  assert.equal(rec.status, "importing", "崩溃时批次处于导入中");
  assert.ok(rec.appliedCount > 0 && rec.appliedCount < batch.ops.length, "断点已记录");

  const recovered = mk(crashy); // 模拟重启：构造时自动续导
  const done = recovered.listBatches().find(x => x.batchId === batch.batchId);
  assert.equal(done.status, "applied", "未完成批次已续导完成");
  assert.ok(done.recovered, "记录了恢复续导");
  assert.equal(recovered.listMarks().length, 5);
  assert.deepEqual(recovered.listMarks(), ctrl.listMarks(), "续导结果与一次性导入一致");
});

// 6) 旧数据升级时补出来源
test("旧数据(zfl30Marks)升级：迁移为操作并补录来源", () => {
  const storage = mem();
  storage.setItem(LEGACY_KEY, JSON.stringify([
    { id: "m1", code: "A-017", type: "ceramic", dive: "DIVE-01", x: 42, y: 46, depth: "17.8m", orientation: "东", condition: "边缘残缺", note: "靠近船肋" },
    { id: "m2", code: "W-003", type: "wood", dive: "DIVE-02", x: 58, y: 39, depth: "18.2m", orientation: "西北", condition: "稳定", note: "疑似横梁" },
  ]));
  const s = mk(storage);

  assert.equal(s.listMarks().length, 2);
  assert.equal(s.listDives().length, 2, "旧数据的潜次字符串升级为潜次实体");
  const m1 = s.getEntity("m1");
  assert.equal(m1.origin.source, "legacy", "来源已补录为旧数据升级");
  assert.equal(m1.diveId, s.listDives().find(d => d.code === "DIVE-01").id, "标记挂到对应潜次");
  assert.equal(storage.getItem(LEGACY_KEY), null, "旧键已清理");
  assert.ok(storage.getItem(LEGACY_KEY + ".migrated"), "旧数据留有备份");
  const mig = s.listBatches().find(b => b.batchId.startsWith("legacy-"));
  assert.ok(mig && /旧数据升级/.test(mig.note), "迁移批次有记录");

  const t = mk(); // 迁移结果可正常参与合并
  exchange(s, t);
  assert.equal(t.listMarks().length, 2);
});

// 7) 乱序到达的批次：缺号操作暂存，补齐后自动落账
test("乱序批次：缺号暂存，前序到达后自动补放", () => {
  const a = mk();
  const dive = a.upsertDive(null, { code: "DIVE-09", date: "", vessel: "", note: "" }).op.entityId; // seq1
  const m = a.upsertMark(null, { code: "A-001", type: "ceramic", diveId: dive, depth: "18m", x: 1, y: 1 }).op.entityId; // seq2
  a.upsertMark(m, { depth: "21m" }); // seq3
  const ops = a.state.oplog;
  const mkBatch = (id, list) => ({
    format: "zfl30-batch/1", batchId: id, sourceDevice: a.deviceInfo().deviceId, deviceName: "A",
    createdAt: new Date().toISOString(), ops: list, checksum: checksum(JSON.stringify(list)),
  });

  const b = mk();
  const r1 = b.importBatch(mkBatch("batch_第二批先到", ops.slice(2))); // seq3 缺前序
  assert.equal(r1.parked, 1, "缺号操作被暂存");
  assert.equal(b.getEntity(m), null, "暂存期间不落账");

  b.importBatch(mkBatch("batch_第一批", ops.slice(0, 2))); // 前序补齐
  assert.equal(b.listMarks().length, 1);
  assert.equal(b.getEntity(m).depth, "21m", "暂存操作自动补放");
});

console.log(`\n${passed} 项测试全部通过`);
