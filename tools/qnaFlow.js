// ==========================================================
// QNA FLOW - GuestPro Promotion Bot (TANPA LLM SAMA SEKALI)
// ==========================================================
// (histori PATCH lama: submode via kartu ringkasan, edit per-bagian
// - lihat versi-versi sebelumnya)
//
// PATCH (BARU - edit per-ITEM untuk Promo Code & Formula):
// Sama seperti parserManual.js: menu edit Promo Code / Formula
// sekarang menampilkan daftar item, tiap item bisa di-Edit (timpa)
// atau Hapus (spesifik, bukan cuma yang terakhir). Bedanya dengan
// jalur Template: di sini SEMUA kode promo (termasuk yang pertama)
// ada di satu array yang sama, session.data.promoCodes - jadi tidak
// ada pengecualian "kode pertama diedit lewat Info Dasar" seperti di
// parserManual.js.
// ==========================================================

const {
  RATES_CATALOG,
  buildCategoryKeyboard,
  buildItemKeyboard,
  itemPromptText,
  formatSelectedRatesSummary,
  parseRatesString,
  buildConfirmationCard,
  buildConfirmSendKeyboard,
  buildEditMenuKeyboard,
  buildFieldEditKeyboard,
  buildPromoListKeyboard,
  buildFormulaListKeyboard,
  buildItemActionKeyboard,
} = require("./parserManual");

// ============================================================
// DAFTAR AGENT (TOMBOL TETAP)
// ============================================================

const AGENT_LIST = [
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

// field dasar yang bisa diedit lewat EDIT_BASIC_VALUE
// (promoCodes/rates/formulas/agent punya submenu sendiri)
const BASIC_FIELDS = [
  { key: "nama", label: "Nama Promotion" },
  { key: "promotionType", label: "Promotion Type" },
  { key: "group", label: "Group" },
  { key: "description", label: "Description" },
  { key: "minimumNight", label: "Minimum Night" },
];

// ---------- util ya/tidak ----------
function meansNone(t) {
  return [
    "tidak ada",
    "kosong",
    "-",
    "skip",
    "gaada",
    "ga ada",
    "tidak",
    "none",
  ].includes(String(t).trim().toLowerCase());
}

// ============================================================
// KEYBOARD HELPERS
// ============================================================

function buildYesNoKeyboard(ctx) {
  return [
    [
      { text: "✅ Ya", callback_data: `yn:${ctx}:y` },
      { text: "❌ Tidak", callback_data: `yn:${ctx}:n` },
    ],
  ];
}

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

function buildAgentKeyboard() {
  const rows = AGENT_LIST.map((name, i) => [
    { text: name, callback_data: `ag:${i}` },
  ]);
  rows.push([{ text: "🚫 Tidak Ada", callback_data: "ag:none" }]);
  return rows;
}

// ============================================================
// SESSION
// ============================================================

function newSession() {
  return {
    step: "ASK_NAMA",

    data: {
      nama: null,
      promotionType: null,
      promoCodes: [],
      group: "",
      agent: "",
      description: null,
      minimumNight: null,
      rates: [],
      formulas: [],
    },

    _pendingPromoCode: null,
    _pendingFormula: null,

    _selectedRates: [],
    _pendingRateCatIndex: null,
    _pendingItemSelection: null,

    _pendingFinalData: null,

    // state untuk edit per-bagian dari kartu ringkasan
    _editReturnTo: null, // null | "summary" | "promoList" | "formulaList"
    _editingFieldKey: null,
    _editingPromoIndex: null, // index data.promoCodes yang sedang ditimpa (null = lagi nambah baru)
    _editingFormulaIndex: null, // index data.formulas yang sedang ditimpa (null = lagi nambah baru)
  };
}

const sessions = new Map();

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, newSession());
  }
  return sessions.get(chatId);
}

function resetSession(chatId) {
  sessions.set(chatId, newSession());
  return sessions.get(chatId);
}

function startQnA(chatId) {
  resetSession(chatId);
  return "Mode Tanya Jawab (1 per 1).\n\nNama Promotion?";
}

