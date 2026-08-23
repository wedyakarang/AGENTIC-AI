// ======================================
// UNCERTAINTY HELPER
// Deteksi jawaban ambigu/bingung dari user ("gatau", "bingung", dll)
// di titik-titik keputusan sepanjang bot (pilih Manual/Import, Ya/Tidak
// formula, konfirmasi ringkasan, dst) - supaya bot ngasih PENJELASAN
// singkat sesuai konteks, bukan cuma ngulang "pilih salah satu".
//
// CARA PAKAI di titik keputusan manapun (bot.js, parserManual.js,
// qnaFlow.js):
//
//   const { isUncertainReply, getHelpText } = require("./tools/uncertainty");
//
//   if (isUncertainReply(raw)) {
//     await send(chatId, getHelpText("CHOOSE_MODE"));
//     return; // tetap di state yang sama, user bisa jawab ulang
//   }
//
// Kalau ada state baru yang belum ada di HELP_TEXT, getHelpText() akan
// fallback ke teks generik - jadi aman dipasang di state manapun tanpa
// perlu didaftarkan dulu, tapi hasilnya lebih bagus kalau didaftarkan.
// ======================================

// Pola jawaban yang dianggap "user bingung / tidak tahu harus jawab apa".
// Dicek terhadap versi lowercase + trim dari pesan user.
const UNCERTAIN_PATTERNS = [
  /^(ga|gk|tidak|tak|kurang)?\s*(tau|tahu|ngerti|paham)$/i,
  /^ga+tau+$/i,
  /^gatau+$/i,
  /^bingung$/i,
  /^ga\s*ngerti$/i,
  /^gak\s*ngerti$/i,
  /^kurang\s*paham$/i,
  /^tidak\s*paham$/i,
  /^\?+$/,
  /^apa(an)?(\s*(itu|ya|tuh))?\??$/i,
  /^maksudnya\s*(apa)?\??$/i,
  /^help$/i,
  /^bantuan$/i,
];

function isUncertainReply(text) {
  const clean = String(text || "").trim().toLowerCase();
  if (!clean) return false;
  return UNCERTAIN_PATTERNS.some((pattern) => pattern.test(clean));
}

// Teks bantuan spesifik per konteks/state. Key-nya bebas kamu tentukan
// sendiri (biasanya samain dengan nama state di userState/manualSessions
// supaya gampang dicari), yang penting konsisten dipakai pas pasang
// isUncertainReply() di titik itu.
const HELP_TEXT = {
  CHOOSE_MODE:
    "Nggak masalah, saya jelasin dulu bedanya:\n\n" +
    "*Manual* - cocok kalau kamu mau bikin promotion satu-satu, diketik/dijawab langsung di chat (ada 2 cara: isi Template atau dituntun Tanya Jawab).\n\n" +
    "*Import* - cocok kalau kamu sudah punya banyak promotion sekaligus dalam 1 file Excel (.xlsx), tinggal upload, semua baris diproses otomatis.\n\n" +
    "Kalau cuma mau bikin 1-2 promotion, pilih *Manual*. Kalau punya daftar banyak dari spreadsheet, pilih *Import*.\n\n" +
    "Ketik *Manual* atau *Import* kalau sudah siap.",

  MANUAL_OR_QNA:
    "Nggak masalah, bedanya:\n\n" +
    "*Template* - kamu isi data promotion mengikuti format yang sudah disediakan, lebih cepat kalau sudah terbiasa.\n\n" +
    "*Tanya Jawab* - bot nanya satu-satu (nama promotion, diskon, dst), cocok kalau baru pertama kali atau nggak hafal formatnya.\n\n" +
    "Ketik salah satu buat lanjut.",

  CONFIRM_FORMULA:
    "Maksudnya: apakah promotion ini mau dikasih lebih dari 1 aturan diskon sekaligus (misal diskon 10% DAN potongan Rp50.000 di waktu bersamaan)?\n\n" +
    "Kalau cuma butuh 1 aturan diskon saja, jawab *Tidak*. Kalau mau nambah aturan lain lagi, jawab *Ya*.",

  CONFIRM_SUMMARY:
    "Ini kesempatan buat cek ulang data yang sudah kamu isi (ditampilkan di atas) sebelum benar-benar dikirim ke GuestPro.\n\n" +
    "Kalau semua sudah sesuai, jawab *Ya*. Kalau ada yang salah/mau diulang dari awal, jawab *Tidak*.",

  FLAG_CONFIRM:
    "Maksudnya: sistem menemukan sesuatu yang di luar kebiasaan di data promotion ini (lihat alasan yang disebutkan di atas).\n\n" +
    "Kalau kamu yakin datanya memang benar apa adanya, balas *lanjutkan* - promotion akan tetap dibuat. Kalau ternyata ada yang salah input, balas *batal* - proses ini akan dihapus, tidak ada yang dikirim ke GuestPro.",
};

const DEFAULT_HELP_TEXT =
  "Nggak masalah kalau bingung. Coba baca ulang pertanyaan di atas - " +
  "kalau masih belum jelas, boleh jelasin di mana bingungnya, saya bantu jelasin lebih detail.";

function getHelpText(contextKey) {
  return HELP_TEXT[contextKey] || DEFAULT_HELP_TEXT;
}

module.exports = {
  isUncertainReply,
  getHelpText,
};