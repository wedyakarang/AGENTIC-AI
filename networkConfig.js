// ======================================
// NETWORK CONFIG — Naikkan limit koneksi bersamaan untuk fetch()
// ======================================
//
// MASALAH: Node.js fetch() bawaan (via undici) punya batas default
// jumlah koneksi BERSAMAAN ke 1 origin/domain yang sama (defaultnya
// kecil, sekitar 6). Jadi walau kode kita kirim 15 request sekaligus
// (CONCURRENCY_LIMIT = 15 di excell.js), Node sendiri cuma benar-benar
// membuka beberapa koneksi dulu — sisanya ANTRE nunggu slot kosong,
// bukan benar-benar jalan bersamaan.
//
// SOLUSI: Buat instance undici Agent dengan limit lebih tinggi, lalu
// jadikan itu "dispatcher" default untuk SEMUA fetch() di seluruh
// aplikasi (lewat setGlobalDispatcher). File ini WAJIB di-require
// PALING ATAS, SEBELUM file lain yang pakai fetch() dipanggil.
//
// CARA PAKAI: tambahkan baris ini di paling atas telegram2.js,
// SEBELUM require lain:
//     require("./networkConfig");
// ======================================

const { Agent, setGlobalDispatcher } = require("undici");

// Naikkan sesuai CONCURRENCY_LIMIT yang dipakai di excell.js, kasih
// sedikit buffer ekstra (misal +5) untuk jaga-jaga ada request lain
// yang jalan bersamaan (resolveAgentId, resolveRoomRateIds, dll).
const MAX_CONCURRENT_CONNECTIONS = 20;

const agent = new Agent({
  connections: MAX_CONCURRENT_CONNECTIONS, // jumlah koneksi bersamaan PER ORIGIN
  keepAliveTimeout: 10_000, // koneksi idle ditutup setelah 10 detik
  keepAliveMaxTimeout: 30_000,
});

setGlobalDispatcher(agent);

console.log(`🔧 Network config aktif: max ${MAX_CONCURRENT_CONNECTIONS} koneksi bersamaan per server.`);

module.exports = agent;