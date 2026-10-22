/* =========================================================
   store.js —— 本地数据层（localStorage 持久化，无需后端）
   实体：classes 班级 / banks 词库 / quizzes 测验任务 / records 作答记录
   ========================================================= */
window.Store = (() => {
  "use strict";
  const KEY = "gk3500_v2";
  const uid = p => p + Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 6);

  const blank = () => ({ classes: [], banks: [], quizzes: [], records: [], teacher: { name: "英语备课组" } });

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return blank();
      const d = JSON.parse(raw);
      return Object.assign(blank(), d);
    } catch (e) { return blank(); }
  }
  let db = load();

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(db)); }
    catch (e) { console.warn("存储失败（可能是词库过大）", e); }
    window.dispatchEvent(new CustomEvent("store:change"));
  }
  function reset() { db = blank(); save(); }

  /* ---------- 班级 ---------- */
  function addClass(name) {
    name = (name || "").trim();
    if (!name) throw new Error("班级名称不能为空");
    if (db.classes.some(c => c.name === name)) throw new Error("该班级已存在");
    const c = { id: uid("c_"), name, createdAt: Date.now(), students: [] };
    db.classes.push(c); save(); return c;
  }
  function delClass(id) {
    db.classes = db.classes.filter(c => c.id !== id);
    db.quizzes = db.quizzes.filter(q => q.classId !== id);
    save();
  }

  /* ---------- 词库 ---------- */
  function addBank(name, items, meta) {
    if (!items || !items.length) throw new Error("词库为空");
    const b = {
      id: uid("b_"), name: name || "未命名词库", items,
      meta: meta || {}, createdAt: Date.now(), count: items.length
    };
    db.banks.push(b); save(); return b;
  }
  function delBank(id) {
    db.banks = db.banks.filter(b => b.id !== id);
    save();
  }
  function getBank(id) { return db.banks.find(b => b.id === id); }

  /* ---------- 测验任务 ---------- */
  function addQuiz({ name, bankId, classId, count, minutes, instant, types }) {
    const bank = getBank(bankId);
    if (!bank) throw new Error("请先选择词库");
    const n = Math.min(count, bank.items.length);
    const code = genCode();
    const q = {
      id: uid("q_"), code, name: name || `${bank.name} 词汇测验`,
      bankId, bankName: bank.name, classId,
      count: n, minutes: minutes || 15, instant: instant !== false,
      types: types || ["en2cn", "cn2en"],
      createdAt: Date.now(), open: true
    };
    db.quizzes.push(q); save(); return q;
  }
  function genCode() {
    const chars = "ACDEFGHJKLMNPQRTUVWXY34679";
    let code;
    do { code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join(""); }
    while (db.quizzes.some(q => q.code === code));
    return code;
  }
  function getQuizByCode(code) {
    if (!code) return null;
    return db.quizzes.find(q => q.code === String(code).trim().toUpperCase());
  }
  function delQuiz(id) {
    db.quizzes = db.quizzes.filter(q => q.id !== id);
    db.records = db.records.filter(r => r.quizId !== id);
    save();
  }
  function toggleQuiz(id) {
    const q = db.quizzes.find(x => x.id === id);
    if (q) { q.open = !q.open; save(); }
  }

  /* ---------- 作答记录（学生提交 → 教师端可见） ---------- */
  function addRecord(rec) {
    const r = Object.assign({ id: uid("r_"), at: Date.now() }, rec);
    db.records.push(r); save(); return r;
  }
  function recordsOfQuiz(quizId) { return db.records.filter(r => r.quizId === quizId).sort((a, b) => b.at - a.at); }
  function recordsOfClass(classId) {
    const qids = db.quizzes.filter(q => q.classId === classId).map(q => q.id);
    return db.records.filter(r => qids.includes(r.quizId));
  }

  /* ---------- 统计 ---------- */
  function quizStats(quizId) {
    const rs = recordsOfQuiz(quizId);
    if (!rs.length) return { n: 0, avg: 0, max: 0, min: 0, pass: 0, dist: [0, 0, 0, 0, 0], topWrong: [] };
    const scores = rs.map(r => r.score);
    const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 10) / 10;
    const dist = [0, 0, 0, 0, 0]; // <60, 60-69, 70-79, 80-89, 90-100
    scores.forEach(s => { dist[s < 60 ? 0 : s < 70 ? 1 : s < 80 ? 2 : s < 90 ? 3 : 4]++; });
    const wrongMap = new Map();
    rs.forEach(r => (r.wrongWords || []).forEach(w => {
      const o = wrongMap.get(w.w) || { w: w.w, m: w.m, p: w.p, n: 0 };
      o.n++; wrongMap.set(w.w, o);
    }));
    return {
      n: rs.length, avg, max: Math.max(...scores), min: Math.min(...scores),
      pass: Math.round(scores.filter(s => s >= 60).length / scores.length * 100),
      dist, topWrong: [...wrongMap.values()].sort((a, b) => b.n - a.n).slice(0, 12),
      records: rs
    };
  }

  function classStats(classId) {
    const qs = db.quizzes.filter(q => q.classId === classId);
    const rs = recordsOfClass(classId);
    if (!rs.length) return { n: 0, avg: 0, quizzes: qs.length, students: new Set(), dist: [0, 0, 0, 0, 0], topWrong: [], weakStudents: [] };
    const scores = rs.map(r => r.score);
    const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 10) / 10;
    const dist = [0, 0, 0, 0, 0];
    scores.forEach(s => dist[s < 60 ? 0 : s < 70 ? 1 : s < 80 ? 2 : s < 90 ? 3 : 4]++);
    const wrongMap = new Map();
    rs.forEach(r => (r.wrongWords || []).forEach(w => {
      const o = wrongMap.get(w.w) || { w: w.w, m: w.m, p: w.p, n: 0 };
      o.n++; wrongMap.set(w.w, o);
    }));
    // 按学生聚合
    const byStudent = new Map();
    rs.forEach(r => {
      const k = r.studentName || "匿名";
      const s = byStudent.get(k) || { name: k, scores: [], times: 0 };
      s.scores.push(r.score); s.times++; byStudent.set(k, s);
    });
    const students = [...byStudent.values()].map(s => ({
      name: s.name, times: s.times,
      avg: Math.round(s.scores.reduce((a, b) => a + b, 0) / s.scores.length * 10) / 10,
      last: s.scores[s.scores.length - 1]
    })).sort((a, b) => a.avg - b.avg);
    return {
      n: rs.length, avg, quizzes: qs.length, students,
      dist, topWrong: [...wrongMap.values()].sort((a, b) => b.n - a.n).slice(0, 15),
      weakStudents: students.filter(s => s.avg < 70).slice(0, 8)
    };
  }

  /* ---------- 导出 CSV ---------- */
  function exportCSV(quizId) {
    const q = db.quizzes.find(x => x.id === quizId);
    const rs = recordsOfQuiz(quizId);
    const head = ["学生", "班级", "得分", "正确数", "总题数", "用时(秒)", "提交时间", "错词"];
    const rows = rs.map(r => [
      r.studentName, r.className || "", r.score, r.correct, r.total, r.seconds,
      new Date(r.at).toLocaleString("zh-CN"), (r.wrongWords || []).map(w => w.w).join(" / ")
    ]);
    const csv = [head, ...rows].map(row => row.map(v => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${q ? q.name : "成绩"}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }

  return {
    get db() { return db; }, save, reset,
    addClass, delClass,
    addBank, delBank, getBank,
    addQuiz, delQuiz, toggleQuiz, getQuizByCode,
    addRecord, recordsOfQuiz, recordsOfClass,
    quizStats, classStats, exportCSV
  };
})();
