// // ==========================================================
// // EXECUTOR AGENT - SATU-SATUNYA TITIK LLM DI SELURUH BOT
// // (VERSI GEMINI)
// // ==========================================================

const { GoogleGenerativeAI, SchemaType } = require("@google/generative-ai");
const { recordUsage } = require("./tokenMonitor");
const { createPromotionTool } = require("../indexxx");

const { parseExcelForReview, runWithConcurrencyLimit } = require("../excelll");

const { setPendingFlag, getPendingFlag, clearPendingFlag } = require("./pendingFlags");

// ==========================================================
// CALLBACK STATUS TELEGRAM
// ==========================================================

let statusCallback = null;

function setStatusCallback(callback) {
  statusCallback = callback;
}

// ==========================================================
// GEMINI CONFIG
// ==========================================================

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const MODEL = "gemini-3.5-flash"; // Ganti sesuai kebutuhan (mis. "gemini-2.5-pro" kalau butuh kualitas lebih tinggi).
const REQUEST_TIMEOUT_MS = 20000;

const OPENAI_RETRY_ATTEMPTS = 2; // total percobaan = 1 + ini (jadi 3x) — nama var dipertahankan biar diff minimal
const OPENAI_RETRY_BASE_DELAY_MS = 1000; // 1s, lalu 3s (backoff x3)

const IMPORT_DIRECT_CONCURRENCY = 10;
const IMPORT_FORCE_CONCURRENCY = 10;

// ==========================================================
// KONVERSI JSON SCHEMA BIASA -> SCHEMA GEMINI (SchemaType enum)
// ==========================================================
function toGeminiSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;

  const TYPE_MAP = {
    object: SchemaType.OBJECT,
    string: SchemaType.STRING,
    array: SchemaType.ARRAY,
    number: SchemaType.NUMBER,
    integer: SchemaType.INTEGER,
    boolean: SchemaType.BOOLEAN
  };

  const out = {};

  if (schema.type) {
    out.type = TYPE_MAP[schema.type] || schema.type;
  }
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum;

  if (schema.properties) {
    out.properties = {};
    for (const [key, val] of Object.entries(schema.properties)) {
      out.properties[key] = toGeminiSchema(val);
    }
  }

  if (schema.items) out.items = toGeminiSchema(schema.items);
  if (schema.required) out.required = schema.required;

  return out;
}

// ==========================================================
// HELPER: BANGUN OBJEK usage LENGKAP DARI usageMetadata GEMINI
// ==========================================================
function buildUsagePayload(usageMetadata) {
  return {
    prompt_tokens: usageMetadata.promptTokenCount ?? 0,
    completion_tokens: usageMetadata.candidatesTokenCount ?? 0,
    thoughts_tokens: usageMetadata.thoughtsTokenCount ?? 0,
    tool_use_prompt_tokens: 0,
    cached_tokens: usageMetadata.cachedContentTokenCount ?? 0,
    total_tokens: usageMetadata.totalTokenCount ?? 0
  };
}

// ==========================================================
// KLASIFIKASI ERROR GEMINI
// ==========================================================

function classifyOpenAIError(err) {
  const status = err && (err.status || err.statusCode);
  const msg = (err && err.message ? err.message : "").toLowerCase();

  if (msg.includes("timeout")) {
    return { type: "timeout", title: "⌛ KONEKSI KE AI TIMEOUT" };
  }
  if (status === 503 || status === 500 || msg.includes("overloaded") || msg.includes("unavailable")) {
    return { type: "overloaded", title: "🔥 MODEL AI SEDANG PADAT (5xx)" };
  }
  if (status === 429 || msg.includes("rate limit") || msg.includes("resource_exhausted")) {
    return { type: "rate_limit", title: "⏳ KENA RATE LIMIT AI" };
  }
  if (status === 403 || msg.includes("quota") || msg.includes("billing") || msg.includes("permission")) {
    return { type: "quota", title: "💳 KUOTA / IZIN AI BERMASALAH" };
  }
  if (status === 400 || msg.includes("invalid_argument") || msg.includes("invalid argument")) {
    return { type: "invalid_argument", title: "⚠️ SKEMA TOOL AI SALAH" };
  }
  return { type: "other", title: "⚠️ AI GAGAL DIPANGGIL" };
}

