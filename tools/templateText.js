// ==========================================================
// TEMPLATE TEXT - teks bantuan statis untuk mode Manual
// ==========================================================
// Ini HANYA teks bantuan, tidak ada logika/parsing di sini.
// Ketika user isi & kirim template ini sebagai satu pesan,
// pesan itu akan diproses oleh LLM (llmAgent.js) sama seperti
// pesan bebas lainnya - LLM yang membaca & mengekstrak fieldnya.
// Jadi TIDAK ADA parser khusus untuk format ini, tidak menambah
// kompleksitas atau token ekstra di sisi LLM.
// ==========================================================

const TEMPLATE_TEXT = `Nama: 
Promotion Type: 
Kode Promo: 
Max Used: 
Group: 
Agent: 
Description: 
Minimum Night: 
Rates: 
Formula (DECREASE/INCREASE): 
Formula Value Type (AMOUNT/PERCENT): 
Formula Value: `;

const RATES_LEGEND = `Contoh daftar kategori Rates yang tersedia (tidak lengkap, tanya saja
kalau tidak yakin nama rate-nya - nanti saya cek ke sistem):
1. DUO Santai (DUOGEI, SUPER DUO)
2. Honeymoon Package at Uma Desa
3. Japan Rate
4. Membership Tier 1-5
5. OSHOMRUSH
6. Package
7. Room and Breakfast
8. Room Only
9. SVR (Special VIP Rates)
...dan lainnya.

Tulis di field Rates dengan format "Kategori | NamaRate" (boleh lebih dari
satu, pisahkan dengan baris baru atau koma). Kalau tidak yakin nama pastinya,
tulis saja perkiraannya - saya akan cek ke sistem dulu.`;

function getTemplateMessage() {
  return `Silakan isi template berikut, lalu kirim sebagai satu pesan:\n\n${TEMPLATE_TEXT}\n\n${RATES_LEGEND}`;
}

module.exports = { getTemplateMessage };