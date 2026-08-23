// ======================================
// EXCEL IMPORT HANDLER
// Membaca file .xlsx, mengubah tiap baris jadi format data yang sama
// persis dengan yang dipakai isiPromotion(), lalu memproses SEMUA baris
// satu per satu dan mengumpulkan hasil (link/URL) tiap promosi.
//
// FIX (versi ini):
// 1) MAX USED HILANG - sebelumnya maxUsed cuma kebaca kalau ditulis
//    "KODE:angka" di dalam kolom "Promo Codes". Padahal di file Excel
//    asli, "Promo Codes" cuma isi kode polos (mis. "DU2I34") dan angka
//    Max Used ada di KOLOM TERPISAH "Max Used" (mis. 2). Sekarang
//    parsePromoCodesCell() menerima kolom Max Used sebagai fallback,
//    dipasangkan berdasarkan urutan index kalau ada >1 kode di 1 baris.
// 2) RATES SALAH PARSE - kolom "Rates" di file asli pakai pemisah PIPE
//    ("DUO Santai | Select all"), bukan panah (→/->). Sebelumnya hanya
//    panah yang dikenali sehingga seluruh string dianggap 1 nama rate
//    utuh (tidak pernah ketemu di halaman GuestPro). Sekarang pipe ikut
//    dikenali sebagai pemisah Category | Rate, panah tetap didukung juga
//    untuk kompatibilitas mundur.
// ======================================

const XLSX = require("xlsx");
const { isiPromotion } = require("./isi");

// ======================================
// PARSER SEL BER-DELIMITER
// ======================================

// Pemisah Code <-> Max Used dalam 1 kode (opsional, format lama): "KODE:5"
// Pemisah Category <-> Rate (format baru & lama): "|" atau "→"/"->"/"–"/"—"
const CATEGORY_RATE_SPLIT = /\s*(?:\||→|->|–|—)\s*/;

