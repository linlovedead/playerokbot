(function () {
    // v6.7: GLOBAL TRY-CATCH WRAPPER
    try {
        // Повторный executeScript('content.js') из background — не вешать второй onMessage
        if (window.__playerokBoostContentGuard) return;
        window.__playerokBoostContentGuard = true;

        console.log("🔄 Content script init...");
        window.hasPlayerokBot = true;

        if (typeof window.workInProgress === 'undefined') window.workInProgress = false;

        let shouldStop = false;
        let isScanning = false;

        function log(msg) {
            if (shouldStop) return;
            console.log(`[Bot] ${msg}`);
            try {
                chrome.runtime.sendMessage({ action: 'LOG', message: msg }).catch(() => { });
            } catch (e) { }
        }

        function criticalLog(msg) {
            console.log(`[Bot] ${msg}`);
            try {
                chrome.runtime.sendMessage({ action: 'LOG', message: msg }).catch(() => { });
            } catch (e) { }
        }

        function updateStatus(mode) {
            try {
                chrome.runtime.sendMessage({ action: 'UPDATE_MODE', mode: mode }).catch(() => { });
            } catch (e) { }
        }

        const wait = (ms) => new Promise(resolve => {
            if (shouldStop) { resolve(); return; }
            setTimeout(resolve, ms);
        });

        const random = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

        async function surgicalClick(element) {
            if (!element) return;
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await wait(200 + Math.floor(Math.random() * 300));
            element.style.border = '5px solid red';
            log("[surgicalClick] Цель подсвечена красным. Жму...");
            await wait(200);
            element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            await wait(100);
            element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            await wait(100);
            element.click();
            await wait(50);
        }

        async function robustClick(element) {
            if (!element) return;
            element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await wait(200);
            element.click();
        }

        // === SCOUT MODE ===
        async function scanItems(depthHint = 0) {
            shouldStop = false;
            isScanning = true;
            updateStatus("Сбор товаров...");
            // depthHint grows with each empty scan: 0→5 clicks, 1→10, 2→15... max 30
            const MAX_SHOW_MORE = Math.min(5 + depthHint * 5, 30);
            criticalLog(`🔍 Scout: фаза 1, лимит 'Показать ещё': ${MAX_SHOW_MORE} кликов...`);
            if (typeof document !== 'undefined' && document.hidden) {
                criticalLog("⚠️ Вкладка в фоне: Chrome замедляет скан. Переключись на товары или включи «Фокус на вкладку товаров» в настройках автопубликации.");
            }

            const startTime = Date.now();
            const MAX_SCAN_TIME = 120000;
            let showMoreClicks = 0;
            let lastHeight = 0;
            let sameHeightCount = 0;


            // === PHASE 1: Scroll the entire page, clicking "Показать ещё" ===
            // Do NOT send any items yet — just load all content
            while (isScanning && !shouldStop) {
                if (Date.now() - startTime > MAX_SCAN_TIME) break;

                const currentHeight = document.body.scrollHeight;

                // Find the "Show More" button (both ещё and еще variants)
                const showMore = Array.from(document.querySelectorAll('button, a, [role="button"]')).find(b => {
                    const t = b.textContent.toLowerCase();
                    return t.includes('показать') && (t.includes('ещё') || t.includes('еще') || t.includes('more'));
                });

                if (showMore) {
                    showMoreClicks++;
                    if (showMoreClicks > MAX_SHOW_MORE) {
                        criticalLog(`✅ Фаза 1: достигнут лимит (${MAX_SHOW_MORE} кликов 'Показать ещё').`);
                        break;
                    }
                    criticalLog(`🔽 Нашел 'Показать ещё' (${showMoreClicks}/${MAX_SHOW_MORE}). Кликаю...`);
                    showMore.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    await wait(random(800, 1500));
                    showMore.click();
                    await wait(random(2500, 4000));
                    lastHeight = 0;
                    sameHeightCount = 0;
                    continue;
                }

                if (currentHeight === lastHeight) {
                    sameHeightCount++;
                    if (sameHeightCount >= 4) {
                        criticalLog("✅ Фаза 1 завершена (конец страницы).");
                        break;
                    }
                    window.scrollBy({ top: -random(150, 300), behavior: 'smooth' });
                    await wait(random(500, 1000));
                    window.scrollBy({ top: random(400, 800), behavior: 'smooth' });
                } else {
                    sameHeightCount = 0;
                    lastHeight = currentHeight;
                    window.scrollBy({ top: random(600, 1000), behavior: 'smooth' });
                }

                await wait(random(1200, 2500));
            }

            if (shouldStop) {
                chrome.runtime.sendMessage({ action: 'FOUND_ITEMS', items: [] });
                return;
            }

            // === PHASE 2: Collect matching items from fully loaded page ===
            const includeDrafts = !!window.__autoBoostIncludeDrafts;
            criticalLog(`🔍 Фаза 2: сбор карточек${includeDrafts ? ' (истёкшие + черновики)' : ' (только истёкшие)'}...`);

            const expiredKeywords = ['истек срок', 'истёк срок', 'expired', 'продан', 'sold'];
            const draftKeywords = ['черновик', 'draft'];
            const excludeKeywords = ['премиум'];
            const excludeEmoji = '🚀';
            const allItems = [];

            // Extract UUIDs from Apollo Cache via content_bridge_main.js (world:MAIN)
            // Используем postMessage вместо inline-скрипта (CSP блокирует inline)
            let uuidMap = {};
            try {
                uuidMap = await new Promise((resolve) => {
                    const scriptId = 'apollo-extractor-' + Date.now();
                    const handler = (event) => {
                        if (event.data && event.data.action === 'APOLLO_UUID_MAP' && event.data.scriptId === scriptId) {
                            window.removeEventListener('message', handler);
                            resolve(event.data.map || {});
                        }
                    };
                    window.addEventListener('message', handler);
                    // content_bridge_main.js (world:MAIN) слушает этот запрос и отвечает с данными Apollo
                    window.postMessage({ action: 'APOLLO_UUID_MAP_REQUEST', scriptId: scriptId }, '*');
                    setTimeout(() => { window.removeEventListener('message', handler); resolve({}); }, 2000);
                });
            } catch (e) { console.error("AutoBump: Apollo extract failed", e); }

            const allLinks = document.querySelectorAll('a[href*="/products/"], a[href*="/item/"]');
            for (let link of allLinks) {
                let parent = link.parentElement;
                let foundKeyword = false;
                let shouldExclude = false;

                if (link.innerHTML.includes(excludeEmoji) || link.querySelector('img[src*="Rocket"], img[src*="rocket"]')) {
                    shouldExclude = true;
                }

                // Determine the card container. Go up to 10 levels up to cover thick DOM structures
                for (let k = 0; k < 10; k++) {
                    if (!parent || parent.tagName === 'BODY' || parent.tagName === 'MAIN') break;

                    // Boundary check: if this parent contains links to OTHER products, we've hit the grid! Stop here.
                    const uniqueHrefs = new Set();
                    const relatedLinks = parent.querySelectorAll('a[href*="/products/"], a[href*="/item/"]');
                    relatedLinks.forEach(lh => uniqueHrefs.add(lh.href.split('?')[0]));
                    if (uniqueHrefs.size > 1) break;
                    const text = parent.textContent.toLowerCase();
                    if (expiredKeywords.some(kw => text.includes(kw))) {
                        foundKeyword = true;
                    }
                    if (includeDrafts && draftKeywords.some(kw => text.includes(kw))) {
                        foundKeyword = true;
                    }

                    if (excludeKeywords.some(kw => text.includes(kw))) shouldExclude = true;
                    if (text.includes(excludeEmoji)) shouldExclude = true;
                    if (parent.querySelector && parent.querySelector('img[src*="Rocket"], img[src*="rocket"]')) {
                        shouldExclude = true;
                    }

                    parent = parent.parentElement;
                }

                if (foundKeyword && !shouldExclude) {
                    const href = link.href.split('?')[0];
                    if (!allItems.some(i => i.url === href)) {
                        const slug = href.split('/').pop();
                        const apolloData = uuidMap[slug] || {};
                        const itemId = apolloData.id || '';
                        const obtainingTypeId = apolloData.obtainingTypeId || '';

                        // Items with these obtainingTypeIds are known to be PAID (premium)
                        // Playerok hides the 🚀 emoji on "Sold" items, so we must filter by ID.
                        if (obtainingTypeId) {
                            // "1f000196..." and "1f0bfa0b" were seen in the logs as having no free status (Price: 1399).
                            // NOTE: "1ee8a458" and "1f094820" are skipped from here because they are shared between FREE and PAID offline activations.
                            const premiumTypes = ["1f000196", "1f0bfa0b", "1f0b4a02"];
                            if (premiumTypes.some(pt => obtainingTypeId.startsWith(pt))) {
                                criticalLog(`⏭️ Пропускаю платную (Кэш): ${href}`);
                                continue;
                            }
                        }

                        allItems.push({ url: href, itemId, obtainingTypeId });
                    }
                }
            }

            criticalLog(`✅ Сканирование завершено. Найдено: ${allItems.length} карточек.`);
            chrome.runtime.sendMessage({ action: 'FOUND_ITEMS', items: allItems });
        }

        /** Все карточки /products/… на «Завершённые» с UUID из Apollo — для массового removeItem в фоне. */
        async function scanCompletedForDelete(depthHint = 0) {
            shouldStop = false;
            isScanning = true;
            updateStatus('Удаление: сбор лотов…');
            const MAX_SHOW_MORE = Math.min(10 + depthHint * 10, 80);
            criticalLog(`🗑 Скан завершённых: «Показать ещё» до ${MAX_SHOW_MORE} кликов...`);
            const startTime = Date.now();
            const MAX_SCAN_TIME = 180000;
            let showMoreClicks = 0;
            let lastHeight = 0;
            let sameHeightCount = 0;

            while (isScanning && !shouldStop) {
                if (Date.now() - startTime > MAX_SCAN_TIME) break;
                const currentHeight = document.body.scrollHeight;
                const showMore = Array.from(document.querySelectorAll('button, a, [role="button"]')).find(b => {
                    const t = b.textContent.toLowerCase();
                    return t.includes('показать') && (t.includes('ещё') || t.includes('еще') || t.includes('more'));
                });
                if (showMore) {
                    showMoreClicks++;
                    if (showMoreClicks > MAX_SHOW_MORE) break;
                    showMore.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    await wait(random(800, 1500));
                    showMore.click();
                    await wait(random(2500, 4000));
                    lastHeight = 0;
                    sameHeightCount = 0;
                    continue;
                }
                if (currentHeight === lastHeight) {
                    sameHeightCount++;
                    if (sameHeightCount >= 4) break;
                    window.scrollBy({ top: -random(150, 300), behavior: 'smooth' });
                    await wait(random(500, 1000));
                    window.scrollBy({ top: random(400, 800), behavior: 'smooth' });
                } else {
                    sameHeightCount = 0;
                    lastHeight = currentHeight;
                    window.scrollBy({ top: random(600, 1000), behavior: 'smooth' });
                }
                await wait(random(1200, 2500));
            }

            if (shouldStop) {
                chrome.runtime.sendMessage({ action: 'FOUND_ITEMS', purpose: 'delete_completed', items: [], meta: { skippedNoId: 0 } });
                return;
            }

            let uuidMap = {};
            try {
                uuidMap = await new Promise((resolve) => {
                    const scriptId = 'apollo-del-' + Date.now();
                    const handler = (event) => {
                        if (event.data && event.data.action === 'APOLLO_UUID_MAP' && event.data.scriptId === scriptId) {
                            window.removeEventListener('message', handler);
                            resolve(event.data.map || {});
                        }
                    };
                    window.addEventListener('message', handler);
                    window.postMessage({ action: 'APOLLO_UUID_MAP_REQUEST', scriptId: scriptId }, '*');
                    setTimeout(() => { window.removeEventListener('message', handler); resolve({}); }, 2500);
                });
            } catch (e) { console.error('DeleteScan: Apollo extract failed', e); }

            const RESERVED_TAB_SLUGS = new Set([
                'completed', 'active', 'inactive', 'draft', 'drafts', 'pending', 'sales', 'categories', 'catalog',
                'new', 'edit', 'create', 'moderation', 'expired', 'archived', 'deleted'
            ]);
            function publicProductHrefAndSlug(linkHref) {
                try {
                    const href = (linkHref || '').split('?')[0];
                    const path = new URL(href, window.location.href).pathname;
                    const m = path.match(/^\/products\/([^/]+)\/?$/i) || path.match(/^\/item\/([^/]+)\/?$/i);
                    if (!m) return null;
                    let slug = m[1];
                    try { slug = decodeURIComponent(slug); } catch (_) { }
                    if (RESERVED_TAB_SLUGS.has(slug.toLowerCase())) return null;
                    return { href, slug };
                } catch (_) {
                    return null;
                }
            }

            const allItems = [];
            const seenHref = new Set();
            const allLinks = document.querySelectorAll('a[href*="/products/"], a[href*="/item/"]');
            for (let link of allLinks) {
                const parsed = publicProductHrefAndSlug(link.href || '');
                if (!parsed) continue;
                const href = parsed.href;
                const slug = parsed.slug;
                if (seenHref.has(href)) continue;
                seenHref.add(href);
                const apolloData = uuidMap[slug] || uuidMap[encodeURIComponent(slug)] || {};
                const itemId = apolloData.id || '';
                allItems.push({
                    url: href,
                    slug,
                    itemId,
                    obtainingTypeId: apolloData.obtainingTypeId || ''
                });
            }
            const withCachedId = allItems.filter(i => i.itemId).length;

            criticalLog(`🗑 Скан завершённых: карточек ${allItems.length}, UUID из Apollo ${withCachedId} (остальные — запрос item(slug) в фоне).`);
            chrome.runtime.sendMessage({
                action: 'FOUND_ITEMS',
                purpose: 'delete_completed',
                items: allItems,
                meta: { total: allItems.length, prefetchedId: withCachedId }
            });
        }

        /** Раскрыть «Показать ещё» на вкладке завершённых — для сводки (не трогает глобальный isScanning). */
        /**
         * Раскрыть «Показать ещё» (завершённые / черновики). Для черновиков — короче паузы (та же логика, меньше ожидание).
         * @param {{ fast?: boolean }} [opts]
         */
        async function expandCompletedCatalogPage(opts) {
            const fast = !!(opts && opts.fast);
            const MAX_SHOW_MORE = opts && opts.maxCycles ? opts.maxCycles : (fast ? 45 : 60);
            const startTime = Date.now();
            const MAX_SCAN_TIME = opts && opts.maxCycles ? 180000 : (fast ? 72000 : 120000);
            let showMoreClicks = 0;
            let lastHeight = 0;
            let sameHeightCount = 0;
            while (Date.now() - startTime < MAX_SCAN_TIME) {
                const currentHeight = document.body.scrollHeight;
                const showMore = Array.from(document.querySelectorAll('button, a, [role="button"]')).find(b => {
                    const t = b.textContent.toLowerCase();
                    return t.includes('показать') && (t.includes('ещё') || t.includes('еще') || t.includes('more'));
                });
                if (showMore) {
                    showMoreClicks++;
                    if (showMoreClicks > MAX_SHOW_MORE) break;
                    showMore.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    await wait(random(fast ? 450 : 650, fast ? 900 : 1300));
                    showMore.click();
                    await wait(random(fast ? 1400 : 2200, fast ? 2400 : 3600));
                    lastHeight = 0;
                    sameHeightCount = 0;
                    continue;
                }
                if (currentHeight === lastHeight) {
                    sameHeightCount++;
                    if (sameHeightCount >= 15) break; // Увеличил лимит попыток для медленного интернета
                    // Имитируем активный скролл туда-сюда для триггера IntersectionObserver
                    window.scrollBy({ top: -random(300, 600), behavior: 'smooth' });
                    await wait(random(fast ? 400 : 600, fast ? 800 : 1200));
                    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
                } else {
                    sameHeightCount = 0;
                    lastHeight = currentHeight;
                    // Плавно скроллим вниз по мере появления контента
                    for (let step = 0; step < 3; step++) {
                        window.scrollBy({ top: random(500, 800), behavior: 'smooth' });
                        await wait(random(200, 350));
                    }
                    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
                }
                await wait(random(fast ? 1000 : 1500, fast ? 1800 : 2500));
            }
        }

        function extractCompletedCatalogViaMainWorld() {
            return new Promise((resolve) => {
                const scriptId = 'prok-cc-' + Date.now();
                const handler = (event) => {
                    if (event.data && event.data.action === 'PROK_COMPLETED_CATALOG_RESULT' && event.data.scriptId === scriptId) {
                        window.removeEventListener('message', handler);
                        resolve({ items: event.data.items || [], error: event.data.error || null });
                    }
                };
                window.addEventListener('message', handler);
                window.postMessage({ action: 'PROK_COMPLETED_CATALOG_EXTRACT', scriptId }, '*');
                setTimeout(() => {
                    window.removeEventListener('message', handler);
                    resolve({ items: [], error: 'Таймаут чтения Apollo (проверьте, что страница Playerok загрузилась)' });
                }, 14000);
            });
        }

        const COMPLETED_CATALOG_TAB_SLUGS = new Set([
            'completed', 'active', 'inactive', 'draft', 'drafts', 'pending', 'sales', 'categories', 'catalog',
            'new', 'edit', 'create', 'moderation', 'expired', 'archived', 'deleted'
        ]);

        /** Убирает типичный префикс id из текста ссылки (например «1636904d03f0 название…»). */
        function sanitizeCatalogTitle(raw) {
            let t = String(raw || '').trim().replace(/\s+/g, ' ');
            if (!t) return t;
            t = t.replace(
                /^[0-9a-f]{8}-[0-9a-f-]{27,36}\s+/i,
                ''
            ).replace(
                /^[0-9a-f]{12,40}\s+/i,
                ''
            );
            return t.trim() || String(raw || '').trim();
        }

        function publicProductHrefFromCompletedPage(linkHref) {
            try {
                const href = (linkHref || '').split('?')[0];
                const path = new URL(href, window.location.href).pathname;
                const m = path.match(/^\/products\/([^/]+)\/?$/i) || path.match(/^\/item\/([^/]+)\/?$/i);
                if (!m) return null;
                let slug = m[1];
                try { slug = decodeURIComponent(slug); } catch (_) { /* */ }
                if (COMPLETED_CATALOG_TAB_SLUGS.has(slug.toLowerCase())) return null;
                return { href: href.startsWith('http') ? href : (window.location.origin + href), slug };
            } catch (_) {
                return null;
            }
        }

        /** Числа ₽ рядом с «просмотры/продажи/статистика» — не цена лота. */
        const RUB_AMOUNT_BAD_NEIGHBOR = /просмотр|продаж|заказ(?!н)|отзыв|рейтинг|подписчик|участник|выруч|статист|\bв\s+день\b|\bдень\b/i;

        function parseRubAmountsFromText(text) {
            if (!text) return [];
            const raw = String(text).replace(/\s+/g, ' ');
            const out = [];
            const re = /(\d[\d\s\u00a0]*)\s*₽|₽\s*(\d[\d\s\u00a0]*)/g;
            let m;
            while ((m = re.exec(raw)) !== null) {
                const start = Math.max(0, m.index - 28);
                const end = Math.min(raw.length, m.index + m[0].length + 28);
                if (RUB_AMOUNT_BAD_NEIGHBOR.test(raw.slice(start, end))) continue;
                const chunk = (m[1] || m[2] || '').replace(/[\s\u00a0]/g, '');
                const n = parseInt(chunk, 10);
                if (!isNaN(n) && n > 0 && n < 1e9) out.push(n);
            }
            return out;
        }

        /** Убираем выбросы: «14 110 ₽» из статистики при реальной цене 90 ₽. */
        function filterNoiseRubPrices(nums) {
            if (!nums || nums.length < 2) return nums || [];
            let arr = nums.slice().sort((a, b) => a - b);
            while (arr.length >= 2) {
                const lo = arr[0];
                const hi = arr[arr.length - 1];
                if (hi > lo * 32) {
                    arr.pop();
                    continue;
                }
                if (arr.length >= 3) {
                    const mid = arr[arr.length - 2];
                    if (hi > mid * 22) {
                        arr.pop();
                        continue;
                    }
                }
                break;
            }
            return arr;
        }

        /** Подзаголовок карточки на Playerok: вторая строка «Аккаунты», «Аккаунты с играми» и т.д. */
        function extractCategoryFromDomListingCard(text) {
            const raw = String(text || '').replace(/\r/g, '\n');
            const lines = raw.split(/\n/).map((s) => s.trim()).filter(Boolean);
            const lotCatRe = /^(Аккаунты(?:\s+с\s+играми)?|Ключи|Услуги|Услуга|Предметы|Аренда|Награды\s*Steam|Чистые\s+аккаунты|Пополнение\s+баланса|Другое|Другие\s+игры|Аккаунт)$/i;
            for (let i = 1; i < Math.min(lines.length, 8); i++) {
                if (lotCatRe.test(lines[i])) return lines[i];
            }
            const flat = raw.replace(/\s+/g, ' ').slice(0, 600);
            const m = flat.match(/\b(Steam|Другие\s+игры)\s*[|·•]\s*(Аккаунты(?:\s+с\s+играми)?|Ключи|Услуги|Предметы)/i);
            if (m && m[2]) return m[2].trim();
            return '';
        }

        function detectStatusFromCardText(text, opts) {
            const t = String(text || '').replace(/\s+/g, ' ');
            // «Черновики» (вкладка в шапке) содержит подстроку «черновик» — без (?!И) даёт ложный DRAFT на странице «Завершённые».
            const draftRe = /ЧЕРНОВИК(?!И)|\bDRAFT\b/i;
            const blockedRe = /ЗАБЛОКИРОВАН|\bBLOCKED\b/i;
            const soldRe = /ПРОДАН|ПРОДАНО|\bSOLD\b/i;
            const expiredRe = /\bИСТ[ЁЕ]К\b|ИСТ[ЁЕ]К\s+СРОК|СРОК\s+ИСТ[ЁЕ]К|\bEXPIRED\b/i;
            const completedRe = /ЗАВЕРШ[ЁЕ]Н|ЗАВЕРШЕН/i;
            const modRe = /НА\s+МОДЕРАЦИИ|ПРОВЕРК|МОДЕРАЦИ/i;
            const declinedRe = /ОТКЛОН[ЁЕ]Н|\bDECLINED\b/i;
            const draftT = { re: draftRe, code: 'DRAFT', label: 'Черновик' };
            const blockedT = { re: blockedRe, code: 'BLOCKED', label: 'Заблокирован' };
            const soldT = { re: soldRe, code: 'SOLD', label: 'Продано (завершено)' };
            const expiredT = { re: expiredRe, code: 'EXPIRED', label: 'Истёк' };
            const completedT = { re: completedRe, code: 'COMPLETED', label: 'Завершён' };
            const modT = { re: modRe, code: 'PENDING_APPROVAL', label: 'На модерации' };
            const declinedT = { re: declinedRe, code: 'DECLINED', label: 'Отклонён' };
            const preferSold = opts && opts.preferSoldOrCompleted;
            const tests = preferSold
                ? [soldT, completedT, expiredT, blockedT, modT, declinedT, draftT]
                : [draftT, blockedT, soldT, expiredT, completedT, modT, declinedT];
            for (let j = 0; j < tests.length; j++) {
                if (tests[j].re.test(t)) return { code: tests[j].code, label: tests[j].label };
            }
            return { code: '', label: '' };
        }

        function enrichDomCatalogItemFromCard(anchorEl, item) {
            let el = anchorEl;
            let best = '';
            for (let depth = 0; depth < 14 && el; depth++) {
                el = el.parentElement;
                if (!el) break;
                const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
                if (t.length >= 80 && t.length <= 6000) best = t;
            }
            if (!best) {
                best = (anchorEl.innerText || anchorEl.textContent || '').replace(/\s+/g, ' ').trim();
            }
            const boostedMark = best.indexOf('🚀') !== -1;
            const onCompletedPage = /\/products\/completed/i.test(window.location.href || '');
            const st = detectStatusFromCardText(best, { preferSoldOrCompleted: onCompletedPage });
            const prices = filterNoiseRubPrices(parseRubAmountsFromText(best));
            let priceRub = null;
            let basePriceRub = null;
            let salePriceRub = null;
            let hasDiscount = false;
            if (prices.length >= 2) {
                const sorted = prices.slice().sort((a, b) => a - b);
                salePriceRub = sorted[0];
                basePriceRub = sorted[sorted.length - 1];
                if (basePriceRub > salePriceRub) {
                    const ratio = basePriceRub / salePriceRub;
                    if (ratio > 30) {
                        basePriceRub = null;
                        hasDiscount = false;
                        priceRub = salePriceRub;
                    } else {
                        const pct = (1 - salePriceRub / basePriceRub) * 100;
                        hasDiscount = ratio >= 1.28 || pct >= 22;
                        priceRub = salePriceRub;
                    }
                } else {
                    basePriceRub = null;
                    priceRub = sorted[0];
                    salePriceRub = sorted[0];
                }
            } else if (prices.length === 1) {
                priceRub = prices[0];
                salePriceRub = prices[0];
            }
            let gameTitle = '';
            let categoryName = '';
            const gm = best.match(/Игра[:\s]+([^|·\n]+?)(?=\s*[|·]|\s+Категория|\s+Цена|$)/i);
            if (gm) gameTitle = gm[1].trim().slice(0, 200);
            const cm = best.match(/Категория[^:]{0,12}[:\s]+([^|·\n]+?)(?=\s*[|·]|\s+Цена|\s+Игра|$)/i);
            if (cm) categoryName = cm[1].trim().slice(0, 200);
            if (!categoryName) {
                const head = (best || '').slice(0, 500);
                const known = ['Аккаунты с играми', 'Пополнение баланса', 'Чистые аккаунты', 'Награды Steam', 'Другие игры', 'Аккаунты', 'Ключи', 'Услуги', 'Предметы', 'Аренда', 'Другое'];
                for (let ki = 0; ki < known.length; ki++) {
                    const lab = known[ki];
                    const esc = lab.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    if (new RegExp('(?:^|[\\s|·•])' + esc + '(?:\\s|$|[|·•])').test(head)) {
                        categoryName = lab;
                        break;
                    }
                }
            }
            if (!categoryName) {
                const fromLines = extractCategoryFromDomListingCard(best);
                if (fromLines) categoryName = fromLines;
            }
            return Object.assign({}, item, {
                gameTitle: gameTitle || item.gameTitle,
                categoryName: categoryName || item.categoryName,
                priceRub: priceRub != null ? priceRub : item.priceRub,
                basePriceRub: basePriceRub != null ? basePriceRub : item.basePriceRub,
                salePriceRub: salePriceRub != null ? salePriceRub : item.salePriceRub,
                hasDiscount: hasDiscount,
                status: st.code || item.status,
                statusLabel: st.label || item.statusLabel,
                boostedMark: boostedMark || item.boostedMark
            });
        }

        /** Резерв: ссылки на карточки видны в DOM даже когда __typename в Apollo другой. */
        function extractCompletedCatalogFromDom() {
            const base = (window.location.origin || 'https://playerok.com').replace(/\/$/, '');
            const items = [];
            const seen = new Set();
            const links = document.querySelectorAll('a[href*="/products/"], a[href*="/item/"]');
            for (let i = 0; i < links.length; i++) {
                const parsed = publicProductHrefFromCompletedPage(links[i].href || '');
                if (!parsed) continue;
                const slug = parsed.slug;
                if (seen.has(slug)) continue;
                seen.add(slug);
                let title = sanitizeCatalogTitle((links[i].innerText || links[i].textContent || '').trim());
                if (!title || title.length > 200) title = slug.replace(/-/g, ' ');
                const url = (parsed.href.startsWith('http') ? parsed.href : base + parsed.href).split('?')[0];
                let row = {
                    id: '',
                    slug,
                    title,
                    gameTitle: '—',
                    categoryName: '',
                    priceRub: null,
                    basePriceRub: null,
                    salePriceRub: null,
                    hasDiscount: false,
                    status: '',
                    statusLabel: '',
                    boostedMark: false,
                    url
                };
                row = enrichDomCatalogItemFromCard(links[i], row);
                row._domIdx = i;
                items.push(row);
            }
            return items;
        }

        function sortCatalogByRecency(rows) {
            return (rows || []).slice().sort((a, b) => {
                const ta = Number(a._sortTs) || 0;
                const tb = Number(b._sortTs) || 0;
                if (tb !== ta) return tb - ta;
                return (Number(a._domIdx) || 0) - (Number(b._domIdx) || 0);
            });
        }

        function dedupeCatalogRowsBySlug(rows) {
            const bySlug = new Map();
            for (let i = 0; i < (rows || []).length; i++) {
                const r = rows[i];
                if (!r || !r.slug) continue;
                const k = String(r.slug);
                if (!bySlug.has(k)) bySlug.set(k, r);
            }
            return sortCatalogByRecency(Array.from(bySlug.values()));
        }

        function mergeCompletedCatalogDomAndApollo(domItems, apolloItems, scanPhase) {
            const preferApolloStatus = scanPhase === 'completed';
            function slugInDom(arr, slug) {
                const s = String(slug);
                for (let j = 0; j < (arr || []).length; j++) {
                    if (arr[j] && String(arr[j].slug) === s) return true;
                }
                return false;
            }
            const bySlug = new Map();
            for (let i = 0; i < (apolloItems || []).length; i++) {
                const a = apolloItems[i];
                if (a && a.slug) bySlug.set(String(a.slug), a);
            }
            function domPriceLooksLikeNoise(d) {
                if (!d) return false;
                const b = Number(d.basePriceRub);
                const s = Number(d.salePriceRub);
                if (!isFinite(b) || !isFinite(s) || s <= 0) return false;
                if (b <= s) return false;
                return (b / s) > 30;
            }
            function catalogDiscountFrac(base, sale) {
                const b = Number(base);
                const s = Number(sale);
                if (!isFinite(b) || !isFinite(s) || b <= s) return 0;
                return (b - s) / b;
            }
            function rowEffectiveSale(r) {
                if (!r) return NaN;
                const x = r.salePriceRub != null && r.salePriceRub !== '' ? r.salePriceRub : r.priceRub;
                return Number(x);
            }
            const out = [];
            const enriched = new Set();
            for (let i = 0; i < (domItems || []).length; i++) {
                const d = domItems[i];
                if (!d || !d.slug) continue;
                const sk = String(d.slug);
                const a = bySlug.get(sk);
                if (a) {
                    const mergedTitle = sanitizeCatalogTitle((a.title && String(a.title).trim()) ? String(a.title) : d.title);
                    const domNoise = domPriceLooksLikeNoise(d);
                    let priceRub = a.priceRub != null ? a.priceRub : d.priceRub;
                    let basePriceRub = a.basePriceRub != null ? a.basePriceRub : d.basePriceRub;
                    let salePriceRub = a.salePriceRub != null ? a.salePriceRub : d.salePriceRub;
                    let hasDiscount = !!(a.hasDiscount || d.hasDiscount);
                    if (domNoise) {
                        if (a.priceRub != null) {
                            priceRub = a.priceRub;
                            basePriceRub = a.basePriceRub != null ? a.basePriceRub : null;
                            salePriceRub = a.salePriceRub != null ? a.salePriceRub : a.priceRub;
                            hasDiscount = !!(a.hasDiscount || (a.basePriceRub != null && salePriceRub != null && a.basePriceRub > salePriceRub));
                        } else {
                            const one = d.salePriceRub != null ? d.salePriceRub : d.priceRub;
                            priceRub = one != null ? one : d.priceRub;
                            basePriceRub = null;
                            salePriceRub = priceRub;
                            hasDiscount = false;
                        }
                    } else {
                        const apDisc = catalogDiscountFrac(a.basePriceRub, rowEffectiveSale(a));
                        const domDisc = catalogDiscountFrac(d.basePriceRub, rowEffectiveSale(d));
                        const apS = rowEffectiveSale(a);
                        const domS = rowEffectiveSale(d);
                        const preferDomPrice = isFinite(domDisc) && domDisc > 0 && (
                            domDisc > apDisc + 0.09 ||
                            (isFinite(Number(d.basePriceRub)) && isFinite(Number(a.basePriceRub)) &&
                                Number(d.basePriceRub) >= Number(a.basePriceRub) * 1.4 &&
                                isFinite(domS) && isFinite(apS) &&
                                Math.abs(domS - apS) <= Math.max(25, apS * 0.22))
                        );
                        if (preferDomPrice) {
                            priceRub = d.priceRub != null ? d.priceRub : domS;
                            basePriceRub = d.basePriceRub;
                            salePriceRub = d.salePriceRub != null ? d.salePriceRub : d.priceRub;
                            hasDiscount = !!(d.hasDiscount || (basePriceRub != null && salePriceRub != null && basePriceRub > salePriceRub));
                        }
                    }
                    const apolloSt = String(a.status || '').trim();
                    const domSt = String(d.status || '').trim();
                    const apUp = apolloSt.toUpperCase().replace(/-/g, '_').replace(/\s+/g, '_');
                    const domUp = domSt.toUpperCase().replace(/-/g, '_').replace(/\s+/g, '_');
                    let statusOut;
                    let statusLabelOut;
                    if (apUp === 'DRAFT' || domUp === 'DRAFT') {
                        statusOut = 'DRAFT';
                        statusLabelOut = 'Черновик';
                    } else if (preferApolloStatus && apolloSt) {
                        statusOut = apUp || apolloSt;
                        statusLabelOut = String(a.statusLabel || '');
                    } else {
                        statusOut = domUp || apUp || apolloSt || domSt || '';
                        statusLabelOut = String((d.statusLabel && String(d.statusLabel).trim()) ? d.statusLabel : (a.statusLabel || d.statusLabel || ''));
                    }
                    const rowOut = {
                        id: String(a.id || d.id || ''),
                        slug: sk,
                        title: mergedTitle,
                        gameTitle: (a.gameTitle && a.gameTitle !== '—') ? a.gameTitle : ((d.gameTitle && d.gameTitle !== '—') ? d.gameTitle : '—'),
                        categoryName: (a.categoryName && String(a.categoryName).trim()) ? String(a.categoryName) : String((d.categoryName && d.categoryName.trim()) ? d.categoryName : ''),
                        obtainingTypeId: String(a.obtainingTypeId || d.obtainingTypeId || '').trim(),
                        _sortTs: Math.max(Number(a._sortTs) || 0, Number(d._sortTs) || 0),
                        _domIdx: typeof d._domIdx === 'number' ? d._domIdx : i,
                        priceRub,
                        basePriceRub,
                        salePriceRub,
                        hasDiscount,
                        status: statusOut,
                        statusLabel: statusLabelOut,
                        boostedMark: !!(a.boostedMark || d.boostedMark),
                        url: (d.url && /^https?:/i.test(d.url)) ? d.url : (a.url || d.url)
                    };
                    out.push(rowOut);
                    enriched.add(sk);
                } else {
                    out.push(Object.assign({}, d, { title: sanitizeCatalogTitle(d.title) }));
                }
            }
            for (let i = 0; i < (apolloItems || []).length; i++) {
                const a = apolloItems[i];
                if (!a || !a.slug || enriched.has(String(a.slug))) continue;
                if (slugInDom(domItems, a.slug)) continue;
                out.push(Object.assign({}, a, {
                    title: sanitizeCatalogTitle(a.title),
                    _domIdx: 500000 + i
                }));
            }
            return dedupeCatalogRowsBySlug(out);
        }

        // === WORKER MODE ===
        async function processProduct() {

            if (window.workInProgress) return;
            window.workInProgress = true;
            shouldStop = false;
            updateStatus("Работаю...");

            if (!window.location.href.includes('/products/') && !window.location.href.includes('/item/')) {
                window.workInProgress = false;
                return;
            }

            await wait(3000);

            // Active Check
            const alreadyActive = Array.from(document.querySelectorAll('button, a, div[role="button"]')).some(el => {
                const txt = el.textContent.toLowerCase();
                return (txt.includes('повысить') || txt.includes('поднять') || txt.includes('boost'))
                    && el.getBoundingClientRect().height > 0;
            });

            if (alreadyActive) {
                criticalLog("⚡ Товар уже активен. Skip.");
                chrome.runtime.sendMessage({ action: 'ITEM_ALREADY_ACTIVE' });
                window.workInProgress = false;
                return;
            }

            try {
                // ================================================================
                // API-FIRST: bypass modal UI entirely
                // 1. Get itemId from page (Apollo cache / Next.js JSON)
                // 2. validateItemData -> get priorityStatuses list
                // 3. Pick FREE status (price=0)
                // 4. publishItem with transactionProviderId="LOCAL"
                // ================================================================

                const slug = window.location.href.split('?')[0].split('/').pop();
                log("📌 Slug: " + slug);

                let itemId = null;

                // Try Apollo / Next.js state
                try {
                    itemId = await new Promise((resolve) => {
                        const scriptId = 'id-ext-' + Date.now();
                        const handler = (event) => {
                            if (event.data && event.data.action === 'ITEM_ID_RESULT' && event.data.scriptId === scriptId) {
                                window.removeEventListener('message', handler);
                                resolve(event.data.itemId || null);
                            }
                        };
                        window.addEventListener('message', handler);
                        const script = document.createElement('script');
                        script.textContent = `(function(){
                            try {
                                const slug = '${slug}';
                                let id = null;
                                const nd = window.__NEXT_DATA__;
                                const st = (nd&&nd.props&&nd.props.pageProps&&(nd.props.pageProps.initialApolloState||nd.props.pageProps.apolloState))||{};
                                for(const k in st){if(st[k]&&st[k].slug===slug&&st[k].id&&st[k].id.includes('-')){id=st[k].id;break;}}
                                if(!id){const lc=(window.__APOLLO_CLIENT__&&window.__APOLLO_CLIENT__.cache&&window.__APOLLO_CLIENT__.cache.extract())||window.__APOLLO_STATE__||{};for(const k in lc){if(lc[k]&&lc[k].slug===slug&&lc[k].id&&lc[k].id.includes('-')){id=lc[k].id;break;}}}
                                window.postMessage({action:'ITEM_ID_RESULT',scriptId:'${scriptId}',itemId:id},'*');
                            } catch(e){window.postMessage({action:'ITEM_ID_RESULT',scriptId:'${scriptId}',itemId:null},'*');}
                        })();`;
                        document.documentElement.appendChild(script);
                        script.remove();
                        setTimeout(() => { window.removeEventListener('message', handler); resolve(null); }, 3000);
                    });
                } catch (e) { }

                // Fallback: Next.js JSON
                if (!itemId) {
                    try {
                        const ndEl = document.getElementById('__NEXT_DATA__');
                        const buildId = (ndEl && JSON.parse(ndEl.textContent).buildId) || (window.__NEXT_DATA__ && window.__NEXT_DATA__.buildId);
                        if (buildId) {
                            const res = await fetch('/_next/data/' + buildId + '/products/' + slug + '.json');
                            if (res.ok) {
                                const data = await res.json();
                                const st = (data.pageProps && (data.pageProps.initialApolloState || data.pageProps.apolloState)) || {};
                                for (const k in st) { if (st[k] && st[k].slug === slug && st[k].id && st[k].id.includes('-')) { itemId = st[k].id; break; } }
                            }
                        }
                    } catch (e) { }
                }

                if (!itemId) {
                    criticalLog("❌ Не удалось получить itemId slug=" + slug);
                    chrome.runtime.sendMessage({ action: 'ITEM_DONE', success: false });
                    window.workInProgress = false;
                    return;
                }

                log("✅ itemId: " + itemId);

                // STEP 2: validateItemData — same mutation the site calls on modal open
                const VALIDATE_QUERY = "mutation validateItemData($input: ValidateItemDataInput!) { validateItemData(input: $input) { priorityStatuses { id name price __typename } __typename } }";

                log("📡 validateItemData...");
                let priorityStatuses = [];
                try {
                    const vRes = await fetch('/graphql', {
                        method: 'POST',
                        credentials: 'include',
                        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                        body: JSON.stringify({ operationName: 'validateItemData', query: VALIDATE_QUERY, variables: { input: { itemId } } })
                    });
                    const vJson = await vRes.json();
                    if (vJson.data && vJson.data.validateItemData) {
                        priorityStatuses = vJson.data.validateItemData.priorityStatuses || [];
                        log("📋 Статусы: " + priorityStatuses.length);
                        priorityStatuses.forEach(function (s) { log("  • " + s.name + " — " + s.price); });
                    } else if (vJson.errors) {
                        log("⚠️ validateItemData err: " + vJson.errors[0].message);
                    }
                } catch (e) {
                    log("⚠️ validateItemData exc: " + e.message);
                }

                // STEP 3: pick FREE status (price=0 or null)
                let freeStatus = null;
                for (const s of priorityStatuses) {
                    if (s.price === 0 || s.price === '0' || s.price === null || s.price === undefined) { freeStatus = s; break; }
                }
                if (!freeStatus) {
                    for (const s of priorityStatuses) {
                        const n = (s.name || '').toLowerCase();
                        if (n.includes('обычн') || n.includes('normal') || n.includes('free') || n.includes('бесплат')) { freeStatus = s; break; }
                    }
                }
                if (!freeStatus && priorityStatuses.length > 0) {
                    const sorted = priorityStatuses.slice().sort(function (a, b) { return (a.price || 0) - (b.price || 0); });
                    freeStatus = sorted[0];
                    log("⚠️ Free not found, picking cheapest: " + freeStatus.name + " (" + freeStatus.price + ")");
                }

                if (!freeStatus) {
                    criticalLog("❌ Нет статусов. Отмена.");
                    chrome.runtime.sendMessage({ action: 'ITEM_DONE', success: false });
                    window.workInProgress = false;
                    return;
                }

                // CRITICAL GUARD: abort if not actually free
                const fp = freeStatus.price;
                if (fp !== 0 && fp !== '0' && fp !== null && fp !== undefined && fp !== '') {
                    criticalLog("🚨 СТОП! Дешевейший = " + fp + "₽. НЕ публикую!");
                    chrome.runtime.sendMessage({ action: 'ITEM_DONE', success: false });
                    window.workInProgress = false;
                    return;
                }

                log("✅ Статус: \"" + freeStatus.name + "\" id=" + freeStatus.id + " цена=" + fp + " БЕСПЛАТНО");

                // STEP 4: publishItem with transactionProviderId="LOCAL" (free)
                const PUBLISH_QUERY = "mutation publishItem($input: PublishItemInput!) { publishItem(input: $input) { id status __typename } }";

                log("📡 publishItem LOCAL...");
                await wait(random(500, 1200));

                const pRes = await fetch('/graphql', {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    body: JSON.stringify({
                        operationName: 'publishItem',
                        query: PUBLISH_QUERY,
                        variables: {
                            input: {
                                itemId: itemId,
                                transactionProviderId: "LOCAL",
                                priorityStatuses: [freeStatus.id]
                            }
                        }
                    })
                });
                const pJson = await pRes.json();

                if (pJson.data && pJson.data.publishItem) {
                    const newStatus = pJson.data.publishItem.status;
                    criticalLog("✅ ПОБЕДА! Опубликовано бесплатно! Статус: " + newStatus);
                    chrome.runtime.sendMessage({ action: 'ITEM_DONE', success: true });
                } else {
                    const errMsg = pJson.errors ? pJson.errors[0].message : JSON.stringify(pJson);
                    criticalLog("❌ publishItem ошибка: " + errMsg);
                    chrome.runtime.sendMessage({ action: 'ITEM_DONE', success: false });
                }

                window.workInProgress = false;

            } catch (e) {
                criticalLog("❌ LOGIC ERROR: " + e.message);
                window.workInProgress = false;
                chrome.runtime.sendMessage({ action: 'ITEM_DONE', success: false });
            }
        }

        chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
            if (req.action === 'PING') {
                sendResponse({ ok: true, status: 'PONG' });
                return false;
            }

            // === AUTO-BOOST ACTIONS ===
            if (req.action === 'SCAN') {
                if (isScanning) {
                    criticalLog("⚠️ Сканирование уже идет, игнорирую лишний SCAN");
                    sendResponse({ status: 'ALREADY_SCANNING' });
                    return false;
                }
                if (window.location.href.includes('/profile/') || window.location.href.includes('playerok.com')) {
                    window.__autoBoostIncludeDrafts = !!req.includeDrafts;
                    scanItems(req.depthHint || 0);
                    sendResponse({ status: 'SCAN_STARTED' });
                    return false;

                } else {
                    sendResponse({ status: 'WRONG_PAGE' });
                    return false;
                }
            } else if (req.action === 'SCAN_DELETE_COMPLETED') {
                if (isScanning) {
                    criticalLog('⚠️ Сканирование уже идёт, игнорирую SCAN_DELETE_COMPLETED');
                    sendResponse({ status: 'ALREADY_SCANNING' });
                    return false;
                }
                if (window.location.href.includes('/profile/') || window.location.href.includes('playerok.com')) {
                    scanCompletedForDelete(req.depthHint || 0);
                    sendResponse({ status: 'SCAN_DELETE_STARTED' });
                    return false;
                }
                sendResponse({ status: 'WRONG_PAGE' });
                return false;
            } else if (req.action === 'RUN_COMPLETED_CATALOG_SCAN') {
                const scanPhase = req.scanPhase === 'drafts' ? 'drafts'
                    : req.scanPhase === 'published' ? 'published'
                    : 'completed';
                (async () => {
                    const href = window.location.href || '';
                    if (scanPhase === 'completed' && !href.includes('/products/completed')) {
                        try {
                            await chrome.runtime.sendMessage({
                                action: 'COMPLETED_CATALOG_SCAN_RESULT',
                                scanPhase: 'completed',
                                items: [],
                                error: 'Ожидалась страница …/products/completed (сейчас другой URL).',
                                sourceUrl: href
                            });
                        } catch (_) { /* */ }
                        return;
                    }
                    if (scanPhase === 'drafts' && !/\/products\/drafts/i.test(href)) {
                        try {
                            await chrome.runtime.sendMessage({
                                action: 'COMPLETED_CATALOG_SCAN_RESULT',
                                scanPhase: 'drafts',
                                draftImports: [],
                                error: 'Ожидалась страница …/products/drafts.',
                                sourceUrl: href
                            });
                        } catch (_) { /* */ }
                        return;
                    }
                    if (scanPhase === 'published') {
                        try {
                            const pname = new URL(href).pathname;
                            if (!/\/products(?:\/active)?\/?$/i.test(pname)) {
                                await chrome.runtime.sendMessage({
                                    action: 'COMPLETED_CATALOG_SCAN_RESULT',
                                    scanPhase: 'published',
                                    publishedImports: [],
                                    error: 'Ожидалась страница …/products (опубликованные).',
                                    sourceUrl: href
                                });
                                return;
                            }
                        } catch (_) { /* */ }
                    }
                    criticalLog(scanPhase === 'completed'
                        ? '[Сводка] Завершённые: раскрываю список, DOM + Apollo…'
                        : scanPhase === 'drafts'
                        ? '[Сводка] Черновики: раскрываю список, DOM + Apollo…'
                        : '[Сводка] Опубликованные: раскрываю список, DOM + Apollo…');
                    try {
                        await expandCompletedCatalogPage({
                            fast: scanPhase !== 'completed',
                            maxCycles: scanPhase === 'published' ? 120 : undefined
                        });
                        const apolloResult = await extractCompletedCatalogViaMainWorld();
                        const domItems = extractCompletedCatalogFromDom();
                        const merged = mergeCompletedCatalogDomAndApollo(domItems, apolloResult.items || [], scanPhase);
                        if (scanPhase === 'completed') {
                            await chrome.runtime.sendMessage({
                                action: 'COMPLETED_CATALOG_SCAN_RESULT',
                                scanPhase: 'completed',
                                items: merged,
                                error: null,
                                sourceUrl: window.location.href
                            });
                            criticalLog(`[Сводка] Завершённые: DOM ${domItems.length}, Apollo ${(apolloResult.items || []).length} → ${merged.length} лотов`);
                            if (!merged.length) {
                                criticalLog('[Сводка] На «Завершённых» пусто — переходим к черновикам.');
                            }
                        } else if (scanPhase === 'drafts') {
                            const draftImports = merged.filter(function (r) {
                                if (!r || !r.url) return false;
                                var u = r.url;
                                return u.indexOf('/products/') !== -1 || u.indexOf('/item/') !== -1;
                            }).map(function (r) {
                                return {
                                    title: r.title,
                                    url: r.url,
                                    itemId: r.id || '',
                                    obtainingTypeId: r.obtainingTypeId || '',
                                    basePriceRub: r.basePriceRub,
                                    salePriceRub: r.salePriceRub != null ? r.salePriceRub : r.priceRub,
                                    hasDiscount: !!r.hasDiscount,
                                    quantity: 1
                                };
                            });
                            await chrome.runtime.sendMessage({
                                action: 'COMPLETED_CATALOG_SCAN_RESULT',
                                scanPhase: 'drafts',
                                draftImports: draftImports,
                                error: null,
                                sourceUrl: window.location.href
                            });
                            criticalLog(`[Сводка] Черновики: ${draftImports.length} лотов → сводка «Черновики»`);
                        } else {
                            // published
                            const publishedImports = merged.filter(function (r) {
                                if (!r || !r.url) return false;
                                var u = r.url;
                                if (u.indexOf('/products/') === -1 && u.indexOf('/item/') === -1) return false;
                                // Исключаем не-активные статусы: завершённые, проданные, черновики
                                var st = String(r.status || '').toUpperCase().replace(/-/g, '_').replace(/\s+/g, '_');
                                if (/^(SOLD|COMPLETED|FINISHED|CANCELLED|REJECTED|DELETED|CLOSED|EXPIRED|DRAFT)$/.test(st)) return false;
                                return true;
                            }).map(function (r) {
                                return {
                                    title: r.title,
                                    url: r.url,
                                    itemId: r.id || '',
                                    obtainingTypeId: r.obtainingTypeId || '',
                                    basePriceRub: r.basePriceRub,
                                    salePriceRub: r.salePriceRub != null ? r.salePriceRub : r.priceRub,
                                    hasDiscount: !!r.hasDiscount,
                                    quantity: 1
                                };
                            });
                            await chrome.runtime.sendMessage({
                                action: 'COMPLETED_CATALOG_SCAN_RESULT',
                                scanPhase: 'published',
                                publishedImports: publishedImports,
                                error: null,
                                sourceUrl: window.location.href
                            });
                            criticalLog(`[Сводка] Опубликованные: ${publishedImports.length} лотов → сводка «Опубликованные»`);
                        }
                    } catch (e) {
                        try {
                            await chrome.runtime.sendMessage({
                                action: 'COMPLETED_CATALOG_SCAN_RESULT',
                                scanPhase: scanPhase,
                                items: scanPhase === 'completed' ? [] : undefined,
                                draftImports: scanPhase === 'drafts' ? [] : undefined,
                                publishedImports: scanPhase === 'published' ? [] : undefined,
                                error: e.message || String(e),
                                sourceUrl: window.location.href
                            });
                        } catch (_) { /* */ }
                    }
                })();
                sendResponse({ ack: true });
                return true;
            } else if (req.action === 'GET_LIVE_CATALOG') {
                // Быстрое чтение живого Apollo-кэша из текущей вкладки — без раскрытия DOM, без навигации.
                // Возвращает всё что Apollo успел накопить (items со статусами APPROVED/DRAFT/EXPIRED и т.д.)
                extractCompletedCatalogViaMainWorld().then((result) => {
                    sendResponse({ items: result.items || [], error: result.error || null });
                }).catch((e) => {
                    sendResponse({ items: [], error: e.message || String(e) });
                });
                return true;
            } else if (req.action === 'STOP_SCANNING') {
                isScanning = false;
            } else if (req.action === 'STOP_IMMEDIATELY' || req.action === 'GLOBAL_STOP') {
                shouldStop = true;
                isScanning = false;
            } else if (req.action === 'START_PROCESSING') {
                processProduct();
                sendResponse({ status: 'STARTED' });
            }

            // === AUTO-GREETING ACTIONS ===
            else if (req.action === 'SCAN_ORDERS') {
                scanOrders().then(() => {
                    sendResponse({ status: 'success' });
                }).catch((err) => {
                    log(`❌ Ошибка в scanOrders: ${err.message}`);
                    sendResponse({ status: 'error', error: err.message });
                });
                return true;
            } else if (req.action === 'START_PROCESSING_ORDER') {
                processOrder();
                sendResponse({ status: 'started' });
            }
        });

        if (window.location.href.includes('/products/') || window.location.href.includes('/item/')) {
            chrome.runtime.sendMessage({ action: 'AM_I_TASK' }, (res) => {
                if (res && res.process) processProduct();
            });
        } else if (window.location.href.includes("playerok.com")) {
            try { chrome.runtime.sendMessage({ action: 'READY_TO_SCAN', url: window.location.href }).catch(() => { }); } catch (e) { }
        }

    } catch (globalError) {
        console.error("FATAL SCRIPT ERROR:", globalError);
    }

    // === ФУНКЦИИ АВТОПРИВЕТСТВИЯ ===
    async function scanOrders() {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        console.log("[Bot] 🔍 Сканирую страницу заказов...");
        await wait(2000);
        window.scrollTo(0, 0);
        await wait(500);
        window.scrollTo(0, document.body.scrollHeight);
        await wait(2000);
        const orderUrls = [];
        const seen = new Set();
        const statusPhrases = ['Выполните заказ', 'Ожидает выполнения', 'оплачен', 'paid', 'Выполнить'];
        for (const phrase of statusPhrases) {
            const xpath = `//*[contains(text(), '${phrase}')]`;
            try {
                const result = document.evaluate(xpath, document.body, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
                for (let i = 0; i < result.snapshotLength; i++) {
                    const el = result.snapshotItem(i);
                    const link = el.closest('a[href*="/sales/"]') || el.closest('a');
                    if (link && link.href && link.href.includes('/sales/') && !seen.has(link.href)) {
                        seen.add(link.href);
                        orderUrls.push(link.href);
                    }
                }
            } catch (_) { }
        }
        if (orderUrls.length === 0) {
            const allSalesLinks = document.querySelectorAll('a[href*="/sales/"]');
            for (const a of allSalesLinks) {
                if (a.href && /\/sales\/\d+/.test(a.href) && !seen.has(a.href)) {
                    seen.add(a.href);
                    orderUrls.push(a.href);
                }
            }
        }
        console.log(`[Bot] 📦 Найдено заказов: ${orderUrls.length}`);
        chrome.runtime.sendMessage({ action: 'FOUND_ORDERS', orders: orderUrls });
    }

    async function processOrder() {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        const random = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
        if (window.workInProgress) return;
        window.workInProgress = true;
        updateStatus("Обрабатываю заказ...");
        try {
            await wait(3000);
            let username = null;
            const sellerNameForXpath = await new Promise(r => chrome.storage.local.get(['playerokUsername'], d => r(d.playerokUsername || 'Morion21')));
            const usernameSelectors = [
                `//a[contains(@href, '/profile/') and not(contains(@href, '${sellerNameForXpath}'))]`,
                "//*[contains(text(), 'Покупатель')]/following-sibling::*"
            ];
            for (const xpath of usernameSelectors) {
                try {
                    const res = document.evaluate(xpath + "//text()", document.body, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                    const node = res.singleNodeValue;
                    if (node && node.textContent && node.textContent.trim().length > 2) {
                        const t = node.textContent.trim();
                        if (!/^\d+$/.test(t) && !t.includes('@') && t.length < 50) {
                            username = t;
                            break;
                        }
                    }
                } catch (_) { }
            }
            if (!username) {
                const sellerName = await new Promise(r => chrome.storage.local.get(['playerokUsername'], d => r(d.playerokUsername || 'Morion21')));
                const profileLinks = document.querySelectorAll('a[href*="/profile/"]');
                for (const a of profileLinks) {
                    if (!a.href.includes(sellerName) && a.textContent.trim()) {
                        username = a.textContent.trim();
                        if (username.length > 2 && username.length < 50) break;
                    }
                }
            }
            if (!username) {
                console.log("[Bot] ❌ Не удалось найти имя пользователя");
                chrome.runtime.sendMessage({ action: 'ORDER_DONE', success: false, orderUrl: window.location.href });
                window.workInProgress = false;
                return;
            }
            console.log(`[Bot] 👤 Пользователь: ${username}`);
            const userCheck = await chrome.runtime.sendMessage({ action: 'CHECK_USER', username: username });
            if (!userCheck.isNew) {
                console.log(`[Bot] ⚠️ Пользователь ${username} уже получал приветствие. Пропускаю.`);
                chrome.runtime.sendMessage({ action: 'ORDER_DONE', success: false, orderUrl: window.location.href, username: username, markAsProcessed: true });
                window.workInProgress = false;
                return;
            }
            const chatPhrases = ['Чат', 'Chat', 'Написать', 'Сообщение', 'Message'];
            let chatBtn = null;
            for (let i = 0; i < 8; i++) {
                for (const phrase of chatPhrases) {
                    const xpath = `//button[contains(., '${phrase}')] | //a[contains(., '${phrase}')] | //*[@role='button'][contains(., '${phrase}')]`;
                    try {
                        const res = document.evaluate(xpath, document.body, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                        chatBtn = res.singleNodeValue;
                        if (chatBtn && chatBtn.offsetParent !== null) break;
                    } catch (_) { }
                }
                if (chatBtn) break;
                await wait(1000);
            }
            if (!chatBtn) {
                console.log("[Bot] ❌ Кнопка 'Чат' не найдена.");
                chrome.runtime.sendMessage({ action: 'ORDER_DONE', success: false, orderUrl: window.location.href });
                window.workInProgress = false;
                return;
            }
            console.log("[Bot] 🔹 Нашел кнопку Чат, кликаю...");
            chatBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await wait(300);
            chatBtn.click();
            await wait(3000);
            let messageInput = null;
            const inputSelectors = [
                'textarea[placeholder*="Сообщение"]', 'textarea[placeholder*="Message"]',
                'textarea[placeholder*="письмо"]', 'input[type="text"][placeholder*="Сообщение"]',
                'textarea', '[contenteditable="true"]'
            ];
            for (let i = 0; i < 8; i++) {
                for (const sel of inputSelectors) {
                    messageInput = document.querySelector(sel);
                    if (messageInput && messageInput.offsetParent !== null) break;
                }
                if (messageInput) break;
                await wait(1000);
            }
            if (!messageInput) {
                console.log("[Bot] ❌ Поле ввода сообщения не найдено");
                chrome.runtime.sendMessage({ action: 'ORDER_DONE', success: false, orderUrl: window.location.href });
                window.workInProgress = false;
                return;
            }
            const GREETING_MESSAGE = `Здравствуйте! Я ваш бот-помощник. 👋\r\n\r\nСпасибо за покупку! Если вы приобрели аккаунт с офлайн-активацией, выдача товара происходит автоматически. Ожидать продавца не нужно — данные придут вам в ближайшее время.\r\n\r\n⚠️ Важно: Если данные не поступили в течение 10 минут, пожалуйста, напишите нам в чат. Продавец подключится и решит вопрос в кратчайшие сроки.\r\n\r\n📢 Обратите внимание: Техническая поддержка и ручная выдача (в случае сбоя) работают ежедневно с 10:00 до 20:00. Если вы написали в нерабочее время, мы ответим вам сразу, как только начнем работу.\r\n\r\nЖелаем приятной игры! 🎮`;
            console.log("[Bot] ⌨️ Печатаю сообщение...");
            messageInput.focus();
            for (let char of GREETING_MESSAGE) {
                messageInput.value += char;
                messageInput.dispatchEvent(new Event('input', { bubbles: true }));
                await wait(random(50, 150));
            }
            await wait(500);
            let sendBtn = document.querySelector('button[type="submit"]') || document.querySelector('button[aria-label*="Send"]') || document.querySelector('button[aria-label*="Отправить"]');
            if (!sendBtn) {
                const buttons = document.querySelectorAll('button');
                for (const b of buttons) {
                    if (b.offsetParent && (b.textContent.includes('Отправ') || b.textContent.includes('Send') || b.querySelector('svg'))) {
                        sendBtn = b;
                        break;
                    }
                }
            }
            if (!sendBtn) {
                console.log("[Bot] ❌ Кнопка отправки не найдена");
                chrome.runtime.sendMessage({ action: 'ORDER_DONE', success: false, orderUrl: window.location.href });
                window.workInProgress = false;
                return;
            }
            console.log("[Bot] 📤 Отправляю сообщение...");
            sendBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await wait(300);
            sendBtn.click();
            await wait(1500);
            console.log("[Bot] ✅ Приветствие отправлено!");
            chrome.runtime.sendMessage({ action: 'ORDER_DONE', success: true, orderUrl: window.location.href, username: username });
            window.workInProgress = false;
        } catch (e) {
            console.log(`[Bot] ❌ ОШИБКА: ${e.message}`);
            chrome.runtime.sendMessage({ action: 'ORDER_DONE', success: false, orderUrl: window.location.href });
            window.workInProgress = false;
        }
    }

    function updateStatus(mode) {
        try {
            chrome.runtime.sendMessage({ action: 'UPDATE_MODE', mode: mode }).catch(() => { });
        } catch (e) { }
    }
})();
