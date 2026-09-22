// 请求入口层：仅负责 HTTP 路由、请求解析、幂等复用与页面承载。
// 所有判定交给 src/rules.js，所有落盘交给 src/store.js。
import http from "node:http";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonStore } from "./src/store.js";
import {
  DomainError,
  createPlan,
  correctPlan,
  registerSlice,
  deliverSlice,
  listView,
  planView,
  planById,
  statsView,
  seedDb,
} from "./src/rules.js";
import { page } from "./src/page.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "core-desk.json");
const port = Number(process.env.PORT || 3025);
const store = new JsonStore(dbPath, seedDb());

function sendJson(res, status, data, extraHeaders = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...extraHeaders });
  res.end(JSON.stringify(data, null, 2));
}

// 幂等：同一 Idempotency-Key 的重复/并发提交沿用首次结果。
// 没有显式 Key 时退化为路径+请求体指纹；进行中的并发请求也共享同一份 Promise。
const idem = new Map(); // key -> { at, status, body, promise? }
const IDEM_TTL_MS = 10 * 60 * 1000;
function idemKey(req, rawBody, fallback) {
  const explicit = req.headers["idempotency-key"];
  if (typeof explicit === "string" && explicit.trim()) return `k:${explicit.trim()}`;
  return `f:${fallback}:${rawBody}`;
}
async function settleEntry(entry, replay) {
  if (entry.promise) await entry.promise;
  if (entry.error) {
    if (replay) entry.error.idempotentReplay = true;
    throw entry.error;
  }
  return entry.result;
}
async function idempotent(key, worker) {
  const hit = idem.get(key);
  if (hit) return { ...(await settleEntry(hit, true)), replay: true };
  const entry = { at: Date.now(), promise: null, result: null, error: null };
  entry.promise = (async () => {
    try {
      entry.result = await worker();
    } catch (err) {
      entry.error = err;
    } finally {
      entry.promise = null;
    }
  })();
  idem.set(key, entry);
  const result = await settleEntry(entry);
  if (idem.size > 500) {
    for (const [k, v] of idem) {
      if (!v.promise && Date.now() - v.at > IDEM_TTL_MS) idem.delete(k);
    }
  }
  return { ...result, replay: false };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const { pathname } = url;

    if (req.method === "GET" && pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(page);
    }

    // ---------- 只读：列表、统计、方案详情（入口只读，不含判定写入） ----------
    if (req.method === "GET" && pathname === "/api/plans") {
      const db = await store.read();
      return sendJson(res, 200, { plans: listView(db), stats: statsView(db) });
    }
    const detail = pathname.match(/^\/api\/plans\/([^/]+)$/);
    if (detail && req.method === "GET") {
      const db = await store.read();
      const plan = planById(db, detail[1]);
      if (!plan || !plan.active) return sendJson(res, 404, { error: "plan_not_found" });
      return sendJson(res, 200, planView(db, plan));
    }

    // ---------- 写入：全部走串行 mutate + 幂等 ----------
    if (req.method === "POST" && pathname === "/api/plans") {
      const raw = await reqBodyText(req);
      const input = JSON.parse(raw || "{}");
      const out = await idempotent(idemKey(req, raw, pathname), () =>
        store.mutate(db => {
          const plan = createPlan(db, input);
          return { status: 201, body: planView(db, plan) };
        })
      );
      return sendJson(res, out.status, out.body, { "Idempotent-Replay": out.replay ? "1" : "0" });
    }

    const correct = pathname.match(/^\/api\/plans\/([^/]+)\/correct$/);
    if (correct && req.method === "POST") {
      const raw = await reqBodyText(req);
      const input = JSON.parse(raw || "{}");
      const out = await idempotent(idemKey(req, raw, pathname), () =>
        store.mutate(db => {
          const plan = correctPlan(db, correct[1], input);
          return { status: 200, body: planView(db, plan) };
        })
      );
      return sendJson(res, out.status, out.body, { "Idempotent-Replay": out.replay ? "1" : "0" });
    }

    if (req.method === "POST" && pathname === "/api/slices") {
      const raw = await reqBodyText(req);
      const input = JSON.parse(raw || "{}");
      const out = await idempotent(idemKey(req, raw, pathname), () =>
        store.mutate(db => {
          const slice = registerSlice(db, input);
          return { status: 201, body: { slice, plan: planView(db, planById(db, slice.planId)) } };
        })
      );
      return sendJson(res, out.status, out.body, { "Idempotent-Replay": out.replay ? "1" : "0" });
    }

    const deliver = pathname.match(/^\/api\/slices\/([^/]+)\/deliver$/);
    if (deliver && req.method === "POST") {
      const raw = await reqBodyText(req);
      const out = await idempotent(idemKey(req, raw, pathname), () =>
        store.mutate(db => {
          const record = deliverSlice(db, deliver[1]);
          return { status: 200, body: { delivery: record, plan: planView(db, planById(db, record.planId)) } };
        })
      );
      return sendJson(res, out.status, out.body, { "Idempotent-Replay": out.replay ? "1" : "0" });
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    const replayHeader = error.idempotentReplay ? { "Idempotent-Replay": "1" } : {};
    if (error instanceof DomainError) return sendJson(res, error.status, { error: error.error, details: error.details }, replayHeader);
    if (error instanceof SyntaxError) return sendJson(res, 400, { error: "invalid_json" });
    sendJson(res, 500, { error: error.message });
  }
});

async function reqBodyText(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

server.listen(port, () => console.log(`定向取样与剩余长度核销台 listening on http://localhost:${port}`));
