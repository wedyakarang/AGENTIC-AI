// // ======================================
// // RESOLVERS
// // Mengubah nama Agent / Rate menjadi UUID untuk payload
// // hotel-smart-promotion. Daftar di-cache di memori (sekali per
// // sesi login) dan tiap panggilan dicatat ke apiMonitor.
// //
// // PENTING - FIX RACE CONDITION (BARU): sebelumnya cache disimpan
// // sebagai VALUE (agentListCache = null lalu diisi array setelah fetch
// // selesai). Ini aman kalau dipanggil satu-satu, TAPI kalau banyak baris
// // (misal Import Excel 5 baris) di-resolve PARALEL (Promise.all), semua
// // baris sama-sama mengecek cache SEBELUM ada satupun yang selesai fetch
// // - jadi semuanya melihat cache kosong dan ikut fetch API sendiri-
// // sendiri (persis yang terjadi: 5 baris = 5x GET /agent-option, 5x GET
// // /hotel-room-type-rate-option).
// //
// // Sekarang cache menyimpan PROMISE-nya (bukan cuma hasil akhirnya).
// // Panggilan yang datang bersamaan otomatis "nebeng" ke Promise yang
// // sama yang sedang berjalan, bukan bikin fetch baru masing-masing.
// // Hasilnya: seberapa pun banyak baris/nama yang perlu di-resolve
// // paralel dalam satu sesi, GET /agent-option dan GET
// // /hotel-room-type-rate-option masing-masing HANYA terpanggil 1x total.
// //
// // resolveAgentId() / resolveRoomRateIds() = versi LAMA, EXACT MATCH
// // SAJA. TIDAK diubah/dihapus - tetap dipakai jalur Template & Excel
// // import yang datanya memang sudah presisi (dari form/spreadsheet).
// //
// // resolveAgentSmart() / resolveRoomRatesSmart() = versi BARU, dipakai
// // jalur "Tanya Jawab" (input bebas dari chat). Urutan resolusi:
// //   1. Exact match (persis seperti versi lama, paling cepat & aman)
// //   2. Fuzzy match via tools/matcher.js (TANPA LLM sama sekali)
// //   3. Kalau masih ambigu -> dikembalikan sebagai status "ambiguous"
// //      berisi daftar kandidat, untuk diputuskan oleh LLM SEKALI SAJA
// //      di tools/llmResolver.js (bukan loop chat panjang).
// // ======================================

// const { API_ORIGIN, ENDPOINTS } = require("./config");
// const { recordCall } = require("./monitor");
// const { findBestMatches } = require("./tools/matcher");

// // Menyimpan PROMISE yang sedang/sudah berjalan, bukan value langsung.
// // null = belum pernah ada permintaan fetch yang berjalan.
// let agentListPromise = null;
// let roomRateListPromise = null;

// function clearResolverCache() {
//   agentListPromise = null;
//   roomRateListPromise = null;
// }

// function authHeaders(token) {
//   return {
//     "Content-Type": "application/json",
//     Authorization: `Bearer ${token}`,
//   };
// }

// async function fetchAgentListFromApi(token) {
//   const label = `GET ${ENDPOINTS.AGENT_OPTION}`;
//   const start = Date.now();
//   let ok = false;
//   try {
//     const res = await fetch(`${API_ORIGIN}${ENDPOINTS.AGENT_OPTION}`, {
//       method: "GET",
//       headers: authHeaders(token),
//     });

//     if (!res.ok) {
//       throw new Error(`GAGAL AMBIL DAFTAR AGENT (HTTP ${res.status})`);
//     }

//     const json = await res.json();
//     const list = Array.isArray(json?.data) ? json.data : [];
//     ok = true;
//     return list;
//   } finally {
//     recordCall(label, { durationMs: Date.now() - start, success: ok });
//   }
// }

// async function getAgentList(token) {
//   // Kalau sudah ada Promise yang sedang/sudah berjalan (baik masih
//   // pending maupun sudah selesai), pakai itu - TIDAK fetch baru.
//   // Ini yang membuat panggilan paralel tetap cuma 1x request API,
//   // karena semua panggilan "menunggu" Promise yang sama.
//   if (agentListPromise) return agentListPromise;

