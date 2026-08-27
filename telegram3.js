// ======================================
// TELEGRAM HERMES - FINAL BUILD (v27 - PERBAIKAN UX)
// ======================================
// Riwayat:
// v25 - Mode WEBHOOK LOKAL (bukan polling). Telegram KIRIM update ke
//        server lokal lewat HTTP POST, diteruskan lewat tunnel publik
//        (ngrok / Cloudflare Tunnel). State tetap di memory proses yang
//        sama (Map), tidak dipindah ke database.
// v26 - Tombol "🎯 PROMOTION" yang otomatis muncul lagi setiap proses
//        selesai DIHAPUS. Tombol itu hanya muncul di balasan /start.
// v27 - PERBAIKAN UX (perubahan di build ini):
//   1. Global escape hatch: ketik "batal"/"cancel"/"stop" kapan saja
//      saat sedang di tengah flow untuk langsung keluar bersih.
//   2. Konfirmasi akhir SEBELUM submit: data yang lolos rule-based
//      check (yang sebelumnya langsung dieksekusi tanpa preview) kini
//      selalu ditampilkan dulu ke user via tombol "Buat / Ubah / Batal"
//      sebelum benar-benar dibuat ke GuestPro.
//   3. Pesan error ke user dibuat ramah (friendlyError) - detail
//      teknis tetap lengkap di console.error + (opsional) dikirim ke
//      ADMIN_CHAT_ID, tapi user cuma lihat pesan yang mudah dipahami.
//   4. Indikator "sedang mengetik" (sendChatAction) dikirim sebelum
//      pemanggilan AI yang agak lama (finalize & analisis) supaya bot
//      terasa responsif, bukan diam total.
//   5. /start sekarang menyebutkan semua command yang tersedia
//      (promotion, analisis, token, batal) - sebelumnya tersembunyi.
//   6. Tombol "➕ Buat promotion lagi" ditempel di PESAN HASIL yang
//      sama setelah promotion berhasil dibuat (bukan pesan/tombol baru
//      terpisah seperti di v25) - kompromi antara v25 (berisik) dan
//      v26 (user harus ingat ketik ulang "promotion" manual).
// v28 - PERBAIKAN ROBUSTNESS (perubahan di build ini):
//   7. Busy-lock per chat: mencegah double-tap tombol "Buat Promotion"
//      atau pesan beruntun memicu proses ganda (promotion dobel).
//   8. Timeout pembungkus untuk semua panggilan eksternal (login,
//      finalize, import excel, analisis) - chat tidak lagi stuck tanpa
//      batas kalau layanan luar hang.
//   9. Audit log persisten (promotion-audit.log) - siapa (chat id)
//      membuat promotion apa dan kapan, terlepas dari console log yang
//      hilang saat terminal ditutup.
//   10. Validasi jumlah baris Excel sebelum dikirim ke AI - mencegah
//       file raksasa memicu biaya token besar/proses hang.
//   11. Whitelist akses opsional lewat ALLOWED_CHAT_IDS di .env.
//   12. Graceful shutdown (SIGTERM/SIGINT) - proses yang sedang
//       berjalan dibiarkan selesai dulu sebelum server benar-benar mati.
//
// CARA PAKAI:
//   1. Jalankan ngrok: ngrok http 3000
//   2. Copy URL https yang keluar dari ngrok, isi ke PUBLIC_URL di .env
//   3. Jalankan bot ini: npm run hermes (webhook otomatis didaftarkan
//      ke Telegram saat startup kalau PUBLIC_URL sudah diisi)
//   4. Cek pendaftaran webhook:
//      curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo
//
// REKOMENDASI: jalankan lewat PM2 ("pm2 start 'npm run gateway' --name
// hermes") supaya proses tetap hidup & auto-restart kalau crash/reboot.
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

const VERSION_TAG = "telegram3-final-v29-fix-double-validation";

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
    "⚠️ ADMIN_CHAT_ID belum diisi di .env - notifikasi error teknis ke admin DILEWATI. " +
      "User tetap bisa mulai lewat /start atau ketik 'promotion' seperti biasa."
  );
}

