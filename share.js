/* =========================================================
   share.js —— 极短分享链接（密钥瓶 / Key Vial）
   ---------------------------------------------------------
   目标：老师发给学生的链接 ≤ 30 字符（含域名），能直接在微信里点开。

   为什么必须这么做：
     纯静态页面没有后端，没法「按需生成短链」；把整份试卷塞进
     #q= 里，压到极限也要 200+ 字符。于是改成「密钥瓶」：

       fixed   试卷密文（AES-256-GCM）编进 index.html，随页面一起发布
               发布 —— 长度不计入链接
       alias   链接里只剩 8 位暗号，它同样参与 AES-GCM 的 AAD，
               输错一位就解密失败（而不是解出半份乱卷）

     https://<域名>/s/AB12CD34      ← 整条 27 字符

   一次发布 = 一个「试卷批次」。老师发布新卷、且旧链接失效之前，
   重新跑一次打包脚本即可（同一批次内可容纳 8192 份不同试卷）。

   安全边界：fixed 段随页面公开，等价于「知道暗号就能取卷」。
   适合课堂练习、随堂测；不适合真正保密的选拔考试。
   ========================================================= */
window.ShareCodec = (() => {
  "use strict";

  /* 密钥瓶来自 index.html 的 <script id="vial-data">，由 pack-share.js 生成 */
  const FIXED_B64 = (() => {
    const el = document.getElementById("vial-data");
    return el ? el.textContent.trim() : "";
  })();

  /* ---------------- Base32（Crockford 风格，去掉 I L O U） ---------------- */
  const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  function b32enc(bytes) {
    let acc = 0, bits = 0, out = "";
    for (let i = 0; i < bytes.length; i++) {
      acc = (acc << 8) | bytes[i];       // 累积 ≤ 13 位，不会溢出
      bits += 8;
      while (bits >= 5) {
        out += B32[(acc >>> (bits - 5)) & 31];
        bits -= 5;
      }
      acc &= (1 << bits) - 1;            // 只留尚未输出的低位
    }
    if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
    // 固定补足 8 位：4 字节 = 32 位，末尾 2 位是填充，避免「末位清零」时被吞掉
    while (out.length < 8) out += B32[0];
    return out;
  }
  /* 手输容错：I/L → 1，O → 0 */
  function normAlias(s) {
    return String(s || "").toUpperCase()
      .replace(/[^0-9A-Z]/g, "")
      .replace(/[IL]/g, "1")
      .replace(/O/g, "0");
  }
  function b32dec(str) {
    const s = normAlias(str);
    const out = [];
    let acc = 0, bits = 0;
    for (let i = 0; i < s.length; i++) {
      const v = B32.indexOf(s[i]);
      if (v < 0) throw new Error("暗号里有无法识别的字符");
      acc = (acc << 5) | v;              // 累积 ≤ 12 位
      bits += 5;
      if (bits >= 8) {
        out.push((acc >>> (bits - 8)) & 0xff);
        bits -= 8;
        acc &= (1 << bits) - 1;
      }
    }
    return new Uint8Array(out);
  }

  /* ---------------- 暗号：8 位 Base32（含 4 位校验） ----------------
     32 位总量拆成：26 位瓶号（约 6700 万份）+ 2 位填充 + 4 位校验。
     · 填充位让「瓶号很小」的暗号也不至于像 00000000 这样的序号；
     · 4 位校验让乱敲的暗号约 937‰ 被直接拦下，提示「暗号不存在」，
       而不是去解密一堆垃圾数据。
     实现上拆成高 16 位 / 低 16 位两组分别编码，绕开 JS 32 位位运算
     在大数上溢出、以及整数除法取整不一致的问题。 */
  const MAX_VIAL = 1 << 26;
  function aliasValue(idx, data) {
    const fill = data & 0x03;
    const ck = (idx ^ fill ^ Math.floor(idx / 128) ^ Math.floor(idx / 32768)) & 0x0f;
    return idx * 64 + fill * 16 + ck;
  }
  function encodeWord(x) {
    let out = "", rem = x;
    for (let i = 0; i < 4; i++) { out = B32[rem % 32] + out; rem = Math.floor(rem / 32); }
    return out;
  }
  function decodeWord(str) {
    let x = 0;
    for (let i = 0; i < str.length; i++) {
      const v = B32.indexOf(str[i]);
      if (v < 0) throw new Error("暗号里有无法识别的字符");
      x = x * 32 + v;
    }
    return x < 65536 ? x : -1;   // 4 个字符最多 2^20，超出即非法
  }
  function makeAlias(idx, data) {
    const v = aliasValue(idx, data);
    return encodeWord(Math.floor(v / 65536)) + encodeWord(v % 65536);
  }
  function parseAlias(code) {
    const s = normAlias(code);
    if (s.length !== 8) throw new Error("暗号应为 8 位");
    const hi = decodeWord(s.slice(0, 4)), lo = decodeWord(s.slice(4));
    if (hi < 0 || lo < 0) throw new Error("暗号不存在");
    const v = hi * 65536 + lo;
    const ck = v % 16;
    const fill = Math.floor(v / 16) % 4;
    const idx = Math.floor(v / 64);
    if (idx >= MAX_VIAL || ck !== ((idx ^ fill ^ Math.floor(idx / 128) ^ Math.floor(idx / 32768)) & 0x0f)) {
      throw new Error("暗号不存在");
    }
    return idx;
  }

  /* ---------------- 密钥瓶 ---------------- */
  let vialCache = null;
  function getVial() {
    if (vialCache !== null) return vialCache;
    if (!FIXED_B64) return (vialCache = null);
    try {
      // 不再用 atob 拼 Uint8Array（旧实现有字段名写错导致取到 0 的坑），
      // 手动解码 Base64，避免依赖二进制字符串的边界行为
      const s = FIXED_B64.replace(/\s+/g, "");
      const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      const out = [];
      let acc = 0, bits = 0;
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === "=") break;
        const v = B64.indexOf(ch);
        if (v < 0) continue;
        acc = (acc << 6) | v;
        bits += 6;
        if (bits >= 8) {
          out.push((acc >>> (bits - 8)) & 0xff);
          bits -= 8;
        }
      }
      vialCache = new Uint8Array(out);
    } catch { vialCache = null; }
    return vialCache;
  }
  const hasVial = () => !!getVial();

  /* 布局：[0] 版本 | [1..14] 13 位密码 | [14..16] 条目数 u16 | 之后定长记录 */
  const PW_LEN = 13;
  const DATA_START = 16;
  function vialMeta() {
    const b = getVial();
    if (!b) return null;
    const count = b[14] | (b[15] << 8);
    const dataStart = DATA_START;
    // 记录定长：总长 = 头 + count × recLen
    const recLen = count > 0 ? Math.floor((b.length - dataStart) / count) : 0;
    return { ver: b[0], count, dataStart, recLen };
  }
  function recordAt(idx) {
    const meta = vialMeta();
    if (!meta) return null;
    const b = getVial();
    const recLen = meta.recLen;
    const p = meta.dataStart + idx * recLen;
    if (!recLen || p + recLen > b.length) return null;
    const len = b[p];
    if (!len || len + 1 > recLen) return null;
    const nonce = b.slice(p + 1, p + 13);
    // 末 16 字节是 GCM 认证标签，必须原样交给 WebCrypto
    const ct = b.slice(p + 13, p + 1 + len);
    return { nonce, ct };
  }

  /* ---------------- AES-256-GCM ----------------
     密码是 13 位数字，PBKDF2-SHA256 派生 256 位密钥；
     AAD 固定为 "gkv1|" —— 暗号不再参与密钥，而是靠上面的校验和
     保证「暗号错 → 直接查不到条目」。 */
  let keyCache = null;
  async function getKey() {
    if (keyCache) return keyCache;
    const subtle = crypto && crypto.subtle;
    if (!subtle) throw new Error("当前浏览器内核过旧，请升级微信或换浏览器");
    // 密码取自密钥瓶头部的 [1..13]，用已解码的字节取，避免依赖 atob 的分块行为
    const vb = getVial();
    let pw = "";
    for (let i = 1; i <= PW_LEN; i++) pw += String.fromCharCode(vb[i]);   // [1..14]
    pw = pw.replace(/[^0-9a-f]/gi, "");
    const material = new TextEncoder().encode("gk3500-vial|" + pw);
    const km = await subtle.importKey("raw", material, "PBKDF2", false, ["deriveBits"]);
    const bits = await subtle.deriveBits(
      { name: "PBKDF2", salt: new TextEncoder().encode("gk3500-v1"), iterations: 10000, hash: "SHA-256" },
      km, 256
    );
    keyCache = await subtle.importKey("raw", bits, "AES-GCM", false, ["decrypt"]);
    return keyCache;
  }

  async function plainOf(idx) {
    const rec = recordAt(idx);
    if (!rec) throw new Error("暗号不存在");
    const key = await getKey();
    let buf;
    try {
      buf = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: rec.nonce, additionalData: new TextEncoder().encode("gkv1") },
        key, rec.ct
      );
    } catch (e) {
      // 解密失败细节只写控制台，页面上统一提示「暗号不存在」
      console.warn("[vial] 解密失败", e && e.message);
      throw new Error("暗号不存在");
    }
    // 按 latin1 还原字节流：0..255 一一对应，后续再决定是 JSON 文本还是位流
    const u8 = new Uint8Array(buf);
    let txt = "";
    for (let i = 0; i < u8.length; i++) txt += String.fromCharCode(u8[i]);
    return txt;
  }

  /* ---------------- 试卷位流 ↔ 结构（与旧 v4 同构） ----------------
       [0]     标志：bit0 即时反馈、bit1 有测验码
       [1]     限时分钟
       [2]     题数
       [3..7]  测验码（5 位/字符，30 位）
       题目区  每题 1 位题型 + 2 位正确位置 + 4×12 位词索引
       附注区  内置库覆盖不到的选项：数量 u16 + 每条 [len][词:释义:词性] */
  const PER_Q_BITS = 1 + 2 + 4 * 12;
  const CODE_ALPHA = "ACDEFGHJKLMNPQRTUVWXY34679";

  let builtinIndex = null;
  function getBuiltinIndex() {
    if (builtinIndex) return builtinIndex;
    builtinIndex = new Map();
    try {
      (window.__BUILTIN_VOCAB__ || []).forEach((v, i) => builtinIndex.set(String(v.w).toLowerCase(), i));
    } catch { /* 忽略 */ }
    return builtinIndex;
  }
  const builtinAt = i => (window.__BUILTIN_VOCAB__ || [])[i] || null;

  function unpackCode(bytes, at, len) {
    let bits = 0;
    for (let i = 0; i < 4; i++) bits = (bits << 8) | bytes[at + i];
    const shift = 30 - len * 5;
    const val = shift > 0 ? bits >>> shift : bits;
    let out = "";
    for (let i = len - 1; i >= 0; i--) out += CODE_ALPHA[(val >>> (i * 5)) & 0x1f] || "A";
    return out;
  }

  function unpackBin(bytes) {
    let p = 0;
    const vf = bytes[p++];
    if ((vf >> 4) !== 4) throw new Error("试卷格式不匹配");
    const flags = vf & 0x0f;
    const minutes = bytes[p++] || 15;
    const qCount = bytes[p++];
    let code = "";
    if (flags & 2) {
      const len = bytes[p + 4];
      code = unpackCode(bytes, p, Math.max(1, Math.min(6, len)));
      p += 5;
    }

    const qBytesLen = Math.ceil((qCount * PER_Q_BITS) / 8);
    const qStart = p;
    const qEnd = p + qBytesLen;
    const readBits = (pos, n) => {
      let v = 0;
      for (let i = 0; i < n; i++) {
        const bitPos = pos + i;
        const bit = (bytes[qStart + (bitPos >> 3)] >> (7 - (bitPos & 7))) & 1;
        v = (v << 1) | bit;
      }
      return v;
    };

    const raw = [];
    for (let k = 0; k < qCount; k++) {
      const base = k * PER_Q_BITS;
      const refs = [];
      const isCn2en = readBits(base, 1) === 1;
      const ai = readBits(base + 1, 2);
      for (let j = 0; j < 4; j++) refs.push(readBits(base + 3 + j * 12, 12));
      raw.push({ isCn2en, ai, refs });
    }

    p = qEnd;
    const extCount = (bytes[p] | (bytes[p + 1] << 8)) || 0; p += 2;
    const extras = [];
    const td = new TextDecoder();
    for (let i = 0; i < extCount; i++) {
      const n = bytes[p++];
      extras.push(td.decode(bytes.slice(p, p + n)));
      p += n;
    }

    const resolve = ref => {
      if (ref === 0xfef) return { word: "", meaning: "", pos: "" };
      if (ref === 0xfff) {
        const s = extras.shift() || "W:?:";
        const [, w, m, pos] = s.split(":");
        return { word: w || "", meaning: m || "", pos: pos || "" };
      }
      const v = builtinAt(ref);
      return v ? { word: v.w, meaning: v.m, pos: v.p || "" } : { word: "?", meaning: "", pos: "" };
    };

    const questions = raw.map((q, k) => {
      const ai = Math.min(q.ai, 3);
      const opts = q.refs.map(resolve);
      const c = opts[ai] || { word: "", meaning: "", pos: "" };
      return {
        id: k,
        type: q.isCn2en ? "cn2en" : "en2cn",
        word: c.word, meaning: c.meaning, pos: c.pos || "", phon: "",
        tier: "core",
        options: opts.map((r, i) => ({ word: r.word, meaning: r.meaning, correct: i === ai })),
        answerIndex: ai
      };
    });
    return { code, minutes, instant: (flags & 1) !== 0, questions };
  }

  /* ---------------- 对外：解码 ----------------
     入参既可以是 8 位暗号，也可以是旧版 #q= 长串。 */
  async function decode(aliasOrBody) {
    const s = String(aliasOrBody || "").trim();
    if (!s) throw new Error("链接内容为空");

    // 旧版 #q= 长链接：首字符 4 + Base64URL
    if (s[0] === "4" && s.length > 40) {
      const bin = b64urlDec(s.slice(1));
      const out = unpackBin(bin);
      if (!out.questions.length) throw new Error("试卷内容为空");
      return { ...out, name: out.code ? `词汇测验 ${out.code}` : "词汇测验", bankName: "内置词库" };
    }

    const idx = parseAlias(s);
    const meta = vialMeta();
    if (!meta) throw new Error("这份试卷已下线，请让老师重新发链接");
    if (idx >= meta.count) throw new Error("暗号不存在");

    const txt = await plainOf(idx);
    // 先试 JSON，再按位流解析
    let payload = null;
    if (txt[0] === "{") { try { payload = JSON.parse(txt); } catch { payload = null; } }
    if (payload) {
      if (!Array.isArray(payload.q) || !payload.q.length) throw new Error("试卷数据损坏");
      const code = payload.c || "";
      return {
        code,
        name: code ? `词汇测验 ${code}` : "词汇测验",
        minutes: payload.m || 15,
        instant: payload.i !== 0,
        bankName: "内置词库",
        questions: payload.q
      };
    }
    const bin = new Uint8Array(txt.length);
    for (let i = 0; i < txt.length; i++) bin[i] = txt.charCodeAt(i) & 0xff;
    const out = unpackBin(bin);
    if (!out.questions.length) throw new Error("试卷数据损坏");
    return { ...out, name: out.code ? `词汇测验 ${out.code}` : "词汇测验", bankName: "内置词库" };
  }

  function b64urlDec(str) {
    const s = str.replace(/-/g, "+").replace(/_/g, "/");
    const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
    const bin = atob(s + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* ---------------- 链接生成 ----------------
     线上：https://<域名>/s/XXXXXXXX  （27 字符）
     本地双击打开（file:）：退回 #p= 形式 */
  function makeLink(alias) {
    if (location.protocol === "file:") return `${location.pathname}#p=${alias}`;
    // 静态托管（GitHub Pages 等）没有服务端重写，用查询参数承载暗号
    const base = location.origin + location.pathname.replace(/[^/]*$/, "");
    return `${base}?c=${alias}`;
  }

  /* 瓶内第 idx 份试卷的暗号（与打包脚本算法一致） */
  function aliasAt(idx) {
    return makeAlias(idx, (idx * 40503) % 4);
  }
  function toc() {
    const meta = vialMeta();
    return { count: meta ? meta.count : 0, ver: meta ? meta.ver : 0 };
  }

  /* ---------------- 二维码（离线生成，无第三方库） ----------------
     字节模式 + 纠错等级 M，自动选版本（1..10，足够放一条 URL）。
     只实现生成侧必需的部分：RS 纠错、交织、矩阵放置、掩码择优。 */
  const QR = (() => {
    const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
    (() => {
      let x = 1;
      for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
      for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
    })();
    const mul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

    // 纠错等级 M 的每块参数：[每块纠错码数, 组1块数, 组1数据码数, 组2块数, 组2数据码数]
    const EC_M = [
      null,
      [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0],
      [24, 2, 43, 0, 0], [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39],
      [22, 3, 36, 2, 37], [26, 4, 43, 1, 44], [30, 1, 50, 4, 51],
    ];
    const ALIGN = [
      [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
      [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54],
    ];

    function rsGen(n) {
      let g = [1];
      for (let i = 0; i < n; i++) {
        const ng = new Array(g.length + 1).fill(0);
        for (let j = 0; j < g.length; j++) {
          ng[j] ^= g[j];
          ng[j + 1] ^= mul(g[j], EXP[i]);
        }
        g = ng;
      }
      return g;
    }
    function rsEncode(data, n) {
      const g = rsGen(n);
      const res = new Array(data.length + n).fill(0);
      data.forEach((v, i) => res[i] = v);
      for (let i = 0; i < data.length; i++) {
        const f = res[i];
        if (!f) continue;
        for (let j = 0; j < g.length; j++) res[i + j] ^= mul(g[j], f);
      }
      return res.slice(data.length);
    }

    function build(text) {
      const bytes = Array.from(new TextEncoder().encode(text));
      let ver = 0, ecw, blocks;
      for (let v = 1; v <= 10; v++) {
        const [ecc, b1, d1, b2, d2] = EC_M[v];
        const totalData = b1 * d1 + b2 * d2;
        const need = 4 + (v <= 9 ? 8 : 16) + bytes.length * 8;
        if (need <= totalData * 8) { ver = v; ecw = ecc; blocks = [b1, d1, b2, d2]; break; }
      }
      if (!ver) throw new Error("链接过长，无法生成二维码");

      const size = ver * 4 + 17;
      const [ecc, b1, d1, b2, d2] = EC_M[ver];
      const totalData = b1 * d1 + b2 * d2;

      // 位流
      const bits = [];
      const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
      put(4, 4);                       // 字节模式
      put(bytes.length, ver <= 9 ? 8 : 16);
      bytes.forEach(b => put(b, 8));
      const cap = totalData * 8;
      put(0, Math.min(4, cap - bits.length));
      while (bits.length % 8) bits.push(0);
      const dataCw = [];
      for (let i = 0; i < bits.length; i += 8) {
        let b = 0;
        for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
        dataCw.push(b);
      }
      const PAD = [0xec, 0x11];
      let pi = 0;
      while (dataCw.length < totalData) dataCw.push(PAD[pi++ % 2]);

      // 分块 + 纠错 + 交织
      const dBlocks = [], eBlocks = [];
      let off = 0;
      for (let i = 0; i < b1; i++) { const d = dataCw.slice(off, off + d1); off += d1; dBlocks.push(d); eBlocks.push(rsEncode(d, ecc)); }
      for (let i = 0; i < b2; i++) { const d = dataCw.slice(off, off + d2); off += d2; dBlocks.push(d); eBlocks.push(rsEncode(d, ecc)); }
      const maxD = Math.max(...dBlocks.map(b => b.length));
      const final = [];
      for (let i = 0; i < maxD; i++) dBlocks.forEach(b => { if (i < b.length) final.push(b[i]); });
      for (let i = 0; i < ecc; i++) eBlocks.forEach(b => final.push(b[i]));

      // 矩阵
      const m = Array.from({ length: size }, () => new Array(size).fill(null));
      const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

      function finder(r, c) {
        // 7×7 回字 + 四周一圈白色分隔带
        for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
          const inside = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
          const ring = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
          m[rr][cc] = inside && (ring === 3 || ring <= 1) ? 1 : 0;
          reserved[rr][cc] = true;
        }
      }
      finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

      // 定时图形
      for (let i = 8; i < size - 8; i++) {
        m[6][i] = i % 2 === 0 ? 1 : 0; reserved[6][i] = true;
        m[i][6] = i % 2 === 0 ? 1 : 0; reserved[i][6] = true;
      }
      // 对齐图形
      const ap = ALIGN[ver];
      ap.forEach(r => ap.forEach(c => {
        if (reserved[r][c]) return;
        for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          m[r + dr][c + dc] = (ring === 0 || ring === 2) ? 1 : 0;
          reserved[r + dr][c + dc] = true;
        }
      }));
      // 格式信息区（最后按最优掩码写入）
      for (let i = 0; i <= 8; i++) { reserved[8][i] = true; reserved[i][8] = true; }
      for (let i = 0; i <= 7; i++) reserved[8][size - 1 - i] = true;
      for (let i = 0; i <= 7; i++) reserved[size - 1 - i][8] = true;
      // 版本信息（v≥7）
      if (ver >= 7) {
        for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) {
          reserved[size - 11 + j][i] = true;
          reserved[i][size - 11 + j] = true;
        }
      }
      // 固定黑点
      m[size - 8][8] = 1; reserved[size - 8][8] = true;

      // 放数据（之字形）
      let bi = 0;
      const totalBits = final.length * 8;
      const getBit = k => (final[k >> 3] >> (7 - (k & 7))) & 1;
      let up = true;
      for (let right = size - 1; right > 0; right -= 2) {
        if (right === 6) right = 5;
        for (let k = 0; k < size; k++) {
          const row = up ? size - 1 - k : k;
          for (let c = 0; c < 2; c++) {
            const col = right - c;
            if (reserved[row][col]) continue;
            m[row][col] = bi < totalBits ? getBit(bi++) : 0;
          }
        }
        up = !up;
      }

      // 掩码
      const MASK = [
        (r, c) => (r + c) % 2 === 0,
        (r) => r % 2 === 0,
        (r, c) => c % 3 === 0,
        (r, c) => (r + c) % 3 === 0,
        (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
        (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
        (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
        (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
      ];
      function applyFmt(mat, mask) {
        const data = (0 << 3) | mask;          // 纠错等级 M = 00
        let rem = data;
        for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
        const bitsFmt = ((data << 10) | rem) ^ 0x5412;
        const bit = i => (bitsFmt >> i) & 1;
        // 左上
        for (let i = 0; i <= 5; i++) mat[8][i] = bit(i);
        mat[8][7] = bit(6); mat[8][8] = bit(7); mat[7][8] = bit(8);
        for (let i = 9; i <= 14; i++) mat[14 - i][8] = bit(i);
        // 右上 / 左下
        for (let i = 0; i <= 7; i++) mat[8][size - 1 - i] = bit(i);
        for (let i = 8; i <= 14; i++) mat[size - 15 + i][8] = bit(i);
        mat[size - 8][8] = 1;
      }
      function score(mat) {
        let s = 0;
        // 规则 1：同色连续
        for (let i = 0; i < size; i++) {
          let runR = 1, runC = 1;
          for (let j = 1; j < size; j++) {
            runR = mat[i][j] === mat[i][j - 1] ? runR + 1 : 1;
            runC = mat[j][i] === mat[j - 1][i] ? runC + 1 : 1;
            if (runR === 5) s += 3; else if (runR > 5) s++;
            if (runC === 5) s += 3; else if (runC > 5) s++;
          }
        }
        // 规则 2：2×2 同色
        for (let i = 0; i < size - 1; i++) for (let j = 0; j < size - 1; j++) {
          const v = mat[i][j];
          if (v === mat[i][j + 1] && v === mat[i + 1][j] && v === mat[i + 1][j + 1]) s += 3;
        }
        // 规则 3：1:1:3:1:1 类定位形态
        const pat = [1, 0, 1, 1, 1, 0, 1];
        const matchAt = (get, at) => pat.every((v, k) => get(at + k) === v);
        for (let i = 0; i < size; i++) for (let j = 0; j <= size - 7; j++) {
          const rowGet = k => mat[i][j + k];
          const colGet = k => mat[j + k][i];
          if (matchAt(rowGet, 0)) s += 40;
          if (matchAt(colGet, 0)) s += 40;
        }
        // 规则 4：黑白比例
        let dark = 0;
        for (let i = 0; i < size; i++) for (let j = 0; j < size; j++) dark += mat[i][j];
        s += Math.floor(Math.abs(dark * 100 / (size * size) - 50) / 5) * 10;
        return s;
      }

      let best = null, bestScore = Infinity;
      for (let mask = 0; mask < 8; mask++) {
        const mat = m.map(r => r.slice());
        for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
          if (reserved[r][c]) continue;
          if (MASK[mask](r, c)) mat[r][c] ^= 1;
        }
        applyFmt(mat, mask);
        const sc = score(mat);
        if (sc < bestScore) { bestScore = sc; best = mat; }
      }
      return best;
    }

    function svg(text, px) {
      const mat = build(text);
      const size = mat.length;
      const quiet = 4;
      const dim = size + quiet * 2;
      const s = px || 220;
      let path = "";
      for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
        if (mat[r][c]) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
      }
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${s}" height="${s}" shape-rendering="crispEdges">
        <rect width="${dim}" height="${dim}" fill="#fff"/><path d="${path}" fill="#111"/></svg>`;
    }
    /* 画到 canvas 上（用于导出 PNG 与下载），不依赖外部库 */
    function toCanvas(text, px, quietZone) {
      const mat = build(text);
      const size = mat.length;
      const quiet = quietZone == null ? 4 : quietZone;
      const dim = size + quiet * 2;
      const s = px || 512;
      const scale = Math.max(1, Math.floor(s / dim));
      const cv = document.createElement("canvas");
      cv.width = cv.height = dim * scale;
      const g = cv.getContext("2d");
      g.fillStyle = "#fff";
      g.fillRect(0, 0, cv.width, cv.height);
      g.fillStyle = "#111";
      for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
        if (mat[r][c]) g.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
      }
      return cv;
    }

    return { build, svg, toCanvas };
  })();

  /* ---------------- 从 URL 读取 ----------------
     支持 /s/XXXXXXXX、?c=XXXXXXXX、#p=XXXXXXXX、旧 #q=长串 */
  function readFromUrl() {
    const path = location.pathname || "";
    let m = path.match(/\/s\/([0-9A-Za-z]{4,16})\/?$/);
    if (m) return m[1].toUpperCase();
    const q = new URLSearchParams(location.search);
    for (const key of ["c", "code"]) {
      const v = q.get(key);
      if (v && /^[0-9A-Za-z]{6,16}$/.test(v)) return v.toUpperCase();
    }
    const h = location.hash || "";
    m = h.match(/[#&]p=([0-9A-Za-z]+)/);
    if (m) return m[1].toUpperCase();
    m = h.match(/[#&](?:q|quiz)=([0-9A-Za-z\-_]+)/);
    if (m) return m[1];
    return null;
  }

  /* ---------------- 导出 ---------------- */
  function readShareParam() {
    const p = new URLSearchParams(location.search || "");
    return p.get("s") || p.get("share") || "";
  }

  return {
    decode, makeLink, readFromUrl, hasVial, toc, aliasAt,
    qrSvg: (text, px) => QR.svg(text, px),
    qrCanvas: (text, px) => QR.toCanvas(text, px)
  };
})();
