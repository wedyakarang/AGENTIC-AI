// // ======================================
// // API MONITOR
// // Mencatat jumlah panggilan ke GuestPro API per endpoint, durasi,
// // dan status (sukses/gagal). Direset otomatis tiap login baru
// // (dipanggil dari ensureLoggedIn() di indexx.js), jadi statistiknya
// // per-sesi, bukan menumpuk selamanya.
// // ======================================

// let stats = {};

// function resetStats() {
//   stats = {};
// }

// function recordCall(endpoint, { durationMs, success }) {
//   if (!stats[endpoint]) {
//     stats[endpoint] = { total: 0, success: 0, failed: 0, totalDurationMs: 0 };
//   }
//   stats[endpoint].total += 1;
//   if (success) stats[endpoint].success += 1;
//   else stats[endpoint].failed += 1;
//   stats[endpoint].totalDurationMs += durationMs;
// }

// function getStats() {
//   return stats;
// }

// function formatStatsSummary() {
//   const endpoints = Object.keys(stats);
//   if (endpoints.length === 0) return "📊 Belum ada request API GuestPro tercatat di sesi ini.";

//   const lines = endpoints.map((ep) => {
//     const s = stats[ep];
//     const avg = s.total > 0 ? Math.round(s.totalDurationMs / s.total) : 0;
//     return `• ${ep}: ${s.total}x (✅${s.success} ❌${s.failed}), rata-rata ${avg}ms`;
//   });

//   const totalCalls = endpoints.reduce((sum, ep) => sum + stats[ep].total, 0);

//   return `📊 *STATISTIK PANGGILAN API GUESTPRO*\nTotal request: ${totalCalls}\n\n${lines.join("\n")}`;
// }

// module.exports = {
//   resetStats,
//   recordCall,
//   getStats,
//   formatStatsSummary,
// };

// ======================================
// API MONITOR
// Mencatat jumlah panggilan ke GuestPro API per endpoint, durasi,
// dan status (sukses/gagal).
//
// resetStats() dipanggil di 2 tempat:
//   1. ensureLoggedIn() (indexxx.js) - saat login manual baru terjadi
//   2. runFinalizeAndReport() / runImportAndReport() (telegram3.js) -
//      di AWAL SETIAP PROSES create promotion / import excel
// Karena #2 terjadi di awal tiap proses, statistik yang ditampilkan
// via formatStatsSummary() di akhir proses OTOMATIS murni statistik
// proses itu saja (GET + POST) - tidak perlu mekanisme snapshot/diff
// terpisah.
//
// UPDATE: recordCall() sekarang menerima flag `cached` - dipakai oleh
// resolv.js supaya GET yang datanya diambil dari cache (bukan fetch
// API baru) TETAP tercatat sebagai "dipakai" di statistik, bukan
// hilang begitu saja hanya karena tidak ada request HTTP baru yang
// terjadi.
// ======================================

// ======================================
// API MONITOR
// Mencatat jumlah panggilan ke GuestPro API per endpoint, durasi,
// dan status (sukses/gagal).
//
// resetStats() dipanggil di 2 tempat:
//   1. ensureLoggedIn() (indexxx.js) - saat login manual baru terjadi
//   2. runFinalizeAndReport() / runImportAndReport() (telegram3.js) -
//      di AWAL SETIAP PROSES create promotion / import excel (baik
//      1 data manual, maupun 1 BATCH Excel berisi banyak baris)
// Karena #2 terjadi di awal tiap proses, statistik yang ditampilkan
// via formatStatsSummary() di akhir proses OTOMATIS murni statistik
// proses itu saja.
//
// recordCall(endpoint, opts) - mencatat SETIAP panggilan apa adanya,
// dipakai untuk POST (harus 1:1 dengan jumlah data yang diproses -
// 5 baris Excel = 5x POST, TIDAK didedup).
//
// recordCallOnce(endpoint, opts) - mencatat endpoint ini HANYA SEKALI
// per proses (per siklus resetStats()), terlepas berapa kali fungsi
// ini dipanggil setelahnya di proses yang sama. Dipakai untuk GET
// resolver (agent/rate) - supaya Import Excel 5 baris yang
// masing-masing "memakai" data agent/rate yang sama tetap tercatat
// 1x GET per endpoint per proses, bukan 5x, walau resolv.js memanggil
// getAgentList()/getRoomRateList() sekali per baris.
// ======================================

let stats = {};
let recordedOnceKeys = new Set();

function resetStats() {
  stats = {};
  recordedOnceKeys = new Set();
}

function recordCall(endpoint, { durationMs = 0, success = true, cached = false } = {}) {
  if (!stats[endpoint]) {
    stats[endpoint] = {
      total: 0,
      success: 0,
      failed: 0,
      totalDurationMs: 0, // hanya diisi dari fresh call, biar rata-rata akurat
      fresh: 0,
      cached: 0,
    };
  }

  const s = stats[endpoint];
  s.total += 1;
  if (success) s.success += 1;
  else s.failed += 1;

  if (cached) {
    s.cached += 1;
  } else {
    s.fresh += 1;
    s.totalDurationMs += durationMs;
  }
}

// Sekali per proses (per siklus resetStats()) untuk endpoint ini -
// panggilan ke-2, ke-3, dst dalam proses yang sama diabaikan.
function recordCallOnce(endpoint, opts) {
  if (recordedOnceKeys.has(endpoint)) return;
  recordedOnceKeys.add(endpoint);
  recordCall(endpoint, opts);
}

function getStats() {
  return stats;
}

function formatStatsSummary() {
  const endpoints = Object.keys(stats);
  if (endpoints.length === 0) return "📊 Belum ada request API GuestPro tercatat di proses ini.";

  const lines = endpoints.map((ep) => {
    const s = stats[ep];
    const avg = s.fresh > 0 ? Math.round(s.totalDurationMs / s.fresh) : 0;

    let detail = `${s.total}x (✅${s.success} ❌${s.failed})`;
    if (s.cached > 0) {
      detail += ` — ${s.fresh} fetch baru, ${s.cached} dari cache`;
    }
    detail += s.fresh > 0 ? `, rata-rata ${avg}ms` : ``;

    return `• ${ep}: ${detail}`;
  });

  const totalCalls = endpoints.reduce((sum, ep) => sum + stats[ep].total, 0);

  return `📊 *STATISTIK PANGGILAN API GUESTPRO*\nTotal request: ${totalCalls}\n\n${lines.join("\n")}`;
}

module.exports = {
  resetStats,
  recordCall,
  recordCallOnce,
  getStats,
  formatStatsSummary,
};