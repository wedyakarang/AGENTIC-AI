// ======================================
// browser.js
// Buka GuestPro pakai Playwright LANGSUNG di proses yang sama
// (tidak lewat HTTP/axios ke server terpisah)
// ======================================

const { chromium } = require("playwright");

let context = null;
let page = null;

async function openGuestPro() {
  // kalau sudah terbuka, pakai yang ada
  if (context && page && !page.isClosed()) {
    await page.bringToFront();
    return { page, status: "already_open" };
  }

  context = await chromium.launchPersistentContext("./session", {
    headless: false,
    channel: "chrome", // atau pakai executablePath kalau channel "chrome" tidak ketemu
    viewport: null,
    args: [
      "--start-maximized",
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check"
    ]
  });

  page = context.pages()[0];
  if (!page) {
    page = await context.newPage();
  }

  await page.goto("https://demo-dashboard-merchant.guestpro.co.id/user/login", {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });

  await page.bringToFront();

  return { page, status: "opened" };
}

module.exports = { openGuestPro };