// helper - bangun ulang data final dari session.data, lalu balik ke kartu ringkasan
function goToConfirmSummary(session) {
  const finalData = buildFinalData(session.data);
  session._pendingFinalData = finalData;
  session.step = "CONFIRM_SUMMARY";
  return {
    reply: buildConfirmationCard(finalData),
    done: false,
    keyboard: buildConfirmSendKeyboard(),
  };
}

// helper generik - setelah 1 langkah edit selesai, tentukan balik
// ke mana berdasarkan session._editReturnTo (sama pola dengan
// parserManual.js, cuma referensi ke session.data.promoCodes /
// session.data.formulas).
function returnAfterEdit(session) {
  const target = session._editReturnTo;
  session._editReturnTo = null;

  if (target === "promoList") {
    session.step = "EDIT_PROMO_MENU";
    return {
      reply: `Promo code saat ini: ${session.data.promoCodes.length}`,
      done: false,
      keyboard: buildPromoListKeyboard(session.data.promoCodes),
    };
  }
  if (target === "formulaList") {
    session.step = "EDIT_FORMULA_MENU";
    return {
      reply: `Formula saat ini: ${session.data.formulas.length}`,
      done: false,
      keyboard: buildFormulaListKeyboard(session.data.formulas),
    };
  }
  return goToConfirmSummary(session);
}

// ============================================================
// STATE MACHINE - INPUT TEKS BEBAS
// ============================================================

async function handleUserMessage(chatId, userText) {
  const session = getSession(chatId);
  const t = (userText || "").trim();

  switch (session.step) {
    case "ASK_NAMA": {
      if (!t) return { reply: "Nama tidak boleh kosong. Nama Promotion?", done: false };

      session.data.nama = t;
      session.step = "ASK_TYPE";
      return { reply: "Promotion Type-nya apa? (contoh: PROMO CODE)", done: false };
    }

    case "ASK_TYPE": {
      if (!t) return { reply: "Tidak boleh kosong. Promotion Type-nya apa?", done: false };

      session.data.promotionType = t;
      session.step = "ASK_PROMOCODE_KODE";
      return { reply: "Kode promo-nya apa?", done: false };
    }

    case "ASK_PROMOCODE_KODE": {
      if (!t) return { reply: "Kode tidak boleh kosong. Kode promo-nya apa?", done: false };

      session._pendingPromoCode = { kode: t };
      session.step = "ASK_PROMOCODE_MAXUSED";
      return { reply: "Max Used-nya berapa? (angka)", done: false };
    }

    // MODIFIKASI: overwrite index tertentu kalau lagi mengedit item
    // yang sudah ada, else push baru. Cek _editReturnTo untuk tujuan balik.
    case "ASK_PROMOCODE_MAXUSED": {
      if (!t || isNaN(Number(t))) {
        return { reply: "Harus angka. Max Used-nya berapa?", done: false };
      }

      session._pendingPromoCode.maxUsed = Number(t);

      if (session._editingPromoIndex !== null && session._editingPromoIndex !== undefined) {
        session.data.promoCodes[session._editingPromoIndex] = session._pendingPromoCode;
        session._editingPromoIndex = null;
      } else {
        session.data.promoCodes.push(session._pendingPromoCode);
      }
      session._pendingPromoCode = null;

      if (session._editReturnTo) {
        return returnAfterEdit(session);
      }

      session.step = "ASK_PROMOCODE_MORE";
      return {
        reply: "Ada kode promo tambahan?",
        done: false,
        keyboard: buildYesNoKeyboard("promo"),
      };
    }

    case "ASK_GROUP": {
      session.data.group = meansNone(t) ? "" : t;

      session.step = "ASK_DESCRIPTION";
      return { reply: "Deskripsi promotion-nya apa?", done: false };
    }

    case "ASK_DESCRIPTION": {
      if (!t) return { reply: "Tidak boleh kosong. Deskripsi promotion-nya apa?", done: false };

      session.data.description = t;
      session.step = "ASK_MIN_NIGHT";
      return { reply: "Minimum malam menginapnya berapa?", done: false };
    }

    case "ASK_MIN_NIGHT": {
      if (!t || isNaN(Number(t))) {
        return { reply: "Harus angka. Minimum malam menginapnya berapa?", done: false };
      }

      session.data.minimumNight = Number(t);
      session.step = "ASK_AGENT_BUTTON";
      return {
        reply: "Untuk Agent apa? Pilih salah satu:",
        done: false,
        keyboard: buildAgentKeyboard(),
      };
    }

    // MODIFIKASI: overwrite index tertentu kalau lagi mengedit item
    // yang sudah ada, else push baru. Cek _editReturnTo lebih dulu.
    case "ASK_FORMULA_VALUE": {
      if (!t || isNaN(Number(t))) {
        return { reply: "Harus angka. Value-nya berapa?", done: false };
      }

      session._pendingFormula.value = Number(t);

      if (session._editingFormulaIndex !== null && session._editingFormulaIndex !== undefined) {
        session.data.formulas[session._editingFormulaIndex] = session._pendingFormula;
        session._editingFormulaIndex = null;
      } else {
        session.data.formulas.push(session._pendingFormula);
      }
      session._pendingFormula = null;

      if (session._editReturnTo) {
        return returnAfterEdit(session);
      }

      session.step = "ASK_FORMULA_MORE";
      return {
        reply: "Formula tersimpan ✅\n\nAda formula tambahan?",
        done: false,
        keyboard: buildYesNoKeyboard("formula"),
      };
    }

    // input teks untuk edit 1 field dasar dari menu edit
    case "EDIT_BASIC_VALUE": {
      if (!t) return { reply: "Tidak boleh kosong. Masukkan nilai baru:", done: false };
      const key = session._editingFieldKey;
      const field = BASIC_FIELDS.find((f) => f.key === key);

      if (key === "group") {
        session.data.group = meansNone(t) ? "" : t;
      } else if (key === "minimumNight") {
        if (isNaN(Number(t))) {
          return { reply: `Harus angka.\n\nMasukkan nilai baru untuk ${field.label}:`, done: false };
        }
        session.data.minimumNight = Number(t);
      } else {
        session.data[key] = t;
      }

      session._editingFieldKey = null;
      return goToConfirmSummary(session);
    }

    // ---------------- STATE BUTTON ONLY ----------------
    case "ASK_AGENT_BUTTON":
    case "ASK_PROMOCODE_MORE":
    case "ASK_RATES_CATEGORY":
    case "ASK_RATES_ITEM":
    case "ASK_FORMULA_TYPE":
    case "ASK_FORMULA_VALUETYPE":
    case "ASK_FORMULA_MORE":
    case "CONFIRM_SUMMARY":
    case "EDIT_MENU":
    case "EDIT_BASIC_CHOOSE":
    case "EDIT_PROMO_MENU":
    case "EDIT_PROMO_ITEM":
    case "EDIT_FORMULA_MENU":
    case "EDIT_FORMULA_ITEM": {
      return { reply: "Silakan pilih salah satu tombol di atas ya 🙏", done: false };
    }

    case "DONE":
    default: {
      resetSession(chatId);
      return { reply: "Sesi direset. Ketik PROMOTION untuk mulai lagi.", done: false };
    }
  }
}

