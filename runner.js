/* =========================================================
   runner.js —— 待发布批次自动上线服务
   ---------------------------------------------------------
   做什么：
     1. 定时从 Supabase Storage（bucket=assets）拉 data/vials.json
        —— 教师端「导出发布包」会把批次自动存到这里，无需人工搬运
     2. 用 pack-share.js 重新打包整批（密钥瓶 Base64）
     3. 提交 index.html 到 GitHub Pages（Contents API）
     4. 回写 data/vials.json 的发布状态（已上线 / 条目索引）

   环境变量（写在 runner.env 或系统环境）：
     SUPABASE_URL / SUPABASE_ANON_KEY      默认读 index.html 内嵌配置
     GITHUB_TOKEN                          有 contents:write 权限的 PAT
     GITHUB_REPO                           默认 duozhid/vocab-quiz
     GITHUB_BRANCH                         默认 main
     POLL_SECONDS                          默认 60
   ========================================================= */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const ROOT = __dirname;
const VIAL_JSON = path.join(ROOT, "data", "vials.json");
const STATE = path.join(ROOT, "data", "runner-state.json");
const CFG = {
  supabaseUrl: process.env.SUPABASE_URL || "",
  supabaseKey: process.env.SUPABASE_ANON_KEY || "",
  token: process.env.GITHUB_TOKEN || "",
  repo: process.env.GITHUB_REPO || "duozhid/vocab-quiz",
  branch: process.env.GITHUB_BRANCH || "main",
  poll: Number(process.env.POLL_SECONDS || 60),
  bucket: "assets",
  object: "data/vials.json"
};

function log(...a) {
  console.log(new Date().toISOString().slice(11, 19), ...a);
}

/* 配置缺省时从 index.html 的 cloud-config 里抠 */
function fillFromHtml() {
  try {
    const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
    const m = html.match(/id="cloud-config"[^>]*>([\s\S]*?)<\/script>/);
    if (m) {
      const cfg = JSON.parse(m[1]);
      CFG.supabaseUrl = CFG.supabaseUrl || cfg.url || "";
      CFG.supabaseKey = CFG.supabaseKey || cfg.anonKey || "";
    }
  } catch { /* 忽略 */ }
}

const objectUrl = () =>
  `${CFG.supabaseUrl}/storage/v1/object/public/${CFG.bucket}/${CFG.object}`;

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, "utf8")); }
  catch { return { etag: "", lastPubAt: 0 }; }
}
function writeState(s) { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); }

/* 拉批次：先 HEAD 比对 ETag，没变化直接跳过；再用下载链接取内容 */
async function fetchBatch(state) {
  const url = objectUrl() + "?t=" + Date.now();
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  const etag = crypto.createHash("sha1").update(buf).digest("hex");
  if (etag === state.etag) return null;             // 批次没变，不用重打包
  let doc;
  try { doc = JSON.parse(buf.toString("utf8")); } catch { return null; }
  if (!doc || !Array.isArray(doc.quizzes) || !doc.quizzes.length) return null;
  // 完整卷必须带题目；只有回写清单的空壳批次直接无视
  const usable = doc.quizzes.filter(q => Array.isArray(q.q) ? q.q.length : (Array.isArray(q.questions) && q.questions.length));
  if (!usable.length) {
    log("批次里没有带题目的试卷，跳过（等教师端导出完整发布包）");
    return { etag, empty: true };
  }
  return { etag, doc, usable: usable.length, total: doc.quizzes.length };
}

async function putGithub(filePath, content) {
  const api = `https://api.github.com/repos/${CFG.repo}/contents/${encodeURIComponent(filePath)}?ref=${CFG.branch}`;
  const h = {
    Authorization: `Bearer ${CFG.token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "vial-runner"
  };
  const head = await fetch(api, { headers: h });
  let sha = "";
  if (head.ok) { const j = await head.json(); sha = j.sha || ""; }
  const body = {
    message: `auto: publish vial batch ${new Date().toISOString()}`,
    content: Buffer.from(content).toString("base64"),
    branch: CFG.branch
  };
  if (sha) body.sha = sha;
  const put = await fetch(`https://api.github.com/repos/${CFG.repo}/contents/${encodeURIComponent(filePath)}`, {
    method: "PUT",
    headers: { ...h, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!put.ok) throw new Error(`GitHub ${put.status} ${(await put.text()).slice(0, 160)}`);
}

async function uploadStatus(doc) {
  if (!CFG.supabaseUrl || !CFG.supabaseKey) return;
  try {
    await fetch(`${CFG.supabaseUrl}/storage/v1/object/${CFG.bucket}/${CFG.object}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CFG.supabaseKey}`,
        "Content-Type": "application/json",
        "x-upsert": "true",
        "cache-control": "no-store"
      },
      body: JSON.stringify(doc)
    });
  } catch (e) { log("回写状态失败（不影响上线）:", e.message); }
}

