import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";

const PORT = 3199;
const DB = `/tmp/directional-test-${process.pid}.json`;
const base = `http://localhost:${PORT}`;

function start() {
  const proc = spawn("node", ["server.js"], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, LEGACY_DB_PATH: "/nonexistent-legacy.json" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server start timeout")), 8000);
    proc.stdout.on("data", chunk => {
      if (String(chunk).includes("listening")) { clearTimeout(timer); resolve(proc); }
    });
    proc.stderr.on("data", chunk => process.stderr.write(chunk));
  });
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  return { status: res.status, data, replayed: res.headers.get("x-replayed") === "true" };
}

const planBody = { topDepth: 100.2, bottomDepth: 101, azimuth: 45, dip: 5, sampleLength: 0.8 };
const coreOf = (state, id) => state.cores.find(c => c.id === id);

let proc = await start();
try {
  // 页面入口
  const home = await fetch(base + "/");
  assert.equal(home.status, 200);
  assert.match(await home.text(), /定向取样与剩余长度核销台/);

  const baseline = (await api("/api/state")).data;

  // 1. 登记岩芯
  const bad = await api("/api/cores", { method: "POST", body: { borehole: "ZK-T0", coreBox: "BX-T0", topDepth: 103, bottomDepth: 100 } });
  assert.equal(bad.status, 422);
  const coreA = (await api("/api/cores", { method: "POST", body: { borehole: "ZK-T1", coreBox: "BX-T1", topDepth: 100, bottomDepth: 103, owner: "测试员" } })).data;
  assert.equal(coreA.id, "CORE-002"); // 种子含 CORE-001

  // 2. 提交方案 + 重复提交沿用首次结果（无 requestId，走报文指纹）
  const plan1 = await api(`/api/cores/${coreA.id}/plans`, { method: "POST", body: planBody });
  assert.equal(plan1.status, 201);
  assert.equal(plan1.data.id, `PLAN-${coreA.id}-V1`);
  const plan1dup = await api(`/api/cores/${coreA.id}/plans`, { method: "POST", body: planBody });
  assert.equal(plan1dup.replayed, true);
  assert.equal(plan1dup.data.id, plan1.data.id);
  let state = (await api("/api/state")).data;
  assert.equal(state.cores.flatMap(c => c.archive.plans).length + state.cores.filter(c => c.activePlan).length, baseline.cores.filter(c => c.activePlan).length + 1);
  assert.equal(coreOf(state, coreA.id).activePlan.remaining, 0.8);

  // 3. 每根岩芯同时仅一份有效方案
  const second = await api(`/api/cores/${coreA.id}/plans`, { method: "POST", body: { ...planBody, dip: 3 } });
  assert.equal(second.status, 409);

  // 4. 整单拒绝且不写入：倾角 / 方位 / 区间 / 重叠
  const mk = async (hole, box) => (await api("/api/cores", { method: "POST", body: { borehole: hole, coreBox: box, topDepth: 100, bottomDepth: 103 } })).data.id;
  const coreB = await mk("ZK-T2", "BX-T2");
  const coreC = await mk("ZK-T3", "BX-T3");
  const coreD = await mk("ZK-T4", "BX-T4");
  const coreE = await mk("ZK-T5", "BX-T5");
  // 同孔同箱的第二根岩芯：报文需可区分，否则按重复提交沿用首次结果
  const coreF = (await api("/api/cores", { method: "POST", body: { borehole: "ZK-T5", coreBox: "BX-T5", topDepth: 100, bottomDepth: 103, owner: "第二根" } })).data.id;
  assert.notEqual(coreF, coreE);
  const plansBefore = (await api("/api/state")).data.cores.filter(c => c.activePlan).length;

  const rDip = await api(`/api/cores/${coreB}/plans`, { method: "POST", body: { ...planBody, dip: 10.5 } });
  assert.equal(rDip.status, 422);
  assert.ok(rDip.data.reasons.some(r => r.includes("倾角不在零至十度")));
  const dipEdge = await api(`/api/cores/${coreB}/plans`, { method: "POST", body: { ...planBody, dip: 10 } });
  assert.equal(dipEdge.status, 201); // 边界值 10 合法

  const rAz = await api(`/api/cores/${coreC}/plans`, { method: "POST", body: { topDepth: 100.2, bottomDepth: 101, dip: 5, sampleLength: 0.8 } });
  assert.equal(rAz.status, 422);
  assert.ok(rAz.data.reasons.some(r => r.includes("方位缺失")));

  const rRange = await api(`/api/cores/${coreD}/plans`, { method: "POST", body: { ...planBody, topDepth: 99.5 } });
  assert.equal(rRange.status, 422);
  assert.ok(rRange.data.reasons.some(r => r.includes("区间越界")));
  const rLen = await api(`/api/cores/${coreD}/plans`, { method: "POST", body: { ...planBody, sampleLength: 5 } });
  assert.equal(rLen.status, 422);
  assert.ok(rLen.data.reasons.some(r => r.includes("区间越界")));

  await api(`/api/cores/${coreE}/plans`, { method: "POST", body: { topDepth: 100, bottomDepth: 101, azimuth: 10, dip: 2, sampleLength: 1 } });
  const rOverlap = await api(`/api/cores/${coreF}/plans`, { method: "POST", body: { topDepth: 100.5, bottomDepth: 101.5, azimuth: 20, dip: 2, sampleLength: 1 } });
  assert.equal(rOverlap.status, 422);
  assert.ok(rOverlap.data.reasons.some(r => r.includes("重叠")));
  const touch = await api(`/api/cores/${coreF}/plans`, { method: "POST", body: { topDepth: 101, bottomDepth: 102, azimuth: 20, dip: 2, sampleLength: 1 } });
  assert.equal(touch.status, 201); // 端点相接不算重叠

  state = (await api("/api/state")).data;
  assert.equal(state.cores.filter(c => c.activePlan).length, plansBefore + 3); // dipEdge、coreE、touch 写入，拒绝单不写入
  assert.equal(coreOf(state, coreC).activePlan, null);
  assert.equal(coreOf(state, coreD).activePlan, null);

  // 5. 切片：并发重复提交沿用首次结果，剩余长度只核销一次
  const sliceBody = { offset: 0.1, length: 0.2, direction: "正向" };
  const concurrent = await Promise.all(Array.from({ length: 5 }, () =>
    api(`/api/plans/${plan1.data.id}/slices`, { method: "POST", body: sliceBody })));
  assert.ok(concurrent.every(r => r.status === 201));
  assert.equal(new Set(concurrent.map(r => r.data.id)).size, 1);
  assert.ok(concurrent.slice(1).every(r => r.replayed));
  state = (await api("/api/state")).data;
  assert.equal(coreOf(state, coreA.id).activePlan.slices.length, 1);
  assert.equal(coreOf(state, coreA.id).activePlan.remaining, 0.6);

  // 6. 超出剩余长度 / 方向反转 → 只转待复测，不核销
  const over = await api(`/api/plans/${plan1.data.id}/slices`, { method: "POST", body: { offset: 0.2, length: 0.7, direction: "正向" } });
  assert.equal(over.status, 201);
  assert.equal(over.data.status, "待复测");
  assert.ok(over.data.reasons.includes("超出剩余长度"));
  const rev = await api(`/api/plans/${plan1.data.id}/slices`, { method: "POST", body: { offset: 0.2, length: 0.1, direction: "反向" } });
  assert.equal(rev.data.status, "待复测");
  assert.ok(rev.data.reasons.includes("方向反转"));
  const ok2 = await api(`/api/plans/${plan1.data.id}/slices`, { method: "POST", body: { offset: 0.3, length: 0.1, direction: "正向" } });
  assert.equal(ok2.data.status, "有效");
  state = (await api("/api/state")).data;
  assert.equal(coreOf(state, coreA.id).activePlan.remaining, 0.5); // 待复测不核销
  assert.equal(state.stats["待复测切片"], 2);

  // 7. 交付 + 重复交付沿用首次结果
  const dlv = await api(`/api/plans/${plan1.data.id}/deliver`, { method: "POST", body: {} });
  assert.equal(dlv.status, 201);
  assert.deepEqual(dlv.data.sliceIds.sort(), [concurrent[0].data.id, ok2.data.id].sort());
  const dlvDup = await api(`/api/plans/${plan1.data.id}/deliver`, { method: "POST", body: {} });
  assert.equal(dlvDup.replayed, true);
  const dlvAgain = await api(`/api/plans/${plan1.data.id}/deliver`, { method: "POST", body: { note: "再次点击" } });
  assert.equal(dlvAgain.status, 409);

  // 8. 更正：非法更正整单拒绝；合法更正使切片与交付立即失效，按新位置重算
  const badCorrect = await api(`/api/cores/${coreA.id}/plan/correct`, { method: "POST", body: { ...planBody, dip: 20 } });
  assert.equal(badCorrect.status, 422);
  const correct = await api(`/api/cores/${coreA.id}/plan/correct`, { method: "POST", body: { topDepth: 100.2, bottomDepth: 101.2, azimuth: 50, dip: 8, sampleLength: 1 } });
  assert.equal(correct.status, 201);
  assert.equal(correct.data.version, 2);
  state = (await api("/api/state")).data;
  const viewA = coreOf(state, coreA.id);
  assert.equal(viewA.activePlan.id, `PLAN-${coreA.id}-V2`);
  assert.equal(viewA.activePlan.remaining, 1); // 按新位置重算
  assert.equal(viewA.activePlan.slices.length, 0);
  assert.equal(viewA.archive.plans.length, 1);
  assert.equal(viewA.archive.plans[0].status, "已更正");
  assert.equal(viewA.archive.slices.length, 4);
  assert.ok(viewA.archive.slices.every(s => s.status === "已失效"));
  assert.equal(viewA.archive.deliveries.length, 1);
  assert.equal(viewA.archive.deliveries[0].status, "已失效");
  assert.equal(state.stats["已交付"], 0); // 旧版留档不计统计
  assert.equal(state.stats["待复测切片"], 0);

  // 9. 旧方案不可再引用
  const stale = await api(`/api/plans/${plan1.data.id}/slices`, { method: "POST", body: { offset: 0, length: 0.1, direction: "正向" } });
  assert.equal(stale.status, 409);
  const fresh = await api(`/api/plans/${correct.data.id}/slices`, { method: "POST", body: { offset: 0, length: 0.4, direction: "正向" } });
  assert.equal(fresh.data.status, "有效");
  assert.equal((await api("/api/state")).data.cores.find(c => c.id === coreA.id).activePlan.remaining, 0.6);

  // 10. requestId 幂等：同键不同报文也沿用首次结果
  const ridBody = { borehole: "ZK-T9", coreBox: "BX-T9", topDepth: 50, bottomDepth: 60, requestId: "fixed-rid-1" };
  const first = await api("/api/cores", { method: "POST", body: ridBody });
  const again = await api("/api/cores", { method: "POST", body: { ...ridBody, borehole: "ZK-T9-CHANGED" } });
  assert.equal(again.replayed, true);
  assert.equal(again.data.id, first.data.id);
  assert.equal((await api("/api/state")).data.cores.filter(c => c.borehole.startsWith("ZK-T9")).length, 1);

  // 11. 重载（重启）后列表、剩余长度、状态一致
  const before = (await api("/api/state")).data;
  proc.kill();
  proc = await start();
  const after = (await api("/api/state")).data;
  assert.deepEqual(after, before);

  console.log("全部冒烟断言通过 ✔");
} finally {
  proc.kill();
  await rm(DB, { force: true });
}