// v28: whitelist akses opsional. Isi ALLOWED_CHAT_IDS di .env dengan
// daftar chat id dipisah koma (mis. "111111,222222") kalau bot ini
// hanya boleh dipakai staf tertentu, bukan siapa pun yang menemukan
// username bot-nya. Kosongkan/hapus env ini untuk membuka akses ke
// semua orang seperti sebelumnya (perilaku default, tidak berubah).
const ALLOWED_CHAT_IDS = (process.env.ALLOWED_CHAT_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (ALLOWED_CHAT_IDS.length > 0) {
  console.log(`🔒 Whitelist akses aktif untuk ${ALLOWED_CHAT_IDS.length} chat id.`);
} else {
  console.warn(
    "⚠️ ALLOWED_CHAT_IDS belum diisi - bot TERBUKA untuk siapa pun yang menemukan username-nya di Telegram."
  );
}
function isAllowedChat(chatId) {
  if (ALLOWED_CHAT_IDS.length === 0) return true; // whitelist tidak aktif = terbuka
  return ALLOWED_CHAT_IDS.includes(String(chatId));
}

// v28: batas wajar jumlah baris Excel yang diproses AI dalam satu
// batch - mencegah file raksasa (sengaja/tidak sengaja) memicu biaya
// token besar atau membuat proses hang lama.
const MAX_EXCEL_ROWS = Number(process.env.MAX_EXCEL_ROWS || 500);

// v28: batas waktu (ms) untuk tiap panggilan ke layanan eksternal
// (login GuestPro, AI finalize/import/analisis) - kalau lewat, chat
// user diberi tahu, bukan menggantung tanpa batas.
const EXTERNAL_CALL_TIMEOUT_MS = Number(process.env.EXTERNAL_CALL_TIMEOUT_MS || 45000);

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
// v27: menyimpan data yang sudah "lolos" alur manual/QnA tapi BELUM
// benar-benar dikirim ke GuestPro - menunggu user menekan tombol
// konfirmasi akhir (lihat askFinalConfirmation).
const pendingSubmissions = new Map();

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

// v27: pesan error yang ramah untuk user awam - detail teknis lengkap
// tetap dicatat di console.error, dan (kalau ADMIN_CHAT_ID diisi)
// dikirim ke admin supaya tetap bisa ditelusuri, tanpa membingungkan
// user yang cuma mau bikin promotion.
function friendlyError(err, context = "") {
  console.error(`❌ [${context || "error"}]`, err);

  if (ADMIN_CHAT_ID) {
    const detail = `⚠️ Error teknis${context ? ` (${context})` : ""}:\n\`${escapeMarkdown(String(err && err.message))}\``;
    sendPlain(ADMIN_CHAT_ID, detail).catch(() => {});
  }

  return (
    "Terjadi kendala saat memproses permintaanmu. Tim teknis sudah diberi tahu.\n\n" +
    "Coba lagi sebentar lagi, atau ketik *batal* lalu ulangi dari awal."
  );
}

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

// v27: indikator "sedang mengetik" native Telegram - dipanggil sebelum
// pemanggilan AI yang agak lama supaya bot terasa responsif, bukan
// diam total sampai hasil muncul. Gagal diam-diam (tidak kritikal).
async function showTyping(chatId) {
  try {
    await bot.sendChatAction(chatId, "typing");
  } catch (_) {
    // tidak fatal - abaikan
  }
}

function resetAllSessions(chatId) {
  userState.delete(chatId);
  flagEditSessions.delete(chatId);
  pendingSubmissions.delete(chatId);
  resetManualSession(manualSessions, chatId);
  resetQnASession(chatId);
  clearProgress(chatId);
  busyChats.delete(chatId);
}

// v28: busy-lock per chat - mencegah double-tap tombol atau pesan
// beruntun memicu proses berat (mis. finalizeAndCreate) dua kali
// sekaligus untuk chat yang sama, yang bisa berujung promotion dobel.
const busyChats = new Set();

function isChatBusy(chatId) {
  return busyChats.has(chatId);
}

async function withBusyLock(chatId, fn) {
  if (busyChats.has(chatId)) {
    await send(chatId, "⏳ Masih memproses permintaan sebelumnya, mohon tunggu sebentar ya.");
    return;
  }
  busyChats.add(chatId);
  try {
    return await fn();
  } finally {
    busyChats.delete(chatId);
  }
}

// v28: bungkus promise dengan batas waktu supaya chat tidak stuck
// tanpa batas kalau layanan eksternal (login GuestPro, AI, dll) hang.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Waktu habis: ${label} melebihi ${Math.round(ms / 1000)} detik`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// v28: audit log persisten - siapa membuat promotion apa dan kapan.
// Terpisah dari console.log supaya tetap ada jejaknya walau terminal
// ditutup atau proses di-restart.
const AUDIT_LOG_PATH = path.join(__dirname, "promotion-audit.log");
function logAudit(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
  fs.appendFile(AUDIT_LOG_PATH, line, (err) => {
    if (err) console.error("❌ Gagal menulis audit log:", err.message);
  });
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

// v27: tombol "lanjutan" yang ditempel LANGSUNG ke pesan hasil akhir
// (bukan pesan terpisah seperti v25, bukan hilang total seperti v26).
// Dipakai sebagai keyboard kedua argumen updateProgress() di titik-titik
// hasil sukses/gagal di bawah.
const CONTINUE_KEYBOARD = [[{ text: "➕ Buat promotion lagi", callback_data: "cmd:promotion" }]];

// v29: PERBAIKAN BUG - askFinalConfirmation sebelumnya SELALU
// menampilkan tombol "✅ Buat Promotion" tanpa mengecek dulu apakah
// data valid, sehingga data yang sudah pasti kosong (nama/kode promo)
// tetap menampilkan opsi "lanjut" - user bisa menekannya, baru GAGAL
// lagi di finalizeAndCreate(), lalu BARU muncul layar Edit/Batal yang
// benar. Ini bikin validasi terasa jalan dua kali padahal cukup sekali.
//
// Sekarang: cek checkRuleBasedAnomalies() (fungsi rule-based YANG SAMA
// dipakai executorAgent.js) SEBELUM menampilkan apa pun. Kalau sudah
// ketahuan kosong, langsung lempar ke runFinalizeAndReport() supaya
// finalizeAndCreate() yang menangani dari awal - hasilnya user LANGSUNG
// dapat layar "DATA KOSONG" + tombol Edit/Batal (foto 3), tanpa mampir
// dulu ke layar "Buat Promotion" yang keliru (foto 2).
async function askFinalConfirmation(chatId, finalData, sourceFlow, onDoneCleanup) {
  const ruleReasons = checkRuleBasedAnomalies(finalData);
  if (ruleReasons.length > 0) {
    // Data sudah pasti tidak valid - skip layar konfirmasi custom,
    // biar executorAgent.js yang tangani (flag + tombol Edit/Batal).
    await runFinalizeAndReport(chatId, finalData, onDoneCleanup);
    return;
  }

  pendingSubmissions.set(chatId, { finalData, sourceFlow, onDoneCleanup });
  userState.set(chatId, "final_confirm_flow");

  let preview;
  try {
    preview = buildManualFlagText({ type: "manual", finalData });
  } catch (_) {
    preview = `Nama: ${finalData.nama || "-"}`;
  }

  await sendButtons(chatId, `📋 *Cek dulu sebelum dibuat:*\n\n${preview}`, [
    [
      { text: "✅ Buat Promotion", callback_data: "final_confirm:yes" },
      { text: "✏️ Ubah Data", callback_data: "final_confirm:edit" },
    ],
    [{ text: "❌ Batal", callback_data: "final_confirm:no" }],
  ]);
}

async function runFinalizeAndReport(chatId, finalData, onDoneCleanup) {
  clearProgress(chatId);
  await showTyping(chatId);
  await updateProgress(chatId, "⏳ Memproses via AI...");

  resetStats();

  const processId = `${chatId}-${Date.now()}`;

  try {
    const outcome = await withTimeout(
      finalizeAndCreate({ chatId, processId, finalData }),
      EXTERNAL_CALL_TIMEOUT_MS,
      "pembuatan promotion"
    );

    if (outcome.flagged) {
      if (onDoneCleanup) onDoneCleanup();
      return;
    }

    // v28: audit log - jejak siapa (chat id) membuat promotion apa,
    // berhasil atau tidak, terlepas dari console log yang bisa hilang.
    logAudit({
      chatId,
      action: "create_promotion",
      nama: finalData.nama,
      ok: !!outcome.ok,
      promotionId: outcome.promotionId || null,
      reason: outcome.ok ? null : outcome.reason || null,
    });

    const resultLine = outcome.ok
      ? `✅ Promotion berhasil dibuat: *${escapeMarkdown(finalData.nama)}*\n` +
        `ID: ${buildPromotionIdDisplay(outcome.promotionId)}` +
        (outcome.viaLLM ? "" : "\n_(diproses via fallback, tanpa AI)_")
      : `❌ Promotion gagal dibuat.\nAlasan: ${escapeMarkdown(outcome.reason || "tidak diketahui")}`;

    const combinedText =
      resultLine + "\n\n" + formatStatsSummary() + "\n\n" + formatTokenSummary(processId);

    await updateProgress(chatId, combinedText, CONTINUE_KEYBOARD);
    clearProgress(chatId);
  } catch (err) {
    if (err.isLimitError) {
      const title = LIMIT_TITLE_BY_TYPE[err.limitType] || "⚠️ LIMIT AI";
      await updateProgress(
        chatId,
        `${title}\n\n${escapeMarkdown(err.message)}\n\nData kamu belum hilang - coba ketik "Ya" lagi sebentar setelah limitnya reda.`,
        null
      );
      return;
    }

    await updateProgress(chatId, `❌ ${friendlyError(err, "finalizeAndCreate")}`, CONTINUE_KEYBOARD);
    clearProgress(chatId);
  }

  if (onDoneCleanup) onDoneCleanup();
}

async function runImportAndReport(chatId, filePath) {
  clearProgress(chatId);
  await showTyping(chatId);
  await updateProgress(chatId, "📥 Excel diterima & tervalidasi.\n\n⏳ Memproses via AI...");

  resetStats();

  const processId = `${chatId}-${Date.now()}`;

  try {
    const result = await withTimeout(
      finalizeImportExcel({ chatId, processId, filePath }),
      EXTERNAL_CALL_TIMEOUT_MS * 2, // batch excel wajar diberi waktu lebih longgar
      "import excel"
    );

    if (result.status === "error") {
      await updateProgress(chatId, "❌ " + escapeMarkdown(result.message), CONTINUE_KEYBOARD);
      clearProgress(chatId);
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

      await updateProgress(chatId, combinedText, CONTINUE_KEYBOARD);
      clearProgress(chatId);
    }
  } catch (err) {
    if (err.isLimitError) {
      const title = LIMIT_TITLE_BY_TYPE[err.limitType] || "⚠️ LIMIT AI";
      await updateProgress(
        chatId,
        `${title}\n\n${escapeMarkdown(err.message)}\n\nCoba upload ulang file-nya sebentar lagi.`,
        null
      );
      return;
    }

    await updateProgress(chatId, `❌ ${friendlyError(err, "finalizeImportExcel")}`, CONTINUE_KEYBOARD);
    clearProgress(chatId);
  } finally {
    fs.unlink(filePath, () => {});
    userState.delete(chatId);
  }
}

async function reportForceOutcome(chatId, outcome) {
  if (!outcome) {
    await updateProgress(chatId, "❌ Terjadi kesalahan tak terduga saat memproses konfirmasi.", CONTINUE_KEYBOARD);
    clearProgress(chatId);
    return;
  }

  if (outcome.error) {
    await updateProgress(chatId, `❌ ${escapeMarkdown(outcome.error)}`, CONTINUE_KEYBOARD);
    clearProgress(chatId);
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

  await updateProgress(chatId, combinedText, CONTINUE_KEYBOARD);
  clearProgress(chatId);
}

async function startPromotionFlow(chatId) {
  resetAllSessions(chatId);

  try {
    await send(chatId, "🔐 Mengecek status login GuestPro...");
    const loginResult = await withTimeout(ensureLoggedIn(), EXTERNAL_CALL_TIMEOUT_MS, "login GuestPro");
    await send(chatId, `✅ ${escapeMarkdown(loginResult.message)}`);
  } catch (err) {
    await send(chatId, `❌ ${friendlyError(err, "ensureLoggedIn")}`);
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
    "👋 *Selamat datang di Hermes!*\n\n" +
      "Saya siap membantu kamu membuat promotion hotel di GuestPro dengan cepat dan mudah - tinggal isi data, saya yang urus sisanya.\n\n" +
      "*Perintah yang tersedia:*\n" +
      "• */promotion* — mulai buat promotion baru\n" +
      "• */analisis <pertanyaan>* — tanya statistik promosi\n" +
      "• *token* — cek pemakaian token AI\n" +
      "• *batal* — hentikan proses yang sedang berjalan, kapan saja\n\n" +
      "Yuk, mulai sekarang 👇",
    [[{ text: "🎯 PROMOTION", callback_data: "cmd:promotion" }]]
  );
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;

  // v28: whitelist akses opsional - lihat ALLOWED_CHAT_IDS di .env.
  if (!isAllowedChat(chatId)) {
    console.warn(`🔒 Chat ${chatId} ditolak (tidak ada di ALLOWED_CHAT_IDS).`);
    return;
  }

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
      await send(chatId, `❌ ${friendlyError(err, "downloadFile")}`);
      userState.delete(chatId);
      return;
    }

    // v28: validasi jumlah baris SEBELUM dikirim ke AI - mencegah file
    // raksasa memicu biaya token besar atau proses hang lama.
    try {
      const XLSX = require("xlsx");
      const wb = XLSX.readFile(filePath);
      const firstSheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: "" });
      if (rows.length > MAX_EXCEL_ROWS) {
        await send(
          chatId,
          `❌ File Excel kamu berisi ${rows.length} baris data, melebihi batas maksimal ${MAX_EXCEL_ROWS} baris per proses.\n\n` +
            `Silakan pecah jadi beberapa file lebih kecil, lalu upload satu per satu.`
        );
        fs.unlink(filePath, () => {});
        userState.delete(chatId);
        return;
      }
    } catch (err) {
      // kalau gagal membaca (mis. file corrupt) - biarkan lolos ke
      // finalizeImportExcel yang punya validasi & pesan error sendiri.
      console.warn("⚠️ Gagal cek jumlah baris Excel sebelum proses:", err.message);
    }

    await withBusyLock(chatId, () => runImportAndReport(chatId, filePath));
    return;
  }

  if (!msg.text) return;
  const raw = msg.text.trim();
  const text = raw.toLowerCase();

  const mode = userState.get(chatId);

  // ==================== v27: GLOBAL ESCAPE HATCH ====================
  // Berfungsi kapan saja user sedang di tengah sebuah flow (state apa
  // pun selain kosong), supaya user awam selalu punya jalan keluar
  // yang gampang diingat tanpa harus tahu tombol/step spesifik.
  if (/^(batal|cancel|stop)$/i.test(raw) && mode) {
    cancelAfterFlag(chatId); // aman dipanggil walau tidak ada pending flag
    resetAllSessions(chatId);
    await send(chatId, "🛑 Proses dibatalkan.\n\nKetik */promotion* kalau mau mulai lagi.");
    return;
  }
  // ==================== AKHIR ESCAPE HATCH ====================

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
    await withBusyLock(chatId, () => startPromotionFlow(chatId));
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
      await withTimeout(ensureLoggedIn(), EXTERNAL_CALL_TIMEOUT_MS, "login GuestPro");
    } catch (err) {
      await send(chatId, `❌ ${friendlyError(err, "ensureLoggedIn/analisis")}`);
      return;
    }

    await send(chatId, "Baik, mohon ditunggu...");
    await showTyping(chatId);

    const processId = `${chatId}-${Date.now()}`;

    await withBusyLock(chatId, async () => {
      try {
        const answer = await withTimeout(
          answerPromotionQuestion({ chatId, processId, question }),
          EXTERNAL_CALL_TIMEOUT_MS,
          "analisis AI"
        );
        await sendLong(chatId, answer);
      } catch (err) {
        await send(chatId, `❌ ${friendlyError(err, "answerPromotionQuestion")}`);
      }
    });
    return;
  }
  // ==================== AKHIR COMMAND /analisis ====================

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

    // v27: dulu langsung runFinalizeAndReport - sekarang mampir dulu
    // ke layar konfirmasi akhir supaya user sempat cek datanya.
    if (result.done && result.data) {
      await askFinalConfirmation(chatId, result.data, "manual", () => {
        resetManualSession(manualSessions, chatId);
      });
    }
    return;
  }

  if (mode === "qna_flow") {
    try {
      const result = await handleQnAMessage(chatId, raw);

      if (result.done && result.data) {
        await askFinalConfirmation(chatId, result.data, "qna", () => {
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
      await send(chatId, `❌ ${friendlyError(err, "qna_flow")}`);
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

  if (mode === "final_confirm_flow") {
    await send(chatId, "Silakan pilih salah satu tombol di atas dulu (Buat / Ubah / Batal), atau ketik *batal* untuk keluar.");
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

  // v28: whitelist akses opsional - lihat ALLOWED_CHAT_IDS di .env.
  if (!isAllowedChat(chatId)) {
    console.warn(`🔒 Chat ${chatId} ditolak (tidak ada di ALLOWED_CHAT_IDS).`);
    try { await bot.answerCallbackQuery(query.id); } catch (_) {}
    return;
  }

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

  // ==================== v27: KONFIRMASI AKHIR SEBELUM SUBMIT ====================
  if (data && data.startsWith("final_confirm:")) {
    const pending = pendingSubmissions.get(chatId);

    if (!pending) {
      await editButtons(chatId, messageId, "❌ Sesi konfirmasi sudah kadaluarsa. Ketik */promotion* untuk mulai lagi.", null);
      userState.delete(chatId);
      return;
    }

    if (data === "final_confirm:no") {
      pendingSubmissions.delete(chatId);
      await editButtons(chatId, messageId, "❌ Dibatalkan. Data tidak jadi dibuat.", null);
      resetAllSessions(chatId);
      return;
    }

    if (data === "final_confirm:edit") {
      pendingSubmissions.delete(chatId);
      await editButtons(chatId, messageId, "✏️ Baik, mari ulangi pengisian datanya:", null);
      if (pending.sourceFlow === "qna") {
        userState.set(chatId, "qna_flow");
        const firstPrompt = startQnA(chatId);
        await send(chatId, firstPrompt);
      } else {
        userState.set(chatId, "manual_flow");
        const start = startManualSubmode(manualSessions, chatId);
        await sendButtons(chatId, start.text, start.keyboard);
      }
      return;
    }

    if (data === "final_confirm:yes") {
      // v28: hapus dari pendingSubmissions SEBELUM proses apa pun -
      // kalau user sempat tap dua kali, tap kedua tidak akan menemukan
      // "pending" lagi (sudah masuk cabang di atas: "sesi kadaluarsa").
      // Ditambah busy-lock sebagai lapisan kedua untuk jaga-jaga.
      pendingSubmissions.delete(chatId);
      if (isChatBusy(chatId)) {
        await bot.answerCallbackQuery(query.id, { text: "Masih diproses, mohon tunggu...", show_alert: false }).catch(() => {});
        return;
      }
      progressMessages.set(chatId, messageId);
      await editButtons(chatId, messageId, "⏳ Membuat promotion...", null);
      await withBusyLock(chatId, () => runFinalizeAndReport(chatId, pending.finalData, pending.onDoneCleanup));
      userState.delete(chatId);
      return;
    }

    return;
  }
  // ==================== AKHIR KONFIRMASI AKHIR ====================

  if (data && data.startsWith("flag_continue:")) {
    if (isChatBusy(chatId)) {
      await bot.answerCallbackQuery(query.id, { text: "Masih diproses, mohon tunggu...", show_alert: false }).catch(() => {});
      return;
    }
    progressMessages.set(chatId, messageId);
    await editButtons(chatId, messageId, "⏳ Memproses konfirmasi kamu...", null);
    await withBusyLock(chatId, async () => {
      try {
        const outcome = await withTimeout(forceCreateAfterFlag(chatId), EXTERNAL_CALL_TIMEOUT_MS, "konfirmasi flag");
        logAudit({ chatId, action: "force_create_after_flag", ok: !outcome?.error, outcome: outcome?.type || null });
        await reportForceOutcome(chatId, outcome);
      } catch (err) {
        await updateProgress(chatId, `❌ ${friendlyError(err, "forceCreateAfterFlag")}`, CONTINUE_KEYBOARD);
        clearProgress(chatId);
      }
    });
    resetAllSessions(chatId);
    return;
  }

  if (data && data.startsWith("flag_cancel:")) {
    cancelAfterFlag(chatId);
    await editButtons(chatId, messageId, "❌ Dibatalkan.", null);
    resetAllSessions(chatId);
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
      await askFinalConfirmation(chatId, result.data, "manual", () => {
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
        await askFinalConfirmation(chatId, result.data, "qna", () => {
          resetQnASession(chatId);
        });
        return;
      }

      await editButtons(chatId, messageId, result.reply, result.keyboard);
    } catch (err) {
      await send(chatId, `❌ ${friendlyError(err, "qna_flow callback")}`);
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

const server = app.listen(PORT, async () => {
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

// v28: graceful shutdown - kalau proses di-kill (mis. saat deploy
// ulang lewat PM2), tunggu maksimal beberapa detik supaya chat yang
// sedang diproses (busyChats) sempat selesai dulu sebelum server
// benar-benar berhenti menerima koneksi baru.
async function gracefulShutdown(signal) {
  console.log(`\n🛑 Menerima ${signal} - memulai graceful shutdown...`);
  server.close(() => console.log("🔌 HTTP server berhenti menerima koneksi baru."));

  const maxWaitMs = 15000;
  const start = Date.now();
  while (busyChats.size > 0 && Date.now() - start < maxWaitMs) {
    console.log(`⏳ Menunggu ${busyChats.size} proses aktif selesai...`);
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log("👋 Hermes berhenti.");
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));