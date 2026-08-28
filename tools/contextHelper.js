// ======================================
// CONTEXT HELPER - AI TERBATAS KONTEKS
// ======================================

const { GoogleGenAI } = require("@google/genai");
const { recordUsage } = require("./tokenMonitor");

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = "gemini-3.5-flash";
const REQUEST_TIMEOUT_MS = 15000;

const OUT_OF_CONTEXT_MESSAGE =
  "Maaf, pertanyaan ini di luar konteks bot ini. 🙏\n\n" +
  "Bot ini cuma bisa bantu untuk membuat *promotion hotel* di GuestPro (lewat Manual atau Import Excel). " +
  "Coba jawab sesuai instruksi terakhir di atas ya, atau ketik *PROMOTION* untuk mulai dari awal.";

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout ${ms}ms`)), ms);
    promise.then(
      (result) => { clearTimeout(timer); resolve(result); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

function buildUsagePayload(usageMeta) {
  return {
    prompt_tokens: usageMeta.promptTokenCount ?? 0,
    completion_tokens: usageMeta.candidatesTokenCount ?? 0,
    thoughts_tokens: usageMeta.thoughtsTokenCount ?? 0,
    tool_use_prompt_tokens: usageMeta.toolUsePromptTokenCount ?? 0,
    cached_tokens: usageMeta.cachedContentTokenCount ?? 0,
    total_tokens: usageMeta.totalTokenCount ?? 0,
  };
}

const ANSWER_DECLARATION = {
  name: "answer_question",
  description:
    "Panggil ini HANYA kalau pertanyaan user berkaitan dengan langkah bot saat ini, cara pakai bot ini, atau proses membuat promotion hotel (Manual/Import/format Excel/dll). Jawab singkat dan jelas.",
  parameters: {
    type: "object",
    properties: {
      answer: {
        type: "string",
        description: "Jawaban singkat (maksimal 3-4 kalimat), Bahasa Indonesia, langsung ke inti, tanpa basa-basi panjang.",
      },
    },
    required: ["answer"],
  },
};

const OUT_OF_CONTEXT_DECLARATION = {
  name: "out_of_context",
  description:
    "Panggil ini kalau pertanyaan/pesan user TIDAK berkaitan sama sekali dengan bot promotion ini - misal curhat, obrolan random, pertanyaan umum di luar cara pakai bot ini, topik lain apapun.",
  parameters: { type: "object", properties: {} },
};

// Deskripsi konteks per state - dikirim ke AI supaya tahu batasan
// topik apa yang masih dianggap "dalam konteks". Tambahkan key baru
// di sini kalau ada state baru yang butuh helper ini.
const CONTEXT_DESCRIPTIONS = {
  CHOOSE_MODE:
    "User sedang diminta memilih antara input Manual (isi data promotion langsung lewat chat) atau Import (upload file Excel berisi banyak promotion sekaligus), untuk membuat promotion hotel di GuestPro.",
  MANUAL_OR_QNA:
    "User sedang diminta memilih antara mengisi promotion pakai Template (format baku) atau dituntun Tanya Jawab satu-satu, di jalur Manual pembuatan promotion hotel.",
  CONFIRM_FORMULA:
    "User sedang ditanya apakah promotion yang sedang dibuat perlu ditambah lebih dari 1 aturan diskon (formula) sekaligus.",
  CONFIRM_SUMMARY:
    "User sedang diminta konfirmasi (Ya/Tidak) apakah ringkasan data promotion yang sudah diisi sudah benar, sebelum dikirim ke GuestPro.",
  FLAG_CONFIRM:
    "User sedang diminta memutuskan 'lanjutkan' atau 'batal' terhadap promotion yang ditandai janggal oleh sistem, sebelum benar-benar dieksekusi ke GuestPro.",
};

/**
 * @param {object} params
 * @param {string|number} params.chatId
 * @param {string} params.processId
 * @param {string} params.contextKey - key dari CONTEXT_DESCRIPTIONS
 * @param {string} params.userQuestion - pesan asli dari user
 * @returns {Promise<{inContext: boolean, text: string}>}
 */
async function askContextualHelp({ chatId, processId, contextKey, userQuestion }) {
  const contextDesc =
    CONTEXT_DESCRIPTIONS[contextKey] ||
    "User sedang menggunakan bot Telegram untuk membuat promotion hotel di GuestPro (Manual atau Import Excel).";

  try {
    const response = await withTimeout(
      ai.models.generateContent({
        model: MODEL,
        contents: [
          {
            role: "user",
            parts: [
              {
                text:
                  `Konteks bot saat ini: ${contextDesc}\n\n` +
                  `Pesan dari user: "${userQuestion}"\n\n` +
                  `Kalau pesan ini adalah pertanyaan/kebingungan yang MASIH berkaitan dengan konteks di atas atau cara pakai bot promotion ini secara umum -> panggil answer_question.\n` +
                  `Kalau pesan ini TIDAK berkaitan sama sekali (topik lain, obrolan random, pertanyaan umum di luar bot ini) -> panggil out_of_context.`,
              },
            ],
          },
        ],
        config: {
          tools: [{ functionDeclarations: [ANSWER_DECLARATION, OUT_OF_CONTEXT_DECLARATION] }],
          toolConfig: {
            functionCallingConfig: {
              mode: "ANY",
              allowedFunctionNames: ["answer_question", "out_of_context"],
            },
          },
          maxOutputTokens: 300,
        },
      }),
      REQUEST_TIMEOUT_MS
    );

    const usageMeta = response.usageMetadata || {};
    recordUsage({
      chatId,
      processId,
      feature: "context-helper",
      model: MODEL,
      usage: buildUsagePayload(usageMeta),
    });

    const parts = response.candidates?.[0]?.content?.parts || [];
    const call = parts.find((p) => p.functionCall)?.functionCall;

    if (call?.name === "answer_question" && call.args?.answer) {
      return { inContext: true, text: call.args.answer };
    }

    // call.name === "out_of_context", ATAU AI tidak memanggil tool
    // yang valid -> dianggap aman sebagai "di luar konteks" (fail-safe:
    // lebih aman menolak daripada AI ngarang jawaban tanpa validasi).
    return { inContext: false, text: OUT_OF_CONTEXT_MESSAGE };
  } catch (err) {
    console.error("❌ CONTEXT HELPER ERROR:", err.message);
    // AI gagal dipanggil (timeout/error) -> fallback aman, JANGAN
    // mencoba menjawab apapun tanpa AI (beda dengan promotion, di sini
    // tidak ada rule-based pengganti untuk menilai pertanyaan bebas).
    return { inContext: false, text: OUT_OF_CONTEXT_MESSAGE };
  }
}

module.exports = {
  askContextualHelp,
  OUT_OF_CONTEXT_MESSAGE,
};