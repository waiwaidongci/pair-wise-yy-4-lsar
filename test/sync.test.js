// 离线合并引擎测试：在带桩浏览器环境的 vm 中运行 index.html 的脚本
const fs = require("fs");
const vm = require("vm");
const path = require("path");

function makeElement(tag) {
  const el = {
    tagName: tag, children: [], style: {}, dataset: {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    appendChild(c) { this.children.push(c); return c; },
    append(...cs) { cs.forEach(c => this.children.push(c)); },
    addEventListener(ev, fn) { this["on" + ev] = fn; },
    remove() {}, click() {}, reset() {},
    querySelectorAll() { return []; },
    querySelector() { return makeElement("div"); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; },
    files: null,
  };
  return new Proxy(el, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === "innerHTML" || k === "textContent" || k === "hidden" || k === "value" || k === "title") return t["_" + k] || "";
      if (k === "checked") return false;
      const child = makeElement("div");
      t[k] = child;
      return child;
    },
    set(t, k, v) {
      if (k === "innerHTML" || k === "textContent" || k === "hidden" || k === "value" || k === "title") { t["_" + k] = v; return true; }
      t[k] = v;
      return true;
    },
  });
}

function createEnv() {
  const storage = new Map();
  const elements = new Map();
  const ls = {
    getItem: k => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: k => storage.delete(k),
  };
  const document = {
    querySelector(sel) {
      if (!elements.has(sel)) elements.set(sel, makeElement("div"));
      return elements.get(sel);
    },
    createElement: t => makeElement(t),
    addEventListener() {},
  };
  const ctx = {
    localStorage: ls,
    document,
    crypto: { randomUUID: () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
    }) },
    FileReader: class { readAsText(f) { this.result = f.content; setTimeout(() => this.onload && this.onload(), 0); } },
    Blob: class {}, URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    prompt: () => null, alert: msg => { ctx.__alerts.push(msg); },
    setTimeout, clearTimeout, console,
  };
  ctx.__alerts = [];
  vm.createContext(ctx);
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(script, ctx);
  vm.runInContext(`globalThis.__api = {
    get device(){ return device; },
    get dives(){ return dives; }, set dives(v){ dives = v; },
    get marks(){ return marks; }, set marks(v){ marks = v; },
    get ops(){ return ops; }, set ops(v){ ops = v; },
    get batches(){ return batches; }, set batches(v){ batches = v; },
    get conflicts(){ return conflicts; }, set conflicts(v){ conflicts = v; },
    createMark, updateMark, deleteMark, createDive,
    applyRemoteOp, runBatch, normalizePackage, legacyOpsFromMarks,
    migrateIfNeeded, seedIfEmpty, checkRecovery, resolveConflict,
    saveAll, render,
  };`, ctx);
  return { ctx, api: ctx.__api, storage };
}

