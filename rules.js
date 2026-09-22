import { createHash } from "node:crypto";

// —— 判定规则常量 ——
export const DIP_RANGE = { min: 0, max: 10 }; // 倾角零至十度
export const AZIMUTH_RANGE = { min: 0, max: 360 }; // 方位角 [0, 360)
export const DIRECTIONS = ["正向", "反向"];

const EPS = 1e-9;

export function toNumber(value) {
  if (value === null || value === undefined || value === "") return NaN;
  return Number(value);
}

export function round3(value) {
  return Math.round(value * 1000) / 1000;
}

// 重复/并发提交识别：优先客户端 requestId，否则用 方法+路径+报文 指纹
export function fingerprint(method, path, payload) {
  const { requestId, ...rest } = payload || {};
  const canonical = JSON.stringify(rest, Object.keys(rest).sort());
  return createHash("sha256").update(`${method} ${path} ${canonical}`).digest("hex").slice(0, 24);
}

export function activePlanOf(db, coreId) {
  return db.plans.find(plan => plan.coreId === coreId && plan.status === "有效") || null;
}

// 剩余长度 = 取样长度 - 有效切片核销（待复测/已失效不核销）
export function remainingOf(plan, slices) {
  const used = slices
    .filter(slice => slice.planId === plan.id && slice.status === "有效")
    .reduce((sum, slice) => sum + slice.length, 0);
  return round3(plan.sampleLength - used);
}

// 同孔同箱有效方案区间重叠（端点相接不算重叠）
export function findOverlap(db, borehole, coreBox, top, bottom, excludePlanId = null) {
  return db.plans.find(plan =>
    plan.status === "有效" &&
    plan.id !== excludePlanId &&
    plan.borehole === borehole &&
    plan.coreBox === coreBox &&
    top < plan.bottomDepth && plan.topDepth < bottom
  ) || null;
}

function nextVersion(db, coreId) {
  return db.plans
    .filter(plan => plan.coreId === coreId)
    .reduce((max, plan) => Math.max(max, plan.version), 0) + 1;
}

// 方案字段判定：区间越界 / 方位缺失 / 倾角不在零至十度 / 同孔同箱重叠
function validatePlanFields(db, core, input, excludePlanId = null) {
  const top = toNumber(input.topDepth);
  const bottom = toNumber(input.bottomDepth);
  const azimuth = toNumber(input.azimuth);
  const dip = toNumber(input.dip);
  const sampleLength = toNumber(input.sampleLength);
  const reasons = [];

  const intervalKnown = Number.isFinite(top) && Number.isFinite(bottom);
  if (
    !intervalKnown || top >= bottom ||
    top < core.topDepth - EPS || bottom > core.bottomDepth + EPS ||
    !Number.isFinite(sampleLength) || sampleLength <= 0 || sampleLength - (bottom - top) > EPS
  ) reasons.push("区间越界");

  if (!Number.isFinite(azimuth) || azimuth < AZIMUTH_RANGE.min || azimuth >= AZIMUTH_RANGE.max) {
    reasons.push("方位缺失");
  }
  if (!Number.isFinite(dip) || dip < DIP_RANGE.min - EPS || dip > DIP_RANGE.max + EPS) {
    reasons.push("倾角不在零至十度");
  }
  if (intervalKnown && top < bottom) {
    const hit = findOverlap(db, core.borehole, core.coreBox, top, bottom, excludePlanId);
    if (hit) reasons.push(`与同孔同箱方案重叠(${hit.id})`);
  }
  return { reasons, top, bottom, azimuth, dip, sampleLength };
}

function buildPlan(db, core, fields) {
  const version = nextVersion(db, core.id);
  return {
    id: `PLAN-${core.id}-V${version}`,
    coreId: core.id,
    borehole: core.borehole,
    coreBox: core.coreBox,
    version,
    topDepth: round3(fields.top),
    bottomDepth: round3(fields.bottom),
    azimuth: round3(fields.azimuth),
    dip: round3(fields.dip),
    sampleLength: round3(fields.sampleLength),
    status: "有效",
    createdAt: new Date().toISOString(),
    supersededAt: null
  };
}

// —— 登记岩芯 ——
export function decideAddCore(db, input) {
  const borehole = String(input.borehole ?? "").trim();
  const coreBox = String(input.coreBox ?? "").trim();
  const owner = String(input.owner ?? "").trim() || "未指定";
  const project = String(input.project ?? "").trim() || "定向取样";
  const top = toNumber(input.topDepth);
  const bottom = toNumber(input.bottomDepth);
  const reasons = [];
  if (!borehole || !coreBox) reasons.push("钻孔编号与岩芯箱号必填");
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || top >= bottom) reasons.push("岩芯区间非法");
  if (reasons.length) return { ok: false, status: 422, reasons };
  const core = {
    id: "",
    borehole,
    coreBox,
    owner,
    project,
    topDepth: round3(top),
    bottomDepth: round3(bottom),
    createdAt: new Date().toISOString(),
    legacySlices: []
  };
  return {
    ok: true,
    core,
    apply(db) {
      core.id = `CORE-${String(++db.seq.core).padStart(3, "0")}`;
      db.cores.push(core);
    }
  };
}

// —— 提交方案：每根岩芯同时仅一份有效方案，违规整单拒绝 ——
export function decideSubmitPlan(db, coreId, input) {
  const core = db.cores.find(item => item.id === coreId);
  if (!core) return { ok: false, status: 404, reasons: ["岩芯不存在"] };
  if (activePlanOf(db, coreId)) return { ok: false, status: 409, reasons: ["已存在有效方案，如需调整请走更正"] };
  const fields = validatePlanFields(db, core, input);
  if (fields.reasons.length) return { ok: false, status: 422, reasons: fields.reasons };
  const plan = buildPlan(db, core, fields);
  return { ok: true, plan, apply(db) { db.plans.push(plan); } };
}

