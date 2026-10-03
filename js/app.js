/* global SyncStore */
"use strict";

const store = new SyncStore(localStorage);
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const map = $("#map");
const form = $("#form");
const diveForm = $("#diveForm");
const typeNames = { ceramic: "陶片", wood: "木构件", metal: "金属件", unknown: "未知物" };
const fieldNames = {
  code: "编号", type: "类型", diveId: "潜次", depth: "深度", orientation: "朝向",
  condition: "保存状态", note: "备注", x: "横坐标", y: "纵坐标", date: "日期", vessel: "船/站点",
};

let pending = null; // 地图上待保存的坐标

// ---------- 通用 ----------
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), 3600);
}
function prov(e) { // 来源行：设备 / 操作号，旧数据升级也有来源
  const src = e.origin && e.origin.source === "legacy" ? "旧数据升级" : store.peerName(e.origin && e.origin.deviceId);
  const upd = e.updatedBy ? store.peerName(e.updatedBy.deviceId) : src;
  const op = e.updatedBy && e.updatedBy.opId ? e.updatedBy.opId.slice(0, 12) + "…" : "-";
  return `来源 ${esc(src)} · 最后修改 ${esc(upd)} · 操作 ${esc(op)}`;
}
function diveLabel(id) {
  if (!id) return "未分配潜次";
  const d = store.getEntity(id);
  if (!d) return "未知潜次";
  return d.code + (d.status === "deleted" ? "(已撤掉)" : "");
}
function fmtVal(field, v) {
  if (field === "diveId") return diveLabel(v);
  if (field === "type") return typeNames[v] || v;
  return String(v ?? "");
}

// ---------- 渲染 ----------
function filtered() {
  const f = $("#filter").value;
  const marks = store.listMarks();
  return f ? marks.filter(m => m.type === f) : marks;
}

function render() {
  const info = store.deviceInfo();
  $("#deviceLabel").textContent = `离线合并已启用 · 设备 ${info.name} · 操作 ${info.opCount} 条`;
  renderDiveOptions(form.diveId.value);
  renderMap();
  if ($("#view").value === "timeline") renderTimeline(filtered());
  else renderList(filtered());
  renderDives();
  renderSync();
}

function renderMap() {
  map.querySelectorAll(".marker").forEach(el => el.remove());
  for (const m of filtered()) {
    const el = document.createElement("button");
    el.className = "marker " + (m.type || "unknown")
      + (m.id === form.rowId.value ? " selected" : "")
      + (m.status === "conflict" ? " conflict" : "");
    el.style.left = m.x + "%";
    el.style.top = m.y + "%";
    el.textContent = (m.code || "?").slice(0, 2);
    el.title = m.code;
    el.onclick = ev => { ev.stopPropagation(); editMark(m.id); };
    map.appendChild(el);
  }
}

function renderList(data) {
  $("#listTitle").textContent = "标记列表";
  const list = $("#list");
  list.className = "list";
  list.innerHTML = data.map(m => `
    <div class="item ${m.id === form.rowId.value ? "active" : ""}" data-id="${m.id}">
      <b>${esc(m.code)}</b> <span class="pill">${typeNames[m.type] || m.type}</span>${m.status === "conflict" ? ' <span class="pill warn">挂起</span>' : ""}
      <div class="muted">${esc(diveLabel(m.diveId))} · ${esc(m.depth)} · ${esc(m.orientation || "")}</div>
      <div>${esc(m.condition || "")}</div>
      <div class="muted">${prov(m)}</div>
    </div>`).join("") || '<div class="muted">没有符合条件的标记。</div>';
}

function renderTimeline(data) {
  $("#listTitle").textContent = "潜次时间线";
  const list = $("#list");
  list.className = "timeline";
  const groups = {};
  for (const m of data) (groups[diveLabel(m.diveId)] = groups[diveLabel(m.diveId)] || []).push(m);
  list.innerHTML = Object.entries(groups).map(([dive, items]) =>
    `<div class="item"><b>${esc(dive)}</b><div class="muted">${items.length} 个标记</div>` +
    items.map(i => `<div>${esc(i.code)} · ${typeNames[i.type] || i.type}</div>`).join("") + `</div>`
  ).join("") || '<div class="muted">暂无记录。</div>';
}

function renderDiveOptions(selected) {
  const sel = form.diveId;
  const dives = store.listDives();
  let html = dives.map(d =>
    `<option value="${d.id}">${esc(d.code)}${d.vessel ? " · " + esc(d.vessel) : ""}</option>`).join("");
  if (selected && !dives.some(d => d.id === selected)) {
    html += `<option value="${selected}">（已撤掉潜次）</option>`;
  }
  sel.innerHTML = html;
  if (selected) sel.value = selected;
}

