// ======================================
  // EXCEL IMPORT HANDLER — VERSI FETCH + PARALLEL (CONCURRENCY LIMITED)
  // ======================================
  //
  // - Baris Excel diproses PARALEL, dibatasi CONCURRENCY_LIMIT sekaligus,
  //   untuk menghindari rate limit / overload GuestPro dan cache stampede
  //   di resolvers.js.
  // - onProgress dipanggil tiap 1 baris selesai (tidak berurutan).
  // - results tetap diurutkan sesuai nomor baris di akhir.
  //
  // TAMBAHAN (untuk anomaly-check Import di executorAgent.js):
  // - parseExcelForReview(filePath): parse SAJA, tanpa eksekusi ke GuestPro.
  // - executeParsedPromotions(parsedRows): eksekusi array hasil parse di atas.
  // ======================================

  const XLSX = require("xlsx");
  const { createPromotionTool } = require("./indexxx");

  const CATEGORY_RATE_SPLIT = /\s*(?:\||→|->|–|—)\s*/;

  // ======================================
  // BARU — LINK PROMOTION (sama seperti buildPromotionIdDisplay() di
  // telegram3.js). ID promotion yang berhasil dibuat lewat Import
  // SEKARANG ditampilkan sebagai link Markdown yang bisa langsung
  // diklik ke halaman promotion itu di dashboard GuestPro, kalau
  // GUESTPRO_PROMOTION_URL_TEMPLATE (atau default demo di bawah)
  // mengandung placeholder literal "{id}". Kalau template kosong/tidak
  // valid, fallback ke tampilan ID sebagai teks biasa - supaya tidak
  // ada apa pun yang rusak.
  //
  // CATATAN: dipisah/duplikat dari telegram3.js (bukan di-import),
  // karena excelll.js sengaja tidak bergantung ke telegram3.js -
  // supaya excelll.js tetap bisa dipakai berdiri sendiri (mis. lewat
  // processExcelImport() langsung, di luar bot Telegram).
  // ======================================
  const DEFAULT_GUESTPRO_PROMOTION_URL_TEMPLATE =
    "https://demo-dashboard-merchant.guestpro.co.id/masterdata/v2/promotion/{id}";
  const GUESTPRO_PROMOTION_URL_TEMPLATE =
    process.env.GUESTPRO_PROMOTION_URL_TEMPLATE || DEFAULT_GUESTPRO_PROMOTION_URL_TEMPLATE;

  function buildPromotionIdDisplay(promotionId) {
    const id = promotionId || "-";
    if (!promotionId || !GUESTPRO_PROMOTION_URL_TEMPLATE || !GUESTPRO_PROMOTION_URL_TEMPLATE.includes("{id}")) {
      return id;
    }
    const url = GUESTPRO_PROMOTION_URL_TEMPLATE.replace("{id}", encodeURIComponent(promotionId));
    return `[${id}](${url})`;
  }

  // Berapa banyak baris yang boleh diproses BERSAMAAN.
  const CONCURRENCY_LIMIT = 10;

  function parsePromoCodesCell(cell, maxUsedCell) {
    if (!cell) return [];

    const fallbackMaxUsed = String(maxUsedCell ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((v) => Number(v))
      .filter((n) => !Number.isNaN(n));

    return String(cell)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((entry, idx) => {
        if (entry.includes(":")) {
          const [kode, maxUsed] = entry.split(":").map((x) => (x || "").trim());
          return { kode, maxUsed: Number(maxUsed) || fallbackMaxUsed[idx] || fallbackMaxUsed[0] || 1 };
        }
        return {
          kode: entry,
          maxUsed: fallbackMaxUsed[idx] ?? fallbackMaxUsed[0] ?? 1,
        };
      });
  }

  function parseFormulasCell(cell) {
    if (!cell) return [];
    return String(cell)
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((triple) => {
        const [formula, formulaType, value] = triple.split("|").map((x) => (x || "").trim());
        return {
          formula: formula || "DECREASE",
          formulaType: formulaType || "AMOUNT",
          value: Number(value) || 0,
        };
      });
  }

  function parseRatesCell(cell) {
    if (!cell) return [];
    return String(cell)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((seg) => {
        const parts = seg.split(CATEGORY_RATE_SPLIT);
        if (parts.length >= 2) {
          return { category: parts[0].trim(), rate: parts.slice(1).join(" ").trim() };
        }
        return { category: null, rate: seg };
      });
  }

  function excelRowToPromotionData(row) {
    const maxUsedCell = row["Max Used"] ?? row["MAX USE"] ?? row["Max Use"] ?? "";

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
  // WORKER POOL SEDERHANA
  // ======================================
  async function runWithConcurrencyLimit(items, limit, workerFn) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function worker() {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        if (currentIndex >= items.length) return;

        results[currentIndex] = await workerFn(items[currentIndex], currentIndex);
      }
    }

    const workerCount = Math.min(limit, items.length);
    const workers = Array.from({ length: workerCount }, () => worker());
    await Promise.all(workers);

    return results;
  }

  // ======================================
  // PROSES 1 BARIS (jalur lama, dipakai processExcelImport)
  // ======================================
  async function processOneRow(row, index, onProgress) {
    const rowNumber = index + 1;
    const data = excelRowToPromotionData(row);

    const missing = validateRow(data);
    if (missing.length > 0) {
      console.log(`⚠️ BARIS EXCEL #${rowNumber} DILEWATI - FIELD KURANG:`, missing);
      const result = {
        row: rowNumber,
        nama: data.nama || "(tanpa nama)",
        status: "skipped",
        message: "Field kurang: " + missing.join(", "),
      };
      if (onProgress) onProgress(result);
      return result;
    }

    console.log(`▶️ PROSES BARIS EXCEL #${rowNumber}:`, data.nama);

    try {
      const result = await createPromotionTool(data);
      const finalResult = {
        row: rowNumber,
        nama: data.nama,
        status: result.ok ? "success" : "error",
        message: result.ok ? "Berhasil" : result.reason,
        promotionId: result.promotionId,
      };
      if (onProgress) onProgress(finalResult);
      return finalResult;
    } catch (err) {
      const finalResult = { row: rowNumber, nama: data.nama, status: "error", message: err.message };
      if (onProgress) onProgress(finalResult);
      return finalResult;
    }
  }

  // ======================================
  // PROSES SEMUA BARIS — jalur lama (import langsung tanpa review)
  // ======================================
  async function processExcelImport(filePath, onProgress = null) {
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

    if (rows.length === 0) {
      return { status: "error", message: "File Excel kosong / tidak ada baris data.", results: [] };
    }

    const results = await runWithConcurrencyLimit(
      rows,
      CONCURRENCY_LIMIT,
      (row, index) => processOneRow(row, index, onProgress)
    );

    return { status: "done", results };
  }

  function formatImportSummary(results) {
    const lines = results.map((r) => {
      if (r.status === "success") {
        return `✅ Baris ${r.row} (${r.nama}): berhasil\nID: ${buildPromotionIdDisplay(r.promotionId)}`;
      }
      if (r.status === "skipped") {
        return `⏭️ Baris ${r.row} (${r.nama}): dilewati - ${r.message}`;
      }
      return `❌ Baris ${r.row} (${r.nama}): gagal - ${r.message}`;
    });

    const successCount = results.filter((r) => r.status === "success").length;

    return (
      `📋 *HASIL IMPORT EXCEL* (${successCount}/${results.length} berhasil)\n\n` +
      lines.join("\n\n")
    );
  }

  // ======================================
  // BARU — PARSE-ONLY: baca Excel, ubah ke data promotion, TANPA
  // eksekusi ke GuestPro. Dipakai executorAgent.js untuk anomaly-check
  // sebelum benar-benar create.
  // ======================================
  function parseExcelForReview(filePath) {
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

    return rawRows.map((row, index) => {
      const rowNumber = index + 1;
      const data = excelRowToPromotionData(row);
      const missing = validateRow(data);
      return { rowNumber, nama: data.nama || "(tanpa nama)", data, missing };
    });
  }

  // Eksekusi 1 baris yang SUDAH di-parse (bukan raw Excel row lagi)
  async function executeOnePromotionData(rowNumber, nama, data, missing, onProgress) {
    if (missing && missing.length > 0) {
      const result = {
        row: rowNumber,
        nama: nama || "(tanpa nama)",
        status: "skipped",
        message: "Field kurang: " + missing.join(", "),
      };
      if (onProgress) onProgress(result);
      return result;
    }

    console.log(`▶️ PROSES BARIS EXCEL #${rowNumber} (dari review):`, nama);

    try {
      const result = await createPromotionTool(data);
      const finalResult = {
        row: rowNumber,
        nama,
        status: result.ok ? "success" : "error",
        message: result.ok ? "Berhasil" : result.reason,
        promotionId: result.promotionId,
      };
      if (onProgress) onProgress(finalResult);
      return finalResult;
    } catch (err) {
      const finalResult = { row: rowNumber, nama, status: "error", message: err.message };
      if (onProgress) onProgress(finalResult);
      return finalResult;
    }
  }

  // ======================================
  // BARU — eksekusi array hasil parseExcelForReview() ke GuestPro,
  // paralel dengan concurrency limit yang sama.
  // ======================================
  async function executeParsedPromotions(parsedRows, onProgress = null) {
    if (!parsedRows || parsedRows.length === 0) {
      return { status: "error", message: "Tidak ada baris untuk dieksekusi.", results: [] };
    }

    const results = await runWithConcurrencyLimit(
      parsedRows,
      CONCURRENCY_LIMIT,
      (item) => executeOnePromotionData(item.rowNumber, item.nama, item.data, item.missing, onProgress)
    );

    return { status: "done", results };
  }

  module.exports = {
    processExcelImport,
    formatImportSummary,
    excelRowToPromotionData,
    parsePromoCodesCell,
    parseFormulasCell,
    parseRatesCell,
    runWithConcurrencyLimit,
    parseExcelForReview,
    executeParsedPromotions,
  };