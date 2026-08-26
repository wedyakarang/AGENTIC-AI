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
// v26 - TAMBAHAN: parameter "is_relevant" untuk menangani pertanyaan
// OFF-TOPIC (contoh: "sekarang tanggal berapa?", "siapa presiden RI").
// Sebelumnya, karena tool_choice dipaksa "required", AI TETAP HARUS
// mengisi filter walau pertanyaannya gak nyambung sama sekali dengan
// data promosi - akibatnya filter jatuh ke nilai default kosong,
// yang oleh applyFilter dianggap "tidak ada filter" -> semua data
// promosi ditampilkan. Ini SALAH: harusnya bot bilang "gak ngerti",
// bukan malah dump semua data.
//
// Solusinya: is_relevant tetap memenuhi syarat tool_choice:"required"
// (AI selalu WAJIB panggil tool ini), tapi sekarang AI punya "jalan
// keluar" resmi untuk bilang "pertanyaan ini gak nyambung dengan
// data promosi" tanpa harus mengarang filter. Kalau is_relevant
// bernilai false, fetchAllPromotions() bahkan TIDAK dipanggil sama
// sekali (hemat 1 API call ke GuestPro yang gak perlu), dan bot
// langsung balas kalimat penolakan standar.
//
// v27 - TAMBAHAN: answer_type "aggregate" + parameter aggregate_field
// & aggregate_function. Sebelumnya tool HANYA bisa filter + count/list
// - tidak bisa menjawab pertanyaan seperti "berapa MAKSIMAL penggunaan
// promo code untuk 1 promotion?" (minta nilai tertinggi dari field
// max_use), atau "berapa rata-rata pemakaian promo?" (minta rata-rata
// dari field used). Sebelum ada ini, AI terpaksa membiarkan semua
// filter kosong karena tidak ada tempat untuk menaruh maksud user -
// hasilnya applyFilter meloloskan SEMUA data lalu dihitung count-nya
// (jawaban ngawur seperti "Total promosi: 86" padahal user tanya soal
// batas maksimal pemakaian, bukan jumlah promosi).
//
// Sekarang AI bisa pilih answer_type="aggregate" + tentukan field mana
// (aggregate_field: "used" atau "max_use") dan fungsi agregat apa
// (aggregate_function: "max"/"min"/"avg"/"sum") - JS yang menghitung
// nilai sebenarnya dari data yang sudah difilter, AI tidak menghitung
// apapun sendiri (tetap konsisten dengan filosofi awal file ini).
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