// ============================================================
// STATE MACHINE - CALLBACK TOMBOL
// ============================================================

async function handleUserCallback(chatId, data) {
  const session = getSession(chatId);

  switch (session.step) {
    case "ASK_AGENT_BUTTON": {
      const isEdit = !!session._editReturnTo;

      if (data === "ag:none") {
        session.data.agent = "";
      } else {
        const m = /^ag:(\d+)$/.exec(data);
        if (!m) return null;

        const idx = Number(m[1]);
        if (idx < 0 || idx >= AGENT_LIST.length) return null;

        session.data.agent = AGENT_LIST[idx];
      }

      if (isEdit) {
        return returnAfterEdit(session);
      }

      session.step = "ASK_RATES_CATEGORY";
      session._selectedRates = [];

      return {
        reply: "Sekarang pilih Rates dari tombol di bawah:",
        done: false,
        keyboard: buildCategoryKeyboard(),
      };
    }

    case "ASK_PROMOCODE_MORE": {
      if (data === "yn:promo:y") {
        session.step = "ASK_PROMOCODE_KODE";
        return { reply: "Kode promo-nya apa?", done: false, keyboard: null };
      }

      if (data === "yn:promo:n") {
        session.step = "ASK_GROUP";
        return {
          reply: "Untuk Group apa? (nama group, atau ketik 'tidak ada')",
          done: false,
          keyboard: null,
        };
      }

      return null;
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

        session.data.rates = parseRatesString(session._selectedRates.join("\n"));

        if (session._editReturnTo) {
          return returnAfterEdit(session);
        }

        session.step = "ASK_FORMULA_TYPE";

        return {
          reply:
            `Rates tersimpan ✅\n` +
            `${formatSelectedRatesSummary(session._selectedRates)}\n\n` +
            `Sekarang pilih Formula pertama:`,
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

      // FIX BUG: sync penuh - hapus dulu semua baris kategori ini,
      // baru tambah ulang yang masih tercentang.
      if (data === "ri:save") {
        if (selected.size === 0) {
          return {
            reply: `Belum ada item dipilih.\n\n${itemPromptText(catIndex, selected)}`,
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
          reply: `Rates kategori ini diperbarui ✅\n${formatSelectedRatesSummary(session._selectedRates)}\n\nPilih kategori lain, atau tekan "Selesai":`,
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

    case "ASK_FORMULA_TYPE": {
      if (data !== "fm:dec" && data !== "fm:inc") return null;

      session._pendingFormula = {
        formula: data === "fm:dec" ? "DECREASE" : "INCREASE",
      };

      session.step = "ASK_FORMULA_VALUETYPE";
      return {
        reply: "Value Type-nya apa?",
        done: false,
        keyboard: buildFormulaValueTypeKeyboard(),
      };
    }

    case "ASK_FORMULA_VALUETYPE": {
      if (data !== "fv:amt" && data !== "fv:pct") return null;

      session._pendingFormula.formulaType = data === "fv:amt" ? "AMOUNT" : "PERCENT";
      session.step = "ASK_FORMULA_VALUE";

      return { reply: "Value-nya berapa? (angka)", done: false, keyboard: null };
    }

    case "ASK_FORMULA_MORE": {
      if (data === "yn:formula:y") {
        session.step = "ASK_FORMULA_TYPE";
        return {
          reply: "Formula tambahan-nya apa?",
          done: false,
          keyboard: buildFormulaTypeKeyboard(),
        };
      }

      if (data === "yn:formula:n") {
        return goToConfirmSummary(session);
      }

      return null;
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
        return { reply: "Field mana yang mau diubah?", done: false, keyboard: buildFieldEditKeyboard(BASIC_FIELDS) };
      }
      if (data === "ed:agent") {
        session._editReturnTo = "summary";
        session.step = "ASK_AGENT_BUTTON";
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
          reply: `Promo code saat ini: ${session.data.promoCodes.length}`,
          done: false,
          keyboard: buildPromoListKeyboard(session.data.promoCodes),
        };
      }
      if (data === "ed:formula") {
        session.step = "EDIT_FORMULA_MENU";
        return {
          reply: `Formula saat ini: ${session.data.formulas.length}`,
          done: false,
          keyboard: buildFormulaListKeyboard(session.data.formulas),
        };
      }
      return null;
    }

    case "EDIT_BASIC_CHOOSE": {
      if (data === "edf:cancel") return goToConfirmSummary(session);
      const m = /^edf:(\d+)$/.exec(data);
      if (!m) return null;
      const idx = Number(m[1]);
      if (idx < 0 || idx >= BASIC_FIELDS.length) return null;

      session._editingFieldKey = BASIC_FIELDS[idx].key;
      session.step = "EDIT_BASIC_VALUE";
      const current = session.data[BASIC_FIELDS[idx].key];
      return {
        reply: `Nilai sekarang: ${current || "-"}\n\nMasukkan nilai baru untuk ${BASIC_FIELDS[idx].label}:`,
        done: false,
        keyboard: null,
      };
    }

    // daftar semua promo code (termasuk yang pertama) - tekan item -> Edit/Hapus
    case "EDIT_PROMO_MENU": {
      if (data === "edp:back") return goToConfirmSummary(session);

      if (data === "edp:add") {
        session._editingPromoIndex = null;
        session._editReturnTo = "promoList";
        session.step = "ASK_PROMOCODE_KODE";
        return { reply: "Kode promo baru:", done: false, keyboard: null };
      }

      const m = /^edpi:(\d+)$/.exec(data);
      if (!m) return null;
      const idx = Number(m[1]);
      if (idx < 0 || idx >= session.data.promoCodes.length) return null;

      session._editingPromoIndex = idx;
      session.step = "EDIT_PROMO_ITEM";
      const p = session.data.promoCodes[idx];
      return {
        reply: `Promo code: *${p.kode}* (max ${p.maxUsed})\n\nMau diapakan?`,
        done: false,
        keyboard: buildItemActionKeyboard("edpa:edit", "edpa:delete", "edpa:cancel"),
      };
    }

    case "EDIT_PROMO_ITEM": {
      const idx = session._editingPromoIndex;

      if (data === "edpa:cancel") {
        session._editingPromoIndex = null;
        session.step = "EDIT_PROMO_MENU";
        return {
          reply: `Promo code saat ini: ${session.data.promoCodes.length}`,
          done: false,
          keyboard: buildPromoListKeyboard(session.data.promoCodes),
        };
      }

      if (data === "edpa:delete") {
        if (session.data.promoCodes.length <= 1) {
          return {
            reply: "Minimal harus ada 1 kode promo, tidak bisa dihapus semua.",
            done: false,
            keyboard: buildItemActionKeyboard("edpa:edit", "edpa:delete", "edpa:cancel"),
          };
        }
        const removed = session.data.promoCodes[idx];
        session.data.promoCodes.splice(idx, 1);
        session._editingPromoIndex = null;
        session.step = "EDIT_PROMO_MENU";
        return {
          reply: `Promo code "${removed.kode}" dihapus ✅`,
          done: false,
          keyboard: buildPromoListKeyboard(session.data.promoCodes),
        };
      }

      if (data === "edpa:edit") {
        session._editReturnTo = "promoList";
        session.step = "ASK_PROMOCODE_KODE";
        return {
          reply: `Kode sekarang: ${session.data.promoCodes[idx].kode}\n\nKode baru (mengganti yang lama):`,
          done: false,
          keyboard: null,
        };
      }

      return null;
    }

    // daftar formula - tekan item -> Edit/Hapus
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
      if (idx < 0 || idx >= session.data.formulas.length) return null;

      session._editingFormulaIndex = idx;
      session.step = "EDIT_FORMULA_ITEM";
      const f = session.data.formulas[idx];
      return {
        reply: `Formula: *${f.formula} ${f.value}${f.formulaType === "PERCENT" ? "%" : ""}*\n\nMau diapakan?`,
        done: false,
        keyboard: buildItemActionKeyboard("edma:edit", "edma:delete", "edma:cancel"),
      };
    }

    case "EDIT_FORMULA_ITEM": {
      const idx = session._editingFormulaIndex;

      if (data === "edma:cancel") {
        session._editingFormulaIndex = null;
        session.step = "EDIT_FORMULA_MENU";
        return {
          reply: `Formula saat ini: ${session.data.formulas.length}`,
          done: false,
          keyboard: buildFormulaListKeyboard(session.data.formulas),
        };
      }

      if (data === "edma:delete") {
        if (session.data.formulas.length <= 1) {
          return {
            reply: "Minimal harus ada 1 formula, tidak bisa dihapus semua.",
            done: false,
            keyboard: buildItemActionKeyboard("edma:edit", "edma:delete", "edma:cancel"),
          };
        }
        const removed = session.data.formulas[idx];
        session.data.formulas.splice(idx, 1);
        session._editingFormulaIndex = null;
        session.step = "EDIT_FORMULA_MENU";
        return {
          reply: `Formula "${removed.formula} ${removed.value}${removed.formulaType === "PERCENT" ? "%" : ""}" dihapus ✅`,
          done: false,
          keyboard: buildFormulaListKeyboard(session.data.formulas),
        };
      }

      if (data === "edma:edit") {
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

// ============================================================
// DATA FINAL
// ============================================================

function buildFinalData(d) {
  return {
    nama: d.nama,
    namaID: d.nama,
    type: d.promotionType,
    promoCodes: d.promoCodes,
    group: d.group || "",
    agent: d.agent || "",
    description: d.description,
    descriptionID: d.description,
    rates: d.rates.map((r) => ({ category: r.category, rate: r.rate })),
    formulas: d.formulas,
    minimumNight: d.minimumNight,
  };
}

module.exports = {
  startQnA,
  handleUserMessage,
  handleUserCallback,
  resetSession,
  buildFinalData,
};