function freshEnv() {
  const env = createEnv();
  env.api.marks = [];
  env.api.dives = [];
  env.api.ops = [];
  env.api.conflicts = [];
  env.api.saveAll();
  return env;
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("PASS", name); }
  catch (e) { failed++; console.error("FAIL", name, "\n  " + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

// ---------- 场景 ----------
test("旧数据升级：补出设备号/版本/潜次实体", () => {
  const env = createEnv();
  env.storage.set("zfl30Marks", JSON.stringify([
    { id: "old-1", code: "A-001", type: "ceramic", dive: "DIVE-01", x: 10, y: 20, depth: "18m", orientation: "东", condition: "好", note: "" },
    { id: "old-2", code: "W-002", type: "wood", dive: "DIVE-03", x: 30, y: 40, depth: "19m", orientation: "西", condition: "一般", note: "" },
  ]));
  env.storage.set("zfl30Schema", "1");
  env.api.migrateIfNeeded();
  env.api.dives = JSON.parse(env.storage.get("zfl30Dives"));
  env.api.marks = JSON.parse(env.storage.get("zfl30Marks"));
  env.api.ops = JSON.parse(env.storage.get("zfl30Ops"));
  env.api.batches = JSON.parse(env.storage.get("zfl30Batches"));
  assert(env.api.dives.length === 2, "应补出2个潜次实体，实际 " + env.api.dives.length);
  assert(env.api.marks.length === 2, "标记应保留2条");
  const m = env.api.marks.find(x => x.id === "old-1");
  assert(m.deviceId && m.version === 1 && m.createdAt && m.updatedAt, "标记应补出来源字段");
  assert(m.diveId === env.api.dives[0].id, "应挂到潜次实体");
  assert(env.api.ops.every(o => o.opId && o.deviceId && o.baseVersion === 0), "迁移操作应带操作号/设备号/基准版本");
  assert(env.api.batches.some(b => b.type === "migration" && b.status === "done"), "应有迁移批次记录");
});

test("幂等：同一操作号重传只认首次结果", () => {
  const a = freshEnv();
  const b = freshEnv();
  a.api.createMark({ code: "A-017", type: "ceramic", dive: "DIVE-01", x: 42, y: 46, depth: "17.8m" });
  const pkg = { format: "zfl30-archive", deviceId: a.api.device.id, deviceName: "船", ops: JSON.parse(a.storage.get("zfl30Ops")) };
  const batch1 = { batchId: "b1", type: "import", sourceDevice: pkg.deviceId, sourceName: "船", fileName: "a.json", startedAt: 1, status: "applying", opsTotal: pkg.ops.length, opsApplied: 0, skipped: [], dropped: [], conflicts: [], appliedOpIds: [] };
  b.api.batches.push(batch1);
  b.api.runBatch(batch1, pkg.ops);
  assert(b.api.marks.length === 1, "首次导入应有1个标记");
  const before = b.api.marks.length;
  const batch2 = { batchId: "b2", type: "import", sourceDevice: pkg.deviceId, sourceName: "船", fileName: "a.json", startedAt: 2, status: "applying", opsTotal: pkg.ops.length, opsApplied: 0, skipped: [], dropped: [], conflicts: [], appliedOpIds: [] };
  b.api.batches.push(batch2);
  b.api.runBatch(batch2, pkg.ops);
  assert(b.api.marks.length === before, "重传不应新增标记");
  assert(batch2.skipped.length === pkg.ops.length, "重传操作应全部记为重复跳过");
});

test("撤掉优先：迟到编辑不能复活已撤标记", () => {
  const a = freshEnv();
  const b = freshEnv();
  const mark = a.api.createMark({ code: "A-017", type: "ceramic", dive: "DIVE-01", x: 42, y: 46, depth: "17.8m" });
  // B 先导入 A 的创建
  const createOps = JSON.parse(a.storage.get("zfl30Ops"));
  const b1 = { batchId: "b1", type: "import", sourceDevice: a.api.device.id, fileName: "create.json", startedAt: 1, status: "applying", opsTotal: 1, opsApplied: 0, skipped: [], dropped: [], conflicts: [], appliedOpIds: [] };
  b.api.batches.push(b1); b.api.runBatch(b1, createOps);
  assert(!b.api.marks[0].deleted, "标记初始应存在");
  // A 撤掉
  a.api.deleteMark(mark.id);
  const delOp = JSON.parse(a.storage.get("zfl30Ops")).find(o => o.op === "delete");
  // B 迟到的编辑（基于旧版本，在撤掉之后到达）
  const lateEdit = { opId: "dev-late#1", deviceId: "dev-late", baseVersion: 1, entityType: "marker", entityId: mark.id, op: "update", changes: { depth: { from: "17.8m", to: "19.0m" } }, ts: 99 };
  const b2 = { batchId: "b2", type: "import", sourceDevice: a.api.device.id, fileName: "del.json", startedAt: 2, status: "applying", opsTotal: 1, opsApplied: 0, skipped: [], dropped: [], conflicts: [], appliedOpIds: [] };
  b.api.batches.push(b2); b.api.runBatch(b2, [delOp]);
  assert(b.api.marks[0].deleted, "标记应已撤掉");
  const b3 = { batchId: "b3", type: "import", sourceDevice: "dev-late", fileName: "late.json", startedAt: 3, status: "applying", opsTotal: 1, opsApplied: 0, skipped: [], dropped: [], conflicts: [], appliedOpIds: [] };
  b.api.batches.push(b3); b.api.runBatch(b3, [lateEdit]);
  assert(b.api.marks[0].deleted, "迟到编辑不得复活已撤标记");
  assert(b.api.marks[0].depth === "17.8m", "深度不应被迟到编辑改动");
  assert(b3.skipped.some(s => s.reason === "deleted-entity-late-edit"), "应记录迟到编辑被压制");
});

test("同字段冲突：保留两份现场值并挂起，裁决后生效", () => {
  const a = freshEnv();
  const b = freshEnv();
  const mark = a.api.createMark({ code: "A-017", type: "ceramic", dive: "DIVE-01", x: 42, y: 46, depth: "17.8m" });
  const createOps = JSON.parse(a.storage.get("zfl30Ops"));
  const b1 = { batchId: "b1", type: "import", sourceDevice: a.api.device.id, fileName: "create.json", startedAt: 1, status: "applying", opsTotal: 1, opsApplied: 0, skipped: [], dropped: [], conflicts: [], appliedOpIds: [] };
  b.api.batches.push(b1); b.api.runBatch(b1, createOps);
  // 两边离线各改一次深度（都基于版本1）
  a.api.updateMark(mark.id, { code: "A-017", type: "ceramic", dive: "DIVE-01", x: 42, y: 46, depth: "17.5m", note: "" });
  b.api.updateMark(b.api.marks[0].id, { code: "A-017", type: "ceramic", dive: "DIVE-01", x: 42, y: 46, depth: "19.0m", note: "" });
  const aOps = JSON.parse(a.storage.get("zfl30Ops"));
  const aUpdate = aOps.find(o => o.op === "update");
  const b2 = { batchId: "b2", type: "import", sourceDevice: a.api.device.id, fileName: "edit.json", startedAt: 2, status: "applying", opsTotal: 1, opsApplied: 0, skipped: [], dropped: [], conflicts: [], appliedOpIds: [] };
  b.api.batches.push(b2); b.api.runBatch(b2, [aUpdate]);
  const m = b.api.marks[0];
  assert(m.depth === "19.0m", "本机现场值应保留，实际 " + m.depth);
  assert(m.hasConflict, "标记应挂起冲突");
  assert(b.api.conflicts.some(c => c.status === "pending" && c.field === "depth" && c.localValue === "19.0m" && c.remoteValue === "17.5m"), "冲突应保留两份现场值");
  // 裁决：采用对方值
  const c = b.api.conflicts.find(x => x.status === "pending");
  b.api.resolveConflict(c, "remote");
  assert(b.api.marks[0].depth === "17.5m", "裁决采用对方值后深度应为17.5m");
  assert(!b.api.marks[0].hasConflict, "挂起应解除");
});

test("不同字段并发修改：干净合并", () => {
  const a = freshEnv();
  const b = freshEnv();
  const mark = a.api.createMark({ code: "A-017", type: "ceramic", dive: "DIVE-01", x: 42, y: 46, depth: "17.8m" });
  const b1 = { batchId: "b1", type: "import", sourceDevice: a.api.device.id, fileName: "create.json", startedAt: 1, status: "applying", opsTotal: 1, opsApplied: 0, skipped: [], dropped: [], conflicts: [], appliedOpIds: [] };
  b.api.batches.push(b1); b.api.runBatch(b1, JSON.parse(a.storage.get("zfl30Ops")));
  a.api.updateMark(mark.id, { code: "A-017", type: "ceramic", dive: "DIVE-01", x: 42, y: 46, depth: "17.8m", note: "船肋附近" });
  b.api.updateMark(b.api.marks[0].id, { code: "A-017", type: "ceramic", dive: "DIVE-01", x: 42, y: 46, depth: "19.0m", note: "" });
  const aUpdate = JSON.parse(a.storage.get("zfl30Ops")).find(o => o.op === "update");
  const b2 = { batchId: "b2", type: "import", sourceDevice: a.api.device.id, fileName: "edit.json", startedAt: 2, status: "applying", opsTotal: 1, opsApplied: 0, skipped: [], dropped: [], conflicts: [], appliedOpIds: [] };
  b.api.batches.push(b2); b.api.runBatch(b2, [aUpdate]);
  const m = b.api.marks[0];
  assert(m.note === "船肋附近" && m.depth === "19.0m", "不同字段应合并双方修改");
  assert(!m.hasConflict, "不应挂起冲突");
});

test("导入崩溃恢复：未完成批次可继续且不重复应用", () => {
  const a = freshEnv();
  const b = freshEnv();
  a.api.createMark({ code: "A-001", type: "ceramic", dive: "DIVE-01", x: 1, y: 2, depth: "18m" });
  a.api.createMark({ code: "A-002", type: "metal", dive: "DIVE-02", x: 3, y: 4, depth: "19m" });
  const ops = JSON.parse(a.storage.get("zfl30Ops"));
  // 模拟崩溃：批次只应用了前2条（DIVE-01 潜次 + 其标记）
  const batch = { batchId: "crash", type: "import", sourceDevice: a.api.device.id, fileName: "big.json", startedAt: 1, status: "applying", opsTotal: ops.length, opsApplied: 2, skipped: [], dropped: [], conflicts: [], appliedOpIds: [ops[0].opId, ops[1].opId], ops };
  b.api.batches.push(batch);
  b.api.ops.push(ops[0], ops[1]);
  b.api.dives.push({ ...ops[0].payload, deviceId: ops[0].deviceId, version: 1, deleted: false });
  b.api.marks.push({ ...ops[1].payload, deviceId: ops[1].deviceId, version: 1, deleted: false });
  // 恢复
  b.api.runBatch(batch, ops);
  assert(batch.status === "done", "批次应恢复完成");
  assert(b.api.marks.length === 2, "两条标记都应存在");
  assert(b.api.ops.length === ops.length, "操作不应重复应用");
  assert(batch.skipped.some(s => s.reason === "duplicate"), "断点前已应用的操作应记为重复");
});

test("旧版裸数组导出：兼容导入并补来源", () => {
  const b = freshEnv();
  const legacy = [{ id: "L-1", code: "A-017", type: "ceramic", dive: "DIVE-01", x: 42, y: 46, depth: "17.8m" }];
  const pkg = b.api.normalizePackage(legacy);
  assert(pkg.deviceId === "legacy", "裸数组应识别为旧版导出");
  const batch = { batchId: "b", type: "import", sourceDevice: pkg.deviceId, fileName: "old.json", startedAt: 1, status: "applying", opsTotal: pkg.ops.length, opsApplied: 0, skipped: [], dropped: [], conflicts: [], appliedOpIds: [] };
  b.api.batches.push(batch); b.api.runBatch(batch, pkg.ops);
  assert(b.api.marks.length === 1 && b.api.dives.length === 1, "应导入标记并补出潜次实体");
  assert(b.api.marks[0].deviceId === "legacy", "应补出来源设备");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
