// ==========================================================
// PARSER MANUAL - GuestPro Promotion Bot
// ==========================================================

// ---------- Konfigurasi field wajib (jalur Template) ----------
const REQUIRED_FIELDS = [
  { key: "nama", label: "Nama Promotion" },
  { key: "promotionType", label: "Promotion Type" },
  { key: "code", label: "Kode Promo" },
  { key: "maxUsed", label: "Max Used" },
  { key: "group", label: "Group" },
  { key: "description", label: "Description" },
  { key: "minimumNight", label: "Minimum Night" },
];

const OPTIONAL_KEYS = [];

const FIELD_VALIDATORS = {};

const TEMPLATE_TEXT = `Nama: 
Promotion Type: 
Code: 
Max Used: 
Group: 
Description: 
Minimum Night: `;

// ============================================================
// KATALOG RATES
// ============================================================

const RATES_CATALOG = [
  { name: "DUO Santai", items: ["DUOGEI", "SUPER DUO"] },
  {
    name: "Honeymoon Package at Uma Desa",
    items: ["Honeymoon at Luxury Suite", "Honeymoon at President Suite"],
  },
  {
    name: "Japan Rate",
    items: [
      "Hashira Room Asian Only",
      "Hashira Room Asian Only Copy",
      "Hashira Room Japanese Only",
    ],
  },
  { name: "Khusus raja", items: ["khusus raja"] },
  { name: "Membership Tier", items: ["Standart Room with Membership"] },
  { name: "Membership Tier 1", items: ["Standart Room with Membership (Tier 1)"] },
  { name: "Membership Tier 2", items: ["Standart Room with Membership (Tier 2)"] },
  { name: "Membership Tier 3", items: ["Standart Room with Membership (Tier 3)"] },
  { name: "Membership Tier 4", items: ["Standart Room with Membership (Tier 4)"] },
  { name: "Membership Tier 5", items: ["Standart Room with Membership (Tier 5)"] },
  {
    name: "OSHOMRUSH",
    items: [
      "OSHOMRUSH Garden View",
      "OSHOMRUSH Garden View Copy",
      "OSHOMRUSH Standart Room",
    ],
  },
  {
    name: "Package",
    items: [
      "Luxury Room Package",
      "Single Room Pakages",
      "Standar Package",
      "Superior Room Package",
    ],
  },
  {
    name: "Package Honey Moon 7 Night",
    items: ["Luxury Honey Moon Package 7 Night"],
  },
  {
    name: "Room and Breakfast",
    items: [
      "Garden View Room and Breakfast",
      "Garden View Room and Breakfast Copy",
      "Luxury Room with Breakfast",
      "President Siute With Breakfast",
      "Single Room With Breakfast",
      "Standart Room With Breakfast",
      "Superior Room With Breakfast",
      "Virtual RnB",
    ],
  },
  {
    name: "Room Only",
    items: [
      "Capsul Room Only",
      "Garden View Room Only",
      "Luxury Room Only",
      "President Suite Room Only",
      "ROOM AJA RAJA BETARE",
      "Sandart Room Only",
      "Single Room Only",
      "Superior Room Only",
      "xxx Copy",
    ],
  },
  { name: "Standard", items: ["Standart with Promotion"] },
  { name: "Standart Room with Baddie", items: ["Standart Room with Baddie"] },
  {
    name: "SVR (Special VIP Rates)",
    items: ["Private Pool Villa 3 Bedroom SVR"],
  },
  { name: "SVR BAR 1", items: ["Private Pool Villa 3 Bedroom SVR (BAR 1)"] },
  { name: "SVR BAR 2", items: ["Private Pool Villa 3 Bedroom SVR (BAR 2)"] },
  { name: "SVR BAR 3", items: ["Private Pool Villa 3 Bedroom SVR (BAR 3)"] },
  { name: "SVR BAR 4", items: ["Private Pool Villa 3 Bedroom SVR (BAR 4)"] },
  { name: "SVR BAR 5", items: ["Private Pool Villa 3 Bedroom SVR (BAR 5)"] },
];

// ============================================================
// KATALOG AGENT
// ============================================================

const AGENT_CATALOG = [
  "Agoda",
  "Booking Engine",
  "Booking.com",
  "Booking.com1",
  "Complimentary",
  "Direct",
  "Indra Kenz",
  "Opit Affiliate",
  "Opit Media Corp",
  "Ragil Influencer",
  "TEST CITY LEDGER",
  "Walkin",
];

// ============================================================
// HELPER: susun tombol jadi baris-baris (n per baris)
// ============================================================
function chunkButtons(buttons, perRow) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += perRow) {
    rows.push(buttons.slice(i, i + perRow));
  }
  return rows;
}

// ---------- Keyboard: pilih submode Manual ----------
function buildSubmodeKeyboard() {
  return [
    [
      { text: "📄 Template", callback_data: "sm:tpl" },
      { text: "💬 Tanya Jawab", callback_data: "sm:qna" },
    ],
  ];
}

