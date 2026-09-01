// ==========================================================
// ANALYSIS AGENT - AI menangkap MAKSUD pertanyaan bebas soal promosi,
// (VERSI OPENAI / GPT)
// ==========================================================
//
// PERBEDAAN DARI VERSI GEMINI:
//
// 1. SDK "openai", bukan "@google/generative-ai". Client dibuat sekali
//    secara global (ai = new OpenAI(...)) dan tools dikirim ulang tiap
//    request lewat parameter `tools`, bukan lewat model instance
//    terpisah seperti pola getGenerativeModel() di Gemini.
//
// 2. Skema parameter tool ditulis dalam JSON Schema biasa (type:
//    "object"/"string"/"boolean"/"number"), BUKAN SchemaType enum
//    Gemini (SchemaType.OBJECT dst).
//
// 3. Memaksa model manggil tool (pengganti toolConfig.mode:"ANY")
//    pakai tool_choice: "required".
//
// 4. Argumen tool call dari OpenAI (tool_calls[].function.arguments)
//    adalah STRING JSON, BUKAN object langsung seperti Gemini - jadi
//    HARUS di-parse lewat JSON.parse (lihat safeParseToolArgs).
//
// 5. Padanan mematikan extended thinking (thinkingConfig.thinkingBudget
//    di Gemini) adalah parameter reasoning_effort: "none" - WAJIB
//    disertakan kalau model reasoning dipakai bersama `tools`, karena
//    endpoint /v1/chat/completions menolak nilai lain untuk kombinasi
//    itu.
//
// 6. Tidak ada maxOutputTokens - pakai max_completion_tokens.
//
// 7. Usage token dilaporkan lewat response.usage dengan nama field
//    prompt_tokens / completion_tokens / completion_tokens_details.
//    reasoning_tokens / prompt_tokens_details.cached_tokens /
//    total_tokens - beda dari promptTokenCount dst di Gemini.
//
// 8. SEMUA logic bisnis lain (cache jawaban, jalur cepat keyword,
//    filter/agregasi data promosi, format jawaban) PERSIS SAMA seperti
//    versi Gemini - tidak ada perubahan perilaku, hanya provider LLM
//    dan bentuk pemanggilannya yang beda.
//
// ==========================================================

const OpenAI = require("openai");
const { fetchAllPromotions } = require("./analysis");
const { recordUsage } = require("./tokenMonitor");

const ai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// CEK nama model OpenAI terbaru yang tersedia di akun kamu - placeholder.
const MODEL = "gpt-4o-mini";

// Padanan thinkingConfig.thinkingBudget: 0 - mematikan extended
// reasoning. WAJIB "none" kalau model reasoning dipakai bareng `tools`
// (endpoint /v1/chat/completions menolak nilai lain untuk kombinasi itu).
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

// ==========================================================
// v29(a) - CACHE JAWABAN PER TEKS PERTANYAAN
// ==========================================================
// In-memory, hilang kalau proses Node.js restart (sama seperti
// Map/State lain di bot ini). Key = pertanyaan yang sudah
// dinormalisasi (lowercase + rapikan spasi berlebih).
const answerCache = new Map(); // key: string pertanyaan -> { answer, timestamp }

// TTL (masa berlaku cache). Data promosi bisa berubah (promo baru
// dibuat/diedit lewat /promotion), jadi cache tidak boleh berlaku
// selamanya supaya user tidak dapat jawaban basi. Default 5 menit,
// bisa diubah lewat env ANALYSIS_CACHE_TTL_MS.
const CACHE_TTL_MS = Number(process.env.ANALYSIS_CACHE_TTL_MS || 5 * 60 * 1000);

function normalizeQuestionKey(question) {
  return question.trim().toLowerCase().replace(/\s+/g, " ");
}

// Dipanggil dari luar (mis. setelah finalizeAndCreate() di /promotion
// sukses membuat/mengubah promosi) untuk membuang seluruh cache lama,
// supaya user tidak dapat jawaban basi sebelum TTL habis. Opsional -
// kalau tidak dipanggil, cache tetap otomatis kedaluwarsa lewat TTL.
function invalidateAnswerCache() {
  const size = answerCache.size;
  answerCache.clear();
  console.log(`🧹 Cache jawaban /analisis dibersihkan (${size} entri dihapus).`);
}

