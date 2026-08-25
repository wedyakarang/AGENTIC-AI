// ==========================================================
// ANALYSIS AGENT - AI menangkap MAKSUD pertanyaan bebas soal promosi,
// tapi PENGHITUNGAN/FILTER datanya dilakukan oleh kode JS biasa
// (deterministik, pasti akurat) - BUKAN oleh AI.
//
// KENAPA DIDESAIN BEGINI (penting):
// Versi awal mengirim SELURUH data mentah ke AI dan minta AI
// menghitung sendiri dari teks (misal "ada berapa yang aktif") -
// ini TERBUKTI SERING SALAH HITUNG (49 aktif + 50 tidak aktif = 99,
// padahal total cuma 81). LLM memang lemah untuk tugas menjumlahkan
// item dari blok teks panjang, walau kuat untuk memahami bahasa.
//
// Makanya sekarang AI HANYA bertugas mengekstrak MAKSUD user jadi
// filter terstruktur (lewat tool calling) - contoh: "berapa promo
// aktif?" -> { is_active_filter: "active", answer_type: "count" }.
// Setelah itu, filter & hitung datanya 100% dikerjakan JS
// (applyFilter di bawah), bukan AI - jadi angkanya PASTI benar,
// selama data sumbernya (fetchAllPromotions) benar.
//
// v25 - TAMBAHAN: parameter "name_query" supaya AI bisa membedakan
// PENCARIAN NAMA SPESIFIK ("apakah ada promosi dengan nama wedya?")
// dari PERMINTAAN AGREGAT ("berikan semua nama promosi yang masih
// aktif"). Kalau name_query terisi -> JS filter HANYA promosi yang
// namanya mengandung teks itu (partial match, case-insensitive),
// dan jawabannya berupa DETAIL LENGKAP promosi yang cocok saja -
// BUKAN semua data. Kalau name_query kosong -> perilaku lama tetap
// jalan (filter status/pemakaian/tipe, tampilkan semua yang cocok).
//
// CATATAN ARSITEKTUR: executorAgent.js mendeklarasikan diri sebagai
// "SATU-SATUNYA TITIK LLM DI SELURUH BOT". Modul ini titik LLM KEDUA
// (khusus command /analisis). Kalau mau strict satu titik LLM,
// pindahkan ke executorAgent.js sebagai tool baru.
// ==========================================================

const OpenAI = require("openai");
const { fetchAllPromotions } = require("./analysis");
const { recordUsage } = require("./tokenMonitor");

