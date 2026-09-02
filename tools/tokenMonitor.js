// ==========================================================
// TOKEN MONITOR - GuestPro Promotion Bot
// ==========================================================

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "tokenUsage.json");


const PRICING = {
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10.0 },
  "gemini-3.5-flash": { input: 1.5, output: 9.0 },
  "gemini-3.6-flash": { input: 1.5, output: 9.0 },
  default: { input: 0.15, output: 0.6 },
};

// BARU — KURS USD -> IDR, dipakai untuk menampilkan estimasi biaya
// dalam Rupiah di samping USD. Bisa di-override lewat .env
// (USD_TO_IDR=16300, misalnya) supaya gampang diupdate manual kalau
// kurs berubah, tanpa perlu ubah kode. Kalau .env tidak diisi/tidak
// valid (bukan angka), fallback ke DEFAULT_USD_TO_IDR di bawah.
const DEFAULT_USD_TO_IDR = 16300;
const USD_TO_IDR = Number(process.env.USD_TO_IDR) > 0 ? Number(process.env.USD_TO_IDR) : DEFAULT_USD_TO_IDR;

function fmtRupiah(usd) {
  const idr = usd * USD_TO_IDR;
  // Biaya per proses biasanya kecil (< Rp1.000) - tampilkan 2 angka
  // di belakang koma supaya tidak semua kelihatan "Rp0" begitu saja,
  // tapi tetap dibulatkan rapi ala format Rupiah Indonesia.
  return `Rp${idr.toLocaleString("id-ID", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ entries: [] }, null, 2));
  }
}

function loadData() {
  ensureDataFile();
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("⚠️ tokenMonitor: gagal baca data, reset ke kosong.", err.message);
    return { entries: [] };
  }
}

function saveData(data) {
  ensureDataFile();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ============================================================
// CATAT 1 PEMAKAIAN TOKEN
// ============================================================
// usage: {
//   prompt_tokens, completion_tokens,
//   thoughts_tokens?, tool_use_prompt_tokens?, cached_tokens?,
//   total_tokens
// }
function recordUsage({ chatId, processId = null, feature = "unknown", model = "default", usage }) {
  if (!usage) {
    console.warn("⚠️ tokenMonitor.recordUsage dipanggil tanpa `usage` - dilewati.");
    return;
  }

  const promptTokens = usage.prompt_tokens || 0;
  const completionTokens = usage.completion_tokens || 0;
  const thoughtsTokens = usage.thoughts_tokens || 0;
  const toolUsePromptTokens = usage.tool_use_prompt_tokens || 0;
  const cachedTokens = usage.cached_tokens || 0;

  const knownSum = promptTokens + completionTokens + thoughtsTokens + toolUsePromptTokens + cachedTokens;
  // Kalau Gemini tidak kasih total_tokens sama sekali, pakai jumlah
  // kategori yang kita tahu. Kalau dikasih tapi lebih besar dari
  // jumlah kategori yang kita tangkap, sisanya dicatat sebagai
  // "otherTokens" - JUJUR ditampilkan, bukan hilang begitu saja.
  const totalTokens = usage.total_tokens || knownSum;
  const otherTokens = Math.max(0, totalTokens - knownSum);

  const data = loadData();
  data.entries.push({
    ts: new Date().toISOString(),
    chatId: chatId ? String(chatId) : null,
    processId: processId ? String(processId) : null,
    feature,
    model,
    promptTokens,
    completionTokens,
    thoughtsTokens,
    toolUsePromptTokens,
    cachedTokens,
    otherTokens,
    totalTokens,
  });
  saveData(data);

  console.log(
    `📊 [tokenMonitor] ${feature} | model=${model} | prompt=${promptTokens} completion=${completionTokens} ` +
      `thoughts=${thoughtsTokens} toolSchema=${toolUsePromptTokens} cached=${cachedTokens} lainnya=${otherTokens} total=${totalTokens}`
  );
}

// ============================================================
// HITUNG ESTIMASI BIAYA (USD) dari entries
// ============================================================
// Prompt (+ tool schema, + cached) ditagih rate input; completion
// (+ thoughts, + lainnya) ditagih rate output - ini asumsi umum
// Gemini, sesuaikan kalau provider/model kamu beda kebijakannya.
function estimateCost(entries) {
  let cost = 0;
  for (const e of entries) {
    const price = PRICING[e.model] || PRICING.default;
    const inputLike = e.promptTokens + (e.toolUsePromptTokens || 0) + (e.cachedTokens || 0);
    const outputLike = e.completionTokens + (e.thoughtsTokens || 0) + (e.otherTokens || 0);
    cost += (inputLike / 1_000_000) * price.input;
    cost += (outputLike / 1_000_000) * price.output;
  }
  return cost;
}

// ============================================================
// FILTER ENTRIES BERDASARKAN PERIODE
// ============================================================
function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function summarize(entries) {
  const totalCalls = entries.length;
  const promptTokens = entries.reduce((s, e) => s + e.promptTokens, 0);
  const completionTokens = entries.reduce((s, e) => s + e.completionTokens, 0);
  const thoughtsTokens = entries.reduce((s, e) => s + (e.thoughtsTokens || 0), 0);
  const toolUsePromptTokens = entries.reduce((s, e) => s + (e.toolUsePromptTokens || 0), 0);
  const cachedTokens = entries.reduce((s, e) => s + (e.cachedTokens || 0), 0);
  const otherTokens = entries.reduce((s, e) => s + (e.otherTokens || 0), 0);
  const totalTokens = entries.reduce((s, e) => s + e.totalTokens, 0);
  const cost = estimateCost(entries);

  // breakdown per feature (mis. executor:create-promotion, dst)
  const byFeature = {};
  for (const e of entries) {
    if (!byFeature[e.feature]) {
      byFeature[e.feature] = { calls: 0, totalTokens: 0 };
    }
    byFeature[e.feature].calls += 1;
    byFeature[e.feature].totalTokens += e.totalTokens;
  }

  return {
    totalCalls,
    promptTokens,
    completionTokens,
    thoughtsTokens,
    toolUsePromptTokens,
    cachedTokens,
    otherTokens,
    totalTokens,
    cost,
    byFeature,
  };
}

// ============================================================
// RINGKASAN 1 PROSES TERAKHIR (1 alur promotion penuh)
// ============================================================
function getLastProcessStats(processId = null) {
  const data = loadData();
  if (!data.entries.length) return null;

  let entries;
  let matchedProcessId;

  if (processId) {
    entries = data.entries.filter((e) => e.processId === String(processId));
    if (!entries.length) {
      return { processId: String(processId), notFound: true };
    }
    matchedProcessId = String(processId);
  } else {
    const lastEntry = data.entries[data.entries.length - 1];
    if (lastEntry.processId) {
      entries = data.entries.filter((e) => e.processId === lastEntry.processId);
    } else {
      entries = [lastEntry];
    }
    matchedProcessId = lastEntry.processId;
  }

  return {
    processId: matchedProcessId,
    startedAt: entries[0]?.ts,
    endedAt: entries[entries.length - 1]?.ts,
    ...summarize(entries),
  };
}

// ============================================================
// AMBIL RINGKASAN: proses terakhir, hari ini, semua waktu
// ============================================================
function getStats(processId = null) {
  const data = loadData();
  const now = new Date();

  const today = data.entries.filter((e) => isSameDay(new Date(e.ts), now));
  const all = data.entries;

  return {
    lastProcess: getLastProcessStats(processId),
    today: summarize(today),
    allTime: summarize(all),
    lastEntry: data.entries.length ? data.entries[data.entries.length - 1] : null,
  };
}

// ============================================================
// FORMAT TEKS UNTUK DIKIRIM KE TELEGRAM
// ============================================================
function fmtNum(n) {
  return n.toLocaleString("id-ID");
}

// Bangun baris breakdown token yang SELALU jumlahnya match dengan
// total yang ditampilkan - tiap kategori yang nilainya > 0 saja
// yang ditulis, supaya laporan tidak penuh baris "0" percuma.
function buildTokenBreakdownLine(s) {
  const parts = [`in: ${fmtNum(s.promptTokens)}`, `out: ${fmtNum(s.completionTokens)}`];
  if (s.thoughtsTokens > 0) parts.push(`reasoning: ${fmtNum(s.thoughtsTokens)}`);
  if (s.toolUsePromptTokens > 0) parts.push(`skema tool: ${fmtNum(s.toolUsePromptTokens)}`);
  if (s.cachedTokens > 0) parts.push(`cache: ${fmtNum(s.cachedTokens)}`);
  if (s.otherTokens > 0) parts.push(`lainnya: ${fmtNum(s.otherTokens)}`);
  return parts.join(", ");
}

// BARU — bangun teks "Estimasi biaya" yang menampilkan USD DAN IDR
// sekaligus, supaya user tidak perlu hitung konversi manual.
function buildCostLine(cost) {
  return `$${cost.toFixed(4)} (${fmtRupiah(cost)})`;
}

function formatTokenSummary(processId = null) {
  const stats = getStats(processId);

  const lines = [];
  lines.push("📊 *Monitoring Token LLM*");
  lines.push("");

  // ---- 1. PROSES TERAKHIR ----
  lines.push("*Proses Terakhir* (1 alur promotion):");
  if (stats.lastProcess && stats.lastProcess.notFound) {
    lines.push("  ⚠️ Proses ini GAGAL TOTAL sebelum sempat memanggil AI (timeout/error).");
    lines.push("  Tidak ada token terpakai untuk proses ini - lihat pesan error di atas untuk alasannya.");
  } else if (stats.lastProcess) {
    const p = stats.lastProcess;
    lines.push(`  Panggilan LLM: ${fmtNum(p.totalCalls)}`);
    lines.push(`  Token: ${fmtNum(p.totalTokens)} (${buildTokenBreakdownLine(p)})`);
    lines.push(`  Estimasi biaya: ${buildCostLine(p.cost)}`);
  } else {
    lines.push("  (belum ada proses tercatat)");
  }
  lines.push("");

  // ---- 2. HARI INI ----
  lines.push("*Hari Ini:*");
  lines.push(`  Panggilan LLM: ${fmtNum(stats.today.totalCalls)}`);
  lines.push(`  Token: ${fmtNum(stats.today.totalTokens)} (${buildTokenBreakdownLine(stats.today)})`);
  lines.push(`  Estimasi biaya: ${buildCostLine(stats.today.cost)}`);
  lines.push("");

  // ---- 3. SEPANJANG WAKTU ----
  lines.push("*Sepanjang Waktu:*");
  lines.push(`  Panggilan LLM: ${fmtNum(stats.allTime.totalCalls)}`);
  lines.push(`  Token: ${fmtNum(stats.allTime.totalTokens)} (${buildTokenBreakdownLine(stats.allTime)})`);
  lines.push(`  Estimasi biaya: ${buildCostLine(stats.allTime.cost)}`);

  return lines.join("\n");
}

// ============================================================
// BARU — RINGKASAN TOKEN UNTUK 1 PROSES SAJA (dipakai /analisis,
// dll - versi ringkas, cuma bagian "Proses Terakhir", tanpa Hari
// Ini / Sepanjang Waktu). Kalau processId tidak ketemu di data
// (mis. dijawab dari cache/jalur cepat keyword tanpa panggil AI),
// ditampilkan sebagai 0 token terpakai, BUKAN pesan "GAGAL TOTAL"
// seperti di formatTokenSummary() yang memang untuk kasus error.
// ============================================================
function formatLastProcessTokenSummary(processId = null) {
  const stats = getStats(processId);
  const p = stats.lastProcess;

  const lines = [];
  lines.push("📊 *Monitoring Token LLM*");
  lines.push("");
  lines.push("*Proses Terakhir* (1 alur promotion):");

  if (p && p.notFound) {
    lines.push("  Tidak ada pemanggilan AI untuk proses ini (dijawab dari cache/pola cepat, 0 token terpakai).");
  } else if (p) {
    lines.push(`  Panggilan LLM: ${fmtNum(p.totalCalls)}`);
    lines.push(`  Token: ${fmtNum(p.totalTokens)} (${buildTokenBreakdownLine(p)})`);
    lines.push(`  Estimasi biaya: ${buildCostLine(p.cost)}`);
  } else {
    lines.push("  (belum ada proses tercatat)");
  }

  return lines.join("\n");
}

// ============================================================
// RESET (opsional, kalau mau bersihkan data lama)
// ============================================================
function resetUsage() {
  saveData({ entries: [] });
}

module.exports = {
  recordUsage,
  getStats,
  getLastProcessStats,
  formatTokenSummary,
  formatLastProcessTokenSummary,
  resetUsage,
};