// —— 更正方案：关联切片与交付立即失效，按新位置重算，旧版留档 ——
export function decideCorrectPlan(db, coreId, input) {
  const core = db.cores.find(item => item.id === coreId);
  if (!core) return { ok: false, status: 404, reasons: ["岩芯不存在"] };
  const current = activePlanOf(db, coreId);
  if (!current) return { ok: false, status: 409, reasons: ["当前无有效方案可更正"] };
  const fields = validatePlanFields(db, core, input, current.id);
  if (fields.reasons.length) return { ok: false, status: 422, reasons: fields.reasons };
  const plan = buildPlan(db, core, fields);
  return {
    ok: true,
    plan,
    apply(db) {
      const now = plan.createdAt;
      current.status = "已更正";
      current.supersededAt = now;
      for (const slice of db.slices.filter(item => item.planId === current.id && item.status !== "已失效")) {
        slice.status = "已失效";
        slice.reasons = [...slice.reasons, "方案更正"];
        slice.invalidatedAt = now;
      }
      for (const delivery of db.deliveries.filter(item => item.planId === current.id && item.status === "已交付")) {
        delivery.status = "已失效";
        delivery.invalidatedAt = now;
      }
      db.plans.push(plan);
    }
  };
}

// —— 登记切片：须引用有效方案与相对位置；超出剩余长度或方向反转只转待复测 ——
export function decideAddSlice(db, planId, input) {
  const plan = db.plans.find(item => item.id === planId);
  if (!plan) return { ok: false, status: 404, reasons: ["方案不存在"] };
  if (plan.status !== "有效") return { ok: false, status: 409, reasons: ["方案已更正，切片须引用有效方案"] };
  const offset = toNumber(input.offset);
  const length = toNumber(input.length);
  const direction = String(input.direction ?? "");
  if (!Number.isFinite(offset) || !Number.isFinite(length) || length <= 0 || !DIRECTIONS.includes(direction)) {
    return { ok: false, status: 400, reasons: ["切片参数不完整：相对位置、长度、方向（正向/反向）必填"] };
  }
  const remaining = remainingOf(plan, db.slices);
  const reasons = [];
  if (direction === "反向") reasons.push("方向反转");
  if (offset < 0 || offset + length > plan.sampleLength + EPS || length > remaining + EPS) reasons.push("超出剩余长度");
  const slice = {
    id: "",
    planId: plan.id,
    planVersion: plan.version,
    offset: round3(offset),
    length: round3(length),
    direction,
    status: reasons.length ? "待复测" : "有效",
    reasons,
    createdAt: new Date().toISOString()
  };
  return {
    ok: true,
    slice,
    apply(db) {
      slice.id = `SL-${String(++db.seq.slice).padStart(3, "0")}`;
      db.slices.push(slice);
    }
  };
}

// —— 交付：仅有效方案的有效切片可交付 ——
export function decideDeliver(db, planId) {
  const plan = db.plans.find(item => item.id === planId);
  if (!plan) return { ok: false, status: 404, reasons: ["方案不存在"] };
  if (plan.status !== "有效") return { ok: false, status: 409, reasons: ["方案已更正，交付已失效"] };
  const validSlices = db.slices.filter(item => item.planId === plan.id && item.status === "有效");
  if (!validSlices.length) return { ok: false, status: 409, reasons: ["无有效切片可交付"] };
  if (db.deliveries.some(item => item.planId === plan.id && item.status === "已交付")) {
    return { ok: false, status: 409, reasons: ["该方案已交付"] };
  }
  const delivery = {
    id: "",
    planId: plan.id,
    planVersion: plan.version,
    sliceIds: validSlices.map(item => item.id),
    status: "已交付",
    createdAt: new Date().toISOString(),
    invalidatedAt: null
  };
  return {
    ok: true,
    delivery,
    apply(db) {
      delivery.id = `DLV-${String(++db.seq.delivery).padStart(3, "0")}`;
      db.deliveries.push(delivery);
    }
  };
}

// —— 读模型：列表 + 剩余长度 + 统计（旧版留档不计统计） ——
export function buildState(db) {
  const cores = db.cores.map(core => {
    const active = activePlanOf(db, core.id);
    const archivedPlans = db.plans.filter(plan => plan.coreId === core.id && plan.status !== "有效");
    const archivedPlanIds = new Set(archivedPlans.map(plan => plan.id));
    let activePlan = null;
    if (active) {
      const remaining = remainingOf(active, db.slices);
      activePlan = {
        ...active,
        remaining,
        consumed: round3(active.sampleLength - remaining),
        slices: db.slices.filter(slice => slice.planId === active.id),
        deliveries: db.deliveries.filter(delivery => delivery.planId === active.id)
      };
    }
    return {
      ...core,
      activePlan,
      archive: {
        plans: archivedPlans,
        slices: db.slices.filter(slice => archivedPlanIds.has(slice.planId)),
        deliveries: db.deliveries.filter(delivery => archivedPlanIds.has(delivery.planId))
      }
    };
  });
  const activePlanIds = new Set(db.plans.filter(plan => plan.status === "有效").map(plan => plan.id));
  const liveSlices = db.slices.filter(slice => activePlanIds.has(slice.planId) && slice.status !== "已失效");
  const stats = {
    有效方案: activePlanIds.size,
    有效切片: liveSlices.filter(slice => slice.status === "有效").length,
    待复测切片: liveSlices.filter(slice => slice.status === "待复测").length,
    已交付: db.deliveries.filter(delivery => activePlanIds.has(delivery.planId) && delivery.status === "已交付").length
  };
  return { cores, stats };
}
