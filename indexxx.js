// ======================================
// TOOL LAYER
// ======================================

const { loginManual, clearSession, isSessionValid, getAuthState, getSessionRemainingDays } = require("./auth");
const { createPromotionWithRetry } = require("./promotionAPI");
const { clearResolverCache } = require("./resolv");
const { resetStats } = require("./monitor");

async function ensureLoggedIn() {
  if (await isSessionValid()) {
    const auth = getAuthState();
    const remainingDays = getSessionRemainingDays();

    console.log(
      `♻️ Session lama masih valid (dikonfirmasi server, estimasi sisa ${remainingDays} hari) - pakai token tersimpan, tidak login ulang.`
    );

    return {
      ok: true,
      message: `Session masih aktif, tidak perlu login ulang (estimasi sisa ${remainingDays} hari). Selamat datang!`,
      merchantId: auth.merchantId,
      reused: true,
    };
  }

  console.log("🔒 Session tidak ada / ditolak server - perlu login manual ulang.");

  clearSession();        // hapus session lama -> paksa login manual ulang
  clearResolverCache();  // hapus cache daftar agent/rate sesi sebelumnya
  resetStats();          // mulai hitungan statistik API dari nol

  const auth = await loginManual();
  return { ok: true, message: "Login berhasil", merchantId: auth.merchantId, reused: false };
}

async function createPromotionTool(data) {
  const result = await createPromotionWithRetry(data);

  if (result.ok) {
    return { ok: true, promotionId: result.id };
  }

  // ALASAN GAGAL ASLINYA - ini yang paling penting, selalu ada isinya
  // (baik dari validasi, dari exception resolveAgentId/resolveRoomRateIds,
  // maupun dari response error server GuestPro).
  console.log(`❌ GAGAL - Nama: ${data?.nama || "-"} | Alasan: ${result.message}`);

  // Detail teknis tambahan HANYA di-print kalau memang ada isinya
  // (kalau gagal sebelum sempat bikin payload/kirim request, dua hal
  // ini memang tidak akan pernah ada - itu WAJAR, bukan bug).
  if (result.rawResponse !== undefined) {
    console.log("RAW RESPONSE API:", JSON.stringify(result.rawResponse, null, 2));
  }
  if (result.payloadSent !== undefined) {
    console.log("PAYLOAD TERKIRIM:", JSON.stringify(result.payloadSent, null, 2));
  }

  return {
    ok: false,
    reason: result.validationErrors
      ? result.validationErrors.join("; ")
      : result.message,
  };
}

module.exports = {
  ensureLoggedIn,
  createPromotionTool,
};

