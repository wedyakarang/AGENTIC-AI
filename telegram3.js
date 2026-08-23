// ======================================
// TELEGRAM HERMES - FINAL BUILD (v20 - validasi kelengkapan nama &
// kode promo di executorAgent.js, edit field cuma Nama Promotion +
// Kode Promo, isFlagResolved sebagai satu sumber kebenaran)
// (Manual: Template deterministik / Tanya Jawab deterministik)
// + Import Excel (via AI, 1x panggilan per BATCH - baik untuk baris
//   aman maupun baris kosong yang sudah dikonfirmasi user, BUKAN
//   1x per baris - supaya hemat token walau baris banyak)
// ======================================

require("./networkConfig");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");

const { ensureLoggedIn } = require("./indexxx");
const { formatImportSummary } = require("./excelll");
const { formatStatsSummary, resetStats } = require("./monitor");
const {
  startQnA,
  handleUserMessage: handleQnAMessage,
  handleUserCallback: handleQnACallback,
  resetSession: resetQnASession,
} = require("./tools/qnaFlow");
const {
  startManualSubmode,
  handlePromotionMessage: handleManualMessage,
  handlePromotionCallback: handleManualCallback,
  resetSession: resetManualSession,
} = require("./tools/parserManual");
const {
  finalizeAndCreate,
  finalizeImportExcel,
  forceCreateAfterFlag,
  cancelAfterFlag,
  setStatusCallback,
  checkRuleBasedAnomalies,
  isFlagResolved,
  buildManualFlagText,
  buildImportFlagText,
  buildFlagKeyboard,
} = require("./tools/executorAgent");
const { getPendingFlag } = require("./tools/pendingFlags");
const {
  buildFieldMenuKeyboard,
  buildFieldMenuText,
  buildRowListKeyboard,
} = require("./tools/flagEdit");
const { formatTokenSummary } = require("./tools/tokenMonitor");
const { isUncertainReply, getHelpText } = require("./tools/uncertainty");
const { askContextualHelp } = require("./tools/contextHelper");

const VERSION_TAG = "telegram3-final-v20-validasi-nama-kode-promo";

if (!process.env.TELEGRAM_TOKEN) {
  throw new Error("TELEGRAM_TOKEN belum ada di .env");
}
if (!process.env.GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY belum ada di .env");
}

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || null;
if (!ADMIN_CHAT_ID) {
  console.warn(
    "⚠️ ADMIN_CHAT_ID belum diisi di .env - fitur auto-kirim tombol PROMOTION saat start DILEWATI. " +
      "User tetap bisa mulai lewat /start atau ketik 'promotion' seperti biasa."
  );
}

const DEFAULT_GUESTPRO_PROMOTION_URL_TEMPLATE =
  "https://demo-dashboard-merchant.guestpro.co.id/masterdata/v2/promotion/{id}";
const GUESTPRO_PROMOTION_URL_TEMPLATE =
  process.env.GUESTPRO_PROMOTION_URL_TEMPLATE || DEFAULT_GUESTPRO_PROMOTION_URL_TEMPLATE;
if (!process.env.GUESTPRO_PROMOTION_URL_TEMPLATE) {
  console.warn(
    "ℹ️ GUESTPRO_PROMOTION_URL_TEMPLATE belum diisi di .env - memakai default (demo): " +
      DEFAULT_GUESTPRO_PROMOTION_URL_TEMPLATE +
      " . Kalau nanti pindah ke domain production, isi env ini supaya override default."
  );
}

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const userState = new Map();
const manualSessions = new Map();
const progressMessages = new Map();
const flagEditSessions = new Map();

function getEditingData(chatId) {
  const pf = getPendingFlag(chatId);
  const session = flagEditSessions.get(chatId);
  if (!pf || !session) return null;

  if (pf.type === "manual") return pf.finalData;
  if (pf.type === "import" && session.rowIndex !== null) {
    const row = pf.flaggedRows[session.rowIndex];
    return row ? row.data : null;
  }
  return null;
}

