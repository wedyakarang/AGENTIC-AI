// ======================================
// TELEGRAM HERMES - FINAL BUILD (v25 - MODE WEBHOOK LOKAL, bukan polling
// lagi. Perubahan dari v24: bot tidak lagi aktif "nanya" ke Telegram
// terus-menerus (polling: true dihapus). Sekarang Telegram yang KIRIM
// update ke server lokal kita lewat HTTP POST, diteruskan lewat tunnel
// publik (ngrok / Cloudflare Tunnel) karena kita tidak punya VPS/domain
// sendiri. State (userState, manualSessions, dll) TETAP di memory proses
// yang sama seperti sebelumnya - TIDAK dipindah ke database, karena
// prosesnya tetap 1 dan terus jalan (bukan serverless).
//
// v26 - PERUBAHAN: tombol "🎯 PROMOTION" yang otomatis muncul lagi
// setiap kali sebuah proses (create manual/import/force-create/cancel)
// SELESAI (lewat fungsi sendPromotionAgainButton) SUDAH DIHAPUS.
// Sekarang tombol itu HANYA muncul di 1 tempat: balasan command /start.
// Kalau user mau bikin promotion baru setelah selesai, dia tinggal
// ketik ulang "promotion" atau "/promotion" secara manual - tidak ada
// lagi tombol pintasan yang otomatis dimunculkan bot.
//
// CARA PAKAI:
//   1. Jalankan ngrok: ngrok http 3000
//   2. Copy URL https yang keluar dari ngrok, isi ke PUBLIC_URL di .env
//   3. Jalankan bot ini: npm run hermes (webhook otomatis didaftarkan
//      ke Telegram saat startup kalau PUBLIC_URL sudah diisi)
//   4. Cek pendaftaran webhook:
//      curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo
//
// CATATAN: URL ngrok gratis BERUBAH tiap kali ngrok di-restart - berarti
// PUBLIC_URL di .env juga harus diupdate + bot di-restart tiap kali itu
// terjadi, supaya webhook yang terdaftar ke Telegram tetap valid.
// ======================================

require("./networkConfig");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const express = require("express");
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
const { answerPromotionQuestion } = require("./tools/analysisAgent");

const VERSION_TAG = "telegram3-final-v26-webhook-ngrok";

if (!process.env.TELEGRAM_TOKEN) {
  throw new Error("TELEGRAM_TOKEN belum ada di .env");
}
if (!process.env.GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY belum ada di .env");
}
if (!process.env.WEBHOOK_SECRET) {
  throw new Error(
    "WEBHOOK_SECRET belum ada di .env - ini dipakai sebagai bagian rahasia di path webhook " +
      "(https://.../webhook/<WEBHOOK_SECRET>) supaya endpoint tidak sembarangan bisa di-POST orang lain. " +
      "Isi dengan string acak yang panjang, bebas format."
  );
}
if (!process.env.PUBLIC_URL) {
  console.warn(
    "⚠️ PUBLIC_URL belum diisi di .env - webhook TIDAK akan otomatis didaftarkan ke Telegram saat start. " +
      "Jalankan ngrok/Cloudflare Tunnel dulu, copy URL https-nya ke PUBLIC_URL, baru restart bot."
  );
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

// PERUBAHAN UTAMA v25: TIDAK ADA LAGI { polling: true }. Bot dibuat
// dalam mode pasif - dia cuma dipakai untuk KIRIM balasan (sendMessage,
// editMessageText, dll), sedangkan update MASUK diproses manual lewat
// bot.processUpdate() di dalam handler webhook Express di bawah.
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN);

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

// Telegram membatasi ±4096 karakter per pesan. Kalau teks (misal
// daftar 46+ nama promosi) lebih panjang dari itu, pecah jadi
// beberapa pesan berurutan - dipecah per BARIS supaya tidak ada
// baris yang terpotong di tengah, dan tidak ada data yang hilang.
const TELEGRAM_SAFE_CHUNK_SIZE = 3500;

function splitLongMessage(text, maxLen = TELEGRAM_SAFE_CHUNK_SIZE) {
  if (!text || text.length <= maxLen) return [text];

  const lines = text.split("\n");
  const chunks = [];
  let current = "";

  for (const line of lines) {
    const candidate = current ? current + "\n" + line : line;
    if (candidate.length > maxLen && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);

  return chunks;
}

async function sendLong(chatId, text) {
  const chunks = splitLongMessage(text);
  for (let i = 0; i < chunks.length; i++) {
    const prefix = chunks.length > 1 ? `*(${i + 1}/${chunks.length})*\n\n` : "";
    await send(chatId, prefix + chunks[i]);
  }
}


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

// v26: fungsi sendPromotionAgainButton() DIHAPUS. Sebelumnya fungsi
// ini dipanggil otomatis setiap kali sebuah proses (create manual,
// import excel, force-create setelah flag, atau cancel) SELESAI -
// efeknya tombol "🎯 PROMOTION" terus muncul berulang-ulang tiap
// user selesai bikin promotion, padahal user cuma minta tombol itu
// muncul saat /start saja. Semua titik pemanggilannya di bawah sudah
// dihapus juga (lihat komentar "v26" di tiap lokasi).

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
    // v26: sendPromotionAgainButton(chatId) DIHAPUS dari sini.
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
    // v26: sendPromotionAgainButton(chatId) DIHAPUS dari sini.
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
      // v26: sendPromotionAgainButton(chatId) DIHAPUS dari sini.
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
      // v26: sendPromotionAgainButton(chatId) DIHAPUS dari sini.
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
    // v26: sendPromotionAgainButton(chatId) DIHAPUS dari sini.
  } finally {
    fs.unlink(filePath, () => {});
    userState.delete(chatId);
  }
}

