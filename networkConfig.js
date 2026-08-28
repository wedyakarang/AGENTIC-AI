// ======================================
// NETWORK CONFIG — Naikkan limit koneksi bersamaan untuk fetch()
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