// ==========================================================
// FLAG EDIT - helper util MURNI (tanpa I/O, tanpa require lain) untuk
// ==========================================================

function buildFieldMenuKeyboard(data, backCallback) {
  const rows = [];

  rows.push([
    {
      text: `📝 Nama Promotion: ${data.nama && String(data.nama).trim() !== "" ? data.nama : "(KOSONG)"}`,
      callback_data: "fe:field:nama",
    },
  ]);

  const promoCodes = Array.isArray(data.promoCodes) ? data.promoCodes : [];
  promoCodes.forEach((p, i) => {
    const kodeKosong = !p || !p.kode || String(p.kode).trim() === "";
    rows.push([
      {
        text: `🎟️ Kode Promo #${i + 1}: ${kodeKosong ? "(KOSONG)" : p.kode}`,
        callback_data: `fe:field:promo:${i}`,
      },
    ]);
  });

  rows.push([{ text: "⬅️ Kembali", callback_data: backCallback }]);
  return rows;
}

function buildFieldMenuText(data, ruleReasons) {
  const statusLine =
    ruleReasons.length > 0
      ? `🚩 Masih kosong:\n- ${ruleReasons.join("\n- ")}`
      : "✅ Nama & semua kode promo sudah terisi - tidak ada lagi yang kosong.";

  return `*${data.nama && String(data.nama).trim() !== "" ? data.nama : "(baris ini)"}*\n\n${statusLine}\n\nPilih field yang mau diisi/diubah:`;
}

// Dipakai KHUSUS jalur Import - daftar baris yang di-flag, user pilih
// salah satu untuk masuk ke buildFieldMenuKeyboard() di atas. Baris
// yang sudah diedit sampai lengkap ditandai ✅ di labelnya.
function buildRowListKeyboard(flaggedRows) {
  const rows = flaggedRows.map((r, i) => [
    {
      text: `Baris ${r.row} (${r.nama || "-"})${r.ruleReasons.length === 0 ? " ✅" : ""}`,
      callback_data: `fe:row:${i}`,
    },
  ]);
  rows.push([{ text: "⬅️ Kembali ke Ringkasan", callback_data: "fe:summary" }]);
  return rows;
}

module.exports = {
  buildFieldMenuKeyboard,
  buildFieldMenuText,
  buildRowListKeyboard,
};