// ---------- Keyboard: daftar kategori rates ----------
function buildCategoryKeyboard() {
  const buttons = RATES_CATALOG.map((c, i) => ({ text: c.name, callback_data: `rc:${i}` }));
  const rows = chunkButtons(buttons, 2);
  rows.push([{ text: "✅ Selesai Pilih Rates", callback_data: "rc:done" }]);
  return rows;
}

// ---------- Keyboard: daftar item di dalam 1 kategori (multi-select) ----------
function buildItemKeyboard(catIndex, selectedIdxSet) {
  const category = RATES_CATALOG[catIndex];
  const buttons = category.items.map((it, i) => ({
    text: `${selectedIdxSet.has(i) ? "✅" : "▫️"} ${it}`,
    callback_data: `ri:${i}`,
  }));
  const rows = chunkButtons(buttons, 1);
  rows.push([{ text: "🔘 Pilih Semua", callback_data: "ri:all" }]);
  rows.push([
    { text: "↩️ Batal", callback_data: "ri:cancel" },
    { text: "✅ Simpan & Kembali", callback_data: "ri:save" },
  ]);
  return rows;
}

function itemPromptText(catIndex, selectedIdxSet) {
  const category = RATES_CATALOG[catIndex];
  const count = selectedIdxSet.size;
  return (
    `Kategori: *${category.name}*\n` +
    `Pilih rate (bisa lebih dari satu, tekan lagi untuk batalkan pilihan):\n\n` +
    `${count > 0 ? `Terpilih: ${count} item` : "Belum ada yang dipilih"}`
  );
}

// ---------- Keyboard: daftar agent ----------
function buildAgentKeyboard() {
  const buttons = AGENT_CATALOG.map((a, i) => ({ text: a, callback_data: `ag:${i}` }));
  const rows = chunkButtons(buttons, 2);
  rows.push([{ text: "⏭️ Lewati (tidak ada agent)", callback_data: "ag:skip" }]);
  return rows;
}

// ---------- Keyboard: generik Ya/Tidak ----------
function buildYesNoKeyboard(ctx) {
  return [
    [
      { text: "✅ Ya", callback_data: `yn:${ctx}:y` },
      { text: "❌ Tidak", callback_data: `yn:${ctx}:n` },
    ],
  ];
}

// ---------- Keyboard: tipe formula ----------
function buildFormulaTypeKeyboard() {
  return [
    [
      { text: "⬇️ DECREASE", callback_data: "fm:dec" },
      { text: "⬆️ INCREASE", callback_data: "fm:inc" },
    ],
  ];
}

function buildFormulaValueTypeKeyboard() {
  return [
    [
      { text: "💰 AMOUNT", callback_data: "fv:amt" },
      { text: "% PERCENT", callback_data: "fv:pct" },
    ],
  ];
}

function formatSelectedRatesSummary(selectedRates) {
  if (selectedRates.length === 0) return "(belum ada rates dipilih)";
  return selectedRates.map((r) => `- ${r}`).join("\n");
}

// ============================================================
// KARTU RINGKASAN KONFIRMASI
// ============================================================
function buildConfirmationCard(d) {
  const promoCodesStr =
    d.promoCodes && d.promoCodes.length > 0
      ? d.promoCodes.map((p) => `${p.kode} (max ${p.maxUsed})`).join(", ")
      : "-";

  const ratesStr =
    d.rates && d.rates.length > 0 ? d.rates.map((r) => r.rate).join(", ") : "-";

  const formulaStr =
    d.formulas && d.formulas.length > 0
      ? d.formulas
          .map((f) => `${f.formula} ${f.value}${f.formulaType === "PERCENT" ? "%" : ""}`)
          .join(", ")
      : "-";

  return (
    "📋 *Ringkasan Promosi*\n" +
    "_Cek dulu sebelum dikirim ke GuestPro:_\n\n" +
    `*Nama:* ${d.nama}\n` +
    `*Tipe:* ${d.type}\n` +
    `*Kode Promo:* ${promoCodesStr}\n` +
    `*Group:* ${d.group || "-"}\n` +
    `*Agent:* ${d.agent || "-"}\n` +
    `*Deskripsi:* ${d.description}\n` +
    `*Min. Malam:* ${d.minimumNight}\n` +
    `*Rates:* ${ratesStr}\n` +
    `*Formula:* ${formulaStr}\n\n` +
    "Sudah benar semua?"
  );
}

function buildConfirmSendKeyboard() {
  return [
    [
      { text: "✅ Kirim Sekarang", callback_data: "cf:send" },
      { text: "✏️ Ubah Dulu", callback_data: "cf:edit" },
    ],
  ];
}

// ============================================================
// KEYBOARD EDIT PER-BAGIAN
// ============================================================
function buildEditMenuKeyboard() {
  return [
    [{ text: "✏️ Info Dasar (Nama, Type, Code, dst)", callback_data: "ed:basic" }],
    [{ text: "🤝 Agent", callback_data: "ed:agent" }],
    [{ text: "🏨 Rates", callback_data: "ed:rates" }],
    [{ text: "🎟️ Promo Code", callback_data: "ed:promo" }],
    [{ text: "🧮 Formula", callback_data: "ed:formula" }],
    [{ text: "⬅️ Batal, Kembali ke Ringkasan", callback_data: "ed:cancel" }],
  ];
}

