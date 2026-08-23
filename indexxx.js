// ======================================
// TOOL LAYER
// createPromotionTool() mengembalikan object KECIL ke pemanggil
// (ok, promotionId, reason) - detail teknis lengkap (payload, response
// mentah) di-log ke console saja untuk debugging, tidak dikirim ke LLM.
//
// ensureLoggedIn(): cek dulu apakah session lama MASIH VALID - BUKAN
// lagi dengan menebak umur token sendiri, tapi isSessionValid() di
// auth.js benar-benar tanya ke server GuestPro (endpoint curent-user-get).
// Kalau server bilang valid -> pakai token lama langsung, TANPA buka
// browser, TANPA hapus cache/statistik. Kalau server bilang token
// ditolak (401/403) -> BARU clearSession() (hapus session lama + cache
// + statistik) lalu loginManual() untuk sesi baru.
//
// getSessionRemainingDays() yang dipakai di sini HANYA estimasi buat
// ditampilkan ke user (asumsi umur token 90 hari) - bukan lagi acuan
// valid/tidaknya session itu sendiri. Kalau GuestPro suatu saat ubah
// durasi token, angka "sisa X hari" ini bisa saja meleset, tapi
// isSessionValid() tetap benar karena divalidasi langsung ke server.
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

// ======================================
// CONTOH PEMAKAIAN (referensi, tidak dieksekusi)
// ======================================
//
// const { ensureLoggedIn, createPromotionTool } = require("./indexx");
//
// async function contoh() {
//   await ensureLoggedIn();
//
//   const data = {
//     nama: "Diskon Lebaran",
//     namaID: "Diskon Lebaran",
//     type: "PROMO CODE",
//     promoCodes: [{ kode: "LEBARAN10", maxUsed: 5 }],
//     group: "SUKSMA",
//     agent: "",
//     description: "Diskon spesial",
//     descriptionID: "Diskon spesial",
//     rates: [{ category: null, rate: "Deluxe Room" }],
//     formulas: [{ formula: "DECREASE", formulaType: "PERCENT", value: 10 }],
//     minimumNight: 2,
//   };
//
//   const result = await createPromotionTool(data);
//   console.log(result);
// }