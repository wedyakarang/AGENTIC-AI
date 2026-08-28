// // ======================================
// // RESOLVERS
// ======================================

const { API_ORIGIN, ENDPOINTS } = require("./config");
const { recordCallOnce } = require("./monitor");
const { findBestMatches } = require("./tools/matcher");

// Menyimpan PROMISE yang sedang/sudah berjalan, bukan value langsung.
// null = belum pernah ada permintaan fetch yang berjalan.
let agentListPromise = null;
let roomRateListPromise = null;

function clearResolverCache() {
  agentListPromise = null;
  roomRateListPromise = null;
}

function authHeaders(token) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

async function fetchAgentListFromApi(token) {
  const label = `GET ${ENDPOINTS.AGENT_OPTION}`;
  const start = Date.now();
  let ok = false;
  try {
    const res = await fetch(`${API_ORIGIN}${ENDPOINTS.AGENT_OPTION}`, {
      method: "GET",
      headers: authHeaders(token),
    });

    if (!res.ok) {
      throw new Error(`GAGAL AMBIL DAFTAR AGENT (HTTP ${res.status})`);
    }

    const json = await res.json();
    const list = Array.isArray(json?.data) ? json.data : [];
    ok = true;
    return list;
  } finally {
    // recordCallOnce: kalau proses ini SUDAH pernah mencatat GET
    // endpoint ini (mis. dari cache-hit baris sebelumnya di proses
    // yang sama), panggilan ini diabaikan - tidak akan pernah terjadi
    // dalam praktiknya karena begini2 baris pertama yang fetch fresh
    // pasti yang pertama kali "mengklaim" pencatatan; tapi guard ini
    // tetap aman untuk kasus race/paralel.
    recordCallOnce(label, { durationMs: Date.now() - start, success: ok, cached: false });
  }
}

async function getAgentList(token) {
  // Kalau sudah ada Promise yang sedang/sudah berjalan (baik masih
  // pending maupun sudah selesai), pakai itu - TIDAK fetch baru.
  // Tetap dicatat sebagai "dipakai" (cached: true) - TAPI lewat
  // recordCallOnce(), jadi kalau proses ini sudah pernah mencatat GET
  // endpoint ini sebelumnya (baris lain di proses/batch yang sama),
  // panggilan ini tidak menambah hitungan lagi.
  if (agentListPromise) {
    recordCallOnce(`GET ${ENDPOINTS.AGENT_OPTION}`, {
      durationMs: 0,
      success: true,
      cached: true,
    });
    return agentListPromise;
  }

  agentListPromise = fetchAgentListFromApi(token); // recordCallOnce (fresh) sudah di dalam fungsi ini

  try {
    return await agentListPromise;
  } catch (err) {
    // Fetch gagal -> reset supaya percobaan BERIKUTNYA bisa fetch
    // ulang (bukan terus-menerus mengembalikan error yang sama).
    agentListPromise = null;
    throw err;
  }
}

async function fetchRoomRateListFromApi(token) {
  const label = `GET ${ENDPOINTS.ROOM_RATE_OPTION}`;
  const start = Date.now();
  let ok = false;

  try {
    const res = await fetch(`${API_ORIGIN}${ENDPOINTS.ROOM_RATE_OPTION}`, {
      method: "GET",
      headers: authHeaders(token),
    });

    if (!res.ok) {
      throw new Error(`GAGAL AMBIL DAFTAR RATE (HTTP ${res.status})`);
    }

    const json = await res.json();
    const list = Array.isArray(json?.data) ? json.data : [];
    ok = true;
    return list;
  } finally {
    recordCallOnce(label, { durationMs: Date.now() - start, success: ok, cached: false });
  }
}

async function getRoomRateList(token) {
  if (roomRateListPromise) {
    recordCallOnce(`GET ${ENDPOINTS.ROOM_RATE_OPTION}`, {
      durationMs: 0,
      success: true,
      cached: true,
    });
    return roomRateListPromise;
  }

  roomRateListPromise = fetchRoomRateListFromApi(token); // recordCallOnce (fresh) sudah di dalam fungsi ini

  try {
    return await roomRateListPromise;
  } catch (err) {
    roomRateListPromise = null;
    throw err;
  }
}

function flattenRoomRates(categories) {
  const flat = [];
  for (const category of categories) {
    const rates = Array.isArray(category.room_rate) ? category.room_rate : [];
    for (const rate of rates) {
      flat.push({
        id: rate.id,
        name: rate.name,
        categoryName: category.name,
      });
    }
  }
  return flat;
}

// ============================================================
// VERSI LAMA - EXACT MATCH SAJA (tidak diubah, tetap dipakai
// jalur Template & Excel import)
// ============================================================

async function resolveAgentId(agentName, token) {
  if (!agentName) return null;

  const list = await getAgentList(token);
  const target = String(agentName).trim().toLowerCase();

  const found = list.find(
    (item) => String(item.name || "").trim().toLowerCase() === target
  );

  if (!found) {
    console.log(`⚠️ Agent "${agentName}" tidak ditemukan (${list.length} data)`);
    return null;
  }

  return found.id;
}