// Generik: terima array field {key,label}, dipakai baik REQUIRED_FIELDS
// (parserManual) maupun BASIC_FIELDS (qnaFlow).
function buildFieldEditKeyboard(fields) {
  const buttons = fields.map((f, i) => ({ text: f.label, callback_data: `edf:${i}` }));
  const rows = chunkButtons(buttons, 2);
  rows.push([{ text: "⬅️ Batal", callback_data: "edf:cancel" }]);
  return rows;
}

// keyboard generik daftar item (dipakai Promo Code & Formula,
// di parserManual.js MAUPUN qnaFlow.js - satu sumber kebenaran).
function buildListItemsKeyboard(items, formatFn, itemPrefix, addCallback, addLabel, backCallback) {
  const rows = items.map((it, i) => [{ text: formatFn(it, i), callback_data: `${itemPrefix}${i}` }]);
  rows.push([{ text: addLabel, callback_data: addCallback }]);
  rows.push([{ text: "⬅️ Kembali ke Ringkasan", callback_data: backCallback }]);
  return rows;
}

function buildPromoListKeyboard(promoCodes) {
  return buildListItemsKeyboard(
    promoCodes,
    (p) => `${p.kode} (max ${p.maxUsed})`,
    "edpi:",
    "edp:add",
    "➕ Tambah Promo Code",
    "edp:back"
  );
}

function buildFormulaListKeyboard(formulas) {
  return buildListItemsKeyboard(
    formulas,
    (f) => `${f.formula} ${f.value}${f.formulaType === "PERCENT" ? "%" : ""}`,
    "edmi:",
    "edm:add",
    "➕ Tambah Formula",
    "edm:back"
  );
}

// keyboard aksi untuk 1 item (Edit / Hapus / Batal) - generik,
// callback_data-nya dikirim dari caller supaya bisa dipakai promo
// maupun formula.
function buildItemActionKeyboard(editCb, deleteCb, cancelCb) {
  return [
    [
      { text: "✏️ Edit", callback_data: editCb },
      { text: "🗑️ Hapus", callback_data: deleteCb },
    ],
    [{ text: "⬅️ Batal", callback_data: cancelCb }],
  ];
}

// ============================================================
// SESSION HELPERS
// ============================================================

function newSession() {
  return {
    step: "CHOOSE_MANUAL_SUBMODE",
    mode: "manual",
    submode: null,
    data: {},
    promoCodes: [], // promo code TAMBAHAN saja - yang pertama ada di data.code/data.maxUsed
    formulas: [],
    missingFields: [],
    missingIndex: 0,
    _pendingPromoCode: null,
    _pendingFormula: null,
    _selectedRates: [],
    _pendingRateCatIndex: null,
    _pendingItemSelection: null,
    _pendingFinalData: null,
    // state untuk edit per-bagian dari kartu ringkasan
    _editReturnTo: null, // null | "summary" | "promoList" | "formulaList"
    _editingFieldKey: null, // key REQUIRED_FIELDS yang sedang diedit (EDIT_BASIC_VALUE)
    _editingPromoIndex: null, // index session.promoCodes yang sedang ditimpa (null = lagi nambah baru)
    _editingFormulaIndex: null, // index session.formulas yang sedang ditimpa (null = lagi nambah baru)
  };
}

function getSession(sessionStore, chatId) {
  if (!sessionStore.has(chatId)) sessionStore.set(chatId, newSession());
  return sessionStore.get(chatId);
}
function resetSession(sessionStore, chatId) {
  sessionStore.set(chatId, newSession());
  return sessionStore.get(chatId);
}

function startManualSubmode(sessionStore, chatId) {
  resetSession(sessionStore, chatId);
  return {
    text: "Pilih cara input:",
    keyboard: buildSubmodeKeyboard(),
  };
}

function isYes(text) {
  return ["ya", "y", "yes", "iya", "1"].includes(String(text).trim().toLowerCase());
}
function isNo(text) {
  return ["tidak", "no", "t", "n", "gak", "enggak", "ga", "2"].includes(
    String(text).trim().toLowerCase()
  );
}

// ============================================================
// PARSER TEMPLATE
// ============================================================

const LABEL_MAP = {
  nama: "nama",
  "promotion type": "promotionType",
  code: "code",
  "max used": "maxUsed",
  group: "group",
  description: "description",
  "minimum night": "minimumNight",
  formula: "formula",
  "formula type": "formulaType",
  "formula value": "formulaValue",
};