async function renderFieldMenu(chatId, messageId) {
  const data = getEditingData(chatId);
  if (!data) {
    await editButtons(chatId, messageId, "❌ Data tidak ditemukan (mungkin sesi sudah kadaluarsa).", null);
    return;
  }
  const session = flagEditSessions.get(chatId);
  const ruleReasons = checkRuleBasedAnomalies(data);
  const backCallback = session.type === "import" ? "fe:rowlist" : "fe:summary";
  await editButtons(chatId, messageId, buildFieldMenuText(data, ruleReasons), buildFieldMenuKeyboard(data, backCallback));
}

async function renderFlagSummary(chatId, messageId) {
  const pf = getPendingFlag(chatId);
  flagEditSessions.delete(chatId);
  userState.delete(chatId);

  if (!pf) {
    await editButtons(chatId, messageId, "❌ Sesi konfirmasi sudah kadaluarsa.", null);
    return;
  }

  const text = pf.type === "manual" ? buildManualFlagText(pf) : buildImportFlagText(pf);
  const canContinue = isFlagResolved(pf);
  await editButtons(chatId, messageId, text, buildFlagKeyboard(chatId, canContinue));
}

function escapeMarkdown(text) {
  if (!text) return "";

  return String(text)
    .replace(/_/g, "\\_")
    .replace(/\*/g, "\\*")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/`/g, "\\`");
}

function buildPromotionIdDisplay(promotionId) {
  const id = promotionId || "-";
  if (!promotionId || !GUESTPRO_PROMOTION_URL_TEMPLATE || !GUESTPRO_PROMOTION_URL_TEMPLATE.includes("{id}")) {
    return `\`${id}\``;
  }
  const url = GUESTPRO_PROMOTION_URL_TEMPLATE.replace("{id}", encodeURIComponent(promotionId));
  return `[${id}](${url})`;
}

const LIMIT_TITLE_BY_TYPE = {
  rate_limit: "⏳ KENA RATE LIMIT AI",
  quota: "💳 KUOTA AI HABIS",
  timeout: "⌛ KONEKSI KE AI TIMEOUT",
};

async function send(chatId, text, retryCount = 0) {
  const safeText =
    text === undefined || text === null || String(text).trim() === ""
      ? "⚠️ (pesan kosong - ada bug, cek log server)"
      : String(text);

  try {
    return await bot.sendMessage(chatId, safeText, { parse_mode: "Markdown" });
  } catch (err) {
    if (err.response && err.response.statusCode === 429 && retryCount < 3) {
      const retryAfter = err.response.body?.parameters?.retry_after || 2;
      console.warn(
        `⏳ Kena limit Telegram (429) utk chat ${chatId}. Coba lagi dalam ${retryAfter} detik... (percobaan ke-${retryCount + 1})`
      );
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      return send(chatId, text, retryCount + 1);
    }

    if (err.message && err.message.includes("can't parse entities")) {
      console.log("⚠️ Markdown parse gagal, kirim ulang sebagai teks polos.");
      return await bot.sendMessage(chatId, safeText);
    }

    console.error("❌ Gagal kirim pesan Telegram:", err.message);
  }
}

async function sendPlain(chatId, text, retryCount = 0) {
  const safeText =
    text === undefined || text === null || String(text).trim() === ""
      ? "⚠️ (pesan kosong - ada bug, cek log server)"
      : String(text);

  try {
    return await bot.sendMessage(chatId, safeText);
  } catch (err) {
    if (err.response && err.response.statusCode === 429 && retryCount < 3) {
      const retryAfter = err.response.body?.parameters?.retry_after || 2;
      console.warn(
        `⏳ Kena limit Telegram (429) utk chat ${chatId}. Coba lagi dalam ${retryAfter} detik... (percobaan ke-${retryCount + 1})`
      );
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      return sendPlain(chatId, text, retryCount + 1);
    }

    console.error("❌ Gagal kirim pesan Telegram (plain):", err.message);
  }
}

async function sendButtons(chatId, text, keyboard) {
  const safeText =
    text === undefined || text === null || String(text).trim() === ""
      ? "⚠️ (pesan kosong - ada bug, cek log server)"
      : String(text);

  try {
    return await bot.sendMessage(chatId, safeText, {
      parse_mode: "Markdown",
      reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
    });
  } catch (err) {
    if (err.message && err.message.includes("can't parse entities")) {
      return await bot.sendMessage(chatId, safeText, {
        reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
      });
    }
    console.error("❌ Gagal kirim pesan+tombol Telegram:", err.message);
  }
}