async function resolveRoomRateIds(rates, token) {
  if (!Array.isArray(rates) || rates.length === 0) return [];

  const categories = await getRoomRateList(token);
  const flatRates = flattenRoomRates(categories);

  const resolvedIds = [];
  const missing = [];

  for (const item of rates) {
    const rateName = typeof item === "object" && item.rate ? item.rate : item;
    const target = String(rateName).trim().toLowerCase();

    if (target === "select all") {
      const categoryName =
        typeof item === "object" && item.category ? item.category : null;

      if (categoryName) {
        const categoryTarget = String(categoryName).trim().toLowerCase();
        const matchedCategory = categories.find(
          (c) => String(c.name || "").trim().toLowerCase() === categoryTarget
        );
        if (matchedCategory) {
          const catRates = Array.isArray(matchedCategory.room_rate)
            ? matchedCategory.room_rate
            : [];
          catRates.forEach((r) => resolvedIds.push(r.id));
          continue;
        }
      }
      missing.push(rateName);
      continue;
    }

    const found = flatRates.find(
      (opt) => String(opt.name || "").trim().toLowerCase() === target
    );

    if (found) {
      resolvedIds.push(found.id);
    } else {
      missing.push(rateName);
    }
  }

  if (missing.length > 0) {
    console.log("⚠️ RATE TIDAK DITEMUKAN:", missing);
  }

  return resolvedIds;
}

// ============================================================
// VERSI BARU - SMART RESOLVE (exact -> fuzzy -> ambigu)
// Dipakai jalur "Tanya Jawab" / input bebas dari chat.
// TIDAK memanggil LLM - cuma menyiapkan status utk tools/llmResolver.js
// ============================================================

/**
 * @returns {{status:"resolved", id, name} | {status:"ambiguous", candidates} | {status:"not_found"} | {status:"empty"}}
 */
async function resolveAgentSmart(agentName, token) {
  if (!agentName) return { status: "empty" };

  const list = await getAgentList(token);
  const target = String(agentName).trim().toLowerCase();

  // 1. Exact match dulu - paling cepat, paling aman, 0 biaya tambahan.
  const exact = list.find(
    (item) => String(item.name || "").trim().toLowerCase() === target
  );
  if (exact) return { status: "resolved", id: exact.id, name: exact.name };

  // 2. Fuzzy match - MASIH TANPA LLM.
  const result = findBestMatches(agentName, list, "name");

  if (result.status === "resolved") {
    return { status: "resolved", id: result.best.id, name: result.best.name };
  }
  if (result.status === "ambiguous") {
    return {
      status: "ambiguous",
      candidates: result.candidates.map((c) => ({ id: c.id, name: c.name })),
    };
  }
  return { status: "not_found" };
}

/**
 * Selalu mengembalikan array sepanjang input `rates`, urutan sama,
 * masing-masing berstatus resolved/ambiguous/not_found/select_all.
 */
async function resolveRoomRatesSmart(rates, token) {
  if (!Array.isArray(rates) || rates.length === 0) return [];

  const categories = await getRoomRateList(token);
  const flatRates = flattenRoomRates(categories);

  return rates.map((item) => {
    const rateName = typeof item === "object" && item.rate ? item.rate : item;
    const target = String(rateName).trim().toLowerCase();

    if (target === "select all") {
      const categoryName =
        typeof item === "object" && item.category ? item.category : null;
      const categoryTarget = categoryName
        ? String(categoryName).trim().toLowerCase()
        : null;
      const matchedCategory = categoryTarget
        ? categories.find(
            (c) => String(c.name || "").trim().toLowerCase() === categoryTarget
          )
        : null;

      if (matchedCategory) {
        const catRates = Array.isArray(matchedCategory.room_rate)
          ? matchedCategory.room_rate
          : [];
        return {
          status: "select_all",
          ids: catRates.map((r) => r.id),
          category: matchedCategory.name,
          original: item,
        };
      }
      return { status: "not_found", original: item };
    }

    // 1. Exact match
    const exact = flatRates.find(
      (opt) => String(opt.name || "").trim().toLowerCase() === target
    );
    if (exact) {
      return { status: "resolved", id: exact.id, name: exact.name, original: item };
    }

    // 2. Fuzzy match - TANPA LLM
    const fuzzy = findBestMatches(rateName, flatRates, "name");
    if (fuzzy.status === "resolved") {
      return {
        status: "resolved",
        id: fuzzy.best.id,
        name: fuzzy.best.name,
        original: item,
      };
    }
    if (fuzzy.status === "ambiguous") {
      return {
        status: "ambiguous",
        candidates: fuzzy.candidates.map((c) => ({ id: c.id, name: c.name })),
        original: item,
      };
    }
    return { status: "not_found", original: item };
  });
}

module.exports = {
  // versi lama (exact-only, dipakai Template & Excel)
  resolveAgentId,
  resolveRoomRateIds,
  clearResolverCache,
  getAgentList,
  getRoomRateList,
  // versi baru (smart, dipakai jalur Tanya Jawab)
  resolveAgentSmart,
  resolveRoomRatesSmart,
};