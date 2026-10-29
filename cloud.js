/* =========================================================
   cloud.js —— 成绩云端同步（Supabase REST，无 SDK 依赖）
   ---------------------------------------------------------
   目标：学生交卷后成绩自动上云，教师端自动可见，不再需要
   生成成绩码 / 二维码回传。

   设计要点：
   1. 只用一个表 gk_scores，行内是扁平字段，便于教师端直接查。
   2. 学生端用 anon key 仅 INSERT（RLS 限制），无法读取他人成绩。
   3. 教师端读取走 RPC 函数 teacher_scores(口令)，口令校验在数据库里
      完成 —— anon key 直接 SELECT 表会被 RLS 拒绝，全班成绩不会
      因为前端代码公开而泄露。
   4. 未配置 / 网络失败时自动降级为本地存储，不影响答题与报告。

   配置：在 index.html 的 <script id="cloud-config"> 里填
        url / anonKey / teacherCode（与建表 SQL 里的口令一致）。
   ========================================================= */
window.Cloud = (() => {
  "use strict";

  function readConfig() {
    const el = document.getElementById("cloud-config");
    if (!el) return null;
    try {
      const c = JSON.parse(el.textContent || "{}");
      if (!c.url || !c.anonKey) return null;
      if (/YOUR_|填你的|xxx/i.test(c.url + c.anonKey)) return null;
      return {
        url: String(c.url).replace(/\/+$/, ""),
        anonKey: String(c.anonKey).trim(),
        teacherCode: String(c.teacherCode || "")
      };
    } catch (e) { return null; }
  }
  const cfg = readConfig();
  const enabled = !!cfg;

  function headers(extra) {
    return Object.assign({
      "apikey": cfg.anonKey,
      "Authorization": "Bearer " + cfg.anonKey,
      "Content-Type": "application/json"
    }, extra || {});
  }

  /* 把 Supabase 的错误统一压成一句人话 */
  function brief(status, text) {
    let msg = "";
    try { msg = (JSON.parse(text) || {}).message || ""; } catch (e) { msg = text || ""; }
    msg = String(msg).slice(0, 160);
    if (status === 0) return "网络不可用";
    if (status === 401 || status === 403) return `没权限（HTTP ${status}）：请检查 anon key 与数据库策略`;
    if (status === 404) return `表 gk_scores 或函数 teacher_scores 不存在（HTTP 404）：请先执行建表 SQL`;
    if (/relation .* does not exist/i.test(msg)) return "表 gk_scores 不存在：请先执行建表 SQL";
    if (/function .* does not exist/i.test(msg)) return "函数 teacher_scores 不存在：请先执行建表 SQL";
    if (/invalid api key/i.test(msg)) return "anon key 无效：请核对 cloud-config 里的 anonKey";
    return `HTTP ${status}${msg ? " " + msg : ""}`;
  }

  /* 网络层异常统一翻译（浏览器原生报错是英文的） */
  function netErr(e) {
    const m = String((e && e.message) || e || "");
    if (/failed to fetch|networkerror|load failed|err_connection/i.test(m)) {
      return "连不上云端（网络中断，或 Supabase 项目已暂停 —— 免费版 7 天无访问会自动暂停，去控制台点 Restore 即可）";
    }
    return m || "网络错误";
  }

  /* 学生端：上传一条成绩。失败不抛异常，返回 {ok:false, error} */
  async function pushScore(rec) {
    if (!enabled) return { ok: false, error: "云端未配置" };
    const row = {
      quiz_code: String(rec.code || "").toUpperCase().slice(0, 12) || "UNKNOWN",
      quiz_name: String(rec.quizName || "").slice(0, 120),
      student_name: String(rec.studentName || "匿名学生").slice(0, 24),
      score: Math.max(0, Math.min(100, Math.round(rec.score || 0))),
      correct: Math.max(0, rec.correct || 0),
      total: Math.max(0, rec.total || 0),
      seconds: Math.max(0, Math.round(rec.seconds || 0)),
      wrong_words: (rec.wrongWords || []).slice(0, 60).map(w => ({ w: w.w, m: w.m, p: w.p })),
      device: (navigator.userAgent || "").slice(0, 200),
      client_at: new Date().toISOString()
    };
    try {
      const res = await fetch(`${cfg.url}/rest/v1/gk_scores`, {
        method: "POST",
        headers: headers({ "Prefer": "return=minimal" }),
        body: JSON.stringify(row)
      });
      if (!res.ok) return { ok: false, error: brief(res.status, await res.text()) };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: netErr(e) };
    }
  }

  /* 教师端：通过 RPC 拉取成绩。code 为空则拉全部（最多 1000 条）
     口令错误时数据库端直接返回空集合，前端提示「口令不对」 */
  async function pullScores(code) {
    if (!enabled) return { ok: false, error: "云端未配置", rows: [] };
    try {
      const res = await fetch(`${cfg.url}/rest/v1/rpc/teacher_scores`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          p_pass: cfg.teacherCode || "",
          p_code: code ? String(code).toUpperCase() : null,
          p_limit: 1000
        })
      });
      if (!res.ok) return { ok: false, error: brief(res.status, await res.text()), rows: [] };
      const rows = await res.json();
      return { ok: true, rows: Array.isArray(rows) ? rows : [] };
    } catch (e) {
      return { ok: false, error: netErr(e), rows: [] };
    }
  }

  /* 连通性自检：走 RPC，能区分「表没建」「口令不对」「key 不对」 */
  async function ping() {
    if (!enabled) return { ok: false, error: "云端未配置" };
    try {
      const res = await fetch(`${cfg.url}/rest/v1/rpc/teacher_scores`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ p_pass: cfg.teacherCode || "", p_code: null, p_limit: 1 })
      });
      if (!res.ok) return { ok: false, error: brief(res.status, await res.text()) };
      const rows = await res.json();
      return { ok: true, sample: Array.isArray(rows) ? rows.length : 0 };
    } catch (e) {
      return { ok: false, error: netErr(e) };
    }
  }

  /* 上传二进制文件（PDF 等）到 worksheets 桶，返回公开直链。
     微信内置浏览器不能下载 blob: 链接，但可以下载 http 直链的 pdf/doc，
     所以手机端走「先上传、再让微信按原生方式下载」。 */
  async function uploadFile(fileName, blobOrText, mime) {
    if (!enabled) return { ok: false, error: "云端未配置" };
    const safe = String(fileName || "")
      .replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
    const ext = /\.pdf$/i.test(String(fileName)) ? ".pdf"
      : /\.doc$/i.test(String(fileName)) ? ".doc" : ".html";
    const path = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${safe ? "-" + safe : ""}${ext}`;
    try {
      const res = await fetch(`${cfg.url}/storage/v1/object/worksheets/${path}`, {
        method: "POST",
        headers: {
          "apikey": cfg.anonKey,
          "Authorization": "Bearer " + cfg.anonKey,
          "Content-Type": mime || "application/octet-stream",
          "cache-control": "3600"
        },
        body: blobOrText
      });
      if (!res.ok) return { ok: false, error: brief(res.status, await res.text()) };
      const name = `${safe || "worksheet"}${ext}`;
      return {
        ok: true,
        url: `${cfg.url}/storage/v1/object/public/worksheets/${path}`,
        dlUrl: `${cfg.url}/storage/v1/object/public/worksheets/${path}?download=${encodeURIComponent(name)}`,
        name: `${String(fileName || "练习").replace(/\.pdf$/i, "")}.pdf`
      };
    } catch (e) {
      return { ok: false, error: netErr(e) };
    }
  }

  /* 把巩固练习上传到云存储，返回公开链接（微信内转发/保存用）。
     走公开密钥 + 存储桶 worksheets 的 anon INSERT 策略。
     注意：Supabase Storage 的 key 只接受 ASCII 安全字符，文件名里的
     中文会被去掉，只保留时间戳+随机段，避免 Invalid key。 */
  async function uploadWorksheet(fileName, html) {
    if (!enabled) return { ok: false, error: "云端未配置" };
    const safe = String(fileName || "").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
    const path = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${safe ? "-" + safe : ""}.html`;
    try {
      const res = await fetch(`${cfg.url}/storage/v1/object/worksheets/${path}`, {
        method: "POST",
        headers: {
          "apikey": cfg.anonKey,
          "Authorization": "Bearer " + cfg.anonKey,
          "Content-Type": "text/html; charset=utf-8",
          "cache-control": "3600"
        },
        body: String(html || "")
      });
      if (!res.ok) return { ok: false, error: brief(res.status, await res.text()) };
      return { ok: true, url: `${cfg.url}/storage/v1/object/public/worksheets/${path}` };
    } catch (e) {
      return { ok: false, error: netErr(e) };
    }
  }

  /* ---------- 发布批次（密钥瓶）中转 ----------
     前端只管把「待发布批次」丢到存储桶，后台 runner 定时取走、
     重打包并提交到 GitHub Pages。bucket=assets，固定键 data/vials.json。 */
  const BATCH_OBJ = "data/vials.json";

  async function uploadBatch(batch) {
    if (!enabled) return { ok: false, error: "云端未配置" };
    try {
      const res = await fetch(`${cfg.url}/storage/v1/object/assets/${BATCH_OBJ}`, {
        method: "POST",
        headers: {
          "apikey": cfg.anonKey,
          "Authorization": "Bearer " + cfg.anonKey,
          "Content-Type": "application/json",
          "x-upsert": "true",
          "cache-control": "no-store"
        },
        body: JSON.stringify(batch)
      });
      if (!res.ok) return { ok: false, error: brief(res.status, await res.text()) };
      return { ok: true };
    } catch (e) { return { ok: false, error: netErr(e) }; }
  }

  async function pullBatch() {
    if (!enabled) return { ok: false, error: "云端未配置" };
    try {
      const res = await fetch(`${cfg.url}/storage/v1/object/public/assets/${BATCH_OBJ}?t=${Date.now()}`, { cache: "no-store" });
      if (res.status === 400 || res.status === 404) return { ok: true, batch: null };
      if (!res.ok) return { ok: false, error: brief(res.status, await res.text()) };
      const txt = await res.text();
      let b = null;
      try { b = JSON.parse(txt); } catch { b = null; }
      return { ok: true, batch: b };
    } catch (e) { return { ok: false, error: netErr(e) }; }
  }

  return { enabled, cfg, pushScore, pullScores, ping, uploadWorksheet, uploadFile, uploadBatch, pullBatch };
})();
