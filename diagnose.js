// ======================================
// SCRIPT DIAGNOSA KECEPATAN
// Jalankan file Excel yang SAMA (15 baris) dua kali:
//   1) Dengan CONCURRENCY_LIMIT = 1 (baseline sequential)
//   2) Dengan CONCURRENCY_LIMIT = 15 (full paralel)
// Lalu bandingkan waktunya di sini.
//
// CARA PAKAI:
//   node diagnose.js path/ke/file.xlsx
//
// PENTING: networkConfig.js WAJIB di-require PALING ATAS di sini juga
// (bukan cuma di telegram2.js) supaya limit koneksi yang dinaikkan
// benar-benar aktif saat diagnose.js dijalankan sendiri/terpisah.
// ======================================

require("./networkConfig"); // <-- WAJIB PALING ATAS, sebelum require lain

const path = require("path");
const { getStats, resetStats } = require("./GUESTPRO/apiMonitor");

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.log("Pakai: node diagnose.js path/ke/file.xlsx");
    process.exit(1);
  }

  const { ensureLoggedIn } = require("./GUESTPRO/indexx");
  console.log("🔐 Login dulu...");
  await ensureLoggedIn();

  // Import excell.js SETELAH login supaya cache token dkk sudah siap
  delete require.cache[require.resolve("./GUESTPRO/excell")];
  const { processExcelImport, formatImportSummary } = require("./GUESTPRO/excell");

  console.log("\n🚀 Mulai proses...");
  const startTime = Date.now();

  const result = await processExcelImport(filePath);

  const totalDurationMs = Date.now() - startTime;
  const stats = getStats();

  // ============================================
  // RINGKASAN PER-BARIS (biar kelihatan baris mana
  // yang gagal dan ALASAN aslinya, bukan cuma statistik).
  // ============================================
  console.log("\n" + formatImportSummary(result.results).replace(/\*/g, ""));

  console.log("\n===== HASIL DIAGNOSA =====");
  console.log(`Total baris diproses : ${result.results.length}`);
  console.log(`Waktu TOTAL nyata    : ${totalDurationMs}ms (${(totalDurationMs / 1000).toFixed(1)} detik)`);

  for (const [endpoint, s] of Object.entries(stats)) {
    if (endpoint.includes("CREATE_PROMOTION") || endpoint.includes("create-promotion") || endpoint.includes("promotion")) {
      const avg = s.total > 0 ? Math.round(s.totalDurationMs / s.total) : 0;
      const predictedSerial = avg * s.total;
      console.log(`\nEndpoint: ${endpoint}`);
      console.log(`  Jumlah request      : ${s.total}`);
      console.log(`  Rata-rata per request: ${avg}ms`);
      console.log(`  Prediksi KALAU SERIAL: ${predictedSerial}ms (${(predictedSerial / 1000).toFixed(1)} detik)`);

      const ratio = totalDurationMs / predictedSerial;
      console.log(`\n  Rasio (nyata / prediksi serial): ${(ratio * 100).toFixed(0)}%`);

      if (ratio > 0.85) {
        console.log("  ⚠️ KESIMPULAN: Waktu nyata HAMPIR SAMA dengan prediksi serial.");
        console.log("     -> Server GuestPro kemungkinan besar MEMPROSES REQUEST SECARA SERIAL");
        console.log("        di baliknya, TIDAK PEDULI berapa CONCURRENCY_LIMIT di sisi kita.");
        console.log("     -> Naikkan CONCURRENCY_LIMIT TIDAK AKAN banyak membantu.");
      } else if (ratio < 0.5) {
        console.log("  ✅ KESIMPULAN: Waktu nyata JAUH lebih cepat dari prediksi serial.");
        console.log("     -> Paralelisasi BEKERJA. Server bisa proses beberapa request bersamaan.");
        console.log("     -> Kalau masih mau lebih cepat, coba naikkan CONCURRENCY_LIMIT sedikit lagi.");
      } else {
        console.log("  🤔 KESIMPULAN: Ada SEBAGIAN efek paralel, tapi tidak maksimal.");
        console.log("     -> Server mungkin punya batas concurrent request tertentu");
        console.log("        (lebih dari 1, tapi kurang dari CONCURRENCY_LIMIT yang dipakai).");
      }
    }
  }

  console.log("\n===========================");
}

main().catch((err) => {
  console.error("❌ ERROR:", err.message);
  process.exit(1);
});