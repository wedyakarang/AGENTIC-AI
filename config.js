// ======================================
// CONFIG
// STATUS ENDPOINT:
//   ✅ CONFIRMED  -> sudah dites & terbukti benar dari DevTools
//   ⚠️ ASSUMPTION -> belum dites, wajib divalidasi manual
// ======================================

module.exports = {
  DASHBOARD_ORIGIN: "https://demo-dashboard-merchant.guestpro.co.id",
  LOGIN_URL: "https://demo-dashboard-merchant.guestpro.co.id/user/login",

  // ✅ CONFIRMED dari Network tab (Request URL asli, :authority header)
  API_ORIGIN: "https://demo-ga-api.guestpro.co.id/admin-merchant/api",

  ENDPOINTS: {
    // ✅ CONFIRMED dari Network tab - dipakai untuk LIST (GET) & CREATE (POST) promosi,
    // path yang sama, method beda (REST convention)
    CREATE_PROMOTION: "/v2/hotel-smart-promotion",
    LIST_PROMOTION: "/v2/hotel-smart-promotion",
    AGENT_OPTION: "/agent-option",                       // ✅ CONFIRMED
    ROOM_RATE_OPTION: "/hotel-room-type-rate-option",    // ✅ CONFIRMED
  },

  LOCAL_STORAGE_KEY: "LOCAL_STORAGE",
  SESSION_DIR: "C:\\yogapunya\\chrome-session",
};