async function editButtons(chatId, messageId, text, keyboard) {
  const safeText =
    text === undefined || text === null || String(text).trim() === ""
      ? "⚠️ (pesan kosong - ada bug, cek log server)"
      : String(text);

  try {
    await bot.editMessageText(safeText, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard || [] },
    });
  } catch (err) {
    if (err.message && err.message.includes("message is not modified")) return;

    if (err.message && err.message.includes("can't parse entities")) {
      try {
        console.log("⚠️ Markdown parse gagal saat edit, coba ulang TANPA parse_mode (pesan sama).");
        await bot.editMessageText(safeText, {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: { inline_keyboard: keyboard || [] },
        });
        return;
      } catch (err2) {
        // lanjut ke fallback kirim pesan baru di bawah
      }
    }

    await sendButtons(chatId, text, keyboard);
  }
}

async function updateProgress(chatId, text, keyboard = null) {
  const existingId = progressMessages.get(chatId);

  if (existingId) {
    await editButtons(chatId, existingId, text, keyboard);
    return existingId;
  }

  const msg = await sendButtons(chatId, text, keyboard);
  if (msg && msg.message_id) {
    progressMessages.set(chatId, msg.message_id);
    return msg.message_id;
  }
  return null;
}

function clearProgress(chatId) {
  progressMessages.delete(chatId);
}

setStatusCallback(async (chatId, message, options) => {
  const keyboard =
    options && options.replyMarkup && options.replyMarkup.inline_keyboard
      ? options.replyMarkup.inline_keyboard
      : null;
  await updateProgress(chatId, message, keyboard);
});

async function downloadFile(fileId, savePath) {
  const url = await bot.getFileLink(fileId);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("Gagal download file");
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.promises.writeFile(savePath, buffer);
}

async function sendPromotionAgainButton(chatId) {
  await sendButtons(chatId, "SELAMAT DATANG DI AGENT AI BOOKING ENGINE!!!", [
    [{ text: "🎯 PROMOTION", callback_data: "cmd:promotion" }],
  ]);
}

async function runFinalizeAndReport(chatId, finalData, onDoneCleanup) {
  clearProgress(chatId);
  await updateProgress(chatId, "⏳ Memproses via AI...");

  resetStats();

  const processId = `${chatId}-${Date.now()}`;

  try {
    const outcome = await finalizeAndCreate({
      chatId,
      processId,
      finalData,
    });

    if (outcome.flagged) {
      if (onDoneCleanup) onDoneCleanup();
      return;
    }

    const resultLine = outcome.ok
      ? `✅ Promotion berhasil dibuat: *${escapeMarkdown(finalData.nama)}*\n` +
        `ID: ${buildPromotionIdDisplay(outcome.promotionId)}` +
        (outcome.viaLLM ? "" : "\n_(diproses via fallback, tanpa AI)_")
      : `❌ Promotion gagal dibuat.\nAlasan: ${escapeMarkdown(outcome.reason || "tidak diketahui")}`;

    const combinedText =
      resultLine + "\n\n" + formatStatsSummary() + "\n\n" + formatTokenSummary(processId);

    await updateProgress(chatId, combinedText, null);
    clearProgress(chatId);
    await sendPromotionAgainButton(chatId);
  } catch (err) {
    console.error("❌ Error saat finalizeAndCreate:", err);

    if (err.isLimitError) {
      const title = LIMIT_TITLE_BY_TYPE[err.limitType] || "⚠️ LIMIT AI";
      await updateProgress(
        chatId,
        `${title}\n\n${escapeMarkdown(err.message)}\n\nData kamu belum hilang - coba ketik "Ya" lagi sebentar setelah limitnya reda.`,
        null
      );
      return;
    }

    await updateProgress(chatId, `❌ ERROR saat membuat promotion: ${escapeMarkdown(err.message)}`, null);
    clearProgress(chatId);
    await sendPromotionAgainButton(chatId);
  }

  if (onDoneCleanup) onDoneCleanup();
}

