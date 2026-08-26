// ======================================
// AUTH MODULE
// Playwright DIPAKAI HANYA UNTUK LOGIN. Setelah login manual, token
// dibaca dari localStorage, browser ditutup, semua request selanjutnya
// pakai fetch() biasa.
//
// SESSION PERSISTENCE: HANYA TOKEN yang disimpan permanen (ke
// AUTH_STATE_FILE), BUKAN folder session Chrome.
//
// VALIDASI SESSION: isSessionValid() TIDAK menebak umur token sendiri.
// Dia tanya ke server GuestPro lewat CURRENT_USER_ENDPOINT. Kalau
// server bilang 401/403 -> token invalid, dianggap expired. Kalau
// network/server error (500, timeout) -> TIDAK langsung dianggap
// expired, supaya bot tidak maksa login manual gara-gara GuestPro
// lagi gangguan sesaat.
//
// UMUR TOKEN (BARU): getSessionRemainingDays() TIDAK LAGI pakai
// SESSION_MAX_AGE_MS hardcode. Sekarang dibaca LANGSUNG dari klaim
// "exp" di dalam JWT itu sendiri - klaim ini ditandatangani oleh
// server GuestPro saat token diterbitkan, jadi umurnya memang
// ditentukan oleh server/API, bukan ditebak di kode kita.
// ======================================

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { LOGIN_URL, SESSION_DIR, LOCAL_STORAGE_KEY } = require("./config");

const AUTH_STATE_FILE = path.join(path.dirname(SESSION_DIR), "auth-state.json");

// Endpoint ringan GuestPro buat cek token masih valid di server (bukan tebak umur sendiri)
const CURRENT_USER_ENDPOINT = "https://demo-ga-api.guestpro.co.id/admin-merchant/api/curent-user-get";

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

async function isSessionValid() {
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
      console.log("⚠️ Validasi token gagal (status", res.status, "), diasumsikan masih valid sementara");
      return true;
    }

    const body = await res.json();
    const userData = Array.isArray(body) ? body[0] : (body?.data ?? body);

    if (!userData || userData.success === false || !userData.username) {
      console.log("🔒 Response 200 tapi bukan data user valid - session dianggap expired");
      return false;
    }

    console.log("✅ Token dikonfirmasi valid oleh server (username:", userData.username, ")");
    return true;
  } catch (e) {
    console.log("⚠️ Gagal menghubungi server untuk validasi token:", e.message, "- diasumsikan masih valid sementara");
    return true;
  }
}

// ==========================================================
// UMUR TOKEN - dibaca dari klaim exp di dalam JWT (ditentukan
// server GuestPro saat token diterbitkan), BUKAN dihitung dari
// angka hardcode.
// ==========================================================

function decodeJwtPayload(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (payload.length % 4) payload += "=";

    const json = Buffer.from(payload, "base64").toString("utf-8");
    return JSON.parse(json);
  } catch (e) {
    console.log("⚠️ Gagal decode payload token:", e.message);
    return null;
  }
}

// Sisa umur session dalam hari - dibaca dari klaim "exp" di token
// (detik Unix, ditandatangani server). return null kalau tidak
// terbaca, supaya TIDAK disalahartikan sebagai "0 hari / expired".
function getSessionRemainingDays() {
  const saved = authState.token ? authState : loadAuthStateFromDisk();
  if (!saved || !saved.token) return null;

  const payload = decodeJwtPayload(saved.token);
  if (!payload || typeof payload.exp !== "number") {
    console.log("⚠️ Token tidak punya klaim 'exp' yang bisa dibaca - sisa hari tidak diketahui");
    return null;
  }

  const expiresAtMs = payload.exp * 1000;
  const remainingMs = expiresAtMs - Date.now();

  return Math.max(0, Math.ceil(remainingMs / (24 * 60 * 60 * 1000)));
}

// Tanggal persis token expired, dibaca dari klaim exp di server.
function getSessionExpiryDate() {
  const saved = authState.token ? authState : loadAuthStateFromDisk();
  if (!saved || !saved.token) return null;

  const payload = decodeJwtPayload(saved.token);
  if (!payload || typeof payload.exp !== "number") return null;

  return new Date(payload.exp * 1000);
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
        "Create promotion mungkin gagal. Coba klik-klik dashboard dulu sebelum browser ditutup, lalu login ulang."
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
  getSessionExpiryDate,
  cleanupChromeSessionDir,
};