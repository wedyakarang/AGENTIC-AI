// // ======================================
// // API MONITOR
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