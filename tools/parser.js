// ==========================================================
// PARSER.JS - GuestPro Promotion Bot (mode MANUAL)
// ==========================================================
// API yang dipakai oleh telegram.js & index.js (BA Hermes):
//
//   createEmptySession()
//     -> object session baru, siap dipakai handlePromotionMessage()
//
//   handlePromotionMessage(sessionStore, chatId, text)
//     -> { status, message, data? }
//        status === "ready_to_execute"  => `data` siap dikirim ke isiPromotion()
//        status lainnya (mis. "collecting") => masih proses tanya-jawab,
//        tampilkan `message` ke user dan tunggu balasan berikutnya.
//
// ALUR:
//   0) CHOOSE_SUBMODE -> user pilih "Template" atau "Satu per satu"
//   1a) TEMPLATE: user kirim 1 pesan besar berformat "Label: Value" per baris
//   1b) QNA: bot tanya field satu per satu secara bertahap
//   2) Field yang kosong (khusus jalur Template) ditanya ulang satu per satu
//   3) Loop "tambah promo code lagi?" (Ya/Tidak)
//   4) Loop "tambah formula lagi?" (Ya/Tidak)
//   5) DONE -> return status "ready_to_execute" + data siap pakai isiPromotion()
// ==========================================================

// ---------- Field wajib (dipakai untuk validasi & prompt ulang) ----------
const REQUIRED_FIELDS = [
  { key: "nama", label: "Nama" },
  { key: "promotionType", label: "Promotion Type" },
  { key: "code", label: "Code" },
  { key: "maxUsed", label: "Max Used" },
  { key: "group", label: "Group" },
  { key: "agent", label: "Agent" },
  { key: "description", label: "Description" },
  { key: "minimumNight", label: "Minimum Night" },
  { key: "rates", label: "Rates" },
  { key: "formula", label: "Formula (DECREASE/INCREASE)" },
  { key: "formulaValueType", label: "Formula Value Type (AMOUNT/PERCENT)" },
  { key: "formulaValue", label: "Formula Value" },
];

// Field yang boleh kosong
const OPTIONAL_KEYS = ["agent"];

// ---------- Legenda Rates ----------
const RATES_LEGEND = `Untuk List Rates Affected:
1. DUO Santai (Select All, DUOGEI, SUPER DUO)
2. Honeymoon Package at Uma Desa (Select All, Honeymoon at Luxury Suite, Honeymoon at President Suite)
3. Japan Rate (Select All, Hashira Room Asian Only, Hashira Room Asian Only Copy, Hashira Room Japanese Only)
4. Khusus raja (Select All, khusus raja)
5. Membership Tier (Select All, Standart Room with Membership)
6. Membership Tier 1 (Select All, Standart Room with Membership (Tier 1))
7. Membership Tier 2 (Select All, Standart Room with Membership (Tier 2))
8. Membership Tier 3 (Select All, Standart Room with Membership (Tier 3))
9. Membership Tier 4 (Select All, Standart Room with Membership (Tier 4))
10. Membership Tier 5 (Select All, Standart Room with Membership (Tier 5))
11. OSHOMRUSH (Select All, OSHOMRUSH Garden View, OSHOMRUSH Garden View Copy, OSHOMRUSH Standart Room)
12. Package (Select All, Luxury Room Package, Single Room Pakages, Standar Package, Superior Room Package)
13. Package Honey Moon 7 Night (Select All, Luxury Honey Moon Package 7 Night)
14. Room and Breakfast (Select All, Garden View Room and Breakfast, Garden View Room and Breakfast Copy, Luxury Room with Breakfast, President Siute With Breakfast, Single Room With Breakfast, Standart Room With Breakfast, Superior Room With Breakfast, Virtual RnB)
15. Room Only (Select All, Capsul Room Only, Garden View Room Only, Luxury Room Only, President Suite Room Only, ROOM AJA RAJA BETARE, Sandart Room Only, Single Room Only, Superior Room Only, xxx Copy)
16. Standard (Select All, Standart with Promotion)
17. Standart Room with Baddie (Select All, Standart Room with Baddie)
18. SVR (Special VIP Rates) (Select All, Private Pool Villa 3 Bedroom SVR)
19. SVR BAR 1 (Select All, Private Pool Villa 3 Bedroom SVR (BAR 1))
20. SVR BAR 2 (Select All, Private Pool Villa 3 Bedroom SVR (BAR 2))
21. SVR BAR 3 (Select All, Private Pool Villa 3 Bedroom SVR (BAR 3))
22. SVR BAR 4 (Select All, Private Pool Villa 3 Bedroom SVR (BAR 4))
23. SVR BAR 5 (Select All, Private Pool Villa 3 Bedroom SVR (BAR 5))

Tulis di field Rates dalam format "Kategori | NamaRate" (bisa lebih dari satu, pisahkan dengan baris baru atau koma).`;

