// world:"MAIN" — запускается ДО загрузки скриптов страницы (document_start).
// Object.defineProperty защищает патч: Next.js не может перезаписать window.fetch.
// Setter сохраняет новую версию fetch как _base, getter всегда отдаёт prok_fetch.
(function () {
    if (window.__prokFetchPatched) return;

    var _base = (typeof fetch === 'function') ? fetch : null;
    if (!_base) return;

    window.__prokFetchPatched = true;
    console.log('[PROK-MAIN] ✓ fetch patched v3 at', location.href.slice(0, 60));

    // ── Блокировка FullStory (анти-шпион) ───────────────────────────────────────
    if (typeof window !== 'undefined' && !window.hasOwnProperty('FS')) {
        var spoofFS = function() { console.log('[PROK-MAIN] 🛡️ FullStory blocked:', arguments); };
        spoofFS.identify = spoofFS.event = spoofFS.log = spoofFS.setVars = spoofFS.clearUserCookie = spoofFS.shutdown = spoofFS.restart = spoofFS.consent = spoofFS;
        Object.defineProperty(window, 'FS', { value: spoofFS, writable: false });
        window._fs_ready = function(){};
        console.log('[PROK-MAIN] 🛡️ Injected fake FullStory (window.FS)');
    }

    var __prioCache = {};
    
    // ── Apollo UUID map (читает main world для content.js) ───────────────────────
    window.addEventListener('message', function (evt) {
        if (!evt.data || evt.data.action !== 'APOLLO_UUID_MAP_REQUEST') return;
        var scriptId = evt.data.scriptId || '';
        var map = {};
        try {
            var apollo = (window.__APOLLO_CLIENT__ && window.__APOLLO_CLIENT__.cache && typeof window.__APOLLO_CLIENT__.cache.extract === 'function')
                ? window.__APOLLO_CLIENT__.cache.extract() : (window.__APOLLO_STATE__ || {});
            var ndProps = window.__NEXT_DATA__ && window.__NEXT_DATA__.props && window.__NEXT_DATA__.props.pageProps;
            var nextData = (ndProps && ndProps.initialApolloState) || {};
            var sources = [apollo, nextData];
            for (var si = 0; si < sources.length; si++) {
                var src = sources[si];
                for (var key in src) {
                    if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
                    var v = src[key];
                    if (v && v.slug && v.id && String(v.id).indexOf('-') !== -1) {
                        var oTypeId = '';
                        if (v.obtainingType) {
                            if (v.obtainingType.id) oTypeId = v.obtainingType.id;
                            else if (v.obtainingType.__ref) oTypeId = String(v.obtainingType.__ref).replace('ObtainingType:', '');
                        }
                        map[v.slug] = { id: v.id, obtainingTypeId: oTypeId };
                    }
                }
            }
        } catch (e) {}
        window.postMessage({ action: 'APOLLO_UUID_MAP', scriptId: scriptId, map: map }, '*');
    });

    // ── Сводка: полный список лотов из Apollo+Next (страница «Завершённые») ─────
    window.addEventListener('message', function (evt) {
        if (!evt.data || evt.data.action !== 'PROK_COMPLETED_CATALOG_EXTRACT') return;
        var scriptId = evt.data.scriptId || '';
        var items = [];
        var errMsg = null;
        try {
            var RESERVED_SLUG = {
                completed: 1, active: 1, inactive: 1, draft: 1, drafts: 1, pending: 1, sales: 1, categories: 1, catalog: 1,
                new: 1, edit: 1, create: 1, moderation: 1, expired: 1, archived: 1, deleted: 1
            };
            function mergeInto(dst, src) {
                if (!src) return;
                for (var key in src) {
                    if (Object.prototype.hasOwnProperty.call(src, key)) dst[key] = src[key];
                }
            }
            function resolveRef(merged, ref) {
                if (ref == null) return null;
                if (typeof ref === 'object' && ref.__ref && merged[ref.__ref]) return merged[ref.__ref];
                if (typeof ref === 'string' && merged[ref]) return merged[ref];
                return null;
            }
            var merged = {};
            try {
                var apollo = (window.__APOLLO_CLIENT__ && window.__APOLLO_CLIENT__.cache && typeof window.__APOLLO_CLIENT__.cache.extract === 'function')
                    ? window.__APOLLO_CLIENT__.cache.extract() : {};
                mergeInto(merged, apollo);
            } catch (e0) { /* */ }
            try {
                if (window.__APOLLO_STATE__ && typeof window.__APOLLO_STATE__ === 'object') mergeInto(merged, window.__APOLLO_STATE__);
            } catch (e1) { /* */ }
            try {
                var ndProps = window.__NEXT_DATA__ && window.__NEXT_DATA__.props && window.__NEXT_DATA__.props.pageProps;
                var nextSt = (ndProps && (ndProps.initialApolloState || ndProps.apolloState)) || {};
                mergeInto(merged, nextSt);
            } catch (e2) { /* */ }
            function isSkippedTypename(tn) {
                if (!tn) return false;
                return /^(Chat|UserFragment|User|RegularUserFragment|GameProfile|Game$|File|Transaction|Testimonial|GameCategory|MinimalGameCategory|RegularGameCategory|ChatMessage|Order|Deal|ItemDeal|BankCard|Notification|Banner|Button|Icon)/i.test(tn);
            }
            function cacheKeyLooksLikeItem(key) {
                return /(^|:)(MyItem|Item|ForeignItem|MyItemProfile|ForeignItemProfile|ItemProfile|ProductItem|CatalogItem|UserItem)(:|$)/i.test(key);
            }
            function statusRu(st) {
                var m = {
                    SOLD: 'Продано (завершено)', COMPLETED: 'Завершён', FINISHED: 'Завершён',
                    DRAFT: 'Черновик', APPROVED: 'В продаже', PENDING_APPROVAL: 'На модерации',
                    PENDING_MODERATION: 'На проверке изменений', DECLINED: 'Отклонён', BLOCKED: 'Заблокирован',
                    EXPIRED: 'Истёк'
                };
                var s = String(st || '');
                return m[s] || (s ? s.replace(/_/g, ' ') : '—');
            }
            function sanitizeCatalogTitle(raw) {
                var t = String(raw || '').trim().replace(/\s+/g, ' ');
                if (!t) return t;
                t = t.replace(/^[0-9a-f]{8}-[0-9a-f-]{27,36}\s+/i, '').replace(/^[0-9a-f]{12,40}\s+/i, '');
                return t.trim() || String(raw || '').trim();
            }
            function firstNumeric() {
                var args = arguments;
                for (var i = 0; i < args.length; i++) {
                    var v = args[i];
                    if (v != null && !isNaN(Number(v))) return Math.round(Number(v));
                }
                return null;
            }
            /** Собирает все похожие на цену числа из объекта лота (в т.ч. вложенные pricing/discount) и выбирает min=max пару при большом разрыве — иначе 505/90 теряются из‑за firstNumeric. */
            function pickCatalogPricesFromItem(o) {
                var map = {};
                function add(v) {
                    if (v == null || v === '') return;
                    var n = Math.round(Number(v));
                    if (!isFinite(n) || n < 1 || n > 5e6) return;
                    map[n] = true;
                }
                var baseKeys = ['basePrice', 'prevPrice', 'previousPrice', 'oldPrice', 'strikePrice', 'listPrice', 'compareAtPrice', 'originalPrice', 'priceBeforeDiscount', 'retailPrice', 'catalogPrice', 'recommendedPrice', 'msrp'];
                var saleKeys = ['rawPrice', 'price', 'priceRub', 'salePrice', 'finalPrice', 'currentPrice', 'buyerPrice', 'amount', 'sellingPrice', 'cost'];
                var i, k, sub, sk, lk, v;
                for (i = 0; i < baseKeys.length; i++) add(o[baseKeys[i]]);
                for (i = 0; i < saleKeys.length; i++) add(o[saleKeys[i]]);
                var nests = ['pricing', 'priceInfo', 'discounts', 'discount', 'prices', 'tariff'];
                for (i = 0; i < nests.length; i++) {
                    sub = o[nests[i]];
                    if (!sub || typeof sub !== 'object' || sub.__ref) continue;
                    for (sk in sub) {
                        if (!Object.prototype.hasOwnProperty.call(sub, sk)) continue;
                        if (typeof sub[sk] === 'number') add(sub[sk]);
                    }
                }
                for (k in o) {
                    if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
                    lk = k.toLowerCase();
                    if (/percent|pct|ratio|commission|feepercent|count|quantity|priority|sequence|rank|views|sales|orders|position|index|level/i.test(lk)) continue;
                    v = o[k];
                    if (typeof v === 'number') {
                        if (v >= 1 && v <= 100 && !/price|rub|amount/.test(lk)) continue;
                        if (/price|rub|amount|cost|strike|base|old|prev|original|compare|retail|total|sum|fee$/i.test(lk)) add(v);
                    }
                }
                var arr = Object.keys(map).map(Number).sort(function (a, b) { return a - b; });
                if (!arr.length) return { priceRub: null, basePriceRub: null, salePriceRub: null };
                if (arr.length === 1) {
                    var one = arr[0];
                    return { priceRub: one, basePriceRub: null, salePriceRub: one };
                }
                var minP = arr[0];
                var maxP = arr[arr.length - 1];
                if (maxP <= minP) return { priceRub: minP, basePriceRub: null, salePriceRub: minP };
                var ratio = maxP / minP;
                if (ratio >= 1.18) {
                    return { priceRub: minP, basePriceRub: maxP, salePriceRub: minP };
                }
                var guess = firstNumeric(o.rawPrice, o.priceRub, o.price, o.salePrice, o.finalPrice, o.currentPrice) || minP;
                return { priceRub: guess, basePriceRub: null, salePriceRub: guess };
            }
            function normalizeStatusCode(o) {
                if (o && (o.isDraft === true || o.draft === true)) return 'DRAFT';
                var s = o.status || o.itemStatus || o.publicationStatus || o.lifecycleStatus || o.itemState;
                if (!s && o.state) {
                    if (typeof o.state === 'string') s = o.state;
                    else s = (o.state.status || o.state.value || o.state.code || '');
                }
                s = String(s || '').trim();
                if (!s) return '';
                return s.toUpperCase().replace(/-/g, '_').replace(/\s+/g, '_');
            }
            var seen = {};
            var base = (location.origin || 'https://playerok.com').replace(/\/$/, '');
            for (var k in merged) {
                if (!Object.prototype.hasOwnProperty.call(merged, k)) continue;
                var o = merged[k];
                if (!o || typeof o !== 'object' || !o.slug) continue;
                var tn = String(o.__typename || '');
                if (isSkippedTypename(tn)) continue;
                var keyLike = cacheKeyLooksLikeItem(k);
                var strictItem = /^(MyItem|ForeignItem|MyItemProfile|ForeignItemProfile|ItemProfile)$/i.test(tn);
                if (tn) {
                    var looseListing = /MyItem|ForeignItem|ItemProfile|CatalogItem|UserItem|ProductItem|^Item$|sellable|dealable|Listing/i.test(tn);
                    if (!strictItem && !looseListing && !keyLike) continue;
                    if (/GameProfile|GameCategory|ItemDeal|ChatMessage|Game$|User[^I]/i.test(tn)) continue;
                } else if (!keyLike) {
                    continue;
                }
                var slug = String(o.slug);
                try { slug = decodeURIComponent(slug); } catch (e3) { /* */ }
                if (RESERVED_SLUG[String(slug).toLowerCase()]) continue;
                var idStr = String(o.id || '');
                var uuidLike = /^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(idStr);
                var hasName = !!(o.name && String(o.name).trim()) || !!(o.title && String(o.title).trim());
                var hasPrice = o.rawPrice != null || o.price != null || o.amount != null || o.finalPrice != null || o.priceRub != null || o.cost != null;
                if (!(uuidLike || hasName || hasPrice || keyLike)) continue;
                if (seen[slug]) continue;
                seen[slug] = 1;
                var gObj = null;
                var gameTitle = '—';
                if (typeof o.game === 'string' && String(o.game).trim()) gameTitle = String(o.game).trim();
                else {
                    gObj = resolveRef(merged, o.game);
                    if (gObj && gObj.name) gameTitle = String(gObj.name);
                }
                if (gameTitle === '—' && o.gameName) gameTitle = String(o.gameName);
                if (gameTitle === '—' && o.gameTitle) gameTitle = String(o.gameTitle);
                var categoryName = '';
                if (typeof o.category === 'string' && String(o.category).trim()) categoryName = String(o.category).trim();
                else {
                    var catObj = resolveRef(merged, o.category) || resolveRef(merged, o.gameCategory) || resolveRef(merged, o.subcategory)
                        || resolveRef(merged, o.primaryCategory) || resolveRef(merged, o.sellCategory) || resolveRef(merged, o.listingCategory)
                        || resolveRef(merged, o.itemCategory) || resolveRef(merged, o.gamePageCategory)
                        || resolveRef(merged, o.minimalGameCategory) || resolveRef(merged, o.regularGameCategory);
                    if (catObj && catObj.name) categoryName = String(catObj.name);
                }
                if (!categoryName && o.categoryName) categoryName = String(o.categoryName).trim();
                if (!categoryName && gObj && typeof gObj === 'object') {
                    var gCatKeys = ['lotCategory', 'defaultCategory', 'category', 'gameCategory', 'sellCategory', 'profileCategory', 'primaryCategory', 'sellerCategory', 'listingCategory', 'minimalGameCategory', 'regularGameCategory'];
                    for (var gki = 0; gki < gCatKeys.length && !categoryName; gki++) {
                        var gkRef = gObj[gCatKeys[gki]];
                        var gCatNode = resolveRef(merged, gkRef);
                        if (gCatNode && gCatNode.name) categoryName = String(gCatNode.name);
                    }
                }
                if (!categoryName) {
                    var gid = o.gameCategoryId || o.categoryId || o.sellCategoryId || o.primaryCategoryId;
                    if (gid) {
                        var gids = String(gid);
                        for (var ck in merged) {
                            if (!Object.prototype.hasOwnProperty.call(merged, ck)) continue;
                            var cn = merged[ck];
                            if (!cn || typeof cn !== 'object' || !cn.name) continue;
                            if (String(cn.id || '') !== gids) continue;
                            var ctn = String(cn.__typename || '');
                            if (/category/i.test(ctn) || /Category:/i.test(ck)) {
                                categoryName = String(cn.name);
                                break;
                            }
                        }
                    }
                }
                var obtainingTypeId = '';
                if (o.obtainingType) {
                    if (o.obtainingType.id) obtainingTypeId = String(o.obtainingType.id);
                    else if (o.obtainingType.__ref) {
                        var otNode = resolveRef(merged, o.obtainingType);
                        if (otNode && otNode.id) obtainingTypeId = String(otNode.id);
                    }
                }
                var sortTs = 0;
                var dateFields = ['updatedAt', 'modifiedAt', 'createdAt', 'publishedAt', 'dateUpdated', 'lastUpdated', 'completedAt'];
                for (var di = 0; di < dateFields.length && !sortTs; di++) {
                    var dv = o[dateFields[di]];
                    if (dv == null) continue;
                    if (typeof dv === 'number' && isFinite(dv)) {
                        sortTs = dv < 1e12 ? Math.round(dv * 1000) : Math.round(dv);
                    } else if (typeof dv === 'string') {
                        var parsed = Date.parse(dv);
                        if (!isNaN(parsed)) sortTs = parsed;
                    }
                }
                var title = sanitizeCatalogTitle(String(o.name || o.title || slug || '—'));
                var picked = pickCatalogPricesFromItem(o);
                var priceRub = picked.priceRub;
                var basePriceRub = picked.basePriceRub;
                var salePriceRub = picked.salePriceRub != null ? picked.salePriceRub : priceRub;
                var hasDiscount = false;
                if (basePriceRub != null && salePriceRub != null && basePriceRub > salePriceRub) {
                    var brat = basePriceRub / salePriceRub;
                    var pcp = (1 - salePriceRub / basePriceRub) * 100;
                    hasDiscount = brat >= 1.28 || pcp >= 22;
                } else {
                    hasDiscount = !!(o.hasDiscount || o.discountPercent || o.discount);
                }
                var st = normalizeStatusCode(o);
                var boostedMark = !!(o.boostedMark || o.isBoosted || o.wasBoosted || o.hasBoost || o.priorityBump || o.boostedUntil || (o.priorityStatus && String(o.priorityStatus).length > 0));
                items.push({
                    id: String(o.id || ''),
                    slug: slug,
                    title: title,
                    gameTitle: gameTitle,
                    categoryName: categoryName,
                    obtainingTypeId: obtainingTypeId,
                    _sortTs: sortTs,
                    priceRub: priceRub,
                    basePriceRub: basePriceRub,
                    salePriceRub: salePriceRub,
                    hasDiscount: hasDiscount,
                    status: st,
                    statusLabel: statusRu(st),
                    boostedMark: boostedMark,
                    url: base + '/products/' + encodeURIComponent(slug)
                });
            }
            items.sort(function (a, b) {
                var ta = Number(a._sortTs) || 0;
                var tb = Number(b._sortTs) || 0;
                if (tb !== ta) return tb - ta;
                return 0;
            });
        } catch (e) {
            errMsg = e && e.message ? e.message : 'extract error';
        }
        window.postMessage({ action: 'PROK_COMPLETED_CATALOG_RESULT', scriptId: scriptId, items: items, error: errMsg }, '*');
    });

    // ── prok_fetch: перехватчик GraphQL ─────────────────────────────────────────
    function prok_fetch(url, opts) {
        window.__prokFetchCallCount = (window.__prokFetchCallCount || 0) + 1;
        var baseFn = _base;
        if (!baseFn || baseFn === prok_fetch) return Promise.reject(new TypeError('prok: no base fetch'));
        var p;
        try { p = baseFn.apply(this, arguments); } catch (e) { return Promise.reject(e); }
        try {
            var u = typeof url === 'string' ? url
                : (url instanceof Request ? url.url : String(url || ''));
            if (window.__prokDebugFetch) console.log('[PROK-DBG] fetch url:', u.slice(0, 100), 'bodyType:', opts && typeof opts.body);
            if (u.indexOf('graphql') !== -1) {
                window.__prokGqlHitCount = (window.__prokGqlHitCount || 0) + 1;
                var rawBody = opts && opts.body;
                var bodyStr = typeof rawBody === 'string' ? rawBody : '';
                if (window.__prokDebugFetch) console.log('[PROK-MAIN] graphql hit! url:', u.slice(0, 80), 'bodyType:', typeof rawBody);
                if (!bodyStr && rawBody instanceof Blob) {
                    rawBody.text().then(function(t) { console.log('[PROK-MAIN] blob body:', t.slice(0, 120)); }).catch(function(){});
                }

                // ── POST GraphQL (тело — JSON) ────────────────────────────────────
                if (bodyStr && bodyStr.charCodeAt(0) === 123) {
                    var reqList = [];
                    try { var parsed = JSON.parse(bodyStr); reqList = Array.isArray(parsed) ? parsed : [parsed]; } catch (_) {}
                    if (reqList.length) {
                        for (var ri = 0; ri < reqList.length; ri++) {
                            if (_opName(reqList[ri]) === 'publishitem') {
                                _schedulePublishFromCache(reqList[ri]);
                            }
                        }
                        var capturedReqList = reqList;
                        p.then(function (res) {
                            return res.clone().json().then(function (d) {
                                var ra = Array.isArray(d) ? d : null;
                                for (var i = 0; i < capturedReqList.length; i++) {
                                    var bod = capturedReqList[i];
                                    if (!bod) continue;
                                    var dj = ra ? ra[i] : (i === 0 ? d : null);
                                    if (!dj) continue;
                                    var op = _opName(bod);
                                    console.log('[PROK-MAIN] op:', op || '?', Object.keys((dj && dj.data) || {}));
                                    _handle(bod, dj);
                                }
                            }).catch(function(e) { if (e && e.name !== 'AbortError') console.log('[PROK-MAIN] json parse error:', e && e.message); });
                        }).catch(function (e) { if (e && e.name !== 'AbortError') console.log('[PROK-MAIN] response clone error:', e && e.message); });
                    }
                }

                // ── GET GraphQL (Playerok APQ: ?operationName=...&variables=...) ──
                // Большинство запросов Playerok идут через GET с параметрами в URL
                if (!bodyStr) {
                    try {
                        var urlObj = new URL(u, location.origin);
                        var getOpName = urlObj.searchParams.get('operationName') || '';
                        var getVarStr = urlObj.searchParams.get('variables') || '';
                        var getExtStr = urlObj.searchParams.get('extensions') || '';
                        if (getOpName || getVarStr) {
                            var getVars = null;
                            try { getVars = getVarStr ? JSON.parse(getVarStr) : null; } catch(_) {}
                            var getExt = null;
                            try { getExt = getExtStr ? JSON.parse(getExtStr) : null; } catch(_) {}
                            var capturedGetOp = getOpName;
                            var capturedGetVars = getVars;
                            p.then(function(res) {
                                return res.clone().json().then(function(d) {
                                    console.log('[PROK-MAIN] get-gql:', capturedGetOp, Object.keys((d && d.data) || {}));
                                }).catch(function() {});
                            }).catch(function() {});
                        }
                    } catch (_get) {}
                }
            }
        } catch (_) {}
        return p;
    }

    // Безопасный клон объекта — ограничение глубины и размера, защита от circular refs
    function _safeClone(obj, depth) {
        if (depth <= 0) return '[...]';
        if (obj === null || obj === undefined) return obj;
        if (typeof obj !== 'object') return obj;
        if (Array.isArray(obj)) {
            var arr = [];
            for (var ai = 0; ai < Math.min(obj.length, 30); ai++) arr.push(_safeClone(obj[ai], depth - 1));
            return arr;
        }
        var keys = Object.keys(obj).slice(0, 40);
        var out = {};
        for (var ki = 0; ki < keys.length; ki++) {
            try { out[keys[ki]] = _safeClone(obj[keys[ki]], depth - 1); } catch (_) { out[keys[ki]] = '[err]'; }
        }
        return out;
    }

    // Object.defineProperty ТОЛЬКО с getter (без setter).
    // Попытки перезаписать window.fetch (Next.js, полифилы) тихо игнорируются.
    // _base остаётся оригинальным нативным fetch → нет рекурсии.
    try {
        Object.defineProperty(window, 'fetch', {
            configurable: true, enumerable: true,
            get: function () { return prok_fetch; }
        });
    } catch (e) {
        window.fetch = prok_fetch;
    }
        window.__prokFetchCallCount = 0;
        window.__prokDebugFetch = false; // включи через консоль: window.__prokDebugFetch = true // для диагностики

    // ── Вспомогательные функции ───────────────────────────────────────────────────

    // Резервный путь: читаем Apollo кэш через 1.5с после publishItem.
    // Нужен потому что Apollo использует AbortController: после успешного ответа сервера
    // React-навигация отменяет сигнал → наш clone().text() падает с AbortError.
    // Но данные в кэше уже есть — Apollo успел их записать до отмены.
    function _schedulePublishFromCache(bod) {
        var itemId = bod.variables && bod.variables.input && bod.variables.input.itemId;
        if (!itemId) return;
        setTimeout(function () {
            try {
                var apollo = window.__APOLLO_CLIENT__ || window.__apolloClient__;
                if (!apollo) {
                    // Ищем в window по ключам
                    for (var wk in window) {
                        try {
                            var wv = window[wk];
                            if (wv && typeof wv === 'object' && wv.cache && typeof wv.cache.extract === 'function' && typeof wv.query === 'function') {
                                apollo = wv; break;
                            }
                        } catch(_) {}
                    }
                }
                if (!apollo || !apollo.cache || typeof apollo.cache.extract !== 'function') return;
                var data = apollo.cache.extract();
                // Пробуем оба возможных ключа
                var item = data['MyItem:' + itemId] || data['Item:' + itemId];
                if (!item || !item.slug) {
                    // Fallback: перебираем кэш в поиске нашего itemId
                    for (var k in data) {
                        if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
                        var v = data[k];
                        if (v && v.id === itemId && v.slug) { item = v; break; }
                    }
                }
                if (!item || !item.slug) return;
                var st = item.status || '';
                if (/^(DRAFT|EXPIRED|DELETED|CANCELLED|REJECTED)$/i.test(st)) return;
                var base = (location.origin || 'https://playerok.com').replace(/\/$/, '');
                var href = base + '/products/' + item.slug;
                console.log('[PROK-MAIN] → publish (from cache)', itemId.slice(0, 8), st, href.slice(0, 60));
                _pub(href, itemId, st || 'PENDING_APPROVAL');
            } catch (e) { console.log('[PROK-MAIN] cache poll error:', e && e.message); }
        }, 1500);
    }

    function _opName(b) {
        var n = String(b && b.operationName || '').toLowerCase();
        if (n) return n;
        var q = String(b && b.query || '');
        if (q.indexOf('publishItem') !== -1) return 'publishitem';
        if (q.indexOf('createItem') !== -1) return 'createitem';
        if (q.indexOf('updateItem') !== -1) return 'updateitem';
        if (q.indexOf('deleteItem') !== -1) return 'deleteitem';
        if (q.indexOf('archiveItem') !== -1) return 'archiveitem';
        if (q.indexOf('increaseItemPriorityStatus') !== -1) return 'increaseitemprioritystatus';
        if (q.indexOf('validateItemData') !== -1) return 'validateitemdata';
        return '';
    }

    function _pub(href, itemId, status) {
        if (!href || !itemId) return;
        if (/^(SOLD|CANCELLED|REJECTED|DELETED|CLOSED)$/i.test(status || '')) return;
        console.log('[PROK-MAIN] → publish', itemId.slice(0, 8), status);
        window.postMessage({ __prok_pub_v1__: 1, href: href, status: status || '', itemId: itemId }, '*');
    }

    function _del(itemId, href) {
        if (!itemId && !href) return;
        window.postMessage({ __prok_del_v1__: 1, itemId: itemId || '', href: href || location.href }, '*');
    }

    function _handle(bod, dj) {
        var op = _opName(bod);

        if (op === 'validateitemdata') {
            var vid = bod.variables && bod.variables.input && bod.variables.input.itemId;
            var vd = dj.data && dj.data.validateItemData;
            if (vid && vd && vd.priorityStatuses) __prioCache[vid] = vd.priorityStatuses;
            return;
        }

        if (op === 'increaseitemprioritystatus' && bod.variables && bod.variables.input) {
            var inp = bod.variables.input;
            var pid = (inp.priorityStatuses || [])[0];
            if (dj.errors && dj.errors.length) return;
            if (!(dj.data && dj.data.increaseItemPriorityStatus)) return;
            var priceBoost = 0, lst = __prioCache[inp.itemId] || [];
            for (var j = 0; j < lst.length; j++) { if (lst[j].id === pid) { priceBoost = Number(lst[j].price) || 0; break; } }
            window.postMessage({ __prok_boost_v1__: 1, href: location.href, itemId: inp.itemId || '', priorityId: pid || '', priceRub: Math.round(priceBoost) }, '*');
            return;
        }

        if (op === 'publishitem') {
            var inp2 = (bod.variables && bod.variables.input) || {};
            var pubId = inp2.itemId || '';
            var pubPrio = (inp2.priorityStatuses || [])[0];
            var pi = dj.data && dj.data.publishItem;
            if (pi && pi.id) {
                var base = (location.origin || 'https://playerok.com').replace(/\/$/, '');
                var hrefPub = (pi.slug && pi.slug.length)
                    ? base + '/products/' + pi.slug
                    : (pubId ? base + '/products/' + pubId : location.href);
                if (hrefPub.indexOf('/products/') === -1) hrefPub = location.href;
                _pub(hrefPub, pubId || pi.id, pi.status);
                var lstP = __prioCache[pubId] || [], prP = 0;
                for (var q = 0; q < lstP.length; q++) { if (lstP[q].id === pubPrio) { prP = Number(lstP[q].price) || 0; break; } }
                if (pubPrio && prP > 0) window.postMessage({ __prok_boost_v1__: 1, href: hrefPub, itemId: pubId || '', priorityId: pubPrio, priceRub: Math.round(prP) }, '*');
            }
            return;
        }

        if (op === 'createitem') {
            var ci = dj.data && dj.data.createItem;
            if (ci && ci.id) {
                var baseC = (location.origin || 'https://playerok.com').replace(/\/$/, '');
                var hrefCi = ci.slug ? baseC + '/products/' + ci.slug : location.href;
                if (hrefCi.indexOf('/products/') !== -1) _pub(hrefCi, ci.id, ci.status);
            }
            return;
        }

        if (op === 'deleteitem' || op === 'archiveitem' || op === 'removeitem') {
            var delId = (bod.variables && (bod.variables.itemId || bod.variables.id)) || '';
            var dr = dj.data && (dj.data.deleteItem || dj.data.archiveItem || dj.data.removeItem);
            _del((dr && dr.id) ? String(dr.id) : String(delId), location.href);
            return;
        }

        if (op === 'updateitem' && bod.variables && bod.variables.input) {
            var ui = dj.data && dj.data.updateItem;
            if (!ui || !ui.id) return;
            var stU = ui.status || '';
            if (/^(DELETED|CANCELLED|REJECTED|CLOSED)$/i.test(stU)) { _del(String(ui.id), location.href); return; }
            if (/PUBLISHED|ACTIVE|MODERATION|MODERATING|PENDING|PROCESSING|REVIEW|DRAFT|EXPIRED|WAITING|SUBMITTED|LISTED|VISIBLE|SCHEDULED|QUEUE|APPROVAL/i.test(stU)) {
                if (location.href.indexOf('/products/') !== -1) _pub(location.href, ui.id, stU);
            }
            return;
        }

        // Fallback
        var dk = dj && dj.data;
        if (dk && typeof dk === 'object') {
            for (var fk in dk) {
                if (!Object.prototype.hasOwnProperty.call(dk, fk)) continue;
                if (fk === '__typename' || fk === 'validateItemData' || fk === 'increaseItemPriorityStatus') continue;
                var nf = dk[fk];
                if (!nf || typeof nf !== 'object' || !nf.id) continue;
                var sf = nf.status || '';
                if (/^(DELETED|CANCELLED|REJECTED|CLOSED)$/i.test(sf)) { _del(String(nf.id), location.href); break; }
                if (/^SOLD$/i.test(sf)) continue;
                if (nf.slug || /PUBLISHED|ACTIVE|MODERATION|PENDING|PROCESSING|DRAFT|WAITING|APPROVAL|EXPIRED/i.test(sf)) {
                    var hrefFb = nf.slug
                        ? (location.origin || 'https://playerok.com').replace(/\/$/, '') + '/products/' + nf.slug
                        : location.href;
                    if (hrefFb.indexOf('/products/') !== -1) { _pub(hrefFb, nf.id, sf); break; }
                }
            }
        }
    }
})();