// Dipakai sebagai jawaban tetap ketika AI menandai pertanyaan
// sebagai tidak relevan dengan data promosi.
const OFF_TOPIC_REPLY =
  "🤔 Maaf, pertanyaan itu di luar cakupan saya. Saya hanya bisa menjawab " +
  "pertanyaan seputar data promosi GuestPro (status aktif/tidak aktif, " +
  "jumlah pemakaian, nama promosi, tipe promo, dll). Coba tanyakan hal " +
  "lain terkait promosi ya.";

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
    "Tentukan apakah pertanyaan user relevan dengan data promosi GuestPro, dan jika ya, tentukan filter yang sesuai serta jenis jawaban yang diminta (jumlah, daftar, atau nilai agregat seperti maksimal/minimal/rata-rata). JANGAN menghitung apapun sendiri - cukup tentukan filter & jenis jawabannya, penghitungan dilakukan sistem.",
  parameters: {
    type: "object",
    properties: {
      is_relevant: {
        type: "boolean",
        description:
          "true kalau pertanyaan user memang tentang data promosi GuestPro (status aktif/tidak aktif, jumlah pemakaian, batas maksimal pemakaian, nama promosi, kode promo, tipe promosi, ringkasan/statistik promosi, dsb). false kalau pertanyaan SAMA SEKALI TIDAK berkaitan dengan data promosi, contoh: 'sekarang tanggal berapa?', 'siapa presiden Indonesia?', obrolan umum, sapaan, atau topik lain di luar promosi. Kalau ragu-ragu tapi ada kemungkinan masih nyambung ke promosi, pilih true."
      },
      name_query: {
        type: "string",
        description:
          "Isi HANYA kalau user menyebut NAMA SPESIFIK promosi yang dicari (pencarian, bukan permintaan daftar umum), contoh: 'apakah ada promosi dengan nama wedya?' -> name_query='wedya'. 'cari promo diskon lebaran' -> name_query='diskon lebaran'. KOSONGKAN string ('') kalau user TIDAK menyebut nama spesifik dan hanya minta filter umum seperti status aktif/tidak aktif, jumlah pemakaian, atau daftar semua promosi. Abaikan/kosongkan kalau is_relevant=false."
      },
      is_active_filter: {
        type: "string",
        enum: ["active", "inactive", "any"],
        description: "'active' kalau user tanya soal promo yang masih aktif/berjalan, 'inactive' kalau tanya yang tidak aktif/nonaktif/mati, 'any' kalau status aktif tidak relevan dengan pertanyaan. Isi 'any' kalau is_relevant=false."
      },
      used_comparison: {
        type: "string",
        enum: ["gt", "gte", "lt", "lte", "eq", "none"],
        description: "Operator perbandingan untuk jumlah PEMAKAIAN promo (field 'used'), dipakai untuk FILTER data sebelum dihitung/ditampilkan/diagregasi. gt=lebih dari, gte=minimal/setidaknya, lt=kurang dari, lte=maksimal, eq=tepat sama dengan, none=tidak ada filter pemakaian di pertanyaan. Isi 'none' kalau is_relevant=false."
      },
      used_value: {
        type: "number",
        description: "Nilai pembanding untuk pemakaian, contoh: 'di atas 100' -> used_comparison=gt, used_value=100. Abaikan/isi 0 kalau used_comparison=none atau is_relevant=false."
      },
      promotion_type: {
        type: "string",
        description: "Isi HANYA kalau user menyebut tipe promosi spesifik (PROMO_CODE, SPECIAL_DEAL, EARLY_BIRD, AFFILIATE, dll persis sesuai istilah GuestPro). Kosongkan string kalau tidak relevan atau is_relevant=false."
      },
      answer_type: {
        type: "string",
        enum: ["count", "list", "aggregate"],
        description:
          "'count' kalau user minta ANGKA JUMLAH promosi yang cocok (misal 'ada berapa promo aktif?'). " +
          "'list' kalau user minta DAFTAR/NAMA/SEBUTKAN promosinya, atau kalau name_query terisi. " +
          "'aggregate' kalau user minta NILAI TERTINGGI/TERENDAH/RATA-RATA/TOTAL dari suatu field, BUKAN jumlah promosi - " +
          "contoh: 'berapa maksimal penggunaan promo code untuk 1 promotion?' (minta batas pemakaian maksimal yang di-set -> aggregate_field='max_use', aggregate_function='max'), " +
          "'promo apa yang paling banyak dipakai?' atau 'berapa pemakaian tertinggi?' (-> aggregate_field='used', aggregate_function='max'), " +
          "'berapa rata-rata pemakaian promo?' (-> aggregate_field='used', aggregate_function='avg'). " +
          "Isi 'count' kalau is_relevant=false (tidak akan dipakai)."
      },
      aggregate_field: {
        type: "string",
        enum: ["none", "used", "max_use"],
        description:
          "Field yang ingin diringkas dengan fungsi agregat, HANYA diisi kalau answer_type='aggregate'. " +
          "'used' = jumlah pemakaian aktual tiap promosi. " +
          "'max_use' = batas maksimal pemakaian yang DI-SET untuk tiap promosi (dipakai untuk pertanyaan seperti 'berapa maksimal penggunaan promo code yang dibolehkan'). " +
          "Isi 'none' kalau answer_type bukan 'aggregate'."
      },
      aggregate_function: {
        type: "string",
        enum: ["none", "max", "min", "avg", "sum"],
        description:
          "Fungsi agregat yang diminta, HANYA diisi kalau answer_type='aggregate'. max=nilai tertinggi, min=nilai terendah, avg=rata-rata, sum=jumlah total. Isi 'none' kalau answer_type bukan 'aggregate'."
      }
    },
    required: ["is_relevant", "is_active_filter", "used_comparison", "answer_type"]
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
// FORMAT JAWABAN AGREGAT (max/min/avg/sum) - v27.
// Dihitung 100% oleh JS dari data yang SUDAH difilter (respect
// filter status aktif/tipe/dsb kalau ada), AI tidak menghitung
// apapun, hanya menentukan field & fungsi agregatnya.
// ==========================================================
const AGGREGATE_FIELD_LABEL = {
  used: "pemakaian aktual",
  max_use: "batas maksimal pemakaian (max_use)"
};

const AGGREGATE_FUNCTION_LABEL = {
  max: "tertinggi",
  min: "terendah",
  avg: "rata-rata",
  sum: "total"
};

function formatAggregateAnswer(filtered, args) {
  const field = args.aggregate_field;
  const fn = args.aggregate_function;
  const desc = describeFilter(args);
  const scopeText = desc ? ` (di antara promosi ${desc})` : "";

  if (!field || field === "none" || !fn || fn === "none") {
    // Jaga-jaga kalau AI lupa isi field/function walau answer_type=aggregate.
    return "Maaf, saya tidak bisa menentukan nilai apa yang diminta. Coba perjelas pertanyaannya.";
  }

  // Ambil nilai numerik field yang diminta dari tiap promosi yang lolos filter.
  // Promosi tanpa nilai valid untuk field ini (null/undefined/bukan angka)
  // diabaikan dari perhitungan, supaya tidak mengacaukan max/min/avg/sum.
  const values = filtered
    .map(p => (typeof p[field] === "number" ? p[field] : null))
    .filter(v => v !== null);

  if (values.length === 0) {
    return `Tidak ada data ${AGGREGATE_FIELD_LABEL[field]} yang bisa dihitung${scopeText}.`;
  }

  let result;
  switch (fn) {
    case "max": result = Math.max(...values); break;
    case "min": result = Math.min(...values); break;
    case "sum": result = values.reduce((a, b) => a + b, 0); break;
    case "avg": {
      const sum = values.reduce((a, b) => a + b, 0);
      result = Math.round((sum / values.length) * 100) / 100; // 2 desimal
      break;
    }
  }

  const fnLabel = AGGREGATE_FUNCTION_LABEL[fn];
  const fieldLabel = AGGREGATE_FIELD_LABEL[field];

  return `Nilai *${fnLabel}* untuk ${fieldLabel}${scopeText} adalah *${result}* (dari ${values.length} promosi).`;
}

// ==========================================================
// FUNGSI UTAMA - dipanggil dari command /analisis di telegram3.js
// ==========================================================
async function answerPromotionQuestion({ chatId, processId, question }) {
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
              `Pertama tentukan apakah pertanyaan ini relevan dengan data promosi (is_relevant). ` +
              `Kalau relevan, tentukan juga filter yang tepat lewat tool query_promotions. JANGAN menghitung apapun sendiri. ` +
              `Ingat: name_query HANYA diisi kalau user mencari 1 nama promosi spesifik, bukan untuk permintaan daftar umum seperti "semua promosi aktif". ` +
              `Kalau user minta nilai tertinggi/terendah/rata-rata/total dari suatu angka (misal "maksimal penggunaan promo code", "rata-rata pemakaian promo") - itu BUKAN permintaan jumlah promosi, gunakan answer_type="aggregate" beserta aggregate_field dan aggregate_function yang sesuai.`
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

  // Kalau AI menandai pertanyaan tidak relevan dengan data promosi,
  // langsung balas penolakan - JANGAN fetch/filter data promosi
  // sama sekali (hemat API call ke GuestPro yang gak perlu).
  if (args.is_relevant === false) {
    console.log("🚫 Pertanyaan ditandai tidak relevan, skip fetch data.");
    return OFF_TOPIC_REPLY;
  }

  const promotions = await fetchAllPromotions();
  const filtered = applyFilter(promotions, args);
  const nameQuery = (args.name_query || "").trim();

  // Kalau ini pencarian nama spesifik -> selalu pakai format detail
  // per promosi yang cocok, TERLEPAS dari answer_type yang dipilih
  // AI (count/list/aggregate), karena user yang cari 1 nama pasti
  // butuh detailnya, bukan cuma angka atau baris ringkas.
  if (nameQuery !== "") {
    return formatNameSearchAnswer(filtered, args);
  }

  if (args.answer_type === "aggregate") {
    return formatAggregateAnswer(filtered, args);
  }

  return args.answer_type === "list"
    ? formatListAnswer(filtered, args)
    : formatCountAnswer(filtered, args);
}

module.exports = {
  answerPromotionQuestion,
};