function isRetryableOpenAIError(err) {
  return classifyOpenAIError(err).type === "overloaded";
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function notifyFallback(chatId, err, contextLabel) {
  if (!statusCallback) return;

  const { title } = classifyOpenAIError(err);
  const reason = err && err.message ? err.message : "tidak diketahui";

  try {
    await statusCallback(
      chatId,
      `${title}\n\n` +
        `Gagal saat: ${contextLabel}\n` +
        `Detail: ${reason}`
    );
  } catch (notifyErr) {
    console.error("⚠️ Gagal kirim notifikasi fallback ke Telegram:", notifyErr.message);
  }
}

// ==========================================================
// TOOL 1: CREATE PROMOTION (dipakai jalur Manual & jalur Import)
// Skema ditulis dalam JSON Schema biasa (sumber kebenaran tunggal),
// dikonversi ke format Gemini lewat toGeminiSchema() saat model dibuat.
// ==========================================================

const CREATE_PROMOTION_FUNCTION = {
  name: "create_promotion",
  description:
    "Panggil ini kalau nama promotion DAN semua kode promo sudah terisi (DATA AMAN), sehingga aman untuk langsung dieksekusi ke GuestPro. Gunakan data APA ADANYA - jangan mengubah, membulatkan, atau menafsirkan ulang nilai apapun.",
  parameters: {
    type: "object",
    properties: {
      nama: { type: "string" },
      namaID: { type: "string" },
      type: { type: "string", enum: ["PROMO CODE"] },
      promoCodes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kode: { type: "string" },
            maxUsed: { type: "number" }
          },
          required: ["kode"]
        }
      },
      group: { type: "string" },
      agent: { type: "string" },
      description: { type: "string" },
      descriptionID: { type: "string" },
      rates: {
        type: "array",
        items: {
          type: "object",
          properties: {
            category: { type: "string" },
            rate: { type: "string" }
          },
          required: ["rate"]
        }
      },
      formulas: {
        type: "array",
        items: {
          type: "object",
          properties: {
            formula: { type: "string", enum: ["DECREASE", "INCREASE"] },
            formulaType: { type: "string", enum: ["AMOUNT", "PERCENT"] },
            value: { type: "number" }
          },
          required: ["formula", "formulaType", "value"]
        }
      },
      minimumNight: { type: "number" }
    },
    required: ["nama", "type", "promoCodes", "description", "rates", "formulas", "minimumNight"]
  }
};

// ==========================================================
// TOOL 2: FLAG ANOMALY (dipakai jalur Manual) — khusus menandai
// DATA KOSONG (nama promotion dan/atau kode promo)
// ==========================================================
const FLAG_ANOMALY_FUNCTION = {
  name: "flag_anomaly",
  description:
    "Panggil ini SEBAGAI GANTI create_promotion kalau field nama promotion DAN/ATAU ada kode promo yang MASIH KOSONG, sehingga data belum lengkap dan belum bisa dieksekusi ke GuestPro.",
  parameters: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description:
          "Sebutkan SPESIFIK field mana saja yang kosong (contoh: 'Nama promotion kosong', 'Kode promo ke-2 kosong'). Jangan sebut hal lain di luar nama & kode promo."
      }
    },
    required: ["reason"]
  }
};

// ==========================================================
// TOOL 3: SUMMARIZE ANOMALIES (dipakai jalur Import, 1x per batch)
// ==========================================================
const SUMMARIZE_ANOMALIES_FUNCTION = {
  name: "summarize_anomalies",
  description:
    "Buat ringkasan singkat dan jelas (bahasa Indonesia) tentang baris mana saja yang nama promotion dan/atau kode promonya masih kosong, supaya user gampang tahu apa yang perlu diisi sebelum melanjutkan.",
  parameters: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "Ringkasan singkat per-baris (atau dikelompokkan), fokus ke field mana yang kosong."
      }
    },
    required: ["summary"]
  }
};

// Deklarasi versi Gemini (hasil konversi toGeminiSchema)
const CREATE_PROMOTION_DECLARATION = {
  name: CREATE_PROMOTION_FUNCTION.name,
  description: CREATE_PROMOTION_FUNCTION.description,
  parameters: toGeminiSchema(CREATE_PROMOTION_FUNCTION.parameters)
};

const FLAG_ANOMALY_DECLARATION = {
  name: FLAG_ANOMALY_FUNCTION.name,
  description: FLAG_ANOMALY_FUNCTION.description,
  parameters: toGeminiSchema(FLAG_ANOMALY_FUNCTION.parameters)
};

const SUMMARIZE_ANOMALIES_DECLARATION = {
  name: SUMMARIZE_ANOMALIES_FUNCTION.name,
  description: SUMMARIZE_ANOMALIES_FUNCTION.description,
  parameters: toGeminiSchema(SUMMARIZE_ANOMALIES_FUNCTION.parameters)
};