async function tick() {
  const state = readState();
  const got = await fetchBatch(state);
  if (!got) return;
  if (got.empty) { writeState({ ...state, etag: got.etag }); return; }

  const doc = got.doc;
  // 只把带题目的条目写进打包输入，避免空壳覆盖掉已有内容
  const list = doc.quizzes.filter(q => Array.isArray(q.q) ? q.q.length : (Array.isArray(q.questions) && q.questions.length));

  /* 双保险：与上一次已发布的批次合并，防止一条只含新卷的批次把老卷冲掉。
     前端也会合并，这里是兜底——旧链接一旦丢失无法恢复。 */
  let prev = [];
  try {
    const back = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "vials-full.json"), "utf8"));
    prev = Array.isArray(back.quizzes) ? back.quizzes : [];
  } catch { /* 首次运行没有历史 */ }
  if (prev.length) {
    const merged = prev.map(q => ({ ...q }));
    list.forEach(q => {
      const code = String(q.c || q.code || "");
      const i = merged.findIndex(x => String(x.c || x.code || "") === code);
      if (i >= 0) merged[i] = q; else merged.push(q);
    });
    if (merged.length !== list.length) log(`合并历史批次：已发布 ${prev.length} + 本次 ${list.length} → ${merged.length}`);
    list.length = 0; list.push(...merged);
  }
  // 密钥优先级：已发布批次的密钥 > 前端带来的 > 默认值。换密钥会让旧短链全废，所以历史优先。
  const norm = s => String(s || "").replace(/[^0-9a-f]/gi, "").toLowerCase().slice(0, 13);
  const pw = (state.pw && state.pw.length === 13) ? state.pw
    : (norm(doc.pw).length === 13 ? norm(doc.pw) : "0123456789abc");
  const input = { pw, quizzes: list };
  if (state.pw && state.pw !== input.pw) {
    log("批次密钥变化，沿用历史密钥", state.pw);
    input.pw = state.pw;
  }
  fs.writeFileSync(VIAL_JSON, JSON.stringify(input, null, 2));

  const out = execFileSync(process.execPath, [path.join(ROOT, "pack-share.js")], {
    cwd: ROOT, encoding: "utf8"
  });
  if (/ERROR|自检失败/.test(out)) { log("打包失败:\n" + out.slice(-400)); return; }

  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  await putGithub("index.html", html);

  const after = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "vials-full.json"), "utf8"));
  const pub = {
    ...doc,
    publishedAt: Date.now(),
    count: after.quizzes.length,
    quizzes: after.quizzes
  };

  /* 关键：等 GitHub Pages 真的换上新密文，再告诉前端「已上线」。
     否则前端轮询到的还是旧页面，会一直卡在等待态。 */
  const wantLen = (html.match(/id="vial-data">([^<]*)<\/script>/) || [, ""])[1].length;
  let live = false;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 6000));
    try {
      const r = await fetch(`https://duozhid.github.io/vocab-quiz/index.html?cb=${Date.now()}`, { cache: "no-store" });
      const txt = await r.text();
      const got = (txt.match(/id="vial-data">([^<]*)<\/script>/) || [, ""])[1].length;
      if (got === wantLen) { live = true; log(`线上已生效（第 ${(i + 1) * 6}s）`); break; }
    } catch { /* 继续等 */ }
  }
  if (!live) log("等待线上生效超时，仍写入发布状态（前端下次轮询会自愈）");

  await uploadStatus(pub);
  writeState({ etag: got.etag, lastPubAt: Date.now(), pw: input.pw, count: after.quizzes.length });
  log(`已上线 ${after.quizzes.length} 份试卷（批次 ${got.total} 条，其中 ${got.usable} 条带题）`);
}

(async function main() {
  fillFromHtml();
  if (!CFG.token) { console.error("缺少 GITHUB_TOKEN"); process.exit(2); }
  if (!CFG.supabaseUrl) { console.error("缺少 SUPABASE_URL"); process.exit(2); }
  log(`runner 启动：repo=${CFG.repo} 轮询=${CFG.poll}s`);
  while (true) {
    try { await tick(); } catch (e) { log("本轮异常:", e.message); }
    await new Promise(r => setTimeout(r, CFG.poll * 1000));
  }
})();
