// ==========================================================
// PENDING FLAGS - Penyimpanan sementara promotion yang di-flag AI
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