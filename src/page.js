// 页面承载：仅负责表单提交与结果展示，三个页签对应
// 请求入口（提交动作）、判定规则（规则说明与拒绝原因）、记录存储（方案/切片/留档）。
export const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>定向取样与剩余长度核销台</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#242822; --muted:#687062; --line:#d7ddd1; --accent:#526f43; --warn:#a85b1f; --bad:#9c3b32; --good:#3f6b46; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:20px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:16px; }
    h1 { margin:0; font-size:23px; } .meta { color:var(--muted); font-size:13px; }
    nav { display:flex; gap:8px; padding:14px 28px 0; } nav button { background:#e4e8df; color:var(--ink); } nav button.on { background:var(--accent); color:#fff; }
    main { padding:18px 28px 28px; }
    form,.panel,.card,.stat,.rule { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; }
    h2 { margin:0 0 12px; font-size:17px; } h3 { margin:0 0 6px; font-size:15px; }
    label { display:block; margin:9px 0 4px; color:var(--muted); font-size:12px; }
    input,select { width:100%; border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; background:#fff; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:9px 14px; font-weight:700; cursor:pointer; font-size:13px; }
    button.ghost { background:#e4e8df; color:var(--ink); } button.mini { padding:5px 9px; font-size:12px; }
    .stats { display:grid; grid-template-columns:repeat(5,1fr); gap:10px; margin-bottom:16px; }
    .stat strong { display:block; font-size:21px; margin-top:2px; } .stat span { color:var(--muted); font-size:12px; }
    .cols { display:grid; grid-template-columns:380px 1fr; gap:16px; align-items:start; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(360px,1fr)); gap:12px; }
    .card { display:grid; gap:8px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:2px 9px; font-size:12px; }
    .pill.ok { background:#e7f0e4; color:var(--good); border-color:#bcd2b6; }
    .pill.retest { background:#f6e7d6; color:var(--warn); border-color:#e0bf9b; }
    .pill.off { background:#ececea; color:var(--muted); }
    .bar { height:8px; border-radius:4px; background:#e4e8df; overflow:hidden; } .bar i { display:block; height:100%; background:var(--accent); }
    .slice { border-top:1px solid var(--line); padding:9px 0; display:grid; gap:5px; }
    .slice .meta, .card .meta { font-size:12px; }
    .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
    .alert { border-radius:6px; padding:10px 12px; font-size:13px; margin-bottom:12px; display:none; }
    .alert.bad { display:block; background:#f7e5e2; border:1px solid #ddb4ae; color:var(--bad); }
    .alert.good { display:block; background:#e7f0e4; border:1px solid #bcd2b6; color:var(--good); }
    .alert ul { margin:6px 0 0; padding-left:18px; }
    .rule { margin-bottom:10px; } .rule code { background:#eef1ea; border-radius:4px; padding:1px 5px; }
    .hist { background:#f7f8f5; border:1px dashed var(--line); border-radius:6px; padding:8px 10px; font-size:12px; color:var(--muted); margin-top:6px; }
    .muted { color:var(--muted); }
    @media (max-width:980px){ .cols{grid-template-columns:1fr;} .stats{grid-template-columns:1fr 1fr;} header{display:block;} }
  </style>
</head>
<body>
  <header>
    <div><h1>定向取样与剩余长度核销台</h1><div class="meta">请求入口 · 判定规则 · 记录存储 分层承载；每根岩芯同时仅一份有效方案</div></div>
    <button id="reload">刷加重载</button>
  </header>
  <nav>
    <button data-tab="entry" class="on">请求入口</button>
    <button data-tab="rules">判定规则</button>
    <button data-tab="store">记录存储</button>
  </nav>
  <main>
    <div id="alert"></div>
    <div class="stats" id="stats"></div>

    <section data-panel="entry">
      <div class="cols">
        <form id="planForm" class="panel">
          <h2>登记 / 更正定向取样方案</h2>
          <input type="hidden" name="planId" value="">
          <div class="row"><label style="flex:1">岩芯编号<input name="coreId" required placeholder="CORE-002"></label>
          <label style="flex:1">钻孔编号<input name="borehole" required placeholder="ZK-17"></label>
          <label style="flex:1">岩芯箱号<input name="coreBox" required placeholder="BX-09"></label></div>
          <div class="row"><label style="flex:1">顶深 m<input name="topDepth" type="number" step="0.01" required></label>
          <label style="flex:1">底深 m<input name="bottomDepth" type="number" step="0.01" required></label></div>
          <div class="row"><label style="flex:1">方位角 °<input name="azimuth" type="number" step="0.1" required placeholder="0–360"></label>
          <label style="flex:1">倾角 °<input name="dip" type="number" step="0.1" required placeholder="0–10"></label>
          <label style="flex:1">取样长度 m<input name="sampleLength" type="number" step="0.01" required></label></div>
          <label>负责人<input name="owner" placeholder="选填"></label>
          <div class="row" style="margin-top:10px"><button id="planSubmit">登记方案</button><button type="button" class="ghost" id="planReset">清空表单</button></div>
          <div class="meta" style="margin-top:8px">更正时旧版自动留档，关联切片按新位置重算，已交付立即失效。</div>
        </form>
        <form id="sliceForm" class="panel">
          <h2>登记切片（引用方案 + 相对位置）</h2>
          <label>所属有效方案<select name="planId" required></select></label>
          <div class="row"><label style="flex:1">切片编号<input name="sliceId" required placeholder="SL-002-B"></label>
          <label style="flex:1">相对位置 m（沿取样方位，可为负）<input name="offset" type="number" step="0.01" required></label>
          <label style="flex:1">切片长度 m<input name="length" type="number" step="0.01" required></label></div>
          <div class="row" style="margin-top:10px"><button>提交切片</button></div>
          <div class="meta" style="margin-top:8px">超出剩余长度或方向反转不拒收，状态转「待复测」且不核销长度；重复或并发提交沿用首次结果。</div>
        </form>
      </div>
    </section>

    <section data-panel="rules" style="display:none">
      <div class="panel">
        <h2>整单拒绝（任一违例不写入任何记录）</h2>
        <div class="rule">① 区间越界：<code>顶深 ≥ 0</code>、<code>底深 &gt; 顶深</code>、<code>0 &lt; 取样长度 ≤ 底深−顶深</code>。</div>
        <div class="rule">② 方位缺失：方位角必填，且落在 <code>0–360°</code>。</div>
        <div class="rule">③ 倾角不合法：必须落在 <code>0–10°</code>（含端点）。</div>
        <div class="rule">④ 同孔同箱重叠：与同钻孔、同岩芯箱内任何有效方案的深度区间严格重叠（端点相接允许）。</div>
        <div class="rule">⑤ 一根岩芯同时仅一份有效方案：相同岩芯编号再次登记将被拒绝，需对原方案「更正」。</div>
        <h2 style="margin-top:18px">切片判定</h2>
        <div class="rule">切片必须引用有效方案并给出相对位置；<code>相对位置 &lt; 0</code> 判为方向反转，<code>切片长度 &gt; 剩余长度</code> 判为超出剩余长度——两种情形只转「待复测」，不占用核销长度。</div>
        <h2 style="margin-top:18px">方案更正与失效</h2>
        <div class="rule">更正产生新版本：旧版留档但不计统计；关联切片全部按新参数重新判定，既有交付立即失效；新核销结果以新版本为准。</div>
        <h2 style="margin-top:18px">并发与一致性</h2>
        <div class="rule">写请求在存储层串行执行（校验+落盘为一个原子段）；相同 <code>Idempotency-Key</code> 或相同请求体的重复/并发提交沿用首次结果；列表、剩余长度与重载后状态一致。</div>
      </div>
    </section>

    <section data-panel="store" style="display:none">
      <div class="grid" id="plans"></div>
    </section>
  </main>
  <script>
    const $ = s => document.querySelector(s);
    const $$ = s => [...document.querySelectorAll(s)];
    let state = { plans: [], stats: {} };

    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } } : options);
      const data = await res.json();
      if (!res.ok) {
        const e = new Error(data.error || "请求失败");
        e.payload = data;
        throw e;
      }
      return { data, replay: res.headers.get("Idempotent-Replay") };
    }

    function alertBox(kind, title, items) {
      const el = $("#alert");
      el.className = "alert " + kind;
      el.innerHTML = "<b>" + title + "</b>" + (items && items.length ? "<ul>" + items.map(i => "<li>" + i + "</li>").join("") + "</ul>" : "");
      setTimeout(() => { el.className = "alert"; }, kind === "good" ? 3500 : 9000);
    }

    function renderStats() {
      const s = state.stats;
      const cards = [
        ["有效方案", s.activePlans],
        ["已核销切片", s.validSlices],
        ["待复测切片", s.retestSlices],
        ["有效交付", s.activeDeliveries],
        ["剩余长度合计 m", s.remainingLengthTotal],
      ];
      $("#stats").innerHTML = cards.map(([k, v]) => '<div class="stat"><span>' + k + '</span><strong>' + (v ?? 0) + '</strong></div>').join("");
    }

    function renderSliceOptions() {
      const sel = $('#sliceForm select[name="planId"]');
      sel.innerHTML = state.plans.map(p => '<option value="' + p.id + '">' + p.coreId + " · " + p.borehole + "/" + p.coreBox + " · " + p.topDepth + "-" + p.bottomDepth + "m · 剩 " + p.remainingLength + "m</option>").join("");
    }

    function renderPlans() {
      $("#plans").innerHTML = state.plans.map(p => {
        const pct = p.sampleLength ? Math.min(100, Math.round(p.usedLength / p.sampleLength * 100)) : 0;
        return '<article class="card" data-plan="' + p.id + '">'
          + '<div class="row" style="justify-content:space-between"><h3>' + p.coreId + ' <span class="meta">v' + p.version + '</span></h3>'
          + '<span class="pill ok">有效方案</span></div>'
          + '<div class="meta">' + p.borehole + " · " + p.coreBox + " · " + p.owner + "</div>"
          + '<div class="meta">深度区间 ' + p.topDepth + "–" + p.bottomDepth + "m ｜ 方位 " + p.azimuth + "° ｜ 倾角 " + p.dip + "° ｜ 取样长度 " + p.sampleLength + "m</div>"
          + '<div class="bar" title="已核销 ' + p.usedLength + 'm"><i style="width:' + pct + '%"></i></div>'
          + '<div class="meta">已核销 <b>' + p.usedLength + '</b>m ｜ 剩余 <b>' + p.remainingLength + '</b>m ｜ 切片 ' + p.validSliceCount + " 核销 / " + p.retestCount + " 待复测</div>"
          + '<div class="row"><button class="mini" data-correct="' + p.id + '">更正方案</button><button class="mini ghost" data-toggle="' + p.id + '">切片与留档</button></div>'
          + '<div data-detail="' + p.id + '" style="display:none"></div>'
          + "</article>";
      }).join("");
      $$("[data-correct]").forEach(btn => btn.onclick = () => fillCorrect(btn.dataset.correct));
      $$("[data-toggle]").forEach(btn => btn.onclick = async () => {
        const box = document.querySelector('[data-detail="' + btn.dataset.toggle + '"]');
        if (box.style.display === "none") { await loadDetail(btn.dataset.toggle, box); box.style.display = "block"; }
        else box.style.display = "none";
      });
    }

    async function loadDetail(planId, box) {
      const { data: plan } = await api("/api/plans/" + planId);
      const slices = plan.slices.map(s =>
        '<div class="slice"><div class="row" style="justify-content:space-between"><b>' + s.id + '</b>'
        + (s.status === "已核销" ? '<span class="pill ok">已核销</span>' : '<span class="pill retest">待复测</span>') + '</div>'
        + '<div class="meta">相对位置 ' + s.offset + "m（绝对 " + (plan.topDepth + s.offset).toFixed(3) + "m）｜ 长度 " + s.length + "m ｜ 方案 v" + s.planVersion
        + (s.reason ? " ｜ <span style=color:var(--warn)>" + s.reason + "</span>" : "") + '</div>'
        + '<div class="meta">' + (s.delivered ? '<span class="pill ok">已交付 ' + s.deliveryId + '</span>' : (s.status === "已核销" ? '<button class="mini" data-deliver="' + s.id + '">核销交付</button>' : '<span class="pill off">待复测不可交付</span>')) + '</div></div>'
      ).join("") || '<div class="meta">尚无切片</div>';
      const history = plan.history.map(h =>
        '<div class="hist">留档 v' + h.version + "（" + h.archivedAt + "）：" + h.topDepth + "–" + h.bottomDepth + "m ｜ 方位 " + h.azimuth + "° ｜ 倾角 " + h.dip + "° ｜ 取样长度 " + h.sampleLength + "m —— 不计统计</div>"
      ).join("");
      const staleDeliveries = plan.deliveries.filter(d => !d.valid).map(d => '<div class="hist">交付 ' + d.id + "（方案 v" + d.planVersion + "，" + d.at + "）已随方案更正失效，留档不计统计</div>").join("");
      box.innerHTML = slices + (history || staleDeliveries ? '<h3 style="margin-top:10px">版本与交付留档</h3>' + history + staleDeliveries : "");
      $$("[data-deliver]").forEach(b => b.onclick = async () => {
        try { await api("/api/slices/" + b.dataset.deliver + "/deliver", { method: "POST", body: "{}" }); alertBox("good", "交付成功（重复提交沿用首次结果）"); await load(); await loadDetail(planId, box); }
        catch (e) { alertBox("bad", "交付被拒绝", [e.message]); }
      });
    }

    function fillCorrect(planId) {
      const p = state.plans.find(x => x.id === planId);
      const f = $("#planForm");
      Object.entries({ planId: p.id, coreId: p.coreId, borehole: p.borehole, coreBox: p.coreBox, topDepth: p.topDepth, bottomDepth: p.bottomDepth, azimuth: p.azimuth, dip: p.dip, sampleLength: p.sampleLength, owner: p.owner || "" }).forEach(([k, v]) => f[k].value = v);
      $("#planSubmit").textContent = "提交更正（v" + p.version + " → v" + (p.version + 1) + "）";
      switchTab("entry");
      alertBox("good", "已带入方案 " + p.id + " 的当前值，修改后提交更正");
    }

    async function load() {
      const { data } = await api("/api/plans");
      state = data;
      renderStats(); renderSliceOptions(); renderPlans();
    }

    function switchTab(tab) {
      $$("[data-tab]").forEach(b => b.classList.toggle("on", b.dataset.tab === tab));
      $$("[data-panel]").forEach(p => p.style.display = p.dataset.panel === tab ? "" : "none");
    }
    $$("[data-tab]").forEach(b => b.onclick = () => switchTab(b.dataset.tab));
    $("#reload").onclick = () => load().then(() => alertBox("good", "已从记录存储重载，列表与剩余长度一致"));

    $("#planReset").onclick = () => { $("#planForm").reset(); $('#planForm [name="planId"]').value = ""; $("#planSubmit").textContent = "登记方案"; };
    $("#planForm").onsubmit = async ev => {
      ev.preventDefault();
      const f = ev.target;
      const payload = Object.fromEntries(new FormData(f).entries());
      const planId = payload.planId;
      delete payload.planId;
      const path = planId ? "/api/plans/" + encodeURIComponent(planId) + "/correct" : "/api/plans";
      try {
        const { replay } = await api(path, { method: "POST", body: JSON.stringify(payload) });
        alertBox("good", replay ? "重复/并发提交：沿用首次结果" : (planId ? "方案已更正，关联切片已按新位置重算，旧交付失效" : "方案登记成功"));
        f.reset(); $("#planSubmit").textContent = "登记方案"; await load();
      } catch (e) {
        const msgs = e.payload && e.payload.details ? e.payload.details.map(d => d.message || d.code) : [e.message];
        alertBox("bad", "整单拒绝，未写入任何记录", msgs);
      }
    };
    $("#sliceForm").onsubmit = async ev => {
      ev.preventDefault();
      const fd = new FormData(ev.target);
      const payload = { planId: fd.get("planId"), id: fd.get("sliceId"), offset: fd.get("offset"), length: fd.get("length") };
      try {
        const { data, replay } = await api("/api/slices", { method: "POST", body: JSON.stringify(payload) });
        const st = data.slice.status === "已核销" ? "切片核销成功" : "切片转待复测：" + data.slice.reason;
        alertBox(data.slice.status === "已核销" ? "good" : "bad", replay ? "重复/并发提交：沿用首次结果（" + st + "）" : st);
        ev.target.reset(); await load();
      } catch (e) {
        const msgs = e.payload && e.payload.details ? e.payload.details.map(d => d.message || d.code) : [e.message];
        alertBox("bad", "切片登记被拒绝", msgs);
      }
    };

    load();
  </script>
</body>
</html>`;
