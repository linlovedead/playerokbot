// Bridge Pattern: выполняет GraphQL запросы в контексте страницы Playerok.
// Перехват window.fetch вынесен в content_bridge_main.js (world:MAIN, обходит CSP).
// Этот файл: isolated world — слушаем postMessage, пишем в storage, шлём сообщения в SW.

(function () {
    // ── Утилиты прямой записи в storage (работают даже если SW выгружен) ──────────

    function _normUrl(u) {
        if (!u || typeof u !== 'string') return '';
        var s = u.split(/[?#]/)[0].replace(/\/$/, '');
        return s.replace(/^https?:\/\/(www\.)?playerok\.com/i, 'https://playerok.com');
    }

    function _parseSlugFromUrl(u) {
        try {
            var path = new URL(u).pathname;
            var m = path.match(/^\/products\/([^/]+)\/?$/i);
            if (!m) return '';
            var s = m[1];
            try { s = decodeURIComponent(s); } catch (_) {}
            var reserved = { completed:1, active:1, inactive:1, draft:1, drafts:1, pending:1, sales:1, new:1, edit:1, create:1, deleted:1 };
            return reserved[s.toLowerCase()] ? '' : s;
        } catch (_) { return ''; }
    }

    /** Патчит статус лота в снимке «Все товары» при ручной публикации. */
    function _patchCompletedCatalogPublished(itemId, href) {
        var pid = String(itemId || '').trim();
        var slug = href ? _parseSlugFromUrl(_normUrl(href)) : '';
        if (!pid && !slug) return;
        var KEY = 'dashboard_completed_catalog_v1';
        chrome.storage.local.get(KEY, function (raw) {
            if (chrome.runtime.lastError) return;
            var payload = raw[KEY];
            if (!payload || !Array.isArray(payload.items)) return;
            var changed = false;
            for (var i = 0; i < payload.items.length; i++) {
                var it = payload.items[i];
                if (!it) continue;
                if ((pid && String(it.id || '') === pid) || (slug && String(it.slug || '') === slug)) {
                    it.status = 'APPROVED';
                    it.statusLabel = 'В продаже';
                    changed = true;
                }
            }
            if (changed) {
                payload.fetchedAt = Date.now();
                var sv = {}; sv[KEY] = payload;
                chrome.storage.local.set(sv);
            }
        });
    }

    /** Удаляет лот из снимка «Все товары» при ручном удалении. */
    function _removeFromCompletedCatalog(itemId, href) {
        var pid = String(itemId || '').trim();
        var slug = href ? _parseSlugFromUrl(_normUrl(href)) : '';
        if (!pid && !slug) return;
        var KEY = 'dashboard_completed_catalog_v1';
        chrome.storage.local.get(KEY, function (raw) {
            if (chrome.runtime.lastError) return;
            var payload = raw[KEY];
            if (!payload || !Array.isArray(payload.items)) return;
            var before = payload.items.length;
            payload.items = payload.items.filter(function (it) {
                if (!it) return false;
                if (pid && String(it.id || '') === pid) return false;
                if (slug && String(it.slug || '') === slug) return false;
                return true;
            });
            if (payload.items.length !== before) {
                payload.fetchedAt = Date.now();
                var sv = {}; sv[KEY] = payload;
                chrome.storage.local.set(sv);
            }
        });
    }

    function _writeDashboardPublishDirect(href, itemId, status) {
        if (!href && !itemId) return;
        var target = _normUrl(href);
        if (!target && itemId) target = 'https://playerok.com/products/' + itemId;
        if (!target || target.indexOf('/products/') === -1) return;
        var DRAFTS_KEY = 'dashboard_drafts_v1';
        var PUB_KEY = 'dashboard_published_v1';
        chrome.storage.local.get([DRAFTS_KEY, PUB_KEY], function (raw) {
            if (chrome.runtime.lastError) return;
            var drafts = Array.isArray(raw[DRAFTS_KEY]) ? raw[DRAFTS_KEY] : [];
            var pub = Array.isArray(raw[PUB_KEY]) ? raw[PUB_KEY] : [];
            var now = Date.now();
            // Dedup 60 s
            var isDup = pub.some(function (p) {
                var pu = _normUrl(p.url || '');
                if (itemId && String(p.itemId || '') === itemId) return (now - (p.at || 0)) < 60000;
                return pu === target && (now - (p.at || 0)) < 60000;
            });
            if (isDup) return;
            // Найти совпадающий черновик
            var draftIdx = -1;
            for (var di = 0; di < drafts.length; di++) {
                var d = drafts[di];
                var du = _normUrl(d.url || '');
                if ((du && du === target) || (itemId && String(d.itemId || '') === itemId)) {
                    draftIdx = di; break;
                }
            }
            var record;
            if (draftIdx >= 0) {
                var dr = drafts[draftIdx];
                var titleRaw = String(dr.title || '').replace(/\s*\[черновик\]\s*$/i, '').trim() || dr.title || '';
                record = {
                    id: 'pub_' + now + '_' + Math.random().toString(36).slice(2, 9),
                    at: now, title: titleRaw,
                    basePriceRub: dr.basePriceRub != null ? Math.round(Number(dr.basePriceRub)) : null,
                    salePriceRub: dr.salePriceRub != null ? Math.round(Number(dr.salePriceRub)) : null,
                    hasDiscount: !!dr.hasDiscount, url: href || dr.url || '',
                    itemId: itemId || dr.itemId || '',
                    quantity: Math.max(1, parseInt(dr.quantity, 10) || 1),
                    source: 'promoted_from_draft'
                };
                drafts = drafts.filter(function (_, i) { return i !== draftIdx; });
            } else {
                // Обновить существующую запись «опубликованные» по URL
                var exIdx = -1;
                for (var pi = 0; pi < pub.length; pi++) {
                    if (_normUrl(pub[pi].url || '') === target) { exIdx = pi; break; }
                }
                if (exIdx >= 0) {
                    var ex = pub.splice(exIdx, 1)[0];
                    pub.unshift(Object.assign({}, ex, { itemId: itemId || ex.itemId, at: now }));
                    chrome.storage.local.set({ [PUB_KEY]: pub.slice(0, 2000) });
                    return;
                }
                var slug = target.split('/').pop() || '';
                record = {
                    id: 'pub_' + now + '_' + Math.random().toString(36).slice(2, 9),
                    at: now, title: decodeURIComponent(slug).replace(/-/g, ' '),
                    basePriceRub: null, salePriceRub: null, hasDiscount: false,
                    url: href || target, itemId: itemId || '', quantity: 1, source: 'page_publish'
                };
            }
            pub.unshift(record);
            var save = {};
            save[DRAFTS_KEY] = drafts.slice(0, 2000);
            save[PUB_KEY] = pub.slice(0, 2000);
            chrome.storage.local.set(save);
        });
    }

    function _writeDashboardDeleteDirect(itemId, href) {
        var target = _normUrl(href || '');
        var pid = String(itemId || '').trim();
        if (!pid && !target) return;
        var DRAFTS_KEY = 'dashboard_drafts_v1';
        var PUB_KEY = 'dashboard_published_v1';
        chrome.storage.local.get([DRAFTS_KEY, PUB_KEY], function (raw) {
            if (chrome.runtime.lastError) return;
            var drafts = Array.isArray(raw[DRAFTS_KEY]) ? raw[DRAFTS_KEY] : [];
            var pub = Array.isArray(raw[PUB_KEY]) ? raw[PUB_KEY] : [];
            function shouldRemove(e) {
                if (pid && String(e.itemId || '') === pid) return true;
                if (target && _normUrl(e.url || '') === target) return true;
                return false;
            }
            var d2 = drafts.filter(function (e) { return !shouldRemove(e); });
            var p2 = pub.filter(function (e) { return !shouldRemove(e); });
            if (d2.length !== drafts.length || p2.length !== pub.length) {
                var sv = {};
                sv[DRAFTS_KEY] = d2;
                sv[PUB_KEY] = p2;
                chrome.storage.local.set(sv);
            }
        });
    }

    console.log('[PROK-ISO] isolated world loaded ✓');

    // ── Слушатель postMessage от content_bridge_main.js ───────────────────────────
    window.addEventListener('message', function (evt) {
        if (!evt.data) return;

        if (evt.data.__prok_pub_v1__ || evt.data.__prok_del_v1__ || evt.data.__prok_boost_v1__) {
            console.log('[PROK-ISO] postMessage received:', JSON.stringify(evt.data).slice(0, 200));
        }

        if (evt.data.__prok_boost_v1__) {
            try {
                chrome.runtime.sendMessage({
                    action: 'PAGE_PAID_BUMP_DETECTED',
                    href: evt.data.href || '',
                    itemId: evt.data.itemId || '',
                    priceRub: evt.data.priceRub || 0
                }).catch(function () { });
            } catch (_) { }
            return;
        }

        if (evt.data.__prok_del_v1__) {
            _writeDashboardDeleteDirect(evt.data.itemId || '', evt.data.href || '');
            // Убрать из снимка «Все товары» напрямую (не ждём SW)
            _removeFromCompletedCatalog(evt.data.itemId || '', evt.data.href || '');
            try {
                chrome.runtime.sendMessage({
                    action: 'PAGE_ITEM_DELETED',
                    itemId: evt.data.itemId || '',
                    href: evt.data.href || ''
                }).catch(function () { });
            } catch (_) { }
            return;
        }

        if (!evt.data.__prok_pub_v1__) return;
        // Пишем напрямую в storage — не зависит от того, жив ли SW
        _writeDashboardPublishDirect(evt.data.href || '', evt.data.itemId || '', evt.data.status || '');
        // Обновить статус в «Все товары» напрямую (не ждём SW)
        _patchCompletedCatalogPublished(evt.data.itemId || '', evt.data.href || '');
        // Дополнительно уведомляем background (для полной логики promote)
        try {
            chrome.runtime.sendMessage({
                action: 'PAGE_PUBLISH_DETECTED',
                href: evt.data.href || '',
                status: evt.data.status || '',
                itemId: evt.data.itemId || ''
            }).catch(function () { });
        } catch (_) { }
    });
})();

/** Как в веб-клиенте Playerok (PyPlayerokAPI transport): без x-gql-op часть операций отвечает 403. */
function playerokWebGqlHeaders(operationName) {
    const op = operationName || 'viewer';
    return {
        'accept': '*/*',
        'apollo-require-preflight': 'true',
        'x-apollo-operation-name': op,
        'x-gql-op': op,
        'x-gql-path': '/',
        'apollographql-client-name': 'web',
        'x-timezone-offset': String(-new Date().getTimezoneOffset())
    };
}


// ── Обработчики сообщений от background.js ────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'PING') {
        sendResponse({ ok: true, status: 'PONG' });
        return false;
    }

    if (request.action === 'GET_REDIRECT_URL') {
        fetch(request.url, { method: 'HEAD', credentials: 'include' })
            .then(res => sendResponse({ finalUrl: res.url }))
            .catch(err => sendResponse({ error: err.message }));
        return true;
    }
    if (request.action === 'FETCH_PAGE' || request.action === 'FETCH_PAGE_HTML') {
        const url = request.url;
        fetch(url, { credentials: 'include' })
            .then(r => r.text())
            .then(html => {
                let chatId = null;
                const parser = new DOMParser();
                const doc = parser.parseFromString(html, 'text/html');
                const chatLink = doc.querySelector('a[href^="/chats/"]');
                if (chatLink) {
                    const match = chatLink.getAttribute('href').match(/\/chats\/([a-f0-9-]+)/);
                    if (match) chatId = match[1];
                }
                if (!chatId) {
                    const patterns = [
                        /href=["']\/chats?\/([0-9a-fA-F-]{36})["']/,
                        /"chatId"\s*:\s*["']([0-9a-fA-F-]{36})["']/,
                        /chatId["']?\s*:\s*["']([0-9a-fA-F-]{36})["']/,
                        /\/chats?\/([0-9a-fA-F-]{36})/
                    ];
                    for (const re of patterns) {
                        const m = html.match(re);
                        if (m) { chatId = m[1]; break; }
                    }
                }
                sendResponse({ success: true, html, chatId });
            })
            .catch(e => sendResponse({ success: false, error: e.message }));
        return true;
    }
    if (request.action === 'GENERATE_AND_UPLOAD') {
        const {
            operationName, query, variables, templateBase64, coords, bannerUrl, screenshotUrls,
            preRenderedCardDataUrl
        } = request;

        if (preRenderedCardDataUrl && String(preRenderedCardDataUrl).startsWith('data:image')) {
            const imgFull = new Image();
            let _imgDone = false;
            const _imgTimeout = setTimeout(() => {
                if (_imgDone) return;
                _imgDone = true;
                sendResponse({ success: false, error: 'Pre-rendered card image load timeout (15s)' });
            }, 15000);
            imgFull.onload = async () => {
                if (_imgDone) return;
                _imgDone = true;
                clearTimeout(_imgTimeout);
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = imgFull.width;
                    canvas.height = imgFull.height;
                    const x = canvas.getContext('2d');
                    x.drawImage(imgFull, 0, 0);
                    canvas.toBlob(async blob => {
                        if (!blob) return sendResponse({ success: false, error: 'Canvas toBlob failed (full card)' });
                        try {
                            const formData = new FormData();
                            formData.append('operations', JSON.stringify({ operationName, query, variables }));
                            formData.append('map', JSON.stringify({ "1": ["variables.attachments.0"] }));
                            const ext = blob.type ? blob.type.split('/')[1] : 'jpg';
                            formData.append('1', blob, 'cover.' + ext);
                            const ctrl = new AbortController();
                            const timer = setTimeout(() => ctrl.abort(), 25000);
                            try {
                                const res = await fetch('/graphql', {
                                    method: 'POST',
                                    credentials: 'include',
                                    headers: playerokWebGqlHeaders(operationName),
                                    body: formData,
                                    signal: ctrl.signal
                                });
                                const text = await res.text();
                                clearTimeout(timer);
                                if (!res.ok) return sendResponse({ success: false, error: `HTTP ${res.status}: ${text}` });
                                const json = JSON.parse(text);

                                if (json.errors) sendResponse({ success: false, error: json.errors[0]?.message || 'GraphQL error' });
                                else sendResponse({ success: true, data: json.data });
                            } catch (e) {
                                clearTimeout(timer);
                                sendResponse({ success: false, error: 'Upload fail: ' + (e.message || String(e)) });
                            }
                        } catch (e) {
                            sendResponse({ success: false, error: String(e.message || e) });
                        }
                    }, 'image/jpeg', 0.95);
                } catch (e) {
                    sendResponse({ success: false, error: 'Full card render error: ' + e.message });
                }
            };
            imgFull.onerror = () => {
                if (_imgDone) return;
                _imgDone = true;
                clearTimeout(_imgTimeout);
                sendResponse({ success: false, error: 'Failed to load pre-rendered card image' });
            };
            imgFull.src = preRenderedCardDataUrl;
            return true;
        }

        async function fetchBlobTimeout(url, timeoutMs = 15000) {
            async function tryOnce(ms) {
                const ctrl = new AbortController();
                const timer = setTimeout(() => ctrl.abort(), ms);
                try {
                    const res = await fetch(url, { signal: ctrl.signal });
                    if (!res.ok) return null;
                    return await res.blob();
                } catch (_) {
                    return null;
                } finally {
                    clearTimeout(timer);
                }
            }
            let blob = await tryOnce(timeoutMs);
            if (blob) return blob;
            await new Promise(r => setTimeout(r, 450));
            return tryOnce(Math.min(timeoutMs, 14000));
        }

        function roundedPath(ctx, x, y, width, height, radius) {
            ctx.moveTo(x + radius, y);
            ctx.lineTo(x + width - radius, y);
            ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
            ctx.lineTo(x + width, y + height - radius);
            ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
            ctx.lineTo(x + radius, y + height);
            ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
            ctx.lineTo(x, y + radius);
            ctx.quadraticCurveTo(x, y, x + radius, y);
            ctx.closePath();
        }

        function fillRoundedRect(ctx, fillStyle, x, y, width, height, radius) {
            ctx.save();
            ctx.beginPath();
            roundedPath(ctx, x, y, width, height, radius);
            ctx.fillStyle = fillStyle;
            ctx.fill();
            ctx.restore();
        }

        function drawRoundedRect(ctx, img, x, y, width, height, radius) {
            ctx.save();
            ctx.beginPath();
            roundedPath(ctx, x, y, width, height, radius);
            ctx.clip();
            ctx.drawImage(img, x, y, width, height);
            ctx.restore();
        }

        const REF_TEMPLATE_W = 1280;
        const REF_TEMPLATE_H = 1400;
        const REF_BANNER_BOX = [91, 250, 1221, 620];

        function clampBannerBox(box, imgW, imgH) {
            const [l, t, r, b] = box;
            if (typeof l !== 'number' || typeof t !== 'number' || typeof r !== 'number' || typeof b !== 'number') return null;
            if (Number.isNaN(l) || Number.isNaN(t) || Number.isNaN(r) || Number.isNaN(b)) return null;
            const L = Math.max(0, Math.min(l, imgW - 2));
            const T = Math.max(0, Math.min(t, imgH - 2));
            const R = Math.min(Math.max(L + 4, r), imgW);
            const B = Math.min(Math.max(T + 4, b), imgH);
            if (R <= L + 2 || B <= T + 2) return null;
            return [L, T, R, B];
        }

        function scaledDefaultBannerBox(imgW, imgH) {
            return [
                Math.round(REF_BANNER_BOX[0] * imgW / REF_TEMPLATE_W),
                Math.round(REF_BANNER_BOX[1] * imgH / REF_TEMPLATE_H),
                Math.round(REF_BANNER_BOX[2] * imgW / REF_TEMPLATE_W),
                Math.round(REF_BANNER_BOX[3] * imgH / REF_TEMPLATE_H),
            ];
        }

        function resolveBannerBox(coords, imgW, imgH, hasBannerAssets) {
            const raw = coords && coords.banner && Array.isArray(coords.banner) && coords.banner.length >= 4
                ? coords.banner : null;
            let box = raw ? clampBannerBox(raw, imgW, imgH) : null;
            if (box) return box;
            if (!hasBannerAssets) return null;
            box = clampBannerBox(scaledDefaultBannerBox(imgW, imgH), imgW, imgH);
            if (box) {
                console.warn('[GENERATE_AND_UPLOAD] Нет валидной рамки баннера в coords — подставлена запасная.');
            }
            return box;
        }

        function uniqScreenshotUrls(pool) {
            const seen = new Set();
            const out = [];
            for (const u of pool || []) {
                const s = String(u || '').trim();
                if (!s || seen.has(s)) continue;
                seen.add(s);
                out.push(s);
            }
            return out;
        }

        function thumbSlotUrls(ssPool, bannerUsedUrl, numSlots) {
            const pool = uniqScreenshotUrls(ssPool);
            if (!numSlots) return [];
            const skip = bannerUsedUrl ? String(bannerUsedUrl).trim() : '';
            const out = [];
            let skippedOnce = false;
            for (const u of pool) {
                if (!skippedOnce && skip && u === skip) { skippedOnce = true; continue; }
                out.push(u);
                if (out.length >= numSlots) return out.slice(0, numSlots);
            }
            let p = out.length;
            while (out.length < numSlots && pool.length) { out.push(pool[p % pool.length]); p++; }
            return out.slice(0, numSlots);
        }

        async function uploadBlob(blob) {
            const formData = new FormData();
            const operations = JSON.stringify({ operationName, query, variables });
            formData.append('operations', operations);
            formData.append('map', JSON.stringify({ "1": ["variables.attachments.0"] }));
            const ext = blob.type ? blob.type.split('/')[1] : 'jpg';
            formData.append('1', blob, "cover." + ext);
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 20000);
            try {
                const res = await fetch('/graphql', {
                    method: 'POST', credentials: 'include',
                    headers: playerokWebGqlHeaders(operationName),
                    body: formData, signal: ctrl.signal
                });
                const text = await res.text();
                return { ok: res.ok, status: res.status, text };
            } finally {
                clearTimeout(timer);
            }
        }

        const img = new Image();
        img.onload = async () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);

                const BANNER_TIMEOUT_MS = 22000;
                const SS_TIMEOUT_MS = 15000;
                const ssPool = uniqScreenshotUrls(Array.isArray(screenshotUrls) ? screenshotUrls : []);
                const hasBannerAssets = (!!bannerUrl && String(bannerUrl).trim()) || ssPool.length > 0;
                const bannerBox = resolveBannerBox(coords || {}, img.width, img.height, hasBannerAssets);
                let bannerUsedUrl = null;
                if (bannerBox) {
                    const bx = bannerBox[0], by = bannerBox[1];
                    const bw = bannerBox[2] - bannerBox[0];
                    const bh = bannerBox[3] - bannerBox[1];
                    const br = 35;
                    fillRoundedRect(ctx, '#1e1e1e', bx, by, bw, bh, br);
                    let bannerBlob = null;
                    const bannerTryUrls = [];
                    if (bannerUrl && String(bannerUrl).trim()) bannerTryUrls.push(String(bannerUrl).trim());
                    const appIdMatch = bannerUrl && String(bannerUrl).match(/\/apps\/(\d+)\//);
                    if (appIdMatch) {
                        const aid = appIdMatch[1];
                        const alt = [
                            `https://cdn.akamai.steamstatic.com/steam/apps/${aid}/header.jpg`,
                            `https://steamcdn-a.akamaihd.net/steam/apps/${aid}/header.jpg`,
                            `https://cdn.cloudflare.steamstatic.com/steam/apps/${aid}/header.jpg`,
                            `https://cdn.akamai.steamstatic.com/steam/apps/${aid}/library_hero.jpg`,
                            `https://cdn.akamai.steamstatic.com/steam/apps/${aid}/capsule_616x353.jpg`
                        ];
                        for (const u of alt) if (!bannerTryUrls.includes(u)) bannerTryUrls.push(u);
                    }
                    for (const u of bannerTryUrls) {
                        try {
                            bannerBlob = await fetchBlobTimeout(u, BANNER_TIMEOUT_MS);
                            if (bannerBlob) {
                                bannerUsedUrl = u;
                                if (u !== bannerUrl) console.warn('[GENERATE] баннер загружен с запасного URL:', u.slice(0, 80));
                                break;
                            }
                        } catch (e) { console.error('Banner fetch failed', u, e); }
                    }
                    if (!bannerBlob && ssPool.length) {
                        try {
                            bannerBlob = await fetchBlobTimeout(ssPool[0], BANNER_TIMEOUT_MS);
                            if (bannerBlob) bannerUsedUrl = ssPool[0];
                        } catch (e) { console.error('Banner fallback (ssPool[0]) failed', e); }
                    }
                    if (bannerBlob) {
                        try {
                            const bImg = await createImageBitmap(bannerBlob);
                            drawRoundedRect(ctx, bImg, bx, by, bw, bh, br);
                        } catch (e) {
                            console.error('Banner createImageBitmap failed', e);
                            fillRoundedRect(ctx, '#2d2d2d', bx, by, bw, bh, br);
                        }
                    }
                }

                const ssBoxes = Array.isArray(coords.ss)
                    ? coords.ss.filter(b => Array.isArray(b) && b.length >= 4 && b.every(n => typeof n === 'number' && !Number.isNaN(n)))
                    : [];
                if (ssBoxes.length) {
                    const thumbUrls = thumbSlotUrls(ssPool, bannerUsedUrl, ssBoxes.length);
                    for (let i = 0; i < ssBoxes.length; i++) {
                        const box = ssBoxes[i];
                        const bw = box[2] - box[0];
                        const bh = box[3] - box[1];
                        fillRoundedRect(ctx, '#1e1e1e', box[0], box[1], bw, bh, 20);
                        const primary = thumbUrls[i];
                        const tryUrls = [];
                        if (primary) tryUrls.push(primary);
                        for (const u of ssPool) { if (u && u !== primary && !tryUrls.includes(u)) tryUrls.push(u); }
                        let sBlob = null;
                        for (const u of tryUrls) {
                            try { sBlob = await fetchBlobTimeout(u, SS_TIMEOUT_MS); if (sBlob) break; }
                            catch (e) { console.error('SS fetch failed', u?.slice?.(0, 80), e); }
                        }
                        if (sBlob) {
                            try {
                                const sImg = await createImageBitmap(sBlob);
                                drawRoundedRect(ctx, sImg, box[0], box[1], bw, bh, 20);
                            } catch (e) { console.error('SS draw failed', e); }
                        }
                    }
                }

                canvas.toBlob(async blob => {
                    if (!blob) return sendResponse({ success: false, error: 'Canvas toBlob failed' });
                    try {
                        const result = await uploadBlob(blob);
                        if (!result.ok) { sendResponse({ success: false, error: `HTTP ${result.status}: ${result.text}` }); return; }
                        const json = JSON.parse(result.text);
                        if (json.errors) sendResponse({ success: false, error: json.errors[0]?.message || 'GraphQL error' });
                        else sendResponse({ success: true, data: json.data });
                    } catch (e) {
                        sendResponse({ success: false, error: 'Upload fail: ' + (e.message || String(e)) });
                    }
                }, 'image/jpeg', 0.95);
            } catch (e) {
                sendResponse({ success: false, error: 'Canvas render error: ' + e.message });
            }
        };
        img.onerror = () => sendResponse({ success: false, error: 'Failed to load template image inside content script' });
        img.src = templateBase64;
        return true;
    }

    if (request.action === 'EXECUTE_GRAPHQL_FILE') {
        const { operationName, query, variables, fileUrl } = request;
        fetch(fileUrl)
            .then(res => res.blob())
            .then(blob => {
                const formData = new FormData();
                const operations = JSON.stringify({ operationName, query, variables });
                formData.append('operations', operations);
                formData.append('map', JSON.stringify({ "0": ["variables.attachments.0"] }));
                const ext = blob.type ? blob.type.split('/')[1] : 'jpg';
                formData.append('0', blob, "cover." + ext);
                return fetch('/graphql', {
                    method: 'POST', credentials: 'include',
                    headers: playerokWebGqlHeaders(operationName),
                    body: formData
                });
            })
            .then(res => res.text().then(text => ({ ok: res.ok, status: res.status, text })))
            .then(({ ok, status, text }) => {
                if (!ok) return sendResponse({ success: false, error: `HTTP ${status}: ${text}` });
                try {
                    const json = JSON.parse(text);
                    if (json.errors) sendResponse({ success: false, error: json.errors[0]?.message || 'GraphQL error' });
                    else sendResponse({ success: true, data: json.data });
                } catch (e) {
                    sendResponse({ success: false, error: 'Invalid JSON: ' + (e.message || String(e)) });
                }
            })
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (request.action !== 'EXECUTE_GRAPHQL') return false;

    const { operationName, query, variables, extensions } = request;
    const body = extensions
        ? { operationName, variables, extensions }
        : { operationName, query, variables };

    const postHeaders = Object.assign({
        'Content-Type': 'application/json'
    }, playerokWebGqlHeaders(operationName));

    function finishFromText(text, res) {
        let json = null;
        try {
            json = JSON.parse(text);
        } catch (_) {
            if (!res.ok) {
                sendResponse({ success: false, error: `HTTP ${res.status}: ${text}` });
                return;
            }
            sendResponse({ success: false, error: 'Invalid JSON' });
            return;
        }
        const httpErr = !res.ok;
        if (json.errors && json.errors.length) {
            const err0 = json.errors[0];
            const msg = err0?.message || 'GraphQL error';
            sendResponse({
                success: false,
                error: httpErr ? `HTTP ${res.status}: ${text}` : msg
            });
            return;
        }
        if (httpErr) {
            sendResponse({ success: false, error: `HTTP ${res.status}: ${text}` });
            return;
        }
        sendResponse({ success: true, data: json.data });
    }

    function shouldRetryGetPersisted(text, status) {
        if (status === 403) return true;
        try {
            const j = JSON.parse(text);
            const e0 = j?.errors?.[0];
            const code = e0?.extensions?.code || '';
            const msg = e0?.message || '';
            return /FORBIDDEN|Access denied/i.test(code + msg);
        } catch (_) {
            return false;
        }
    }

    (async () => {
        try {
            let res = await fetch('/graphql', {
                method: 'POST',
                credentials: 'include',
                headers: postHeaders,
                body: JSON.stringify(body)
            });
            let text = await res.text();
            if (extensions && shouldRetryGetPersisted(text, res.status)) {
                const params = new URLSearchParams();
                params.set('operationName', operationName || '');
                params.set('variables', JSON.stringify(variables || {}));
                params.set('extensions', JSON.stringify(extensions));
                res = await fetch('/graphql?' + params.toString(), {
                    method: 'GET',
                    credentials: 'include',
                    headers: playerokWebGqlHeaders(operationName)
                });
                text = await res.text();
            }
            finishFromText(text, res);
        } catch (err) {
            sendResponse({ success: false, error: err.message });
        }
    })();

    return true;
});
