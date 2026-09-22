// 判定规则层：纯领域逻辑，入口/存储之外的所有业务规则都集中在这里。
// 规则要点：
//  - 方案整单校验：区间越界、方位缺失、倾角不在 0–10°、同孔同箱区间重叠、
//    同一根岩芯已有有效方案——任一不满足整单拒绝，不写任何记录。
//  - 切片必须引用有效方案与相对位置；方向反转或超出剩余长度只落“待复测”，
//    不占用核销长度。
//  - 方案更正：旧版留档（不计统计），关联切片按新位置重算，已交付立即失效。

export const SCHEMA_VERSION = 2;
export const SLICE_OK = "已核销";
export const SLICE_RETEST = "待复测";
export const SLICE_REASONS = {
  reverse: "方向反转：相对位置为负，背离取样方向",
  overflow: "超出剩余长度：区间已超过方案取样长度",
};

const EPS = 1e-6;

export class DomainError extends Error {
  constructor(status, error, details) {
    super(error);
    this.status = status;
    this.error = error;
    this.details = details;
  }
}

export function nowIso() {
  return new Date().toISOString();
}
export function genId(prefix) {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random()
    .toString(36)
    .slice(2, 7)
    .toUpperCase()}`;
}
// 长度以毫米为单位登记，统一保留三位小数，规避浮点误差。
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;
}
function str(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function emptyDb() {
  return { schemaVersion: SCHEMA_VERSION, plans: [], slices: [], deliveries: [] };
}

export function seedDb() {
  const db = emptyDb();
  const at = "2026-06-12T10:00:00.000Z";
  const plan = {
    id: "PL-SEED-01",
    version: 1,
    active: true,
    coreId: "CORE-001",
    borehole: "ZK-17",
    coreBox: "BX-09",
    topDepth: 128.4,
    bottomDepth: 128.8,
    azimuth: 142,
    dip: 6,
    sampleLength: 0.32,
    owner: "陆川",
    createdAt: at,
    updatedAt: at,
    history: [],
  };
  const slice = {
    id: "SL-001-A",
    planId: plan.id,
    planVersion: 1,
    offset: 0,
    length: 0.12,
    status: SLICE_OK,
    reason: "",
    createdAt: at,
    evaluatedAt: at,
  };
  db.plans.push(plan);
  db.slices.push(slice);
  db.deliveries.push({
    id: "DLV-SEED-01",
    sliceId: slice.id,
    planId: plan.id,
    planVersion: 1,
    valid: true,
    at: "2026-06-13T11:20:00.000Z",
  });
  return db;
}

export function activePlans(db) {
  return db.plans.filter(p => p.active);
}
export function planById(db, planId) {
  return db.plans.find(p => p.id === planId) || null;
}
export function slicesOf(db, planId) {
  return db.slices.filter(s => s.planId === planId);
}

function readFields(input) {
  const fields = {
    coreId: str(input.coreId),
    borehole: str(input.borehole),
    coreBox: str(input.coreBox),
    topDepth: num(input.topDepth),
    bottomDepth: num(input.bottomDepth),
    azimuth: input.azimuth === "" || input.azimuth == null ? null : num(input.azimuth),
    dip: input.dip === "" || input.dip == null ? null : num(input.dip),
    sampleLength: num(input.sampleLength),
    owner: str(input.owner),
  };
  return fields;
}

// 整单校验：收集全部违例后一次性拒绝；校验期间不修改 db。
function validatePlan(db, f, selfCoreId = null) {
  const problems = [];
  if (!f.coreId) problems.push({ code: "core_missing", message: "岩芯编号缺失" });
  if (!f.borehole) problems.push({ code: "borehole_missing", message: "钻孔编号缺失" });
  if (!f.coreBox) problems.push({ code: "box_missing", message: "岩芯箱号缺失" });

  if (f.topDepth === null || f.bottomDepth === null || f.sampleLength === null) {
    problems.push({ code: "number_invalid", message: "顶深、底深、取样长度必须为数值" });
  } else {
    if (f.topDepth < 0) problems.push({ code: "interval_out_of_bounds", message: `顶深越界：${f.topDepth} 小于 0` });
    if (f.bottomDepth <= f.topDepth)
      problems.push({ code: "interval_out_of_bounds", message: `区间越界：底深 ${f.bottomDepth} 不大于顶深 ${f.topDepth}` });
    const span = Math.round((f.bottomDepth - f.topDepth) * 1000) / 1000;
    if (f.sampleLength <= 0)
      problems.push({ code: "interval_out_of_bounds", message: "取样长度必须大于 0" });
    else if (f.sampleLength > span + EPS)
      problems.push({
        code: "interval_out_of_bounds",
        message: `取样长度 ${f.sampleLength}m 超出区间长度 ${span}m`,
      });
  }

  if (f.azimuth === null) problems.push({ code: "azimuth_missing", message: "方位角缺失" });
  else if (f.azimuth < 0 || f.azimuth >= 360)
    problems.push({ code: "azimuth_missing", message: `方位角 ${f.azimuth} 不在 0–360 度范围内` });

  if (f.dip === null) problems.push({ code: "dip_invalid", message: "倾角缺失" });
  else if (f.dip < 0 - EPS || f.dip > 10 + EPS)
    problems.push({ code: "dip_invalid", message: `倾角 ${f.dip} 不在 0–10 度范围内` });

  // 一根岩芯同时仅一份有效方案
  if (f.coreId) {
    const dup = activePlans(db).find(p => p.coreId === f.coreId && p.coreId !== selfCoreId);
    if (dup)
      problems.push({
        code: "core_plan_exists",
        message: `岩芯 ${f.coreId} 已存在有效方案 ${dup.id}（v${dup.version}）`,
      });
  }

  // 同孔同箱区间重叠（端点相接不算重叠）
  if (f.topDepth !== null && f.bottomDepth !== null && f.borehole && f.coreBox) {
    for (const p of activePlans(db)) {
      if (p.coreId === selfCoreId) continue;
      if (p.borehole !== f.borehole || p.coreBox !== f.coreBox) continue;
      if (f.topDepth < p.bottomDepth - EPS && f.bottomDepth > p.topDepth + EPS) {
        problems.push({
          code: "interval_overlap",
          message: `与同孔同箱方案 ${p.id}（${p.topDepth}–${p.bottomDepth}m）区间重叠`,
        });
      }
    }
  }

  if (problems.length) throw new DomainError(422, "plan_rejected", problems);
}

export function createPlan(db, input) {
  const f = readFields(input);
  validatePlan(db, f);
  const at = nowIso();
  const plan = {
    id: genId("PL"),
    version: 1,
    active: true,
    coreId: f.coreId,
    borehole: f.borehole,
    coreBox: f.coreBox,
    topDepth: f.topDepth,
    bottomDepth: f.bottomDepth,
    azimuth: f.azimuth,
    dip: f.dip,
    sampleLength: f.sampleLength,
    owner: f.owner,
    createdAt: at,
    updatedAt: at,
    history: [],
  };
  db.plans.push(plan);
  return plan;
}

// 方案更正：整单校验通过后旧版留档；关联切片全部按新位置重算，
// 旧有效交付一律失效（记录保留）。
export function correctPlan(db, planId, input) {
  const plan = planById(db, planId);
  if (!plan) throw new DomainError(404, "plan_not_found");
  if (!plan.active) throw new DomainError(409, "plan_not_active");
  const f = readFields(input);
  validatePlan(db, f, plan.coreId);

  const snapshot = Object.fromEntries(
    ["coreId", "borehole", "coreBox", "topDepth", "bottomDepth", "azimuth", "dip", "sampleLength", "owner"]
      .map(k => [k, plan[k]])
  );
  snapshot.version = plan.version;
  snapshot.archivedAt = nowIso();
  plan.history.push(snapshot);

  Object.assign(plan, {
    coreId: f.coreId,
    borehole: f.borehole,
    coreBox: f.coreBox,
    topDepth: f.topDepth,
    bottomDepth: f.bottomDepth,
    azimuth: f.azimuth,
    dip: f.dip,
    sampleLength: f.sampleLength,
    owner: f.owner,
  });
  plan.version += 1;
  plan.updatedAt = nowIso();

  for (const d of db.deliveries) {
    if (d.planId === plan.id && d.valid) d.valid = false;
  }
  reevaluate(db, plan);
  return plan;
}

// 纯重算：按登记先后顺序顺次核销；待复测切片不占长度。
export function reevaluate(db, plan) {
  const list = slicesOf(db, plan.id)
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let remaining = plan.sampleLength;
  const at = nowIso();
  for (const s of list) {
    s.planVersion = plan.version;
    s.evaluatedAt = at;
    if (s.offset < -EPS) {
      s.status = SLICE_RETEST;
      s.reason = SLICE_REASONS.reverse;
      continue;
    }
    if (s.length > remaining + EPS) {
      s.status = SLICE_RETEST;
      s.reason = SLICE_REASONS.overflow;
      continue;
    }
    s.status = SLICE_OK;
    s.reason = "";
    remaining = Math.round((remaining - s.length) * 1000) / 1000;
  }
  return list;
}

export function registerSlice(db, input) {
  const planId = str(input.planId);
  const id = str(input.id);
  const plan = planById(db, planId);
  if (!plan) throw new DomainError(404, "plan_not_found", { planId });
  if (!plan.active) throw new DomainError(409, "plan_not_active");
  if (!id) throw new DomainError(400, "slice_id_missing");
  if (db.slices.some(s => s.id === id))
    throw new DomainError(409, "slice_id_exists", { id });

  const offset = num(input.offset);
  const length = num(input.length);
  if (offset === null) throw new DomainError(400, "offset_invalid", { message: "相对位置必须为数值" });
  if (length === null || length <= 0) throw new DomainError(400, "length_invalid", { message: "取样长度必须为正数" });

  const slice = {
    id,
    planId: plan.id,
    planVersion: plan.version,
    offset,
    length,
    status: SLICE_RETEST,
    reason: "",
    createdAt: nowIso(),
    evaluatedAt: null,
  };
  db.slices.push(slice);
  reevaluate(db, plan);
  return slice;
}

export function deliverSlice(db, sliceId) {
  const slice = db.slices.find(s => s.id === sliceId);
  if (!slice) throw new DomainError(404, "slice_not_found");
  const plan = planById(db, slice.planId);
  if (!plan || !plan.active) throw new DomainError(409, "plan_not_active");
  if (slice.status !== SLICE_OK)
    throw new DomainError(409, "slice_not_valid", { status: slice.status, reason: slice.reason });
  const existing = db.deliveries.find(d => d.sliceId === slice.id && d.planVersion === plan.version && d.valid);
  if (existing) return existing;
  const record = {
    id: genId("DLV"),
    sliceId: slice.id,
    planId: plan.id,
    planVersion: plan.version,
    valid: true,
    at: nowIso(),
  };
  db.deliveries.push(record);
  return record;
}

// ---------- 视图与统计（只读，仅统计当前版本） ----------

function planConsumption(db, plan) {
  const slices = slicesOf(db, plan.id);
  const valid = slices.filter(s => s.status === SLICE_OK && s.planVersion === plan.version);
  const retest = slices.filter(s => s.status === SLICE_RETEST && s.planVersion === plan.version);
  const used = Math.round(valid.reduce((sum, s) => sum + s.length, 0) * 1000) / 1000;
  const remaining = Math.round((plan.sampleLength - used) * 1000) / 1000;
  return { slices, valid, retest, used, remaining };
}

export function planView(db, plan) {
  const c = planConsumption(db, plan);
  const deliveries = db.deliveries.filter(d => d.planId === plan.id);
  return {
    ...plan,
    usedLength: c.used,
    remainingLength: c.remaining,
    sliceCount: c.slices.length,
    validSliceCount: c.valid.length,
    retestCount: c.retest.length,
    deliveries: deliveries.map(d => ({ ...d, sliceId: d.sliceId })),
    slices: c.slices
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(s => {
        const d = deliveries.find(x => x.sliceId === s.id && x.planVersion === plan.version && x.valid);
        return { ...s, delivered: Boolean(d), deliveryId: d ? d.id : null };
      }),
  };
}

export function listView(db) {
  return activePlans(db)
    .map(p => {
      const c = planConsumption(db, p);
      return {
        id: p.id,
        version: p.version,
        coreId: p.coreId,
        borehole: p.borehole,
        coreBox: p.coreBox,
        topDepth: p.topDepth,
        bottomDepth: p.bottomDepth,
        azimuth: p.azimuth,
        dip: p.dip,
        sampleLength: p.sampleLength,
        owner: p.owner,
        updatedAt: p.updatedAt,
        usedLength: c.used,
        remainingLength: c.remaining,
        sliceCount: c.slices.length,
        validSliceCount: c.valid.length,
        retestCount: c.retest.length,
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function statsView(db) {
  const active = activePlans(db);
  const currentSlices = db.slices.filter(s => {
    const p = planById(db, s.planId);
    return p && p.active && s.planVersion === p.version;
  });
  const valid = currentSlices.filter(s => s.status === SLICE_OK);
  const retest = currentSlices.filter(s => s.status === SLICE_RETEST);
  const sampleTotal = Math.round(active.reduce((sum, p) => sum + p.sampleLength, 0) * 1000) / 1000;
  const usedTotal = Math.round(valid.reduce((sum, s) => sum + s.length, 0) * 1000) / 1000;
  return {
    activePlans: active.length,
    currentSlices: currentSlices.length,
    validSlices: valid.length,
    retestSlices: retest.length,
    sampleLengthTotal: sampleTotal,
    usedLengthTotal: usedTotal,
    remainingLengthTotal: Math.round((sampleTotal - usedTotal) * 1000) / 1000,
    activeDeliveries: db.deliveries.filter(d => d.valid).length,
  };
}