// ==========================================================
// v29(b) - JALUR CEPAT BERBASIS KEYWORD (TANPA AI)
// ==========================================================
// Hanya menangani pola pertanyaan yang SANGAT umum & jelas maknanya.
// Kalau tidak yakin/cocok, return null supaya fallback ke OpenAI -
// lebih aman daripada salah tebak filter.
function tryFastKeywordMatch(question) {
  const q = question.toLowerCase();

  // Kalau ada indikasi kompleksitas (nama spesifik, perbandingan angka,
  // agregat, tipe promo, dsb), JANGAN dipaksa lewat jalur cepat -
  // serahkan ke OpenAI supaya tidak salah filter.
  const hasComplexSignal =
    /nama|kode|promo_code|kupon|maksimal|minimal|paling|rata-rata|rata2|tertinggi|terendah|di atas|di bawah|lebih dari|kurang dari|max\s*use|kuota|limit|tipe|jenis promo|early\s*bird|affiliate|special\s*deal/.test(
      q
    );
  if (hasComplexSignal) return null;

  // Deteksi status aktif/tidak aktif - urutan pengecekan PENTING:
  // cek "tidak aktif" / "nonaktif" / "non aktif" DULU sebelum cek
  // "aktif" saja, karena "tidak aktif" JUGA mengandung kata "aktif".
  let isActiveFilter = null;
  if (/tidak\s*aktif|non\s*aktif|nonaktif|sudah\s*mati|berhenti|expired|kadaluarsa|kedaluwarsa/.test(q)) {
    isActiveFilter = "inactive";
  } else if (/\baktif\b|\bberjalan\b|\bmasih\s*jalan\b/.test(q)) {
    isActiveFilter = "active";
  }

  // Jalur cepat ini HANYA menangani pertanyaan status aktif/tidak
  // aktif yang jelas. Kalau tidak ada sinyal status sama sekali,
  // serahkan ke OpenAI (termasuk pertanyaan umum "ada promo apa saja"
  // tanpa filter status, supaya tidak salah tebak jenis jawaban).
  if (!isActiveFilter) return null;

  const wantsList = /daftar|sebutkan|nama.*promo|list|apa\s*saja/.test(q);

  return {
    is_relevant: true,
    name_query: "",
    is_active_filter: isActiveFilter,
    used_comparison: "none",
    used_value: 0,
    max_use_comparison: "none",
    max_use_value: 0,
    promotion_type: "",
    answer_type: wantsList ? "list" : "count",
    aggregate_field: "none",
    aggregate_function: "none",
  };
}

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
  const statusCode = err && (err.status || err.statusCode);
  const code = (err && (err.code || err.error?.code) ? String(err.code || err.error?.code) : "").toLowerCase();
  const msg = (err && err.message ? err.message : "").toLowerCase();
  return (
    statusCode === 503 ||
    statusCode === 500 ||
    code.includes("server_error") ||
    msg.includes("overloaded")
  );
}

async function callGeminiWithRetry(requestFn, contextLabel) {
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
  const u = usage || {};
  return {
    prompt_tokens: u.prompt_tokens ?? 0,
    completion_tokens: u.completion_tokens ?? 0,
    thoughts_tokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
    tool_use_prompt_tokens: 0,
    cached_tokens: u.prompt_tokens_details?.cached_tokens ?? 0,
    total_tokens: u.total_tokens ?? 0
  };
}

// OpenAI mengembalikan argumen tool call sebagai STRING JSON (beda
// dari Gemini yang sudah berupa object langsung) - HARUS di-parse.
function safeParseToolArgs(rawArgs) {
  if (rawArgs && typeof rawArgs === "object") return rawArgs;
  try {
    return JSON.parse(rawArgs);
  } catch (err) {
    console.warn("⚠️ Gagal parse argumen tool dari AI:", err.message);
    return null;
  }
}