async function reportForceOutcome(chatId, outcome) {
  if (!outcome) {
    await updateProgress(chatId, "❌ Terjadi kesalahan tak terduga saat memproses konfirmasi.", null);
    clearProgress(chatId);
    // v26: sendPromotionAgainButton(chatId) DIHAPUS dari sini.
    return;
  }

  if (outcome.error) {
    await updateProgress(chatId, `❌ ${escapeMarkdown(outcome.error)}`, null);
    clearProgress(chatId);
    // v26: sendPromotionAgainButton(chatId) DIHAPUS dari sini.
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
  // v26: sendPromotionAgainButton(chatId) DIHAPUS dari sini.
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

  // ==================== COMMAND: /promotion ====================
  if (text === "promotion" || text === "/promotion") {
    await startPromotionFlow(chatId);
    return;
  }
  // ==================== AKHIR COMMAND /promotion ====================

  // ==================== COMMAND: /analisis (AI, PERTANYAAN BEBAS) ====================
  const isAnalisisCommand =
    text === "analisis" ||
    text.startsWith("/analisis") ||
    text.startsWith("analisis ");

  if (isAnalisisCommand) {
    const question = raw.replace(/^\/?analisis\s*/i, "").trim();

    try {
      await send(chatId, "🔐 Mengecek status login GuestPro...");
      await ensureLoggedIn();
    } catch (err) {
      await send(chatId, `❌ Gagal login: ${escapeMarkdown(err.message)}`);
      return;
    }

    await send(chatId, "Baik, mohon ditunggu...");

    const processId = `${chatId}-${Date.now()}`;

    try {
      const answer = await answerPromotionQuestion({ chatId, processId, question });
      await sendLong(chatId, answer);
    } catch (err) {
      console.error("❌ Error saat analisis AI:", err);
      await send(chatId, `❌ Gagal analisis: ${escapeMarkdown(err.message)}`);
    }
    return;
  }
  // ==================== AKHIR COMMAND /analisis ====================

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
    "❌ Perintah tidak dikenal.\n\nKetik */start* untuk lihat menu, atau ketik */promotion* untuk mulai langsung.\nKetik */analisis <pertanyaan>* untuk tanya statistik promosi (contoh: */analisis berapa promo yang masih aktif?*).\nKetik *TOKEN* untuk lihat pemakaian token LLM.\nKetik *VERSION* untuk cek versi bot yang aktif."
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
    // v26: sendPromotionAgainButton(chatId) DIHAPUS dari sini.
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

// ==========================================================
// WEBHOOK SERVER (v25) - menggantikan peran polling. Telegram akan
// POST update ke sini lewat tunnel publik (ngrok/Cloudflare Tunnel),
// bukan bot yang aktif nanya ke Telegram tiap beberapa detik lagi.
// ==========================================================
const app = express();
app.use(express.json());

const WEBHOOK_PATH = `/webhook/${process.env.WEBHOOK_SECRET}`;
const PORT = process.env.PORT || 3000;

app.post(WEBHOOK_PATH, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Endpoint simpel buat ngecek server hidup (opsional, berguna pas testing)
app.get("/", (req, res) => res.send("Hermes webhook aktif ✅"));

app.listen(PORT, async () => {
  console.log(`🤖 Hermes Running [${VERSION_TAG}] - PID ${process.pid}`);
  console.log(`🌐 Webhook server listening di port ${PORT}`);

  if (process.env.PUBLIC_URL) {
    const webhookUrl = `${process.env.PUBLIC_URL}${WEBHOOK_PATH}`;
    try {
      await bot.setWebHook(webhookUrl);
      console.log(`✅ Webhook terdaftar ke Telegram: ${webhookUrl}`);
    } catch (err) {
      console.error("❌ Gagal daftar webhook ke Telegram:", err.message);
    }
  } else {
    console.warn(
      "⚠️ PUBLIC_URL kosong - webhook belum didaftarkan. Isi PUBLIC_URL di .env dengan URL ngrok/tunnel, lalu restart."
    );
  }
});