# Hermes Agent - GuestPro Promotion Bot

Bot otomatis untuk promosi GuestPro, terintegrasi dengan Telegram dan AI (Gemini).
Bot berjalan lewat **webhook** (bukan polling) — Telegram mengirim update langsung ke server lokal kamu lewat tunnel publik (ngrok).

## Skill yang dimiliki

1. Membuat Promotion (input manual atau import Excel)
2. Analisis Data Promosi (tanya jawab bebas soal statistik promosi)

## Cara Install

1. **Extract** file zip ini ke folder mana saja di laptop kamu.
2. Pastikan sudah terinstall:
   - **Node.js** (versi LTS): https://nodejs.org
   - **VSCode**: https://code.visualstudio.com
   - **ngrok**: https://ngrok.com/download (dipakai untuk membuka tunnel publik ke server lokal)
3. Buka folder hasil extract, **double-click setup.bat**.
   - Installer akan otomatis: cek Node.js → install dependency → install browser Playwright → menyiapkan file .env → membuka project di VSCode.
4. Kalau VSCode tidak otomatis terbuka, buka manual: **File → Open Folder** → pilih folder ini.

## Isi Kredensial (WAJIB sebelum menjalankan bot)

Di VSCode, buka file **.env** (sudah otomatis dibuat dari template), lalu isi baris-baris berikut dengan kredensial **milik kamu sendiri**:

| Variabel | Wajib? | Cara mendapatkan / catatan |
|---|---|---|
| TELEGRAM_TOKEN | Wajib | Chat @BotFather di Telegram → /newbot → ikuti instruksi → copy token yang diberikan |
| GEMINI_API_KEY | Wajib | Daftar/login di https://aistudio.google.com → Get API key |
| WEBHOOK_SECRET | Wajib | Isi bebas dengan string acak yang panjang (contoh: hermes-rahasia-2026-abc123). Dipakai sebagai bagian rahasia di path webhook supaya endpoint bot tidak sembarangan bisa di-POST orang lain |
| PUBLIC_URL | Wajib (diisi ulang tiap restart ngrok) | URL https yang keluar dari ngrok saat dijalankan, contoh: https://xxxx.ngrok-free.app. **Berubah tiap kali ngrok di-restart** — kalau berubah, update lagi di sini lalu restart bot |
| GUESTPRO_USERNAME / GUESTPRO_PASSWORD | Wajib | Kredensial login GuestPro kamu |
| ADMIN_CHAT_ID | Opsional | Chat @userinfobot di Telegram, dia akan balas dengan Chat ID kamu. Kalau diisi, error teknis akan dikirim ke chat ini |
| ALLOWED_CHAT_IDS | Opsional | Daftar Chat ID (dipisah koma) yang boleh pakai bot ini, contoh: 111111,222222. Kosongkan kalau bot boleh dipakai siapa saja yang menemukan username-nya |
| MAX_EXCEL_ROWS | Opsional | Batas maksimal baris Excel yang diproses sekali import. Default: 500 |
| EXTERNAL_CALL_TIMEOUT_MS | Opsional | Batas waktu (ms) untuk tiap panggilan ke layanan luar (login, AI, dll). Default: 45000 |
| ANALYSIS_CACHE_TTL_MS | Opsional | Masa berlaku cache jawaban /analisis (ms), supaya pertanyaan yang sama persis tidak perlu panggil AI ulang. Default: 300000 (5 menit) |
| GUESTPRO_PROMOTION_URL_TEMPLATE | Opsional | Template URL detail promotion di dashboard GuestPro, dipakai untuk membuat link ID promotion yang bisa diklik di hasil chat |

Contoh isi .env setelah diisi:

```env
TELEGRAM_TOKEN=8123456789:AAExxxxxxxxxxxxxxxxxxxxxxxx
GEMINI_API_KEY=AIzaSyxxxxxxxxxxxxxxxxxxxxxxx
WEBHOOK_SECRET=hermes-rahasia-2026-abc123
PUBLIC_URL=https://flanking-unveiled-tutor.ngrok-free.dev
GUESTPRO_USERNAME=akun-kamu
GUESTPRO_PASSWORD=password-kamu
ADMIN_CHAT_ID=123456789
```

## Menjalankan Bot

Bot butuh **2 proses aktif bersamaan**: tunnel ngrok (supaya Telegram bisa kirim update ke laptop kamu) dan bot itu sendiri.

### 1. Jalankan ngrok

Buka terminal, jalankan:

```bash
ngrok http 3000
```

Ngrok akan menampilkan URL forwarding, contoh:

```
Forwarding  https://flanking-unveiled-tutor.ngrok-free.dev -> http://localhost:3000
```

Copy URL https://... itu ke PUBLIC_URL di .env.

> ⚠️ **URL ngrok gratis berubah tiap kali ngrok di-restart.** Setiap kali itu terjadi, update ulang PUBLIC_URL di .env, lalu restart bot di langkah 2 supaya webhook yang terdaftar ke Telegram tetap valid.

### 2. Jalankan bot

Di terminal VSCode yang berbeda (Terminal → New Terminal), ketik:

