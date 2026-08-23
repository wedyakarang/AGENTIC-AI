// ======================================
// TELEGRAM HERMES - GUESTPRO PROMOTION AUTOMATION
// Pengganti bot WhatsApp. Menggabungkan:
//   - browser.js   -> buka GuestPro, biar user login manual dulu
//   - isi.js       -> isiPromotion(page, data), support multi promo
//                      code & multi formula
//   - paser.js     -> handlePromotionMessage(), flow tanya-jawab
//                      multi-turn untuk mode MANUAL
//   - excel.js     -> processExcelImport(), untuk mode IMPORT
//
// CATATAN: browser (Playwright page) dipakai BERSAMA oleh semua chat
// (single shared browser, sama seperti kode lama kamu yang cuma punya
// satu `promotionData` global). Kalau nanti mau multi-user paralel,
// perlu 1 page terpisah per chatId - belum diimplementasikan di sini.
//
// FIX (versi ini):
// Download file Excel sebelumnya pakai bot.downloadFile() lalu MENEBAK
// file mana yang barusan masuk dengan cara mengambil file dengan mtime
// paling baru di folder ./uploads. Ini race condition: kalau ada 2 chat
// yang kirim file Excel hampir bersamaan, file bisa ketuker antar user
// (chat A bisa memproses file milik chat B). Sekarang file di-download
// LANGSUNG ke path tujuan yang sudah pasti unik per-chat (berbasis
// getFileLink + fetc h), tanpa perlu menebak file mana yang paling baru.
//
// FIX (versi ini juga):
// Saat pilih "Manual", teks yang dikirim sekarang menanyakan submode
// Template / Satu per satu (bukan langsung minta kirim template),
// karena parser.js sekarang punya step CHOOSE_SUBMODE di awal.
// ======================================
require("dotenv").config();
const path = require("path");
const fs = require("fs");
const TelegramBot = require("node-telegram-bot-api");

const { openGuestPro } = require("./browser");           // harus return { page }
const { isiPromotion } = require("./tools/isi");
const { handlePromotionMessage, createEmptySession } = require("./tools/parser");
const { processExcelImport, formatImportSummary } = require("./tools/excel");

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

const UPLOAD_DIR = "./uploads";
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ======================================
// STATE GLOBAL
// ======================================
let page = null;        // Playwright page, di-set setelah openGuestPro()
let loggedIn = false;    // gate login manual sebelum bisa isi promosi

// modeStore: chatId -> "choose_mode" | "manual" | "import_wait_file"
const modeStore = new Map();
// promotionSessionStore: chatId -> session dari parser.js (khusus mode manual)
const promotionSessionStore = new Map();

// ======================================
// HELPER KIRIM PESAN (biar gampang dipanggil dari mana saja)
// ======================================
function send(chatId, text) {
  return bot.sendMessage(chatId, text);
}

// ======================================
// HELPER (BARU): DOWNLOAD FILE TELEGRAM LANGSUNG KE PATH TUJUAN
// Menggantikan bot.downloadFile() + tebak-mtime-terbaru yang rawan
// race condition kalau ada beberapa chat upload file bersamaan.
// ======================================
async function downloadTelegramFileTo(fileId, destPath) {
  const fileLink = await bot.getFileLink(fileId); // URL file di server Telegram
  const response = await fetch(fileLink);
  if (!response.ok) {
    throw new Error(`Gagal download file dari Telegram (HTTP ${response.status})`);
  }
  const arrayBuffer = await response.arrayBuffer();
  await fs.promises.writeFile(destPath, Buffer.from(arrayBuffer));
}