//   agentListPromise = fetchAgentListFromApi(token);

//   try {
//     return await agentListPromise;
//   } catch (err) {
//     // Fetch gagal -> reset supaya percobaan BERIKUTNYA bisa fetch
//     // ulang (bukan terus-menerus mengembalikan error yang sama).
//     agentListPromise = null;
//     throw err;
//   }
// }

// async function fetchRoomRateListFromApi(token) {
//   const label = `GET ${ENDPOINTS.ROOM_RATE_OPTION}`;
//   const start = Date.now();
//   let ok = false;

//   try {
//     const res = await fetch(`${API_ORIGIN}${ENDPOINTS.ROOM_RATE_OPTION}`, {
//       method: "GET",
//       headers: authHeaders(token),
//     });

//     if (!res.ok) {
//       throw new Error(`GAGAL AMBIL DAFTAR RATE (HTTP ${res.status})`);
//     }

//     const json = await res.json();
//     const list = Array.isArray(json?.data) ? json.data : [];
//     ok = true;
//     return list;
//   } finally {
//     recordCall(label, { durationMs: Date.now() - start, success: ok });
//   }
// }

// async function getRoomRateList(token) {
//   if (roomRateListPromise) return roomRateListPromise;

//   roomRateListPromise = fetchRoomRateListFromApi(token);

//   try {
//     return await roomRateListPromise;
//   } catch (err) {
//     roomRateListPromise = null;
//     throw err;
//   }
// }

// function flattenRoomRates(categories) {
//   const flat = [];
//   for (const category of categories) {
//     const rates = Array.isArray(category.room_rate) ? category.room_rate : [];
//     for (const rate of rates) {
//       flat.push({
//         id: rate.id,
//         name: rate.name,
//         categoryName: category.name,
//       });
//     }
//   }
//   return flat;
// }

// // ============================================================
// // VERSI LAMA - EXACT MATCH SAJA (tidak diubah, tetap dipakai
// // jalur Template & Excel import)
// // ============================================================

// async function resolveAgentId(agentName, token) {
//   if (!agentName) return null;

//   const list = await getAgentList(token);
//   const target = String(agentName).trim().toLowerCase();

//   const found = list.find(
//     (item) => String(item.name || "").trim().toLowerCase() === target
//   );

//   if (!found) {
//     console.log(`⚠️ Agent "${agentName}" tidak ditemukan (${list.length} data)`);
//     return null;
//   }

//   return found.id;
// }

// async function resolveRoomRateIds(rates, token) {
//   if (!Array.isArray(rates) || rates.length === 0) return [];

//   const categories = await getRoomRateList(token);
//   const flatRates = flattenRoomRates(categories);

//   const resolvedIds = [];
//   const missing = [];

//   for (const item of rates) {
//     const rateName = typeof item === "object" && item.rate ? item.rate : item;
//     const target = String(rateName).trim().toLowerCase();

//     if (target === "select all") {
//       const categoryName =
//         typeof item === "object" && item.category ? item.category : null;

//       if (categoryName) {
//         const categoryTarget = String(categoryName).trim().toLowerCase();
//         const matchedCategory = categories.find(
//           (c) => String(c.name || "").trim().toLowerCase() === categoryTarget
//         );
//         if (matchedCategory) {
//           const catRates = Array.isArray(matchedCategory.room_rate)
//             ? matchedCategory.room_rate
//             : [];
//           catRates.forEach((r) => resolvedIds.push(r.id));
//           continue;
//         }
//       }
//       missing.push(rateName);
//       continue;
//     }

//     const found = flatRates.find(
//       (opt) => String(opt.name || "").trim().toLowerCase() === target
//     );

//     if (found) {
//       resolvedIds.push(found.id);
//     } else {
//       missing.push(rateName);
//     }
//   }

//   if (missing.length > 0) {
//     console.log("⚠️ RATE TIDAK DITEMUKAN:", missing);
//   }

