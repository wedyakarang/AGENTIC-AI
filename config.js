// ======================================
// CONFIG
// STATUS ENDPOINT:
//   ✅ CONFIRMED  -> sudah dites & terbukti benar dari DevTools
//   ⚠️ ASSUMPTION -> belum dites, wajib divalidasi manual
// ======================================

module.exports = {
  DASHBOARD_ORIGIN: "https://demo-dashboard-merchant.guestpro.co.id",
  LOGIN_URL: "https://demo-dashboard-merchant.guestpro.co.id/user/login",

  API_ORIGIN: "https://demo-ga-api.guestpro.co.id/admin-merchant/api",

  ENDPOINTS: {
    CREATE_PROMOTION: "/v2/hotel-smart-promotion",     // ✅ CONFIRMED (dari :path)
    AGENT_OPTION: "/agent-option",                       // ✅ CONFIRMED (dari :path)
    ROOM_RATE_OPTION: "/hotel-room-type-rate-option",    // ✅ terbukti resolve UUID sukses
  },

  LOCAL_STORAGE_KEY: "LOCAL_STORAGE",
  SESSION_DIR: "C:\\yogapunya\\chrome-session",
};