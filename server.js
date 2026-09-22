import http from "node:http";
import * as store from "./store.js";
import * as rules from "./rules.js";

const port = Number(process.env.PORT || 3025);

async function payload(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("bad_json"), { status: 400 });
  }
}

function sendJson(res, status, data, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(data, null, 2));
}

// 幂等键：客户端 requestId 优先，否则按 方法+路径+报文 指纹
function idemKey(req, path, body) {
  const rid = body && typeof body.requestId === "string" && body.requestId.trim();
  return rid ? `rid:${rid.trim()}` : `fp:${rules.fingerprint(req.method, path, body)}`;
}

function sendResult(res, result) {
  sendJson(res, result.status, result.body, { "X-Replayed": String(result.replayed) });
}

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>定向取样与剩余长度核销台</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#242822; --muted:#687062; --line:#d7ddd1; --accent:#526f43; --warn:#a86a1c; --bad:#a03d2a; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:16px; }
    h1 { margin:0; font-size:24px; } h2 { margin:0 0 12px; font-size:18px; } h3 { margin:0; font-size:16px; }
    main { display:grid; grid-template-columns:360px 1fr; gap:22px; padding:22px 28px; align-items:start; }
    form,.panel,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:8px 0 4px; color:var(--muted); font-size:13px; }
    input,select { width:100%; border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; background:#fff; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:9px 13px; font-weight:700; cursor:pointer; }
    button:disabled { opacity:.55; cursor:default; } button.ghost { background:#eef1ea; color:var(--ink); border:1px solid var(--line); }
    .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(380px,1fr)); gap:12px; } .card { display:grid; gap:10px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .pill.ok { color:var(--accent); border-color:var(--accent); } .pill.warn { color:var(--warn); border-color:var(--warn); } .pill.bad { color:var(--bad); border-color:var(--bad); }
    .remaining { display:flex; align-items:baseline; gap:10px; } .remaining strong { font-size:26px; color:var(--accent); }
    .bar { height:8px; background:#e7ebe2; border-radius:999px; overflow:hidden; } .bar i { display:block; height:100%; background:var(--accent); }
    table { width:100%; border-collapse:collapse; font-size:13px; } th,td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); } th { color:var(--muted); font-weight:600; }
    .row { display:grid; grid-template-columns:repeat(2,1fr); gap:8px; } .row3 { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; }
    details { border:1px dashed var(--line); border-radius:8px; padding:10px 12px; } summary { cursor:pointer; color:var(--muted); font-size:13px; }
    .archive { background:#fafaf7; font-size:13px; } .archive .item { padding:6px 0; border-bottom:1px dashed var(--line); } .archive .item:last-child { border-bottom:0; }
    #toast { position:fixed; left:50%; bottom:26px; transform:translateX(-50%); background:#242822; color:#fff; padding:10px 18px; border-radius:8px; opacity:0; pointer-events:none; transition:opacity .2s; max-width:80vw; }
    #toast.show { opacity:.95; } #toast.bad { background:var(--bad); }
    @media (max-width:950px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .stats{grid-template-columns:1fr 1fr;} }
  </style>
</head>
<body>
  <header>
    <div><h1>定向取样与剩余长度核销台</h1><div class="meta">每根岩芯同时仅一份有效方案 · 切片引用方案与相对位置 · 更正即失效重算 · 旧版留档不计统计</div></div>
    <button class="ghost" id="reload">刷新</button>
  </header>
  <main>
    <form id="core-form">
      <h2>登记岩芯</h2>
      <label>钻孔编号</label><input name="borehole" required>
      <label>岩芯箱号</label><input name="coreBox" required>
      <div class="row">
        <div><label>岩芯顶深(m)</label><input name="topDepth" type="number" step="any" required></div>
        <div><label>岩芯底深(m)</label><input name="bottomDepth" type="number" step="any" required></div>
      </div>
      <label>负责人</label><input name="owner">
      <div style="margin-top:12px"><button type="submit">登记岩芯</button></div>
    </form>
    <section>
      <div class="stats" id="stats"></div>
      <div class="grid" id="cores"></div>
    </section>
  </main>
  <div id="toast"></div>
  <script>
    const statsEl = document.querySelector("#stats");
    const coresEl = document.querySelector("#cores");
    const coreForm = document.querySelector("#core-form");
    const toastEl = document.querySelector("#toast");
    let state = { cores: [], stats: {} };

    const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
    const rid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "-" + Math.random());

    function toast(msg, bad) {
      toastEl.textContent = msg;
      toastEl.className = bad ? "show bad" : "show";
      clearTimeout(toastEl._t);
      toastEl._t = setTimeout(() => { toastEl.className = ""; }, 3800);
    }

    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers: { "Content-Type": "application/json" } } : options);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data.reasons || [data.error || "请求失败"]).join("；"));
      return { data, replayed: res.headers.get("X-Replayed") === "true" };
    }

    async function submit(path, btn, body) {
      btn.disabled = true;
      btn.dataset.rid = btn.dataset.rid || rid();
      try {
        const result = await api(path, { method: "POST", body: JSON.stringify({ ...body, requestId: btn.dataset.rid }) });
        toast(result.replayed ? "重复或并发提交，已沿用首次结果" : "已保存");
        await load();
      } catch (error) {
        btn.dataset.rid = rid(); // 新的一次尝试使用新的幂等键
        toast(error.message, true);
      } finally {
        btn.disabled = false;
      }
    }

    function planForm(core, mode) {
      const k = mode + "|" + core.id;
      const field = (name, label) => '<div><label>' + label + '</label><input type="number" step="any" data-f="' + name + "|" + k + '"></div>';
      return '<div class="row">' + field("topDepth", "顶深(m)") + field("bottomDepth", "底深(m)") + "</div>"
        + '<div class="row3">' + field("azimuth", "方位角(°)") + field("dip", "倾角(0-10°)") + field("sampleLength", "取样长度(m)") + "</div>"
        + '<div style="margin-top:10px"><button type="button" data-plan-btn="' + k + '">' + (mode === "submit" ? "提交方案" : "提交更正") + "</button></div>";
    }

    function slicesTable(p) {
      if (!p.slices.length) return '<div class="meta">暂无切片</div>';
      return "<table><thead><tr><th>切片</th><th>相对位置</th><th>长度</th><th>方向</th><th>状态</th><th>原因</th></tr></thead><tbody>"
        + p.slices.map(s => "<tr><td>" + esc(s.id) + "</td><td>" + s.offset + "m</td><td>" + s.length + "m</td><td>" + esc(s.direction)
          + '</td><td><span class="pill ' + (s.status === "有效" ? "ok" : "warn") + '">' + s.status + "</span></td>"
          + '<td class="meta">' + esc((s.reasons || []).join("；")) + "</td></tr>").join("")
        + "</tbody></table>";
    }

    function planView(core) {
      const p = core.activePlan;
      if (!p) return '<div class="meta">暂无有效方案，请提交定向取样方案。</div>' + planForm(core, "submit");
      const pct = p.sampleLength > 0 ? Math.min(100, Math.round(p.consumed / p.sampleLength * 100)) : 0;
      const delivered = p.deliveries.some(d => d.status === "已交付");
      return '<div><span class="pill ok">有效方案 ' + esc(p.id) + "</span> " + '<span class="pill">V' + p.version + "</span></div>"
        + '<div class="meta">区间 ' + p.topDepth + "–" + p.bottomDepth + "m · 方位角 " + p.azimuth + "° · 倾角 " + p.dip + "° · 取样长度 " + p.sampleLength + 'm</div>'
        + '<div class="remaining"><span>剩余长度</span><strong>' + p.remaining + 'm</strong><span class="meta">已核销 ' + p.consumed + "m / " + p.sampleLength + "m</span></div>"
        + '<div class="bar"><i style="width:' + pct + '%"></i></div>'
        + slicesTable(p)
        + '<div class="row3"><div><label>相对位置(m)</label><input type="number" step="any" data-s="offset|' + p.id + '"></div>'
        + '<div><label>切片长度(m)</label><input type="number" step="any" data-s="length|' + p.id + '"></div>'
        + '<div><label>方向</label><select data-s="direction|' + p.id + '"><option>正向</option><option>反向</option></select></div></div>'
        + '<div style="display:flex;gap:8px;margin-top:4px"><button type="button" data-slice-btn="' + p.id + '">登记切片</button>'
        + '<button type="button" class="ghost" data-deliver="' + p.id + '"' + (delivered ? " disabled" : "") + ">" + (delivered ? "已交付" : "交付当前方案") + "</button></div>"
        + (p.deliveries.length ? '<div class="meta">交付：' + p.deliveries.map(d => esc(d.id) + " · " + d.status + " · 切片 " + d.sliceIds.map(esc).join("、")).join("；") + "</div>" : "")
        + '<details><summary>更正方案（关联切片与交付立即失效，按新位置重算，旧版留档）</summary>' + planForm(core, "correct") + "</details>";
    }

    function archiveView(core) {
      const a = core.archive;
      const legacy = core.legacySlices || [];
      const total = a.plans.length + a.slices.length + a.deliveries.length + legacy.length;
      if (!total) return "";
      const items = []
        .concat(a.plans.map(p => '<div class="item"><span class="pill bad">' + p.status + '</span> 方案 ' + esc(p.id) + " · 区间 " + p.topDepth + "–" + p.bottomDepth + "m · 方位 " + p.azimuth + "° · 倾角 " + p.dip + "° · 取样 " + p.sampleLength + "m</div>"))
        .concat(a.slices.map(s => '<div class="item"><span class="pill bad">已失效</span> 切片 ' + esc(s.id) + " · " + esc(s.planId) + " · 位置 " + s.offset + "m · 长度 " + s.length + "m · " + esc((s.reasons || []).join("；")) + "</div>"))
        .concat(a.deliveries.map(d => '<div class="item"><span class="pill bad">已失效</span> 交付 ' + esc(d.id) + " · " + esc(d.planId) + " · 切片 " + d.sliceIds.map(esc).join("、") + "</div>"))
        .concat(legacy.map(s => '<div class="item"><span class="pill">旧系统留档</span> ' + esc(s.id) + " · " + esc(s.method || "") + " · " + esc(s.status || "") + "</div>"));
      return '<details class="archive"><summary>留档（不计入统计）· ' + total + " 条</summary>" + items.join("") + "</details>";
    }

    function render() {
      statsEl.innerHTML = Object.entries(state.stats).map(([k, v]) => '<div class="stat"><span>' + esc(k) + "</span><strong>" + v + "</strong></div>").join("");
      coresEl.innerHTML = state.cores.map(core =>
        '<article class="card"><div><h3>' + esc(core.borehole) + " · " + esc(core.coreBox) + "</h3>"
        + '<div class="meta">' + esc(core.id) + " · 岩芯区间 " + core.topDepth + "–" + core.bottomDepth + "m · 负责人 " + esc(core.owner) + "</div></div>"
        + planView(core) + archiveView(core) + "</article>"
      ).join("");
      bind();
    }

    function bind() {
      coresEl.querySelectorAll("[data-plan-btn]").forEach(btn => btn.onclick = () => {
        const parts = btn.dataset.planBtn.split("|");
        const mode = parts[0], coreId = parts.slice(1).join("|");
        const read = f => document.querySelector('[data-f="' + f + "|" + mode + "|" + coreId + '"]').value;
        const path = mode === "submit" ? "/api/cores/" + encodeURIComponent(coreId) + "/plans" : "/api/cores/" + encodeURIComponent(coreId) + "/plan/correct";
        submit(path, btn, { topDepth: read("topDepth"), bottomDepth: read("bottomDepth"), azimuth: read("azimuth"), dip: read("dip"), sampleLength: read("sampleLength") });
      });
      coresEl.querySelectorAll("[data-slice-btn]").forEach(btn => btn.onclick = () => {
        const planId = btn.dataset.sliceBtn;
        const read = f => document.querySelector('[data-s="' + f + "|" + planId + '"]').value;
        submit("/api/plans/" + encodeURIComponent(planId) + "/slices", btn, { offset: read("offset"), length: read("length"), direction: read("direction") });
      });
      coresEl.querySelectorAll("[data-deliver]").forEach(btn => btn.onclick = () => {
        submit("/api/plans/" + encodeURIComponent(btn.dataset.deliver) + "/deliver", btn, {});
      });
    }

    async function load() {
      const result = await api("/api/state");
      state = result.data;
      render();
    }

    coreForm.onsubmit = async event => {
      event.preventDefault();
      const btn = coreForm.querySelector("button");
      await submit("/api/cores", btn, Object.fromEntries(new FormData(coreForm).entries()));
      coreForm.reset();
    };
    document.querySelector("#reload").onclick = load;
    load();
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(page);
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      return sendJson(res, 200, rules.buildState(await store.getDb()));
    }
    if (req.method === "POST" && url.pathname === "/api/cores") {
      const input = await payload(req);
      const result = await store.transact(idemKey(req, url.pathname, input), db => {
        const decision = rules.decideAddCore(db, input);
        if (!decision.ok) return { status: decision.status, body: { error: "core_rejected", reasons: decision.reasons } };
        decision.apply(db);
        return { status: 201, body: decision.core };
      });
      return sendResult(res, result);
    }
    const planMatch = url.pathname.match(/^\/api\/cores\/([^/]+)\/plans$/);
    if (planMatch && req.method === "POST") {
      const input = await payload(req);
      const result = await store.transact(idemKey(req, url.pathname, input), db => {
        const decision = rules.decideSubmitPlan(db, decodeURIComponent(planMatch[1]), input);
        if (!decision.ok) return { status: decision.status, body: { error: "plan_rejected", reasons: decision.reasons } };
        decision.apply(db);
        return { status: 201, body: decision.plan };
      });
      return sendResult(res, result);
    }
    const correctMatch = url.pathname.match(/^\/api\/cores\/([^/]+)\/plan\/correct$/);
    if (correctMatch && req.method === "POST") {
      const input = await payload(req);
      const result = await store.transact(idemKey(req, url.pathname, input), db => {
        const decision = rules.decideCorrectPlan(db, decodeURIComponent(correctMatch[1]), input);
        if (!decision.ok) return { status: decision.status, body: { error: "correction_rejected", reasons: decision.reasons } };
        decision.apply(db);
        return { status: 201, body: decision.plan };
      });
      return sendResult(res, result);
    }
    const sliceMatch = url.pathname.match(/^\/api\/plans\/([^/]+)\/slices$/);
    if (sliceMatch && req.method === "POST") {
      const input = await payload(req);
      const result = await store.transact(idemKey(req, url.pathname, input), db => {
        const decision = rules.decideAddSlice(db, decodeURIComponent(sliceMatch[1]), input);
        if (!decision.ok) return { status: decision.status, body: { error: "slice_rejected", reasons: decision.reasons } };
        decision.apply(db);
        return { status: 201, body: decision.slice };
      });
      return sendResult(res, result);
    }
    const deliverMatch = url.pathname.match(/^\/api\/plans\/([^/]+)\/deliver$/);
    if (deliverMatch && req.method === "POST") {
      const input = await payload(req);
      const result = await store.transact(idemKey(req, url.pathname, input), db => {
        const decision = rules.decideDeliver(db, decodeURIComponent(deliverMatch[1]));
        if (!decision.ok) return { status: decision.status, body: { error: "deliver_rejected", reasons: decision.reasons } };
        decision.apply(db);
        return { status: 201, body: decision.delivery };
      });
      return sendResult(res, result);
    }
    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message });
  }
});

server.listen(port, () => console.log(`Directional sampling console listening on http://localhost:${port}`));