async function runImportAndReport(chatId, filePath) {
  clearProgress(chatId);
  await updateProgress(chatId, "📥 Excel diterima & tervalidasi.\n\n⏳ Memproses via AI...");

  resetStats();

  const processId = `${chatId}-${Date.now()}`;

  try {
    const result = await finalizeImportExcel({
      chatId,
      processId,
      filePath,
    });

    if (result.status === "error") {
      await updateProgress(chatId, "❌ " + escapeMarkdown(result.message), null);
      clearProgress(chatId);
      await sendPromotionAgainButton(chatId);
    } else if (result.status === "flagged" || result.flagged) {
      return;
    } else {
      const combinedText =
        formatImportSummary(result.results) +
        (result.viaLLM ? "" : "\n\n(diproses via fallback, tanpa AI)") +
        "\n\n" +
        formatStatsSummary() +
        "\n\n" +
        formatTokenSummary(processId);

      await updateProgress(chatId, combinedText, null);
      clearProgress(chatId);
      await sendPromotionAgainButton(chatId);
    }
  } catch (err) {
    console.error("❌ Error saat finalizeImportExcel:", err);

    if (err.isLimitError) {
      const title = LIMIT_TITLE_BY_TYPE[err.limitType] || "⚠️ LIMIT AI";
      await updateProgress(
        chatId,
        `${title}\n\n${escapeMarkdown(err.message)}\n\nCoba upload ulang file-nya sebentar lagi.`,
        null
      );
      return;
    }

    await updateProgress(chatId, `❌ ERROR:\n\n${escapeMarkdown(err.message)}`, null);
    clearProgress(chatId);
    await sendPromotionAgainButton(chatId);
  } finally {
    fs.unlink(filePath, () => {});
    userState.delete(chatId);
  }
}

async function reportForceOutcome(chatId, outcome) {
  if (!outcome) {
    await updateProgress(chatId, "❌ Terjadi kesalahan tak terduga saat memproses konfirmasi.", null);
    clearProgress(chatId);
    await sendPromotionAgainButton(chatId);
    return;
  }

  if (outcome.error) {
    await updateProgress(chatId, `❌ ${escapeMarkdown(outcome.error)}`, null);
    clearProgress(chatId);
    await sendPromotionAgainButton(chatId);
    return;
  }

  let resultBlock;
  if (outcome.type === "import") {
    resultBlock =
      formatImportSummary(outcome.results || []) +
      (outcome.viaLLM
        ? "\n\n(dieksekusi via AI, 1x panggilan untuk seluruh batch)"
        : "\n\n(AI gagal dipanggil - fallback otomatis tanpa AI)");
  } else if (outcome.ok) {
    resultBlock =
      `✅ Promotion berhasil dibuat (sesuai konfirmasi kamu, tanpa AI).\n` +
      `ID: ${buildPromotionIdDisplay(outcome.promotionId)}`;
  } else {
    resultBlock = `❌ Promotion gagal dibuat.\nAlasan: ${escapeMarkdown(outcome.reason || "tidak diketahui")}`;
  }

  const tokenBlock = "\n\n" + formatTokenSummary(outcome.processId);

  const combinedText = resultBlock + "\n\n" + formatStatsSummary() + tokenBlock;

  await updateProgress(chatId, combinedText, null);
  clearProgress(chatId);

  await sendPromotionAgainButton(chatId);
}

async function startPromotionFlow(chatId) {
  userState.delete(chatId);
  clearProgress(chatId);

  try {
    await send(chatId, "🔐 Mengecek status login GuestPro...");
    const loginResult = await ensureLoggedIn();
    await send(chatId, `✅ ${escapeMarkdown(loginResult.message)}`);
  } catch (err) {
    await send(chatId, `❌ Gagal login: ${escapeMarkdown(err.message)}`);
    return;
  }

  userState.set(chatId, "CHOOSE_MODE");
  await sendButtons(chatId, "Pilih metode input promotion:", [
    [
      { text: "📋 Manual", callback_data: "md:manual" },
      { text: "📥 Import", callback_data: "md:import" },
    ],
  ]);
}

