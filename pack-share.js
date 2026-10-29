/* =========================================================
   pack-share.js —— 生成「密钥瓶」分享数据
   ---------------------------------------------------------
   用法：
     node pack-share.js               # 用当前已发布的试卷重新打包
     node pack-share.js --export      # 打包前先从浏览器导出老师已建的测验

   做的事：
     1. 读取 data/vials.json（老师在浏览器里建好的试卷批次）
     2. 用内置 3500 词库把每份试卷重组成紧凑位流
     3. AES-256-GCM 加密，拼成定长记录，整体 Base64 后写进
        index.html 的 <script id="vial-data">
     4. 每个条目同时算出 8 位暗号，写进 data/vials.json 回传

   设计要点：位流里的选项只存 12 位词索引（最多 4095），
   内置库按 stage1（core+mid，约 3000 词）排序后大部分词都能命中；
   命中不了的走「附注区」完整存词+释义。
   ========================================================= */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const DATA_START = 16;   // 头部：1 版本 + 13 密码 + 2 条目数
const VIAL_JSON = path.join(ROOT, "data", "vials.json");

/* ---------------- 词库 ---------------- */
const vocab = JSON.parse(fs.readFileSync(path.join(ROOT, "vocab.json"), "utf8"));
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/* 与前端一致的暗号算法：29 位瓶号 + 2 位填充 + 1 位校验 */
function makeAlias(idx, data) {
  // 32 位拆成「高 16 位 / 低 16 位」两组 Base32，避免位运算截断
  const fill = data & 3;
  const ck = (idx ^ fill ^ Math.floor(idx / 128) ^ Math.floor(idx / 32768)) & 0x0f;
  const v = idx * 64 + fill * 16 + ck;
  const hi = Math.floor(v / 65536), lo = v % 65536;
  const part = x => {
    let s = "", rem = x;
    for (let i = 0; i < 4; i++) {
      s = B32[rem % 32] + s;
      rem = Math.floor(rem / 32);
    }
    return s;
  };
  return part(hi) + part(lo);
}

/* 内置库索引：前 stage1 个词（按 tier 排序后）优先占 12 位内下标 */
function builtinOrder() {
  const TIER_RANK = { core: 0, mid: 1, high: 2 };
  const idx = vocab.map((v, i) => ({ v, i, r: TIER_RANK[v.tier] ?? 2 }));
  idx.sort((a, b) => a.r - b.r);
  return idx.map(x => x.i);            // order[rank] = 原始下标
}