```bash
npm run gateway
```

Kalau berhasil, akan muncul log konfirmasi di terminal seperti:

```
🤖 Hermes Running [...] - PID xxxx
🌐 Webhook server listening di port 3000
✅ Webhook terdaftar ke Telegram: https://xxxx.ngrok-free.dev/webhook/<WEBHOOK_SECRET>
```

### (Rekomendasi) Jalankan lewat PM2 supaya bot tetap hidup

Supaya bot tidak mati saat terminal ditutup, dan otomatis restart kalau crash:

```bash
npm install -g pm2
pm2 start "npm run gateway" --name hermes
pm2 logs hermes
```

> ⚠️ **Jangan jalankan bot dua kali sekaligus** (misal lewat npm run gateway manual DAN lewat PM2 bersamaan) — keduanya akan rebutan port 3000 dan rebutan daftar webhook ke Telegram, bikin bot jadi tidak konsisten membalas.

## Perintah yang Tersedia di Telegram

| Perintah | Fungsi |
|---|---|
| /start | Menampilkan menu & daftar perintah |
| /promotion | Mulai buat promotion baru (manual atau import Excel) |
| /analisis <pertanyaan> | Tanya statistik promosi bebas, contoh: /analisis berapa promo yang masih aktif? |
| token | Cek pemakaian token AI |
| batal | Hentikan proses yang sedang berjalan, kapan saja |
| version | Cek versi bot yang sedang aktif |

## PENTING — Baca sebelum pakai

- **Jangan gunakan token/API key yang sama dengan developer/penjual aslinya.** Setiap instance bot **WAJIB** pakai kredensial sendiri-sendiri (Telegram token, Gemini key, GuestPro login, dll). Kalau pakai kredensial yang sama dengan instance lain, bot akan saling rebutan koneksi dan error.
- Jangan share file .env kamu ke siapapun setelah diisi — itu berisi kredensial pribadi/akun kamu.
- Jangan share WEBHOOK_SECRET kamu — siapa pun yang tahu URL webhook lengkap (termasuk secret ini) bisa mengirim update palsu ke bot kamu.
- Kalau ada error saat npm install atau npx playwright install, pastikan koneksi internet stabil dan coba jalankan setup.bat ulang.

## Referensi Provider LLM

Folder ini berisi referensi implementasi beberapa provider Large Language Model (LLM).

File-file ini tidak otomatis digunakan oleh bot. Provider aktif hanya akan berubah jika implementasinya dipanggil atau diintegrasikan ke sistem utama.

### Provider yang tersedia

| Provider | File Referensi |
| --- | --- |
| DeepSeek | [Lihat kode DeepSeek](provider/AI%20AN/deepseek.js) |
| Gemini | [Lihat kode Gemini](provider/AI%20AN/gemini.js) |
| OpenAI | [Lihat kode OpenAI](provider/AI%20AN/openai.js) |

### Catatan

- Folder provider digunakan sebagai referensi implementasi alternatif.
- Kode provider tidak berjalan secara otomatis hanya karena file tersebut berada di folder `provider/`.
- Provider aktif dapat diganti dengan mengambil atau mengintegrasikan kode dari file yang sesuai.
- API key sebaiknya tetap menggunakan environment variable dan tidak ditulis langsung di dalam kode.

### Struktur Folder

```text
provider/
└── AI AN/
    ├── deepseek.js
    ├── gemini.js
    └── openai.js
```

## Troubleshooting

| Masalah | Solusi |
|---|---|
| setup.bat bilang Node.js belum terinstall | Install dulu dari https://nodejs.org, restart CMD, jalankan setup.bat lagi |
| VSCode tidak otomatis terbuka | Buka VSCode manual → File → Open Folder → pilih folder project ini |
| Bot tidak merespon di Telegram | 1) Cek terminal ngrok masih terbuka & aktif (baris Forwarding https://...). 2) Cek PUBLIC_URL di .env sudah sesuai URL ngrok yang aktif SEKARANG. 3) Restart bot supaya webhook didaftar ulang dengan URL terbaru |
| Bot tiba-tiba error / balasan aneh setelah pakai PM2 | Kemungkinan ada 2 proses bot jalan bersamaan (manual + PM2). Cek pm2 list, matikan salah satu (pm2 stop hermes atau tutup terminal manual), lalu jalankan ulang hanya lewat satu cara saja |
| TELEGRAM_TOKEN belum ada di .env / error serupa saat start | Cek lagi .env, pastikan semua variabel wajib (TELEGRAM_TOKEN, GEMINI_API_KEY, WEBHOOK_SECRET) sudah terisi tanpa spasi tambahan |
| Error saat login GuestPro | Cek lagi GUESTPRO_USERNAME dan GUESTPRO_PASSWORD di .env sudah benar |
| Mau cek webhook yang sedang terdaftar ke Telegram | Jalankan di browser: https://api.telegram.org/bot<TOKEN>/getWebhookInfo (ganti <TOKEN> dengan isi TELEGRAM_TOKEN, jangan share URL ini ke siapapun) |
