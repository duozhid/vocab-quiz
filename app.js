/* =========================================================
   高中英语 3500 词掌握度测验 —— 主逻辑
   模块：词库加载 → 组卷 → 作答 → 判分 → 诊断 → 习题生成
   ========================================================= */
(() => {
  "use strict";

  /* ---------- 常量 ---------- */
  const LETTERS = ["A", "B", "C", "D"];
  const POS_CN = { "n.": "名词", "v.": "动词", "vt.": "及物动词", "vi.": "不及物动词", "adj.": "形容词",
    "adv.": "副词", "prep.": "介词", "conj.": "连词", "pron.": "代词", "num.": "数词", "art.": "冠词",
    "int.": "感叹词", "aux.": "助动词", "abbr.": "缩写" };
  const TIERS = {
    core: { name: "高频核心词", desc: "阅读、写作中出现频率最高" },
    mid:  { name: "中频进阶词", desc: "阅读理解与完形填空常客" },
    high: { name: "低频难词",   desc: "拉开分差、易被忽略" }
  };
  const TYPES = {
    en2cn: { name: "英译中", desc: "看英文选中文释义" },
    cn2en: { name: "中译英", desc: "看中文选对应英文单词" }
  };

  const state = {
    vocab: [],
    mode: "mixed",        // core / mid / high / mixed
    count: 20,
    types: ["en2cn", "cn2en"],
    instant: true,
    timed: true,
    deadlineTimer: null,
    deadline: 0,
    questions: [],
    idx: 0,
    answers: [],          // {choice, correct, ms, doubt}
    startedAt: 0,
    qStart: 0,
    locked: false,
    timer: null,
    elapsed: 0
  };

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------- 工具 ---------- */
  const rnd = n => Math.floor(Math.random() * n);
  function shuffle(a) {
    const r = a.slice();
    for (let i = r.length - 1; i > 0; i--) { const j = rnd(i + 1); [r[i], r[j]] = [r[j], r[i]]; }
    return r;
  }
  function pick(arr, n) { return shuffle(arr).slice(0, n); }

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("on");
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove("on"), 2200);
  }

  function speak(text) {
    if (!("speechSynthesis" in window)) return toast("当前浏览器不支持发音");
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-US"; u.rate = .9;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }

  /* ---------- 词库分级（按字母序位置近似词频：词典按词频/难度大致递增编排） ---------- */
  function tierOf(i, total) {
    const p = i / total;
    return p < 0.5 ? "core" : p < 0.8 ? "mid" : "high";
  }

  /* ---------- 组卷 ---------- */
  function buildQuestions() {
    let pool = state.vocab.filter(v => v.m && v.m.length > 1 && /^[a-z\-]+$/.test(v.w));
    if (state.mode !== "mixed") {
      pool = state.vocab.filter(v => v.tier === state.mode && v.m);
    }
    if (pool.length < state.count) pool = state.vocab.slice();
    const chosen = pick(pool, state.count);

    // 全库按词性索引，用于挑干扰项
    const byPos = {};
    state.vocab.forEach(v => { (byPos[v.p] = byPos[v.p] || []).push(v); });

    return chosen.map((v, i) => {
      const type = state.types[rnd(state.types.length)];
      const samePos = (byPos[v.p] || state.vocab).filter(x => x.w !== v.w);
      let distractors = [];

      if (type === "en2cn") {
        // 干扰项：同词性的其他释义，避免出现含义相近（包含相同汉字串）的选项
        const cand = shuffle(samePos).filter(x => x.m !== v.m);
        for (const x of cand) {
          if (distractors.length >= 3) break;
          const overlap = [...x.m].some(ch => v.m.includes(ch) && /[\u4e00-\u9fff]/.test(ch));
          if (overlap && distractors.length < 2) continue; // 只放宽一次
          if (!distractors.some(d => d.m === x.m)) distractors.push(x);
        }
      } else {
        const cand = shuffle(samePos);
        for (const x of cand) {
          if (distractors.length >= 3) break;
          if (Math.abs(x.w.length - v.w.length) > 4) continue;
          if (x.w[0] === v.w[0] && distractors.length < 2) continue; // 尽量不同首字母，避免送分
          distractors.push(x);
        }
      }
      // 补足干扰项：先用全库随机（有上限，避免无限循环），再按字母序兜底
      let guard = 0;
      while (distractors.length < 3 && guard < 200) {
        guard++;
        const x = state.vocab[rnd(state.vocab.length)];
        if (!x || x.w === v.w || distractors.some(d => d.w === x.w)) continue;
        distractors.push(x);
      }
      if (distractors.length < 3) {
        for (const x of state.vocab) {
          if (distractors.length >= 3) break;
          if (x.w === v.w || distractors.some(d => d.w === x.w)) continue;
          distractors.push(x);
        }
      }
      // 词库总量不足 4 个时的最后兜底，保证每题 4 个选项
      while (distractors.length < 3) {
        distractors.push({ w: `option${distractors.length}`, m: "（词库词条不足）", p: v.p });
      }

      const options = shuffle([v, ...distractors.slice(0, 3)]).map(x => ({
        word: x.w, meaning: x.m, pos: x.p, correct: x.w === v.w
      }));

      return {
        id: i, type, word: v.w, meaning: v.m, pos: v.p, phon: v.ph, tier: v.tier || tierOf(state.vocab.indexOf(v), state.vocab.length),
        options, answerIndex: options.findIndex(o => o.correct)
      };
    });
  }

  /* ---------- 计时 ---------- */
  function startTimer() {
    if (!state.timed) return;
    const t0 = Date.now() - state.elapsed * 1000;
    state.timer = setInterval(() => {
      state.elapsed = Math.round((Date.now() - t0) / 1000);
      const m = String(Math.floor(state.elapsed / 60)).padStart(2, "0");
      const s = String(state.elapsed % 60).padStart(2, "0");
    }, 250);
  }

  /* ---------- 渲染：测试 ---------- */
  function renderQuestion() {
    const q = state.questions[state.idx];
    const n = state.questions.length;
    state.locked = false;
    state.qStart = Date.now();

    $("#q-progress").style.width = `${(state.idx / n) * 100}%`;
    $("#q-counter").innerHTML = `第 <b>${state.idx + 1}</b> / ${n} 题`;
    $("#q-progress-text").textContent = `${Math.round((state.idx / n) * 100)}%`;
    $("#q-type").textContent = TYPES[q.type].name;
    $("#q-pos").textContent = POS_CN[q.pos] || q.pos || "—";
    $("#q-tier").textContent = TIERS[q.tier].name;
    $("#q-no").textContent = `QUESTION ${String(state.idx + 1).padStart(2, "0")}`;

    // 题干预览点阵
    $("#q-dots").innerHTML = state.questions.map((_, i) => {
      const a = state.answers[i];
      let cls = "";
      if (a) cls = a.correct ? "ok" : "no";
      if (i === state.idx) cls += " cur";
      return `<i class="${cls}"></i>`;
    }).join("");

    // 题干与选项必须互不透露答案：
    //   en2cn —— 题干只给英文单词（+音标），选项只给中文释义
    //   cn2en —— 题干只给中文释义（+词性提示），选项只给英文单词
    // 之前 en2cn 的选项带了释义、cn2en 的题干旁又混入释义，等于把答案摆在眼前。
    if (q.type === "en2cn") {
      $("#q-stem").innerHTML = `<span class="stem-en">${esc(q.word)}</span>`;
      $("#q-phon").innerHTML = q.phon
        ? `/${esc(q.phon)}/ <span class="spk" data-say="${esc(q.word)}" title="朗读">🔊</span>`
        : `<span class="spk" data-say="${esc(q.word)}" title="朗读">🔊 朗读</span>`;
      $("#q-instr").textContent = "选出该单词最恰当的中文释义";
    } else {
      $("#q-stem").innerHTML = `<span class="stem-cn">${esc(q.meaning)}</span>`;
      $("#q-phon").innerHTML = q.pos
        ? `<span class="pos-hint">词性：${esc(q.pos)}</span>`
        : "";
      $("#q-instr").textContent = "选出与中文释义对应的英文单词";
    }

    // 选项一律只显示「作答侧」的文本，绝不附带答案侧信息
    $("#q-opts").innerHTML = q.options.map((o, i) => `
      <button class="opt" data-i="${i}">
        <span class="key">${LETTERS[i]}</span>
        <span class="txt">${esc(q.type === "en2cn" ? o.meaning : o.word)}</span>
      </button>`).join("");

    $("#instant-fb").className = "instant hidden";
    $("#btn-next").disabled = true;
    $("#btn-next").textContent = state.idx === n - 1 ? "提交并生成分析 →" : "下一题 →";
    $$("#q-opts .opt").forEach(b => b.addEventListener("click", () => answer(+b.dataset.i)));
    const spk = $(".spk");
    if (spk) spk.addEventListener("click", e => { e.stopPropagation(); speak(spk.dataset.say); });
  }

  function answer(i) {
    if (state.locked && state.instant) return;
    const q = state.questions[state.idx];
    if (state.instant) {
      state.locked = true;
      const opts = $$("#q-opts .opt");
      const ok = q.options[i].correct;
      opts.forEach((b, k) => {
        b.disabled = true;
        if (q.options[k].correct) b.classList.add("right");
        else if (k === i) b.classList.add("wrong");
      });
      const fb = $("#instant-fb");
      const right = q.options[q.answerIndex];
      const pick = q.options[i];
      fb.className = "instant " + (ok ? "ok" : "no");
      if (ok) {
        fb.innerHTML = `<span class="ic">✓</span><span>答对了。<b>${esc(q.word)}</b> ${esc(q.pos)} ${esc(q.meaning)}</span>`;
      } else if (q.type === "en2cn") {
        // 作答侧是中文：指出你选的那条释义其实属于哪个词
        fb.innerHTML = `<span class="ic">✕</span><span>正确答案是「<b>${esc(right.meaning)}</b>」。<br>
          你选的「${esc(pick.meaning)}」是 <b>${esc(pick.word)}</b> 的意思。</span>`;
      } else {
        fb.innerHTML = `<span class="ic">✕</span><span>正确答案是 <b>${esc(right.word)}</b>（${esc(right.pos)} ${esc(right.meaning)}）。<br>
          你选的 <b>${esc(pick.word)}</b> 释义为：${esc(pick.meaning)}。</span>`;
      }
      state.answers[state.idx] = { choice: i, correct: ok, ms: Date.now() - state.qStart };
      $("#btn-next").disabled = false;
      $("#q-dots").innerHTML = state.questions.map((_, k) => {
        const a = state.answers[k];
        let cls = a ? (a.correct ? "ok" : "no") : "";
        if (k === state.idx) cls += " cur";
        return `<i class="${cls}"></i>`;
      }).join("");
    } else {
      state.answers[state.idx] = { choice: i, correct: q.options[i].correct, ms: Date.now() - state.qStart };
      next();
    }
  }

  function next() {
    if (state.idx < state.questions.length - 1) {
      state.idx++;
      renderQuestion();
    } else {
      finish();
    }
  }

  /* =========================================================
     成绩分析
     ========================================================= */
  function analyze() {
    const qs = state.questions, as = state.answers;
    const total = qs.length;
    const correct = as.filter(a => a && a.correct).length;
    const score = Math.round((correct / total) * 100);

    const byTier = {}, byType = {}, byPos = {};
    qs.forEach((q, i) => {
      const ok = as[i] && as[i].correct;
      [[byTier, q.tier], [byType, q.type], [byPos, q.pos]].forEach(([bucket, key]) => {
        bucket[key] = bucket[key] || { n: 0, ok: 0 };
        bucket[key].n++; if (ok) bucket[key].ok++;
      });
    });

    const rate = b => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, Math.round((v.ok / v.n) * 100)]));
    const rt = rate(byTier), rtype = rate(byType), rpos = rate(byPos);

    const avgMs = Math.round(as.reduce((s, a) => s + (a ? a.ms : 0), 0) / total / 1000 * 10) / 10;
    const wrong = qs.filter((q, i) => !as[i] || !as[i].correct);
    const guessed = qs.filter((q, i) => as[i] && as[i].correct && as[i].ms < 2600).length;
    const doubtful = qs.filter((q, i) => as[i] && as[i].correct && as[i].ms > 9000).length;

    return { total, correct, score, wrong, byTier: rt, byType: rtype, byPos: rpos, avgMs, guessed, doubtful, qs, as };
  }

  function gradeOf(score) {
    if (score >= 95) return { label: "词汇精熟", color: "var(--violet)", bg: "var(--violet-l)", desc: "已达高考高分段的词汇稳定度" };
    if (score >= 85) return { label: "掌握良好", color: "var(--green)", bg: "var(--green-l)", desc: "基础扎实，重点补齐难点词" };
    if (score >= 70) return { label: "基本达标", color: "var(--brand)", bg: "var(--brand-l)", desc: "核心词够用，进阶词需加固" };
    if (score >= 55) return { label: "需要巩固", color: "var(--amber)", bg: "var(--amber-l)", desc: "词汇量不足，先抓高频核心" };
    return { label: "基础薄弱", color: "var(--red)", bg: "var(--red-l)", desc: "建议从核心高频词重新起步" };
  }

  function renderReport() {
    const r = analyze();
    lastResult = r;
    const g = gradeOf(r.score);
    const R = 78, C = 2 * Math.PI * R;

    $("#stu-quiz").classList.add("hidden");
    $("#stu-report").classList.remove("hidden");
    window.scrollTo({ top: 0, behavior: "smooth" });

    const weakTier = Object.entries(r.byTier).sort((a, b) => a[1] - b[1])[0];
    const strongTier = Object.entries(r.byTier).sort((a, b) => b[1] - a[1])[0];
    const weakType = Object.entries(r.byType).sort((a, b) => a[1] - b[1])[0];

    $("#report-head").innerHTML = `
      <div class="score-ring">
        <svg width="200" height="200" viewBox="0 0 200 200">
          <circle cx="100" cy="100" r="${R}" fill="none" stroke="#eef1f8" stroke-width="14"/>
          <circle cx="100" cy="100" r="${R}" fill="none" stroke="${g.color}" stroke-width="14" stroke-linecap="round"
            stroke-dasharray="${C}" stroke-dashoffset="${C}" id="ring-anim"/>
        </svg>
        <div class="val"><div><b style="color:${g.color}">${r.score}</b><small>分 / 100</small></div></div>
      </div>
      <div>
        <div class="rp-grade">
          <h2>词汇掌握度分析报告</h2>
          <span class="badge" style="background:${g.bg};color:${g.color}">${g.label}</span>
        </div>
        <p class="rp-sum">本次共 ${r.total} 题，答对 <b>${r.correct}</b> 题，答错 <b>${r.total - r.correct}</b> 题。${g.desc}。
        ${weakTier ? `四项能力中最薄弱的是「${TIERS[weakTier[0]].name}」（正确率 ${weakTier[1]}%），
        表现最稳的是「${TIERS[strongTier[0]].name}」（${strongTier[1]}%）。` : ""}
        ${weakType && weakType[1] < 80 ? `题型上，<b>${TYPES[weakType[0]].name}</b>正确率仅 ${weakType[1]}%，说明「${weakType[0] === "cn2en" ? "会认不会写、拼写提取慢" : "词义辨识不牢、看到英文想不起中文"}」是当前主要瓶颈。` : ""}</p>
        <div class="rp-quick">
          <div><span>${r.avgMs}s</span><small>平均每题耗时</small></div>
          <div><span>${r.guessed}</span><small>瞬时作答（疑猜）</small></div>
          <div><span>${r.doubtful}</span><small>超时犹豫题</small></div>
          <div><span>${r.total - r.correct}</span><small>需回炉词条</small></div>
        </div>
      </div>`;

    requestAnimationFrame(() => {
      const ring = $("#ring-anim");
      if (ring) {
        ring.style.transition = "stroke-dashoffset 1.1s cubic-bezier(.2,.8,.2,1)";
        ring.style.strokeDashoffset = String(C * (1 - r.score / 100));
      }
    });

    /* 维度条形图 */
    const bar = (label, pct, color) => `
      <div class="bar-row">
        <div class="lbl"><span>${label}</span><b style="color:${color}">${pct}%</b></div>
        <div class="bar"><span style="width:${pct}%;background:${color}"></span></div>
      </div>`;
    const colOf = p => p >= 85 ? "var(--green)" : p >= 65 ? "var(--brand)" : "var(--red)";

    $("#tier-bars").innerHTML = Object.keys(TIERS)
      .filter(k => r.byTier[k] !== undefined)
      .map(k => bar(`${TIERS[k].name}<small style="color:var(--ink-3);font-weight:400"> · ${TIERS[k].desc}</small>`, r.byTier[k], colOf(r.byTier[k]))).join("");

    $("#type-bars").innerHTML = Object.keys(TYPES)
      .filter(k => r.byType[k] !== undefined)
      .map(k => bar(`${TYPES[k].name}<small style="color:var(--ink-3);font-weight:400"> · ${TYPES[k].desc}</small>`, r.byType[k], colOf(r.byType[k]))).join("")
      + (Object.keys(r.byPos).length ? `<div style="margin-top:16px;font-size:12px;color:var(--ink-3);letter-spacing:.3px">按词性（题量 ≥ 2 时列入）</div>` +
        Object.entries(r.byPos).filter(([, v]) => v.n ? true : true).sort((a, b) => b[1] - a[1]).slice(0, 6)
          .map(([k, v]) => `<div class="bar-row"><div class="lbl"><span>${POS_CN[k] || k}</span><b style="color:${colOf(v)}">${v}%</b></div>
          <div class="bar"><span style="width:${v}%;background:${colOf(v)}"></span></div></div>`).join("") : "");

    /* 错词表 */
    const rows = r.wrong.map(q => {
      const a = r.as[q.id];
      const chosen = a ? q.options[a.choice] : null;
      return `<tr>
        <td><div class="w">${esc(q.word)}</div><div class="ph">/${esc(q.phon || "")}/</div></td>
        <td>${esc(q.pos)} ${esc(q.meaning)}</td>
        <td>${chosen && !chosen.correct ? `<span class="mini" style="color:var(--red);background:var(--red-l)">误选 ${esc(chosen.word)}</span>` : `<span class="mini">未作答</span>`}</td>
        <td><span class="mini">${TIERS[q.tier].name}</span></td>
      </tr>`;
    }).join("");
    $("#wrong-count").textContent = r.wrong.length ? `共 ${r.wrong.length} 个` : "";
    $("#wrong-table").innerHTML = rows
      ? `<table class="tb"><thead><tr><th>词条</th><th>正确释义</th><th>你的作答</th><th>难度层</th></tr></thead><tbody>${rows}</tbody></table>`
      : `<p class="empty-note">本次没有错题 —— 建议直接进入「低频难词」档位，或把题量提到 40 题做一次更严格的探测。</p>`;

    /* 诊断结论 */
    const diags = [];
    if (r.byTier.core !== undefined && r.byTier.core < 80) diags.push(["核心高频词未稳住", `高频词正确率 ${r.byTier.core}%，低于 80% 的安全线。这部分词直接影响阅读速度与写作表达，是提分性价比最高的区域，应优先回炉。`]);
    if (r.byTier.mid !== undefined && r.byTier.mid < 65) diags.push(["中频进阶词是断层区", `中频词正确率仅 ${r.byTier.mid}%。这类词多出现在完形填空与七选五的干扰句中，认得出但想不准，考试中极易连错。`]);
    if (r.byTier.high !== undefined && r.byTier.high >= 70) diags.push(["难词区表现反超", `低频难词正确率 ${r.byTier.high}%，反而高于其他档位，说明你更熟悉「生词表」式记忆，对常见词的多义、搭配掌握不足 —— 这是典型的「背过但没吃透」。`]);
    if (r.byType.cn2en !== undefined && r.byType.cn2en < 75) diags.push(["输出侧（中→英）薄弱", `中译英正确率 ${r.byType.cn2en}%。说明词汇停留在「被动识别」，写作时调不出来。需要从「看词想义」切换到「看义想词」。`]);
    if (r.byType.en2cn !== undefined && r.byType.en2cn < 75) diags.push(["词义辨识不稳", `英译中正确率 ${r.byType.en2cn}%。多为近义干扰或一词多义造成的误判，建议按词根/语境成组记忆。`]);
    if (r.guessed >= Math.max(2, Math.round(r.total * 0.2))) diags.push(["作答偏快，可能存在猜测", `${r.guessed} 题在 2.6 秒内完成，远快于平均 ${r.avgMs} 秒。若这些题恰好答对，说明掌握并不牢靠，容易被考场上的干扰项反噬。`]);
    if (r.avgMs > 13) diags.push(["提取速度偏慢", `平均每题 ${r.avgMs} 秒，超过 13 秒的「熟练线」。高考阅读对词汇的调用要求是「秒级反应」，建议增加限时闪卡训练。`]);
    if (!diags.length) diags.push(["整体状态健康", `各维度均在安全线以上，接下来应把练习重心从「认识」转向「用对」：结合语境、搭配和一词多义做深度加工。`]);

    $("#diagnosis").innerHTML = `<ul class="list-num">${diags.map(([t, d]) => `<li><div><b style="color:var(--ink)">${t}</b><br>${d}</div></li>`).join("")}</ul>`;

    /* 学习建议 */
    const weakWords = r.wrong.slice(0, 8);
    const plan = [];
    plan.push(["第 1–3 天：错词集中清算", `把下方 ${r.wrong.length} 个错词做成卡片，正面英文、背面"词性＋核心义＋一个自己写的短句"。每天早中晚各过 1 遍，只保留仍会错的，逐轮筛减。`]);
    if (weakTier) plan.push([`第 4–10 天：主攻「${TIERS[weakTier[0]].name}」`, `每天 25 词，采用「3-2-1 复现法」：当天记 3 遍、次日 2 遍、第 3 天 1 遍。这一档是你当前正确率最低（${weakTier[1]}%）的区域，提分最快。`]);
    if (r.byType.cn2en !== undefined && r.byType.cn2en < 85) plan.push(["贯穿全程：反向默写", `遮住英文，看中文释义默写单词，并在纸上标注重音位置。每天 15 个，专挑"看着眼熟但拼不准"的词 —— 这正是中译英失分的主因。`]);
    plan.push(["第 11–14 天：语境固化", `精读 2 篇高考真题阅读，把今天错的词在原文中划出来，抄写整句。孤立记词 7 天会忘掉约 60%，放进句子里能保留 80% 以上。`]);
    plan.push(["第 15 天：回测", `用同一套测验的「${weakTier ? TIERS[weakTier[0]].name : "混合"}」档位再测一次，题量 30 题。正确率提升 15 个百分点以上，说明方法有效；若无变化，需减少词量、增加复现频次。`]);

    $("#plan").innerHTML = `<ul class="list-num">${plan.map(([t, d]) => `<li><div><b style="color:var(--ink)">${t}</b><br>${d}</div></li>`).join("")}</ul>`;

    const methods = [
      ["词根词缀法", "如 <b>con-</b>（共同）+ <b>trib</b>（给予）→ contribute 贡献、tribute 致敬。掌握 60 个高频词根可覆盖约 1500 词。"],
      ["一词多义优先", `高考真正考的是「熟词僻义」，如 <b>address</b> 不只是"地址"（还有「处理、演讲」），<b>book</b> 不只是「书」（还有「预订」）。`],
      ["搭配记忆法", "记 <b>make a difference</b> 而不是单独记 difference；记 <b>be committed to doing</b> 而不是 commit。搭配记牢，完形填空直接受益。"],
      ["间隔重复", "按 1 天 / 2 天 / 4 天 / 7 天 / 15 天 的节奏复现。用错题本或闪卡 App 自动排程，比「每天背 50 个新词」有效得多。"]
    ];
    $("#methods").innerHTML = `<div class="tips">${methods.map(([t, d]) => `<div class="tip"><b>${t}</b>${d}</div>`).join("")}</div>`;

    /* 生成空白习题 */
    renderWorksheet(r);
  }

  /* =========================================================
     空白习题纸
     ========================================================= */
  const W = v => ({ w: v.w || v.word, p: v.p || v.pos, m: v.m || v.meaning, ph: v.ph || v.phon || "" });

  function renderWorksheet(r) {
    // 统一成 {w,p,m,ph}
    const wrongWords = r.wrong.map(q => W(q));
    const wrongSet = new Set(wrongWords.map(v => v.w));
    // 用本次题目里的词补足到 12 个，优先非核心词
    let base = [...wrongWords];
    const extras = r.qs.filter(q => !wrongSet.has(q.word) && q.tier !== "core").map(W);
    base = base.concat(shuffle(extras)).slice(0, 14);
    if (base.length < 8) {
      base = base.concat(pick(state.vocab.map(W).filter(v => !base.some(b => b.w === v.w)), 8 - base.length));
    }
    state.worksheetWords = base;

    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const A = shuffle(base), B = shuffle(base).slice(0, Math.min(6, base.length));
    const C = shuffle(base).slice(0, Math.min(8, base.length));

    /* Part 1 英译中（含例句填空位） */
    const p1 = A.map(v => `
      <li><div class="inl"><b>${esc(v.w)}</b> <span style="font-family:var(--mono);font-size:12px;color:var(--ink-3)">/${esc(v.ph || "")}/</span>
      <span class="ans-line" style="min-width:200px"></span><div class="sug"></div></div></li>`).join("");

    /* Part 2 中译英 */
    const p2 = B.map(v => `<li><div class="inl">${esc(v.p)} ${esc(v.m)}<span class="ans-line"></span></div></li>`).join("");

    /* Part 3 首字母填空（语境句）—— 用释义提示，避免错误例句 */
    const p3 = C.map(v => {
      const first = v.w[0], rest = Math.max(2, v.w.length - 1 - Math.floor(v.w.length * 0.3));
      const blanks = "_".repeat(Math.min(12, rest));
      return `<li><div class="inl">${esc(v.p)} ${esc(v.m)} 　→　<b>${esc(first.toUpperCase())}${blanks}</b>（${v.w.length} 个字母）</div></li>`;
    }).join("");

    /* Part 4 词形转换：用同一词 + 常见后缀做提示 */
    const p4words = shuffle(base).slice(0, 4);
    const p4 = p4words.map(v => `<li><div class="inl"><b>${esc(v.w)}</b>（${esc(v.p)} ${esc(v.m)}）
      　写出其 <span style="letter-spacing:1px">形容词 / 名词</span> 形式：<span class="ans-line" style="min-width:120px"></span></div></li>`).join("");

    /* Part 5 选词填空（词库 + 5 句释义句） */
    const bank = shuffle(base).slice(0, 6);
    const p5 = bank.map((v, i) => `<li><div class="inl">第 ${i + 1} 句所用单词的中文意思是：
      <b>${esc(v.m)}</b>（${esc(v.p)}），该词是 <span class="ans-line" style="min-width:140px"></span></div></li>`).join("");
    const bankHtml = `<div class="wordbank">${bank.map((v, i) => `<div>${String.fromCharCode(65 + i)}. ${esc(v.w)}</div>`).join("")}</div>`;

    $("#worksheet").innerHTML = `
      <div class="paper-head">
        <h2>高中英语 3500 词 · 个性化巩固练习</h2>
        <div class="line">依据本次测验结果自动生成 · 共 5 个部分 · 建议限时 25 分钟</div>
      </div>
      <div class="paper-info">
        <div>姓名：<span></span></div><div>班级：<span></span></div><div>日期：<span>${dateStr}</span></div><div>得分：<span></span></div>
      </div>

      <div class="paper-part">
        <h3>Part I　写出中文释义（每词 2 分，共 ${base.length} 题）</h3>
        <div class="note">要求写出该词在高中阶段的<b>核心义项</b>，可附词性。会的先跳过，回头再补。</div>
        <ol>${p1}</ol>
      </div>

      <div class="paper-part">
        <h3>Part II　根据中文写出英文（每题 2 分，共 ${B.length} 题）</h3>
        <div class="note">注意<b>拼写、双写辅音、不发音字母</b>；写完后用红笔自查一遍。</div>
        <ol>${p2}</ol>
      </div>

      <div class="paper-part">
        <h3>Part III　首字母提示拼写（每题 1 分，共 ${C.length} 题）</h3>
        <div class="note">根据词性与释义补全单词，字母数已给出。</div>
        <ol>${p3}</ol>
      </div>

      <div class="paper-part">
        <h3>Part IV　词形转换（每题 2 分，共 ${p4words.length} 题）</h3>
        <div class="note">高考语法填空高频考法：给出原词，写出括号内要求的派生形式。</div>
        <ol>${p4}</ol>
      </div>

      <div class="paper-part">
        <h3>Part V　词义匹配（每题 1 分，共 ${bank.length} 题）</h3>
        <div class="note">从上方词库中选出与下列中文释义对应的单词，把字母写在横线上，每个词只用一次。</div>
        ${bankHtml}
        <ol>${p5}</ol>
      </div>

      <div class="paper-part">
        <h3>Part VI　造句应用（每题 5 分，任选 4 题）</h3>
        <div class="note">从错词中任选 4 个，各写一个不少于 8 词的完整句子，要求体现该词的常见搭配。</div>
        <ol>${shuffle(base).slice(0, 4).map(v => `<li><div class="inl"><b>${esc(v.w)}</b>：<div style="border-bottom:1px solid #dfe5f0;height:26px"></div><div style="border-bottom:1px solid #dfe5f0;height:26px"></div></div></li>`).join("")}</ol>
      </div>

      <div class="answerkey">
        <h4>参考答案（自测后使用）</h4>
        <div class="kv">${base.map(v => `<div>${esc(v.w)} — ${esc(v.p)} ${esc(v.m)}</div>`).join("")}</div>
      </div>`;
  }

