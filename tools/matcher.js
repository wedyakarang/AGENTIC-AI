// ======================================
// MATCHER
// Fuzzy string matching ringan, TANPA dependency eksternal (murni JS,
// tidak perlu npm install apa pun).
//
// Dipakai resolv.js untuk mencocokkan nama rate/agent yang diketik user
// secara bebas (typo, singkatan, sebagian nama) terhadap daftar resmi
// dari API GuestPro - SEBELUM (dan supaya TIDAK PERLU) melempar ke LLM.
//
// LLM baru dipanggil kalau hasil fuzzy match di sini benar-benar ambigu
// (skor mepet / ada lebih dari satu kandidat yang sama-sama kuat).
// Taruh file ini di folder tools/ (sejajar dengan tokenMonitor.js).
// ======================================

function levenshtein(a, b) {
  a = String(a);
  b = String(b);
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;

  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] =
        a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

// Skor 0..1 (1 = identik). Substring match dikasih bonus besar karena
// user sering ngetik singkatan/sebagian nama saja (mis. "DUO" utk "DUO Santai").
function similarity(query, candidate) {
  const q = String(query || "").trim().toLowerCase();
  const c = String(candidate || "").trim().toLowerCase();
  if (!q || !c) return 0;
  if (q === c) return 1;

  if (c.includes(q) || q.includes(c)) {
    const longer = Math.max(q.length, c.length);
    const shorter = Math.min(q.length, c.length);
    return 0.85 + 0.15 * (shorter / longer); // 0.85 - 1.0
  }

  const dist = levenshtein(q, c);
  const maxLen = Math.max(q.length, c.length);
  return maxLen === 0 ? 0 : 1 - dist / maxLen;
}

/**
 * Cari kandidat terbaik dari daftar objek.
 *
 * @param {string} query - teks yang diketik user
 * @param {Array<object>} items - daftar kandidat (mis. hasil getAgentList())
 * @param {string} key - nama field yang dibandingkan (default "name")
 * @param {object} opts
 * @param {number} opts.autoThreshold - skor minimal utk auto-resolve TANPA LLM (default 0.92)
 * @param {number} opts.marginNeeded - selisih minimal vs kandidat ke-2 utk auto-resolve (default 0.08)
 * @param {number} opts.candidateThreshold - skor minimal utk masuk daftar kandidat ambigu (default 0.55)
 * @param {number} opts.limit - maksimal kandidat ambigu yang dikembalikan ke LLM (default 5)
 *
 * @returns {{status: "resolved"|"ambiguous"|"not_found", best: object|null, candidates: object[]}}
 */
function findBestMatches(query, items, key = "name", opts = {}) {
  const {
    autoThreshold = 0.92,
    marginNeeded = 0.08,
    candidateThreshold = 0.55,
    limit = 5,
  } = opts;

  const scored = items
    .map((item) => ({ item, score: similarity(query, item[key]) }))
    .filter((x) => x.score >= candidateThreshold)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return { status: "not_found", best: null, candidates: [] };
  }

  const best = scored[0];
  const secondScore = scored[1] ? scored[1].score : 0;

  // Auto-resolve kalau skor tinggi DAN cukup jauh di atas kandidat ke-2
  // (menghindari auto-pilih salah waktu ada 2 nama yang sama-sama mirip,
  // misal "DUO Santai" vs "DUO Standard").
  if (best.score >= autoThreshold && best.score - secondScore >= marginNeeded) {
    return { status: "resolved", best: best.item, candidates: [] };
  }

  return {
    status: "ambiguous",
    best: null,
    candidates: scored.slice(0, limit).map((x) => x.item),
  };
}

module.exports = { similarity, findBestMatches, levenshtein };