//   return resolvedIds;
// }

// // ============================================================
// // VERSI BARU - SMART RESOLVE (exact -> fuzzy -> ambigu)
// // Dipakai jalur "Tanya Jawab" / input bebas dari chat.
// // TIDAK memanggil LLM - cuma menyiapkan status utk tools/llmResolver.js
// // ============================================================

// /**
//  * @returns {{status:"resolved", id, name} | {status:"ambiguous", candidates} | {status:"not_found"} | {status:"empty"}}
//  */
// async function resolveAgentSmart(agentName, token) {
//   if (!agentName) return { status: "empty" };

//   const list = await getAgentList(token);
//   const target = String(agentName).trim().toLowerCase();

//   // 1. Exact match dulu - paling cepat, paling aman, 0 biaya tambahan.
//   const exact = list.find(
//     (item) => String(item.name || "").trim().toLowerCase() === target
//   );
//   if (exact) return { status: "resolved", id: exact.id, name: exact.name };

//   // 2. Fuzzy match - MASIH TANPA LLM.
//   const result = findBestMatches(agentName, list, "name");

//   if (result.status === "resolved") {
//     return { status: "resolved", id: result.best.id, name: result.best.name };
//   }
//   if (result.status === "ambiguous") {
//     return {
//       status: "ambiguous",
//       candidates: result.candidates.map((c) => ({ id: c.id, name: c.name })),
//     };
//   }
//   return { status: "not_found" };
// }

// /**
//  * Selalu mengembalikan array sepanjang input `rates`, urutan sama,
//  * masing-masing berstatus resolved/ambiguous/not_found/select_all.
//  */
// async function resolveRoomRatesSmart(rates, token) {
//   if (!Array.isArray(rates) || rates.length === 0) return [];

//   const categories = await getRoomRateList(token);
//   const flatRates = flattenRoomRates(categories);

//   return rates.map((item) => {
//     const rateName = typeof item === "object" && item.rate ? item.rate : item;
//     const target = String(rateName).trim().toLowerCase();

//     if (target === "select all") {
//       const categoryName =
//         typeof item === "object" && item.category ? item.category : null;
//       const categoryTarget = categoryName
//         ? String(categoryName).trim().toLowerCase()
//         : null;
//       const matchedCategory = categoryTarget
//         ? categories.find(
//             (c) => String(c.name || "").trim().toLowerCase() === categoryTarget
//           )
//         : null;

//       if (matchedCategory) {
//         const catRates = Array.isArray(matchedCategory.room_rate)
//           ? matchedCategory.room_rate
//           : [];
//         return {
//           status: "select_all",
//           ids: catRates.map((r) => r.id),
//           category: matchedCategory.name,
//           original: item,
//         };
//       }
//       return { status: "not_found", original: item };
//     }

//     // 1. Exact match
//     const exact = flatRates.find(
//       (opt) => String(opt.name || "").trim().toLowerCase() === target
//     );
//     if (exact) {
//       return { status: "resolved", id: exact.id, name: exact.name, original: item };
//     }

//     // 2. Fuzzy match - TANPA LLM
//     const fuzzy = findBestMatches(rateName, flatRates, "name");
//     if (fuzzy.status === "resolved") {
//       return {
//         status: "resolved",
//         id: fuzzy.best.id,
//         name: fuzzy.best.name,
//         original: item,
//       };
//     }
//     if (fuzzy.status === "ambiguous") {
//       return {
//         status: "ambiguous",
//         candidates: fuzzy.candidates.map((c) => ({ id: c.id, name: c.name })),
//         original: item,
//       };
//     }
//     return { status: "not_found", original: item };
//   });
// }

// module.exports = {
//   // versi lama (exact-only, dipakai Template & Excel)
//   resolveAgentId,
//   resolveRoomRateIds,
//   clearResolverCache,
//   getAgentList,
//   getRoomRateList,
//   // versi baru (smart, dipakai jalur Tanya Jawab)
//   resolveAgentSmart,
//   resolveRoomRatesSmart,
// };