// ---------- Template yang dikirim ke user saat pilih "Template" ----------
const TEMPLATE_TEXT = `Silakan isi template berikut, lalu kirim sebagai 1 pesan:

Nama: 
Promotion Type: 
Code: 
Max Used: 
Group: 
Agent: 
Description: 
Minimum Night: 
Rates: 
Formula (DECREASE/INCREAS): 
Formula Value Type (AMOUNT/PERCENT): 
Formula Value: 

${RATES_LEGEND}`;

// ============================================================
// SESSION
// ============================================================

// Dipakai telegram.js saat masuk mode manual, dan index.js saat /reset-chat
function createEmptySession() {
  return {
    step: "CHOOSE_SUBMODE",
    submode: null, // 'template' | 'qna'
    data: {},
    promoCodes: [], // promo code TAMBAHAN (di luar yang pertama)
    formulas: [], // formula TAMBAHAN (di luar yang pertama)
    qnaIndex: 0,
    missingFields: [],
    missingIndex: 0,
    _pendingPromoCode: null,
    _pendingFormula: null,
  };
}

function getSession(sessionStore, chatId) {
  if (!sessionStore.has(chatId)) sessionStore.set(chatId, createEmptySession());
  return sessionStore.get(chatId);
}

// ============================================================
// UTIL
// ============================================================

function isYes(text) {
  return ["ya", "y", "yes", "iya", "1"].includes((text || "").trim().toLowerCase());
}

function isNo(text) {
  return ["tidak", "no", "t", "n", "gak", "enggak", "ga", "2"].includes(
    (text || "").trim().toLowerCase()
  );
}

// ---------- Parser template "Label: Value" per baris ----------
const LABEL_MAP = {
  nama: "nama",
  "promotion type": "promotionType",
  code: "code",
  "max used": "maxUsed",
  group: "group",
  agent: "agent",
  description: "description",
  "minimum night": "minimumNight",
  rates: "rates",
};

function matchLabelKey(rawLabel) {
  const label = rawLabel.trim().toLowerCase();
  if (label.startsWith("formula value type")) return "formulaValueType";
  if (label.startsWith("formula value")) return "formulaValue";
  if (label.startsWith("formula")) return "formula";
  return LABEL_MAP[label] || null;
}

function parseTemplate(text) {
  const lines = text.split("\n");
  const result = {};
  let currentKey = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const idx = line.indexOf(":");
    if (idx === -1) {
      // baris lanjutan (mis. Rates lebih dari 1 baris)
      if (currentKey) {
        result[currentKey] = ((result[currentKey] || "") + "\n" + line).trim();
      }
      continue;
    }

    const matchedKey = matchLabelKey(line.slice(0, idx));
    const value = line.slice(idx + 1).trim();

    if (matchedKey) {
      result[matchedKey] = value;
      currentKey = matchedKey;
    } else {
      currentKey = null;
    }
  }

  return result;
}

function findMissingFields(data) {
  return REQUIRED_FIELDS.filter((f) => {
    if (OPTIONAL_KEYS.includes(f.key)) return false;
    const v = data[f.key];
    return v === undefined || v === null || String(v).trim() === "";
  });
}

function fieldPrompt(field) {
  if (field.key === "rates") return `${RATES_LEGEND}\n\n${field.label}:`;
  return `${field.label}:`;
}

// ---------- Parser Rates string -> [{ category, rate }] ----------
function parseRatesString(str) {
  if (!str) return [];
  return str
    .split(/\n|,/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      if (line.includes("|")) {
        const [category, rate] = line.split("|").map((s) => s.trim());
        return { category: category || null, rate };
      }
      return { category: null, rate: line };
    });
}