// "DU2I34,ABC123" atau "KODE1:5,KODE2:10" -> [{kode, maxUsed}, ...]
// maxUsedCell (dari kolom "Max Used" terpisah di Excel) dipakai sebagai
// FALLBACK per-index kalau kode yang bersangkutan tidak menulis ":maxUsed"
// sendiri secara eksplisit.
function parsePromoCodesCell(cell, maxUsedCell) {
  if (!cell) return [];

  const fallbackMaxUsed = String(maxUsedCell ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(v => Number(v))
    .filter(n => !Number.isNaN(n));

  return String(cell)
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map((entry, idx) => {
      // format lama "KODE:5" masih didukung, kalau ada
      if (entry.includes(":")) {
        const [kode, maxUsed] = entry.split(":").map(x => (x || "").trim());
        return { kode, maxUsed: Number(maxUsed) || fallbackMaxUsed[idx] || fallbackMaxUsed[0] || 1 };
      }
      // format baru (sesuai file Excel asli): kode polos, maxUsed
      // diambil dari kolom "Max Used" terpisah, dipasangkan per-index.
      return {
        kode: entry,
        maxUsed: fallbackMaxUsed[idx] ?? fallbackMaxUsed[0] ?? 1,
      };
    });
}

// "DECREASE|PERCENT|10;INCREASE|AMOUNT|50000" -> [{formula,formulaType,value}, ...]
// (spasi di sekitar "|" aman karena tiap bagian di-trim)
function parseFormulasCell(cell) {
  if (!cell) return [];
  return String(cell)
    .split(";")
    .map(s => s.trim())
    .filter(Boolean)
    .map(triple => {
      const [formula, formulaType, value] = triple.split("|").map(x => (x || "").trim());
      return {
        formula: formula || "DECREASE",
        formulaType: formulaType || "AMOUNT",
        value: Number(value) || 0,
      };
    });
}

// "DUO Santai | Select all,Package | Select All" -> [{category,rate}, ...]
// Mendukung pemisah "|" (format asli file Excel) MAUPUN panah →/->/–/—
// (format lama) untuk Category <-> Rate. Antar-entri dipisah koma.
function parseRatesCell(cell) {
  if (!cell) return [];
  return String(cell)
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(seg => {
      const parts = seg.split(CATEGORY_RATE_SPLIT);
      if (parts.length >= 2) {
        return { category: parts[0].trim(), rate: parts.slice(1).join(" ").trim() };
      }
      return { category: null, rate: seg };
    });
}

// ======================================
// 1 BARIS EXCEL -> DATA OBJECT UNTUK isiPromotion()
// ======================================
function excelRowToPromotionData(row) {
  const maxUsedCell = row["Max Used"] ?? row["MAX USE"] ??row["Max Use"] ?? "";

  return {
    nama: row["Nama"] || row["NAMA"] || row["Name"] || "",
    namaID: row["Nama ID"] || row["Nama Indonesia"] || "",
    type: row["Promotion Type"] || row["Type"] || "PROMO CODE",
    promoCodes: parsePromoCodesCell(row["Promo Codes"] || row["Kode Promo"], maxUsedCell),
    group: row["Group"] || row["Travel Agency"] || "",
    agent: row["Agent"] || "",
    description: row["Description"] || row["Deskripsi"] || "-",
    descriptionID: row["Description ID"] || row["Deskripsi ID"] || "",
    minimumNight: Number(row["Minimum Night"]) || 1,
    rates: parseRatesCell(row["Rates"]),
    formulas: parseFormulasCell(row["Formulas"] || row["Formula"]),
  };
}

// ======================================
// VALIDASI RINGAN SEBELUM DIPROSES
// (biar ketahuan dari awal kalau ada baris yang jelas kosong,
// tanpa perlu buka browser dulu)
// ======================================
function validateRow(data) {
  const missing = [];
  if (!data.nama) missing.push("Nama");
  if (!data.promoCodes.length || !data.promoCodes[0].kode) missing.push("Promo Codes");
  if (!data.group && !data.agent) missing.push("Group/Agent (minimal salah satu)");
  if (!data.rates.length || !data.rates[0].rate) missing.push("Rates");
  if (!data.formulas.length) missing.push("Formulas");
  return missing;
}

// ======================================
// BATCH RUNNER: PROSES SEMUA BARIS DI EXCEL SATU PER SATU
// ======================================
async function processExcelImport(page, filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  if (rows.length === 0) {
    return { status: "error", message: "File Excel kosong / tidak ada baris data.", results: [] };
  }
  if (rows.length > 6) {
    console.log("⚠️ Excel berisi lebih dari 6 baris (" + rows.length + "), tetap akan diproses semua satu per satu.");
  }

  const results = [];

  for (let i = 0; i < rows.length; i++) {
    const rowNumber = i + 1;
    const data = excelRowToPromotionData(rows[i]);

    const missing = validateRow(data);
    if (missing.length > 0) {
      console.log(`⚠️ BARIS EXCEL #${rowNumber} DILEWATI - FIELD KURANG:`, missing);
      results.push({
        row: rowNumber,
        nama: data.nama || "(tanpa nama)",
        status: "skipped",
        message: "Field kurang: " + missing.join(", "),
      });
      continue;
    }

    console.log(`▶️ PROSES BARIS EXCEL #${rowNumber}:`, data.nama, "| promoCodes:", data.promoCodes, "| rates:", data.rates);
    try {
      const result = await isiPromotion(page, data);
      results.push({ row: rowNumber, nama: data.nama, ...result });
    } catch (err) {
      results.push({ row: rowNumber, nama: data.nama, status: "error", message: err.message });
    }

    // jeda antar promosi biar tidak numpuk/ke-detect sebagai spam
    await page.waitForTimeout(3000);
  }

  return { status: "done", results };
}

// ======================================
// FORMAT PESAN RANGKUMAN HASIL IMPORT (buat dikirim balik ke user)
// ======================================
function formatImportSummary(results) {
  const lines = results.map(r => {
    if (r.status === "success") {
      return `✅ Baris ${r.row} (${r.nama}): berhasil\n${r.url}`;
    }
    if (r.status === "skipped") {
      return `⏭️ Baris ${r.row} (${r.nama}): dilewati - ${r.message}`;
    }
    return `❌ Baris ${r.row} (${r.nama}): gagal - ${r.message}`;
  });

  const successCount = results.filter(r => r.status === "success").length;

  return (
    `📋 *HASIL IMPORT EXCEL* (${successCount}/${results.length} berhasil)\n\n` +
    lines.join("\n\n")
  );
}

module.exports = {
  processExcelImport,
  formatImportSummary,
  excelRowToPromotionData,
  parsePromoCodesCell,
  parseFormulasCell,
  parseRatesCell,
};