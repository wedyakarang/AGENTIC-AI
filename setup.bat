@echo off
echo ==========================================================
echo   HERMES AGENT - INSTALLER
echo ==========================================================
echo [1/4] Mengecek Node.js...
node -v >nul 2>&1
if errorlevel 1 (
    echo Node.js belum terinstall. Download di https://nodejs.org
    pause
    exit /b
)
echo [2/4] npm install...
call npm install
if errorlevel 1 (
    echo Gagal npm install.
    pause
    exit /b
)
echo [3/4] Install Playwright chromium...
call npx playwright install chromium
echo [4/4] Menyiapkan .env...
if not exist ".env" (
    copy ".env.example" ".env" >nul
    echo File .env dibuat dari template. Isi kredensialmu sendiri.
) else (
    echo .env sudah ada, tidak ditimpa.
)
echo ==========================================================
echo   INSTALASI SELESAI
echo   Langkah selanjutnya:
echo   1. VSCode akan terbuka otomatis
echo   2. Buka file .env, isi semua kredensial (Telegram, OpenAI, Gemini, GuestPro)
echo   3. Jalankan bot lewat terminal VSCode: npm run hermes
echo ==========================================================
echo Membuka project di VSCode...
code .
pause