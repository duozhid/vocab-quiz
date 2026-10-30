/* =========================================================
   docx-parse.js —— 浏览器端 Word(.docx) 词库解析 v2
   ---------------------------------------------------------
   支持格式：
   1) 行式：abandon v. 抛弃 / abandon [əˈbændən] v. 抛弃 / v. abandon 抛弃
            多个词性：accept vt. 接受 vi. 同意 / abstract n.&adj. 摘要；抽象的
            内联编号：accept 1) vt. 接受 2) vi. 同意
   2) 表格式：任意列序，自动识别 序号 / 单词 / 音标 / 词性 / 释义（含合并表头、无表头）
   3) 纯文本粘贴：制表符或多空格分列同样可识别
   同一单词出现在多行时自动合并词性与释义。

   核心原则：
   · 一个词条可承载多个词性：p 存 "vt. / vi."，m 存合并后释义
   · 词性、音标、序号绝不会被当成单词
   · 只有"纯词性行""纯音标行"这类无意义的行会跳过，不会再丢词条
   ========================================================= */
window.DocxParser = (() => {
  "use strict";

  /* ---------------- 词性词典 ---------------- */
  // 长词性必须排在短词性之前，避免 prep 被 n 抢先匹配
  const POS_LIST = ["interj", "prep", "conj", "pron", "abbr", "adj", "adv", "aux", "num", "art",
    "vt", "vi", "phr", "pl", "n", "v", "a", "ad", "int"];
  const POS_MAP = {
    n: "n.", v: "v.", vt: "vt.", vi: "vi.", adj: "adj.", a: "adj.", adv: "adv.", ad: "adv.",
    prep: "prep.", conj: "conj.", pron: "pron.", num: "num.", art: "art.", int: "int.",
    interj: "int.", aux: "aux.", abbr: "abbr.", pl: "pl.", phr: "phr."
  };
  // 词性 token：可带括号、可带点、可带斜杠连接的组合，如 (n.) / adj./adv. / vt.&vi.
  const POS_TOKEN = new RegExp(
    `^[(（\\[]?((?:${POS_LIST.join("|")})\\s*[\\.．]?)(?:\\s*[)）\\]])?$`, "i");

  const isPos = t => {
    const s = String(t).trim();
    if (!s) return false;
    if (POS_TOKEN.test(s)) return true;
    // 无点裸词性（vi / vt / n / adj），但必须是完整词、不是普通英文单词
    return new RegExp(`^[(（]?(${POS_LIST.join("|")})[)）]?$`, "i").test(s);
  };
  const normPos = t => {
    const m = String(t).trim().match(POS_TOKEN);
    if (!m) return null;
    const key = m[1].replace(/[\s\.．]/g, "").toLowerCase();
    return POS_MAP[key] || null;
  };
  // 连写形式：adj./adv.  vt.&vi.  n.and v.  以及空格分隔的 v. phr.
  function splitPosGroup(tok) {
    const s = String(tok).trim().replace(/^[(（\[]|[,，;；]$/g, "");
    if (/[\/&、]|and/i.test(s)) {
      const parts = s.split(/\s*[\/&、]\s*|\s+and\s+/i).filter(Boolean);
      if (parts.length >= 2 && parts.every(p => isPos(p))) return parts;
    }
    // "v. phr." —— 由调用方把相邻 token 拼起来后传进来
    const seg = s.split(/\s+/).filter(Boolean);
    if (seg.length >= 2 && seg.every(p => isPos(p))) return seg;
    return isPos(s) ? [s] : [];
  }

  const CN = /[\u4e00-\u9fff]/;
  const hasCN = s => CN.test(s);

  /* ---------------- 音标判定 ---------------- */
  // 只保留 IPA 专有符号。绝不能混入普通拉丁字母（i/u/a/o/e/n…），
  // 否则 isPhonetic('vi') 会因命中 'i' 而误判为音标。
  const IPA_CHARS = /[ˈˌːəɪʊʌɔæɑɜθðʃʒŋɡɚɝɒɛɱɲɫʧʤʔ]/;
  function isPhonetic(tok) {
    const s = String(tok).trim();
    if (!s) return false;
    const wrapped = /^[/\[［〔]\s*[^\]/］〕]*\s*[\]/］〕]$/.test(s);
    const inner = s.replace(/^[/\[［〔]|[\]/］〕]$/g, "");
    if (!inner) return false;
    if (hasCN(inner) || /[a-zA-Z]{4,}\s+[a-zA-Z]{4,}/.test(inner)) return false;
    // 纯字母且长度 ≤ 5 且无 IPA 符号 → 极可能是词性/缩写，不是音标
    if (/^[a-zA-Z]+$/.test(inner) && inner.length <= 5 && !IPA_CHARS.test(inner)) return false;
    if (wrapped) return true;
    // 无括号：必须含 IPA 特有符号，或明显是重音标记
    if (IPA_CHARS.test(inner)) return true;
    if (/^[a-zA-Zːˈˌ:·' ]+$/.test(inner) && /[ˈˌː]/.test(inner)) return true;
    return false;
  }
  const unwrapPhon = s => String(s).trim().replace(/^[/\[［〔]|[\]/］〕]$/g, "").trim();

  /* ---------------- 单词判定 ---------------- */
  const isWord = t => {
    const s = String(t).trim();
    if (!s || s.length > 24) return false;
    if (/^[（(]?\d{1,3}[）)\.、．]?$/.test(s)) return false;        // 纯序号
    if (!/[a-zA-Z]/.test(s)) return false;
    if (isPos(s) || splitPosGroup(s).length) return false;      // 词性不是单词
    if (isPhonetic(s)) return false;                              // 音标不是单词
    // 允许：字母、连字符、省字符、词间空格、变体括号 (te)、尾部标记 * †，以及数字开头（3D / 4G）
    const core = s.replace(/[*†‡※#\s]+$/g, "").replace(/[（(][^）)]{0,8}[）)]$/g, "").trim();
    return /^[a-zA-Z0-9][a-zA-Z0-9'’\-\s\.]*$/.test(core) && /[a-zA-Z]/.test(core);
  };
  const cleanWord = t => String(t).trim()
    .replace(/^[\[\(（【※●◆■★※·•\-–—]+/, "")
    .replace(/[*†‡※#\s]+$/, "")
    .replace(/[（(][^）)]{0,8}[）)]$/, "")   // 去掉变体标注：abandon(te) → abandon
    .replace(/[’]/g, "'")
    .toLowerCase();

  /* ---------------- 序号 / 装饰符清理 ---------------- */
  function stripLeadingIndex(s) {
    return String(s)
      .replace(/^[\s\-•·●◆■★※→>\u3000]+/, "")
      .replace(/^\(?\d{1,3}\s*[\.\)、．）]\s*/, "")
      .replace(/^[（(]\s*\d{1,3}\s*[）)]\s*/, "")
      .replace(/^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮]\s*/, "")
      .replace(/^\d{1,3}\s+(?=[a-zA-Z])/, "")
      .trim();
  }

  /* ---------------- 表头噪音 ---------------- */
  const NOISE = /^(unit|module|lesson|revision|word\s*list|vocabulary|new\s*words?|词汇|单词表|词语表|生词|第[一二三四五六七八九十\d]+(单元|课|部分)|附录|总复习)/i;
  const isNoiseLine = s => {
    const t = String(s).trim();
    if (!t) return true;
    if (hasCN(t) && NOISE.test(t.replace(/\s+/g, " "))) return true;
    if (NOISE.test(t) && t.length <= 30) return true;
    // 纯数字、纯符号
    if (/^[\d\s\.\-–—_=*#·]+$/.test(t)) return true;
    return false;
  };

  /* =========================================================
     一、读 docx
     ========================================================= */
  async function readDocx(file) {
    if (typeof JSZip === "undefined") throw new Error("JSZip 未加载，无法解析 .docx");
    const buf = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(buf);
    const entry = zip.file("word/document.xml");
    if (!entry) throw new Error("这不是有效的 .docx 文件（缺少 word/document.xml）");
    const xml = await entry.async("string");
    return parseDocumentXml(xml);
  }

  const decodeXml = s => s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, "&");

  function textOf(xmlFragment) {
    const out = [];
    const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:br\s*\/>|<w:tab\s*\/>/g;
    let m;
    while ((m = re.exec(xmlFragment)) !== null) {
      if (m[0].startsWith("<w:br")) out.push("\n");
      else if (m[0].startsWith("<w:tab")) out.push("\t");
      else out.push(decodeXml(m[1]));
    }
    return out.join("").replace(/\u00a0/g, " ");
  }

  function parseDocumentXml(xml) {
    const paragraphs = [], tables = [];
    const tableRe = /<w:tbl>[\s\S]*?<\/w:tbl>/g;
    let last = 0, m;
    while ((m = tableRe.exec(xml)) !== null) {
      collectParagraphs(xml.slice(last, m.index), paragraphs);
      const rows = [];
      const rowRe = /<w:tr[\s>][\s\S]*?<\/w:tr>/g;
      let r;
      while ((r = rowRe.exec(m[0])) !== null) {
        const cells = [];
        const cellRe = /<w:tc>[\s\S]*?<\/w:tc>/g;
        let c;
        while ((c = cellRe.exec(r[0])) !== null) cells.push(textOf(c[0]).replace(/\s+/g, " ").trim());
        if (cells.some(x => x !== "")) rows.push(cells);
      }
      if (rows.length) tables.push(rows);
      last = m.index + m[0].length;
    }
    collectParagraphs(xml.slice(last), paragraphs);
    return { paragraphs: paragraphs.filter(x => x.trim()), tables };
  }

  function collectParagraphs(fragment, out) {
    const pRe = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g;
    let p;
    while ((p = pRe.exec(fragment)) !== null) {
      const line = textOf(p[1]).trim();
      if (line) out.push(line);
    }
  }

  /* =========================================================
     二、行式解析（核心）
     返回 { w, entries:[{pos, meaning}] } 或 null
     ========================================================= */
  function parseLine(raw) {
    let line = String(raw).replace(/\u3000/g, " ").replace(/\s+/g, " ").trim();
    if (!line || isNoiseLine(line)) return null;
    line = stripLeadingIndex(line);
    if (!line) return null;

    // 统一分隔符：把 ===, ——, … 等换成空格
    line = line.replace(/(?:[—–\-]{2,}|[=＝]{2,}|…{2,}|[·•]{2,})/g, " ").replace(/\s+/g, " ").trim();
    if (!line) return null;

    // 切 tokens：中文、词性、音标、单词边界都要切开
    let tokens = [];
    line.split(" ").filter(Boolean).forEach(t => {
      // 纯装饰符号（* † ※ 等）直接丢弃，否则会挡住「词 → 词性」的邻接判断
      if (/^[*†‡※#·•\-–—~～=＋+|]+$/.test(t)) return;
      // 词性连写整体保留：adj./adv.  n.&adj.  vt.&vi.
      if (splitPosGroup(t).length || isPos(t)) { tokens.push(t); return; }
      // "能力(n.)" / "能力（n.）" → ["能力", "(n.)"]
      const m1 = t.match(/^([^()（）\[\]]*?)[(（]([(（]?\s*[a-zA-Z]{1,6}\s*[\.．]?\s*[)）])$/);
      if (m1 && hasCN(m1[1])) { tokens.push(m1[1], "(" + m1[2]); return; }
      // "(n.)能力" → ["(n.)", "能力"]
      const m2 = t.match(/^([(（]\s*[a-zA-Z]{1,6}\s*[\.．]\s*[)）])(.+)$/);
      if (m2) { tokens.push(m2[1], m2[2]); return; }
      // "abandon（v.）放弃" 全角括号夹词性 → ["abandon", "(v.)", "放弃"]
      const m3 = t.match(/^([a-zA-Z][a-zA-Z'’\-]*)[(（]\s*([a-zA-Z]{1,6}\s*[\.．]?)\s*[)）](.*)$/);
      if (m3 && isPos(m3[2])) { tokens.push(m3[1], "(" + m3[2] + ")"); if (m3[3]) tokens.push(m3[3]); return; }
      tokens.push(t);
    });

    let word = null, phon = "";
    const entries = [];         // [{pos, meaning}]
    let curPos = null, curMean = [];
    let sawAnyPos = false;
    const isIndexTok = t => /^\(?\d{1,2}\s*[\)\.、．]$/.test(t) || /^[（(]\s*\d{1,2}\s*[）)]$/.test(t);

    const flush = () => {
      const m = curMean.join(" ").replace(/\s+/g, " ").trim();
      if (m) entries.push({ pos: curPos, meaning: m });
      curMean = [];
    };

    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];

      /* 1) 单词（仅在还没取到单词时） */
      if (!word && isWord(tok) && !hasCN(tok)) {
        // 找下一个「有意义」的 token：跳过 1) / ① / — 这类编号装饰
        let j = i + 1;
        while (j < tokens.length && isIndexTok(tokens[j])) j++;
        const next = tokens[j] || "";
        const nextIsSignal = isPhonetic(next) || isPos(next) || splitPosGroup(next).length || hasCN(next);
        if (nextIsSignal || j >= tokens.length) {
          word = cleanWord(tok);
          continue;
        }
        /* 短语兜底：look after 照顾 / look forward to 期待
           当前词后面还是普通英文词，且更远处才出现词性/中文 → 视为短语的一部分 */
        const nextPlain = isWord(next) && !hasCN(next);
        if (nextPlain && tok.length >= 2) {
          let k = i + 1;
          while (k < tokens.length && isWord(tokens[k]) && !hasCN(tokens[k])) k++;
          const after = tokens[k] || "";
          if (isPos(after) || splitPosGroup(after).length || hasCN(after) || k >= tokens.length) {
            const phrase = tokens.slice(i, k).map(cleanWord).join(" ");
            if (/^[a-z][a-z'’\- ]*$/.test(phrase)) { word = phrase; i = k - 1; continue; }
          }
        }
      }

      /* 2) 音标 */
      if (!phon && isPhonetic(tok)) { phon = unwrapPhon(tok); continue; }

      /* 3) 词性（含组合词性、内联编号） */
      let posFound = null;
      const grp = splitPosGroup(tok);
      if (grp.length) {
        posFound = grp.map(normPos).filter(Boolean);
      } else if (isPos(tok)) {
        posFound = [normPos(tok)];
      } else {
        // 形如 "(n.)" 已被 isPos 覆盖；形如 "n.能力" 粘连的情况拆开
        const jam = tok.match(/^[(（]?((?:n|v|vt|vi|adj|adv|prep|conj|pron|art|num|int|interj|aux|abbr|a|ad)\s*[\.．])\s*(.+)$/i);
        if (jam && hasCN(jam[2])) { posFound = [normPos(jam[1])]; tokens.splice(i + 1, 0, jam[2]); }
      }
      if (posFound && posFound.length) {
        flush();
        curPos = posFound.join(" / ");
        sawAnyPos = true;
        continue;
      }

      /* 4) 其余：内联编号 or 释义 */
      if (/^\d{1,2}[\)\.、．]\s*$/.test(tok)) continue;           // "1)" 单独成 token
      if (/^[（(]\s*\d{1,2}\s*[）)]$/.test(tok)) continue;
      // "2)contribute" / "2、contribute" 这类编号+单词粘连：剥掉编号后丢弃该 token
      if (/^\d{1,2}\s*[\)\.、．]\s*[a-zA-Z]/.test(tok)) continue;
      // 释义段里重复出现单词本词（1) contribute v. 贡献 2) contribute vi. 有助于）→ 丢掉
      if (word && cleanWord(tok) === word) continue;
      curMean.push(tok);
    }
    flush();

    if (!word) return null;
    // 只保留含中文的释义段；若全无中文，整行无效
    const valid = entries.filter(e => hasCN(e.meaning));
    if (!valid.length) return null;

    // 清理释义里的编号、多余括号
    valid.forEach(e => {
      e.meaning = e.meaning
        .replace(/^[\s：:—–\-、,，。\.]+/, "")
        .replace(/^\d{1,2}[\)\.、．]\s*/, "")
        .replace(/^[(（]\s*[a-zA-Z]{1,6}\s*[\.．]?\s*[)）]\s*/, "")
        .trim();
    });
    return { w: word, phon, entries: valid };
  }

  /* =========================================================
     三、表格式解析
     ========================================================= */
  const HEAD = {
    idx: /^(序号|编号|no\.?|number|#)$/i,
    word: /^(单词|词汇|英文|英语|生词|word|words|english|vocabulary|spelling)$/i,
    phon: /^(音标|读音|发音|phonetic|phonetics|pronunciation|ipa)$/i,
    pos: /^(词性|词类|part\s*of\s*speech|pos|part)$/i,
    mean: /^(释义|中文|意思|含义|翻译|词义|中文意思|meaning|chinese|definition|translation|explanation)$/i
  };
  function matchHead(h) {
    const t = String(h).replace(/[\s:：]/g, "");
    for (const k of Object.keys(HEAD)) if (HEAD[k].test(t)) return k;
    return null;
  }

  function parseTable(rows) {
    if (!rows || !rows.length) return [];
    const width = Math.max(...rows.map(r => r.length));

    /* 判表头：首行至少命中 2 个，或命中"单词/释义"任一 */
    let cols = null, start = 0;
    const first = rows[0];
    const hits = {};
    first.forEach((cell, i) => { const k = matchHead(cell); if (k && hits[k] === undefined) hits[k] = i; });
    const hitCount = Object.keys(hits).length;
    if (hitCount >= 2 || (hitCount >= 1 && (hits.word !== undefined || hits.mean !== undefined))) {
      cols = {
        word: hits.word, phon: hits.phon, pos: hits.pos, mean: hits.mean, idx: hits.idx
      };
      start = 1;
    } else {
      /* 无表头：按内容推断每一列的语义 */
      cols = inferColumns(rows.slice(0, Math.min(12, rows.length)), width);
    }

    const out = [];
    for (let i = start; i < rows.length; i++) {
      const r = rows[i];
      if (!r || !r.some(x => x !== "")) continue;

      let word = cols.word >= 0 ? (r[cols.word] || "").trim() : "";
      if (!isWord(word)) {
        // 该列不是单词，则整行再按行式兜底
        const joined = r.filter(Boolean).join(" ");
        const line = parseLine(joined);
        if (line) out.push(line);
        continue;
      }
      word = cleanWord(word);

      let phon = cols.phon >= 0 ? (r[cols.phon] || "").trim() : "";
      phon = phon ? unwrapPhon(phon) : "";

      /* 词性：词性列 + 释义列里夹带的词性，全部收集 */
      const posSet = [];
      const pushPos = p => { const n = normPos(p); if (n && !posSet.includes(n)) posSet.push(n); };

      if (cols.pos >= 0) {
        const cell = (r[cols.pos] || "").trim();
        cell.split(/[\s,，;；\/&、]+/).filter(Boolean).forEach(pushPos);
      }

      let meaning = cols.mean >= 0 ? (r[cols.mean] || "").trim() : "";
      if (!meaning) {
        // 没有释义列：取第一个含中文的单元格
        meaning = r.find(c => hasCN(c)) || "";
      }

      /* 释义列里可能夹带词性：n. 账户 v. 解释 → 拆成多词性 */
      const entries = splitMeaningByPos(meaning);
      entries.forEach(e => { if (e.pos) pushPos(e.pos); });

      const meanText = entries.map(e => e.meaning).filter(Boolean).join("；").replace(/\s+/g, " ").trim();
      if (!meanText || !hasCN(meanText)) continue;

      out.push({
        w: word, phon,
        entries: [{ pos: posSet.join(" / ") || null, meaning: meanText }]
      });
    }
    return out;
  }

  /* 按词性把 "adj. 抽象的 n. 摘要" 拆成 [{pos:'adj.',meaning:'抽象的'},{pos:'n.',meaning:'摘要'}]
     同时支持 "接受；vi. 同意" 这种「释义在前、词性在后、用分号分隔」的写法 */
  function splitMeaningByPos(text) {
    let s = String(text).replace(/\s+/g, " ").trim();
    if (!s) return [{ pos: null, meaning: "" }];
    const re = new RegExp(
      `(?:^|[\\s；;，,、]|(?<=[\\u4e00-\\u9fff]))((?:${POS_LIST.join("|")})\\s*[\\.．])(?=[\\s\\u4e00-\\u9fff])`,
      "gi");
    const marks = [];
    let m;
    while ((m = re.exec(s)) !== null) {
      const pos = normPos(m[1]);
      if (!pos) continue;
      const start = m.index + m[0].length - m[1].length;
      // 去重：同一位置只记一次
      if (marks.some(x => x.start === start)) continue;
      marks.push({ pos, start, end: m.index + m[0].length });
    }
    if (!marks.length) return [{ pos: null, meaning: s }];
    // 第一段（若有）作为无词性内容
    const res = [];
    if (marks[0].start > 0) {
      const head = s.slice(0, marks[0].start).replace(/^[\s(（；;，,、]+/, "").replace(/[\s；;，,、]+$/, "").trim();
      if (head) res.push({ pos: null, meaning: head });
    }
    marks.forEach((mk, i) => {
      const end = i + 1 < marks.length ? marks[i + 1].start : s.length;
      const body = s.slice(mk.end, end).replace(/^[\s(（；;，,、]+|[\s)）；;，,、]+$/g, "").trim();
      if (body) res.push({ pos: mk.pos, meaning: body });
    });
    return res.length ? res : [{ pos: null, meaning: s }];
  }

  function inferColumns(sample, width) {
    const score = Array.from({ length: width }, () => ({ word: 0, phon: 0, pos: 0, mean: 0, idx: 0 }));
    sample.forEach(r => {
      for (let c = 0; c < width; c++) {
        const v = (r[c] || "").trim();
        if (!v) continue;
        if (/^\d{1,3}[\.\)、]?$/.test(v)) score[c].idx++;
        else if (isPos(v) || splitPosGroup(v).length) score[c].pos++;
        else if (isPhonetic(v)) score[c].phon++;
        else if (hasCN(v)) score[c].mean++;
        else if (isWord(v)) score[c].word++;
      }
    });
    const pick1 = key => {
      let best = -1, bestN = 0;
      score.forEach((s, i) => { if (s[key] > bestN) { bestN = s[key]; best = i; } });
      return bestN > 0 ? best : -1;
    };
    let wordCol = pick1("word");
    let meanCol = pick1("mean");
    const posCol = pick1("pos"), phonCol = pick1("phon"), idxCol = pick1("idx");
    // 忽略"序号"列被当成单词的情况
    if (idxCol >= 0 && wordCol === idxCol) {
      score[idxCol].word = -1;
      wordCol = pick1("word");
    }
    if (wordCol === meanCol) {
      // 冲突时，取含中文比例最高的是释义列
      const cnRate = i => sample.filter(r => hasCN(r[i] || "")).length;
      const a = cnRate(wordCol), b2 = cnRate(meanCol);
      if (a > b2) meanCol = pick1("mean") === wordCol ? -1 : pick1("mean");
      else wordCol = -1;
    }
    // 兜底：单词列 = 第一个全是英文单词的列；释义列 = 第一个含中文的列
    if (wordCol < 0) {
      for (let c = 0; c < width; c++) if (score[c].word > 0 && c !== meanCol) { wordCol = c; break; }
    }
    if (meanCol < 0) {
      for (let c = 0; c < width; c++) if (score[c].mean > 0) { meanCol = c; break; }
    }
    return { word: wordCol, phon: phonCol, pos: posCol, mean: meanCol, idx: idxCol };
  }

  /* =========================================================
     四、纯文本
     ========================================================= */
  function parseText(text) {
    const lines = String(text).split(/\r?\n/);
    const out = [];
    lines.forEach(line => {
      if (!line.trim()) return;
      if (/\t/.test(line) || /\s{3,}/.test(line)) {
        const cells = line.split(/\t|\s{3,}/).map(s => s.trim()).filter(s => s !== "");
        if (cells.length >= 2) {
          const t = parseTable([cells]);
          if (t.length) { out.push(...t); return; }
        }
      }
      const one = parseLine(line);
      if (one) out.push(one);
    });
    // 与 parseFile 一致：合并同词多行并展平成 {w, p, m, ph}，
    // 否则词条缺 m/p 字段，组卷时释义全空（此前粘贴路径踩过这个坑）。
    const merged = mergeRecords(out);
    merged.sort((a, b) => a.w.localeCompare(b.w));
    return toItems(merged);
  }

  /* =========================================================
     五、合并（同词多行 → 多词性合并）
     ========================================================= */
  function mergeRecords(records) {
    const map = new Map();
    for (const rec of records) {
      const key = rec.w;
      if (!key) continue;
      const old = map.get(key);
      if (!old) {
        map.set(key, {
          w: rec.w, phon: rec.phon || "",
          entries: rec.entries.map(e => ({ pos: e.pos, meaning: e.meaning }))
        });
        continue;
      }
      if (!old.phon && rec.phon) old.phon = rec.phon;
      rec.entries.forEach(e => {
        // 相同词性 + 相同释义 → 跳过；相同词性不同释义 → 合并释义
        const same = old.entries.find(o => o.pos === e.pos);
        if (same) {
          if (!same.meaning.includes(e.meaning)) same.meaning += "；" + e.meaning;
        } else if (!old.entries.some(o => o.pos === e.pos && o.meaning === e.meaning)) {
          old.entries.push({ pos: e.pos, meaning: e.meaning });
        }
      });
    }
    return [...map.values()];
  }

  /* 把合并结果转成前端词条结构 */
  function toItems(merged) {
    return merged.map(m => {
      const posList = [];
      const parts = [];
      m.entries.forEach(e => {
        if (e.pos) e.pos.split(/\s*\/\s*/).forEach(p => { if (p && !posList.includes(p)) posList.push(p); });
        if (e.meaning) parts.push(e.pos ? e.meaning : e.meaning);
      });
      // 释义去重合并
      const seen = new Set();
      const meanings = [];
      parts.forEach(p => { const k = p.trim(); if (k && !seen.has(k)) { seen.add(k); meanings.push(k); } });
      const meaning = meanings.join("；").replace(/\s+/g, " ").slice(0, 70);
      return {
        w: m.w,
        p: posList.join(" / ") || "",
        m: meaning,
        ph: m.phon || ""
      };
    }).filter(x => x.w && x.m);
  }

  /* =========================================================
     六、统一入口
     ========================================================= */
  async function parseFile(file) {
    const name = (file.name || "").toLowerCase();
    let records = [], mode = "";

    if (name.endsWith(".docx")) {
      const doc = await readDocx(file);
      const fromTables = doc.tables.flatMap(parseTable);
      const fromParas = doc.paragraphs.map(parseLine).filter(Boolean);
      records = fromTables.concat(fromParas);
      mode = fromTables.length ? "表格式" : "行式";
      if (fromTables.length && fromParas.length) mode = "表格式 + 行式";
    } else if (name.endsWith(".doc")) {
      throw new Error("暂不支持旧版 .doc 格式，请在 Word 中「另存为」.docx 后再上传");
    } else if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
      throw new Error("暂不支持 .xlsx，请另存为 CSV 或 .docx 后上传");
    } else {
      const text = await file.text();
      records = parseText(text);
      mode = "文本";
    }

    const raw = records.length;
    const merged = mergeRecords(records);
    merged.sort((a, b) => a.w.localeCompare(b.w));
    const items = toItems(merged);

    // 统计：多词性词条数量
    const multi = items.filter(i => i.p.includes("/")).length;
    return {
      items,
      meta: { source: file.name || "文本", mode, raw, multi },
      raw
    };
  }

  return {
    parseFile, parseLine, parseText, parseTable,
    // 供测试与调试
    _internal: { splitMeaningByPos, mergeRecords, toItems, isPos, isPhonetic, isWord, splitPosGroup }
  };
})();