// ---------- Bangun object data final untuk isiPromotion() ----------
function buildFinalData(session) {
  const d = session.data;

  const promoCodes = [
    { kode: d.code, maxUsed: Number(d.maxUsed) || 0 },
    ...session.promoCodes,
  ];

  const formulas = [
    {
      formula: (d.formula || "").toUpperCase(),
      formulaType: (d.formulaValueType || "").toUpperCase(),
      value: Number(d.formulaValue) || 0,
    },
    ...session.formulas,
  ];

  return {
    nama: d.nama,
    namaID: d.nama,
    type: d.promotionType,
    promoCodes,
    group: d.group,
    agent: d.agent || "",
    description: d.description,
    descriptionID: d.description,
    rates: parseRatesString(d.rates),
    formulas,
    minimumNight: Number(d.minimumNight) || 0,
  };
}

// ============================================================
// STATE MACHINE UTAMA
// ============================================================

function handlePromotionMessage(sessionStore, chatId, text) {
  const session = getSession(sessionStore, chatId);
  const t = (text || "").trim();

  switch (session.step) {
    // ---------------- PILIH SUBMODE: TEMPLATE / SATU PER SATU ----------------
    case "CHOOSE_SUBMODE": {
      if (/^(1|template)$/i.test(t)) {
        session.submode = "template";
        session.step = "TEMPLATE_WAIT_INPUT";
        return { status: "collecting", message: TEMPLATE_TEXT };
      }
      if (/^(2|satu per satu|1 per 1|tanya jawab|qna)$/i.test(t)) {
        session.submode = "qna";
        session.step = "QNA_FIELD";
        session.qnaIndex = 0;
        return { status: "collecting", message: fieldPrompt(REQUIRED_FIELDS[0]) };
      }
      return {
        status: "collecting",
        message: "Pilih cara input:\n1. Template\n2. Satu per satu",
      };
    }

    // ---------------- TUNGGU 1 PESAN BESAR (TEMPLATE) ----------------
    case "TEMPLATE_WAIT_INPUT": {
      const parsed = parseTemplate(t);
      session.data = { ...session.data, ...parsed };
      const missing = findMissingFields(session.data);

      if (missing.length > 0) {
        session.step = "TEMPLATE_MISSING_FIELDS";
        session.missingFields = missing;
        session.missingIndex = 0;
        return {
          status: "collecting",
          message:
            `Ada field yang masih kosong:\n${missing.map((f) => "- " + f.label).join("\n")}\n\n` +
            `Silakan isi satu per satu.\n\n${fieldPrompt(missing[0])}`,
        };
      }

      session.step = "ADD_PROMOCODE_CONFIRM";
      return {
        status: "collecting",
        message: "Semua data lengkap ✅\n\nApakah ingin menambahkan promo code lagi? (Ya/Tidak)",
      };
    }

    // ---------------- ISI FIELD YANG KOSONG SATU PER SATU (JALUR TEMPLATE) ----------------
    case "TEMPLATE_MISSING_FIELDS": {
      const field = session.missingFields[session.missingIndex];
      if (!t) {
        return {
          status: "collecting",
          message: `${field.label} tidak boleh kosong.\n\n${fieldPrompt(field)}`,
        };
      }
      session.data[field.key] = t;
      session.missingIndex += 1;

      if (session.missingIndex >= session.missingFields.length) {
        const stillMissing = findMissingFields(session.data);
        if (stillMissing.length > 0) {
          session.missingFields = stillMissing;
          session.missingIndex = 0;
          return { status: "collecting", message: fieldPrompt(stillMissing[0]) };
        }
        session.step = "ADD_PROMOCODE_CONFIRM";
        return {
          status: "collecting",
          message: "Semua data lengkap ✅\n\nApakah ingin menambahkan promo code lagi? (Ya/Tidak)",
        };
      }

      return { status: "collecting", message: fieldPrompt(session.missingFields[session.missingIndex]) };
    }

    // ---------------- TANYA JAWAB SATU PER SATU DARI AWAL (JALUR QNA) ----------------
    case "QNA_FIELD": {
      const field = REQUIRED_FIELDS[session.qnaIndex];
      if (!t && !OPTIONAL_KEYS.includes(field.key)) {
        return { status: "collecting", message: `${field.label} tidak boleh kosong.\n\n${fieldPrompt(field)}` };
      }
      session.data[field.key] = t;
      session.qnaIndex += 1;

      if (session.qnaIndex >= REQUIRED_FIELDS.length) {
        session.step = "ADD_PROMOCODE_CONFIRM";
        return {
          status: "collecting",
          message: "Semua data lengkap ✅\n\nApakah ingin menambahkan promo code lagi? (Ya/Tidak)",
        };
      }

      return { status: "collecting", message: fieldPrompt(REQUIRED_FIELDS[session.qnaIndex]) };
    }

    // ---------------- LOOP TAMBAH PROMO CODE ----------------
    case "ADD_PROMOCODE_CONFIRM": {
      if (isYes(t)) {
        session.step = "ASK_PROMOCODE_CODE";
        return { status: "collecting", message: "Code:" };
      }
      if (isNo(t)) {
        session.step = "ADD_FORMULA_CONFIRM";
        return { status: "collecting", message: "Apakah ingin menambahkan formula lagi? (Ya/Tidak)" };
      }
      return { status: "collecting", message: "Jawab Ya atau Tidak." };
    }

    case "ASK_PROMOCODE_CODE": {
      if (!t) return { status: "collecting", message: "Code tidak boleh kosong.\n\nCode:" };
      session._pendingPromoCode = { kode: t };
      session.step = "ASK_PROMOCODE_MAXUSED";
      return { status: "collecting", message: "Max Used:" };
    }

    case "ASK_PROMOCODE_MAXUSED": {
      if (!t || isNaN(Number(t))) {
        return { status: "collecting", message: "Max Used harus berupa angka.\n\nMax Used:" };
      }
      session._pendingPromoCode.maxUsed = Number(t);
      session.promoCodes.push(session._pendingPromoCode);
      session._pendingPromoCode = null;
      session.step = "ADD_PROMOCODE_CONFIRM";
      return {
        status: "collecting",
        message: "Promo code ditambahkan ✅\n\nApakah ingin menambahkan promo code lagi? (Ya/Tidak)",
      };
    }

    // ---------------- LOOP TAMBAH FORMULA ----------------
    case "ADD_FORMULA_CONFIRM": {
      if (isYes(t)) {
        session.step = "ASK_FORMULA_TYPE";
        return { status: "collecting", message: "Formula (DECREASE/INCREASE):" };
      }
      if (isNo(t)) {
        const finalData = buildFinalData(session);
        session.step = "DONE";
        return { status: "ready_to_execute", message: "Data lengkap, siap diproses ✅", data: finalData };
      }
      return { status: "collecting", message: "Jawab Ya atau Tidak." };
    }

    case "ASK_FORMULA_TYPE": {
      if (!/^(decrease|increase)$/i.test(t)) {
        return {
          status: "collecting",
          message: "Isi DECREASE atau INCREASE saja.\n\nFormula (DECREASE/INCREASE):",
        };
      }
      session._pendingFormula = { formula: t.toUpperCase() };
      session.step = "ASK_FORMULA_VALUETYPE";
      return { status: "collecting", message: "Formula Value Type (AMOUNT/PERCENT):" };
    }

    case "ASK_FORMULA_VALUETYPE": {
      if (!/^(amount|percent)$/i.test(t)) {
        return {
          status: "collecting",
          message: "Isi AMOUNT atau PERCENT saja.\n\nFormula Value Type (AMOUNT/PERCENT):",
        };
      }
      session._pendingFormula.formulaType = t.toUpperCase();
      session.step = "ASK_FORMULA_VALUE";
      return { status: "collecting", message: "Formula Value:" };
    }

    case "ASK_FORMULA_VALUE": {
      if (!t || isNaN(Number(t))) {
        return { status: "collecting", message: "Formula Value harus berupa angka.\n\nFormula Value:" };
      }
      session._pendingFormula.value = Number(t);
      session.formulas.push(session._pendingFormula);
      session._pendingFormula = null;
      session.step = "ADD_FORMULA_CONFIRM";
      return {
        status: "collecting",
        message: "Formula ditambahkan ✅\n\nApakah ingin menambahkan formula lagi? (Ya/Tidak)",
      };
    }

    // ---------------- SELESAI ----------------
    case "DONE": {
      return {
        status: "done",
        message: "Sesi ini sudah selesai. Ketik PROMOTION untuk mulai lagi.",
      };
    }

    // ---------------- FALLBACK ----------------
    default: {
      sessionStore.set(chatId, createEmptySession());
      return {
        status: "collecting",
        message: "Pilih cara input:\n1. Template\n2. Satu per satu",
      };
    }
  }
}

module.exports = {
  createEmptySession,
  handlePromotionMessage,
  getSession,
  parseTemplate,
  parseRatesString,
  buildFinalData,
  REQUIRED_FIELDS,
  TEMPLATE_TEXT,
  RATES_LEGEND,
};