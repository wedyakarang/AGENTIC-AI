// ======================================
// PROMOTION API FINAL
// Direct Fetch API GuestPro
//
// PENTING: API GuestPro menerima multipart/form-data dengan SATU field
// bernama "new_item" berisi seluruh JSON payload sebagai string — BUKAN
// application/json biasa. Ini ditemukan dari cURL request asli browser
// (form-data name="new_item"). Error 'new_item' sebelumnya adalah
// KeyError backend karena field itu tidak ada saat kita kirim JSON polos.
//
// MONITORING: tiap panggilan POST create promotion dicatat ke
// apiMonitor.js (durasi + sukses/gagal) supaya bisa dipantau dari
// Telegram lewat formatStatsSummary().
// ======================================

const { API_ORIGIN, ENDPOINTS } = require("./config");
const { getAuthState, clearAuthState } = require("./auth");
const { resolveAgentId, resolveRoomRateIds } = require("./resolv");
const { recordCall } = require("./monitor");

// ===============================
// PROMOTION TYPE
// ===============================

const PROMOTION_TYPE_MAP = {
  "PROMO CODE": "PROMO_CODE",
  "PROMO_CODE": "PROMO_CODE",
};
    
function mapPromotionType(type) {
  const key = String(type || "").trim().toUpperCase();
  const result = PROMOTION_TYPE_MAP[key];

  if (!result) {
    throw new Error(`Promotion type tidak dikenal: ${type}`);
  }

  return result;
}

// ===============================
// VALIDATION
// ===============================

function validateData(data) {
  const errors = [];

  if (!data.nama) errors.push("Nama kosong");
  if (!data.promoCodes || data.promoCodes.length === 0) errors.push("Promo code kosong");
  if (!data.rates || data.rates.length === 0) errors.push("Rate kosong");
  if (!data.formulas || data.formulas.length === 0) errors.push("Formula kosong");

  return errors;
}

// ===============================
// PAYLOAD BUILDER
// ===============================

async function mapDataToApiPayload(data, token) {
  const [agentId, roomRateIds] = await Promise.all([
    resolveAgentId(data.agent, token),
    resolveRoomRateIds(data.rates, token),
  ]);

  if (data.agent && !agentId) {
    throw new Error(`Agent tidak ditemukan: ${data.agent}`);
  }

  if (roomRateIds.length === 0) {
    throw new Error("Room rate tidak ditemukan");
  }

  return {
    name: data.nama || "",
    promotion_type: mapPromotionType(data.type),
    promo_code: "",
    partner_name: data.group || "",
    partner_detail: "",
    agent: agentId || "",

    formula: data.formulas.map((f) => ({
      calculate_by: f.formula,
      value: String(f.value ?? 0),
      value_type: f.formulaType,
    })),

    rate: [],
    room_rate: roomRateIds,

    promo_code_list: data.promoCodes.map((c) => ({
      promo_code: c.kode,
      max_use: Number(c.maxUsed ?? 1),
      used: 0,
      use_max_use_daily_on_sale: false,
      use_max_use_daily_on_stay: false,
      max_use_daily_on_sale: 1,
      max_use_daily_on_stay: 1,
    })),

    is_use_custom_sale_stay_date: false,
    custom_sale_date_list: [],
    blackout_sale_date: [],
    custom_stay_date_list: [],
    blackout_stay_date: [],

    is_use_custom_sale_days: false,
    sale_sunday: false,
    sale_monday: false,
    sale_tuesday: false,
    sale_wednesday: false,
    sale_thursday: false,
    sale_friday: false,
    sale_saturday: false,

    is_use_custom_stay_days: false,
    stay_sunday: false,
    stay_monday: false,
    stay_tuesday: false,
    stay_wednesday: false,
    stay_thursday: false,
    stay_friday: false,
    stay_saturday: false,

    is_apply_smart_pricing_if_lower: false,

    max_use: 1,
    use_max_use_daily_on_sale: false,
    use_max_use_daily_on_stay: false,
    max_use_daily_on_sale: 1,
    max_use_daily_on_stay: 1,
    used: 0,

    apply_on: "EVERY_NIGHT",
    apply_days: 1,

    is_active: data.isActive ?? true,
    is_always_show_as_comparison: false,
    bypass_price_limitation: false,

    min_night: String(data.minimumNight ?? 1),

    is_use_popup: false,
    popup_image: null,
    popup_description: null,

    is_combinable: false,
    combine_mode: "ACCUMULATION",
    parent_id: [],use_cancellation_policy: false,
    use_cancellation_policy_period: false,
    cancellation_policy_period: null,

    use_term_and_condition: false,
    term_and_condition_mode: "NONE",
    use_term_and_condition_period: false,
    term_and_condition_period: null,

    use_minimum_deposit: false,
    use_minimum_deposit_period: false,
    minimum_deposit_period: null,

    description_mode: "NONE",
    description: "",
    show_discount_value: true,

    name_en: data.nama,
    name_ind: data.namaID || data.nama,
    description_en: data.description || "",
    description_ind: data.descriptionID || data.description || "",
  };
}

// ===============================
// CREATE API
// ===============================

async function createPromotionOnce(data) {
  const auth = getAuthState();

  if (!auth.token) {
    throw new Error("Belum login");
  }

  const payload = await mapDataToApiPayload(data, auth.token);

  console.log("DEBUG PAYLOAD:", JSON.stringify(payload, null, 2));

  const finalUrl = `${API_ORIGIN}${ENDPOINTS.CREATE_PROMOTION}`;
  console.log("URL YANG DIPANGGIL:", finalUrl);

  // ======================================
  // KIRIM SEBAGAI multipart/form-data, field "new_item" = JSON string.
  // Jangan set Content-Type manual — fetch akan otomatis mengisi
  // multipart/form-data dengan boundary yang benar kalau body-nya FormData.
  // ======================================
  const form = new FormData();
  form.append("new_item", JSON.stringify(payload));

  const monitorLabel = `POST ${ENDPOINTS.CREATE_PROMOTION}`;
  const startTime = Date.now();
  let requestOk = false;

  try {
    const res = await fetch(finalUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "user-group-id": auth.userGroupId || "",
      },
      body: form,
    });

    // Token expired/tidak valid -> bersihkan authState supaya pemanggil
    // tahu harus login ulang, bukan diam-diam gagal terus-menerus.
    if (res.status === 401) {
      clearAuthState();
      throw new Error("TOKEN_EXPIRED: silakan jalankan ensureLoggedIn() lagi.");
    }

    let json = null;
    try {
      json = await res.json();
    } catch (e) {
      // response bukan JSON valid, biarkan json = null
    }

    console.log("API RESPONSE:", JSON.stringify(json, null, 2));

    requestOk = res.ok && json?.success !== false;

    return {
      ok: requestOk,
      id: json?.data?.id || null,
      message: json?.message || `HTTP ${res.status}`,
      rawResponse: json,
      payloadSent: payload,
    };
  } finally {
    recordCall(monitorLabel, { durationMs: Date.now() - startTime, success: requestOk });
  }
}

// ===============================
// RETRY
// ===============================

async function createPromotionWithRetry(data) {
  const errors = validateData(data);

  if (errors.length) {
    return {
      ok: false,
      message: errors.join("; "),
      validationErrors: errors,
    };
  }

  try {
    return await createPromotionOnce(data);
  } catch (err) {
    return {
      ok: false,
      message: err.message,
    };
  }
}

module.exports = {
  createPromotionWithRetry,
  mapDataToApiPayload,
  validateData,
};