// ======================================
  // GUESTPRO PROMOTION AUTOMATION
  // FINAL VERSION - RATES AFFECTED BUG FIX + FALLBACK MATCHING
  // + ALUR PROSES DIURUTKAN ULANG
  // + FIX: fallback split category/rate sekarang mengenali PIPE "|"
  // + MULTI PROMO CODE ("Add more promo code") & MULTI FORMULA
  //   ("Add More Formula") — nyambung dengan data.promoCodes[] /
  //   data.formulas[] yang dihasilkan parser (GROUPS: promoCode & formula).
  // + FIX v8: locator input Code/Max Used sekarang exclude input yang
  //   disabled, supaya kolom "Used" (read-only) di tabel promo code tidak
  //   ikut kehitung dan menggeser index baris ke-2 dst.
  // + FIX v9: SAVE DETECTION DIPERKUAT
  //   - Klik Save sekarang memvalidasi dulu tombol mana yang benar-benar
  //     visible & tidak disabled (log semua kandidat tombol "Save").
  //   - Menunggu response POST/PUT/PATCH ke endpoint promotion yang
  //     SPESIFIK terjadi setelah klik (bukan cuma listener global).
  //   - Listener response global sekarang juga mendeteksi payload yang
  //     "gagal secara logis" walau HTTP status 200 (mis. {success:false}).
  //   - Screenshot otomatis diambil saat kondisi akhir terdeteksi gagal.
  // + FIX v10 (VERSI INI): AUTO-RETRY SAAT PROMO_CODE DUPLIKAT
  //   - Referensi input Code disimpan (codeInputRefs) agar bisa diisi
  //     ulang tanpa perlu mencari elemen dari awal.
  //   - Saat response Save gagal SPESIFIK karena
  //     "promo_code [...] already exists", script otomatis menambah
  //     suffix unik ke SEMUA kode promo lalu klik Save ulang
  //     (maks 3 percobaan). Kode HANYA diubah kalau memang bentrok,
  //     jadi tidak merusak intent kode asli kalau tidak ada collision.
  // ======================================
  //
  // ALUR PROSES:
  //    1) Isi Nama (bahasa pertama)
  //    2) Promotion Type
  //    3) Code + Max Used (LOOP, klik "Add more promo code" utk entry ke-2 dst)
  //    4) Group (Travel Agency)
  //    5) Agent
  //    6) Description (bahasa pertama)
  //    7) Minimum Night
  //    8) Ganti Bahasa -> Indonesia
  //    9) Isi Nama lagi (bahasa Indonesia)
  //    10) Isi Description lagi (bahasa Indonesia)
  //    11) Lanjut: Rates Affected -> Formula (LOOP, klik "Add More Formula"
  //        utk entry ke-2 dst) -> Active -> Save (DENGAN VALIDASI RESPONSE
  //        + AUTO-RETRY JIKA PROMO CODE DUPLIKAT)
  // ======================================

  async function isiPromotion(page, data) {
    try {
      console.log("🚀 START PROMOTION");
      console.log("🔖 SCRIPT VERSION: v10-auto-retry-duplicate-promo-code");

      // ======================================
      // DATA PARSING
      // ======================================
      const nama = data.nama || data.name || "";
      const namaID = data.namaID || data.nama_id || data.namaIndonesia || nama;
      const type = data.type || "PROMO CODE";

      const promoCodes = (Array.isArray(data.promoCodes) && data.promoCodes.length > 0)
        ? data.promoCodes
        : [{ kode: data.kode || data.code || "", maxUsed: data.maxUsed || 1 }];

      const group = data.group || "";
      const agent = data.agent || "";
      const description = data.description || "-";
      const rates = Array.isArray(data.rates) ? data.rates : [data.rates];

      const formulas = (Array.isArray(data.formulas) && data.formulas.length > 0)
        ? data.formulas
        : [{
            formula: data.formula || "DECREASE",
            formulaType: data.formulaType || data.valueType || "AMOUNT",
            value: data.value || 0,
          }];

      const minimumNight = data.minimumNight || 1;

      console.log("📦 DATA PROMOTION", { nama, type, promoCodes, group, agent, description, rates, formulas, minimumNight });

      // ======================================
      // GUARD: VALIDASI DATA SEBELUM SENTUH BROWSER
      // ======================================
      const validationErrors = [];
      if (!nama) validationErrors.push("Nama kosong");
      if (!promoCodes.length || promoCodes.some(c => !c || !c.kode)) {
        validationErrors.push("Code/Kode kosong (minimal 1 kode promosi dengan field 'kode' harus diisi)");
      }
      if (!formulas.length || formulas.some(f => !f || !f.formula)) {validationErrors.push("Formula kosong (minimal 1 formula dengan field 'formula' harus diisi)");
      }
      if (!rates.length || rates.some(r => r === undefined || r === null || (typeof r === "object" && !r.rate))) {
        validationErrors.push("Rates kosong/tidak valid (field 'rates' harus array berisi {category, rate} atau string rate)");
      }
      if (validationErrors.length > 0) {
        const msg = "DATA TIDAK VALID, DIBATALKAN SEBELUM BUKA BROWSER: " + validationErrors.join("; ");
        console.log("❌ " + msg);
        console.log("🔎 DATA MENTAH YANG DITERIMA:", JSON.stringify(data));
        return { status: "error", message: msg, rawData: data };
      }

      // ======================================
      // TANGKAP RESPONSE API YANG GAGAL (mis. saat klik Save)
      // ======================================
      const failedApiResponses = [];
      page.on("response", async (response) => {
        try {
          const req = response.request();
          const method = req.method();
          const url = response.url();
          if ((method === "POST" || method === "PUT" || method === "PATCH") && /promotion/i.test(url)) {
            let bodyText = "";
            try { bodyText = (await response.text()).slice(0, 800); } catch (e) { }

            let parsed = null;
            try { parsed = JSON.parse(bodyText); } catch (e) { }
            const logicallyFailed = !!(parsed && (parsed.success === false || parsed.status === "error" || parsed.error));

            if (!response.ok() || logicallyFailed) {
              failedApiResponses.push({ url, status: response.status(), body: bodyText, logicallyFailed });
              console.log("❌ RESPONSE API GAGAL:", response.status(), url, "| logicallyFailed:", logicallyFailed, "| BODY:", bodyText);
            } else {
              console.log("✅ RESPONSE API OK:", response.status(), url);
            }
          }
        } catch (e) { }
      });

      // ======================================
      // OPEN GUESTPRO PAGE
      // ======================================
      console.log("🌐 OPEN GUESTPRO");
      await page.goto("https://demo-dashboard-merchant.guestpro.co.id/masterdata/v2/promotion/new", { waitUntil: "domcontentloaded", timeout: 120000 });
      await page.waitForTimeout(8000);
      console.log("✅ PAGE READY");

      // ======================================
      // HELPER SELECT VUE DROPDOWN
      // ======================================
      async function selectVueValue(label) {
        console.log("SELECT:", label);
        const dropdown = page.locator(".vs__dropdown-toggle");
        const total = await dropdown.count();
        console.log("TOTAL DROPDOWN:", total);
        for (let i = 0; i < total; i++) {
          try {
            await dropdown.nth(i).click({ force: true });
            await page.waitForTimeout(1000);
            const option = page.locator(".vs__dropdown-option:visible").filter({ hasText: label }).first();
            if (await option.count()) {
              await option.click({ force: true });
              console.log("✅ SELECT SUCCESS:", label, "INDEX:", i);
              return true;
            }
          } catch (e) { }
        }
        return false;
      }

      // ======================================
      // HELPER INPUT AUTOCOMPLETE FIELD
      // ======================================
      async function fillAutocompleteField(labelText, value) {
        console.log("ISI FIELD:", labelText, "=", value);
        if (!value) { console.log("ℹ️ SKIP (value kosong):", labelText); return false; }
        const fieldsets = page.locator("fieldset.form-group, .form-group").filter({ hasText: labelText });
        const totalFieldset = await fieldsets.count();
        console.log("KANDIDAT FIELD:", labelText, "=", totalFieldset);
        let input = null;
        for (let i = 0; i < totalFieldset; i++) {
          const candidate = fieldsets.nth(i).locator("input.vs__search, input[type='search'], input[type='text']").first();
          if (await candidate.count()) { input = candidate; console.log("✅ FIELD COCOK PADA INDEX:", i); break; }
        }
        if (!input) { console.log("⚠️ INPUT TIDAK DITEMUKAN:", labelText); return false; }await input.scrollIntoViewIfNeeded();
        await input.click({ force: true });
        await input.fill(value);
        await page.waitForTimeout(1500);
        const option = page.locator(".vs__dropdown-option:visible, .dropdown-item:visible, [role='option']:visible").filter({ hasText: value }).first();
        if (await option.count()) { try { await option.click({ force: true }); console.log("✅ SELECT DARI DROPDOWN:", labelText, "=", value); return true; } catch (e) { console.log("ℹ️ DROPDOWN GAGAL DIPILIH, PAKAI TEXT LANGSUNG:", labelText); } }
        await input.press("Tab");
        console.log("✅ ISI FIELD (free text):", labelText, "=", value);
        return true;
      }

      // ======================================
      // HELPER SELECT CALCULATE / VALUE TYPE
      // ======================================
      async function chooseFieldValue(label, value) {
        console.log("SET", label, ":", value);
        const field = page.locator(".form-group").filter({ hasText: label }).last();
        if (!(await field.count())) throw new Error("FIELD TIDAK ADA: " + label);
        const dropdown = field.locator(".vs__dropdown-toggle");
        await dropdown.click({ force: true });
        await page.waitForTimeout(1500);
        const options = page.locator(".vs__dropdown-option:visible");
        const total = await options.count();
        console.log("TOTAL OPTION", label, ":", total);
        let selected = false;
        for (let i = 0; i < total; i++) {
          const text = (await options.nth(i).innerText()).trim();
          console.log("OPTION", i, ":", text);
          if (text.toLowerCase().includes(value.toLowerCase())) { await options.nth(i).click({ force: true }); console.log("✅ OPTION TERPILIH:", text); selected = true; break; }
        }
        if (!selected) throw new Error("OPTION TIDAK DITEMUKAN: " + value);
        await page.waitForTimeout(1000);
        console.log("✅", label, "SELESAI");
      }

      // ======================================
      // HELPER: KLIK TOMBOL "Add more promo code" / "Add More Formula"
      // ======================================
      async function clickAddMoreButton(buttonText) {
        console.log("➕ KLIK TOMBOL:", buttonText);
        const btn = page.getByText(buttonText, { exact: true }).last();
        if (!(await btn.count())) {
          throw new Error("TOMBOL TIDAK DITEMUKAN: " + buttonText + " (cek apakah teks tombol di UI persis sama)");
        }
        await btn.scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        await btn.click({ force: true });
        await page.waitForTimeout(1500);
        console.log("✅ TOMBOL DIKLIK:", buttonText);
      }

      // ======================================
      // HELPER: RESOLVE LOCATOR MODAL BAHASA
      // ======================================
      async function resolveLangModal() {
        const candidates = [
          page.locator(".position-fixed.d-block").filter({ hasText: /language/i }),
          page.locator(".position-fixed.d-block"),
          page.locator(".modal.show").filter({ hasText: /language/i }),
          page.locator(".modal.show"),
        ];
        for (const c of candidates) {
          const loc = c.last();
          if (await loc.count()) {
            const visible = await loc.isVisible().catch(() => false);
            if (visible) return loc;
          }
        }
        return null;
      }

      // ======================================
      // HELPER: BUKA MODAL PEMILIH BAHASA UNTUK FIELD NAME
      // ======================================
      async function openLanguageSelector() {
        console.log("🌐 BUKA LANGUAGE SELECTOR (FIELD NAME)");

        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(800);

        const totalSwitcher = await page.locator(".img-lang-label").count();
        console.log("TOTAL .img-lang-label DITEMUKAN DI HALAMAN:", totalSwitcher);
        if (totalSwitcher === 0) {
          console.log("⚠️ LANGUAGE SWITCHER TIDAK DITEMUKAN");
          return false;
        }

        const alreadyOpen = await resolveLangModal();
        if (alreadyOpen) {
          console.log("✅ MODAL BAHASA SUDAH TERBUKA SEBELUMNYA, LANGSUNGPAKAI");
          return true;
        }

        const langSwitcher = page.locator(".img-lang-label").first();
        await langSwitcher.scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);

        await langSwitcher.evaluate((el) => el.click());

        for (let i = 0; i < 10; i++) {
          await page.waitForTimeout(500);
          if (await resolveLangModal()) {
            console.log("✅ LANGUAGE MODAL TERBUKA (percobaan ke-" + (i + 1) + ")");
            return true;
          }
        }

        console.log("⚠️ MODAL BAHASA TIDAK TERBUKA SETELAH KLIK");
        return false;
      }

      // ======================================
      // HELPER: PILIH OPSI BAHASA DI DALAM MODAL
      // ======================================
      async function pickLanguageOption(langKeyword = "indonesia") {
        let langModal = await resolveLangModal();
        for (let i = 0; i < 6 && !langModal; i++) {
          await page.waitForTimeout(500);
          langModal = await resolveLangModal();
        }
        if (!langModal) {
          console.log("❌ MODAL BAHASA TIDAK DITEMUKAN SAAT MAU PILIH OPSI");
          return false;
        }

        let option = langModal.locator(`img[src*='${langKeyword}']`).first();

        if (!(await option.count())) {
          const allFlags = langModal.locator("img");
          const totalFlags = await allFlags.count();
          console.log("TOTAL FLAG OPTION (fallback):", totalFlags);
          if (totalFlags >= 2) option = allFlags.nth(1);
        }

        if (await option.count()) {
          await option.scrollIntoViewIfNeeded();
          await page.waitForTimeout(300);
          await option.evaluate((el) => el.click());
          console.log("✅ LANGUAGE SELECTED:", langKeyword);
          await page.waitForTimeout(1500);

          const stillOpenModal = await resolveLangModal();
          if (stillOpenModal) {
            const closeBtn = stillOpenModal.locator("button.close, [class*='close']").last();
            if (await closeBtn.count()) {
              await closeBtn.evaluate((el) => el.click()).catch(() => {});
              await page.waitForTimeout(500);
            }
          }
          return true;
        }

        console.log("❌ OPSI BAHASA TIDAK DITEMUKAN:", langKeyword);
        return false;
      }

      // ======================================
      // HELPER: ISI ULANG FIELD NAME
      // ======================================
      async function fillNameField(value) {
        const nameTextarea = page.locator("textarea:visible").first();
        if (!(await nameTextarea.count())) {
          console.log("⚠️ TEXTAREA NAME TIDAK DITEMUKAN");
          return false;
        }
        await nameTextarea.scrollIntoViewIfNeeded();
        await nameTextarea.click({ force: true });
        await nameTextarea.press("Control+A");
        await nameTextarea.fill(value);
        await nameTextarea.press("Tab");
        console.log("✅ NAME (bahasa aktif) DIISI:", value);
        return true;
      }

      // ======================================
      // HELPER: NORMALISASI TEKS (untuk matching yang lebih toleran)
      // ======================================
      function normalizeText(str) {
        return String(str || "").replace(/\s+/g, " ").trim().toLowerCase();
      }

      // ======================================
      // HELPER: CARI TAB KATEGORI DENGAN EXACT MATCH DULU
      // ======================================
      async function findCategoryTab(rateModal, category) {
        const candidates = rateModal.locator(".nav-link").filter({ hasText: category });
        const total = await candidates.count();
        let exactMatch = null;
        let fallback = null;
        for (let i = 0; i < total; i++) {
          const el = candidates.nth(i);
          const text = (await el.innerText().catch(() => ""));
          if (!fallback) fallback = el;
          if (normalizeText(text) === normalizeText(category)) {
            exactMatch = el;
            break;
          }
        }
        if (exactMatch) return { tab: exactMatch, exact: true };
        if (fallback) return { tab: fallback, exact: false };
        return { tab: null, exact: false };
      }

      // ======================================
      // HELPER:DUMP SEMUA TEKS RATE YANG TERSEDIA DI TAB AKTIF
      // ======================================
      async function dumpAvailableRates(rateModal) {
        try {
          const candidateSelectors = [".rate-item", ".list-group-item", "li", ".card", ".form-check-label"];
          for (const sel of candidateSelectors) {
            const els = rateModal.locator(sel + ":visible");
            const total = await els.count();
            if (total > 0) {
              const texts = [];
              for (let i = 0; i < Math.min(total, 100); i++) {
                const t = (await els.nth(i).innerText().catch(() => "")).replace(/\s+/g, " ").trim();
                if (t) texts.push(t);
              }
              if (texts.length) {
                console.log(`ℹ️ DAFTAR RATE TERSEDIA DI TAB INI (via selector "${sel}"):`, texts);
                return;
              }
            }
          }
          console.log("ℹ️ TIDAK BISA MEN-DUMP DAFTAR RATE (selector diagnosa tidak menemukan elemen apapun, cek struktur DOM modal secara manual)");
        } catch (e) {
          console.log("ℹ️ GAGAL DUMP DAFTAR RATE:", e.message);
        }
      }

      // ======================================
      // HELPER: CARI RATE VISIBLE DENGAN POLLING + FALLBACK MATCHING
      // ======================================
      async function findVisibleRate(rateModal, rateName, maxRetry = 10, intervalMs = 500) {
        for (let attempt = 0; attempt < maxRetry; attempt++) {
          const rateCandidates = rateModal.getByText(rateName, { exact: true });
          const totalRateCandidates = await rateCandidates.count();
          for (let i = 0; i < totalRateCandidates; i++) {
            const candidate = rateCandidates.nth(i);
            if (await candidate.isVisible().catch(() => false)) {
              return { rate: candidate, totalCandidates: totalRateCandidates, attempts: attempt + 1, method: "exact" };
            }
          }
          await rateModal.page().waitForTimeout(intervalMs);
        }

        const looseCandidates = rateModal.getByText(rateName, { exact: false });
        const looseTotal = await looseCandidates.count();
        const targetNorm = normalizeText(rateName);
        for (let i = 0; i < looseTotal; i++) {
          const candidate = looseCandidates.nth(i);
          const text = await candidate.innerText().catch(() => "");
          if (normalizeText(text) === targetNorm && (await candidate.isVisible().catch(() => false))) {
            console.log("⚠️ RATE DITEMUKAN VIA NORMALIZED MATCH (bukan exact):", rateName, "| TEKS ELEMEN:", text.trim());
            return { rate: candidate, totalCandidates: looseTotal, attempts: maxRetry, method: "normalized" };
          }
        }

        for (let i = 0; i < looseTotal; i++) {
          const candidate = looseCandidates.nth(i);
          const text = await candidate.innerText().catch(() => "");
          const textNorm = normalizeText(text);
          if (!textNorm) continue;
          const partialHit = textNorm.includes(targetNorm) || targetNorm.includes(textNorm);
          if (partialHit && (await candidate.isVisible().catch(() => false))) {
            console.log("⚠️ RATE DITEMUKAN VIA PARTIAL MATCH (kemungkinan typo/beda penamaan):", rateName, "| TEKS ELEMEN ASLI:", text.trim(), "- MOHON CEK & SAMAKAN DATA SOURCE.");
            return { rate: candidate, totalCandidates: looseTotal, attempts: maxRetry, method: "partial" };
          }
        }

        const finalCandidates = rateModal.getByText(rateName, { exact: true });
        const finalTotal = await finalCandidates.count();
        console.log("❌ RATE TIDAK DITEMUKAN SAMA SEKALI (exact/normalized/partial):", rateName);
        await dumpAvailableRates(rateModal);
        return { rate: null, totalCandidates: finalTotal, attempts: maxRetry, method: "none" };
      }

      // ======================================
      // 1) NAME (BAHASA PERTAMA / INGGRIS)
      // ======================================
      console.log("📝 ISI NAME (BAHASA PERTAMA)");
      await fillNameField(nama);

      // ======================================
      // 2) PROMOTION TYPE
      // ======================================
      console.log("🎯 SETPROMOTION TYPE");
      const typeSelected = await selectVueValue(type);
      if (!typeSelected) throw new Error(type + " tidak ditemukan");
      await page.waitForTimeout(3000);
      console.log("✅ PROMOTION TYPE AKTIF");

      // ======================================
      // 3) CODE & MAX USED — LOOP MULTI PROMO CODE
      // FIX v10: simpan referensi tiap input Code (codeInputRefs) supaya
      // bisa diisi ulang tanpa cari elemen dari awal, dipakai saat
      // auto-retry akibat promo_code duplikat di tahap Save nanti.
      // ======================================
      console.log("🔢 SET PROMO CODE (" + promoCodes.length + " kode)");
      const codeInputRefs = []; // [{ input, kode }]
      for (let i = 0; i < promoCodes.length; i++) {
        const entry = promoCodes[i] || {};
        const kode = entry.kode || entry.code || "";
        const maxUsed = entry.maxUsed || 1;

        if (i > 0) {
          await clickAddMoreButton("Add more promo code");
        }

        const rowInputs = page.locator("input[type='text']:visible:not([disabled])");
        const totalRowInputs = await rowInputs.count();
        const expectedTotal = (i + 1) * 2;
        if (totalRowInputs < expectedTotal) {
          throw new Error(
            `INPUT CODE/MAX USED UNTUK BARIS KE-${i + 1} TIDAK DITEMUKAN ` +
            `(butuh minimal ${expectedTotal} input text visible & enabled, yang ada cuma ${totalRowInputs}). ` +
            `Kemungkinan tombol "Add more promo code" belum menambah baris baru, atau markup GuestPro berubah.`
          );
        }

        const codeInput = rowInputs.nth(expectedTotal - 2);
        const maxUsedInput = rowInputs.nth(expectedTotal - 1);
        await codeInput.scrollIntoViewIfNeeded();
        await codeInput.fill(String(kode));
        await codeInput.press("Tab");
        await maxUsedInput.fill(String(maxUsed));
        await maxUsedInput.press("Tab");

        codeInputRefs.push({ input: codeInput, kode: String(kode) }); // <-- TAMBAHAN v10
        console.log(`✅ CODE[${i}]:`, kode, "| MAX USED:", maxUsed);
      }

      // ======================================
      // GROUP & AGENT
      // ======================================
      await fillAutocompleteField("Travel Agency", group);
      await fillAutocompleteField("Agent", agent);

      // ======================================
      // DESCRIPTION (BAHASA PERTAMA)
      // ======================================
      const areas = page.locator("textarea:visible");
      if (await areas.count() > 1) { await areas.last().fill(description); await areas.last().press("Tab"); console.log("✅ DESCRIPTION (bahasa pertama):", description); }

      // ======================================
      // MINIMUM NIGHT
      // ======================================
      console.log("🌙 SET MINIMUM NIGHT:", minimumNight);

      const minNightInput = page.locator(".form-group").filter({ hasText: "Minimum Night" }).locator("input").first();

      if (await minNightInput.count()) {
        await minNightInput.scrollIntoViewIfNeeded();
        await minNightInput.click({ force: true });
        await minNightInput.press("Control+A");
        await minNightInput.fill(String(minimumNight));
        await minNightInput.press("Tab");
        await page.waitForTimeout(2000);
        console.log("✅ MINIMUM NIGHT:", minimumNight);
      } else {
        throw new Error("INPUT MINIMUM NIGHT TIDAK DITEMUKAN");
      }

      // ======================================
      // GANTI BAHASA NAME -> INDONESIA
      // ======================================
      console.log("🇮🇩 GANTI BENDERA NAME KE INDONESIA");
      const langSwitcherOpened = await openLanguageSelector();
      if (!langSwitcherOpened) {
        throw new Error("GAGAL BUKA LANGUAGE SELECTOR UNTUK FIELD NAME");
      }
      const langPicked = await pickLanguageOption("indonesia");
      if (!langPicked) {
        throw new Error("GAGAL MEMILIH BAHASA INDONESIA PADA MODAL");
      }

      // ======================================
      // ISI NAME LAGI (BAHASA INDONESIA)
      // ======================================
      const namaKeduaTerisi = await fillNameField(namaID);
      if (!namaKeduaTerisi) {
        throw new Error("GAGALMENGISI NAME UNTUK KALI KE-2 (BAHASA INDONESIA)");
      }
      console.log("✅ BAHASA SUDAH DIGANTI & NAME SUDAH DIISI 2 KALI");

      // ======================================
      // ISI DESCRIPTION LAGI (BAHASA INDONESIA)
      // ======================================
      const descriptionID = data.descriptionID || data.description_id || description;
      const areasAfterLang = page.locator("textarea:visible");
      if (await areasAfterLang.count() > 1) {
        await areasAfterLang.last().fill(descriptionID);
        await areasAfterLang.last().press("Tab");
        console.log("✅ DESCRIPTION (bahasa Indonesia):", descriptionID);
      } else {
        console.log("⚠️ TEXTAREA DESCRIPTION TIDAK DITEMUKAN SAAT PENGISIAN KE-2");
      }

      // ======================================
      // RATES AFFECTED
      // ======================================
      console.log("🏨 SET RATES AFFECTED");
      const RATE_MODAL_SELECTOR = ".modal.show";
      const chooseRatesBtn = page.getByText("Choose Rates", { exact: true }).first();
      if (await chooseRatesBtn.count()) { await chooseRatesBtn.click({ force: true }); await page.waitForTimeout(3000); }
      const rateModal = page.locator(RATE_MODAL_SELECTOR).last();
      await rateModal.waitFor({ state: "visible", timeout: 10000 });

      let lastCategoryClicked = null;
      const missingRates = [];

      for (const item of rates) {
        let rateName = typeof item === "object" && item.rate ? item.rate : item;
        let category = typeof item === "object" && item.category ? item.category : null;

        if (!category && typeof rateName === "string" && /[|\-–—]/.test(rateName)) {
          const parts = rateName.split(/\s*[|\-–—]\s*/);
          if (parts.length === 2) {
            category = parts[0].trim();
            rateName = parts[1].trim();
            console.log("ℹ️ RATE STRING DIPECAH -> CATEGORY:", category, "| RATE:", rateName);
          } else {
            console.log("⚠️ RATE STRING PUNYA PEMISAH TAPI JUMLAH BAGIAN ≠ 2, TIDAK DIPECAH:", rateName);
          }
        }

        if (category && category !== lastCategoryClicked) {
          const { tab, exact } = await findCategoryTab(rateModal, category);
          if (tab) {
            await tab.click({ force: true });
            await page.waitForTimeout(2000);
            console.log("✅ CATEGORY SELECT:", category, "(EXACT MATCH:", exact, ")");
            if (!exact) {
              console.log("⚠️ PERINGATAN: tidak ditemukan tab dengan teks PERSIS '" + category + "', pakai kandidat substring pertama. Cek manual apakah tab yang terklik benar.");
            }
            lastCategoryClicked = category;
          } else {
            console.log("❌ CATEGORY TAB TIDAK DITEMUKAN:", category);
          }
        }

        const { rate, totalCandidates, attempts, method } = await findVisibleRate(rateModal, rateName);

        if (rate) {
          await rate.scrollIntoViewIfNeeded();
          await rate.click({ force: true });
          await page.waitForTimeout(1000);
          console.log("✅ RATE CLICK:", rateName, "(ditemukan setelah", attempts, "percobaan, method:", method, ")");
        } else {
          console.log("❌ RATE TIDAK ADA (VISIBLE):", rateName, "- TOTAL KANDIDAT DI DOM:", totalCandidates, "- SETELAH", attempts, "PERCOBAAN");
          missingRates.push({ category, rateName });
        }
      }

      const submitRate = rateModal.locator("button").filter({ hasText: /Submit/i }).last();
      if (await submitRate.count()) { await submitRate.scrollIntoViewIfNeeded(); await page.waitForTimeout(1000); await submitRate.click({ force: true }); console.log("✅ RATE SUBMIT SUCCESS"); } else { throw new Error("BUTTON SUBMIT RATE TIDAK ADA"); }
      await page.waitForTimeout(3000);

      // ======================================
      // FORMULA — LOOP MULTI FORMULA
      // ======================================
      console.log("⚙️ SET FORMULA (" + formulas.length + ")");
      for (let i = 0; i < formulas.length; i++) {
        const f = formulas[i] || {};
        const formula = f.formula || "DECREASE";
        const formulaType = f.formulaType || f.valueType || "AMOUNT";
        const value = f.value || 0;if (i > 0) {
          await clickAddMoreButton("Add More Formula");
        }

        await chooseFieldValue("Calculate by", formula);
        await chooseFieldValue("Value Type", formulaType);

        const formulaInput = page.locator(".form-group").filter({ hasText: "Value" }).last().locator("input");
        if (await formulaInput.count()) {
          await formulaInput.click({ force: true });
          await formulaInput.fill(String(value));
          await formulaInput.press("Tab");
          console.log(`✅ FORMULA[${i}]:`, formula, "/", formulaType, "/ VALUE:", value);
        } else {
          console.log(`⚠️ VALUE INPUT TIDAK DITEMUKAN UNTUK FORMULA[${i}]`);
        }
      }

      // ======================================
      // ACTIVE CHECKBOX
      // ======================================
      console.log("☑ SET ACTIVE");
      const activeLabel = page.getByText("Active", { exact: true }).last();
      if (await activeLabel.count()) { await activeLabel.scrollIntoViewIfNeeded(); await activeLabel.click({ force: true }); await page.waitForTimeout(1000); console.log("✅ ACTIVE SELECTED"); } else { console.log("⚠️ ACTIVE LABEL TIDAK DITEMUKAN"); }

      // ======================================
      // SAVE PROMOTION
      // FIX v10: setelah validasi tombol Save yang benar-benar visible &
      // tidak disabled, klik Save dibungkus dalam loop retry (maks 3x).
      // Kalau response gagal SPESIFIK karena "promo_code [...] already
      // exists", script otomatis menambah suffix unik ke SEMUA kode promo
      // (via codeInputRefs) lalu klik Save ulang. Kalau gagal karena hal
      // lain (bukan duplicate), retry loop langsung berhenti seperti biasa.
      // ======================================
      console.log("💾 SAVE PROMOTION");

      const allSaveButtons = page.locator("button").filter({ hasText: /Save/i });
      const totalSaveButtons = await allSaveButtons.count();
      console.log("🔎 TOTAL TOMBOL 'Save' DITEMUKAN:", totalSaveButtons);

      let saveButton = null;
      for (let i = 0; i < totalSaveButtons; i++) {
        const btn = allSaveButtons.nth(i);
        const isVisible = await btn.isVisible().catch(() => false);
        const isDisabled = await btn.isDisabled().catch(() => true);
        const text = (await btn.innerText().catch(() => "")).trim();
        console.log(`   [${i}] text="${text}" visible=${isVisible} disabled=${isDisabled}`);
        if (isVisible && !isDisabled) {
          saveButton = btn; // ambil kandidat valid TERAKHIR
        }
      }

      if (!saveButton) {
        throw new Error(
          "SAVE BUTTON TIDAK DITEMUKAN ATAU SEMUA KANDIDAT DISABLED/HIDDEN " +
          "(cek log '🔎 TOTAL TOMBOL Save' di atas untuk detail tiap kandidat)"
        );
      }

      await saveButton.scrollIntoViewIfNeeded();
      await page.waitForTimeout(1000);

      const MAX_SAVE_RETRY = 3;
      let saveClickHadNoRequest = false;
      let saveResponseLooksFailed = false;
      let saveResponseSummary = null;
      let duplicateCodeRetryUsed = false;

      for (let attempt = 1; attempt <= MAX_SAVE_RETRY; attempt++) {
        const waitForSaveResponse = page.waitForResponse(
          (res) => {
            const req = res.request();
            return (
              ["POST", "PUT", "PATCH"].includes(req.method()) &&
              /promotion/i.test(res.url())
            );
          },
          { timeout: 20000 }
        ).then(async (res) => {
          let body = "";
          try { body = (await res.text()).slice(0, 1000); } catch (e) { }
          return { url: res.url(), status: res.status(), ok: res.ok(), body };
        }).catch(() => null);

        await saveButton.click({ force: true });
        console.log(`✅ SAVE DIKLIK (percobaan ke-${attempt})`);

        const responseAfterSave = await waitForSaveResponse;
        saveClickHadNoRequest = !responseAfterSave;
        saveResponseLooksFailed = false;

        if (!responseAfterSave) {
          console.log("❌ TIDAK ADA REQUEST POST/PUT/PATCH ke endpoint promotion terdeteksi dalam 20 detik setelah klik Save — kemungkinan klik tidak ter-handle (tombol salah/disabled secara Vue, atau ada overlay/modal lain yang menutupi tombol).");
          break; // bukankasus duplicate code, hentikan retry
        }

        console.log("📨 RESPONSE SETELAH SAVE:", JSON.stringify(responseAfterSave));
        let parsedBody = null;
        try { parsedBody = JSON.parse(responseAfterSave.body); } catch (e) { }
        saveResponseLooksFailed = !responseAfterSave.ok || !!(parsedBody && (parsedBody.success === false || parsedBody.status === "error" || parsedBody.error));
        saveResponseSummary = responseAfterSave;

        if (!saveResponseLooksFailed) {
          console.log("✅ RESPONSE SAVE TERLIHAT SUKSES (HTTP", responseAfterSave.status, ")");
          break; // sukses, keluar dari retry loop
        }

        console.log("❌ RESPONSE SAVE MENANDAKAN GAGAL (HTTP status atau payload):", responseAfterSave);

        const isDuplicateCodeError = /already exists/i.test(responseAfterSave.body) && /promo_code/i.test(responseAfterSave.body);

        if (!isDuplicateCodeError) {
          console.log("ℹ️ KEGAGALAN BUKAN KARENA PROMO_CODE DUPLIKAT — TIDAK DI-RETRY.");
          break;
        }

        if (attempt === MAX_SAVE_RETRY) {
          console.log("⚠️ SUDAH MENCAPAI BATAS MAKSIMAL RETRY (" + MAX_SAVE_RETRY + "x) UNTUK PROMO_CODE DUPLIKAT, MENYERAH.");
          break;
        }

        console.log("♻️ TERDETEKSI PROMO_CODE DUPLIKAT — GENERATE KODE BARU & ULANGI SAVE...");
        duplicateCodeRetryUsed = true;

        // FIX: server hanya menerima huruf & angka (alphanumeric) untuk
        // promo_code — TIDAK BOLEH ada "-" atau karakter simbol lain,
        // makanya suffix di bawah ini murni alphanumeric (tanpa strip).
        const suffix = Date.now().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(-4);
        for (const ref of codeInputRefs) {
          // sanitize juga kode lama, jaga-jaga ada karakter non-alphanumeric
          // yang lolos dari input awal (spasi, strip, dsb).
          const cleanBase = ref.kode.replace(/[^A-Za-z0-9]/g, "");
          ref.kode = cleanBase + suffix;
          await ref.input.fill(ref.kode);
          await ref.input.press("Tab");
          console.log("🔁 KODE DIGANTI JADI:", ref.kode);
        }
        await page.waitForTimeout(1000);
      }

      // ======================================
      // WAIT & RESULT CHECK
      // ======================================
      await page.waitForTimeout(10000);
      const finalUrl = page.url();

      const errorsRaw = await page.locator(
        ".text-danger:visible, .invalid-feedback:visible, .toast-message:visible, .Vue-Toastification__toast:visible, .Vue-Toastification__toast-body:visible, .swal2-html-container:visible, .swal2-title:visible, [role='alert']:visible, .alert-danger:visible, .alert:visible"
      ).allTextContents();
      const errors = errorsRaw
        .map(e => e.replace(/\s+/g, " ").trim())
        .filter(e => e.length > 0 && e !== "*" && e.toLowerCase() !== "x");

      console.log("FINAL URL:", finalUrl);
      console.log("FINAL ERRORS (DOM):", errors);
      if (failedApiResponses.length > 0) {
        console.log("FINAL ERRORS (API RESPONSE):", failedApiResponses);
      }
      if (missingRates.length > 0) {
        console.log("⚠️ RATE YANG TIDAK BERHASIL DIPILIH:", missingRates);
      }
      if (duplicateCodeRetryUsed) {
        console.log("ℹ️ CATATAN: Promo code sempat diganti otomatis karena duplikat. Kode akhir yang dipakai:", codeInputRefs.map(r => r.kode));
      }

      const apiErrorMessages = failedApiResponses.map(r => `[HTTP ${r.status}] ${r.body}`);
      const allErrors = [...errors, ...apiErrorMessages];

      const definitelyFailed =
        saveClickHadNoRequest ||
        saveResponseLooksFailed ||
        allErrors.length > 0;

      if (definitelyFailed) {
        let screenshotPath = null;
        try {
          screenshotPath = `/tmp/promotion-gagal-${Date.now()}.png`;
          await page.screenshot({ path: screenshotPath, fullPage: true });
          console.log("📸 SCREENSHOT DIAMBIL untuk debugging kegagalan save:", screenshotPath);
        } catch (e) {
          console.log("⚠️ GAGAL AMBIL SCREENSHOT:", e.message);
        }

        let message;
        if (saveClickHadNoRequest) {
          message = "Promotion gagal disimpan: klik tombol Save tidak memicurequest apapun ke server (kemungkinan tombol salah/disabled, atau ada overlay/modal lain menutupi tombol).";
        } else if (allErrors.length > 0) {
          message = "Promotion gagal disimpan: " + allErrors[0];
        } else {
          message = "Promotion gagal disimpan: response server menandakan gagal - " + JSON.stringify(saveResponseSummary);
        }

        return {
          status: "error",
          message,
          url: finalUrl,
          errors: allErrors,
          missingRates,
          saveClickHadNoRequest,
          saveResponseSummary,
          duplicateCodeRetryUsed,
          finalCodes: codeInputRefs.map(r => r.kode),
          screenshotPath,
        };
      }

      if (finalUrl.includes("/promotion/new")) {
        console.log("ℹ️ CATATAN: URL masih di /promotion/new tapi response Save terlihat sukses dan tidak ada error DOM/API — kemungkinan GuestPro memang tidak redirect setelah save sukses.");
      }

      return {
        status: "success",
        message: "Promotion berhasil dibuat",
        url: finalUrl,
        missingRates,
        saveResponseSummary,
        duplicateCodeRetryUsed,
        finalCodes: codeInputRefs.map(r => r.kode),
      };

    } catch (error) {
      console.log("❌ ISI PROMOTION ERROR:", error.message);
      return { status: "error", message: error.message };
    }
  }

  // ======================================
  // EXPORT MODULE
  // ======================================
  module.exports = { isiPromotion };