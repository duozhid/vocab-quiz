// build-batch.js —— 合并历史卷 + 重生成损坏卷 + 新增 usage 联调卷，输出 data/vials.json
const fs = require("fs");
const vocab = JSON.parse(fs.readFileSync("vocab.json", "utf8"));
const vset = new Set(vocab.map(v => String(v.w).toLowerCase()));

function misspellings(w) {
  const out = [];
  const add = v => { if (v && v !== w && /^[a-z\-]{2,}$/.test(v) && !out.includes(v) && !vset.has(v)) out.push(v); };
  add(w.replace(/([a-z])\1/, "$1"));
  add(w.length > 3 ? w.slice(0, -1) : w + w.slice(-1));
  const mid = Math.max(1, Math.floor(w.length / 2));
  if (w.length > 3) add(w.slice(0, mid) + w[mid + 1] + w[mid] + w.slice(mid + 2));
  add(w.replace(/ie/, "ei").replace(/ea/, "ee").replace(/ou/, "oa"));
  add(w.length > 3 && w.endsWith("e") ? w.slice(0, -1) : w + "e");
  if (w.length > 4) add(w.slice(0, -2) + w.slice(-1) + w.slice(-2, -1));
  let g = 0;
  while (out.length < 3 && g++ < 8) add(w + "s".repeat(g % 2) + (g > 4 ? "e" : ""));
  return out.slice(0, 3);
}
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// 词仅在 0xffe 内才走内置下标；超出也没关系，打包端自动走附注区
function en2cn(pi) {
  const v = vocab[pi];
  const ds = [vocab[pi + 3], vocab[pi + 7], vocab[pi + 11]];
  const options = shuffle([v, ...ds]).map(x => ({ word: x.w, meaning: x.m, pos: x.p || "", correct: x === v }));
  return { type: "en2cn", word: v.w, meaning: v.m, pos: v.p || "", options };
}
function cn2en(pi) {
  const v = vocab[pi];
  const ds = [vocab[pi + 2], vocab[pi + 9], vocab[pi + 14]];
  const options = shuffle([v, ...ds]).map(x => ({ word: x.w, meaning: x.m, pos: x.p || "", correct: x === v }));
  return { type: "cn2en", word: v.w, meaning: v.m, pos: v.p || "", options };
}
function usage(pi) {
  const v = vocab[pi];
  const vars = misspellings(v.w);
  const options = shuffle([v, ...vars.map(w => ({ w, m: "", p: v.p }))])
    .map(x => ({ word: x.w, meaning: x.m || "", pos: x.p || v.p, correct: x.w === v.w }));
  return { type: "usage", word: v.w, meaning: v.m, pos: v.p || "", options };
}

// 源数据健康检查：任何题出现 ?/undefined/空释义 选项即视为损坏
function quizHealthy(qs) {
  return qs.every(q => {
    const rights = q.options.filter(o => o.correct).length;
    if (rights !== 1) return false;
    return q.options.every(o => {
      const w = String(o.word || "");
      if (!w || w === "?" || w === "undefined") return false;
      if (o.correct && q.type === "en2cn" && !String(o.meaning || "").trim()) return false;
      return true;
    });
  });
}

const full = JSON.parse(fs.readFileSync("data/vials-full.json", "utf8"));
let regenerated = 0;
const base = full.quizzes.map((q, qi) => {
  const qs = q.questions || q.q || [];
  // 旧版完整 JSON 不存 code（只编在位流里）——按上次线上顺序回填，保证旧链接不失效
  const RECOVERED = ["4LRKJC", "F9P7KX", "ALJNFA", "WERCGG"];
  const code = q.code || q.c || (qi >= 5 && qi <= 8 ? RECOVERED[qi - 5] : "");
  const name = q.name || (code ? `词汇测验 ${code}` : "词汇测验");
  if (quizHealthy(qs)) return { code, name, minutes: q.minutes || 15, instant: q.instant !== false, q: qs };
  regenerated++;
  // 损坏卷：按原题型分布重生成干净题目
  const types = qs.map(x => x.type || (x.isCn2en ? "cn2en" : "en2cn"));
  const used = new Set();
  const newQs = types.map(t => {
    let pi; let guard = 0;
    do { pi = Math.floor(Math.random() * (vocab.length - 20)); } while (used.has(pi) && guard++ < 50);
    used.add(pi);
    return t === "usage" ? usage(pi) : t === "cn2en" ? cn2en(pi) : en2cn(pi);
  });
  console.log(`  重生成损坏卷 ${code}（原题含垃圾数据）`);
  return { code, name, minutes: q.minutes || 15, instant: q.instant !== false, q: newQs };
});

// 新增 usage 联调卷
const qs = [];
for (let k = 0; k < 8; k++) {
  const pi = 5 + k * 9;
  qs.push(k % 3 === 2 ? usage(pi) : k % 3 === 0 ? en2cn(pi) : cn2en(pi));
}
const list = [...base.filter(x => x.code !== "ACDE34"), { code: "ACDE34", name: "新题型联调试卷", minutes: 15, instant: true, q: qs }];

// 终检
for (const quiz of list) {
  if (!quizHealthy(quiz.q)) { console.error(`终检失败: ${quiz.code}`); process.exit(1); }
}
fs.writeFileSync("data/vials.json", JSON.stringify({ pw: "0123456789abc", builtAt: new Date().toISOString(), quizzes: list }, null, 1));
console.log(`批次构建完成：${list.length} 份卷，重生成 ${regenerated} 份；联调卷 ACDE34 共 ${qs.length} 题（types: ${qs.reduce((a, x) => (a[x.type] = (a[x.type] || 0) + 1, a) && "" || "", "")}${qs.map(x => x.type).join(",")}）`);
