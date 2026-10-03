/*
 * 离线合并引擎
 * ----------
 * 把 潜次(dive)、标记(mark)、导入批次(batch) 接成离线合并：
 * - 每条改动是一条操作(op)，携带 设备号 deviceId、基准版本 baseVersion(版本向量)、操作号 opId；
 * - 同一操作号重传只认首次结果（opIndex 幂等去重）；
 * - 撤掉(删除)留下墓碑，迟到的编辑不能让已撤掉的标记重新出现；
 * - 两边改过同一字段：两份现场值都保留并挂起，人工选择后生成解决操作向外同步；
 * - 导入按批次逐条落盘，崩溃后重启自动从断点续导未完成批次；
 * - 旧数据(localStorage: zfl30Marks)首次启动自动升级为操作并补录来源。
 *
 * 浏览器：window.SyncStore；Node：module.exports（供测试）。
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  if (root) root.SyncStore = mod.SyncStore;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const MAIN_KEY = "zfl30.sync.v1";       // 合并引擎主状态
  const LEGACY_KEY = "zfl30Marks";        // 旧版整包数据
  const PAYLOAD_PREFIX = "zfl30.payload."; // 导入中批次的留底（崩溃续导用）
  const FORMAT = "zfl30-batch/1";

  // ---------- 工具 ----------
  function uuid(prefix) {
    const s = (typeof crypto !== "undefined" && crypto.randomUUID)
      ? crypto.randomUUID()
      : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    return prefix + "_" + s;
  }
  const now = () => new Date().toISOString();
  const clone = o => JSON.parse(JSON.stringify(o));
  // 版本向量 vv 是否覆盖某个写入坐标（即：写操作的人是否已见过那次写入）
  const covers = (vv, coord) => (vv[coord.deviceId] || 0) >= coord.seq;
  function mergeVV(vv, coord) { if ((vv[coord.deviceId] || 0) < coord.seq) vv[coord.deviceId] = coord.seq; }
  // FNV-1a 校验和，用于批次完整性校验
  function checksum(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return ("0000000" + h.toString(16)).slice(-8);
  }
  const cmpOps = (a, b) => a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : a.seq - b.seq;

  class SyncStore {
    constructor(storage, opts = {}) {
      this.storage = storage;
      this.opts = opts;
      this.migrated = false;
      const raw = storage.getItem(MAIN_KEY);
      this.state = raw ? JSON.parse(raw) : {
        version: 1,
        device: { deviceId: uuid("dev"), name: "本机-" + Math.random().toString(36).slice(2, 6), seq: 0 },
        entities: {},   // id -> 实体（含逐字段来源、版本向量、墓碑、冲突）
        oplog: [],      // 已消费的全部操作（导出/转发用）
        opIndex: {},    // opId -> 首次处理结果（幂等）
        seenSeq: {},    // deviceId -> 已连续应用到的 seq（缺号检测）
        inbox: [],      // 因缺号暂存的操作
        batches: {},    // batchId -> 导入批次记录
        peers: {},      // deviceId -> 设备名（从批次里学到）
      };
      this.migrateLegacy();   // 旧数据升级：补录来源
      this.recoverBatches();  // 崩溃恢复：续导未完成批次
      this.seedIfEmpty();
      this.persist();
    }

    persist() { this.storage.setItem(MAIN_KEY, JSON.stringify(this.state)); }

    // ---------- 本地改动（统一走操作管线） ----------
    localOp(kind, entityId, type, fields) {
      const e = this.state.entities[entityId];
      if (e && e.tombstone) throw new Error("已撤掉，不能再编辑");
      const dev = this.state.device;
      const op = {
        opId: uuid("op"),
        deviceId: dev.deviceId,          // 设备号
        seq: ++dev.seq,                  // 本设备连续序号
        baseVersion: e ? clone(e.vv) : {}, // 基准版本：改动时所见的实体版本向量
        kind, entityId, type,
        fields: fields || null,
        at: now(),
      };
      const result = this.applyOp(op);
      this.drainInbox();
      this.persist();
      return { op, result };
    }

    upsertMark(id, fields) { return this.upsert("mark", id, fields); }
    upsertDive(id, fields) { return this.upsert("dive", id, fields); }
    upsert(kind, id, fields) {
      if (id) {
        const e = this.state.entities[id];
        if (!e) throw new Error("记录不存在");
        if (e.tombstone) throw new Error("已撤掉，不能再编辑");
        const changed = {};
        for (const [k, v] of Object.entries(fields)) {
          const cur = e.fields[k] ? e.fields[k].value : undefined;
          if (cur !== v) changed[k] = v;   // 只把真正改了的字段写进操作
        }
        if (!Object.keys(changed).length) return null;
        return this.localOp(kind, id, "upsert", changed);
      }
      return this.localOp(kind, uuid("ent"), "upsert", fields);
    }

    deleteEntity(id) {
      const e = this.state.entities[id];
      if (!e || e.tombstone) return null;
      return this.localOp(e.kind, id, "delete");
    }

    // 处理挂起冲突：choice = "local" 保留本地 / "remote" 采用对方
    resolveConflict(entityId, conflictId, choice) {
      const e = this.state.entities[entityId];
      if (!e) return null;
      const c = e.conflicts.find(x => x.id === conflictId && x.status === "pending");
      if (!c) return null;
      const value = choice === "remote" ? c.remote.value : (e.fields[c.field] || {}).value;
      // 解决操作的基准版本覆盖双方写入，同步到对端可干净落账
      const { op } = this.localOp(e.kind, entityId, "upsert", { [c.field]: value });
      c.status = "resolved";
      c.choice = choice;
      c.resolvedBy = op.opId;
      c.resolvedAt = now();
      this.persist();
      return op;
    }

    // ---------- 操作落账（本地与导入共用） ----------
    applyOp(op) {
      const st = this.state;
      // 幂等：同一操作号重传，只认首次结果
      if (st.opIndex[op.opId]) return "duplicate";
      // 每个设备的操作必须按序到达，缺号则暂存等待
      const expect = (st.seenSeq[op.deviceId] || 0) + 1;
      if (op.seq < expect) {
        st.opIndex[op.opId] = { result: "error", note: "操作序号回退", at: now() };
        return "error";
      }
      if (op.seq > expect) { st.inbox.push(op); return "parked"; }

      const coord = { deviceId: op.deviceId, seq: op.seq };
      let e = st.entities[op.entityId];
      let result;
      if (e && e.tombstone) {
        result = "tombstoned"; // 已撤掉：迟到的编辑不能让它重新出现
      } else if (op.type === "delete") {
        e = e || this.ensureEntity(op); // 删除先到：也要立墓碑，挡住迟到的创建/编辑
        e.tombstone = { opId: op.opId, deviceId: op.deviceId, seq: op.seq, at: op.at };
        for (const c of e.conflicts) if (c.status === "pending") { c.status = "voided"; c.resolvedAt = now(); }
        mergeVV(e.vv, coord);
        e.updatedBy = { deviceId: op.deviceId, opId: op.opId, at: op.at };
        result = "applied";
      } else {
        e = e || this.ensureEntity(op);
        result = "applied";
        for (const [f, v] of Object.entries(op.fields || {})) {
          if (this.mergeField(e, f, v, op) === "conflict") result = "conflict";
        }
        mergeVV(e.vv, coord);
        e.updatedBy = { deviceId: op.deviceId, opId: op.opId, at: op.at };
      }
      st.seenSeq[op.deviceId] = op.seq;
      st.oplog.push(op); // 已消费操作全部入日志，导出时转发，保证传递性
      st.opIndex[op.opId] = { result, at: now() };
      return result;
    }

    // 字段级合并：基准版本覆盖当前写入 → 干净落账；否则并发 → 保留两份现场值并挂起
    mergeField(e, f, value, op) {
      const cur = e.fields[f];
      const curCoord = cur ? { deviceId: cur.deviceId, seq: cur.seq } : null;
      if (cur && cur.value === value) { // 两边改成同一个值：不算冲突
        if (covers(op.baseVersion, curCoord)) {
          e.fields[f] = { value, opId: op.opId, deviceId: op.deviceId, seq: op.seq };
        }
        this.resolveCovered(e, f, op.baseVersion);
        return "same";
      }
      if (!cur || covers(op.baseVersion, curCoord)) {
        e.fields[f] = { value, opId: op.opId, deviceId: op.deviceId, seq: op.seq };
        this.resolveCovered(e, f, op.baseVersion); // 新写入覆盖了挂起双方 → 自动了结
        return "set";
      }
      const remote = { value, opId: op.opId, deviceId: op.deviceId, seq: op.seq, at: op.at };
      const pending = e.conflicts.find(c => c.field === f && c.status === "pending");
      if (pending) {
        if (covers(op.baseVersion, { deviceId: pending.remote.deviceId, seq: pending.remote.seq })) {
          pending.remote = remote; // 对方在旧值基础上的更新，替换挂起中的对方值
        } else {
          (pending.alternates = pending.alternates || []).push(remote); // 第三方值，留底不丢
        }
      } else {
        e.conflicts.push({
          id: uuid("cfl"), field: f, status: "pending", at: now(),
          local: { value: cur.value, opId: cur.opId, deviceId: cur.deviceId, seq: cur.seq },
          remote,
        });
      }
      return "conflict";
    }

    resolveCovered(e, f, baseVersion) {
      for (const c of e.conflicts) {
        if (c.field === f && c.status === "pending" &&
            covers(baseVersion, { deviceId: c.remote.deviceId, seq: c.remote.seq })) {
          c.status = "superseded";
          c.resolvedAt = now();
        }
      }
    }

    ensureEntity(op) {
      const mine = op.deviceId === this.state.device.deviceId;
      const e = {
        id: op.entityId, kind: op.kind, vv: {}, fields: {}, tombstone: null, conflicts: [],
        origin: { source: mine ? "local" : "sync", deviceId: op.deviceId, opId: op.opId, at: op.at },
        updatedBy: { deviceId: op.deviceId, opId: op.opId, at: op.at },
      };
      this.state.entities[op.entityId] = e;
      return e;
    }

    // 缺号暂存的操作：缺口补齐后自动补放
    drainInbox() {
      let moved = true;
      while (moved) {
        moved = false;
        for (let i = 0; i < this.state.inbox.length; i++) {
          const op = this.state.inbox[i];
          if (op.seq === (this.state.seenSeq[op.deviceId] || 0) + 1) {
            this.state.inbox.splice(i, 1);
            this.applyOp(op);
            moved = true;
            break;
          }
        }
      }
    }

    // ---------- 批次导出 / 导入 ----------
    exportBatch() {
      const st = this.state;
      const ops = [...st.oplog, ...st.inbox].sort(cmpOps); // 含暂存操作，便于转发补齐
      const batch = {
        format: FORMAT,
        batchId: uuid("batch"),
        sourceDevice: st.device.deviceId,
        deviceName: st.device.name,
        createdAt: now(),
        ops,
        checksum: checksum(JSON.stringify(ops)),
      };
      this.persist();
      return batch;
    }

    importBatch(batch) {
      const st = this.state;
      if (!batch || batch.format !== FORMAT || !Array.isArray(batch.ops) || typeof batch.batchId !== "string") {
        throw new Error("批次格式不正确");
      }
      if (checksum(JSON.stringify(batch.ops)) !== batch.checksum) {
        if (batch.batchId) {
          st.batches[batch.batchId] = {
            batchId: batch.batchId, sourceDevice: batch.sourceDevice || "?",
            deviceName: batch.deviceName || "?", receivedAt: now(),
            status: "failed", total: batch.ops.length, appliedCount: 0, stats: {},
            error: "校验和不符，批次已拒收",
          };
          this.persist();
        }
        throw new Error("批次校验和不符，文件可能已损坏");
      }
      if (batch.sourceDevice && batch.deviceName) st.peers[batch.sourceDevice] = batch.deviceName;

      let rec = st.batches[batch.batchId];
      // 整包重传：只报首次结果，不重复落账
      if (rec && rec.status === "applied") return Object.assign({ batchId: rec.batchId, duplicateBatch: true }, rec.stats);
      if (rec && rec.status === "failed") { delete st.batches[batch.batchId]; rec = null; } // 失败批次允许重试
      if (!rec) {
        rec = st.batches[batch.batchId] = {
          batchId: batch.batchId, sourceDevice: batch.sourceDevice, deviceName: batch.deviceName,
          receivedAt: now(), status: "importing", total: batch.ops.length, appliedCount: 0,
          stats: { applied: 0, duplicate: 0, conflict: 0, tombstoned: 0, parked: 0, error: 0 },
        };
        this.storage.setItem(PAYLOAD_PREFIX + batch.batchId, JSON.stringify(batch)); // 留底：崩溃后续导
        this.persist();
      }
      const ops = [...batch.ops].sort(cmpOps);
      for (let i = rec.appliedCount; i < ops.length; i++) {
        const r = this.applyOp(ops[i]);
        rec.stats[r] = (rec.stats[r] || 0) + 1;
        rec.appliedCount = i + 1;
        this.persist(); // 逐条落盘：崩溃后从断点继续，已应用的操作靠幂等去重
      }
      this.drainInbox();
      rec.status = "applied";
      rec.finishedAt = now();
      this.storage.removeItem(PAYLOAD_PREFIX + batch.batchId);
      this.persist();
      return Object.assign({ batchId: rec.batchId }, rec.stats);
    }

    // 启动时恢复：上次崩溃留下 status="importing" 的批次，从断点续导
    recoverBatches() {
      for (const rec of Object.values(this.state.batches)) {
        if (rec.status !== "importing") continue;
        const raw = this.storage.getItem(PAYLOAD_PREFIX + rec.batchId);
        if (!raw) {
          rec.status = "failed";
          rec.error = "批次数据丢失，无法续导，请重新导入";
          continue;
        }
        rec.recovered = true;
        this.importBatch(JSON.parse(raw));
      }
    }

    // ---------- 旧数据升级 ----------
    migrateLegacy() {
      const raw = this.storage.getItem(LEGACY_KEY);
      if (!raw) return;
      let marks = [];
      try { marks = JSON.parse(raw) || []; } catch (e) { marks = []; }
      const batchId = "legacy-" + Date.now();
      const seqBefore = this.state.device.seq;
      const diveByCode = {};
      const ensureDive = code => {
        if (!diveByCode[code]) {
          const r = this.localOp("dive", uuid("ent"), "upsert", { code, date: "", vessel: "", note: "" });
          this.state.entities[r.op.entityId].origin = { source: "legacy", batchId, at: now() };
          diveByCode[code] = r.op.entityId;
        }
        return diveByCode[code];
      };
      for (const m of marks) {
        const diveId = ensureDive(m.dive || "未标注潜次");
        const r = this.localOp("mark", m.id || uuid("ent"), "upsert", {
          code: m.code, type: m.type, diveId, x: m.x, y: m.y,
          depth: m.depth, orientation: m.orientation, condition: m.condition, note: m.note,
        });
        this.state.entities[r.op.entityId].origin = { source: "legacy", batchId, at: now() }; // 补录来源
      }
      const total = this.state.device.seq - seqBefore;
      this.state.batches[batchId] = {
        batchId, sourceDevice: this.state.device.deviceId, deviceName: this.state.device.name,
        receivedAt: now(), status: "applied", total, appliedCount: total,
        stats: { applied: total }, finishedAt: now(),
        note: "旧数据升级：已补录来源",
      };
      this.storage.setItem(LEGACY_KEY + ".migrated", raw); // 原数据留底
      this.storage.removeItem(LEGACY_KEY);
      this.migrated = true;
    }

    seedIfEmpty() {
      if (this.opts.seed === false || this.migrated) return;
      if (Object.keys(this.state.entities).length) return;
      const d1 = this.localOp("dive", uuid("ent"), "upsert", { code: "DIVE-01", date: "", vessel: "分队船一", note: "" }).op.entityId;
      const d2 = this.localOp("dive", uuid("ent"), "upsert", { code: "DIVE-02", date: "", vessel: "分队船一", note: "" }).op.entityId;
      this.localOp("mark", uuid("ent"), "upsert", { code: "A-017", type: "ceramic", diveId: d1, x: 42, y: 46, depth: "17.8m", orientation: "东", condition: "边缘残缺", note: "靠近船肋" });
      this.localOp("mark", uuid("ent"), "upsert", { code: "W-003", type: "wood", diveId: d2, x: 58, y: 39, depth: "18.2m", orientation: "西北", condition: "稳定", note: "疑似横梁" });
    }

    // ---------- 查询 ----------
    statusOf(e) {
      return e.tombstone ? "deleted" : e.conflicts.some(c => c.status === "pending") ? "conflict" : "active";
    }
    snapshot(e) {
      const o = { id: e.id, kind: e.kind, status: this.statusOf(e), origin: e.origin, updatedBy: e.updatedBy };
      for (const [f, m] of Object.entries(e.fields)) o[f] = m.value;
      return o;
    }
    getEntity(id) {
      const e = this.state.entities[id];
      return e ? this.snapshot(e) : null;
    }
    listMarks() { return this.listKind("mark"); }
    listDives() { return this.listKind("dive"); }
    listKind(kind) {
      return Object.values(this.state.entities)
        .filter(e => e.kind === kind && !e.tombstone)
        .map(e => this.snapshot(e))
        .sort((a, b) => String(a.code || "").localeCompare(String(b.code || ""), "zh"));
    }
    listConflicts() {
      const out = [];
      for (const e of Object.values(this.state.entities)) {
        if (e.tombstone) continue;
        for (const c of e.conflicts) {
          if (c.status === "pending") {
            out.push({
              entityId: e.id, kind: e.kind,
              code: (e.fields.code || {}).value || e.id,
              conflict: c, liveValue: e.fields[c.field] ? e.fields[c.field].value : undefined,
            });
          }
        }
      }
      return out;
    }
    listBatches() {
      return Object.values(this.state.batches)
        .sort((a, b) => String(b.receivedAt || "").localeCompare(String(a.receivedAt || "")));
    }
    deviceInfo() {
      const st = this.state;
      return {
        deviceId: st.device.deviceId, name: st.device.name, seq: st.device.seq,
        opCount: st.oplog.length, pendingConflicts: this.listConflicts().length,
      };
    }
    peerName(id) {
      if (!id) return "未知";
      if (id === this.state.device.deviceId) return this.state.device.name + "(本机)";
      return this.state.peers[id] || id.slice(0, 12) + "…";
    }
    renameDevice(name) {
      this.state.device.name = name;
      this.persist();
    }
  }

  return { SyncStore, checksum, MAIN_KEY, LEGACY_KEY, PAYLOAD_PREFIX, FORMAT };
});