// ==========================================================
// HELPER: BANGUN MODEL GEMINI DENGAN SET TOOL TERTENTU, DIPAKSA
// MEMANGGIL SALAH SATU TOOL (mode: "ANY" ~ pengganti tool_choice:"required")
// ==========================================================
function buildModel(functionDeclarations, allowedFunctionNames) {
  return genAI.getGenerativeModel({
    model: MODEL,
    tools: [{ functionDeclarations }],
    toolConfig: {
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames
      }
    }
  });
}

const manualCheckModel = buildModel(
  [CREATE_PROMOTION_DECLARATION, FLAG_ANOMALY_DECLARATION],
  ["create_promotion", "flag_anomaly"]
);
const summarizeModel = buildModel([SUMMARIZE_ANOMALIES_DECLARATION], ["summarize_anomalies"]);
const batchCreateModel = buildModel([CREATE_PROMOTION_DECLARATION], ["create_promotion"]);

// ==========================================================
// KRITERIA YANG DINILAI AI (jalur Manual) — HANYA soal kelengkapan
// nama promotion & kode promo.
// ==========================================================
const DATA_CHECK_CRITERIA = `
Cek data promotion ini HANYA untuk dua hal berikut - JANGAN menilai hal lain (persentase diskon, minimum malam, rates, agent, dsb - itu di luar pengecekan ini):

1. Nama promotion (field "nama"): harus terisi (tidak boleh kosong atau cuma spasi).
2. Kode promo (field "promoCodes[].kode"): SETIAP kode promo di dalam array promoCodes harus terisi (tidak boleh kosong atau cuma spasi). Kalau array promoCodes kosong sama sekali, itu juga dianggap kosong.

Kalau NAMA dan SEMUA KODE PROMO sudah terisi -> data ini DATA AMAN, panggil create_promotion dengan data APA ADANYA.
Kalau ADA yang kosong (nama dan/atau satu atau lebih kode promo) -> data ini DATA KOSONG, panggil flag_anomaly dan sebutkan persis field mana saja yang kosong.
`.trim();

// ==========================================================
// VALIDASI STRUKTURAL (dipakai jalur Manual & Import)
// ==========================================================
function argsStructurallyMatch(aiArgs, original) {
  if (!aiArgs || typeof aiArgs !== "object") return false;

  const arrayFields = ["promoCodes", "rates", "formulas"];
  for (const key of arrayFields) {
    const a = Array.isArray(aiArgs[key]) ? aiArgs[key] : [];
    const b = Array.isArray(original[key]) ? original[key] : [];
    if (a.length !== b.length) return false;
  }

  if (String(aiArgs.nama || "").trim() !== String(original.nama || "").trim()) {
    return false;
  }

  return true;
}

// NOTE: Gemini mengembalikan functionCall.args SEBAGAI OBJECT LANGSUNG,
// jadi tidak perlu safeParseToolArgs (JSON.parse) seperti versi
// OpenAI/DeepSeek. Fungsi ini sengaja TIDAK ADA di versi ini.