function renderDives() {
  const dives = store.listDives();
  const marks = store.listMarks();
  $("#diveList").innerHTML = dives.map(d => {
    const n = marks.filter(m => m.diveId === d.id).length;
    return `<div class="item">
      <b>${esc(d.code)}</b>${d.status === "conflict" ? ' <span class="pill warn">挂起</span>' : ""}
      <div class="muted">${esc(d.date || "未填日期")} · ${esc(d.vessel || "未填船/站点")} · ${n} 个标记</div>
      ${d.note ? `<div>${esc(d.note)}</div>` : ""}
      <div class="muted">${prov(d)}</div>
      <div class="rowops">
        <button data-act="edit" data-id="${d.id}" class="secondary">编辑</button>
        <button data-act="del" data-id="${d.id}" class="secondary">撤掉</button>
      </div>
    </div>`;
  }).join("") || '<div class="muted">还没有潜次，先在上方新建。</div>';
}

function renderSync() {
  const info = store.deviceInfo();
  $("#devId").textContent = info.deviceId;
  if (document.activeElement !== $("#devName")) $("#devName").value = info.name;
  $("#opCount").textContent = info.opCount;

  const cfls = store.listConflicts();
  $("#syncTabBtn").textContent = "同步" + (cfls.length ? `(${cfls.length})` : "");
  $("#cflHint").textContent = cfls.length ? `共 ${cfls.length} 条，处理结果随下次导出同步给对方` : "";
  $("#conflictList").innerHTML = cfls.map(c => {
    const fname = fieldNames[c.conflict.field] || c.conflict.field;
    return `<div class="cfl-card">
      <div><b>${c.kind === "dive" ? "潜次" : "标记"} ${esc(c.code)} · ${esc(fname)}</b> <span class="pill warn">挂起</span></div>
      <div class="cfl-vals">
        <div><span class="muted">本地值</span><b>${esc(fmtVal(c.conflict.field, c.liveValue))}</b></div>
        <div><span class="muted">对方值（${esc(store.peerName(c.conflict.remote.deviceId))}）</span><b>${esc(fmtVal(c.conflict.field, c.conflict.remote.value))}</b></div>
      </div>
      <div class="cfl-ops">
        <button class="secondary" data-ent="${c.entityId}" data-cfl="${c.conflict.id}" data-choice="local">保留本地</button>
        <button data-ent="${c.entityId}" data-cfl="${c.conflict.id}" data-choice="remote">采用对方</button>
      </div>
    </div>`;
  }).join("") || '<div class="muted">没有挂起的冲突。</div>';

  const stMap = { applied: "已应用", importing: "导入中", failed: "失败" };
  $("#batchList").innerHTML = store.listBatches().map(b => {
    let status = stMap[b.status] || b.status;
    if (b.status === "importing") status += ` ${b.appliedCount}/${b.total}`;
    if (b.recovered) status += " · 恢复续导";
    let extra = "";
    if (b.status === "applied") {
      const s = b.stats || {};
      extra = `应用${s.applied || 0} · 重复${s.duplicate || 0} · 冲突${s.conflict || 0} · 丢弃${s.tombstoned || 0} · 暂存${s.parked || 0}`;
    }
    if (b.error) extra = b.error;
    return `<div class="batch-item">
      <div><b>${esc(b.batchId.slice(0, 20))}…</b> <span class="pill ${b.status === "applied" ? "" : "warn"}">${esc(status)}</span></div>
      <div class="muted">来自 ${esc(b.deviceName || b.sourceDevice || "?")} · ${esc(String(b.receivedAt || "").slice(0, 19).replace("T", " "))}${b.note ? " · " + esc(b.note) : ""}</div>
      ${extra ? `<div class="muted">${esc(extra)}</div>` : ""}
    </div>`;
  }).join("") || '<div class="muted">还没有导入过批次。</div>';
}

// ---------- 标记 ----------
function editMark(id) {
  const m = store.getEntity(id);
  if (!m) return;
  form.rowId.value = m.id;
  form.code.value = m.code || "";
  form.type.value = m.type || "ceramic";
  renderDiveOptions(m.diveId);
  form.diveId.value = m.diveId || "";
  form.depth.value = m.depth || "";
  form.orientation.value = m.orientation || "";
  form.condition.value = m.condition || "";
  form.note.value = m.note || "";
  pending = { x: m.x, y: m.y };
  $("#markProv").textContent = m.origin && m.origin.source === "legacy"
    ? "来源：旧数据升级（已补录）"
    : `来源：${store.peerName(m.origin && m.origin.deviceId)} · 操作 ${String(m.updatedBy && m.updatedBy.opId || "").slice(0, 12)}…`;
  render();
}

map.addEventListener("click", event => {
  if (event.target.closest(".marker")) return;
  const rect = map.getBoundingClientRect();
  pending = {
    x: Number(((event.clientX - rect.left) / rect.width * 100).toFixed(2)),
    y: Number(((event.clientY - rect.top) / rect.height * 100).toFixed(2)),
  };
  form.reset();
  form.rowId.value = "";
  form.code.value = "M-" + String(store.listMarks().length + 1).padStart(3, "0");
  renderDiveOptions("");
  if (form.diveId.options.length) form.diveId.selectedIndex = 0;
  $("#markProv").textContent = "";
  render();
});