function build() {
  if (!fs.existsSync(VIAL_JSON)) {
    console.error("缺少 data/vials.json —— 先在教师端点「发布试卷到短链接」导出该文件");
    process.exit(2);
  }
  const src = JSON.parse(fs.readFileSync(VIAL_JSON, "utf8"));
  const order = builtinOrder();
  const rankOf = new Map();            // 原始下标 → 位流下标
  order.forEach((orig, rank) => rankOf.set(orig, rank));

  const indexOf = new Map();           // 小写单词 → 位流下标（仅 12 位内）
  order.slice(0, 0xffe).forEach(orig => {
    const w = String(vocab[orig].w || "").toLowerCase();
    if (w && !indexOf.has(w)) indexOf.set(w, rankOf.get(orig));
  });

  const PER_Q_BITS = 1 + 2 + 4 * 12;
  const CODE_ALPHA = "ACDEFGHJKLMNPQRTUVWXY34679";

  // 6 字符 × 5 位 = 30 位，第一个字符占最高位；整体右对齐成 32 位再切 4 字节。
  // 必须与 share.js 的 unpackCode 严格对称：它把 4 字节读成 30 位高对齐整数，
  // 再用 (val >>> (i*5)) & 0x1f 从低位往高位取字符。
  function packCode(codeStr) {
    const s = String(codeStr || "").toUpperCase().slice(0, 6);
    let val = 0;
    for (let i = 0; i < 6; i++) {
      const v = i < s.length ? Math.max(0, CODE_ALPHA.indexOf(s[i])) : 0;
      val = val * 32 + v;
    }
    return { bytes: [(val >>> 24) & 0xff, (val >>> 16) & 0xff, (val >>> 8) & 0xff, val & 0xff], len: s.length };
  }

  function encodeQuiz(quiz) {
    const qs = quiz.q || [];
    // 兼容两种字段命名：前端导出 {code,...}，旧演示数据 {c,...}
    const code = String(quiz.code || quiz.c || "").toUpperCase();
    const out = [];
    let flags = quiz.i !== false ? 1 : 0;
    const pc = packCode(code);
    if (code) flags |= 2;
    out.push(0x40 | flags);
    out.push(Math.max(1, Math.min(255, quiz.minutes || quiz.m || 15)));
    out.push(Math.min(255, qs.length));
    if (code) out.push(...pc.bytes, pc.len);

    const extras = [];
    const bits = [];
    const push = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };

    qs.forEach(q => {
      const ai = Math.max(0, q.options.findIndex(o => o.correct)) & 3;
      push(q.type === "cn2en" ? 1 : 0, 1);
      push(ai, 2);
      q.options.forEach(o => {
        const key = String(o.word).toLowerCase();
        if (indexOf.has(key)) {
          push(indexOf.get(key), 12);     // 命中内置库：12 位下标
        } else {
          // 词库外的词（老师自建词库）：整个词条塞进附注区
          const rec = "W:" + o.word + ":" + (o.meaning || "") + ":" + (o.pos || q.pos || "");
          let k = extras.indexOf(rec);
          if (k < 0) { extras.push(rec); k = extras.length - 1; }
          push(0xfff, 12);
        }
      });
      for (let k = q.options.length; k < 4; k++) push(0xfef, 12);
    });

    // 位流 → 字节（末字节右补 0）
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | (bits[i + j] || 0);
      out.push(b);
    }
    return { bytes: out, extras, maxExtras: 0 };
  }

  /* 试卷清单 */
  const list = Array.isArray(src) ? src : (src.quizzes || []);
  if (!list.length) { console.error("data/vials.json 里没有试卷"); process.exit(2); }

  // 先编码，拿到最大「附注区」规模
  const encoded = list.map(q => encodeQuiz(q));

  /* 加密 */
  // 必须正好 13 字节：头部 [1..13] 是密码位，多一位就会把后面的长度字段挤歪
  let pwHex = String(src.pw || "").replace(/[^0-9a-f]/gi, "");
  while (pwHex.length < 13) pwHex += "0123456789abcdef"[pwHex.length % 16];
  pwHex = pwHex.slice(0, 13);
  const key = crypto.pbkdf2Sync("gk3500-vial|" + pwHex, Buffer.from("gk3500-v1"), 10000, 32, "sha256");
  const AAD = Buffer.from("gkv1");

  const sealed = encoded.map(({ bytes: rawBytes, extras }) => {
    let bytes = rawBytes;
    if (extras.length) {
      const cnt = Buffer.alloc(2);
      cnt.writeUInt16LE(extras.length, 0);
      bytes = bytes.concat([...cnt]);
      extras.forEach(s => {
        const b = Buffer.from(s, "utf8");
        bytes = bytes.concat([b.length], [...b]);
      });
    } else {
      bytes = bytes.concat([0, 0]);
    }
    const plain = Buffer.from(bytes);
    const nonce = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", key, nonce);
    c.setAAD(AAD);
    const body = Buffer.concat([c.update(plain), c.final()]);
    const tag = c.getAuthTag();
    return Buffer.concat([nonce, body, tag]);   // [12B nonce][密文][16B tag]
  });

  const recLen = Math.max(...sealed.map(b => b.length));
  if (recLen > 4000) { console.error("单条记录超过 4000 字节：", recLen); process.exit(2); }

  const head = Buffer.alloc(DATA_START);
  head[0] = 2;                                  // 版本：v2 = 2 字节记录长度
  head.write(pwHex, 1, 'ascii');                // [1..14] 13 位密码
  head.writeUInt16LE(sealed.length, 14);        // [14..16] 条目数（u16）

  // 记录布局：[0..2] len（u16 BE，= 12 nonce + 密文 + 16 tag）| [2..len] 密文 | 补零对齐
  const recs = sealed.map(b => {
    const rec = Buffer.alloc(recLen + 2);
    rec.writeUInt16BE(b.length, 0);
    b.copy(rec, 2);
    return rec;
  });

  const vial = Buffer.concat([head, ...recs]);
  const b64 = vial.toString("base64");

  /* 写回 index.html */
  const htmlPath = path.join(ROOT, "index.html");
  let html = fs.readFileSync(htmlPath, "utf8");
  const re = /<script type="application\/json" id="vial-data">[\s\S]*?<\/script>/;
  const block = `<script type="application/json" id="vial-data">${b64}</script>`;
  if (re.test(html)) html = html.replace(re, block);
  else html = html.replace('<script src="jszip.min.js"></script>', block + '<script src="jszip.min.js"></script>');
  // 顺手让浏览器永远拿最新版静态资源，避免微信内置浏览器缓存旧文件
  const stamp = Date.now().toString(36);
  html = html.replace(/<script src="((?:jszip\.min|docx-parse|store|share|app)\.js)(\?[^"]*)?"/g,
    (m, name) => `<script src="${name}?v=${stamp}"`);
  fs.writeFileSync(htmlPath, html);

  // 自检：立刻把写进去的密文解回来，确保「打包即正确」
  (() => {
    const back = Buffer.from(b64, "base64");
    const recLen0 = Math.floor((back.length - DATA_START) / sealed.length);
    let okAll = true;
    // 与 share.js 的 unpackCode 严格对称：读 p..p+3 共 30 位，len 在 p+4
    const decodeCode = (b, at, len) => {
      let bits = 0;
      for (let i = 0; i < 4; i++) bits = (bits << 8) | b[at + i];
      const shift = 30 - len * 5;
      const val = shift > 0 ? bits >>> shift : bits;
      let s = "";
      for (let i = len - 1; i >= 0; i--) s += "ACDEFGHJKLMNPQRTUVWXY34679"[(val >>> (i * 5)) & 0x1f] || "A";
      return s;
    };
    for (let k = 0; k < sealed.length; k++) {
      const p0 = DATA_START + k * recLen0;
      const len = (back[p0] << 8) | back[p0 + 1];
      const nonce = back.slice(p0 + 2, p0 + 14);
      const body = back.slice(p0 + 14, p0 + 2 + len);
      try {
        const d = crypto.createDecipheriv("aes-256-gcm", key, nonce);
        d.setAAD(AAD);
        d.setAuthTag(body.slice(-16));
        const pt = Buffer.concat([d.update(body.slice(0, -16)), d.final()]);
        if (!pt.length) { okAll = false; continue; }
        // 解出密文里的测验码，必须与写进 vials.json 的一致
        if (pt[0] & 2) {
          const want = String(list[k].code || list[k].c || "").toUpperCase();
          const got = decodeCode(pt, 3, Math.max(1, Math.min(6, pt[3 + 4])));
          if (got !== want) {
            okAll = false;
            console.error(`   自检失败 第 ${k} 条：密文测验码 ${got} ≠ 期望 ${want}`);
          }
        }
      } catch (e) { okAll = false; console.error("   自检失败 第", k, "条：", e.message); }
    }
    console.log(okAll ? "   ✅ 自检：全部条目可正确解密，测验码一致" : "   ❌ 自检失败");
  })();

  /* 回写暗号
     注意：输入文件 data/vials.json 里带着完整卷面（q/questions），
     不能被摘要覆盖——否则下次再打包就没题目了（曾经踩过这个坑）。
     完整卷面另存 vials-full.json 作为长期基线，摘要写 vials-toc.json。 */
  const full = { pw: pwHex, builtAt: Date.now(), quizzes: list };
  fs.writeFileSync(path.join(ROOT, "data", "vials-full.json"), JSON.stringify(full, null, 2));
  const out = {
    pw: pwHex,
    builtAt: Date.now(),
    quizzes: list.map((q, i) => ({
      id: q.id,
      // 与 encodeQuiz 同一套取值逻辑，否则 vials.json 记的码和密文里的码会不一致
      code: String(q.code || q.c || "").toUpperCase(),
      name: String(q.name || q.n || ""),
      alias: makeAlias(i, (i * 40503) % 4),
      bytes: sealed[i].length + 28
    }))
  };
  fs.writeFileSync(path.join(ROOT, "data", "vials-toc.json"), JSON.stringify(out, null, 2));

  console.log(`✅ 已打包 ${list.length} 份试卷`);
  console.log(`   条目长度 ${recLen} 字节（含 28 字节 GCM 开销）`);
  console.log(`   密钥瓶 Base64 ${b64.length} 字符`);
  console.log(`   密码 ${pwHex}`);
  out.quizzes.forEach(q => console.log(`   ${q.alias}  ${q.code}  ${q.name}  (${q.bytes}B)`));
  return out;
}