// ==========================================================
// TIMEOUT HELPER
// ==========================================================

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout ${ms}ms`));
    }, ms);

    promise.then(
      result => {
        clearTimeout(timer);
        resolve(result);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

// ==========================================================
// RETRY-WITH-BACKOFF UNTUK PANGGILAN GEMINI
// ==========================================================
async function callOpenAIWithRetry(requestFn, { contextLabel = "" } = {}) {
  let lastErr;

  for (let attempt = 0; attempt <= OPENAI_RETRY_ATTEMPTS; attempt++) {
    try {
      return await withTimeout(requestFn(), REQUEST_TIMEOUT_MS);
    } catch (err) {
      lastErr = err;
      const canRetry = attempt < OPENAI_RETRY_ATTEMPTS && isRetryableOpenAIError(err);

      if (!canRetry) throw err;

      const delayMs = OPENAI_RETRY_BASE_DELAY_MS * Math.pow(3, attempt);
      console.warn(
        `⚠️ Gemini 5xx/overloaded saat ${contextLabel || "(tanpa label)"} - retry ${attempt + 1}/${OPENAI_RETRY_ATTEMPTS} setelah ${delayMs}ms...`
      );
      await sleep(delayMs);
    }
  }

  throw lastErr;
}

// ==========================================================
// RULE-BASED CHECK (0 token, murni JS) — mengecek KELENGKAPAN DATA
// (nama promotion & kode promo). Mengembalikan array alasan (string)
// - KOSONG = DATA AMAN.
// ==========================================================
function findEmptyDataAnomalies(finalData) {
  const reasons = [];

  const namaKosong = !finalData?.nama || String(finalData.nama).trim() === "";
  if (namaKosong) {
    reasons.push("Nama promotion kosong");
  }

  const promoCodes = Array.isArray(finalData?.promoCodes) ? finalData.promoCodes : [];
  if (promoCodes.length === 0) {
    reasons.push("Kode promo kosong (belum ada satupun kode promo)");
  } else {
    promoCodes.forEach((pc, idx) => {
      if (!pc || !pc.kode || String(pc.kode).trim() === "") {
        reasons.push(`Kode promo ke-${idx + 1} kosong`);
      }
    });
  }

  return reasons;
}

// ==========================================================
// STATUS "SUDAH LENGKAP / BOLEH LANJUT" — satu sumber kebenaran,
// dipakai baik untuk menentukan tombol yang tampil (buildFlagKeyboard)
// MAUPUN sebagai GUARD sebelum eksekusi nyata (forceCreateAfterFlag).
// ==========================================================
function isFlagResolved(pendingFlag) {
  if (!pendingFlag) return false;

  if (pendingFlag.type === "manual") {
    return findEmptyDataAnomalies(pendingFlag.finalData).length === 0;
  }

  if (pendingFlag.type === "import") {
    return (pendingFlag.flaggedRows || []).every(
      row => findEmptyDataAnomalies(row.data).length === 0
    );
  }

  return false;
}

// ==========================================================
// TOMBOL & TEKS PESAN FLAG
// ==========================================================

function buildFlagKeyboard(chatId, canContinue) {
  if (canContinue) {
    return [
      [
        { text: "✅ Lanjutkan", callback_data: `flag_continue:${chatId}` },
        { text: "❌ Batalkan", callback_data: `flag_cancel:${chatId}` }
      ]
    ];
  }

  return [
    [{ text: "✏️ Edit Data", callback_data: `flag_edit:${chatId}` }],
    [{ text: "❌ Batalkan", callback_data: `flag_cancel:${chatId}` }]
  ];
}

function buildManualFlagText(pf) {
  const freshReasons = findEmptyDataAnomalies(pf.finalData);
  const canContinue = freshReasons.length === 0;

  if (canContinue) {
    return (
      `✅ *DATA AMAN*\n\n` +
      `Nama promotion dan semua kode promo sudah terisi.\n\n` +
      `Tekan "✅ Lanjutkan" untuk membuat promotion ini ke GuestPro.`
    );
  }

  return (
    `🚩 *DATA KOSONG*\n\n` +
    `Field berikut masih kosong dan wajib diisi:\n- ${freshReasons.join("\n- ")}\n\n` +
    `Eksekusi ke GuestPro masih DIHENTIKAN sementara. Tekan "✏️ Edit Data" untuk mengisi field yang kosong.`
  );
}

function buildImportFlagText(pf) {
  const freshFlagged = pf.flaggedRows.map(r => ({
    ...r,
    ruleReasons: findEmptyDataAnomalies(r.data)
  }));

  const stillEmptyCount = freshFlagged.filter(r => r.ruleReasons.length > 0).length;
  const canContinue = stillEmptyCount === 0;

  const detailLines = freshFlagged
    .map(r =>
      r.ruleReasons.length === 0
        ? `Baris ${r.row} (${r.nama || "-"}):\n  ✅ DATA AMAN (sudah diisi)`
        : `Baris ${r.row} (${r.nama || "-"}):\n  🚩 DATA KOSONG - ${r.ruleReasons.join("; ")}`
    )
    .join("\n\n");

  const summaryBlock = pf.aiSummary
    ? `\n\n🤖 Ringkasan AI:\n${pf.aiSummary}`
    : `\n\n⚠️ (AI gagal membuat ringkasan - lihat detail di atas)`;

  const header = canContinue
    ? `✅ *SEMUA DATA SUDAH LENGKAP* (${pf.flaggedRows.length} baris, dari total ${pf.totalRows} baris, ${pf.doneResults.length} baris lain sudah diproses)`
    : `🚩 *${stillEmptyCount} DARI ${pf.flaggedRows.length} BARIS MASIH KOSONG* (dari total ${pf.totalRows} baris, ${pf.doneResults.length} baris lain sudah diproses)`;

  const footer = canContinue
    ? `\n\nTekan "✅ Lanjutkan" untuk membuat semua promotion di atas ke GuestPro.`
    : `\n\nTekan "✏️ Edit Data" untuk mengisi nama/kode promo yang masih kosong pada baris di atas.`;

  return `${header}\n\n${detailLines}${summaryBlock}${footer}`;
}

// ==========================================================
// 1. MANUAL CREATE PROMOTION
// ==========================================================

async function finalizeAndCreate({ chatId, processId, finalData }) {
  const ruleReasons = findEmptyDataAnomalies(finalData);

  if (statusCallback) {
    await statusCallback(chatId, "🤖 Meminta AI untuk mengecek kelengkapan data (nama & kode promo)...");
  }

  let usedLLM = true;
  let argsToUse = finalData;

  try {
    const result = await callOpenAIWithRetry(
      () =>
        manualCheckModel.generateContent({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text:
                    DATA_CHECK_CRITERIA +
                    "\n\nData promotion yang akan diproses:\n\n" +
                    JSON.stringify(finalData)
                }
              ]
            }
          ],
          generationConfig: { maxOutputTokens: 3000 }
        }),
      { contextLabel: "create_promotion" }
    );

    const response = result.response;
    const usage = response.usageMetadata || {};
    console.log("🔍 usage mentah dari Gemini (create):", JSON.stringify(usage));

    recordUsage({
      chatId,
      processId,
      feature: "executor:create-promotion",
      model: MODEL,
      usage: buildUsagePayload(usage)
    });

    const functionCalls = response.functionCalls() || [];
    const call = functionCalls[0];
    const callArgs = call ? call.args : null;

    if (call && call.name === "flag_anomaly" && callArgs) {
      const flagInfo = {
        reason: callArgs.reason || "Nama promotion dan/atau kode promo kosong"
      };

      console.warn("🚩 AI FLAG - DATA KOSONG:", flagInfo);

      const pendingPayloadManual = {
        type: "manual",
        finalData,
        flagReason: flagInfo.reason,
        ruleReasons,
        processId
      };
      setPendingFlag(chatId, pendingPayloadManual);

      if (statusCallback) {
        await statusCallback(chatId, buildManualFlagText(pendingPayloadManual), {
          replyMarkup: { inline_keyboard: buildFlagKeyboard(chatId, isFlagResolved(pendingPayloadManual)) }
        });
      }

      return {
        success: false,
        flagged: true,
        flagReason: flagInfo.reason,
        viaLLM: usedLLM
      };
    }

    if (call && call.name === "create_promotion" && callArgs) {
      console.log("🤖 AI TOOL:", call.name);
      console.log("📦 ARG dari AI:", callArgs);

      if (statusCallback) {
        await statusCallback(
          chatId,
          "🤖 AI: DATA AMAN, memanggil tool:\n\n" + "🛠 " + call.name
        );
      }

      if (argsStructurallyMatch(callArgs, finalData)) {
        argsToUse = callArgs;
        console.log("✅ Struktur data dari AI cocok - dipakai untuk eksekusi.");
      } else {
        console.warn("⚠️ Struktur data dari AI TIDAK cocok dengan data asli - pakai data asli sebagai fallback aman.");
        argsToUse = finalData;
        if (statusCallback) {
          await statusCallback(
            chatId,
            "⚠️ AI mengembalikan struktur data yang tidak cocok dengan data asli kamu - sistem otomatis pakai data asli kamu supaya tetap akurat."
          );
        }
      }
    } else {
      console.warn("⚠️ AI tidak memanggil tool yang dikenali (tool call kosong/tidak valid).");
      usedLLM = false;
      await notifyFallback(
        chatId,
        new Error("AI tidak mengembalikan tool call yang valid"),
        "create_promotion"
      );
    }
  } catch (err) {
    console.error("❌ LLM CREATE ERROR:", err.message);
    console.error(err.stack);
    usedLLM = false;
    await notifyFallback(chatId, err, "create_promotion");
  }

  if (!usedLLM && ruleReasons.length > 0) {
    const pendingPayloadManualFallback = {
      type: "manual",
      finalData,
      flagReason: `AI gagal ditinjau (timeout/error), padahal sistem rule-based sudah menemukan field kosong: ${ruleReasons.join("; ")}`,
      ruleReasons,
      processId
    };
    setPendingFlag(chatId, pendingPayloadManualFallback);

    if (statusCallback) {
      await statusCallback(chatId, buildManualFlagText(pendingPayloadManualFallback), {
        replyMarkup: { inline_keyboard: buildFlagKeyboard(chatId, isFlagResolved(pendingPayloadManualFallback)) }
      });
    }

    return { success: false, flagged: true, flagReason: "AI gagal ditinjau", viaLLM: false };
  }

  const outcome = await createPromotionTool(argsToUse);

  return { ...outcome, viaLLM: usedLLM, viaRuleBased: false, flagged: false };
}

// ==========================================================
// 1B. IMPORT — REVIEW SATU KALI UNTUK SELURUH BATCH BARIS KOSONG.
// ==========================================================
async function reviewFlaggedImportRowsViaAI({ chatId, processId, flaggedRows }) {
  const payload = flaggedRows.map(r => ({
    row: r.rowNumber,
    nama: r.nama,
    fieldKosong: r.ruleReasons,
    data: r.data
  }));

  const result = await callOpenAIWithRetry(
    () =>
      summarizeModel.generateContent({
        contents: [
          {
            role: "user",
            parts: [
              {
                text:
                  "Berikut daftar baris promotion dari file Excel yang SUDAH ditandai oleh sistem rule-based karena " +
                  "nama promotion dan/atau kode promonya masih kosong. Buat ringkasannya lewat tool summarize_anomalies, " +
                  "sebutkan per baris field mana yang kosong.\n\n" +
                  JSON.stringify(payload)
              }
            ]
          }
        ],
        generationConfig: { maxOutputTokens: 1500 }
      }),
    { contextLabel: "review-import-batch" }
  );

  const response = result.response;
  const usage = response.usageMetadata || {};
  console.log("🔍 usage mentah dari Gemini (review import batch):", JSON.stringify(usage));

  recordUsage({
    chatId,
    processId,
    feature: "executor:review-import-batch",
    model: MODEL,
    usage: buildUsagePayload(usage)
  });

  const functionCalls = response.functionCalls() || [];
  const call = functionCalls.find(fc => fc.name === "summarize_anomalies");

  return call?.args?.summary || null;
}

// ==========================================================
// AI dipanggil HANYA SEKALI untuk SATU BATCH (N baris sekaligus)
// ==========================================================
async function executeRowsBatchViaAI({ chatId, processId, rows, contextLabel, promptIntro, concurrency }) {
  const payload = rows.map(r => ({ row: r.row, nama: r.nama, data: r.data }));

  try {
    const result = await callOpenAIWithRetry(
      () =>
        batchCreateModel.generateContent({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text:
                    `${promptIntro} Panggil tool create_promotion UNTUK MASING-MASING baris di bawah ini ` +
                    `(total ${rows.length} baris, jadi total ${rows.length} pemanggilan tool dalam respons ini) - ` +
                    "gunakan data APA ADANYA, jangan mengubah, membulatkan, atau menafsirkan ulang nilai apapun. " +
                    "Field \"nama\" pada tiap pemanggilan tool WAJIB persis sama dengan \"nama\" pada baris " +
                    "terkait, supaya bisa dicocokkan.\n\n" +
                    "Baris-baris yang harus dieksekusi:\n\n" + JSON.stringify(payload)
                }
              ]
            }
          ],
          generationConfig: { maxOutputTokens: Math.min(8000, 1000 + rows.length * 200) }
        }),
      { contextLabel }
    );

    const response = result.response;
    const usage = response.usageMetadata || {};
    console.log(`🔍 usage mentah dari Gemini (${contextLabel}):`, JSON.stringify(usage));

    recordUsage({
      chatId,
      processId,
      feature: `executor:${contextLabel}`,
      model: MODEL,
      usage: buildUsagePayload(usage)
    });

    // NOTE: Gemini bisa mengembalikan beberapa functionCall dalam satu
    // respons ("parallel function calling") kalau modelnya menilai perlu,
    // tapi TIDAK ADA jaminan keras (seperti parallel_tool_calls di OpenAI)
    // bahwa jumlahnya akan selalu persis sama dengan jumlah baris yang
    // diminta. Baris yang tidak kebagian tool call tetap fallback ke data
    // asli, sama seperti versi OpenAI/DeepSeek.
    const functionCalls = (response.functionCalls() || []).filter(fc => fc.name === "create_promotion");

    const usedIndexes = new Set();
    const rowsWithArgs = rows.map(row => {
      const matchIdx = functionCalls.findIndex((fc, idx) => {
        if (usedIndexes.has(idx)) return false;
        const args = fc.args;
        return args && String(args.nama || "").trim() === String(row.nama || "").trim();
      });

      if (matchIdx === -1) {
        console.warn(`⚠️ Baris "${row.nama}" (row ${row.row}): tidak ada tool call cocok dari AI - fallback ke data asli.`);
        return { row, argsToUse: row.data, viaLLM: false };
      }

      usedIndexes.add(matchIdx);
      const args = functionCalls[matchIdx].args;
      const argsToUse = argsStructurallyMatch(args, row.data) ? args : row.data;
      return { row, argsToUse, viaLLM: true };
    });

    const results = await runWithConcurrencyLimit(rowsWithArgs, concurrency, async item => {
      const outcome = await createPromotionTool(item.argsToUse);
      return {
        row: item.row.row,
        nama: item.row.nama,
        status: outcome.ok ? "success" : "error",
        message: outcome.ok ? "Berhasil" : outcome.reason,
        promotionId: outcome.promotionId,
        viaLLM: item.viaLLM
      };
    });

    return { results, viaLLM: true };
  } catch (err) {
    console.error(`❌ AI BATCH ERROR (${contextLabel}):`, err.message);
    await notifyFallback(chatId, err, contextLabel);

    const results = await runWithConcurrencyLimit(rows, concurrency, async row => {
      const outcome = await createPromotionTool(row.data);
      return {
        row: row.row,
        nama: row.nama,
        status: outcome.ok ? "success" : "error",
        message: outcome.ok ? "Berhasil" : outcome.reason,
        promotionId: outcome.promotionId,
        viaLLM: false
      };
    });

    return { results, viaLLM: false };
  }
}

// ==========================================================
// 2A. EKSEKUSI SETELAH USER KONFIRMASI "LANJUTKAN" — TANPA AI (Manual)
// ==========================================================
async function forceCreateOneWithoutAI({ data }) {
  const outcome = await createPromotionTool(data);
  return { outcome, viaLLM: false };
}

// ==========================================================
// 2B. EKSEKUSI SETELAH DI-FLAG (generalized manual & import)
// ==========================================================
async function forceCreateAfterFlag(chatId) {
  const pendingFlag = getPendingFlag(chatId);

  if (!pendingFlag) {
    return {
      success: false,
      error: "Tidak ada promotion yang menunggu konfirmasi (mungkin sudah kadaluarsa atau sudah diproses)."
    };
  }

  if (!isFlagResolved(pendingFlag)) {
    return {
      success: false,
      error: "Masih ada field yang kosong (nama promotion / kode promo). Lengkapi dulu lewat tombol \"✏️ Edit Data\" sebelum melanjutkan."
    };
  }

  clearPendingFlag(chatId);

  if (pendingFlag.type === "import") {
    console.log(
      `▶️ User konfirmasi lanjut IMPORT setelah data dilengkapi (chatId=${chatId}), AI dipanggil 1x untuk seluruh batch (${pendingFlag.flaggedRows.length} baris).`
    );

    const { results: forcedResults, viaLLM } = await executeRowsBatchViaAI({
      chatId,
      processId: pendingFlag.processId,
      rows: pendingFlag.flaggedRows,
      contextLabel: "force-import-batch",
      promptIntro:
        "Baris-baris berikut tadinya ditandai karena nama promotion/kode promo kosong, tapi SUDAH DILENGKAPI " +
        "user dan dikonfirmasi (lewat tombol Telegram) untuk dibuat sekarang.",
      concurrency: IMPORT_FORCE_CONCURRENCY
    });

    const allResults = [...(pendingFlag.doneResults || []), ...forcedResults].sort((a, b) => a.row - b.row);
    return {
      status: "done",
      results: allResults,
      viaLLM,
      wasFlaggedThenConfirmed: true,
      type: "import",
      processId: pendingFlag.processId
    };
  }

  console.log(`▶️ User konfirmasi lanjut MANUAL setelah data dilengkapi (chatId=${chatId}), eksekusi LANGSUNG tanpa AI.`);

  const { outcome, viaLLM } = await forceCreateOneWithoutAI({ data: pendingFlag.finalData });

  return {
    ...outcome,
    viaLLM,
    wasFlaggedThenConfirmed: true,
    type: "manual",
    processId: pendingFlag.processId
  };
}

// ==========================================================
// 3. BATALKAN SETELAH DI-FLAG
// ==========================================================
function cancelAfterFlag(chatId) {
  const pendingFlag = getPendingFlag(chatId);
  clearPendingFlag(chatId);
  return {
    cancelled: true,
    hadPending: !!pendingFlag,
    type: pendingFlag?.type,
    doneResults: pendingFlag?.doneResults || []
  };
}

// ==========================================================
// 4. IMPORT EXCEL
// ==========================================================

async function finalizeImportExcel({ chatId, processId, filePath }) {
  let rows;
  try {
    rows = await parseExcelForReview(filePath);
  } catch (err) {
    console.error("❌ GAGAL PARSE EXCEL:", err.message);
    if (statusCallback) {
      await statusCallback(chatId, `❌ Gagal membaca file Excel: ${err.message}`);
    }
    return { status: "error", message: err.message, results: [] };
  }

  if (rows.length === 0) {
    if (statusCallback) {
      await statusCallback(chatId, "❌ File Excel kosong / tidak ada baris data.");
    }
    return { status: "error", message: "File Excel kosong / tidak ada baris data.", results: [] };
  }

  const skippedResults = [];
  const validRows = [];
  for (const item of rows) {
    if (item.missing && item.missing.length > 0) {
      skippedResults.push({
        row: item.rowNumber,
        nama: item.nama,
        status: "skipped",
        message: "Field kurang: " + item.missing.join(", ")
      });
    } else {
      validRows.push(item);
    }
  }

  if (statusCallback) {
    await statusCallback(
      chatId,
      `🔍 Mengecek ${validRows.length} baris (nama & kode promo, rule-based, 0 token)...`
    );
  }

  const flaggedRows = [];
  const cleanRows = [];
  for (const item of validRows) {
    const ruleReasons = findEmptyDataAnomalies(item.data);
    if (ruleReasons.length > 0) {
      flaggedRows.push({ ...item, ruleReasons });
    } else {
      cleanRows.push(item);
    }
  }

  let doneResults = [];
  let cleanViaLLM = false;

  if (cleanRows.length > 0) {
    if (statusCallback) {
      await statusCallback(
        chatId,
        `🤖 ${cleanRows.length} baris DATA AMAN - meminta AI mengeksekusi (1x panggilan untuk semua baris)...`
      );
    }

    const rowsForAI = cleanRows.map(item => ({ row: item.rowNumber, nama: item.nama, data: item.data }));
    const batchResult = await executeRowsBatchViaAI({
      chatId,
      processId,
      rows: rowsForAI,
      contextLabel: "import-clean-batch",
      promptIntro: "Baris-baris berikut sudah dinilai DATA AMAN oleh sistem rule-based (nama & kode promo terisi).",
      concurrency: IMPORT_DIRECT_CONCURRENCY
    });

    doneResults = batchResult.results;
    cleanViaLLM = batchResult.viaLLM;
  }

  const allDone = [...skippedResults, ...doneResults].sort((a, b) => a.row - b.row);

  if (flaggedRows.length === 0) {
    return { status: "done", results: allDone, viaLLM: cleanViaLLM };
  }

  if (statusCallback) {
    await statusCallback(
      chatId,
      `🤖 Ditemukan ${flaggedRows.length} baris DATA KOSONG dari ${validRows.length} baris - meminta AI membuat ringkasan (1x panggilan untuk semua baris, bukan per baris)...`
    );
  }

  let aiSummary = null;
  try {
    aiSummary = await reviewFlaggedImportRowsViaAI({ chatId, processId, flaggedRows });
  } catch (err) {
    console.error("❌ AI REVIEW IMPORT BATCH ERROR:", err.message);
    console.error(err.stack);
    await notifyFallback(chatId, err, "review-import-batch");
  }

  const pendingPayloadImport = {
    type: "import",
    flaggedRows: flaggedRows.map(r => ({
      row: r.rowNumber,
      nama: r.nama,
      data: r.data,
      ruleReasons: r.ruleReasons
    })),
    doneResults: allDone,
    totalRows: rows.length,
    aiSummary,
    processId
  };
  setPendingFlag(chatId, pendingPayloadImport);

  if (statusCallback) {
    await statusCallback(chatId, buildImportFlagText(pendingPayloadImport), {
      replyMarkup: { inline_keyboard: buildFlagKeyboard(chatId, isFlagResolved(pendingPayloadImport)) }
    });
  }

  return {
    status: "flagged",
    success: false,
    flagged: true,
    totalRows: rows.length,
    flaggedRows: flaggedRows.length,
    doneResults: allDone,
    viaLLM: cleanViaLLM || !!aiSummary,
    results: allDone
  };
}

// ==========================================================
// EXPORT
// ==========================================================

module.exports = {
  finalizeAndCreate,
  forceCreateAfterFlag,
  cancelAfterFlag,
  finalizeImportExcel,
  setStatusCallback,
  checkRuleBasedAnomalies: findEmptyDataAnomalies,
  isFlagResolved,
  buildManualFlagText,
  buildImportFlagText,
  buildFlagKeyboard
};