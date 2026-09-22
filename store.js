import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || join(__dirname, "data", "directional-sampling.json");
const legacyPath = process.env.LEGACY_DB_PATH || join(__dirname, "data", "core-slices.json");

const seed = {
  version: 2,
  seq: { core: 1, slice: 1, delivery: 0 },
  cores: [
    { id: "CORE-001", project: "东岭铜矿薄片", borehole: "ZK-17", coreBox: "BX-09", topDepth: 128, bottomDepth: 130, owner: "陆川", createdAt: "2026-06-12T09:00:00.000Z", legacySlices: [] }
  ],
  plans: [
    { id: "PLAN-CORE-001-V1", coreId: "CORE-001", borehole: "ZK-17", coreBox: "BX-09", version: 1, topDepth: 128.4, bottomDepth: 128.8, azimuth: 132, dip: 6, sampleLength: 0.4, status: "有效", createdAt: "2026-06-12T09:30:00.000Z", supersededAt: null }
  ],
  slices: [
    { id: "SL-001", planId: "PLAN-CORE-001-V1", planVersion: 1, offset: 0.05, length: 0.1, direction: "正向", status: "有效", reasons: [], createdAt: "2026-06-12T10:00:00.000Z" }
  ],
  deliveries: [],
  requests: []
};

function emptyDb() {
  return { version: 2, seq: { core: 0, slice: 0, delivery: 0 }, cores: [], plans: [], slices: [], deliveries: [], requests: [] };
}

// 旧版岩芯切片实验室数据迁移：样本转岩芯，旧切片留档（无方位信息，不生成方案）
function migrateLegacy(raw) {
  const db = emptyDb();
  for (const sample of raw.samples || []) {
    const match = /(-?[\d.]+)\s*[-~–]\s*(-?[\d.]+)/.exec(String(sample.depth || ""));
    db.cores.push({
      id: sample.id,
      project: sample.project || "旧系统迁移",
      borehole: sample.borehole,
      coreBox: sample.coreBox,
      topDepth: match ? Number(match[1]) : 0,
      bottomDepth: match ? Number(match[2]) : 0,
      owner: sample.owner || "未指定",
      createdAt: new Date().toISOString(),
      legacySlices: (sample.slices || []).map(slice => ({ ...slice, archived: "旧系统留档" }))
    });
    const seqNo = Number(String(sample.id).replace(/\D/g, ""));
    if (Number.isFinite(seqNo)) db.seq.core = Math.max(db.seq.core, seqNo);
  }
  return db;
}

let cache = null;
let queue = Promise.resolve();

async function persist(db) {
  const tmp = `${dbPath}.tmp`;
  await writeFile(tmp, JSON.stringify(db, null, 2));
  await rename(tmp, dbPath); // 原子替换，保证重载后状态一致
}

async function loadFromDisk() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    const initial = existsSync(legacyPath)
      ? migrateLegacy(JSON.parse(await readFile(legacyPath, "utf8")))
      : seed;
    await persist(initial);
    return initial;
  }
  const raw = JSON.parse(await readFile(dbPath, "utf8"));
  if (raw.samples && !raw.cores) {
    const migrated = migrateLegacy(raw);
    await persist(migrated);
    return migrated;
  }
  return raw;
}

export async function getDb() {
  if (!cache) cache = await loadFromDisk();
  return cache;
}

// 串行事务：并发提交排队执行；命中幂等键直接沿用首次结果
export function transact(key, fn) {
  const run = queue.then(async () => {
    const db = await getDb();
    if (key) {
      const hit = db.requests.find(item => item.key === key);
      if (hit) return { ...hit.response, replayed: true };
    }
    const result = await fn(db);
    if (key) {
      db.requests.push({ key, at: new Date().toISOString(), response: { status: result.status, body: result.body } });
    }
    await persist(db);
    return { ...result, replayed: false };
  });
  queue = run.catch(() => {});
  return run;
}