// ==========================================================
// TOOL: query_promotions - AI HANYA menentukan FILTER & JENIS
// JAWABAN yang diminta user, TIDAK menghitung apapun sendiri.
// Schema pakai JSON Schema biasa (gaya OpenAI function calling).
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
        description: "Operator perbandingan untuk jumlah PEMAKAIAN AKTUAL promo (field 'used' - berapa kali promo ini SUDAH dipakai tamu), dipakai untuk FILTER data sebelum dihitung/ditampilkan/diagregasi. gt=lebih dari, gte=minimal/setidaknya, lt=kurang dari, lte=maksimal, eq=tepat sama dengan, none=tidak ada filter pemakaian aktual di pertanyaan. JANGAN dipakai untuk pertanyaan soal 'max use'/batas/kuota - itu pakai max_use_comparison. Isi 'none' kalau is_relevant=false."
      },
      used_value: {
        type: "number",
        description: "Nilai pembanding untuk used_comparison, contoh: 'yang sudah dipakai di atas 100 kali' -> used_comparison=gt, used_value=100. Abaikan/isi 0 kalau used_comparison=none atau is_relevant=false."
      },
      max_use_comparison: {
        type: "string",
        enum: ["gt", "gte", "lt", "lte", "eq", "none"],
        description: "Operator perbandingan untuk BATAS MAKSIMAL PEMAKAIAN/KUOTA promo (field 'max_use' - batas yang DI-SET, BUKAN jumlah yang sudah terpakai). Pakai ini kalau user menyebut 'max use', 'kuota', 'batas pemakaian', 'limit promo', 'maksimal pemakaian yang diperbolehkan'. gt=lebih dari, gte=minimal, lt=kurang dari, lte=maksimal, eq=tepat sama dengan, none=tidak ada filter max_use di pertanyaan. Isi 'none' kalau is_relevant=false."
      },
      max_use_value: {
        type: "number",
        description: "Nilai pembanding untuk max_use_comparison, contoh: 'max use-nya di bawah 10' -> max_use_comparison=lt, max_use_value=10. Abaikan/isi 0 kalau max_use_comparison=none atau is_relevant=false."
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
          "'list' kalau user minta DAFTAR/NAMA/SEBUTKAN promosinya, ATAU kalau user bertanya 'promo APA/MANA' yang paling banyak/sedikit dipakai (karena yang diminta adalah IDENTITAS promosinya, bukan cuma angkanya), atau kalau name_query terisi. " +
          "Contoh 'list' + urutkan: 'promo apa yang paling banyak dipakai?', 'promosi mana yang used-nya tertinggi?', 'sebutkan promo dengan pemakaian terbanyak' -> answer_type='list', is_active_filter tetap sesuai konteks, used_comparison/max_use_comparison='none' (biar semua data masuk lalu diurutkan oleh sistem). " +
          "'aggregate' HANYA kalau user MURNI minta satu ANGKA saja tanpa peduli promosi mana pemiliknya - contoh: 'berapa maksimal penggunaan promo code untuk 1 promotion?' (-> aggregate_field='max_use', aggregate_function='max'), 'berapa pemakaian tertinggi saat ini?' (-> aggregate_field='used', aggregate_function='max'), 'berapa rata-rata pemakaian promo?' (-> aggregate_field='used', aggregate_function='avg'). " +
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
      },
      sort_by: {
        type: "string",
        enum: ["none", "used", "max_use"],
        description:
          "Isi HANYA kalau answer_type='list' DAN user memang minta diurutkan/dicari yang PALING banyak/sedikit dari suatu angka (mis. 'promo apa yang paling banyak dipakai' -> sort_by='used'; 'promo dengan max use terbesar' -> sort_by='max_use'). Isi 'none' kalau tidak ada permintaan urutan seperti itu."
      },
      sort_direction: {
        type: "string",
        enum: ["none", "desc", "asc"],
        description:
          "Isi HANYA kalau sort_by diisi. 'desc' untuk paling banyak/tertinggi/terbesar, 'asc' untuk paling sedikit/terendah/terkecil. Isi 'none' kalau sort_by='none'."
      }
    },
    required: ["is_relevant", "is_active_filter", "used_comparison", "max_use_comparison", "answer_type"]
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

    if (args.max_use_comparison && args.max_use_comparison !== "none") {
      const maxUse = typeof p.max_use === "number" ? p.max_use : 0;
      const val = args.max_use_value;
      switch (args.max_use_comparison) {
        case "gt": if (!(maxUse > val)) return false; break;
        case "gte": if (!(maxUse >= val)) return false; break;
        case "lt": if (!(maxUse < val)) return false; break;
        case "lte": if (!(maxUse <= val)) return false; break;
        case "eq": if (!(maxUse === val)) return false; break;
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

  if (args.max_use_comparison && args.max_use_comparison !== "none") {
    const opText = { gt: "lebih dari", gte: "minimal", lt: "kurang dari", lte: "maksimal", eq: "tepat" }[args.max_use_comparison];
    parts.push(`max use ${opText} ${args.max_use_value}x`);
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

// BARU - dukung sort_by/sort_direction sebelum ditampilkan, dan kalau
// user memang minta "PALING banyak/sedikit" (bukan daftar biasa),
// otomatis pangkas ke 1 hasil teratas saja + kalimat pembuka yang
// menyebutkan nama promosinya secara eksplisit - supaya jawabannya
// langsung menjawab "promo APA", bukan cuma daftar panjang.
function formatListAnswer(filtered, args) {
  const desc = describeFilter(args);
  let list = filtered;

  const sortBy = args.sort_by && args.sort_by !== "none" ? args.sort_by : null;
  const sortDir = args.sort_direction === "asc" ? "asc" : "desc";

  if (sortBy) {
    list = [...filtered].sort((a, b) => {
      const av = typeof a[sortBy] === "number" ? a[sortBy] : 0;
      const bv = typeof b[sortBy] === "number" ? b[sortBy] : 0;
      return sortDir === "asc" ? av - bv : bv - av;
    });
  }

  if (list.length === 0) {
    const header = desc ? `📋 *0 promosi ${desc}:*\n\n` : `📋 *0 promosi:*\n\n`;
    return header + "_(tidak ada data yang cocok)_";
  }

  // Kalau ini permintaan "PALING banyak/sedikit" (sort_by terisi),
  // tampilkan sebagai jawaban langsung 1 promosi teratas, bukan daftar.
  if (sortBy) {
    const top = list[0];
    const fieldLabel = sortBy === "used" ? "pemakaian" : "max use";
    const superlativeLabel = sortDir === "asc" ? "paling sedikit" : "paling banyak";
    const statusIcon = top.is_active ? "✅" : "⛔";
    const code = top.promo_code ? ` (${top.promo_code})` : "";
    const value = typeof top[sortBy] === "number" ? top[sortBy] : 0;

    let text =
      `Promosi dengan ${fieldLabel} ${superlativeLabel}${desc ? ` (di antara promosi ${desc})` : ""} adalah:\n\n` +
      `${statusIcon} *${top.name}*${code} - ${top.used ?? 0}/${top.max_use ?? "-"}x`;

    // Kalau ada yang nilainya sama persis (seri), sebutkan juga supaya
    // tidak menyesatkan seolah cuma 1 promosi yang punya nilai tertinggi.
    const tied = list.filter(p => (typeof p[sortBy] === "number" ? p[sortBy] : 0) === value && p !== top);
    if (tied.length > 0) {
      text += `\n\n_(${tied.length} promosi lain juga punya nilai ${fieldLabel} yang sama: ${value})_`;
    }

    return text;
  }

  const header = desc
    ? `📋 *${list.length} promosi ${desc}:*\n\n`
    : `📋 *${list.length} promosi:*\n\n`;

  const lines = list.map(p => {
    const statusIcon = p.is_active ? "✅" : "⛔";
    const code = p.promo_code ? ` (${p.promo_code})` : "";
    return `${statusIcon} ${p.name}${code} - ${p.used ?? 0}/${p.max_use ?? "-"}x`;
  });

  return header + lines.join("\n");
}

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

// DIPERBAIKI - kalau fungsinya max/min, sekarang IKUT menyebutkan nama
// promosi pemilik nilai itu (bukan cuma angka telanjang), sebagai
// jaring pengaman kalau AI tetap memilih answer_type="aggregate"
// untuk pertanyaan "promo apa yang paling banyak/sedikit dipakai".
// avg/sum tetap murni angka karena memang tidak merujuk ke 1 promosi.
function formatAggregateAnswer(filtered, args) {
  const field = args.aggregate_field;
  const fn = args.aggregate_function;
  const desc = describeFilter(args);
  const scopeText = desc ? ` (di antara promosi ${desc})` : "";

  if (!field || field === "none" || !fn || fn === "none") {
    return "Maaf, saya tidak bisa menentukan nilai apa yang diminta. Coba perjelas pertanyaannya.";
  }

  const withValue = filtered.filter(p => typeof p[field] === "number");

  if (withValue.length === 0) {
    return `Tidak ada data ${AGGREGATE_FIELD_LABEL[field]} yang bisa dihitung${scopeText}.`;
  }

  const values = withValue.map(p => p[field]);
  const fnLabel = AGGREGATE_FUNCTION_LABEL[fn];
  const fieldLabel = AGGREGATE_FIELD_LABEL[field];

  if (fn === "max" || fn === "min") {
    const result = fn === "max" ? Math.max(...values) : Math.min(...values);
    const owners = withValue.filter(p => p[field] === result);
    const top = owners[0];
    const statusIcon = top.is_active ? "✅" : "⛔";
    const code = top.promo_code ? ` (${top.promo_code})` : "";

    let text =
      `Promosi dengan ${fieldLabel} ${fnLabel}${scopeText} adalah:\n\n` +
      `${statusIcon} *${top.name}*${code} - nilai *${result}* (${top.used ?? 0}/${top.max_use ?? "-"}x)`;

    if (owners.length > 1) {
      text += `\n\n_(${owners.length - 1} promosi lain juga punya nilai ${fieldLabel} yang sama: ${result})_`;
    }

    return text;
  }

  // avg / sum - murni angka, tidak merujuk ke 1 promosi tertentu.
  let result;
  if (fn === "sum") {
    result = values.reduce((a, b) => a + b, 0);
  } else {
    const sum = values.reduce((a, b) => a + b, 0);
    result = Math.round((sum / values.length) * 100) / 100;
  }

  return `Nilai *${fnLabel}* untuk ${fieldLabel}${scopeText} adalah *${result}* (dari ${values.length} promosi).`;
}

// Dipakai baik oleh jalur cepat (keyword) maupun jalur OpenAI, supaya
// logika "args -> jawaban akhir" tetap satu tempat saja (tidak
// diduplikasi antara dua jalur).
function buildFinalAnswerFromArgs(promotions, args) {
  if (args.is_relevant === false) {
    return OFF_TOPIC_REPLY;
  }

  const filtered = applyFilter(promotions, args);
  const nameQuery = (args.name_query || "").trim();

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

// ==========================================================
// FUNGSI UTAMA - dipanggil dari command /analisis di telegram3.js
// ==========================================================
async function answerPromotionQuestion({ chatId, processId, question }) {
  const effectiveQuestion =
    question && question.trim() !== ""
      ? question.trim()
      : "Berikan ringkasan total promosi, jumlah yang aktif, dan jumlah yang tidak aktif.";

  // ----------------------------------------------------------
  // 1) CEK CACHE dulu - kalau pertanyaan PERSIS SAMA (setelah
  //    dinormalisasi) sudah pernah dijawab dalam rentang TTL,
  //    langsung pakai jawaban lama TANPA panggil OpenAI/GuestPro.
  // ----------------------------------------------------------
  const cacheKey = normalizeQuestionKey(effectiveQuestion);
  const cached = answerCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
    console.log(`♻️ Jawaban /analisis diambil dari cache: "${effectiveQuestion}"`);
    return cached.answer;
  }

  // ----------------------------------------------------------
  // 2) COBA JALUR CEPAT (keyword, tanpa AI) untuk pola sederhana.
  // ----------------------------------------------------------
  const fastArgs = tryFastKeywordMatch(effectiveQuestion);

  let args;
  if (fastArgs) {
    console.log("⚡ Pola /analisis dikenali via keyword, skip panggilan OpenAI:", JSON.stringify(fastArgs));
    args = fastArgs;
  } else {
    // --------------------------------------------------------
    // 3) FALLBACK: panggil OpenAI seperti biasa untuk pertanyaan
    //    yang lebih rumit/ambigu.
    // --------------------------------------------------------
    const prompt =
      `Pertanyaan user tentang data promosi GuestPro:\n"${effectiveQuestion}"\n\n` +
      `Pertama tentukan apakah pertanyaan ini relevan dengan data promosi (is_relevant). ` +
      `Kalau relevan, tentukan juga filter yang tepat lewat tool query_promotions. JANGAN menghitung apapun sendiri. ` +
      `Ingat: name_query HANYA diisi kalau user mencari 1 nama promosi spesifik, bukan untuk permintaan daftar umum seperti "semua promosi aktif". ` +
      `PENTING - bedakan dua field pemakaian: used_comparison/used_value untuk jumlah pemakaian AKTUAL (field 'used', sudah berapa kali dipakai), ` +
      `sedangkan max_use_comparison/max_use_value untuk BATAS MAKSIMAL/KUOTA yang di-set (field 'max_use'). ` +
      `Contoh: "promo yang max use-nya di bawah 10" -> max_use_comparison=lt, max_use_value=10 (BUKAN used_comparison). ` +
      `"promo yang sudah dipakai lebih dari 100 kali" -> used_comparison=gt, used_value=100 (BUKAN max_use_comparison). ` +
      `PENTING - bedakan dua jenis pertanyaan "paling banyak/sedikit": ` +
      `kalau user tanya "promo APA/MANA yang paling banyak/sedikit dipakai" (minta TAHU IDENTITAS promosinya) -> answer_type='list', sort_by='used' atau 'max_use' sesuai konteks, sort_direction='desc' (paling banyak/tertinggi) atau 'asc' (paling sedikit/terendah). ` +
      `Kalau user cuma tanya ANGKA-nya saja tanpa peduli promosi mana ("berapa pemakaian tertinggi", "berapa rata-rata pemakaian") -> answer_type='aggregate' beserta aggregate_field dan aggregate_function yang sesuai.`;

    const response = await callGeminiWithRetry(
      () =>
        ai.chat.completions.create({
          model: MODEL,
          reasoning_effort: REASONING_EFFORT,
          messages: [{ role: "user", content: prompt }],
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
    args = call ? safeParseToolArgs(call.function.arguments) : null;

    if (!args) {
      console.error("⚠️ AI tidak mengembalikan filter yang valid:", JSON.stringify(response).slice(0, 500));
      throw new Error("AI tidak bisa memahami pertanyaan ini. Coba ketik lebih spesifik.");
    }

    console.log("🤖 Filter dari AI:", JSON.stringify(args));
  }

  // Kalau tidak relevan, tidak perlu fetch data promosi sama sekali.
  if (args.is_relevant === false) {
    console.log("🚫 Pertanyaan ditandai tidak relevan, skip fetch data.");
    const answer = OFF_TOPIC_REPLY;
    answerCache.set(cacheKey, { answer, timestamp: Date.now() });
    return answer;
  }

  const promotions = await fetchAllPromotions();
  const answer = buildFinalAnswerFromArgs(promotions, args);

  // Simpan ke cache SETELAH jawaban akhir jadi, supaya pertanyaan
  // persis sama berikutnya (dalam rentang TTL) tidak perlu panggil
  // OpenAI ataupun fetch ulang ke GuestPro.
  answerCache.set(cacheKey, { answer, timestamp: Date.now() });

  return answer;
}

module.exports = {
  answerPromotionQuestion,
  invalidateAnswerCache,
};