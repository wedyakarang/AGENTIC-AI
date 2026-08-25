// ======================================
// ANALYSIS TOOL - Statistik Promosi GuestPro
// Ambil SEMUA promosi (looping semua halaman, bukan cuma page 1),
// lalu hitung: aktif vs tidak aktif, dan promosi yang pemakaiannya
// (used) sudah melebihi ambang batas tertentu (default: 100).
//
// ✅ Endpoint & bentuk response CONFIRMED langsung dari Network tab:
// GET https://demo-ga-api.guestpro.co.id/admin-merchant/api/v2/hotel-smart-promotion
// Response: { success, total, per_page, current_page, last_page, data: [...] }
// Field per item: is_active (boolean), used (number), max_use (number),
// promo_code (string|null), name (string)
// ======================================

const { API_ORIGIN, ENDPOINTS } = require("../config");
const { getAuthState, clearAuthState } = require("../auth");

const LIST_PROMOTION_ENDPOINT = ENDPOINTS.LIST_PROMOTION; // "/v2/hotel-smart-promotion"
const PAGE_SIZE = 100; // ambil banyak sekaligus per halaman, biar hemat request

// ===============================
// AMBIL SEMUA PROMOSI (looping semua halaman)
// ===============================
async function fetchAllPromotions() {
  const auth = getAuthState();
  if (!auth.token) {
    throw new Error("Belum login");
  }

  let page = 1;
  let lastPage = 1;
  const allData = [];

  do {
    const url =
      `${API_ORIGIN}${LIST_PROMOTION_ENDPOINT}` +
      `?keyword=&page=${page}&page_size=${PAGE_SIZE}` +
      `&rates_id=null&promotion_type=ALL` +
      `&sale_date_start=null&sale_date_end=null` +
      `&stay_date_start=null&stay_date_end=null` +
      `&created_at_start=null&created_at_end=null` +
      `&created_by=&status=ALL`;

    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "user-group-id": auth.userGroupId || "",
        Accept: "application/json, text/plain, */*",
      },
    });

    const contentType = res.headers.get("content-type") || "";

    if (res.status === 401) {
      clearAuthState();
      throw new Error("TOKEN_EXPIRED: silakan jalankan ensureLoggedIn() lagi.");
    }

    // Kalau server balikin HTML lagi (bukan JSON), berarti URL/query masih salah
    if (!contentType.includes("application/json")) {
      const rawText = await res.text();
      console.error(
        "❌ Response bukan JSON. Status:", res.status,
        "\nURL:", url,
        "\nCuplikan response:", rawText.slice(0, 300)
      );
      throw new Error(
        `Server tidak mengembalikan JSON (status ${res.status}). Cek console log untuk detail URL & response.`
      );
    }

    const json = await res.json();

    if (json.success === false) {
      throw new Error(json.message || "Gagal mengambil data promosi dari GuestPro");
    }

    allData.push(...(json.data || []));
    lastPage = json.last_page || 1;
    page++;
  } while (page <= lastPage);

  return allData;
}

// ===============================
// ANALISIS DATA PROMOSI
// ===============================
function analyzePromotions(promotions, usageThreshold = 100) {
  let activeCount = 0;
  let inactiveCount = 0;
  const overThreshold = [];

  for (const p of promotions) {
    if (p.is_active) {
      activeCount++;
    } else {
      inactiveCount++;
    }

    if (typeof p.used === "number" && p.used > usageThreshold) {
      overThreshold.push({
        name: p.name,
        promoCode: p.promo_code || "-",
        used: p.used,
        maxUse: p.max_use,
        isActive: p.is_active,
      });
    }
  }

  overThreshold.sort((a, b) => b.used - a.used);

  return {
    total: promotions.length,
    activeCount,
    inactiveCount,
    usageThreshold,
    overThreshold,
  };
}

// ===============================
// FORMAT HASIL BUAT DIKIRIM KE TELEGRAM
// ===============================
function formatAnalysisSummary(stats) {
  let text =
    `📊 *Analisis Promosi GuestPro*\n\n` +
    `Total promosi: *${stats.total}*\n` +
    `✅ Aktif: *${stats.activeCount}*\n` +
    `⛔ Tidak aktif: *${stats.inactiveCount}*\n\n` +
    `🔥 *Pemakaian di atas ${stats.usageThreshold}x:* ${stats.overThreshold.length} promosi\n`;

  if (stats.overThreshold.length > 0) {
    text += "\n";
    for (const p of stats.overThreshold.slice(0, 15)) {
      const statusIcon = p.isActive ? "✅" : "⛔";
      text += `${statusIcon} ${p.name} (${p.promoCode}) - ${p.used}/${p.maxUse}x\n`;
    }
    if (stats.overThreshold.length > 15) {
      text += `\n_...dan ${stats.overThreshold.length - 15} promosi lainnya_`;
    }
  }

  return text;
}

// ===============================
// FUNGSI UTAMA - dipanggil dari command Telegram
// ===============================
async function runPromotionAnalysis(usageThreshold = 100) {
  const promotions = await fetchAllPromotions();
  const stats = analyzePromotions(promotions, usageThreshold);
  return {
    stats,
    summaryText: formatAnalysisSummary(stats),
  };
}

module.exports = {
  fetchAllPromotions,
  analyzePromotions,
  formatAnalysisSummary,
  runPromotionAnalysis,
};