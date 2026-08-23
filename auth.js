// ======================================
// AUTH MODULE
// Playwright DIPAKAI HANYA UNTUK LOGIN. Setelah login manual, token
// dibaca dari localStorage, browser ditutup, semua request selanjutnya
// pakai fetch() biasa.
//
// SESSION PERSISTENCE: HANYA TOKEN yang disimpan permanen (ke
// AUTH_STATE_FILE), BUKAN folder session Chrome.
//
// VALIDASI SESSION (BARU): isSessionValid() TIDAK LAGI menebak umur
// token sendiri (dulu hardcode 90 hari). Sekarang dia benar-benar
// tanya ke server GuestPro lewat CURRENT_USER_ENDPOINT (endpoint
// ringan, cuma balikin data user, dipakai juga oleh dashboard GuestPro
// sendiri buat cek "siapa saya"). Kalau server bilang 401/403 -> token
// memang invalid, baru dianggap expired. Kalau network/server lagi
// error (500, timeout) -> TIDAK langsung dianggap expired, supaya bot
// tidak maksa login manual gara-gara GuestPro lagi gangguan sesaat.
//
// SESSION_MAX_AGE_MS masih disimpan HANYA buat info "sisa X hari" yang
// ditampilkan ke user di Telegram (getSessionRemainingDays) - bukan
// lagi penentu valid/tidaknya token.
// ======================================

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { LOGIN_URL, SESSION_DIR, LOCAL_STORAGE_KEY } = require("./config");

const AUTH_STATE_FILE = path.join(path.dirname(SESSION_DIR), "auth-state.json");

// Endpoint ringan GuestPro buat cek token masih valid di server (bukan tebak umur sendiri)
const CURRENT_USER_ENDPOINT = "https://demo-ga-api.guestpro.co.id/admin-merchant/api/curent-user-get";

// Cuma dipakai buat estimasi tampilan "sisa X hari" ke user, BUKAN penentu valid/invalid
const SESSION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

let authState = {
  token: null,
  refreshToken: null,
  merchantId: null,
  userId: null,
  userGroupId: null,
  obtainedAt: null,
};

function getAuthState() {
  return authState;
}

function isLoggedIn() {
  return !!authState.token;
}

function clearAuthState() {
  authState = {
    token: null,
    refreshToken: null,
    merchantId: null,
    userId: null,
    userGroupId: null,
    obtainedAt: null,
  };
}

// ==========================================================
// PERSISTENSI KE FILE
// ==========================================================

function saveAuthStateToDisk() {
  try {
    fs.writeFileSync(AUTH_STATE_FILE, JSON.stringify(authState, null, 2), "utf-8");
    console.log("💾 Session disimpan ke:", AUTH_STATE_FILE);
  } catch (e) {
    console.log("⚠️ Gagal menyimpan session ke file:", e.message);
  }
}

