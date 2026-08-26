# Hermes Agent - GuestPro Promotion Bot

Bot otomatis untuk promosi GuestPro, terintegrasi dengan Telegram dan AI (OpenAI/Gemini).

# Skill yang dimiliki
1. Membuat Promosii
2. Analisis Data Promosi

## Cara Install

1. **Extract** file zip ini ke folder mana saja di laptop kamu.
2. Pastikan sudah terinstall:
   - **Node.js** (versi LTS): https://nodejs.org
   - **VSCode**: https://code.visualstudio.com
3. Buka folder hasil extract, **double-click `setup.bat`**.
   - Installer akan otomatis: cek Node.js → install dependency → install browser Playwright → menyiapkan file `.env` → membuka project di VSCode.
4. Kalau VSCode tidak otomatis terbuka, buka manual: **File → Open Folder** → pilih folder ini.

## Isi Kredensial (WAJIB sebelum menjalankan bot)

Di VSCode, buka file **`.env`** (sudah otomatis dibuat dari template), lalu isi baris-baris berikut dengan kredensial **milik kamu sendiri**:

| Variabel | Cara mendapatkan |
|---|---|
| `TELEGRAM_TOKEN` | Chat @BotFather di Telegram → `/newbot` → ikuti instruksi → copy token yang diberikan |
| `OPENAI_API_KEY` | Daftar/login di https://platform.openai.com → API keys → Create new secret key |
| `GEMINI_API_KEY` | Daftar/login di https://aistudio.google.com → Get API key |
| `ADMIN_CHAT_ID` | Chat @userinfobot di Telegram, dia akan balas dengan Chat ID kamu (opsional, untuk notifikasi admin) |


Contoh isi `.env` setelah diisi:
```env
TELEGRAM_TOKEN=8123456789:AAExxxxxxxxxxxxxxxxxxxxxxxx
OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxxxxxxxxxx
GEMINI_API_KEY=AIzaSyxxxxxxxxxxxxxxxxxxxxxxx
ADMIN_CHAT_ID=123456789

```

## Menjalankan Bot

Setelah `.env` sudah diisi lengkap, buka **Terminal** di VSCode (menu `Terminal → New Terminal`), lalu ketik:

```bash
npm run hermes
```

Kalau bot berhasil jalan, akan muncul pesan konfirmasi bot aktif di terminal (dan di Telegram kalau `ADMIN_CHAT_ID` sudah diisi).

## PENTING — Baca sebelum pakai

- **Jangan gunakan token/API key yang sama dengan developer/penjual aslinya.** Setiap instance bot **WAJIB** pakai kredensial sendiri-sendiri (Telegram token, OpenAI key, dll). Kalau pakai token yang sama dengan instance lain, bot akan saling rebutan koneksi dan error.
- Jangan share file `.env` kamu ke siapapun setelah diisi — itu berisi kredensial pribadi/akun kamu.
- Kalau ada error saat `npm install` atau `npx playwright install`, pastikan koneksi internet stabil dan coba jalankan `setup.bat` ulang.

## Troubleshooting

| Masalah | Solusi |
|---|---|
| `setup.bat` bilang Node.js belum terinstall | Install dulu dari https://nodejs.org, restart CMD, jalankan `setup.bat` lagi |
| VSCode tidak otomatis terbuka | Buka VSCode manual → File → Open Folder → pilih folder project ini |
| Bot tidak merespon di Telegram | Cek lagi `TELEGRAM_TOKEN` di `.env` sudah benar dan tidak ada spasi tambahan |
| Error saat login GuestPro | Cek lagi `GUESTPRO_USERNAME` dan `GUESTPRO_PASSWORD` sudah benar |