const ai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = "gpt-5.4-mini";
const REASONING_EFFORT = "none";
const REQUEST_TIMEOUT_MS = 20000;
const RETRY_ATTEMPTS = 2;
const RETRY_BASE_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout ${ms}ms`)), ms);
    promise.then(
      result => { clearTimeout(timer); resolve(result); },
      error => { clearTimeout(timer); reject(error); }
    );
  });
}

function isRetryable5xx(err) {
  const status = err && (err.status || err.statusCode);
  const msg = (err && err.message ? err.message : "").toLowerCase();
  return status === 503 || status === 500 || msg.includes("overloaded");
}

async function callOpenAIWithRetry(requestFn, contextLabel) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      return await withTimeout(requestFn(), REQUEST_TIMEOUT_MS);
    } catch (err) {
      lastErr = err;
      const canRetry = attempt < RETRY_ATTEMPTS && isRetryable5xx(err);
      if (!canRetry) throw err;
      const delayMs = RETRY_BASE_DELAY_MS * Math.pow(3, attempt);
      console.warn(`⚠️ OpenAI 5xx/overloaded saat ${contextLabel} - retry ${attempt + 1}/${RETRY_ATTEMPTS} setelah ${delayMs}ms...`);
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

function buildUsagePayload(usage) {
  return {
    prompt_tokens: usage.prompt_tokens ?? 0,
    completion_tokens: usage.completion_tokens ?? 0,
    thoughts_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    tool_use_prompt_tokens: 0,
    cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0
  };
}

function safeParseToolArgs(rawArguments) {
  try {
    return JSON.parse(rawArguments);
  } catch (err) {
    console.warn("⚠️ Gagal parse JSON argumen tool dari AI:", err.message);
    return null;
  }
}

// ==========================================================
// TOOL: query_promotions - AI HANYA menentukan FILTER & JENIS
// JAWABAN yang diminta user, TIDAK menghitung apapun sendiri.
// ==========================================================
const QUERY_PROMOTIONS_FUNCTION = {
  name: "query_promotions",
  description:
    "Tentukan filter yang sesuai dengan pertanyaan user tentang data promosi GuestPro, dan apakah user minta ANGKA/JUMLAH atau DAFTAR NAMA promosi. JANGAN menghitung apapun sendiri - cukup tentukan filternya, penghitungan dilakukan sistem.",
  parameters: {
    type: "object",
    properties: {
      name_query: {
        type: "string",
        description:
          "Isi HANYA kalau user menyebut NAMA SPESIFIK promosi yang dicari (pencarian, bukan permintaan daftar umum), contoh: 'apakah ada promosi dengan nama wedya?' -> name_query='wedya'. 'cari promo diskon lebaran' -> name_query='diskon lebaran'. KOSONGKAN string ('') kalau user TIDAK menyebut nama spesifik dan hanya minta filter umum seperti status aktif/tidak aktif, jumlah pemakaian, atau daftar semua promosi (misal 'berikan semua nama promosi yang masih aktif' -> name_query tetap kosong, karena itu bukan mencari 1 nama tertentu, tapi minta semua yang aktif)."
      },
      is_active_filter: {
        type: "string",
        enum: ["active", "inactive", "any"],
        description: "'active' kalau user tanya soal promo yang masih aktif/berjalan, 'inactive' kalau tanya yang tidak aktif/nonaktif/mati, 'any' kalau status aktif tidak relevan dengan pertanyaan."
      },
      used_comparison: {
        type: "string",
        enum: ["gt", "gte", "lt", "lte", "eq", "none"],
        description: "Operator perbandingan untuk jumlah PEMAKAIAN promo (field 'used'). gt=lebih dari, gte=minimal/setidaknya, lt=kurang dari, lte=maksimal, eq=tepat sama dengan, none=tidak ada filter pemakaian di pertanyaan."
      },
      used_value: {
        type: "number",
        description: "Nilai pembanding untuk pemakaian, contoh: 'di atas 100' -> used_comparison=gt, used_value=100. Abaikan/isi 0 kalau used_comparison=none."
      },
      promotion_type: {
        type: "string",
        description: "Isi HANYA kalau user menyebut tipe promosi spesifik (PROMO_CODE, SPECIAL_DEAL, EARLY_BIRD, AFFILIATE, dll persis sesuai istilah GuestPro). Kosongkan string kalau tidak relevan."
      },
      answer_type: {
        type: "string",
        enum: ["count", "list"],
        description: "'count' kalau user minta ANGKA/JUMLAH/BERAPA saja. 'list' kalau user minta DAFTAR/NAMA/SEBUTKAN promosinya, atau kalau name_query terisi (mencari 1 promosi spesifik biasanya butuh detailnya, bukan cuma angka)."
      }
    },
    required: ["is_active_filter", "used_comparison", "answer_type"]
  }
};

const QUERY_PROMOTIONS_TOOL = { type: "function", function: QUERY_PROMOTIONS_FUNCTION };

// ==========================================================
// PENGHITUNGAN/FILTER DATA - 100% JS, DETERMINISTIK, TIDAK PERNAH
// SALAH HITUNG (selama data sumber dari GuestPro benar).
// ==========================================================
function applyFilter(promotions, args) {
  const nameQuery = (args.name_query || "").trim().toLowerCase();

  return promotions.filter(p => {
    // Pencarian nama spesifik - partial match, case-insensitive.
    // Kalau AI mengisi name_query, ini jadi filter PALING UTAMA:
    // hanya promosi yang namanya mengandung teks itu yang lolos.
    if (nameQuery !== "") {
      const pname = (p.name || "").toLowerCase();
      if (!pname.includes(nameQuery)) return false;
    }

    if (args.is_active_filter === "active" && !p.is_active) return false;
    if (args.is_active_filter === "inactive" && p.is_active) return false;

    if (args.used_comparison && args.used_comparison !== "none") {
      const used = typeof p.used === "number" ? p.used : 0;
      const val = args.used_value;
      switch (args.used_comparison) {
        case "gt": if (!(used > val)) return false; break;
        case "gte": if (!(used >= val)) return false; break;
        case "lt": if (!(used < val)) return false; break;
        case "lte": if (!(used <= val)) return false; break;
        case "eq": if (!(used === val)) return false; break;
      }
    }

    if (args.promotion_type && args.promotion_type.trim() !== "") {
      if (p.promotion_type !== args.promotion_type) return false;
    }

    return true;
  });
}

function describeFilter(args) {
  const parts = [];
  const nameQuery = (args.name_query || "").trim();
  if (nameQuery !== "") parts.push(`nama mengandung "${nameQuery}"`);

  if (args.is_active_filter === "active") parts.push("berstatus aktif");
  if (args.is_active_filter === "inactive") parts.push("berstatus tidak aktif");

  if (args.used_comparison && args.used_comparison !== "none") {
    const opText = { gt: "lebih dari", gte: "minimal", lt: "kurang dari", lte: "maksimal", eq: "tepat" }[args.used_comparison];
    parts.push(`pemakaian ${opText} ${args.used_value}x`);
  }

  if (args.promotion_type && args.promotion_type.trim() !== "") {
    parts.push(`tipe ${args.promotion_type}`);
  }

  return parts.length ? parts.join(", ") : "";
}

function formatCountAnswer(filtered, args) {
  const desc = describeFilter(args);
  return desc
    ? `Ada *${filtered.length}* promosi ${desc}.`
    : `Total promosi: *${filtered.length}*.`;
}

function formatListAnswer(filtered, args) {
  const desc = describeFilter(args);
  const header = desc
    ? `📋 *${filtered.length} promosi ${desc}:*\n\n`
    : `📋 *${filtered.length} promosi:*\n\n`;

  if (filtered.length === 0) {
    return header + "_(tidak ada data yang cocok)_";
  }

  const lines = filtered.map(p => {
    const statusIcon = p.is_active ? "✅" : "⛔";
    const code = p.promo_code ? ` (${p.promo_code})` : "";
    return `${statusIcon} ${p.name}${code} - ${p.used ?? 0}/${p.max_use ?? "-"}x`;
  });

  // TIDAK ADA pembatasan jumlah - semua item ditampilkan. Kalau
  // hasilnya panjang, pemecahan jadi beberapa pesan Telegram
  // ditangani di telegram3.js (splitLongMessage), bukan di sini.
  return header + lines.join("\n");
}

// ==========================================================
// FORMAT KHUSUS UNTUK PENCARIAN NAMA SPESIFIK (name_query terisi).
// Bedanya dengan formatListAnswer biasa: di sini tiap promosi yang
// cocok ditampilkan DETAIL LENGKAPNYA (bukan cuma 1 baris ringkas),
// karena user mencari 1 promosi tertentu dan biasanya butuh detail,
// bukan sekadar daftar nama.
// ==========================================================
function formatNameSearchAnswer(filtered, args) {
  const nameQuery = (args.name_query || "").trim();

  if (filtered.length === 0) {
    return `🔍 Tidak ditemukan promosi dengan nama mengandung *"${nameQuery}"*.`;
  }

  const header = `🔍 Ditemukan *${filtered.length}* promosi dengan nama mengandung *"${nameQuery}"*:\n\n`;

  const blocks = filtered.map(p => {
    const statusText = p.is_active ? "✅ Aktif" : "⛔ Tidak aktif";
    const code = p.promo_code || "-";
    const type = p.promotion_type || "-";
    const used = p.used ?? 0;
    const maxUse = p.max_use ?? "-";
    return (
      `*${p.name}*\n` +
      `Status: ${statusText}\n` +
      `Kode Promo: ${code}\n` +
      `Tipe: ${type}\n` +
      `Pemakaian: ${used}/${maxUse}x`
    );
  });

  return header + blocks.join("\n\n");
}

// ==========================================================
// FUNGSI UTAMA - dipanggil dari command /analisis di telegram3.js
// ==========================================================
async function answerPromotionQuestion({ chatId, processId, question }) {
  const promotions = await fetchAllPromotions();

  // Semua pertanyaan (termasuk kalau user cuma ketik "/analisis" tanpa
  // teks tambahan) tetap masuk lewat AI + tool, TIDAK ada jawaban
  // pintas dari hitungan lokal duluan - AI yang menentukan filter,
  // datanya tetap dari fetchAllPromotions() (API asli GuestPro).
  const effectiveQuestion =
    question && question.trim() !== ""
      ? question.trim()
      : "Berikan ringkasan total promosi, jumlah yang aktif, dan jumlah yang tidak aktif.";

  const response = await callOpenAIWithRetry(
    () =>
      ai.chat.completions.create({
        model: MODEL,
        reasoning_effort: REASONING_EFFORT,
        messages: [
          {
            role: "user",
            content:
              `Pertanyaan user tentang data promosi GuestPro:\n"${effectiveQuestion}"\n\n` +
              `Tentukan filter yang tepat lewat tool query_promotions. JANGAN menghitung apapun sendiri. ` +
              `Ingat: name_query HANYA diisi kalau user mencari 1 nama promosi spesifik, bukan untuk permintaan daftar umum seperti "semua promosi aktif".`
          }
        ],
        tools: [QUERY_PROMOTIONS_TOOL],
        tool_choice: "required",
        max_completion_tokens: 500
      }),
    "analisis-ai"
  );

  const usage = response.usage || {};
  console.log("🔍 usage mentah dari OpenAI (analisis-ai):", JSON.stringify(usage));

  recordUsage({
    chatId,
    processId,
    feature: "executor:analisis-ai",
    model: MODEL,
    usage: buildUsagePayload(usage)
  });

  const toolCalls = response.choices?.[0]?.message?.tool_calls || [];
  const call = toolCalls.find(tc => tc.type === "function" && tc.function.name === "query_promotions");
  const args = call ? safeParseToolArgs(call.function.arguments) : null;

  if (!args) {
    console.error("⚠️ AI tidak mengembalikan filter yang valid:", JSON.stringify(response).slice(0, 500));
    throw new Error("AI tidak bisa memahami pertanyaan ini. Coba ketik lebih spesifik.");
  }

  console.log("🤖 Filter dari AI:", JSON.stringify(args));

  const filtered = applyFilter(promotions, args);
  const nameQuery = (args.name_query || "").trim();

  // Kalau ini pencarian nama spesifik -> selalu pakai format detail
  // per promosi yang cocok, TERLEPAS dari answer_type yang dipilih
  // AI (count/list), karena user yang cari 1 nama pasti butuh
  // detailnya, bukan cuma angka atau baris ringkas.
  if (nameQuery !== "") {
    return formatNameSearchAnswer(filtered, args);
  }

  return args.answer_type === "list"
    ? formatListAnswer(filtered, args)
    : formatCountAnswer(filtered, args);
}

module.exports = {
  answerPromotionQuestion,
};