form.onsubmit = event => {
  event.preventDefault();
  if (!pending) pending = { x: 50, y: 50 };
  const fields = {
    code: form.code.value.trim(),
    type: form.type.value,
    diveId: form.diveId.value,
    depth: form.depth.value.trim(),
    orientation: form.orientation.value.trim(),
    condition: form.condition.value.trim(),
    note: form.note.value.trim(),
    x: pending.x,
    y: pending.y,
  };
  if (!fields.code) { alert("请填写编号"); return; }
  if (!fields.diveId) { alert("请先在「潜次」页新建潜次"); return; }
  try {
    store.upsertMark(form.rowId.value || null, fields);
  } catch (err) { alert(err.message); return; }
  form.reset();
  form.rowId.value = "";
  pending = null;
  $("#markProv").textContent = "";
  render();
};

$("#deleteBtn").onclick = () => {
  const id = form.rowId.value;
  if (!id) return;
  if (!confirm("撤掉该标记？撤掉会同步给对方，且不能因迟到的编辑重新出现。")) return;
  store.deleteEntity(id);
  form.reset();
  form.rowId.value = "";
  pending = null;
  render();
};

$("#list").onclick = e => {
  const it = e.target.closest("[data-id]");
  if (it) editMark(it.dataset.id);
};

// ---------- 潜次 ----------
diveForm.onsubmit = event => {
  event.preventDefault();
  const fields = {
    code: diveForm.code.value.trim(),
    date: diveForm.date.value.trim(),
    vessel: diveForm.vessel.value.trim(),
    note: diveForm.note.value.trim(),
  };
  if (!fields.code) return;
  try {
    store.upsertDive(diveForm.rowId.value || null, fields);
  } catch (err) { alert(err.message); return; }
  diveForm.reset();
  diveForm.rowId.value = "";
  render();
};

$("#diveResetBtn").onclick = () => { diveForm.reset(); diveForm.rowId.value = ""; };

$("#diveList").onclick = e => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = btn.dataset.id;
  if (btn.dataset.act === "edit") {
    const d = store.getEntity(id);
    if (!d) return;
    diveForm.rowId.value = d.id;
    diveForm.code.value = d.code || "";
    diveForm.date.value = d.date || "";
    diveForm.vessel.value = d.vessel || "";
    diveForm.note.value = d.note || "";
  } else if (confirm("撤掉该潜次？其下标记保留，但潜次显示为已撤掉。")) {
    store.deleteEntity(id);
  }
  render();
};

// ---------- 同步：导出 / 导入 / 冲突 ----------
$("#exportBtn").onclick = () => {
  const batch = store.exportBatch();
  const blob = new Blob([JSON.stringify(batch, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `批次-${store.deviceInfo().name}-${batch.createdAt.slice(0, 10)}-${batch.batchId.slice(-4)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`批次已导出：${batch.ops.length} 条操作，拷到对方设备后用「导入批次」合并`);
};

$("#importBtn").onclick = () => $("#importFile").click();
$("#importFile").onchange = async e => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const batch = JSON.parse(await file.text());
    const r = store.importBatch(batch);
    if (r.duplicateBatch) {
      toast("该批次已导入过，按首次结果为准，未重复落账");
    } else {
      toast(`导入完成：应用${r.applied || 0} · 重复${r.duplicate || 0} · 冲突${r.conflict || 0} · 丢弃${r.tombstoned || 0} · 暂存${r.parked || 0}`);
    }
  } catch (err) {
    alert("导入失败：" + err.message);
  }
  render();
};

$("#conflictList").onclick = e => {
  const btn = e.target.closest("button[data-cfl]");
  if (!btn) return;
  store.resolveConflict(btn.dataset.ent, btn.dataset.cfl, btn.dataset.choice);
  toast("冲突已处理，结果随下次导出同步给对方");
  render();
};

$("#saveDevName").onclick = () => {
  const name = $("#devName").value.trim();
  if (name) store.renameDevice(name);
  render();
  toast("设备名已保存");
};

// ---------- 页签 ----------
$$(".tab-btn").forEach(b => b.onclick = () => {
  $$(".tab-btn").forEach(x => x.classList.toggle("active", x === b));
  $$(".tab-page").forEach(p => p.classList.toggle("active", p.id === "tab-" + b.dataset.tab));
});

$("#filter").onchange = render;
$("#view").onchange = render;

// ---------- 初始化 ----------
for (let i = 0; i < 7; i++) {
  const rib = document.createElement("div");
  rib.className = "rib";
  rib.style.left = 28 + i * 7 + "%";
  map.appendChild(rib);
}
render();