/* =========================================================
   流程控制：角色路由 → 教师端 → 学生端
   ========================================================= */

  /* ---------- 通用 UI ---------- */
  function modal(title, html, onOk, okText) {
    $("#modal-title").textContent = title;
    $("#modal-body").innerHTML = html;
    $("#modal-ok").textContent = okText || "确定";
    $("#modal").classList.remove("hidden");
    $("#modal-ok").onclick = () => { $("#modal").classList.add("hidden"); onOk && onOk(); };
    $("#modal-cancel").onclick = () => $("#modal").classList.add("hidden");
  }
  function askText(title, placeholder, cb) {
    modal(title, `<input class="inp" id="modal-input" placeholder="${esc(placeholder)}" style="width:100%">`,
      () => cb($("#modal-input").value.trim()));
    setTimeout(() => { const i = $("#modal-input"); if (i) i.focus(); }, 30);
  }

  /* =========================================================
     测验分享：8 位暗号短链接（详见 share.js 顶部说明）

     静态页面没有后端，没法按需建短链，所以试卷密文随页面发布，
     链接里只放 8 位暗号。老师端「发布短链接」时把卷面写进
     data/vials.json，再由打包脚本生成密钥瓶。
     ========================================================= */
  const SHARE_STAGE = "gk3500_share_stage_v1";

  function readStage() {
    try {
      const d = JSON.parse(localStorage.getItem(SHARE_STAGE) || "{}");
      return { pw: d.pw || "", list: Array.isArray(d.list) ? d.list : [] };
    } catch { return { pw: "", list: [] }; }
  }
  function writeStage(stage) {
    localStorage.setItem(SHARE_STAGE, JSON.stringify(stage));
  }

  /* 用与正式答题完全一致的算法预组卷，把卷面固化下来 */
  function buildQuizPayload(q) {
    const bank = q.bankId ? Store.getBank(q.bankId) : null;
    const prevVocab = state.vocab, prevMode = state.mode, prevCount = state.count;
    const prevTypes = state.types, prevInstant = state.instant, prevQuestions = state.questions;

    state.vocab = bank && bank.items.length
      ? bank.items.map((v, i) => ({ ...v, tier: tierOf(i, bank.items.length) }))
      : builtinVocab.map((v, i) => ({ ...v, tier: tierOf(i, builtinVocab.length) }));
    state.mode = "mixed";
    state.count = Math.min(q.count, state.vocab.length);
    state.types = q.types && q.types.length ? q.types : ["en2cn", "cn2en"];
    state.instant = q.instant !== false;
    state.questions = buildQuestions();

    const questions = state.questions.map(x => ({
      type: x.type,
      options: x.options.map(o => ({
        word: o.word, meaning: o.meaning, pos: o.pos || x.pos || "", correct: !!o.correct
      }))
    }));

    state.vocab = prevVocab; state.mode = prevMode; state.count = prevCount;
    state.types = prevTypes; state.instant = prevInstant; state.questions = prevQuestions;

    return { id: q.id, c: q.code, n: q.name, m: q.minutes, i: q.instant !== false, q: questions };
  }

  /* 把一份试卷登记进待发布批次，返回概览 */
  function stageQuiz(q) {
    const stage = readStage();
    const payload = buildQuizPayload(q);
    const k = stage.list.findIndex(x => x.id === q.id);
    if (k >= 0) stage.list[k] = payload; else stage.list.push(payload);
    writeStage(stage);
    return { stage, index: stage.list.findIndex(x => x.id === q.id), payload };
  }

  function downloadJson(name, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  /* =========================================================
     习题下载：只导出「空白习题」本身
     不含得分/诊断/方案/方法等评价内容，方便直接发给学生做。
     多种格式：PDF（浏览器另存）/ Word（docx 兼容 HTML）/ HTML
     ========================================================= */
  const DL_FILE = (r) => {
    const who = (r && r.studentName && r.studentName !== "匿名学生") ? r.studentName : "";
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    return `词汇巩固练习${who ? "_" + who : ""}_${stamp}`;
  };

  /* 取出习题纸的可打印 DOM（深拷贝，保证屏幕样式不被改动） */
  function worksheetNode(includeKey) {
    const src = $("#worksheet");
    if (!src || !src.innerHTML.trim()) return null;
    const box = document.createElement("div");
    box.className = "paper";
    box.innerHTML = src.innerHTML;
    if (!includeKey) {
      box.querySelectorAll(".answerkey").forEach(el => el.remove());
    }
    // 清掉屏幕端的交互残留
    box.querySelectorAll(".sug").forEach(el => el.remove());
    return box;
  }

  /* 独立文档样式：纸张 A4、正文黑字、去掉卡片阴影 */
  const PAPER_CSS = `
    @page{size:A4;margin:16mm 15mm}
    *{box-sizing:border-box}
    body{margin:0;padding:0;background:#fff;color:#1b2030;
      font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
      font-size:13.5px;line-height:1.75;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .paper{max-width:174mm;margin:0 auto;padding:0}
    .paper-head{text-align:center;border-bottom:2px solid #1b2030;padding-bottom:14px;margin-bottom:4px}
    .paper-head h2{font-size:19px;margin:0;letter-spacing:.5px}
    .paper-head .line{color:#6b7280;font-size:12px;margin-top:6px}
    .paper-info{display:flex;justify-content:space-between;gap:14px;font-size:12.5px;color:#374151;
      padding:12px 0 0;flex-wrap:wrap;border-bottom:1px dashed #dfe3ec;padding-bottom:10px}
    .paper-info span{border-bottom:1px solid #c3cbe0;min-width:100px;display:inline-block;padding:0 6px 2px}
    .paper-part{margin-top:26px;page-break-inside:auto}
    .paper-part h3{font-size:14px;margin:0 0 6px;padding-left:10px;border-left:4px solid #3355d1}
    .paper-part .note{font-size:11.5px;color:#6b7280;margin:0 0 12px;padding-left:14px}
    .paper-part ol{list-style:none;counter-reset:q;margin:0;padding:0;display:grid;gap:12px}
    .paper-part li{counter-increment:q;display:flex;gap:10px;font-size:13px;line-height:1.9;
      page-break-inside:avoid;break-inside:avoid}
    .paper-part li:before{content:counter(q,decimal-leading-zero);font-family:ui-monospace,Menlo,monospace;
      font-size:11px;color:#9aa3b5;flex:none;width:22px;padding-top:2px}
    .paper-part .inl{flex:1}
    .paper-part .ans-line{display:inline-block;min-width:120px;border-bottom:1px solid #c3cbe0;
      height:1.5em;vertical-align:-4px;margin:0 6px}
    .wordbank{display:grid;grid-template-columns:repeat(3,1fr);gap:7px 14px;font-size:13px;
      border:1px solid #dfe3ec;border-radius:7px;padding:11px 14px;margin:0 0 15px;background:#fafbfe}
    .answerkey{margin-top:30px;padding-top:14px;border-top:2px solid #1b2030;page-break-before:auto}
    .answerkey h4{font-size:13px;margin:0 0 9px}
    .answerkey .kv{display:grid;grid-template-columns:1fr 1fr;gap:4px 20px;font-size:12px;color:#374151}
    b{font-weight:600}
  `;

  function worksheetHtml(includeKey) {
    const node = worksheetNode(includeKey);
    if (!node) return null;
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>词汇巩固练习</title><style>${PAPER_CSS}</style></head><body>${node.outerHTML}</body></html>`;
  }

  /* 方式 A：生成 PDF（走浏览器打印面板的「另存为 PDF」，不弹网页打印） */
  function worksheetPdf(includeKey) {
    const node = worksheetNode(includeKey);
    if (!node) return toast("还没有可下载的习题");
    const ifr = document.createElement("iframe");
    ifr.setAttribute("aria-hidden", "true");
    ifr.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0";
    document.body.appendChild(ifr);
    const doc = ifr.contentDocument || ifr.contentWindow.document;
    doc.open();
    doc.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
      <title>${esc(DL_FILE(currentResult()))}</title><style>${PAPER_CSS}</style></head>
      <body>${node.outerHTML}</body></html>`);
    doc.close();
    const fire = () => {
      try {
        ifr.contentWindow.focus();
        ifr.contentWindow.print();
        toast("在打印窗口的「目标打印机」里选「另存为 PDF」即可保存");
      } catch (e) {
        toast("PDF 导出失败，请改用「下载 Word」");
      }
      setTimeout(() => ifr.remove(), 60000);
    };
    if (doc.readyState === "complete") setTimeout(fire, 200);
    else ifr.onload = () => setTimeout(fire, 200);
  }

  /* 方式 B：下载 Word（.doc，Word/WPS 原生可打开并继续编辑） */
  function worksheetWord(includeKey) {
    const html = worksheetHtml(includeKey);
    if (!html) return toast("还没有可下载的习题");
    const head = `<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
      <head><meta charset="utf-8"><title>词汇巩固练习</title>
      <!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom>
      </w:WordDocument></xml><![endif]-->
      <style>@page{size:A4;margin:2cm 1.8cm}${PAPER_CSS.replace(/@page\{[^}]*\}/, "")}
      body{font-family:"宋体",SimSun,sans-serif}.paper-part h3,.paper-head h2{font-family:"黑体",SimHei,sans-serif}
      </style></head><body>`;
    const doc = head + html.replace(/^[\s\S]*?<body>/, "").replace(/<\/body>[\s\S]*$/, "") + "</body></html>";
    const blob = new Blob(["\ufeff", doc], { type: "application/msword;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = DL_FILE(currentResult()) + ".doc";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast("Word 文件已下载，可用 Word / WPS 直接编辑或打印");
  }

  let lastResult = null;
  const currentResult = () => lastResult || {};

  /* 下载面板 */
  function showDownloadSheet() {
    if (!state.worksheetWords || !state.worksheetWords.length) {
      toast("还没有生成习题，请先完成一次测验");
      return;
    }
    modal("下载巩固练习", `
      <div class="dl-sheet">
        <div class="dl-lead">只下载<b>习题本身</b>（题目 + 答题横线），不含得分、诊断、提升方案等评价内容。</div>
        <label class="dl-row">
          <input type="checkbox" id="dl-key" checked>
          <div><b>附参考答案页</b><span>答案单独排在最后一页，可撕下</span></div>
        </label>
        <div class="dl-grid">
          <button class="dl-btn primary" id="dl-pdf">
            <span class="dl-ico">📄</span>
            <span class="dl-t"><b>下载 PDF</b><i>排版固定，适合打印/发群</i></span>
          </button>
          <button class="dl-btn" id="dl-doc">
            <span class="dl-ico">📝</span>
            <span class="dl-t"><b>下载 Word</b><i>可编辑，改题目/加校名</i></span>
          </button>
          <button class="dl-btn" id="dl-html">
            <span class="dl-ico">🌐</span>
            <span class="dl-t"><b>下载网页文件</b><i>单个 .html，手机可直接看</i></span>
          </button>
        </div>
        <div class="dl-foot">PDF 会打开系统打印窗口，在「目标打印机」里选 <b>另存为 PDF</b> 即可保存到本地。</div>
      </div>`, null, "关闭");

    const withKey = () => ($("#dl-key") ? $("#dl-key").checked : true);
    $("#dl-pdf").onclick = () => worksheetPdf(withKey());
    $("#dl-doc").onclick = () => worksheetWord(withKey());
    $("#dl-html").onclick = () => {
      const html = worksheetHtml(withKey());
      if (!html) return toast("还没有可下载的习题");
      const blob = new Blob([html], { type: "text/html;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = DL_FILE(currentResult()) + ".html";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast("网页文件已下载，双击即可打开");
    };
  }

  function showQuizShare(q) {
    const staged = (() => {
      try { return stageQuiz(q); } catch (e) { return { err: e.message }; }
    })();
    if (staged.err) {
      modal("生成失败", `<div class="share-err">组卷失败：${esc(staged.err)}</div>`);
      return;
    }
    const { stage, index } = staged;
    const total = stage.list.length;
    const aliasCandidate = window.ShareCodec.hasVial() && index < window.ShareCodec.toc().count
      ? window.ShareCodec.aliasAt(index) : "";
    const qrSize = 240;

    modal("测验已创建 · 学生扫码作答", `
      <div class="qs-head">
        <div class="qs-code">${q.code}</div>
        <div class="qs-meta">${esc(q.name)}<br>${q.count} 题 · 限时 ${q.minutes} 分钟</div>
      </div>

      <div class="qr-card" id="qr-slot">
        <div class="qr-cap">正在校验线上试卷批次…</div>
      </div>

      <div class="share-tip" style="margin-top:14px">
        <b>其他进入方式</b>
        <div>· <b>同一台电脑</b>：学生端输入测验码 <code>${q.code}</code></div>
        <div>· <b>投屏上课</b>：直接投这页二维码，全班同时扫码</div>
      </div>

      <div class="share-publish">
        <b>发布到线上批次</b>
        <div class="pub-note">
          二维码之所以能这么小，是因为试卷密文跟网页一起发布了。
          当前共有 <b>${total}</b> 份待发布试卷，导出后由系统重新打包上线。
        </div>
        <button class="btn btn-soft btn-sm" id="btn-export-vials">导出发布包（${total} 份）</button>
      </div>`, null, "知道了");

    /* 异步校验：密钥瓶 alias 解出的卷面必须与本卷完全一致（测验码 + 题数），
       否则二维码会指向批次里的另一份卷——此前新建卷直接命中 alias 就是这个错配。 */
    const verifyAndRenderQr = async () => {
      const slot = $("#qr-slot");
      if (!slot) return;
      let ok = false, link = "", alias = "";
      if (aliasCandidate) {
        try {
          const decoded = await window.ShareCodec.decode(aliasCandidate);
          ok = decoded && String(decoded.code || "").toUpperCase() === String(q.code).toUpperCase()
            && (decoded.questions || []).length === q.count;
          if (ok) { alias = aliasCandidate; link = window.ShareCodec.makeLink(alias); }
        } catch (e) { ok = false; }
      }
      if (!slot.isConnected) return;   // 弹窗已被用户关闭
      if (ok) {
        slot.innerHTML = `
          <div class="qr-frame" id="qr-frame">${window.ShareCodec.qrSvg(link, qrSize)}</div>
          <div class="qr-cap">学生用手机 <b>扫一扫</b> 即可开始作答</div>
          <div class="qr-acts">
            <button class="btn btn-primary btn-sm" id="btn-save-qr">保存二维码</button>
            <button class="btn btn-soft btn-sm" id="btn-copy-link">复制链接</button>
            <button class="btn btn-ghost btn-sm" id="btn-copy-text">复制通知文案</button>
          </div>
          <div class="qr-note">扫码或在浏览器打开均直接进入卷面 · 链接仅 ${link.length} 字符</div>
          <details class="qr-detail">
            <summary>查看链接与暗号</summary>
            <div class="sl-url" id="share-url">${esc(link)}</div>
            <div class="qr-alias">暗号 <code>${alias}</code> · 也可在首页输入此暗号进入</div>
          </details>`;
        bindQrActions(link, q);
      } else {
        slot.innerHTML = `
          <div class="share-err" style="margin:12px 0">
            这份试卷还没有发布到线上批次（线上密文与本卷不一致），二维码暂不可用。<br>
            点下方「导出发布包」，把它一起打进批次重新发布即可。
          </div>`;
      }
    };

    const copy = async (text, okMsg) => {
      try {
        await navigator.clipboard.writeText(text);
        toast(okMsg);
      } catch {
        const ta = document.createElement("textarea");
        ta.value = text; document.body.appendChild(ta); ta.select();
        document.execCommand("copy"); ta.remove();
        toast(okMsg);
      }
    };

    function bindQrActions(link, quiz) {
      const noticeText = `【${quiz.name}】英语词汇测验\n共 ${quiz.count} 题，限时 ${quiz.minutes} 分钟。\n点开链接直接作答：\n${link}\n（也可在电脑上打开链接输入测验码 ${quiz.code}）`;
      $("#btn-save-qr").onclick = () => downloadQr(link, quiz.name || quiz.code, quiz.code);
      $("#btn-copy-link").onclick = () => copy(link, "链接已复制，微信里直接粘贴发送");
      $("#btn-copy-text").onclick = () => copy(noticeText, "通知文案已复制");
    }
    verifyAndRenderQr();

    const btnExport = $("#btn-export-vials");
    if (btnExport) btnExport.onclick = () => {
      downloadJson("vials.json", { pw: stage.pw, quizzes: stage.list });
      toast("发布包已导出，交给管理员打包上线");
    };
  }

  /* 把二维码导出成高清 PNG（1024px，含白边，适合打印/投屏/发群） */
  function downloadQr(link, title, code) {
    let cv;
    try {
      cv = window.ShareCodec.qrCanvas(link, 1024);
    } catch (e) {
      toast("二维码生成失败：" + e.message);
      return;
    }
    const pad = 56, foot = 96;
    const out = document.createElement("canvas");
    out.width = cv.width + pad * 2;
    out.height = cv.height + pad * 2 + foot;
    const g = out.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, out.width, out.height);
    g.drawImage(cv, pad, pad);
    g.fillStyle = "#1f2333";
    g.textAlign = "center";
    g.font = "600 34px -apple-system,'PingFang SC','Microsoft YaHei',sans-serif";
    g.fillText("英语词汇测验 · 扫码作答", out.width / 2, out.height - foot + 44);
    g.fillStyle = "#6b7280";
    g.font = "400 26px -apple-system,'PingFang SC','Microsoft YaHei',sans-serif";
    g.fillText(`测验码 ${code}`, out.width / 2, out.height - foot + 84);

    const name = String(title || code || "quiz").replace(/[\\/:*?"<>|\s]+/g, "_");
    out.toBlob(b => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(b);
      a.download = `词汇测验二维码_${name}.png`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast("二维码已保存，可直接打印或发到班级群");
    }, "image/png");
  }

  let role = null;
  function setRole(r) {
    role = r;
    $("#view-gate").classList.toggle("hidden", !!r);
    $("#view-teacher").classList.toggle("hidden", r !== "teacher");
    $("#view-student").classList.toggle("hidden", r !== "student");
    $("#role-pill").classList.toggle("hidden", !r);
    $("#btn-switch").classList.toggle("hidden", !r);
    if (r) $("#role-pill").innerHTML = r === "teacher"
      ? `<span class="dot" style="background:var(--brand)"></span>教师端`
      : `<span class="dot" style="background:var(--green)"></span>学生端`;
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (r === "teacher") {
      renderTeacher();
      // 教师进入自动拉一次云端成绩（静默，失败只在横幅里提示）
      if (window.Cloud && window.Cloud.enabled) syncCloud(false);
    }
    if (r === "student") resetStudent();
  }

  /* =========================================================
     教师端
     ========================================================= */
  let pendingParsed = null;
  const tUI = { tab: "dash", count: 20, minutes: 15, instant: true };

  function renderTeacher() {
    renderClassSelects();
    renderBankList();
    renderQuizList();
    renderDash();
    renderRecordList();
  }

  function renderClassSelects() {
    const cls = Store.db.classes;
    const opts = cls.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
    const empty = `<option value="">（未分班）</option>`;
    ["#dash-class", "#q-class"].forEach(sel => {
      const el = $(sel); if (!el) return;
      const cur = el.value;
      el.innerHTML = sel === "#q-class" ? empty + opts : (opts || `<option value="">暂无班级</option>`);
      if (cur && [...el.options].some(o => o.value === cur)) el.value = cur;
    });
  }

  /* ---------- 学情看板 ---------- */
  function renderDash() {
    const classId = $("#dash-class").value;
    const box = $("#dash-body");
    if (!classId) {
      box.innerHTML = `<div class="card sec"><div class="empty-state">
        <div class="es-ic">🏫</div><h3>还没有班级</h3>
        <p>先新建一个班级，再上传词库、发布测验。学生交卷后数据会自动汇总到这里。</p>
        <button class="btn btn-primary btn-sm" onclick="document.getElementById('btn-add-class').click()">新建班级</button>
      </div></div>`;
      return;
    }
    const st = Store.classStats(classId);
    const clsName = (Store.db.classes.find(c => c.id === classId) || {}).name || "";
    if (!st.n) {
      box.innerHTML = `<div class="card sec">${cloudBanner()}<div class="empty-state">
        <div class="es-ic">📭</div><h3>「${esc(clsName)}」暂无作答数据</h3>
        <p>到「测验任务」发布一次测验，把测验码发给学生，交卷后这里会实时更新。</p>
        <p class="hint-line">学生交卷成绩会自动上传云端，点「成绩明细」右上角「同步云端成绩」即可拉到最新。</p>
      </div></div>`;
      return;
    }

    const distMax = Math.max(1, ...st.dist);
    const distLabels = ["0–59", "60–69", "70–79", "80–89", "90–100"];
    const distCols = ["#d33b4b", "#e0a12a", "#3f63e8", "#2f9e6b", "#7b4dd6"];
    const distHtml = st.dist.map((n, i) => `
      <div class="col">
        <div class="col-bar"><span style="height:${(n / distMax) * 100}%;background:${distCols[i]}"></span></div>
        <b>${n}</b><small>${distLabels[i]}</small>
      </div>`).join("");

    const wrongHtml = st.topWrong.length
      ? `<table class="tb"><thead><tr><th>词条</th><th>释义</th><th>错答人次</th><th>占提交比</th></tr></thead><tbody>
        ${st.topWrong.map(w => `<tr>
          <td><div class="w">${esc(w.w)}</div><div class="ph">${esc(w.p || "")}</div></td>
          <td>${esc(w.m)}</td>
          <td><span class="mini" style="color:var(--red);background:var(--red-l)">${w.n} 人</span></td>
          <td style="width:120px"><div class="bar" style="height:7px"><span style="width:${Math.min(100, w.n / st.n * 100)}%;background:var(--red)"></span></div></td>
        </tr>`).join("")}</tbody></table>`
      : `<p class="empty-note">暂无错词数据</p>`;

    const weakHtml = st.weakStudents.length
      ? `<div class="stu-grid">${st.weakStudents.map(s => `
        <div class="stu-chip">
          <div class="sc-name">${esc(s.name)}</div>
          <div class="sc-score" style="color:${s.avg < 60 ? "var(--red)" : "var(--amber)"}">${s.avg}</div>
          <div class="sc-meta">${s.times} 次测验</div>
        </div>`).join("")}</div>
        <p class="hint-line">平均分低于 70 的学生，建议单独布置错词清单与 Part I/II 练习。</p>`
      : `<p class="empty-note">本班暂无平均分低于 70 的学生 🎉</p>`;

    box.innerHTML = `
      <div class="kpi-row">
        <div class="kpi"><small>提交人次</small><b>${st.n}</b><span>参与学生 ${st.students.length} 人</span></div>
        <div class="kpi"><small>班级平均分</small><b style="color:${st.avg >= 80 ? "var(--green)" : st.avg >= 70 ? "var(--brand)" : "var(--red)"}">${st.avg}</b><span>满分 100</span></div>
        <div class="kpi"><small>及格率</small><b>${Math.round(st.dist.slice(1).reduce((a, b) => a + b, 0) / st.n * 100)}%</b><span>≥ 60 分占比</span></div>
        <div class="kpi"><small>已发布测验</small><b>${st.quizzes}</b><span>次</span></div>
      </div>

      <div class="grid-2" style="margin-top:18px">
        <div class="card sec">
          <h3>📈 分数段分布</h3>
          <div class="sub">全班所有提交记录的得分分布</div>
          <div class="hist">${distHtml}</div>
        </div>
        <div class="card sec">
          <h3>班级高频错词 Top ${st.topWrong.length || 0}</h3>
          <div class="sub">按答错人次排序，可直接用于讲评课</div>
          <div class="tbl-scroll">${wrongHtml}</div>
        </div>
      </div>

      <div class="card sec" style="margin-top:18px">
        <h3>🚨 需重点关注学生</h3>
        <div class="sub">个人平均分从低到高</div>
        ${weakHtml}
      </div>

      <div class="card sec" style="margin-top:18px">
        <h3>👥 学生成绩一览</h3>
        <div class="sub">按平均分升序，点击表头区域可导出完整数据</div>
        <div class="tbl-scroll">
          <table class="tb"><thead><tr><th>学生</th><th>测验次数</th><th>平均分</th><th>最近一次</th><th>状态</th></tr></thead><tbody>
          ${st.students.map(s => `<tr>
            <td><b>${esc(s.name)}</b></td><td>${s.times}</td>
            <td><b style="color:${s.avg >= 85 ? "var(--green)" : s.avg >= 70 ? "var(--brand)" : "var(--red)"}">${s.avg}</b></td>
            <td>${s.last}</td>
            <td><span class="mini">${s.avg >= 85 ? "稳定" : s.avg >= 70 ? "待巩固" : "需干预"}</span></td>
          </tr>`).join("")}
          </tbody></table>
        </div>
      </div>`;
  }

  /* ---------- 词库 ---------- */
  function renderBankList() {
    const banks = Store.db.banks;
    $("#bank-count").textContent = banks.length ? `共 ${banks.length} 个词库` : "还没有词库";
    $("#bank-list").innerHTML = banks.length ? banks.map(b => `
      <div class="item-row">
        <div class="ir-main">
          <div class="ir-title">${esc(b.name)}</div>
          <div class="ir-meta">${b.count} 词 · ${b.meta.mode || "—"} · ${new Date(b.createdAt).toLocaleDateString("zh-CN")}</div>
        </div>
        <button class="btn btn-ghost btn-sm" data-del-bank="${b.id}">删除</button>
      </div>`).join("") : `<p class="empty-note">上传 Word 或载入内置词库后，这里会显示你的词库列表。</p>`;

    $$("[data-del-bank]").forEach(b => b.addEventListener("click", () => {
      const bank = Store.getBank(b.dataset.delBank);
      const used = Store.db.quizzes.filter(q => q.bankId === bank.id).length;
      modal("删除词库", `<p>确定删除词库「${esc(bank.name)}」？${used ? `已被 ${used} 个测验引用，删除后不影响历史成绩。` : ""}</p>`,
        () => { Store.delBank(bank.id); renderTeacher(); });
    }));

    // 测验表单的词库下拉
    const sel = $("#q-bank");
    if (sel) {
      sel.innerHTML = banks.length
        ? banks.map(b => `<option value="${b.id}">${esc(b.name)}（${b.count} 词）</option>`).join("")
        : `<option value="">请先上传词库</option>`;
    }
  }

  /* ---------- 测验任务 ---------- */
  function renderQuizList() {
    const qs = Store.db.quizzes.slice().sort((a, b) => b.createdAt - a.createdAt);
    $("#quiz-count").textContent = qs.length ? `共 ${qs.length} 个测验` : "还没有发布测验";
    $("#quiz-list").innerHTML = qs.length ? qs.map(q => {
      const n = Store.recordsOfQuiz(q.id).length;
      const cls = (Store.db.classes.find(c => c.id === q.classId) || {}).name || "未分班";
      return `<div class="quiz-row">
        <div class="qr-code">${q.code}</div>
        <div class="qr-main">
          <div class="ir-title">${esc(q.name)}</div>
          <div class="ir-meta">${esc(q.bankName)} · ${q.count} 题 · 限时 ${q.minutes} 分钟 · ${esc(cls)}</div>
        </div>
        <div class="qr-stat"><b>${n}</b><small>人提交</small></div>
        <div class="qr-act">
          <button class="btn btn-ghost btn-sm" data-copy="${q.code}">复制码</button>
          <button class="btn btn-soft btn-sm" data-share="${q.id}">学生链接</button>
          <button class="btn btn-ghost btn-sm" data-toggle="${q.id}">${q.open ? "关闭" : "开放"}</button>
          <button class="btn btn-ghost btn-sm" data-del-quiz="${q.id}">删除</button>
        </div>
      </div>`;
    }).join("") : `<p class="empty-note">还没有测验。左侧填好信息后点击「生成测验码」。</p>`;

    $$("[data-copy]").forEach(b => b.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy); toast("测验码已复制：" + b.dataset.copy); }
      catch { toast("测验码：" + b.dataset.copy); }
    }));
    $$("[data-share]").forEach(b => b.addEventListener("click", () => {
      const quiz = (JSON.parse(localStorage.getItem("gk3500_v2") || "{}").quizzes || []).find(x => x.id === b.dataset.share);
      if (quiz) showQuizShare(quiz);
    }));
    $$("[data-toggle]").forEach(b => b.addEventListener("click", () => { Store.toggleQuiz(b.dataset.toggle); renderQuizList(); }));
    $$("[data-del-quiz]").forEach(b => b.addEventListener("click", () => {
      modal("删除测验", "<p>删除后该测验的成绩记录也会一并移除，确定继续？</p>", () => { Store.delQuiz(b.dataset.delQuiz); renderTeacher(); });
    }));
  }

  /* ---------- 成绩明细 ---------- */
  function renderRecordList() {
    const qs = Store.db.quizzes.slice().sort((a, b) => b.createdAt - a.createdAt);
    const sel = $("#rec-quiz");
    const cur = sel.value;
    sel.innerHTML = qs.length ? qs.map(q => `<option value="${q.id}">${esc(q.name)}（${q.code}）</option>`).join("")
      : `<option value="">暂无测验</option>`;
    if (cur && [...sel.options].some(o => o.value === cur)) sel.value = cur;
    renderRecords();
  }

  /* ---------- 成绩明细（支持云端成绩合并） ---------- */
  /* 云端行 → 本地记录结构，key 用于去重（同测验+同姓名+同分+同时间近似） */
  let cloudRows = [];      // 最近一次从云端拉到的原始行
  let cloudState = "idle"; // idle | loading | ok | error

  function cloudRowToRec(row) {
    const at = row.client_at ? new Date(row.client_at).getTime() : Date.now();
    return {
      quizId: "cloud_" + (row.quiz_code || ""),
      quizName: row.quiz_name || "",
      code: row.quiz_code || "",
      studentName: row.student_name || "匿名学生",
      score: row.score || 0,
      correct: row.correct || 0,
      total: row.total || 0,
      seconds: row.seconds || 0,
      wrongWords: Array.isArray(row.wrong_words) ? row.wrong_words : [],
      at,
      fromCloud: true
    };
  }

  /* 把云端成绩写进本地 Store，供看板/导出统一使用；按 (code,姓名,分数,时间) 去重 */
  function mergeCloudIntoStore() {
    if (!cloudRows.length) return { added: 0 };
    let added = 0;
    cloudRows.forEach(row => {
      const code = String(row.quiz_code || "").toUpperCase();
      let quiz = Store.db.quizzes.find(q => String(q.code || "").toUpperCase() === code);
      if (!quiz) {
        // 老师本机没有这份卷（学生在别的设备/演示卷作答）：按云端信息建档
        quiz = Store.addQuiz({
          name: row.quiz_name || `词汇测验 ${code}`,
          code, count: row.total || 0, minutes: 15, instant: true
        });
      }
      const rec = cloudRowToRec(row);
      rec.quizId = quiz.id;
      const dup = Store.db.records.some(r =>
        r.quizId === quiz.id &&
        String(r.studentName) === String(rec.studentName) &&
        Number(r.score) === Number(rec.score) &&
        Math.abs((r.at || 0) - rec.at) < 120000     // 2 分钟内视为同一条
      );
      if (!dup) { Store.addRecord(rec); added++; }
    });
    return { added };
  }

  let syncing = false;
  async function syncCloud(showToast) {
    if (!window.Cloud || !window.Cloud.enabled) {
      if (showToast) toast("云端未配置：请在 index.html 的 cloud-config 填入 Supabase 地址与 key");
      return;
    }
    if (syncing) return;
    syncing = true;
    cloudState = "loading";
    renderRecords();
    const res = await window.Cloud.pullScores("");
    syncing = false;
    if (!res.ok) {
      cloudState = "error";
      cloudError = res.error;
      renderRecords();
      if (showToast) toast("云端同步失败：" + res.error);
      return;
    }
    cloudRows = res.rows;
    cloudState = "ok";
    const { added } = mergeCloudIntoStore();
    renderRecordList();
    if (showToast) {
      if (!cloudRows.length) {
        toast(window.Cloud.cfg.teacherCode
          ? "云端暂时还没有学生提交（口令若不对也会是空的，请核对）"
          : "教师口令为空：请在 cloud-config 的 teacherCode 填入与数据库一致的口令");
      } else {
        toast(added ? `已从云端同步 ${added} 条新成绩` : `云端已是最新，共 ${cloudRows.length} 条成绩`);
      }
    }
  }
  let cloudError = "";

  function renderRecordList() {
    const qs = Store.db.quizzes.slice().sort((a, b) => b.createdAt - a.createdAt);
    const sel = $("#rec-quiz");
    const cur = sel.value;
    sel.innerHTML = qs.length ? qs.map(q => `<option value="${q.id}">${esc(q.name)}（${q.code}）</option>`).join("")
      : `<option value="">暂无测验</option>`;
    if (cur && [...sel.options].some(o => o.value === cur)) sel.value = cur;
    renderRecords();
  }

  function cloudBanner() {
    if (!window.Cloud || !window.Cloud.enabled)
      return `<div class="cloud-note">云端同步未启用，当前只显示本机成绩（可用「录入成绩码」汇总）。</div>`;
    if (cloudState === "loading") return `<div class="cloud-note">正在从云端拉取成绩…</div>`;
    if (cloudState === "error") return `<div class="cloud-note err">云端同步失败：${esc(cloudError)}</div>`;
    if (cloudState === "ok") {
      if (!cloudRows.length) {
        return `<div class="cloud-note">已连上云端，但还没有学生提交。${
          window.Cloud.cfg.teacherCode ? "" : "（教师口令未配置，请在 cloud-config 的 teacherCode 填写）"}</div>`;
      }
      const t = cloudRows[0] && cloudRows[0].client_at
        ? new Date(cloudRows[0].client_at).toLocaleString("zh-CN", { hour12: false }) : "";
      return `<div class="cloud-note ok">云端已同步 · 共 ${cloudRows.length} 条成绩${t ? ` · 最近一条 ${esc(t)}` : ""}</div>`;
    }
    return `<div class="cloud-note">点右上「同步云端成绩」拉取学生最新提交。</div>`;
  }

  function renderRecords() {
    const qid = $("#rec-quiz").value;
    const box = $("#rec-body");
    const banner = cloudBanner();

    if (!qid) { box.innerHTML = banner + `<p class="empty-note">暂无测验记录。</p>`; return; }
    const st = Store.quizStats(qid);
    if (!st.n) { box.innerHTML = banner + `<p class="empty-note">该测验暂无学生提交。</p>`; return; }
    const quiz = Store.db.quizzes.find(q => q.id === qid);
    box.innerHTML = banner + `
      <div class="kpi-row" style="margin-bottom:16px">
        <div class="kpi"><small>提交人数</small><b>${st.n}</b></div>
        <div class="kpi"><small>平均分</small><b>${st.avg}</b></div>
        <div class="kpi"><small>最高 / 最低</small><b class="kpi-dual"><span>${st.max}</span><i>/</i><span>${st.min}</span></b></div>
        <div class="kpi"><small>及格率</small><b>${st.pass}%</b></div>
      </div>
      <div class="tbl-scroll"><table class="tb"><thead><tr>
        <th>#</th><th>学生</th><th>得分</th><th>正确</th><th>用时</th><th>提交时间</th><th>主要错词</th></tr></thead><tbody>
        ${st.records.map((r, i) => `<tr>
          <td style="color:var(--ink-3)">${i + 1}</td>
          <td><b>${esc(r.studentName || "匿名")}</b></td>
          <td><b style="color:${r.score >= 85 ? "var(--green)" : r.score >= 70 ? "var(--brand)" : "var(--red)"}">${r.score}</b></td>
          <td>${r.correct}/${r.total}</td>
          <td>${Math.floor(r.seconds / 60)}分${r.seconds % 60}秒</td>
          <td style="color:var(--ink-3)">${new Date(r.at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</td>
          <td style="font-family:var(--mono);font-size:12px;color:var(--ink-2)">${(r.wrongWords || []).slice(0, 5).map(w => esc(w.w)).join(", ") || "—"}</td>
        </tr>`).join("")}
      </tbody></table></div>
      <p class="hint-line">共 ${quiz.count} 题，限时 ${quiz.minutes} 分钟。点击右上「导出 CSV」可保存完整成绩表。</p>`;
  }

  /* =========================================================
     学生端
     ========================================================= */
  let currentQuiz = null;   // 教师发布的测验 { id, name, minutes, instant, count }
  let selfMode = false;     // 自主检测（无测验码）

  function resetStudent() {
    clearInterval(state.timer);
    clearInterval(state.deadlineTimer);
    $("#stu-gate").classList.remove("hidden");
    $("#stu-quiz").classList.add("hidden");
    $("#stu-report").classList.add("hidden");
    $("#entry-tip").textContent = "";
    $("#btn-print2").classList.add("hidden");
    const last = localStorage.getItem("gk3500_name");
    if (last) $("#name-input").value = last;
  }

  function enterByCode() {
    const code = $("#code-input").value.trim().toUpperCase();
    const name = $("#name-input").value.trim();
    const tip = $("#entry-tip");

    // 分享链接模式：卷面已在手，不需要查本机数据
    if (pendingShare) {
      if (code && pendingShare.code && code !== pendingShare.code.toUpperCase()) {
        tip.className = "entry-tip err";
        tip.textContent = `当前链接对应的是「${pendingShare.code}」，与输入的测验码不一致，请核对。`;
        return;
      }
      startFromShare();
      return;
    }

    if (!code) { tip.className = "entry-tip err"; tip.textContent = "请输入测验码"; return; }
    const q = Store.getQuizByCode(code);
    if (!q) {
      // 本机没有这份测验：多半是换了设备/浏览器，引导用直连链接
      tip.className = "entry-tip err";
      tip.innerHTML = `这台设备上没有测验码「${esc(code)}」。<br>
        换手机或换电脑时，请让老师把<b>「学生直连链接」</b>发给你，点开即可作答（链接里已包含题目）。`;
      return;
    }
    if (!q.open) { tip.className = "entry-tip err"; tip.textContent = "该测验已关闭，请联系老师重新开放"; return; }
    if (!name) { tip.className = "entry-tip err"; tip.textContent = "请填写姓名，成绩需要回传给老师"; return; }
    const bank = Store.getBank(q.bankId);
    if (!bank) { tip.className = "entry-tip err"; tip.textContent = "该测验绑定的词库已被删除，请联系老师"; return; }

    localStorage.setItem("gk3500_name", name);
    currentQuiz = {
      id: q.id, code: q.code, name: q.name, minutes: q.minutes, instant: q.instant,
      count: q.count, types: q.types, classId: q.classId, bankName: q.bankName,
      studentName: name
    };
    selfMode = false;
    // 用词库作为本次题库
    state.vocab = bank.items.map((v, i) => ({ ...v, tier: tierOf(i, bank.items.length) }));
    tip.className = "entry-tip";
    tip.textContent = `已找到「${q.name}」，限时 ${q.minutes} 分钟，即将开始…`;
    setTimeout(() => { try { beginQuiz(); } catch (e) { console.error("beginQuiz failed", e); toast("启动失败：" + e.message); } }, 300);
  }

  /* =========================================================
     从分享链接进入：链接里已带完整卷面，任何设备都能作答
     ========================================================= */
  let pendingShare = null;   // 已解码的卷面，等学生填姓名后开始

  async function initFromShare(str) {
    const tip = $("#entry-tip");
    try {
      pendingShare = await window.ShareCodec.decode(str);
    } catch (e) {
      setRole("student");
      tip.className = "entry-tip err";
      tip.innerHTML = `${esc(e.message || "链接已失效")}。<br>
        请让老师重新发一次链接，或直接在下方输入 6 位测验码。`;
      return;
    }
    // 直接进学生端入口，预填测验码并提示
    setRole("student");
    $("#stu-gate").classList.remove("hidden");
    $("#stu-quiz").classList.add("hidden");
    $("#stu-report").classList.add("hidden");
    $("#code-input").value = pendingShare.code || "";
    const last = localStorage.getItem("gk3500_name");
    if (last) $("#name-input").value = last;
    // 转场动画结束后再写入提示与按钮文案，避免被 resetStudent 覆盖
    setTimeout(() => {
      const t = $("#entry-tip");
      t.className = "entry-tip ok";
      t.innerHTML = `已载入「${esc(pendingShare.name)}」· ${pendingShare.questions.length} 题 · 限时 ${pendingShare.minutes} 分钟<br>
        <b>填写姓名后点「开始测验」即可作答。</b>`;
      $("#btn-code-go").textContent = "开始测验 →";
      if (!last) $("#name-input").focus();
    }, 120);
  }

  function startFromShare() {
    const name = $("#name-input").value.trim();
    const tip = $("#entry-tip");
    if (!name) { tip.className = "entry-tip err"; tip.textContent = "请先填写姓名，成绩需要回传给老师"; return; }
    localStorage.setItem("gk3500_name", name);
    currentQuiz = {
      id: "share_" + (pendingShare.code || "x"),
      code: pendingShare.code, name: pendingShare.name,
      minutes: pendingShare.minutes, instant: pendingShare.instant,
      count: pendingShare.questions.length,
      types: ["en2cn", "cn2en"], bankName: pendingShare.bankName,
      studentName: name
    };
    selfMode = false;
    // 直接用链接里的卷面，保证与老师看到的完全一致
    state.questions = pendingShare.questions;
    state.answers = new Array(state.questions.length).fill(null);
    state.idx = 0; state.elapsed = 0; state.startedAt = Date.now();
    state.deadline = Date.now() + currentQuiz.minutes * 60 * 1000;
    state.timed = true;
    state.instant = currentQuiz.instant !== false;

    $("#stu-gate").classList.add("hidden");
    $("#stu-report").classList.add("hidden");
    $("#stu-quiz").classList.remove("hidden");
    $("#q-counter").innerHTML = `第 <b>1</b> / ${state.questions.length} 题　<span style="color:var(--ink-3)">· ${esc(currentQuiz.name)}</span>`;
    renderQuestion();
    startCountdown();
  }

  function startSelfTest() {
    currentQuiz = { id: null, name: "内置词库自主检测", minutes: 15, instant: true, count: 20, types: ["en2cn", "cn2en"], studentName: $("#name-input").value.trim() || "匿名学生" };
    selfMode = true;
    state.vocab = builtinVocab.map((v, i) => ({ ...v, tier: tierOf(i, builtinVocab.length) }));
    beginQuiz();
  }

  function beginQuiz() {
    const n = Math.min(currentQuiz.count, state.vocab.length);
    // 组卷参数
    state.mode = "mixed";
    state.count = n;
    state.types = currentQuiz.types && currentQuiz.types.length ? currentQuiz.types : ["en2cn", "cn2en"];
    state.instant = currentQuiz.instant !== false;

    state.questions = buildQuestions();
    state.answers = new Array(state.questions.length).fill(null);
    state.idx = 0; state.elapsed = 0; state.startedAt = Date.now();
    state.deadline = Date.now() + currentQuiz.minutes * 60 * 1000;

    $("#stu-gate").classList.add("hidden");
    $("#stu-report").classList.add("hidden");
    $("#stu-quiz").classList.remove("hidden");
    $("#btn-print2").classList.add("hidden");
    $("#q-counter").innerHTML = `第 <b>1</b> / ${state.questions.length} 题　<span style="color:var(--ink-3)">· ${esc(currentQuiz.name)}</span>`;

    clearInterval(state.timer);
    clearInterval(state.deadlineTimer);
    startTimer();
    startCountdown();
    renderQuestion();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function startCountdown() {
    const tick = () => {
      const left = Math.max(0, Math.round((state.deadline - Date.now()) / 1000));
      const m = String(Math.floor(left / 60)).padStart(2, "0");
      const s = String(left % 60).padStart(2, "0");
      const el = $("#countdown");
      el.textContent = `⏳ ${m}:${s}`;
      el.classList.toggle("warn", left <= 120 && left > 30);
      el.classList.toggle("danger", left <= 30);
      if (left <= 0) {
        clearInterval(state.deadlineTimer);
        clearInterval(state.timer);
        toast("时间到，已自动交卷");
        finish(true);
      }
    };
    tick();
    state.deadlineTimer = setInterval(tick, 500);
  }

  function finish(auto) {
    clearInterval(state.timer);
    clearInterval(state.deadlineTimer);
    const unanswered = state.answers.filter(a => !a).length;
    if (!auto && unanswered > 0) toast(`还有 ${unanswered} 题未作答，按错题计入`);

    // 生成报告（renderReport 内部会调用 renderWorksheet）
    renderReport();
    $("#stu-quiz").classList.add("hidden");
    $("#stu-report").classList.remove("hidden");
    $("#btn-print2").classList.remove("hidden");
    window.scrollTo({ top: 0, behavior: "smooth" });

    // 回传成绩
    submitRecord();
  }

  function submitRecord() {
    const r = analyze();
    const wrongWords = r.wrong.map(q => ({ w: q.word, m: q.meaning, p: q.pos }));
    const rec = {
      quizId: currentQuiz.id,
      quizName: currentQuiz.name,
      code: currentQuiz.code || null,
      classId: currentQuiz.classId || null,
      className: currentQuiz.classId ? ((Store.db.classes.find(c => c.id === currentQuiz.classId) || {}).name || "") : "",
      studentName: currentQuiz.studentName || "匿名学生",
      score: r.score, correct: r.correct, total: r.total,
      seconds: Math.min(currentQuiz.minutes * 60, state.elapsed),
      wrongWords,
      byTier: r.byTier, byType: r.byType, avgMs: r.avgMs, guessed: r.guessed
    };
    if (selfMode || !currentQuiz.id) {
      // 自主检测不进入班级统计，但保存在本地供回看
      localStorage.setItem("gk3500_self", JSON.stringify(rec));
      window.__lastRec = rec;
      return;
    }
    Store.addRecord(rec);
    window.__lastRec = rec;
    window.__lastWrongIdx = wrongIndexOf(rec);

    // 成绩自动上云：教师端刷新即可看到，无需学生再生成成绩码
    const tip = document.createElement("div");
    tip.className = "share-ok";
    if (window.Cloud && window.Cloud.enabled) {
      tip.innerHTML = `正在上传成绩到云端…（${esc(rec.studentName)} · ${r.score} 分）`;
      $("#stu-report").prepend(tip);
      let retry = 0;
      const doPush = () => {
        window.Cloud.pushScore(rec).then(res => {
          if (res.ok) {
            tip.innerHTML = `成绩已上传云端（${esc(rec.studentName)} · ${r.score} 分），老师那边可以直接看到，无需再发成绩码。`;
            setTimeout(() => tip.classList.add("fade"), 12000);
            return;
          }
          if (retry < 2) {                       // 网络抖动：静默重试两次
            retry++;
            tip.innerHTML = `网络不稳，正在重试上传（第 ${retry} 次）…`;
            setTimeout(doPush, 1500 * retry);
            return;
          }
          tip.innerHTML = `云端上传失败：${esc(res.error)}。成绩已保存在本机，可点「把成绩交给老师」用成绩码回传。`;
          const btn = $("#btn-score-code");
          if (btn) btn.classList.remove("hidden");
          setTimeout(() => tip.classList.add("fade"), 12000);
        });
      };
      doPush();
    } else {
      tip.innerHTML = `成绩已保存到本机（${esc(rec.studentName)} · ${r.score} 分）。当前未启用云端同步，点下方 <b>「把成绩交给老师」</b> 生成成绩码发给老师。`;
      const btn = $("#btn-score-code");
      if (btn) btn.classList.remove("hidden");
      $("#stu-report").prepend(tip);
      setTimeout(() => tip.classList.add("fade"), 10000);
    }
  }

  /* ---------- 成绩码：无后端的跨设备成绩回传 ----------
     格式 GK1.<6位测验码>.<base64url 位流>
     位流 = [姓名长 5bit][姓名 utf8 ≤12B][分数 7bit][正确 6bit]
          [总题 6bit][耗时 11bit(÷2)][错词数 5bit][错词内置索引 12bit×n]
     学生把成绩码发给老师，老师端粘贴录入即写进班级统计。 */
  const CODE_ALPHA = "ACDEFGHJKLMNPQRTUVWXY34679";

  function wrongIndexOf(rec) {
    const idx = getBuiltinIndex();
    return (rec.wrongWords || []).map(x => {
      const i = idx.get(String(x.w || "").toLowerCase());
      return i == null ? -1 : i;
    }).filter(i => i >= 0 && i < 4095);
  }
  function getBuiltinIndex() {
    if (window.__builtinIdxMap) return window.__builtinIdxMap;
    const m = new Map();
    (window.__BUILTIN_VOCAB__ || []).forEach((v, i) => m.set(String(v.w).toLowerCase(), i));
    window.__builtinIdxMap = m;
    return m;
  }
  function b64uEncode(bytes) {
    let s = "";
    const B = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
      s += B[b0 >> 2];
      s += B[((b0 & 3) << 4) | ((b1 == null ? 0 : b1) >> 4)];
      if (b1 == null) break;
      s += B[((b1 & 15) << 2) | ((b2 == null ? 0 : b2) >> 6)];
      if (b2 == null) break;
      s += B[b2 & 63];
    }
    return s;
  }
  function b64uDecode(str) {
    const B = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const out = [];
    let buf = 0, nb = 0;
    for (const ch of str) {
      const v = B.indexOf(ch);
      if (v < 0) continue;
      buf = (buf << 6) | v; nb += 6;
      if (nb >= 8) { nb -= 8; out.push((buf >> nb) & 0xff); }
    }
    return out;
  }

  function makeScoreCode(rec) {
    const shortQid = rec.code ? String(rec.code).toUpperCase().slice(0, 6) : "";
    if (!shortQid) throw new Error("该测验没有测验码，无法生成成绩码");
    const nameBytes = Array.from(new TextEncoder().encode(String(rec.studentName || "").slice(0, 8))).slice(0, 12);
    const wrongIdx = wrongIndexOf(rec);
    const bits = [];
    const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
    push(nameBytes.length, 5);
    nameBytes.forEach(b => push(b, 8));
    push(Math.max(0, Math.min(100, Math.round(rec.score))), 7);
    push(Math.max(0, Math.min(63, rec.correct)), 6);
    push(Math.max(0, Math.min(63, rec.total)), 6);
    push(Math.max(0, Math.min(2047, Math.round(rec.seconds / 2))), 11);
    push(Math.min(31, wrongIdx.length), 5);
    wrongIdx.slice(0, 31).forEach(i => push(i, 12));
    while (bits.length % 8) bits.push(0);
    const bytes = [];
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      bytes.push(b);
    }
    return `GK1.${shortQid}.${b64uEncode(bytes)}`;
  }

  function parseScoreCode(text) {
    const m = String(text || "").trim().match(/GK(\d)\.([0-9A-Za-z]{1,12})\.([A-Za-z0-9\-_]+)/);
    if (!m) throw new Error("成绩码格式不正确");
    const bytes = b64uDecode(m[3]);
    let p = 0, bitBuf = 0, bitN = 0;
    const take = n => {
      while (bitN < n) { bitBuf = (bitBuf << 8) | (bytes[p++] || 0); bitN += 8; }
      bitN -= n;
      return (bitBuf >> bitN) & ((1 << n) - 1);
    };
    const nameLen = take(5);
    const nameBytes = [];
    for (let i = 0; i < nameLen; i++) nameBytes.push(take(8));
    const studentName = new TextDecoder().decode(new Uint8Array(nameBytes)) || "匿名学生";
    const score = take(7), correct = take(6), total = take(6), sec2 = take(11);
    const wn = take(5);
    const wrongIdx = [];
    for (let i = 0; i < wn; i++) wrongIdx.push(take(12));
    return { qidShort: m[2].toUpperCase(), studentName, score, correct, total, seconds: sec2 * 2, wrongIdx };
  }

  async function importScoreCode(text) {
    const p = parseScoreCode(text);
    let quiz = Store.db.quizzes.find(q => String(q.code || "").toUpperCase() === p.qidShort)
      || Store.db.quizzes.find(q => String(q.id || "").toUpperCase().endsWith(p.qidShort));
    if (!quiz) {
      // 教师本机没有这个测验（可能是演示卷/别的设备建的）：按成绩码自动补建档，
      // 否则成绩无处可挂。先在密钥瓶里反查真实卷名，查不到就用通用名。
      let qname = `词汇测验 ${p.qidShort}`, qcount = p.total;
      try {
        const meta = window.ShareCodec.toc ? window.ShareCodec.toc() : null;
        if (meta && meta.count) {
          for (let i = 0; i < meta.count; i++) {
            const alias = window.ShareCodec.aliasAt(i);
            if (!alias) continue;
            const q = await window.ShareCodec.decode(alias);
            if (q && q.code && String(q.code).toUpperCase() === p.qidShort) {
              qname = q.name || qname;
              qcount = (q.questions || []).length || qcount;
              break;
            }
          }
        }
      } catch (e) { /* 反查失败不影响建档 */ }
      quiz = Store.addQuiz({ name: qname, code: p.qidShort, count: qcount, minutes: 15, instant: true });
    }
    const vocab = window.__BUILTIN_VOCAB__ || [];
    const rec = {
      quizId: quiz.id,
      quizName: quiz.name,
      code: quiz.code || p.qidShort,
      classId: quiz.classId || null,
      className: quiz.classId ? ((Store.db.classes.find(c => c.id === quiz.classId) || {}).name || "") : "",
      studentName: p.studentName,
      score: p.score, correct: p.correct, total: p.total,
      seconds: p.seconds,
      wrongWords: p.wrongIdx.map(i => vocab[i]).filter(Boolean).map(v => ({ w: v.w, m: v.m, p: v.p })),
      imported: true, importedAt: Date.now()
    };
    // 同一学生同一测验重复录入：覆盖旧记录，避免统计翻倍
    const old = Store.db.records.findIndex(r => r.quizId === quiz.id && r.studentName === rec.studentName);
    if (old >= 0) Store.db.records[old] = rec; else Store.addRecord(rec);
    Store.save && Store.save();
    return { quiz, rec };
  }

  /* 学生报告页：生成并展示成绩码（文本 + 二维码） */
  function showScoreCode() {
    const rec = window.__lastRec;
    if (!rec) { toast("请先完成一次测验"); return; }
    let code;
    try { code = makeScoreCode(rec); }
    catch (e) { toast(e.message); return; }
    let qr = "";
    try { qr = window.ShareCodec.qrSvg(code, 200); } catch (e) { /* 二维码失败不影响文本 */ }
    modal("把成绩交给老师", `
      <div class="sc-wrap">
        <p class="sc-lead">截图或复制下面的成绩码，发给老师；老师在「成绩明细 → 录入成绩码」里粘贴即可。</p>
        ${qr ? `<div class="sc-qr">${qr}<div class="sc-cap">老师可扫码直接读取</div></div>` : ""}
        <div class="sc-code" id="sc-code">${esc(code)}</div>
        <div class="sc-note">包含：姓名 ${esc(rec.studentName)} · ${rec.score} 分 · ${rec.correct}/${rec.total} 题</div>
        <button class="btn btn-primary btn-sm" id="btn-copy-sc">复制成绩码</button>
      </div>`, null, "完成");
    const c = $("#btn-copy-sc");
    if (c) c.onclick = async () => {
      try { await navigator.clipboard.writeText(code); toast("已复制，发给老师吧"); }
      catch (e) {
        const ta = document.createElement("textarea");
        ta.value = code; document.body.appendChild(ta); ta.select();
        document.execCommand("copy"); ta.remove(); toast("已复制，发给老师吧");
      }
    };
  }

  /* =========================================================
     事件绑定
     ========================================================= */
  function bind() {
    /* 角色 */
    $("#btn-role-teacher").addEventListener("click", () => setRole("teacher"));
    $("#btn-role-student").addEventListener("click", () => setRole("student"));
    $("#btn-switch").addEventListener("click", () => setRole(null));
    $("#brand-home").addEventListener("click", () => { if (role) setRole(null); });

    /* 教师端 tab */
    $$("#teacher-tabs .tab").forEach(t => t.addEventListener("click", () => {
      $$("#teacher-tabs .tab").forEach(x => x.classList.remove("on"));
      t.classList.add("on");
      $$(".tab-panel").forEach(p => p.classList.add("hidden"));
      $("#panel-" + t.dataset.tab).classList.remove("hidden");
    }));

    /* 班级 */
    $("#dash-class").addEventListener("change", renderDash);
    $("#btn-add-class").addEventListener("click", () => {
      askText("新建班级", "如：高一（3）班", name => {
        if (!name) return toast("班级名称不能为空");
        try { const c = Store.addClass(name); renderTeacher(); $("#dash-class").value = c.id; renderDash(); toast("已创建班级：" + name); }
        catch (e) { toast(e.message); }
      });
    });

    /* 上传 */
    const dz = $("#dropzone"), fi = $("#file-input");
    dz.addEventListener("click", () => fi.click());
    dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("over"); });
    dz.addEventListener("dragleave", () => dz.classList.remove("over"));
    dz.addEventListener("drop", e => {
      e.preventDefault(); dz.classList.remove("over");
      if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    });
    fi.addEventListener("change", e => { if (e.target.files[0]) handleFile(e.target.files[0]); });

    $("#btn-paste-parse").addEventListener("click", () => {
      const txt = $("#paste-area").value.trim();
      if (!txt) return toast("请先粘贴词表内容");
      const items = DocxParser.parseText(txt);
      if (!items.length) return toast("未能识别出词条，请检查格式（单词 + 中文释义）");
      showPreview({ items, meta: { source: "粘贴文本", mode: "文本" }, raw: items.length });
    });

    $("#btn-use-builtin").addEventListener("click", () => {
      if (!builtinVocab.length) return toast("内置词库未加载");
      const exists = Store.db.banks.find(b => b.name === "内置高考 3500 词库");
      if (exists) return toast("内置词库已在列表中");
      Store.addBank("内置高考 3500 词库", builtinVocab, { mode: "内置" });
      renderTeacher(); toast("已载入内置词库 " + builtinVocab.length + " 词");
    });

    $("#btn-save-bank").addEventListener("click", () => {
      if (!pendingParsed) return;
      const name = $("#bank-name").value.trim() || pendingParsed.meta.source || "未命名词库";
      Store.addBank(name, pendingParsed.items, pendingParsed.meta);
      pendingParsed = null;
      $("#parse-preview").classList.add("hidden");
      $("#paste-area").value = "";
      renderBankList(); renderClassSelects(); toast("词库已保存：" + name);
    });

    /* 新建测验 */
    $$("#q-count .chip").forEach(c => c.addEventListener("click", () => {
      $$("#q-count .chip").forEach(x => x.classList.remove("on")); c.classList.add("on"); tUI.count = +c.dataset.v;
    }));
    $$("#q-minutes .chip").forEach(c => c.addEventListener("click", () => {
      $$("#q-minutes .chip").forEach(x => x.classList.remove("on")); c.classList.add("on"); tUI.minutes = +c.dataset.v;
    }));
    $("#sw-instant").addEventListener("click", e => {
      tUI.instant = !tUI.instant; e.currentTarget.classList.toggle("on", tUI.instant);
    });
    $("#btn-create-quiz").addEventListener("click", () => {
      const bankId = $("#q-bank").value;
      if (!bankId) return toast("请先上传或载入词库");
      try {
        const q = Store.addQuiz({
          name: $("#q-name").value.trim(), bankId, classId: $("#q-class").value || null,
          count: tUI.count, minutes: tUI.minutes, instant: tUI.instant
        });
        $("#q-name").value = "";
        renderTeacher();
        showQuizShare(q);
      } catch (e) { toast(e.message); }
    });

    $("#rec-quiz").addEventListener("change", renderRecords);
    $("#btn-sync-cloud").addEventListener("click", () => syncCloud(true));
    $("#btn-cloud-test").addEventListener("click", async () => {
      if (!window.Cloud) return toast("cloud.js 未加载");
      if (!window.Cloud.enabled) {
        return toast("云端未配置：请把 Supabase 的 url / anonKey 填进 index.html 的 cloud-config");
      }
      toast("正在测试云端连接…");
      const r = await window.Cloud.ping();
      if (r.ok) toast("云端连接正常，教师口令有效，可以拉到成绩");
      else toast("连接失败：" + r.error);
    });
    $("#btn-export").addEventListener("click", () => {
      const qid = $("#rec-quiz").value;
      if (!qid) return toast("暂无测验可导出");
      Store.exportCSV(qid); toast("已导出 CSV");
    });
    /* 教师端：批量录入成绩码（每行一条，也接受空格分隔） */
    $("#btn-import-score").addEventListener("click", () => {
      modal("录入成绩码", `
        <p style="margin:0 0 10px;color:var(--ink-3);font-size:13px">粘贴学生发来的成绩码，每行一条，可一次录入多名学生。</p>
        <textarea class="inp" id="imp-text" rows="5" placeholder="GK1.XGFFWX.xxxxxxxx" style="width:100%"></textarea>`,
        () => {
          const lines = ($("#imp-text").value || "").split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
          let ok = 0; const errs = [];
          (async () => {
            for (const t of lines) {
              try { await importScoreCode(t); ok++; }
              catch (e) { errs.push(e.message); }
            }
            if (ok) {
              renderTeacher();
              renderRecords();
              toast(`已录入 ${ok} 条成绩${errs.length ? `，${errs.length} 条失败` : ""}`);
            } else {
              toast(errs[0] || "没有可录入的成绩码");
            }
          })();
        }, "录入");
      setTimeout(() => { const t = $("#imp-text"); if (t) t.focus(); }, 30);
    });

    /* 学生端 */
    $("#btn-code-go").addEventListener("click", enterByCode);
    $("#code-input").addEventListener("input", e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); });
    $("#code-input").addEventListener("keydown", e => { if (e.key === "Enter") enterByCode(); });
    $("#name-input").addEventListener("keydown", e => { if (e.key === "Enter") enterByCode(); });
    $("#btn-self-test").addEventListener("click", startSelfTest);

    $("#btn-next").addEventListener("click", next);
    $("#btn-quit").addEventListener("click", () => {
      const done = state.answers.filter(Boolean).length;
      modal("确认交卷", `<p>已作答 ${done} / ${state.questions.length} 题。交卷后不能再修改，确定交卷？</p>`,
        () => finish(false), "交卷");
    });
    $("#btn-again").addEventListener("click", resetStudent);
    $("#btn-retest").addEventListener("click", () => {
      if (selfMode) { startSelfTest(); }
      else { resetStudent(); toast("请重新输入测验码进入"); }
    });
    $("#btn-print").addEventListener("click", showDownloadSheet);
    $("#btn-print2").addEventListener("click", showDownloadSheet);
    $("#btn-score-code").addEventListener("click", showScoreCode);

    document.addEventListener("keydown", e => {
      const quizView = $("#stu-quiz");
      if (!quizView || quizView.classList.contains("hidden")) return;
      if (["1", "2", "3", "4"].includes(e.key)) {
        const btn = $$("#q-opts .opt")[+e.key - 1];
        if (btn && !btn.disabled) btn.click();
      }
      if (e.key === "Enter" && !$("#btn-next").disabled) next();
    });

    window.addEventListener("beforeunload", e => {
      if (role === "student" && !$("#stu-quiz").classList.contains("hidden")) {
        e.preventDefault(); e.returnValue = "";
      }
    });
  }

  /* ---------- 上传处理 ---------- */
  async function handleFile(file) {
    if (file.size > 8 * 1024 * 1024) return toast("文件过大（> 8MB），请拆分后再上传");
    const dz = $("#dropzone");
    dz.classList.add("busy");
    dz.querySelector(".drop-main").textContent = `正在解析 ${esc(file.name)} …`;
    try {
      const out = await DocxParser.parseFile(file);
      resetDrop();
      if (!out.items.length) {
        toast("未能识别词条，请检查文件格式");
        return;
      }
      showPreview(out);
    } catch (err) {
      resetDrop();
      modal("解析失败", `<p>${esc(err.message)}</p>
        <p style="color:var(--ink-3);font-size:13px;margin-top:8px">如果是 .doc 旧格式，请在 Word 中另存为 .docx；也可以直接复制文本粘贴解析。</p>`);
    }
  }

  function resetDrop() {
    const dz = $("#dropzone");
    dz.classList.remove("busy");
    dz.querySelector(".drop-main").innerHTML = "<b>点击选择</b>或把 Word 文件拖到这里";
    const fi = $("#file-input");
    if (fi) fi.value = "";
  }

  function showPreview(out) {
    pendingParsed = out;
    const box = $("#parse-preview");
    box.classList.remove("hidden");
    const skipped = (out.raw || out.items.length) - out.items.length;
    $("#parse-meta").innerHTML = `来源：${esc(out.meta.source)}（${esc(out.meta.mode)}）　识别 <b>${out.items.length}</b> 条有效词条${skipped > 0 ? `，跳过 ${skipped} 条重复/无效行` : ""}`;
    $("#bank-name").value = (out.meta.source || "").replace(/\.(docx|csv|txt)$/i, "") || "新词库";
    $("#parse-table").innerHTML = `<table class="tb"><thead><tr><th>#</th><th>单词</th><th>音标</th><th>词性</th><th>释义</th></tr></thead><tbody>
      ${out.items.slice(0, 60).map((v, i) => `<tr>
        <td style="color:var(--ink-3)">${i + 1}</td>
        <td class="w">${esc(v.w)}</td>
        <td class="ph">${esc(v.ph || "—")}</td>
        <td><span class="mini">${esc(v.p || "—")}</span></td>
        <td>${esc(v.m)}</td></tr>`).join("")}
    </tbody></table>${out.items.length > 60 ? `<p class="hint-line">仅预览前 60 条，保存后完整 ${out.items.length} 条均纳入题库。</p>` : ""}`;
    box.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ---------- 启动 ---------- */
  let builtinVocab = [];
  async function boot() {
    // 页脚/品牌副标题/隐私说明随云端是否启用切换，避免未配置时误导
    const cloudOn = !!(window.Cloud && window.Cloud.enabled);
    const foot = $("#cloud-foot");
    if (foot) {
      foot.textContent = cloudOn
        ? "交卷成绩自动上传云端，教师端即时汇总"
        : "成绩保存在本机浏览器，由学生用成绩码回传或在此设备导出";
    }
    const sub = $("#brand-sub");
    if (sub) {
      sub.textContent = cloudOn
        ? "教师建卷下发 · 学生限时作答 · 交卷成绩自动上云"
        : "教师建卷下发 · 学生限时作答 · 自动生成成绩分析";
    }
    const pn = $("#privacy-note");
    if (pn && !cloudOn) {
      pn.textContent = "全部数据保存在本机浏览器，不上传服务器";
    }

    // 微信内置浏览器已可完整作答（GitHub Pages 不拦微信 UA），不再提示跳转浏览器
    try {
      // 用相对路径：GitHub Pages 部署在 /vocab-quiz/ 子目录，绝对路径 /vocab.json 会 404
      const res = await fetch("vocab.json", { cache: "no-cache" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      builtinVocab = await res.json();
    } catch (err) {
      document.body.innerHTML = `<div style="padding:60px;text-align:center;font-family:sans-serif">
        <h2>词库加载失败</h2><p style="color:#666;margin-top:10px">请通过本地服务器打开本页面（例如 <code>python3 -m http.server</code>），
        直接双击打开 HTML 文件会被浏览器的跨域策略拦截。</p></div>`;
      return;
    }
    builtinVocab.forEach((v, i) => { v.tier = tierOf(i, builtinVocab.length); });
    state.vocab = builtinVocab;
    // 供分享链接编码使用：干扰项释义若能在内置库查到，就不必塞进链接
    window.__BUILTIN_VOCAB__ = builtinVocab;
    $("#vocab-total").textContent = builtinVocab.length.toLocaleString();
    bind();
    renderTeacher();

    // 从分享链接进入：优先还原卷面，不等用户点身份卡片
    // 短链接形如 <域名>/s/XXXXXXXX（网关把它转成 ?s=XXXXXXXX 再交给页面）
    const share = window.ShareCodec.readFromUrl();
    if (share) {
      window.scrollTo({ top: 0 });
      initFromShare(share);
    }
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