// ======================================
// RESOLVERS
// Mengubah nama Agent / Rate menjadi UUID untuk payload
// hotel-smart-promotion. Daftar di-cache di memori (sekali per
// sesi login) dan tiap panggilan dicatat ke apiMonitor.
//
// FIX RACE CONDITION: cache menyimpan PROMISE-nya (bukan cuma hasil
// akhirnya). Panggilan yang datang bersamaan otomatis "nebeng" ke
// Promise yang sama yang sedang berjalan, bukan bikin fetch baru
// masing-masing.
//
// UPDATE - STATISTIK GET SAAT CACHE HIT: getAgentList()/getRoomRateList()
// sekarang tetap memanggil recordCall() (dengan cached:true) walau
// tidak fetch API baru, supaya GET tetap muncul di statistik proses
// (formatStatsSummary() di monitor.js) walau datanya dari cache.
// Karena resolveAgentId()/resolveRoomRateIds()/resolveAgentSmart()/
// resolveRoomRatesSmart() masing-masing HANYA memanggil
// getAgentList()/getRoomRateList() SATU KALI per proses (dipanggil
// dari mapDataToApiPayload() satu kali per createPromotionOnce()),
// GET otomatis tercatat 1x per proses - berapa pun banyak rate yang
// di-resolve di dalam prosesnya (loop rate terjadi SETELAH list
// diambil, bukan memanggil getRoomRateList() berulang).
//
// resolveAgentId() / resolveRoomRateIds() = versi LAMA, EXACT MATCH
// SAJA. Dipakai jalur Template & Excel import.
//
// resolveAgentSmart() / resolveRoomRatesSmart() = versi BARU, dipakai
// jalur "Tanya Jawab" (input bebas dari chat).
// ======================================

// ======================================
// RESOLVERS
// Mengubah nama Agent / Rate menjadi UUID untuk payload
// hotel-smart-promotion. Daftar di-cache di memori (sekali per
// sesi login) dan tiap panggilan dicatat ke apiMonitor.
//
// FIX RACE CONDITION: cache menyimpan PROMISE-nya (bukan cuma hasil
// akhirnya). Panggilan yang datang bersamaan otomatis "nebeng" ke
// Promise yang sama yang sedang berjalan, bukan bikin fetch baru
// masing-masing.
//
// UPDATE - STATISTIK GET, 1x PER PROSES (bukan per baris/data):
// getAgentList()/getRoomRateList() sekarang memakai recordCallOnce()
// (monitor.js) - bukan recordCall() biasa - untuk mencatat GET.
// recordCallOnce() cuma mencatat SEKALI per siklus resetStats()
// (yaitu SEKALI per proses create-promotion / SEKALI per keseluruhan
// batch Import Excel, lihat monitor.js & telegram3.js), terlepas
// berapa kali getAgentList()/getRoomRateList() sungguhan dipanggil di
// dalam proses itu.
//
// Ini PENTING khusus untuk Import Excel: tiap baris Excel memanggil
// resolveAgentId()/resolveRoomRateIds() sendiri-sendiri (lewat
// createPromotionOnce() per baris) - jadi getAgentList() bisa
// terpanggil 5x kalau ada 5 baris. Sebelum fix ini, tiap dari 5
// panggilan itu tetap masuk ke statistik (baik sebagai fetch baru
// atau cache-hit), sehingga GET tercatat 5x. Sekarang, GET/endpoint
// yang sama HANYA tercatat 1x per keseluruhan proses, sementara POST
// (via recordCall() biasa di promotionAPI.js, TIDAK diubah) tetap
// tercatat 1x per baris - sesuai jumlah data yang benar-benar dikirim.
//
// resolveAgentId() / resolveRoomRateIds() = versi LAMA, EXACT MATCH
// SAJA. Dipakai jalur Template & Excel import.
//
// resolveAgentSmart() / resolveRoomRatesSmart() = versi BARU, dipakai
// jalur "Tanya Jawab" (input bebas dari chat).
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