bot.onText(/^\/start$/, async (msg) => {
  const chatId = msg.chat.id;
  await sendButtons(
    chatId,
    "👋 *Selamat datang di Hermes!*\n\nSaya siap membantu kamu membuat promotion hotel di GuestPro dengan cepat dan mudah - tinggal isi data, saya yang urus sisanya.\n\nYuk, mulai sekarang 👇",
    [[{ text: "🎯 PROMOTION", callback_data: "cmd:promotion" }]]
  );
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;

  if (msg.document) {
    if (userState.get(chatId) !== "WAIT_EXCEL") return;

    const fileName = msg.document.file_name || "";
    if (!fileName.match(/\.xlsx?$/i)) {
      await send(chatId, "❌ File harus Excel (.xlsx)");
      return;
    }

    const filePath = path.join(UPLOAD_DIR, `${Date.now()}-${fileName}`);

    try {
      await downloadFile(msg.document.file_id, filePath);
    } catch (err) {
      await send(chatId, `❌ ERROR download file:\n\n${escapeMarkdown(err.message)}`);
      userState.delete(chatId);
      return;
    }

    await runImportAndReport(chatId, filePath);
    return;
  }

  if (!msg.text) return;
  const raw = msg.text.trim();
  const text = raw.toLowerCase();

  if (text === "version" || text === "/version") {
    await send(chatId, `🏷️ Versi bot aktif: *${VERSION_TAG}*\nPID proses: ${process.pid}`);
    return;
  }

  if (text === "token" || text === "/token" || text === "tokens") {
    await sendPlain(chatId, formatTokenSummary());
    return;
  }

  if (text === "promotion") {
    await startPromotionFlow(chatId);
    return;
  }

  const mode = userState.get(chatId);

  if (mode === "CHOOSE_MODE") {
    if (isUncertainReply(raw)) {
      await send(chatId, getHelpText("CHOOSE_MODE"));
      return;
    }

    if (/^(1|manual)$/i.test(raw)) {
      userState.set(chatId, "manual_flow");
      const start = startManualSubmode(manualSessions, chatId);
      await sendButtons(chatId, start.text, start.keyboard);
      return;
    }
    if (/^(2|import)$/i.test(raw)) {
      userState.set(chatId, "WAIT_EXCEL");
      await send(chatId, "Silakan upload file Excel untuk proses import.");
      return;
    }

    const helpProcessId = `${chatId}-${Date.now()}`;
    const helpResult = await askContextualHelp({
      chatId,
      processId: helpProcessId,
      contextKey: "CHOOSE_MODE",
      userQuestion: raw,
    });
    await send(chatId, helpResult.text);
    return;
  }

  if (mode === "manual_flow") {
    const result = handleManualMessage(manualSessions, chatId, raw);

    if (result.delegateToQnA) {
      userState.set(chatId, "qna_flow");
      const firstPrompt = startQnA(chatId);
      console.log(`➡️ [chat ${chatId}] pindah ke qna_flow (Tanya Jawab dipilih)`);
      await send(chatId, firstPrompt);
      return;
    }

    if (result.keyboard) {
      await sendButtons(chatId, result.reply, result.keyboard);
    } else {
      await send(chatId, result.reply);
    }

    if (result.done && result.data) {
      await runFinalizeAndReport(chatId, result.data, () => {
        userState.delete(chatId);
        resetManualSession(manualSessions, chatId);
      });
    }
    return;
  }

  if (mode === "qna_flow") {
    try {
      const result = await handleQnAMessage(chatId, raw);

      if (result.done && result.data) {
        await runFinalizeAndReport(chatId, result.data, () => {
          userState.delete(chatId);
          resetQnASession(chatId);
        });
        return;
      }

      if (result.keyboard) {
        await sendButtons(chatId, result.reply, result.keyboard);
      } else {
        await send(chatId, result.reply);
      }
    } catch (err) {
      console.error("❌ Error di qna_flow:", err);
      await send(chatId, `❌ Terjadi error: ${escapeMarkdown(err.message)}`);
    }
    return;
  }

  // MODE FLAG_EDIT_FLOW: input teks untuk field yang sedang diedit
  // (Nama Promotion / Kode Promo) - disesuaikan dengan flagEdit.js
  // versi baru yang cuma punya 2 jenis field: "nama" dan "promo:<i>".
  if (mode === "flag_edit_flow") {
    const session = flagEditSessions.get(chatId);
    const editData = getEditingData(chatId);

    if (!session || !editData) {
      await send(chatId, "❌ Sesi edit sudah kadaluarsa. Ketik PROMOTION untuk mulai proses baru.");
      userState.delete(chatId);
      flagEditSessions.delete(chatId);
      return;
    }

    if (!raw) {
      await send(chatId, "Tidak boleh kosong. Coba lagi:");
      return;
    }

    if (session.step === "WAIT_NAMA") {
      editData.nama = raw;
    } else if (session.step === "WAIT_PROMO_KODE") {
      editData.promoCodes[session.pendingPromoIndex].kode = raw;
    } else {
      return;
    }

    session.step = null;

    const ruleReasons = checkRuleBasedAnomalies(editData);
    const backCallback = session.type === "import" ? "fe:rowlist" : "fe:summary";
    await sendButtons(chatId, buildFieldMenuText(editData, ruleReasons), buildFieldMenuKeyboard(editData, backCallback));
    return;
  }

  if (mode === "WAIT_EXCEL") {
    await send(chatId, "Menunggu file Excel (.xlsx). Silakan kirim filenya.");
    return;
  }

  await send(
    chatId,
    "❌ Perintah tidak dikenal.\n\nKetik */start* untuk lihat menu, atau ketik *PROMOTION* untuk mulai langsung.\nKetik *TOKEN* untuk lihat pemakaian token LLM.\nKetik *VERSION* untuk cek versi bot yang aktif."
  );
});

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  try {
    await bot.answerCallbackQuery(query.id);
  } catch (err) {
    // gagal jawab callback (misal query sudah kadaluarsa) - tidak fatal
  }

  if (data === "cmd:promotion") {
    await editButtons(chatId, messageId, "🔐 Memulai proses promotion...", null);
    await startPromotionFlow(chatId);
    return;
  }

  if (data && data.startsWith("flag_continue:")) {
    progressMessages.set(chatId, messageId);
    await editButtons(chatId, messageId, "⏳ Memproses konfirmasi kamu...", null);
    try {
      const outcome = await forceCreateAfterFlag(chatId);
      await reportForceOutcome(chatId, outcome);
    } catch (err) {
      console.error("❌ Error saat forceCreateAfterFlag:", err);
      await updateProgress(chatId, `❌ ERROR saat memproses konfirmasi: ${escapeMarkdown(err.message)}`, null);
      clearProgress(chatId);
    }
    userState.delete(chatId);
    flagEditSessions.delete(chatId);
    resetManualSession(manualSessions, chatId);
    resetQnASession(chatId);
    return;
  }

  if (data && data.startsWith("flag_cancel:")) {
    cancelAfterFlag(chatId);
    await editButtons(chatId, messageId, "❌ Dibatalkan.", null);
    clearProgress(chatId);
    await sendPromotionAgainButton(chatId);
    userState.delete(chatId);
    flagEditSessions.delete(chatId);
    resetManualSession(manualSessions, chatId);
    resetQnASession(chatId);
    return;
  }

  if (data && data.startsWith("flag_edit:")) {
    const pf = getPendingFlag(chatId);
    if (!pf) {
      await editButtons(chatId, messageId, "❌ Sesi konfirmasi sudah kadaluarsa, tidak bisa diedit lagi.", null);
      return;
    }

    userState.set(chatId, "flag_edit_flow");

    if (pf.type === "manual") {
      flagEditSessions.set(chatId, { type: "manual", rowIndex: null, step: null });
      await renderFieldMenu(chatId, messageId);
    } else {
      flagEditSessions.set(chatId, { type: "import", rowIndex: null, step: null });
      await editButtons(
        chatId,
        messageId,
        `Pilih baris yang mau diedit (${pf.flaggedRows.length} baris ditandai):`,
        buildRowListKeyboard(pf.flaggedRows)
      );
    }
    return;
  }

  const mode = userState.get(chatId);

  if (mode === "CHOOSE_MODE") {
    if (data === "md:manual") {
      userState.set(chatId, "manual_flow");
      const start = startManualSubmode(manualSessions, chatId);
      await editButtons(chatId, messageId, start.text, start.keyboard);
      return;
    }
    if (data === "md:import") {
      userState.set(chatId, "WAIT_EXCEL");
      await editButtons(chatId, messageId, "Silakan upload file Excel untuk proses import.", null);
      return;
    }
    return;
  }

  if (mode === "manual_flow") {
    const result = handleManualCallback(manualSessions, chatId, data);
    if (!result) return;

    if (result.delegateToQnA) {
      userState.set(chatId, "qna_flow");
      const firstPrompt = startQnA(chatId);
      console.log(`➡️ [chat ${chatId}] pindah ke qna_flow (Tanya Jawab dipilih via tombol)`);
      await editButtons(chatId, messageId, firstPrompt, null);
      return;
    }

    await editButtons(chatId, messageId, result.reply, result.keyboard);

    if (result.done && result.data) {
      await runFinalizeAndReport(chatId, result.data, () => {
        userState.delete(chatId);
        resetManualSession(manualSessions, chatId);
      });
    }
    return;
  }

  if (mode === "qna_flow") {
    try {
      const result = await handleQnACallback(chatId, data);
      if (!result) return;

      if (result.restartToSubmode) {
        resetQnASession(chatId);
        userState.set(chatId, "manual_flow");
        const start = startManualSubmode(manualSessions, chatId);
        await editButtons(chatId, messageId, start.text, start.keyboard);
        return;
      }

      if (result.done && result.data) {
        await editButtons(chatId, messageId, result.reply || "Diproses ✅", null);
        await runFinalizeAndReport(chatId, result.data, () => {
          userState.delete(chatId);
          resetQnASession(chatId);
        });
        return;
      }

      await editButtons(chatId, messageId, result.reply, result.keyboard);
    } catch (err) {
      console.error("❌ Error di qna_flow (callback):", err);
      await send(chatId, `❌ Terjadi error: ${escapeMarkdown(err.message)}`);
    }
    return;
  }

  // FLAG_EDIT_FLOW: navigasi menu edit field yang di-flag (Nama
  // Promotion / Kode Promo) - disesuaikan dengan flagEdit.js versi
  // baru (callback_data "fe:field:nama" dan "fe:field:promo:<i>",
  // TIDAK ADA LAGI "fe:field:formula:<i>" atau "fe:field:minnight").
  if (mode === "flag_edit_flow") {
    const session = flagEditSessions.get(chatId);
    if (!session) return;

    if (data === "fe:rowlist") {
      const pf = getPendingFlag(chatId);
      if (!pf) return;
      session.rowIndex = null;
      await editButtons(
        chatId,
        messageId,
        `Pilih baris yang mau diedit (${pf.flaggedRows.length} baris ditandai):`,
        buildRowListKeyboard(pf.flaggedRows)
      );
      return;
    }

    if (data.startsWith("fe:row:")) {
      session.rowIndex = Number(data.split(":")[2]);
      await renderFieldMenu(chatId, messageId);
      return;
    }

    if (data === "fe:summary") {
      await renderFlagSummary(chatId, messageId);
      return;
    }

    if (data === "fe:field:nama") {
      session.step = "WAIT_NAMA";
      await editButtons(chatId, messageId, "Nama Promotion baru:", null);
      return;
    }

    if (data.startsWith("fe:field:promo:")) {
      session.pendingPromoIndex = Number(data.split(":")[3]);
      session.step = "WAIT_PROMO_KODE";
      await editButtons(chatId, messageId, "Kode Promo baru:", null);
      return;
    }

    return;
  }

  // mode lain (WAIT_EXCEL, atau tidak ada state) -> tombol basi, abaikan
});

console.log(`🤖 Hermes Running [${VERSION_TAG}] - PID ${process.pid}`);

if (ADMIN_CHAT_ID) {
  sendButtons(
    ADMIN_CHAT_ID,
    "👋 SELAMAT DATANG DI AGNET AI BOOKING ENGINE!!!\n\nYuk, mulai sekarang 👇",
    [[{ text: "🎯 PROMOTION", callback_data: "cmd:promotion" }]]
  ).catch((err) => {
    console.error(
      "❌ Gagal kirim pesan auto-welcome ke ADMIN_CHAT_ID:",
      err.message,
      "\n   Kemungkinan penyebab: chatId ini belum pernah chat dengan bot sebelumnya (Telegram menolak",
      "\n   bot mengirim pesan duluan ke chatId yang belum 'kenal' bot), atau ADMIN_CHAT_ID salah/typo."
    );
  });
}