/* 名片文字 → 文字卡 → 欄位
   輸入：一行一行的文字（OCR 結果或使用者貼上的文字），可附字高 h、在照片上的位置 box、信心 conf。
   流程：
   1. 切成「文字卡」：依換行、大空格、分隔符號、標籤（電話、傳真…）切開；一行裡多個 Email／電話／網址也分開；
      「王小明 心理師」這種姓名職稱同一塊的也拆開。被拉開字距的姓名（林 怡 君）會合回來。
   2. 每張文字卡判斷像什麼：先看最有把握的（Email、電話、網址、地址），再看標籤，再用關鍵字認單位、職稱，最後用刪去法猜姓名。
   3. 分配到欄位：一個欄位可以放多張文字卡（例如地址折成兩行），沒被用到的文字卡保留下來給使用者自己放。
   欄位名稱與 app 相同：name 姓名、title 職稱、org 單位、alt 其他語言、phone 手機、tel 公司電話、email、line、web、address 地址、note 備註。
   這個檔案不碰網路、不存任何資料。 */
(function (root) {
  "use strict";

  // ---------- 正規化 ----------
  const FW = { "：": ":", "；": ";", "，": ",", "（": "(", "）": ")", "＠": "@", "＃": "#", "＋": "+", "－": "-", "—": "-", "–": "-", "．": ".", "／": "/", "｜": "|" };
  function normalize(s) {
    s = String(s || "").replace(/[０-９Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
    s = s.replace(/[：；，（）＠＃＋－—–．／｜]/g, c => FW[c]).replace(/　/g, "  ");   // 全形空格視為大空格
    s = s.replace(/\s*\(at\)\s*|\s*\[at\]\s*/gi, "@").replace(/(\w)\s*[©®]\s*(\w)/g, "$1@$2").replace(/\s*@\s*(?=[A-Za-z0-9])/g, "@");
    s = s.replace(/\t/g, "  ").replace(/ {3,}/g, "  ").trim();
    return s;
  }
  const CJK = "㐀-鿿豈-﫿";
  const reCJK = new RegExp("[" + CJK + "]");
  const reCJK1 = new RegExp("^[" + CJK + "]$");
  const squeezeCJK = s => s.replace(new RegExp("([" + CJK + "])\\s+(?=[" + CJK + "])", "g"), "$1");
  const tidy = s => { s = s.replace(/\s+/g, " ").trim(); return reCJK.test(s) ? squeezeCJK(s) : s; };

  // ---------- 字典 ----------
  const LABELS = [
    ["fax", /^(傳真|fax|f)(?![A-Za-z])\.?/i],
    ["phone", /^(手機|行動電話|行動|mobile|mob|cell|m)(?![A-Za-z])\.?/i],
    ["tel", /^(電話|市話|辦公室|公司電話|專線|總機|tel|phone|office|t|o|p)(?![A-Za-z])\.?/i],
    ["email", /^(電子信箱|電子郵件|信箱|e-?mail|mail|e)(?![A-Za-z])\.?/i],
    ["address", /^(地址|住址|通訊處|add(ress)?|addr|a)(?![A-Za-z])\.?/i],
    ["web", /^(網站|網址|官網|web(site)?|url|w)(?![A-Za-z])\.?(?!\.)/i],
    ["line", /^(line\s*id|line)(?![A-Za-z])\.?/i],
    ["name", /^(姓名|名字)/],
    ["title", /^(職稱|職位|職務)/],
  ];
  const ORG_RE = /(中心|醫院|診所|院區|醫學中心|衛生所|心理治療所|心理諮商所|諮商所|治療所|協會|學會|公會|基金會|股份有限公司|有限公司|公司|企業社|商行|工作室|大學|學院|學校|高中|國中|國小|幼兒園|事務所|政府|市政府|縣政府|區公所|公所|法院|地檢署|檢察署|警察局|分局|派出所|消防局|局|處|署|委員會|議會|教會|聯盟|銀行|集團|部|科|課|組|室|系|所|社|館|園)$|\b(inc\.?|ltd\.?|co\.?,? ?ltd|corp(oration)?|company|center|centre|hospital|clinic|university|college|school|association|foundation|institute|department|bureau|office|bank|group|studio|llc)\b/i;
  const TITLE_WORDS = "心理師|臨床心理師|諮商心理師|社會工作師|社工師|社工員|社工督導|社工|督導|個案管理師|個管師|管理師|主任委員|副主任|主任|執行長|董事長|副總經理|總經理|總監|協理|經理|副理|襄理|專案經理|專員|組長|課長|科長|股長|處長|局長|署長|院長|副院長|校長|所長|隊長|理事長|秘書長|秘書|總幹事|幹事|護理長|護理師|醫師|主治醫師|住院醫師|藥師|營養師|職能治療師|物理治療師|語言治療師|治療師|教授|副教授|助理教授|講師|老師|教師|導師|研究員|助理|律師|會計師|代書|法官|檢察官|書記官|觀護人|警員|巡佐|工程師|設計師|顧問|創辦人|負責人|業務|店長|志工";
  const TITLE_RE = new RegExp("(" + TITLE_WORDS + ")$");
  const TITLE_ANY = new RegExp("(" + TITLE_WORDS + ")");
  const TITLE_FULL = new RegExp("^(" + TITLE_WORDS + ")$");
  const PAIR_RE = new RegExp("^([" + CJK + "]{2,4})\\s*(" + TITLE_WORDS + ")$");
  const PAIR_REV = new RegExp("^(" + TITLE_WORDS + ")\\s*([" + CJK + "]{2,4})$");
  const TITLE_EN = /\b(manager|director|engineer|officer|president|vice president|ceo|cto|cfo|coo|founder|co-founder|assistant|consultant|designer|psychologist|counsel+or|therapist|social worker|case manager|supervisor|coordinator|professor|lecturer|teacher|nurse|doctor|physician|pharmacist|specialist|researcher|attorney|lawyer|accountant|secretary|chairman|executive|representative|sales|lead|head|chief|partner|owner)\b/i;
  const ADDR_STRONG = new RegExp("[" + CJK + "]{1,8}(路|街|大道)|[\\d一二三四五六七八九十]+(段|巷|弄|號|樓)|\\bNo\\.\\s*\\d+|\\b(Rd|Road|St|Street|Ave|Avenue|Blvd|Lane|Ln|Aly|Alley|Sec)\\.?(\\s|,|$)", "i");
  const NOT_ADDR = /(字號|證號|編號|證書|執照|號碼|字第)/;   // 證件上的「第…號」不是地址
  const ADDR_CONT = new RegExp("^[\\d" + CJK + "-]{0,12}(號|樓|室|F|之\\d)");
  const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  const URL_RE = /\b((https?:\/\/)?(www\.)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.(com|net|org|gov|edu|tw|io|co|info|biz|me|app|cc|hk|jp|cn|us|uk)(\.[a-z]{2})?(\/[^\s]*)?)/i;
  const PHONE_SRC = "(\\+?886[\\s-]?\\(?0?\\)?[\\s-]?\\d{1,2}[\\s-]?\\d{3,4}[\\s-]?\\d{3,4}|\\(0\\d{1,2}\\)[\\s-]?\\d{3,4}[\\s-]?\\d{3,4}|0\\d{1,2}[\\s-]\\d{3,4}[\\s-]?\\d{3,4}|09\\d{2}[\\s-]?\\d{3}[\\s-]?\\d{3}|0\\d{8,9})(\\s*(#|ext\\.?|分機|轉|x)\\s*\\d{1,6})?";
  const PHONE_RE = new RegExp(PHONE_SRC, "i");
  const MULTI_RE = new RegExp("[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}|" + PHONE_SRC + "|(https?:\\/\\/)?www\\.[^\\s]+", "gi");
  const SPLIT_LABEL = /\s(?=(?:傳真|手機|行動電話|電話|地址|網站|網址|信箱)|(?:E-?mail|Tel|Fax|Mobile|Cell|LINE|Add(?:ress)?|Web)\b|[TFMEOWAP]\s?:)/gi;
  const STOP = /^(電話|手機|傳真|地址|信箱|網站|分機|服務時間|上班時間|營業時間|歡迎|謝謝|敬上)$/;

  const cleanPhone = p => p.replace(/\s+/g, " ").trim().replace(/\s*(#|ext\.?|分機|轉|x)\s*(\d+)$/i, " #$2");
  const isMobile = p => /^(\+?886[\s-]?\(?0?\)?[\s-]?9|09)/.test(p.replace(/\s/g, ""));
  const latinShare = s => { const l = (s.match(/[A-Za-z]/g) || []).length, c = (s.match(new RegExp("[" + CJK + "]", "g")) || []).length; return l + c ? l / (l + c) : 0; };

  function stripLabel(seg) {
    for (const [field, re] of LABELS) {
      const m = seg.match(re);
      if (!m) continue;
      const after = seg.slice(m[0].length);
      if (m[0].length <= 2 && !/^\s*[:.]/.test(after) && !/^\s+[\d+(@]/.test(after)) continue;   // 單一字母標籤一定要接冒號或號碼
      const rest = after.replace(/^\s*[:.\-]?\s*/, "");
      if (rest) return { label: field, value: rest };
    }
    return { label: null, value: seg };
  }

  // ---------- 1. 切成文字卡 ----------
  function tokenize(lines, side) {
    const out = [];
    lines.forEach((ln, li) => {
      let parts = normalize(ln.text).split(/ {2,}|\s[|│•·]\s|\s*[|│]\s*/).map(p => p.trim()).filter(Boolean);
      // 字距拉開的姓名會被大空格切成一個字一塊，合回來
      const merged = [];
      for (const p of parts) {
        const last = merged[merged.length - 1];
        if (last && reCJK1.test(p) && /^[㐀-鿿豈-﫿](\s?[㐀-鿿豈-﫿]){0,3}$/.test(last)) merged[merged.length - 1] = last + p;
        else merged.push(p);
      }
      for (const part of merged) {
        for (let seg of part.split(SPLIT_LABEL)) {
          seg = (seg || "").replace(/\s+/g, " ").trim(); if (!seg) continue;
          const { label } = stripLabel(seg);
          let pieces = [seg];
          if (!label) {
            const ms = seg.match(MULTI_RE) || [];
            if (ms.length >= 2) {   // 一行裡有兩個以上的 Email／電話／網址：在每個開頭切開
              const at = Array.from(seg.matchAll(MULTI_RE), m => m.index);
              pieces = at.map((st, k) => seg.slice(k === 0 ? 0 : st, k + 1 < at.length ? at[k + 1] : seg.length).replace(/[\s\/,;|、]+$/, "").trim()).filter(Boolean);
            }
            const sq = tidy(seg), raw = seg.trim();
            const spaced = raw.match(new RegExp("^([" + CJK + "](\\s+[" + CJK + "]){1,3})\\s+(" + TITLE_WORDS + ")$"));
            const pr = sq.match(PAIR_RE), rv = sq.match(PAIR_REV);
            if (TITLE_FULL.test(sq)) { /* 整個就是一個職稱，例如「臨床心理師」，不要拆 */ }
            else if (spaced) pieces = [spaced[1], spaced[3]];
            else if (pr && !ORG_RE.test(pr[1]) && !TITLE_ANY.test(pr[1])) pieces = [pr[1], pr[2]];
            else if (rv && !ORG_RE.test(rv[2]) && !TITLE_ANY.test(rv[2])) pieces = [rv[1], rv[2]];
          }
          for (const p of pieces) out.push({ text: tidy(p), line: li, h: ln.h || 0, box: ln.box || null, side: side || "front", pairName: pieces.length === 2 && reCJK.test(p) && !TITLE_RE.test(tidy(p)) });
        }
      }
    });
    return out;
  }

  // ---------- 2. 每張文字卡像什麼 ----------
  function classify(t, prev) {
    const { label, value } = stripLabel(t.text);
    const v = tidy(value);
    t.value = v;
    if (label === "fax") { t.kind = "fax"; return; }
    const em = v.match(EMAIL_RE);
    if (em) { t.kind = "email"; t.value = em[0]; return; }
    if (label === "email") { t.kind = "email"; return; }
    if (label === "line") { t.kind = "line"; return; }
    if (/^@[A-Za-z0-9._-]{3,}$/.test(v)) { t.kind = "line"; return; }
    const ph = v.match(PHONE_RE);
    if (ph && (label === "tel" || label === "phone" || !label)) {
      const p = cleanPhone(ph[0]); t.value = p;
      t.kind = label === "phone" || (!label && isMobile(p)) ? "phone" : "tel"; return;
    }
    if (label === "web" || (URL_RE.test(v) && !reCJK.test(v))) { const u = v.match(URL_RE); t.kind = "web"; t.value = u ? u[0] : v; return; }
    if (label === "name" && v) { t.kind = "nameLabel"; return; }
    if (label === "title" && v) { t.kind = "title"; return; }
    if (label === "address" || (ADDR_STRONG.test(v) && !NOT_ADDR.test(v))) { t.kind = "address"; return; }
    if (prev && prev.kind === "address" && prev.side === t.side && ADDR_CONT.test(v)) { t.kind = "address"; return; }
    if (label === "tel" || label === "phone") { t.kind = label; return; }
    const cjk = reCJK.test(v);
    // 「主治醫師 Attending Psychiatrist」：中文職稱後面接英文，只取中文部分
    const mix = cjk && v.match(new RegExp("^([" + CJK + "\\s]{2,14}?)\\s+([A-Za-z].*)$"));
    if (mix && TITLE_RE.test(mix[1])) { t.kind = "title"; t.value = tidy(mix[1]); return; }
    const isTitle = (cjk && TITLE_RE.test(v) && v.length <= 14) || (!cjk && TITLE_EN.test(v) && v.split(" ").length <= 6 && !ORG_RE.test(v));
    const isOrg = ORG_RE.test(v) && v.length >= 3;
    if (isTitle && !(isOrg && v.length > 8)) { t.kind = cjk ? "title" : "enTitle"; return; }
    if (isOrg) { t.kind = cjk ? "org" : "orgEn"; return; }
    if (new RegExp("^[" + CJK + "]{2,4}$").test(v) && !STOP.test(v)) { t.kind = "nameCand"; return; }
    if (/^[A-Z][A-Za-z'’-]+(,?\s+[A-Z][A-Za-z'’-]+){1,3}$/.test(v)) { t.kind = "enName"; return; }
    t.kind = null;
  }

  // ---------- 3. 分配到欄位 ----------
  function assign(tokens, opts) {
    const has = f => tokens.some(t => t.field === f);
    const firstOf = (k, f, more) => { tokens.filter(t => t.kind === k && !t.field).forEach((t, i) => { if (i === 0 && !has(f)) t.field = f; else if (more) more(t); }); };
    firstOf("email", "email");
    firstOf("line", "line");
    firstOf("web", "web");
    firstOf("phone", "phone", t => { if (!has("tel")) t.field = "tel"; });
    firstOf("tel", "tel", t => { if (!has("phone")) t.field = "phone"; });
    tokens.filter(t => t.kind === "address").forEach(t => { t.field = "address"; });
    const zhOrg = tokens.filter(t => t.kind === "org").slice(0, 3);
    if (zhOrg.length) zhOrg.forEach(t => t.field = "org"); else firstOf("orgEn", "org");
    tokens.filter(t => t.kind === "title").slice(0, 2).forEach(t => t.field = "title");
    firstOf("nameLabel", "name");
    const cands = tokens.filter(t => t.kind === "nameCand");
    const best = cands.slice().sort((a, b) => (b.pairName ? 1 : 0) - (a.pairName ? 1 : 0) || (b.h || 0) - (a.h || 0) || a.line - b.line)[0];
    if (best && !has("name")) best.field = "name";
    const pick = arr => arr.slice().sort((a, b) => (b.h || 0) - (a.h || 0) || a.line - b.line)[0];
    const en = pick(tokens.filter(t => t.kind === "enName")), enT = tokens.find(t => t.kind === "enTitle");
    const backLatin = opts.side === "back" && latinShare(tokens.map(t => t.text).join(" ")) > 0.6;
    if (en) {
      if (!has("name") && !backLatin) { en.field = "name"; if (enT && !has("title")) enT.field = "title"; }
      else { en.field = "alt"; if (enT) enT.field = "alt"; }
    } else if (enT) { enT.field = backLatin || has("title") ? "alt" : "title"; }
    if (backLatin) tokens.forEach(t => { if (t.field === "name" || t.field === "title") t.field = "alt"; if (t.field === "org" && t.kind === "orgEn") t.field = null; });
  }

  // 把同一欄位的文字卡接成欄位內容
  const JOIN = { address: "", org: " ", alt: ", ", title: " ", note: "\n" };
  function joinField(field, values) {
    values = values.filter(Boolean);
    if (!values.length) return "";
    if (field === "address") return values.reduce((a, b) => a + (reCJK.test(a.slice(-1)) || reCJK.test(b[0]) ? "" : " ") + b, "").trim();
    return values.join(field in JOIN ? JOIN[field] : " ");
  }
  // 文字卡放進某個欄位時，實際填入的值：去掉標籤；電話、Email、網址只取有效的那一段
  function valueFor(text, field) {
    let v = tidy(stripLabel(normalize(text)).value);
    const m = field === "phone" || field === "tel" ? v.match(PHONE_RE) : field === "email" ? v.match(EMAIL_RE) : field === "web" ? v.match(URL_RE) : null;
    if (m) v = field === "phone" || field === "tel" ? cleanPhone(m[0]) : m[0];
    return v;
  }
  const joinText = (a, b) => (reCJK.test(a.slice(-1)) && reCJK.test(b[0]) ? a + b : a + " " + b);
  function fieldsFrom(tokens) {
    const r = {};
    for (const t of tokens) if (t.field) (r[t.field] = r[t.field] || []).push(valueFor(t.text, t.field));
    for (const k in r) r[k] = joinField(k, r[k]);
    return r;
  }

  function parse(input, opts) {
    opts = opts || {};
    let lines = Array.isArray(input) ? input.map(l => typeof l === "string" ? { text: l } : l) : String(input || "").split(/\r?\n/).map(t => ({ text: t }));
    lines = lines.map(l => ({ text: String(l.text || "").trim(), h: Number(l.h) || 0, box: l.box || null, conf: l.conf == null ? 100 : Number(l.conf) }))
      .filter(l => l.text && !(l.conf < 30 && !/\d|@/.test(l.text)));   // 低信心又沒數字的多半是 logo 雜訊
    const tokens = tokenize(lines, opts.side);
    tokens.forEach((t, i) => classify(t, tokens[i - 1]));
    assign(tokens, opts);
    const r = fieldsFrom(tokens);
    r.tokens = tokens.map(t => ({ text: t.text, value: t.value, field: t.field || null, kind: t.kind || null, box: t.box, side: t.side }));
    return r;
  }

  const api = { parse, normalize, joinField, fieldsFrom, valueFor, joinText, cleanPhone };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CardParse = api;
})(typeof self !== "undefined" ? self : this);
