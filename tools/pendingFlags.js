// ==========================================================
// PENDING FLAGS - Penyimpanan sementara promotion yang di-flag AI
// ==========================================================
// Menyimpan payload APA ADANYA (bukan destructuring field spesifik),
// supaya field milik jalur "manual" (finalData, flagReason,
// flagSeverity) maupun jalur "import" (type, rows, flaggedDetails,
// filePath) sama-sama tersimpan utuh tanpa ada yang hilang diam-diam.
//
// In-memory (Map), keyed by chatId, dengan auto-expire (lazy check,
// dicek saat diakses, bukan timer background) — cukup untuk 1 sesi
// berjalan bot karena user diharapkan merespons dalam hitungan menit.
//
// Tambahan: dumpPendingFlagsToFile() untuk lihat isi Map saat ini
// lewat file, dipicu manual (misal command /debugflags di Telegram).
// ==========================================================

const fs = require('fs');
const path = require('path');

const PENDING_TTL_MS = 30 * 60 * 1000; // 30 menit

const pending = new Map(); // chatId(string) -> { ...payload, expiresAt }

function setPendingFlag(chatId, payload) {
  pending.set(String(chatId), {
    ...payload,
    expiresAt: Date.now() + PENDING_TTL_MS
  });
}

function getPendingFlag(chatId) {
  const entry = pending.get(String(chatId));
  if (!entry) return null;

  if (Date.now() > entry.expiresAt) {
    pending.delete(String(chatId));
    return null;
  }

  return entry;
}

function clearPendingFlag(chatId) {
  pending.delete(String(chatId));
}

function dumpPendingFlagsToFile() {
  const folder = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });

  const filePath = path.join(folder, 'pendingFlags-debug.json');

  const snapshot = {};
  for (const [chatId, entry] of pending.entries()) {
    snapshot[chatId] = {
      ...entry,
      expiresAtReadable: new Date(entry.expiresAt).toLocaleString('id-ID'),
      sisaMenit: Math.max(0, Math.round((entry.expiresAt - Date.now()) / 60000))
    };
  }

  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2));
  return { filePath, totalEntries: pending.size };
}

module.exports = {
  setPendingFlag,
  getPendingFlag,
  clearPendingFlag,
  dumpPendingFlagsToFile
};