function matchLabelKey(rawLabel) {
  const label = rawLabel.trim().toLowerCase();
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

// DIBIARKAN TETAP ADA (tidak dihapus) - sudah tidak dipanggil lagi di
// TEMPLATE_WAIT_INPUT, tapi tetap diexport untuk kompatibilitas kalau
// ada bagian lain yang memakainya di masa depan.
function findFieldIssues(data) {
  const issues = [];
  for (const f of REQUIRED_FIELDS) {
    if (OPTIONAL_KEYS.includes(f.key)) continue;
    const raw = data[f.key];
    const isEmpty = raw === undefined || raw === null || String(raw).trim() === "";

    if (isEmpty) {
      issues.push({ field: f, message: null });
      continue;
    }

    const validator = FIELD_VALIDATORS[f.key];
    if (validator) {
      const result = validator(raw);
      if (!result.ok) {
        issues.push({ field: f, message: result.message });
        continue;
      }
      data[f.key] = result.value;
    }
  }
  return issues;
}

function fieldPrompt(field, message) {
  return message ? `${message}\n\n${field.label}:` : `${field.label}:`;
}

// ============================================================
// PARSER RATES STRING -> [{ category, rate }]
// ============================================================
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

// ============================================================
// BANGUN OBJECT DATA FINAL
// ============================================================
function buildFinalData(session) {
  const d = session.data;

  const promoCodes = [{ kode: d.code, maxUsed: Number(d.maxUsed) || 0 }, ...session.promoCodes];

  const formulas = session.formulas.map((f) => ({
    formula: f.formula,
    formulaType: f.formulaType,
    value: f.value,
  }));

  return {
    nama: d.nama,
    namaID: d.nama,
    type: d.promotionType,
    promoCodes,
    group: d.group,
    agent: d.agent || "",
    description: d.description,
    descriptionID: d.description,
    rates: parseRatesString(session._selectedRates.join("\n")),
    formulas,
    minimumNight: Number(d.minimumNight) || 0,
  };
}

// helper - bangun ulang data final dari session, lalu balik ke kartu ringkasan
function goToConfirmSummary(session) {
  const finalData = buildFinalData(session);
  session._pendingFinalData = finalData;
  session.step = "CONFIRM_SUMMARY";
  return {
    reply: buildConfirmationCard(finalData),
    done: false,
    keyboard: buildConfirmSendKeyboard(),
  };
}

// helper generik - setelah 1 langkah edit selesai, tentukan mau balik
// ke mana berdasarkan session._editReturnTo.
// - "summary"     -> langsung ke kartu ringkasan (dipakai Agent, Rates, & nambah item baru)
// - "promoList"   -> balik ke daftar Promo Code (dipakai saat MENGEDIT item promo yang sudah ada)
// - "formulaList" -> balik ke daftar Formula (dipakai saat MENGEDIT item formula yang sudah ada)
function returnAfterEdit(session) {
  const target = session._editReturnTo;
  session._editReturnTo = null;

  if (target === "promoList") {
    session.step = "EDIT_PROMO_MENU";
    return {
      reply: `Promo code tambahan saat ini: ${session.promoCodes.length}`,
      done: false,
      keyboard: buildPromoListKeyboard(session.promoCodes),
    };
  }
  if (target === "formulaList") {
    session.step = "EDIT_FORMULA_MENU";
    return {
      reply: `Formula saat ini: ${session.formulas.length}`,
      done: false,
      keyboard: buildFormulaListKeyboard(session.formulas),
    };
  }
  // default / "summary"
  return goToConfirmSummary(session);
}

// ============================================================
// STATE MACHINE - INPUT TEKS BEBAS
// ============================================================
function handlePromotionMessage(sessionStore, chatId, text) {
  const session = getSession(sessionStore, chatId);
  const t = (text || "").trim();

  switch (session.step) {
    // PATCH: TIDAK LAGI mengecek findFieldIssues() di sini. Data
    // mentah dari template (termasuk field kosong) diterima apa
    // adanya, langsung lanjut ke ASK_AGENT. Field kosong baru
    // terdeteksi nanti di executorAgent.js (tahap penilaian akhir).
    case "TEMPLATE_WAIT_INPUT": {
      const parsed = parseTemplate(t);
      session.data = { ...session.data, ...parsed };

      session.step = "ASK_AGENT";
      return {
        reply: "Data diterima ✅\n\nSekarang pilih Agent:",
        done: false,
        keyboard: buildAgentKeyboard(),
      };
    }

    // case "TEMPLATE_MISSING_FIELDS" DIHAPUS - sudah tidak pernah
    // dituju lagi sejak TEMPLATE_WAIT_INPUT tidak lagi bercabang ke
    // situ. Validasi kelengkapan field sekarang murni tanggung jawab
    // executorAgent.js di tahap akhir.

    case "ASK_PROMOCODE_CODE": {
      if (!t) return { reply: "Code tidak boleh kosong.\n\nCode:", done: false };
      session._pendingPromoCode = { kode: t };
      session.step = "ASK_PROMOCODE_MAXUSED";
      return { reply: "Max Used:", done: false };
    }

    // MODIFIKASI: overwrite index tertentu kalau lagi mengedit item
    // yang sudah ada (_editingPromoIndex terisi), else push baru
    // seperti biasa. Lalu cek _editReturnTo untuk tentukan tujuan
    // balik.
    case "ASK_PROMOCODE_MAXUSED": {
      if (!t || isNaN(Number(t))) {
        return { reply: "Max Used harus berupa angka.\n\nMax Used:", done: false };
      }
      session._pendingPromoCode.maxUsed = Number(t);

      if (session._editingPromoIndex !== null && session._editingPromoIndex !== undefined) {
        session.promoCodes[session._editingPromoIndex] = session._pendingPromoCode;
        session._editingPromoIndex = null;
      } else {
        session.promoCodes.push(session._pendingPromoCode);
      }
      session._pendingPromoCode = null;

      if (session._editReturnTo) {
        return returnAfterEdit(session);
      }

      session.step = "ADD_PROMOCODE_CONFIRM";
      return {
        reply: "Promo code ditambahkan ✅\n\nApakah ingin menambahkan promo code lagi?",
        done: false,
        keyboard: buildYesNoKeyboard("promo"),
      };
    }

    // MODIFIKASI: sama - overwrite kalau _editingFormulaIndex terisi,
    // else push baru. Cek _editReturnTo lebih dulu sebelum logic
    // isFirstFormula (yang cuma relevan untuk alur normal/non-edit).
    case "ASK_FORMULA_VALUE": {
      if (!t || isNaN(Number(t))) {
        return { reply: "Formula Value harus berupa angka.\n\nFormula Value:", done: false };
      }

      const isFirstFormula = session.formulas.length === 0;
      session._pendingFormula.value = Number(t);

      if (session._editingFormulaIndex !== null && session._editingFormulaIndex !== undefined) {
        session.formulas[session._editingFormulaIndex] = session._pendingFormula;
        session._editingFormulaIndex = null;
      } else {
        session.formulas.push(session._pendingFormula);
      }
      session._pendingFormula = null;

      if (session._editReturnTo) {
        return returnAfterEdit(session);
      }

      if (isFirstFormula) {
        session.step = "ADD_PROMOCODE_CONFIRM";
        return {
          reply: "Formula tersimpan ✅\n\nApakah ingin menambahkan promo code lagi?",
          done: false,
          keyboard: buildYesNoKeyboard("promo"),
        };
      }

      session.step = "ADD_FORMULA_CONFIRM";
      return {
        reply: "Formula ditambahkan ✅\n\nApakah ingin menambahkan formula lagi?",
        done: false,
        keyboard: buildYesNoKeyboard("formula"),
      };
    }

    // input teks untuk edit 1 field dasar dari menu edit
    case "EDIT_BASIC_VALUE": {
      if (!t) return { reply: "Tidak boleh kosong. Masukkan nilai baru:", done: false };
      const key = session._editingFieldKey;
      const field = REQUIRED_FIELDS.find((f) => f.key === key);
      const validator = FIELD_VALIDATORS[key];

      if (validator) {
        const result = validator(t);
        if (!result.ok) {
          return { reply: fieldPrompt(field, result.message), done: false };
        }
        session.data[key] = result.value;
      } else {
        session.data[key] = t;
      }

      session._editingFieldKey = null;
      return goToConfirmSummary(session);
    }

    // ---------------- Step yang seharusnya dijawab lewat tombol ----------------
    case "CHOOSE_MANUAL_SUBMODE":
    case "ASK_AGENT":
    case "ASK_RATES_CATEGORY":
    case "ASK_RATES_ITEM":
    case "ADD_PROMOCODE_CONFIRM":
    case "ADD_FORMULA_CONFIRM":
    case "ASK_FORMULA_TYPE":
    case "ASK_FORMULA_VALUETYPE":
    case "CONFIRM_SUMMARY":
    case "EDIT_MENU":
    case "EDIT_BASIC_CHOOSE":
    case "EDIT_PROMO_MENU":
    case "EDIT_PROMO_ITEM":
    case "EDIT_FORMULA_MENU":
    case "EDIT_FORMULA_ITEM": {
      return { reply: "Silakan pilih salah satu tombol di atas ya 🙏", done: false };
    }

    case "DONE": {
      return { reply: "Sesi ini sudah selesai. Ketik PROMOTION untuk mulai lagi.", done: true };
    }

    default: {
      resetSession(sessionStore, chatId);
      return {
        reply: "Pilih cara input:",
        done: false,
        keyboard: buildSubmodeKeyboard(),
      };
    }
  }
}

// ============================================================
// STATE MACHINE - CALLBACK TOMBOL
// ============================================================
function handlePromotionCallback(sessionStore, chatId, data) {
  const session = getSession(sessionStore, chatId);

  switch (session.step) {
    case "CHOOSE_MANUAL_SUBMODE": {
      if (data === "sm:tpl") {
        session.submode = "template";
        session.step = "TEMPLATE_WAIT_INPUT";
        return {
          reply:
            `Silakan isi template berikut, lalu kirim sebagai 1 pesan ` +
            `(Agent, Rates, Formula, serta tambahan promo code/formula kalau ada, akan ditanyakan lewat tombol setelah ini):\n\n${TEMPLATE_TEXT}`,
          done: false,
          keyboard: null,
        };
      }
      if (data === "sm:qna") {
        session.submode = "qna";
        session.step = "DONE";
        return { reply: null, done: false, delegateToQnA: true };
      }
      return null;
    }

    case "ASK_AGENT": {
      const isEdit = !!session._editReturnTo;

      if (data === "ag:skip") {
        session.data.agent = "";
      } else {
        const m = /^ag:(\d+)$/.exec(data);
        if (!m) return null;
        const idx = Number(m[1]);
        if (idx < 0 || idx >= AGENT_CATALOG.length) return null;
        session.data.agent = AGENT_CATALOG[idx];
      }

      if (isEdit) {
        return returnAfterEdit(session);
      }

      session.step = "ASK_RATES_CATEGORY";
      session._selectedRates = [];
      return {
        reply: `Agent dipilih: ${session.data.agent || "(dilewati)"} ✅\n\nSekarang pilih Rates dari tombol di bawah:`,
        done: false,
        keyboard: buildCategoryKeyboard(),
      };
    }

    case "ASK_RATES_CATEGORY": {
      if (data === "rc:done") {
        if (session._selectedRates.length === 0) {
          return {
            reply: "Belum ada rates yang dipilih. Pilih minimal 1 kategori dulu:",
            done: false,
            keyboard: buildCategoryKeyboard(),
          };
        }
        session.data.rates = session._selectedRates.join("\n");

        if (session._editReturnTo) {
          return returnAfterEdit(session);
        }

        session.step = "ASK_FORMULA_TYPE";
        return {
          reply:
            `Rates tersimpan ✅\n${formatSelectedRatesSummary(session._selectedRates)}\n\n` +
            `Sekarang pilih Formula:`,
          done: false,
          keyboard: buildFormulaTypeKeyboard(),
        };
      }

      const m = /^rc:(\d+)$/.exec(data);
      if (!m) return null;
      const catIndex = Number(m[1]);
      if (catIndex < 0 || catIndex >= RATES_CATALOG.length) return null;

      session._pendingRateCatIndex = catIndex;

      // FIX BUG: pre-populate checkbox dari _selectedRates yang sudah
      // ada, bukan selalu mulai kosong.
      const category = RATES_CATALOG[catIndex];
      const preSelected = new Set();
      category.items.forEach((item, i) => {
        if (session._selectedRates.includes(`${category.name} | ${item}`)) preSelected.add(i);
      });
      session._pendingItemSelection = preSelected;
      session.step = "ASK_RATES_ITEM";
      return {
        reply: itemPromptText(catIndex, preSelected),
        done: false,
        keyboard: buildItemKeyboard(catIndex, preSelected),
      };
    }

    case "ASK_RATES_ITEM": {
      const catIndex = session._pendingRateCatIndex;
      const category = RATES_CATALOG[catIndex];
      const selected = session._pendingItemSelection;

      if (data === "ri:all") {
        if (selected.size === category.items.length) {
          selected.clear();
        } else {
          category.items.forEach((_, i) => selected.add(i));
        }
        return {
          reply: itemPromptText(catIndex, selected),
          done: false,
          keyboard: buildItemKeyboard(catIndex, selected),
        };
      }

      if (data === "ri:cancel") {
        session._pendingRateCatIndex = null;
        session._pendingItemSelection = null;
        session.step = "ASK_RATES_CATEGORY";
        return {
          reply: `Dibatalkan.\n${formatSelectedRatesSummary(session._selectedRates)}\n\nPilih kategori lain:`,
          done: false,
          keyboard: buildCategoryKeyboard(),
        };
      }

      // FIX BUG: sync penuh (hapus dulu semua baris kategori ini,
      // baru tambah ulang yang masih tercentang) - bukan cuma nambah.
      if (data === "ri:save") {
        if (selected.size === 0) {
          return {
            reply: `Belum ada item dipilih di kategori ini.\n\n${itemPromptText(catIndex, selected)}`,
            done: false,
            keyboard: buildItemKeyboard(catIndex, selected),
          };
        }
        session._selectedRates = session._selectedRates.filter(
          (line) => !line.startsWith(`${category.name} | `)
        );
        for (const idx of selected) {
          session._selectedRates.push(`${category.name} | ${category.items[idx]}`);
        }
        session._pendingRateCatIndex = null;
        session._pendingItemSelection = null;
        session.step = "ASK_RATES_CATEGORY";
        return {
          reply:
            `Rates kategori ini diperbarui ✅\n${formatSelectedRatesSummary(session._selectedRates)}\n\n` +
            `Pilih kategori lain, atau tekan "Selesai":`,
          done: false,
          keyboard: buildCategoryKeyboard(),
        };
      }

      const m = /^ri:(\d+)$/.exec(data);
      if (!m) return null;
      const itemIdx = Number(m[1]);
      if (itemIdx < 0 || itemIdx >= category.items.length) return null;

      if (selected.has(itemIdx)) selected.delete(itemIdx);
      else selected.add(itemIdx);

      return {
        reply: itemPromptText(catIndex, selected),
        done: false,
        keyboard: buildItemKeyboard(catIndex, selected),
      };
    }

    case "ADD_PROMOCODE_CONFIRM": {
      if (data === "yn:promo:y") {
        session.step = "ASK_PROMOCODE_CODE";
        return { reply: "Code:", done: false, keyboard: null };
      }
      if (data === "yn:promo:n") {
        session.step = "ADD_FORMULA_CONFIRM";
        return {
          reply: "Apakah ingin menambahkan formula lagi (selain yang sudah dipilih tadi)?",
          done: false,
          keyboard: buildYesNoKeyboard("formula"),
        };
      }
      return null;
    }

    case "ADD_FORMULA_CONFIRM": {
      if (data === "yn:formula:y") {
        session.step = "ASK_FORMULA_TYPE";
        return { reply: "Formula tambahan-nya apa?", done: false, keyboard: buildFormulaTypeKeyboard() };
      }
      if (data === "yn:formula:n") {
        return goToConfirmSummary(session);
      }
      return null;
    }

    case "ASK_FORMULA_TYPE": {
      if (data !== "fm:dec" && data !== "fm:inc") return null;
      session._pendingFormula = { formula: data === "fm:dec" ? "DECREASE" : "INCREASE" };
      session.step = "ASK_FORMULA_VALUETYPE";
      return { reply: "Formula Value Type-nya apa?", done: false, keyboard: buildFormulaValueTypeKeyboard() };
    }

    case "ASK_FORMULA_VALUETYPE": {
      if (data !== "fv:amt" && data !== "fv:pct") return null;
      session._pendingFormula.formulaType = data === "fv:amt" ? "AMOUNT" : "PERCENT";
      session.step = "ASK_FORMULA_VALUE";
      return { reply: "Formula Value: (ketik angkanya)", done: false, keyboard: null };
    }

    case "CONFIRM_SUMMARY": {
      if (data === "cf:send") {
        session.step = "DONE";
        return {
          reply: "Data lengkap, siap diproses ✅",
          done: true,
          data: session._pendingFinalData,
          keyboard: null,
        };
      }
      if (data === "cf:edit") {
        session.step = "EDIT_MENU";
        return { reply: "Bagian mana yang mau diedit?", done: false, keyboard: buildEditMenuKeyboard() };
      }
      return null;
    }

    // ==================== MENU EDIT PER-BAGIAN ====================
    case "EDIT_MENU": {
      if (data === "ed:cancel") return goToConfirmSummary(session);

      if (data === "ed:basic") {
        session.step = "EDIT_BASIC_CHOOSE";
        return { reply: "Field mana yang mau diubah?", done: false, keyboard: buildFieldEditKeyboard(REQUIRED_FIELDS) };
      }
      if (data === "ed:agent") {
        session._editReturnTo = "summary";
        session.step = "ASK_AGENT";
        return {
          reply: `Agent sekarang: ${session.data.agent || "-"}\n\nPilih Agent baru:`,
          done: false,
          keyboard: buildAgentKeyboard(),
        };
      }
      if (data === "ed:rates") {
        session._editReturnTo = "summary";
        session.step = "ASK_RATES_CATEGORY";
        return {
          reply: `Rates sekarang:\n${formatSelectedRatesSummary(session._selectedRates)}\n\nPilih kategori untuk tambah/ubah, atau tekan "Selesai":`,
          done: false,
          keyboard: buildCategoryKeyboard(),
        };
      }
      if (data === "ed:promo") {
        session.step = "EDIT_PROMO_MENU";
        return {
          reply: `Promo code tambahan saat ini: ${session.promoCodes.length}\n(kode & max used yang pertama diedit lewat "Info Dasar")`,
          done: false,
          keyboard: buildPromoListKeyboard(session.promoCodes),
        };
      }
      if (data === "ed:formula") {
        session.step = "EDIT_FORMULA_MENU";
        return {
          reply: `Formula saat ini: ${session.formulas.length}`,
          done: false,
          keyboard: buildFormulaListKeyboard(session.formulas),
        };
      }
      return null;
    }

    case "EDIT_BASIC_CHOOSE": {
      if (data === "edf:cancel") return goToConfirmSummary(session);
      const m = /^edf:(\d+)$/.exec(data);
      if (!m) return null;
      const idx = Number(m[1]);
      if (idx < 0 || idx >= REQUIRED_FIELDS.length) return null;

      session._editingFieldKey = REQUIRED_FIELDS[idx].key;
      session.step = "EDIT_BASIC_VALUE";
      return {
        reply: `Nilai sekarang: ${session.data[REQUIRED_FIELDS[idx].key]}\n\nMasukkan nilai baru untuk ${REQUIRED_FIELDS[idx].label}:`,
        done: false,
        keyboard: null,
      };
    }

    // daftar promo code tambahan - tekan item -> aksi Edit/Hapus
    case "EDIT_PROMO_MENU": {
      if (data === "edp:back") return goToConfirmSummary(session);

      if (data === "edp:add") {
        session._editingPromoIndex = null;
        session._editReturnTo = "promoList";
        session.step = "ASK_PROMOCODE_CODE";
        return { reply: "Code promo baru:", done: false, keyboard: null };
      }

      const m = /^edpi:(\d+)$/.exec(data);
      if (!m) return null;
      const idx = Number(m[1]);
      if (idx < 0 || idx >= session.promoCodes.length) return null;

      session._editingPromoIndex = idx;
      session.step = "EDIT_PROMO_ITEM";
      const p = session.promoCodes[idx];
      return {
        reply: `Promo code: *${p.kode}* (max ${p.maxUsed})\n\nMau diapakan?`,
        done: false,
        keyboard: buildItemActionKeyboard("edpa:edit", "edpa:delete", "edpa:cancel"),
      };
    }

    // aksi untuk 1 promo code (Edit / Hapus / Batal)
    case "EDIT_PROMO_ITEM": {
      const idx = session._editingPromoIndex;

      if (data === "edpa:cancel") {
        session._editingPromoIndex = null;
        session.step = "EDIT_PROMO_MENU";
        return {
          reply: `Promo code tambahan saat ini: ${session.promoCodes.length}`,
          done: false,
          keyboard: buildPromoListKeyboard(session.promoCodes),
        };
      }

      if (data === "edpa:delete") {
        const removed = session.promoCodes[idx];
        session.promoCodes.splice(idx, 1);
        session._editingPromoIndex = null;
        session.step = "EDIT_PROMO_MENU";
        return {
          reply: `Promo code "${removed.kode}" dihapus ✅`,
          done: false,
          keyboard: buildPromoListKeyboard(session.promoCodes),
        };
      }

      if (data === "edpa:edit") {
        // _editingPromoIndex TETAP terisi - dipakai untuk menimpa
        // (bukan push baru) begitu ASK_PROMOCODE_MAXUSED selesai.
        session._editReturnTo = "promoList";
        session.step = "ASK_PROMOCODE_CODE";
        return {
          reply: `Code sekarang: ${session.promoCodes[idx].kode}\n\nCode baru (mengganti yang lama):`,
          done: false,
          keyboard: null,
        };
      }

      return null;
    }

    // daftar formula - tekan item -> aksi Edit/Hapus
    case "EDIT_FORMULA_MENU": {
      if (data === "edm:back") return goToConfirmSummary(session);

      if (data === "edm:add") {
        session._editingFormulaIndex = null;
        session._editReturnTo = "formulaList";
        session.step = "ASK_FORMULA_TYPE";
        return { reply: "Formula baru, tipenya apa?", done: false, keyboard: buildFormulaTypeKeyboard() };
      }

      const m = /^edmi:(\d+)$/.exec(data);
      if (!m) return null;
      const idx = Number(m[1]);
      if (idx < 0 || idx >= session.formulas.length) return null;

      session._editingFormulaIndex = idx;
      session.step = "EDIT_FORMULA_ITEM";
      const f = session.formulas[idx];
      return {
        reply: `Formula: *${f.formula} ${f.value}${f.formulaType === "PERCENT" ? "%" : ""}*\n\nMau diapakan?`,
        done: false,
        keyboard: buildItemActionKeyboard("edma:edit", "edma:delete", "edma:cancel"),
      };
    }

    // aksi untuk 1 formula (Edit / Hapus / Batal)
    case "EDIT_FORMULA_ITEM": {
      const idx = session._editingFormulaIndex;

      if (data === "edma:cancel") {
        session._editingFormulaIndex = null;
        session.step = "EDIT_FORMULA_MENU";
        return {
          reply: `Formula saat ini: ${session.formulas.length}`,
          done: false,
          keyboard: buildFormulaListKeyboard(session.formulas),
        };
      }

      if (data === "edma:delete") {
        const removed = session.formulas[idx];
        session.formulas.splice(idx, 1);
        session._editingFormulaIndex = null;
        session.step = "EDIT_FORMULA_MENU";
        return {
          reply: `Formula "${removed.formula} ${removed.value}${removed.formulaType === "PERCENT" ? "%" : ""}" dihapus ✅`,
          done: false,
          keyboard: buildFormulaListKeyboard(session.formulas),
        };
      }

      if (data === "edma:edit") {
        // _editingFormulaIndex TETAP terisi - dipakai untuk menimpa
        // begitu ASK_FORMULA_VALUE selesai.
        session._editReturnTo = "formulaList";
        session.step = "ASK_FORMULA_TYPE";
        return {
          reply: "Pilih tipe formula baru (mengganti yang lama):",
          done: false,
          keyboard: buildFormulaTypeKeyboard(),
        };
      }

      return null;
    }

    default:
      return null;
  }
}

module.exports = {
  startManualSubmode,
  handlePromotionMessage,
  handlePromotionCallback,
  resetSession,
  getSession,
  parseTemplate,
  parseRatesString,
  buildFinalData,
  REQUIRED_FIELDS,
  RATES_CATALOG,
  AGENT_CATALOG,
  buildCategoryKeyboard,
  buildItemKeyboard,
  itemPromptText,
  formatSelectedRatesSummary,
  chunkButtons,
  buildConfirmationCard,
  buildConfirmSendKeyboard,
  buildEditMenuKeyboard,
  buildFieldEditKeyboard,
  buildListItemsKeyboard,
  buildPromoListKeyboard,
  buildFormulaListKeyboard,
  buildItemActionKeyboard,
};