// ======================================
// HANDLER PESAN TEKS
// ======================================
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;

  // ---------- FILE / DOCUMENT (untuk mode Import) ----------
  if (msg.document) {
    if (modeStore.get(chatId) !== "import_wait_file") {
      return; // file dikirim di luar konteks import, abaikan
    }

    const fileName = msg.document.file_name || "";
    if (!/\.xlsx?$/i.test(fileName)) {
      await send(chatId, "File yang dikirim bukan Excel (.xlsx). Coba kirim ulang ya.");
      return;
    }

    if (!page) {
      await send(chatId, "❌ Browser belum dibuka. Ketik PROMOTION dulu lalu login.");
      modeStore.delete(chatId);
      return;
    }

    // Path unik per-chat + timestamp, ditentukan dari awal (tidak ditebak
    // dari isi folder), jadi tidak akan ketuker dengan upload chat lain.
    const localPath = path.join(UPLOAD_DIR, `${chatId}-${Date.now()}.xlsx`);

    try {
      await downloadTelegramFileTo(msg.document.file_id, localPath);

      await send(chatId, "📥 File diterima, memproses semua data promosi satu per satu. Mohon tunggu...");

      const importResult = await processExcelImport(page, localPath);
      if (importResult.status === "error") {
        await send(chatId, "❌ " + importResult.message);
      } else {
        await send(chatId, formatImportSummary(importResult.results));
      }
    } catch (err) {
      await send(chatId, "❌ Terjadi error saat memproses file: " + err.message);
    } finally {
      fs.unlink(localPath, () => {});
      modeStore.delete(chatId);
    }
    return;
  }

  if (!msg.text) return;

  const raw = msg.text.trim();
  const text = raw.toLowerCase();

  // ======================================
  // PROMOTION - buka browser & minta login manual
  // ======================================
  if (text === "promotion") {
    try {
      const opened = await openGuestPro();
      page = opened.page;
      loggedIn = false;
      modeStore.delete(chatId);
      promotionSessionStore.delete(chatId);

      await send(chatId, "🌐 GuestPro dibuka.\n\nSilakan login manual.\nJika sudah login ketik:\nSUDAH");
    } catch (e) {
      await send(chatId, "❌ Gagal membuka browser: " + e.message);
    }
    return;
  }

  // ======================================
  // SUDAH - login selesai, lanjut pilih mode
  // ======================================
  if (text === "sudah") {
    if (!page) {
      await send(chatId, "❌ Browser belum dibuka. Ketik PROMOTION dulu.");
      return;
    }
    loggedIn = true;
    modeStore.set(chatId, "choose_mode");

    await send(
      chatId,
      "✅ Login diterima.\n\n" +
      "Mau isi data promosi *Manual* atau *Import* dari Excel?\n" +
      "Ketik: Manual  atau  Import"
    );
    return;
  }

  const mode = modeStore.get(chatId);

  // ======================================
  // PILIH MODE: MANUAL / IMPORT
  // ======================================
  if (mode === "choose_mode") {
    if (text === "manual") {
      modeStore.set(chatId, "manual");
      promotionSessionStore.set(chatId, createEmptySession());
      // FIX: sekarang menanyakan submode (Template / Satu per satu),
      // karena parser.js punya step CHOOSE_SUBMODE di awal session.
      await send(chatId, "Pilih cara input:\n1. Template\n2. Satu per satu");
      return;
    }
    if (text === "import") {
      modeStore.set(chatId, "import_wait_file");
      await send(chatId, "Oke, silakan kirim file Excel-nya sekarang (.xlsx).");
      return;
    }
    await send(chatId, "Mohon jawab *Manual* atau *Import* saja ya.");
    return;
  }

  // ======================================
  // MODE MANUAL - delegasikan ke parser.js (multi-turn: pilih submode,
  // isi field, multi promo code, multi formula, sampai ready_to_execute)
  // ======================================
  if (mode === "manual") {
    if (!loggedIn || !page) {
      await send(chatId, "❌ Browser belum siap. Ketik PROMOTION dulu lalu login.");
      return;
    }

    const result = handlePromotionMessage(promotionSessionStore, chatId, raw);

    if (result.status === "ready_to_execute") {
      await send(chatId, "🚀 Mulai mengisi Promotion...");
      try {
        const execResult = await isiPromotion(page, result.data);
        await send(
          chatId,
          `✅ SELESAI\n\n${execResult.message}\n\n🔗 LINK:\n${execResult.url || "-"}`
        );
      } catch (e) {
        await send(chatId, `❌ ERROR\n${e.message}`);
      } finally {
        modeStore.delete(chatId);
        promotionSessionStore.delete(chatId);
      }
      return;
    }

    await send(chatId, result.message);
    return;
  }

  if (mode === "import_wait_file") {
    await send(chatId, "Menunggu file Excel (.xlsx). Silakan kirim filenya.");
    return;
  }

  // ======================================
  // FALLBACK
  // ======================================
  await send(chatId, "Perintah tidak dikenal. Ketik PROMOTION untuk mulai.");
});

console.log("🤖 Telegram Hermes Running");