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

echo INSTALASI SELESAI. Jalankan: npm run hermes
pause