/* ---------------- 生成示例批次（首次部署 / 演示用） ----------------
   用内置 3500 词库按与前端一致的算法组卷，产出一份可直接使用的
   data/vials.json，让页面开箱就有可用的短链接。 */
function demoVials(count = 4) {
  const TIER_RANK = { core: 0, mid: 1, high: 2 };
  // 与前端 tierOf 一致的近似分层
  const byTier = { core: [], mid: [], high: [] };
  const n = vocab.length;
  vocab.forEach((v, i) => {
    const p = i / n;
    byTier[p < 0.33 ? "core" : p < 0.72 ? "mid" : "high"].push(v);
  });
  const pool = vocab.filter(v => v.m && v.m.length > 1 && /^[a-z\-]+$/.test(v.w));

  function rnd(k) { return Math.floor(Math.random() * k); }
  function shuffle(a) {
    const r = a.slice();
    for (let i = r.length - 1; i > 0; i--) { const j = rnd(i + 1); [r[i], r[j]] = [r[j], r[i]]; }
    return r;
  }
  const byPos = {};
  vocab.forEach(v => { (byPos[v.p] = byPos[v.p] || []).push(v); });

  function makeQuiz(size, minutes, code, name) {
    const chosen = shuffle(pool).slice(0, size);
    const q = chosen.map((v, i) => {
      const type = i % 2 === 0 ? "en2cn" : "cn2en";
      const samePos = (byPos[v.p] || vocab).filter(x => x.w !== v.w);
      const dis = [];
      for (const x of shuffle(samePos)) {
        if (dis.length >= 3) break;
        if (dis.some(d => d.w === x.w || d.m === x.m)) continue;
        dis.push(x);
      }
      while (dis.length < 3) {
        const x = vocab[rnd(vocab.length)];
        if (x.w === v.w || dis.some(d => d.w === x.w)) continue;
        dis.push(x);
      }
      const options = shuffle([v, ...dis.slice(0, 3)]).map(x => ({
        word: x.w, meaning: x.m, pos: x.p, correct: x.w === v.w
      }));
      return { type, options };
    });
    const CODE = "ACDEFGHJKLMNPQRTUVWXY34679";
    let c = "";
    for (let i = 0; i < 6; i++) c += CODE[rnd(CODE.length)];
    return { id: "demo_" + c.toLowerCase(), c, n: name, m: minutes, i: true, q };
  }

  const quizzes = [
    makeQuiz(20, 15, "", "高一 Unit 1–2 词汇过关测"),
    makeQuiz(20, 15, "", "高二 高频动词专项"),
    makeQuiz(30, 20, "", "高三 一轮复习综合测"),
    makeQuiz(10, 10, "", "课堂 5 分钟小测"),
  ];
  return { pw: crypto.randomBytes(8).toString("hex").slice(0, 13), quizzes };
}

if (require.main === module) {
  if (process.argv.includes("--demo")) {
    const v = demoVials();
    fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
    fs.writeFileSync(VIAL_JSON, JSON.stringify(v, null, 2));
    console.log("已生成示例批次 data/vials.json，共", v.quizzes.length, "份试卷");
  }
  build();
}
module.exports = { build, makeAlias, demoVials };