function loadAuthStateFromDisk() {
  try {
    if (!fs.existsSync(AUTH_STATE_FILE)) return null;
    const raw = fs.readFileSync(AUTH_STATE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    console.log("⚠️ Gagal membaca session dari file:", e.message);
    return null;
  }
}

function deleteAuthStateFile() {
  try {
    if (fs.existsSync(AUTH_STATE_FILE)) {
      fs.unlinkSync(AUTH_STATE_FILE);
    }
  } catch (e) {
    console.log("⚠️ Gagal hapus file session:", e.message);
  }
}

// ==========================================================
// CEK VALIDITAS SESSION (dipanggil oleh ensureLoggedIn di indexxx.js)
// ==========================================================
// ASYNC sekarang - benar-benar tanya ke server via CURRENT_USER_ENDPOINT,
// bukan hitung umur token sendiri. Kalau token ada (di memory atau file)
// tapi belum tervalidasi ke server, tetap dicoba dulu ke server -
// server yang punya kebenaran soal umur token, bukan kita.

async function isSessionValid() {
  // Restore dari file dulu kalau memory kosong (proses baru di-restart)
  if (!authState.token) {
    const saved = loadAuthStateFromDisk();
    if (saved && saved.token) {
      authState = saved;
      console.log("♻️ Token dipulihkan dari file, akan divalidasi ke server...");
    }
  }

  if (!authState.token) return false; // memang belum pernah login

  try {
    const res = await fetch(CURRENT_USER_ENDPOINT, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${authState.token}`,
        ...(authState.userGroupId ? { "user-group-id": authState.userGroupId } : {}),
      },
    });

    if (res.status === 401 || res.status === 403) {
      console.log("🔒 Token ditolak server (status", res.status, ") - session dianggap expired");
      return false;
    }

    if (!res.ok) {
      // Error lain (500, dll) - jangan buru-buru anggap expired, bisa jadi GuestPro lagi gangguan
      console.log("⚠️ Validasi token gagal (status", res.status, "), diasumsikan masih valid sementara");
      return true;
    }

    const body = await res.json();
    // Dukung dua kemungkinan bentuk response: object langsung {...} atau array [{...}]
    const userData = Array.isArray(body) ? body[0] : (body?.data ?? body);

    if (!userData || userData.success === false || !userData.username) {
      console.log("🔒 Response 200 tapi bukan data user valid - session dianggap expired");
      return false;
    }

    console.log("✅ Token dikonfirmasi valid oleh server (username:", userData.username, ")");
    return true;
  } catch (e) {
    // Gagal konek (bukan token yang salah) - jangan maksa login ulang
    console.log("⚠️ Gagal menghubungi server untuk validasi token:", e.message, "- diasumsikan masih valid sementara");
    return true;
  }
}

// Sisa umur session dalam hari - ESTIMASI SAJA buat ditampilkan ke user
// lewat Telegram, bukan lagi acuan valid/tidak (itu tugas isSessionValid()).
function getSessionRemainingDays() {
  const saved = authState.token ? authState : loadAuthStateFromDisk();
  if (!saved || !saved.obtainedAt) return 0;

  const age = Date.now() - saved.obtainedAt;
  const remainingMs = SESSION_MAX_AGE_MS - age;
  return Math.max(0, Math.ceil(remainingMs / (24 * 60 * 60 * 1000)));
}

function cleanupChromeSessionDir() {
  try {
    if (fs.existsSync(SESSION_DIR)) {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
      console.log("🗑️ Folder session Chrome dibersihkan:", SESSION_DIR);
    }
  } catch (e) {
    console.log("⚠️ Gagal membersihkan folder session Chrome:", e.message);
  }
}

function clearSession() {
  clearAuthState();
  deleteAuthStateFile();
  cleanupChromeSessionDir();
}

async function readAuthFromPage(page) {
  const raw = await page.evaluate((key) => window.localStorage.getItem(key), LOCAL_STORAGE_KEY);
  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.log("❌ GAGAL PARSE LOCAL_STORAGE:", e.message);
    return null;
  }

  return {
    token: parsed?.guestapps_auth_token || null,
    refreshToken: parsed?.guestapps_auth_refresh || null,
    merchantId: parsed?.MERCHANT?.id || null,
    userId: parsed?.USER?.id || null,
  };
}

async function loginManual({ timeoutMs = 0 } = {}) {
  console.log("🚀 MEMBUKA BROWSER UNTUK LOGIN MANUAL");

  const context = await chromium.launchPersistentContext(SESSION_DIR, {
    headless: false,
    channel: "chrome",
    viewport: null,
    args: [
      "--start-maximized",
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  try {
    const page = context.pages()[0] || (await context.newPage());

    let capturedUserGroupId = null;
    page.on("request", (request) => {
      if (capturedUserGroupId) return;
      const headers = request.headers();
      if (headers["user-group-id"]) {
        capturedUserGroupId = headers["user-group-id"];
        console.log("✅ user-group-id TERTANGKAP:", capturedUserGroupId);
      }
    });

    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.bringToFront();

    console.log("⏳ MENUNGGU USER LOGIN MANUAL... (timeout: " + (timeoutMs || "tanpa batas") + ")");

    await page.waitForFunction(
      () => !window.location.pathname.includes("/user/login"),
      { timeout: timeoutMs || 0 }
    );

    await page.waitForTimeout(1500);

    if (!capturedUserGroupId) {
      await page
        .waitForRequest((req) => !!req.headers()["user-group-id"], { timeout: 5000 })
        .catch(() => {});
    }

    const auth = await readAuthFromPage(page);

    if (!auth || !auth.token) {
      throw new Error(
        "LOGIN TERDETEKSI TAPI TOKEN TIDAK DITEMUKAN DI localStorage. " +
        "Cek apakah key LOCAL_STORAGE masih sama, atau GuestPro barusan ganti mekanisme auth."
      );
    }

    if (!capturedUserGroupId) {
      console.log(
        "⚠️ PERINGATAN: user-group-id TIDAK tertangkap. " +
        "Create promotion mungkin gagal. Coba klik-klik dashboard dulu sebelum browsertertutup, lalu login ulang."
      );
    }

    authState = {
      ...auth,
      userGroupId: capturedUserGroupId,
      obtainedAt: Date.now(),
    };

    saveAuthStateToDisk();

    console.log(
      "✅ LOGIN BERHASIL, TOKEN TERSIMPAN (merchantId:", authState.merchantId,
      ", userGroupId:", authState.userGroupId, ")"
    );

    return authState;
  } finally {
    await context.close().catch(() => {});
    cleanupChromeSessionDir();
  }
}

async function refreshToken() {
  throw new Error(
    "refreshToken() belum diimplementasi - endpoint refresh belum dikonfirmasi dari DevTools. " +
    "Untuk sementara, kalau token expired, panggil loginManual() lagi."
  );
}

module.exports = {
  loginManual,
  refreshToken,
  getAuthState,
  isLoggedIn,
  clearAuthState,
  clearSession,
  isSessionValid,
  getSessionRemainingDays,
  cleanupChromeSessionDir,
};