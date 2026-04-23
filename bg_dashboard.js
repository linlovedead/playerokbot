// ==========================================
// bg_dashboard.js
// Загружается четвёртым (после bg_playerok_api.js).
// Содержит:
//   • 2FA cooldown (persistent) — глобальные задержки между выдачами кода
//   • Catalog parsing (parseCompletedCatalogFromPlayerokHtml, apolloResolve)
//   • Dashboard operations (appendDashboardSale, promoteDashboardDraftToPublishedByProductUrl)
//   • 2FA per-chat helpers (mark2FASent, is2FAOnCooldown, get2FASentAt)
//   • extractCredentialsFromText, lookupOldBuyerUuid, handleOldBuyerCodeRequest
//   • runShadowMonitor, apiScanOrders, pollChatApi, apiSendMessage
//   • apiMarkFulfilled, domClickFulfilled, SteamPass window management
// Доступ к глобальному стейту background.js через общий скоуп importScripts.
// ==========================================
// ============================================================
// PROCESSED MESSAGE IDS — TTL-based cleanup
// ============================================================
/** Очищает processedMessageIds: по размеру (>200) ИЛИ раз в час — чтобы старые ID не копились вечно */
function _pruneProcessedMessageIds() {
    const now = Date.now();
    if (processedMessageIds.size > 200 || now - _processedMessageIdsClearedAt > 3600000) {
        processedMessageIds.clear();
        _processedMessageIdsClearedAt = now;
    }
}

// ============================================================
// PERSISTENT 2FA COOLDOWN (переживает рестарт SW)
// ============================================================
const COOLDOWN_2FA_MS = 180000;      // 3 мин между кодами
const COOLDOWN_2FA_ERROR_MS = 60000; // 1 мин после ошибки
const SENT_AT_KEY = '2fa_sent_at';
const ERR_AT_KEY = '2fa_err_at';

// === ГЛОБАЛЬНАЯ ЗАДЕРЖКА 60 СЕК МЕЖДУ ЛЮБЫМИ ВЫДАЧАМИ 2FA ===
// Каждый полный цикл 2FA занимает 10–30 сек. При меньшем интервале система выдачи кодов
// начинала детектироваться как злоупотребление.
const GLOBAL_2FA_MIN_INTERVAL_MS = 5 * 60 * 1000; // 5 мин между ЛЮБЫМИ выдачами 2FA (между разными чатами/покупателями)
const GLOBAL_2FA_TIME_KEY = 'last_2fa_global_time';

async function getLastGlobal2FATime() {
    const r = await new Promise(res => chrome.storage.local.get(GLOBAL_2FA_TIME_KEY, res));
    return r[GLOBAL_2FA_TIME_KEY] || 0;
}
async function setLastGlobal2FATime() {
    await chrome.storage.local.set({ [GLOBAL_2FA_TIME_KEY]: Date.now() });
}

// === ИСТОРИЯ ЗАКАЗОВ (локальная БД) ===
const ORDERS_HISTORY_KEY = 'orders_history_db';

// === ДАШБОРД (лоты софта, продажи, буст — см. dashboard.html) ===
/** @deprecated старые записи до разделения черновик / опубликовано */
const DASHBOARD_LOTS_KEY = 'dashboard_lots_v1';
const DASHBOARD_DRAFTS_KEY = 'dashboard_drafts_v1';
const DASHBOARD_PUBLISHED_KEY = 'dashboard_published_v1';
const DASHBOARD_SALES_KEY = 'dashboard_sales_v1';
const DASHBOARD_BOOST_KEY = 'dashboard_boost_spent_v1';
/** Снимок вкладки «Завершённые» профиля (/profile/…/products/completed) для сводки */
const DASHBOARD_COMPLETED_CATALOG_KEY = 'dashboard_completed_catalog_v1';
const DASHBOARD_MAX_ROWS = 2000;
const DASHBOARD_MAX_CATALOG_ITEMS = 2000;

async function patchCompletedCatalogListingByUrl(productUrl, patch) {
    const slug = parsePublicProductSlugFromUrl(productUrl || '');
    if (!slug || !patch || typeof patch !== 'object') return;
    const raw = await new Promise((r) => chrome.storage.local.get(DASHBOARD_COMPLETED_CATALOG_KEY, r));
    let payload = raw[DASHBOARD_COMPLETED_CATALOG_KEY];
    if (!payload || !Array.isArray(payload.items)) return;
    let changed = false;
    for (let j = 0; j < payload.items.length; j++) {
        const it = payload.items[j];
        if (it && String(it.slug) === slug) {
            Object.assign(it, patch);
            changed = true;
            break;
        }
    }
    if (changed) {
        payload.fetchedAt = Date.now();
        await chrome.storage.local.set({ [DASHBOARD_COMPLETED_CATALOG_KEY]: payload });
    }
}

/** Панель «Автопубликация» / дашборд — отдельно от activations_today (лимит просмотра в «Истории заказов»). */
const DAILY_BOOST_BUMPS_KEY = 'daily_boost_bumps';
const DAILY_BOOST_BUMPS_DATE_KEY = 'daily_boost_bumps_date';
const DAILY_PUBLISHER_PUBLISHED_KEY = 'daily_publisher_published';
const DAILY_PUBLISHER_PUBLISHED_DATE_KEY = 'daily_publisher_published_date';

function incrementDailyPair(countKey, dateKey) {
    const todayStr = new Date().toISOString().slice(0, 10);
    chrome.storage.local.get([countKey, dateKey], (s) => {
        const prevDate = s[dateKey] || '';
        const prev = prevDate === todayStr ? (Number(s[countKey]) || 0) : 0;
        chrome.storage.local.set({ [countKey]: prev + 1, [dateKey]: todayStr });
    });
}

async function fetchPlayerokHtmlViaBridge(pageUrl) {
    const tabId = await ensurePlayerokTab();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Таймаут загрузки страницы')), 20000);
        chrome.tabs.sendMessage(tabId, { action: 'FETCH_PAGE_HTML', url: pageUrl }, (response) => {
            clearTimeout(timer);
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            if (!response || !response.success) {
                reject(new Error(response?.error || 'Не удалось загрузить HTML'));
                return;
            }
            resolve(String(response.html || ''));
        });
    });
}

function extractNextDataJsonFromHtml(html) {
    const m = String(html).match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i);
    if (!m) return null;
    try {
        return JSON.parse(m[1]);
    } catch (_) {
        return null;
    }
}

function apolloResolve(apollo, ref) {
    if (ref == null) return null;
    if (typeof ref === 'object' && ref.__ref && apollo[ref.__ref]) return apollo[ref.__ref];
    if (typeof ref === 'string' && apollo[ref]) return apollo[ref];
    return null;
}

/** Цены из кэша Apollo: не брать первое попавшееся поле — иначе «старая» 505 ₽ теряется, остаётся 125/90. */
function pickCatalogPricesFromApolloItem(o) {
    const nums = new Map();
    const add = (v) => {
        if (v == null || v === '') return;
        const n = Math.round(Number(v));
        if (!Number.isFinite(n) || n < 1 || n > 5e6) return;
        nums.set(n, true);
    };
    const baseKeys = ['basePrice', 'prevPrice', 'previousPrice', 'oldPrice', 'strikePrice', 'listPrice', 'compareAtPrice', 'originalPrice', 'priceBeforeDiscount', 'retailPrice', 'catalogPrice', 'recommendedPrice', 'msrp'];
    const saleKeys = ['rawPrice', 'price', 'priceRub', 'salePrice', 'finalPrice', 'currentPrice', 'buyerPrice', 'amount', 'sellingPrice', 'cost'];
    for (const k of baseKeys) add(o[k]);
    for (const k of saleKeys) add(o[k]);
    const nests = ['pricing', 'priceInfo', 'discounts', 'discount', 'prices', 'tariff'];
    for (const nk of nests) {
        const sub = o[nk];
        if (!sub || typeof sub !== 'object' || sub.__ref) continue;
        for (const sk of Object.keys(sub)) {
            if (typeof sub[sk] === 'number') add(sub[sk]);
        }
    }
    for (const k of Object.keys(o)) {
        const lk = k.toLowerCase();
        if (/percent|pct|ratio|commission|feepercent|count|quantity|priority|sequence|rank|views|sales|orders|position|index|level/i.test(lk)) continue;
        const v = o[k];
        if (typeof v === 'number') {
            if (v >= 1 && v <= 100 && !/price|rub|amount/.test(lk)) continue;
            if (/price|rub|amount|cost|strike|base|old|prev|original|compare|retail|total|sum|fee$/i.test(lk)) add(v);
        }
    }
    const arr = [...nums.keys()].sort((a, b) => a - b);
    if (!arr.length) return { priceRub: null, basePriceRub: null, salePriceRub: null };
    if (arr.length === 1) {
        const one = arr[0];
        return { priceRub: one, basePriceRub: null, salePriceRub: one };
    }
    const minP = arr[0];
    const maxP = arr[arr.length - 1];
    if (maxP <= minP) return { priceRub: minP, basePriceRub: null, salePriceRub: minP };
    const ratio = maxP / minP;
    if (ratio >= 1.18) return { priceRub: minP, basePriceRub: maxP, salePriceRub: minP };
    const guess = ['rawPrice', 'priceRub', 'price', 'salePrice', 'finalPrice', 'currentPrice'].map((k) => o[k]).find((x) => x != null && !Number.isNaN(Number(x)));
    const g = guess != null ? Math.round(Number(guess)) : minP;
    return { priceRub: g, basePriceRub: null, salePriceRub: g };
}

function normalizeCatalogItemStatusFromApollo(o) {
    if (o && (o.isDraft === true || o.draft === true)) return 'DRAFT';
    let s = o.status || o.itemStatus || o.publicationStatus || o.lifecycleStatus || o.itemState;
    if (!s && o.state) {
        if (typeof o.state === 'string') s = o.state;
        else s = (o.state.status || o.state.value || o.state.code || '');
    }
    s = String(s || '').trim();
    if (!s) return '';
    return s.toUpperCase().replace(/-/g, '_').replace(/\s+/g, '_');
}

/**
 * Достаёт лоты из нормализованного Apollo cache в __NEXT_DATA__ (страница завершённых товаров).
 */
function parseCompletedCatalogFromPlayerokHtml(html) {
    const nd = extractNextDataJsonFromHtml(html);
    if (!nd) {
        return { items: [], error: 'На странице нет данных Next.js — проверьте авторизацию на Playerok.' };
    }
    const props = nd.props?.pageProps || nd.props || {};
    const apollo = props.initialApolloState || props.apolloState
        || props.__APOLLO_STATE__ || nd.__APOLLO_STATE__ || {};
    if (!apollo || typeof apollo !== 'object') {
        return { items: [], error: 'Пустой Apollo state — откройте страницу завершённых вручную в браузере.' };
    }
    const seen = new Set();
    const items = [];
    const gameNameFromRef = (gref) => {
        const g = apolloResolve(apollo, gref);
        return (g && g.name) ? String(g.name) : '—';
    };
    const categoryNameFromItem = (o) => {
        if (typeof o.category === 'string' && String(o.category).trim()) return String(o.category).trim();
        let cat = apolloResolve(apollo, o.category) || apolloResolve(apollo, o.gameCategory) || apolloResolve(apollo, o.subcategory)
            || apolloResolve(apollo, o.primaryCategory) || apolloResolve(apollo, o.sellCategory) || apolloResolve(apollo, o.listingCategory)
            || apolloResolve(apollo, o.itemCategory) || apolloResolve(apollo, o.gamePageCategory)
            || apolloResolve(apollo, o.minimalGameCategory) || apolloResolve(apollo, o.regularGameCategory);
        if (cat && cat.name) return String(cat.name);
        if (o.categoryName) return String(o.categoryName).trim();
        const gObj = apolloResolve(apollo, o.game);
        if (gObj && typeof gObj === 'object') {
            const gCatKeys = ['lotCategory', 'defaultCategory', 'category', 'gameCategory', 'sellCategory', 'profileCategory', 'primaryCategory', 'sellerCategory', 'listingCategory', 'minimalGameCategory', 'regularGameCategory'];
            for (let gki = 0; gki < gCatKeys.length; gki++) {
                const gCatNode = apolloResolve(apollo, gObj[gCatKeys[gki]]);
                if (gCatNode && gCatNode.name) return String(gCatNode.name);
            }
        }
        const gid = o.gameCategoryId || o.categoryId || o.sellCategoryId || o.primaryCategoryId;
        if (!gid) return '';
        const gids = String(gid);
        for (const ck of Object.keys(apollo)) {
            const cn = apollo[ck];
            if (!cn || typeof cn !== 'object' || !cn.name) continue;
            if (String(cn.id || '') !== gids) continue;
            const ctn = String(cn.__typename || '');
            if (/category/i.test(ctn) || /Category:/i.test(ck)) return String(cn.name);
        }
        return '';
    };
    const obtainingTypeIdFrom = (o) => {
        const ot = o.obtainingType;
        if (!ot) return '';
        if (ot.id) return String(ot.id);
        if (ot.__ref) {
            const node = apolloResolve(apollo, ot);
            return (node && node.id) ? String(node.id) : '';
        }
        return '';
    };
    const sortTsFrom = (o) => {
        const fields = ['updatedAt', 'modifiedAt', 'createdAt', 'publishedAt', 'dateUpdated', 'lastUpdated', 'completedAt'];
        for (const f of fields) {
            const dv = o[f];
            if (dv == null) continue;
            if (typeof dv === 'number' && Number.isFinite(dv)) return dv < 1e12 ? Math.round(dv * 1000) : Math.round(dv);
            if (typeof dv === 'string') {
                const parsed = Date.parse(dv);
                if (!Number.isNaN(parsed)) return parsed;
            }
        }
        return 0;
    };
    for (const k of Object.keys(apollo)) {
        const o = apollo[k];
        if (!o || typeof o !== 'object') continue;
        const tn = o.__typename;
        if (!tn || !o.slug) continue;
        if (!/^(MyItem|ForeignItem|MyItemProfile|ForeignItemProfile|ItemProfile)$/i.test(tn)) continue;
        let slug = String(o.slug);
        try {
            slug = decodeURIComponent(slug);
        } catch (_) { /* keep */ }
        if (RESERVED_PRODUCT_PATH_SLUGS.has(slug.toLowerCase())) continue;
        if (seen.has(slug)) continue;
        seen.add(slug);
        const title = String(o.name || o.title || slug || '—');
        const picked = pickCatalogPricesFromApolloItem(o);
        const basePriceRub = picked.basePriceRub != null ? roundDashPrice(picked.basePriceRub) : null;
        const salePriceRub = picked.salePriceRub != null ? roundDashPrice(picked.salePriceRub) : null;
        const priceRub = salePriceRub != null ? salePriceRub : (picked.priceRub != null ? roundDashPrice(picked.priceRub) : null);
        const st = normalizeCatalogItemStatusFromApollo(o);
        items.push({
            id: String(o.id || ''),
            slug,
            title,
            gameTitle: gameNameFromRef(o.game),
            categoryName: categoryNameFromItem(o),
            obtainingTypeId: obtainingTypeIdFrom(o),
            _sortTs: sortTsFrom(o),
            priceRub,
            basePriceRub,
            salePriceRub,
            hasDiscount: normalizeCatalogHasDiscount(basePriceRub, salePriceRub, o.hasDiscount),
            status: st,
            url: `https://playerok.com/products/${encodeURIComponent(slug)}`
        });
    }
    items.sort((a, b) => (Number(b._sortTs) || 0) - (Number(a._sortTs) || 0));
    return { items, error: null };
}

/** Отправляет GET_LIVE_CATALOG в content.js вкладки, ждёт результата. */
async function _sendGetLiveCatalog(tabId) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Apollo read timeout')), 22000);
        chrome.tabs.sendMessage(tabId, { action: 'GET_LIVE_CATALOG' }, (res) => {
            clearTimeout(timer);
            if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
            resolve(res || { items: [], error: 'empty response' });
        });
    });
}

/**
 * Live-refresh каталога: читает живой Apollo-кэш из уже открытой вкладки Playerok
 * через content.js → content_bridge_main.js (GET_LIVE_CATALOG → PROK_COMPLETED_CATALOG_EXTRACT).
 *
 * Логика:
 * 1. Приоритизируем вкладки на /products/* — там Apollo точно содержит товары.
 * 2. Если Apollo пустой и знаем username — тихо переходим на /products, ждём загрузки, читаем снова.
 * 3. Если нет живой вкладки — бросаем, вызывающий молча оставляет кэш.
 */
async function fetchCatalogFromLiveApollo(username) {
    const target = String(username || '').trim();

    // Собираем кандидатов: поиск по URL + известные in-memory globals.
    // Вкладки на /products/* приоритизируем — у них Apollo точно содержит товары.
    const seenIds = new Set();
    const allTabObjs = [];
    try {
        const [tabs1, tabs2] = await Promise.all([
            chrome.tabs.query({ url: '*://*.playerok.com/*' }),
            chrome.tabs.query({ url: 'https://playerok.com/*' })
        ]);
        for (const t of [...tabs1, ...tabs2]) {
            if (!seenIds.has(t.id) && isUsablePlayerokScannerUrl(t.url || '')) {
                seenIds.add(t.id);
                allTabObjs.push(t);
            }
        }
    } catch (_) { /* */ }
    // Добавляем in-memory globals (могут не совпасть с URL-запросом после перезапуска SW)
    for (const gid of [
        typeof bridgeTabId !== 'undefined' ? bridgeTabId : null,
        typeof mainTabId !== 'undefined' ? mainTabId : null,
        typeof boostMainTabId !== 'undefined' ? boostMainTabId : null
    ]) {
        if (gid != null && !seenIds.has(gid)) { seenIds.add(gid); allTabObjs.push({ id: gid, url: '' }); }
    }
    if (!allTabObjs.length) throw new Error('no_playerok_tab');

    // Сортируем: /products/* → /profile/* → всё остальное
    const urlScore = (u) => {
        if (/\/products(\/completed|\/drafts|\/active)?\/?(\?.*)?$/.test(u)) return 10;
        if (u.includes('/products')) return 8;
        if (u.includes('/profile/')) return 4;
        return 1;
    };
    allTabObjs.sort((a, b) => urlScore(b.url || '') - urlScore(a.url || ''));

    // Ищем первую живую вкладку
    let tabId = null;
    for (const tab of allTabObjs) {
        const alive = await pingBridge(tab.id, 1500).catch(() => false);
        if (alive) { tabId = tab.id; break; }
    }
    if (!tabId) throw new Error('no_live_bridge');

    // Читаем текущий Apollo-кэш. Никакой принудительной навигации чужой вкладки —
    // это ломает content-скрипты других модулей (fulfill, boost, steampass).
    // Если Apollo пуст — просто возвращаем ошибку, пользователь сам откроет /products.
    const result = await _sendGetLiveCatalog(tabId);
    const rawItems = Array.isArray(result.items) ? result.items : [];

    if (!rawItems.length) {
        throw new Error(result.error || 'Apollo cache empty — откройте /products и обновите');
    }

    const items = rawItems.slice(0, DASHBOARD_MAX_CATALOG_ITEMS);
    const payload = {
        fetchedAt: Date.now(),
        username: target || 'unknown',
        sourceUrl: 'live-apollo:bridge-tab',
        items
    };
    await chrome.storage.local.set({ [DASHBOARD_COMPLETED_CATALOG_KEY]: payload });

    // Активные товары (APPROVED = «В продаже») — добавляем в dashboard_published_v1
    const ACTIVE_STATUSES = new Set(['APPROVED', 'ACTIVE', 'IN_SALE', 'PUBLISHED', 'AVAILABLE']);
    const activeItems = items.filter((it) => ACTIVE_STATUSES.has(String(it.status || '').toUpperCase()));
    if (activeItems.length) {
        const pubRecords = activeItems.map((it) => ({
            title: String(it.title || '').trim() || 'Лот',
            url: it.url,
            itemId: String(it.id || '').trim(),
            obtainingTypeId: String(it.obtainingTypeId || '').trim(),
            basePriceRub: it.basePriceRub,
            salePriceRub: it.salePriceRub != null ? it.salePriceRub : it.priceRub,
            hasDiscount: !!it.hasDiscount,
            quantity: 1
        }));
        await mergeDashboardPublishedImportsFromScan(pubRecords);
    }

    log(`[Dashboard] Live Apollo: ${items.length} лотов (${activeItems.length} активных) из вкладки tabId=${tabId}`);
    return { items, activeCount: activeItems.length };
}

/** Убрать лот из черновиков/опубликованных сводки (как при PAGE_ITEM_DELETED). */
async function applyDashboardRemoveListing(delItemId, delHref) {
    try {
        const id = String(delItemId || '').trim();
        const href = String(delHref || '').trim();
        const keys = [DASHBOARD_DRAFTS_KEY, DASHBOARD_PUBLISHED_KEY];
        const raw = await new Promise(r => chrome.storage.local.get(keys, o => r(o)));
        let draftsArr = Array.isArray(raw[DASHBOARD_DRAFTS_KEY]) ? raw[DASHBOARD_DRAFTS_KEY] : [];
        let pubArr = Array.isArray(raw[DASHBOARD_PUBLISHED_KEY]) ? raw[DASHBOARD_PUBLISHED_KEY] : [];
        const normHref = normalizeProductPageUrl(href);
        function matchEntry(e) {
            if (id && String(e.itemId || '').trim() === id) return true;
            if (normHref && normalizeProductPageUrl(e.url || '') === normHref) return true;
            return false;
        }
        const dLen = draftsArr.length, pLen = pubArr.length;
        draftsArr = draftsArr.filter(e => !matchEntry(e));
        pubArr = pubArr.filter(e => !matchEntry(e));
        if (draftsArr.length !== dLen || pubArr.length !== pLen) {
            await chrome.storage.local.set({
                [DASHBOARD_DRAFTS_KEY]: draftsArr,
                [DASHBOARD_PUBLISHED_KEY]: pubArr
            });
            log(`[Dashboard] Удалено со сводки: черновики ${dLen}→${draftsArr.length}, опубл. ${pLen}→${pubArr.length}`);
        }
    } catch (e) {
        log(`[Dashboard] applyDashboardRemoveListing: ${e.message}`);
    }
}

/** Убрать лот из снимка «Все товары» по itemId или URL (при удалении с сайта). */
async function removeFromCompletedCatalog(itemId, href) {
    try {
        const id = String(itemId || '').trim();
        const slug = parsePublicProductSlugFromUrl(href || '');
        if (!id && !slug) return;
        const raw = await new Promise(r => chrome.storage.local.get(DASHBOARD_COMPLETED_CATALOG_KEY, o => r(o)));
        const payload = raw[DASHBOARD_COMPLETED_CATALOG_KEY];
        if (!payload || !Array.isArray(payload.items)) return;
        const before = payload.items.length;
        payload.items = payload.items.filter(it => {
            if (!it) return false;
            if (id && String(it.id || '') === id) return false;
            if (slug && String(it.slug || '') === slug) return false;
            return true;
        });
        if (payload.items.length !== before) {
            payload.fetchedAt = Date.now();
            await chrome.storage.local.set({ [DASHBOARD_COMPLETED_CATALOG_KEY]: payload });
            log(`[Dashboard] «Все товары»: удалено ${before - payload.items.length} (itemId=${id.slice(0, 8)})`);
        }
    } catch (e) {
        log(`[Dashboard] removeFromCompletedCatalog: ${e.message}`);
    }
}

const MUTATION_REMOVE_ITEM = `mutation removeItem($id: UUID!) {
  removeItem(id: $id) {
    id
  }
}`;

const QUERY_ITEM_ID_BY_SLUG = `query item($slug: String!) { item(slug: $slug) { id } }`;

/** Только публичные URL вида /products/{slug} или /item/{slug}, не вкладки профиля (/profile/…/products/completed). */
const RESERVED_PRODUCT_PATH_SLUGS = new Set([
    'completed', 'active', 'inactive', 'draft', 'drafts', 'pending', 'sales', 'categories', 'catalog',
    'new', 'edit', 'create', 'moderation', 'expired', 'archived', 'deleted'
]);

function parsePublicProductSlugFromUrl(url) {
    try {
        const path = new URL(url).pathname;
        const m = path.match(/^\/products\/([^/]+)\/?$/i) || path.match(/^\/item\/([^/]+)\/?$/i);
        if (!m) return '';
        let s = m[1];
        try { s = decodeURIComponent(s); } catch (_) { }
        if (RESERVED_PRODUCT_PATH_SLUGS.has(s.toLowerCase())) return '';
        return s;
    } catch (_) {
        return '';
    }
}

function roundDashPrice(v) {
    if (v == null || Number.isNaN(Number(v))) return null;
    return Math.round(Number(v));
}

/** Скидка покупателю на Playerok — заметная (розовый %, зачёркнутая цена). Мелкая разница цен ≈ удержание, не скидка. */
function catalogPricePairIsLikelyBuyerDiscount(baseRub, saleRub) {
    const b = Number(baseRub);
    const s = Number(saleRub);
    if (!Number.isFinite(b) || !Number.isFinite(s) || b <= s) return false;
    const ratio = b / s;
    const pct = (1 - s / b) * 100;
    return ratio >= 1.28 || pct >= 22;
}

function normalizeCatalogHasDiscount(baseRub, saleRub, apiFlag) {
    const b = Number(baseRub);
    const s = Number(saleRub);
    if (!Number.isFinite(b) || !Number.isFinite(s) || b <= s) return !!apiFlag;
    return catalogPricePairIsLikelyBuyerDiscount(b, s);
}

/**
 * Дублирует импортированные черновики в снимок «Все товары» (по slug), чтобы лот был и в черновиках, и в общем списке.
 */
async function mergeDraftRecordsIntoCompletedCatalog(records) {
    if (!Array.isArray(records) || !records.length) return;
    try {
        const raw = await new Promise((r) => chrome.storage.local.get(DASHBOARD_COMPLETED_CATALOG_KEY, r));
        let payload = raw[DASHBOARD_COMPLETED_CATALOG_KEY];
        if (!payload || typeof payload !== 'object') {
            payload = { fetchedAt: Date.now(), username: '', sourceUrl: '', items: [] };
        }
        if (!Array.isArray(payload.items)) payload.items = [];
        const bySlug = new Map();
        payload.items.forEach((it) => {
            if (it && it.slug) bySlug.set(String(it.slug), it);
        });
        let touched = false;
        for (const rec of records) {
            if (!rec || typeof rec !== 'object') continue;
            const slug = parsePublicProductSlugFromUrl(rec.url || '');
            if (!slug) continue;
            const urlCanon = `https://playerok.com/products/${encodeURIComponent(slug)}`;
            const baseP = roundDashPrice(rec.basePriceRub);
            const saleP = roundDashPrice(rec.salePriceRub);
            const priceRub = saleP != null ? saleP : baseP;
            const item = {
                id: String(rec.itemId || ''),
                slug,
                title: String(rec.title || '').trim() || slug,
                gameTitle: '—',
                categoryName: '',
                obtainingTypeId: String(rec.obtainingTypeId || '').trim(),
                priceRub,
                basePriceRub: baseP,
                salePriceRub: saleP != null ? saleP : priceRub,
                hasDiscount: normalizeCatalogHasDiscount(baseP, saleP, rec.hasDiscount),
                status: 'DRAFT',
                statusLabel: 'Черновик',
                boostedMark: false,
                url: urlCanon
            };
            const prev = bySlug.get(slug);
            if (prev) Object.assign(prev, item);
            else {
                payload.items.push(item);
                bySlug.set(slug, item);
            }
            touched = true;
        }
        if (touched) {
            payload.fetchedAt = Date.now();
            payload.items = payload.items.slice(0, DASHBOARD_MAX_CATALOG_ITEMS);
            await chrome.storage.local.set({ [DASHBOARD_COMPLETED_CATALOG_KEY]: payload });
            log('[Dashboard] Черновики Playerok добавлены/обновлены в «Все товары»');
        }
    } catch (e) {
        log(`[Dashboard] mergeDraftRecordsIntoCompletedCatalog: ${e.message}`);
    }
}

function extractDealPriceRub(node) {
    if (!node || typeof node !== 'object') return null;
    const pick = (v) => {
        if (v == null) return null;
        if (typeof v === 'number' && !Number.isNaN(v)) return Math.round(v);
        if (typeof v === 'object' && typeof v.amount === 'number') return Math.round(v.amount);
        if (typeof v === 'string') {
            const n = parseFloat(String(v).replace(',', '.').replace(/\s/g, ''));
            return Number.isFinite(n) ? Math.round(n) : null;
        }
        return null;
    };
    return pick(node.price) ?? pick(node.total) ?? pick(node.amount) ?? pick(node.item?.price) ?? pick(node.dealPrice) ?? null;
}

async function appendDashboardDraftRecord({ title, basePriceRub, salePriceRub, hasDiscount, url, itemId, quantity }) {
    try {
        const raw = await new Promise(r => chrome.storage.local.get(DASHBOARD_DRAFTS_KEY, o => r(o)));
        const arr = raw[DASHBOARD_DRAFTS_KEY] || [];
        const b = roundDashPrice(basePriceRub);
        const s = roundDashPrice(salePriceRub);
        const hd = normalizeCatalogHasDiscount(b, s, hasDiscount);
        const urlN = normalizeProductPageUrl(url || '') || url || '';
        arr.unshift({
            id: `draft_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            at: Date.now(),
            title: title || '',
            basePriceRub: b,
            salePriceRub: s,
            hasDiscount: hd,
            url: urlN,
            itemId: itemId || '',
            quantity: Math.max(1, parseInt(quantity, 10) || 1),
            source: 'publisher'
        });
        await chrome.storage.local.set({ [DASHBOARD_DRAFTS_KEY]: arr.slice(0, DASHBOARD_MAX_ROWS) });
        log(`[Dashboard] ✅ Черновик записан в сводку (${arr.length} всего)`);
        await mergeDraftRecordsIntoCompletedCatalog([{
            title: title || '',
            basePriceRub: b,
            salePriceRub: s,
            hasDiscount: hd,
            url: urlN,
            itemId: itemId || ''
        }]);
    } catch (e) {
        log(`[Dashboard] ❌ Ошибка записи черновика: ${e.message}`);
    }
}

/** Импорт черновиков со страницы профиля Playerok (скан) — без дублей по URL/itemId. */
async function mergeDashboardDraftImportsFromScan(records) {
    if (!Array.isArray(records) || !records.length) return 0;
    try {
        const raw = await new Promise(r => chrome.storage.local.get(DASHBOARD_DRAFTS_KEY, o => r(o)));
        let arr = Array.isArray(raw[DASHBOARD_DRAFTS_KEY]) ? raw[DASHBOARD_DRAFTS_KEY].slice() : [];
        const existingUrls = new Set(arr.map(e => normalizeProductPageUrl(e.url || '')).filter(Boolean));
        const existingIds = new Set(arr.map(e => String(e.itemId || '').trim()).filter(Boolean));
        let added = 0;
        for (const rec of records) {
            if (!rec || typeof rec !== 'object') continue;
            const slugCanon = parsePublicProductSlugFromUrl(rec.url || '');
            const url = slugCanon
                ? `https://playerok.com/products/${encodeURIComponent(slugCanon)}`
                : normalizeProductPageUrl(rec.url || '');
            const itemId = String(rec.itemId || '').trim();
            if (itemId && existingIds.has(itemId)) continue;
            if (url && existingUrls.has(url)) continue;
            if (itemId) existingIds.add(itemId);
            if (url) existingUrls.add(url);
            const rb = roundDashPrice(rec.basePriceRub);
            const rs = roundDashPrice(rec.salePriceRub);
            const rhd = normalizeCatalogHasDiscount(rb, rs, rec.hasDiscount);
            arr.unshift({
                id: `draft_scan_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
                at: Date.now(),
                title: String(rec.title || '').trim() || 'Лот',
                basePriceRub: rb,
                salePriceRub: rs,
                hasDiscount: rhd,
                url: url || String(rec.url || '').trim(),
                itemId: itemId,
                obtainingTypeId: String(rec.obtainingTypeId || '').trim(),
                quantity: Math.max(1, parseInt(rec.quantity, 10) || 1),
                source: 'playerok_draft_scan'
            });
            added++;
        }
        await chrome.storage.local.set({ [DASHBOARD_DRAFTS_KEY]: arr.slice(0, DASHBOARD_MAX_ROWS) });
        if (added) log(`[Dashboard] Скан Playerok → черновики сводки: +${added} (всего ${arr.length})`);
        await mergeDraftRecordsIntoCompletedCatalog(records);
        return added;
    } catch (e) {
        log(`[Dashboard] mergeDashboardDraftImportsFromScan: ${e.message}`);
        return 0;
    }
}

/** Импорт опубликованных лотов со страницы профиля Playerok (скан) — без дублей по URL/itemId. */
async function mergeDashboardPublishedImportsFromScan(records) {
    if (!Array.isArray(records) || !records.length) return 0;
    try {
        const raw = await new Promise(r => chrome.storage.local.get(DASHBOARD_PUBLISHED_KEY, o => r(o)));
        let arr = Array.isArray(raw[DASHBOARD_PUBLISHED_KEY]) ? raw[DASHBOARD_PUBLISHED_KEY].slice() : [];
        const existingUrls = new Set(arr.map(e => normalizeProductPageUrl(e.url || '')).filter(Boolean));
        const existingIds = new Set(arr.map(e => String(e.itemId || '').trim()).filter(Boolean));
        let added = 0;
        for (const rec of records) {
            if (!rec || typeof rec !== 'object') continue;
            const slugCanon = parsePublicProductSlugFromUrl(rec.url || '');
            const url = slugCanon
                ? `https://playerok.com/products/${encodeURIComponent(slugCanon)}`
                : normalizeProductPageUrl(rec.url || '');
            const itemId = String(rec.itemId || '').trim();
            if (itemId && existingIds.has(itemId)) continue;
            if (url && existingUrls.has(url)) continue;
            if (itemId) existingIds.add(itemId);
            if (url) existingUrls.add(url);
            const rb = roundDashPrice(rec.basePriceRub);
            const rs = roundDashPrice(rec.salePriceRub);
            const rhd = normalizeCatalogHasDiscount(rb, rs, rec.hasDiscount);
            arr.unshift({
                id: `pub_scan_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
                at: Date.now(),
                title: String(rec.title || '').trim() || 'Лот',
                basePriceRub: rb,
                salePriceRub: rs,
                hasDiscount: rhd,
                url: url || String(rec.url || '').trim(),
                itemId: itemId,
                obtainingTypeId: String(rec.obtainingTypeId || '').trim(),
                quantity: Math.max(1, parseInt(rec.quantity, 10) || 1),
                source: 'playerok_published_scan'
            });
            added++;
        }
        await chrome.storage.local.set({ [DASHBOARD_PUBLISHED_KEY]: arr.slice(0, DASHBOARD_MAX_ROWS) });
        if (added) log(`[Dashboard] Скан Playerok → опубликованные сводки: +${added} (всего ${arr.length})`);
        return added;
    } catch (e) {
        log(`[Dashboard] mergeDashboardPublishedImportsFromScan: ${e.message}`);
        return 0;
    }
}

async function appendDashboardPublishedRecord({ title, basePriceRub, salePriceRub, hasDiscount, url, itemId, quantity, source = 'publisher' }) {
    try {
        const raw = await new Promise(r => chrome.storage.local.get(DASHBOARD_PUBLISHED_KEY, o => r(o)));
        const arr = raw[DASHBOARD_PUBLISHED_KEY] || [];
        arr.unshift({
            id: `pub_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            at: Date.now(),
            title: title || '',
            basePriceRub: roundDashPrice(basePriceRub),
            salePriceRub: roundDashPrice(salePriceRub),
            hasDiscount: !!hasDiscount,
            url: url || '',
            itemId: itemId || '',
            quantity: Math.max(1, parseInt(quantity, 10) || 1),
            source: source || 'publisher'
        });
        await chrome.storage.local.set({ [DASHBOARD_PUBLISHED_KEY]: arr.slice(0, DASHBOARD_MAX_ROWS) });
        log(`[Dashboard] ✅ Публикация записана в сводку (${arr.length} всего)`);
    } catch (e) {
        log(`[Dashboard] ❌ Ошибка записи публикации: ${e.message}`);
    }
}

// -----------------------------------------------------------------------------
// Live GraphQL Scanner for Dashboard
// -----------------------------------------------------------------------------

const QUERY_PROFILE_PRODUCTS = `query ProfileProducts($userId: String!, $first: Int, $after: String, $filter: ProductFilter, $sort: ProductSort) {
  user(id: $userId) {
    id
    products(first: $first, after: $after, filter: $filter, sort: $sort) {
      edges {
        node {
          id
          title
          slug
          price
          oldPrice
          status
          images {
            url
          }
        }
        cursor
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}`;

async function fetchCatalogFromLiveGraphQL(sendResponse) {
    let viewerName = '';
    const VIEWER_QUERY_LOCAL = `query viewer { viewer { id username } }`;
    try {
        const dataV = await playerokApiQueued(() => playerokApi('viewer', VIEWER_QUERY_LOCAL, {}));
        viewerName = String(dataV?.viewer?.username || '').trim();
        if (!viewerName) {
            if (sendResponse) sendResponse({ ok: false, error: 'Не удалось узнать ник. Авторизуйтесь на Playerok.' });
            return;
        }
    } catch (e) {
        if (sendResponse) sendResponse({ ok: false, error: 'Ошибка получения профиля (нужен вход на Playerok): ' + e.message });
        return;
    }

    let hasNextPage = true;
    let endCursor = null;
    let allNodes = [];
    
    // 1. Fetch backend directly
    try {
        let iterations = 0;
        while (hasNextPage && iterations < 50) { 
            iterations++;
            const vars = {
                userId: viewerName,
                first: 80,
                after: endCursor || undefined,
                sort: 'CREATED_AT_DESC'
            };
            const res = await playerokApiQueued(() => playerokApi('ProfileProducts', QUERY_PROFILE_PRODUCTS, vars));
            const pNode = res?.user?.products;
            if (!pNode || !pNode.edges) break;
            
            pNode.edges.forEach(edge => {
                if (edge && edge.node) allNodes.push(edge.node);
            });
            
            hasNextPage = pNode.pageInfo?.hasNextPage;
            if (!hasNextPage) break;
            endCursor = pNode.pageInfo?.endCursor;
        }
    } catch (err) {
        if (sendResponse) sendResponse({ ok: false, error: 'Ошибка GraphQL API: ' + err.message });
        return;
    }

    // 2. Mapping to our formats
    let completedItems = [];
    let publishedImports = [];
    let draftImports = [];

    const ST_COMPLETED = { SOLD: 1, COMPLETED: 1, FINISHED: 1, EXPIRED: 1, DECLINED: 1, BLOCKED: 1, REJECTED: 1 };
    const ST_DRAFT = { DRAFT: 1, PENDING_APPROVAL: 1, ON_MODERATION: 1 };
    const ST_ACTIVE = { ACTIVE: 1, APPROVED: 1 };

    allNodes.forEach(node => {
        const statusRaw = String(node.status || '').toUpperCase().replace('-', '_');
        
        let imgUrl = '';
        if (node.images && node.images.length > 0) imgUrl = node.images[0].url;

        const basePrice = (node.oldPrice != null && node.oldPrice > 0) ? node.oldPrice : node.price;
        const baseItem = {
            title: node.title || '',
            url: node.slug ? `https://playerok.com/products/${node.slug}` : '',
            itemId: node.id || '',
            basePriceRub: basePrice,
            salePriceRub: node.price,
            hasDiscount: (node.oldPrice != null && node.oldPrice > node.price),
            quantity: 1,
            status: statusRaw
        };

        if (ST_ACTIVE[statusRaw]) {
            publishedImports.push(baseItem);
        } else if (ST_DRAFT[statusRaw]) {
            draftImports.push(baseItem);
            completedItems.push({
                ...baseItem,
                priceRub: String(node.price || ''),
                imageUrl: imgUrl,
                statusInfo: statusRaw,
                publishedAt: Date.now()
            });
        } else {
            completedItems.push({
                ...baseItem,
                priceRub: String(node.price || ''),
                imageUrl: imgUrl,
                statusInfo: statusRaw,
                publishedAt: Date.now()
            });
        }
    });

    try {
        // 3. Save to storage
        let payload = {
            items: completedItems,
            sourceUrl: `https://playerok.com/profile/${encodeURIComponent(viewerName)}/products/completed`,
            fetchedAt: Date.now()
        };
        await chrome.storage.local.set({ [DASHBOARD_COMPLETED_CATALOG_KEY]: payload });
        await mergeDashboardPublishedImportsFromScan(publishedImports);
        await mergeDashboardDraftImportsFromScan(draftImports);

        if (sendResponse) sendResponse({
            ok: true,
            totalItems: allNodes.length,
            completedCount: completedItems.filter(i => ST_COMPLETED[i.status]).length,
            publishedCount: publishedImports.length,
            draftCount: draftImports.length
        });
    } catch (er) {
        if (sendResponse) sendResponse({ ok: false, error: 'Ошибка сохранения: ' + er.message });
    }
}

/** Нормализуем URL товара для сопоставления черновика и вкладки после бесплатной публикации. */
function normalizeProductPageUrl(u) {
    if (!u || typeof u !== 'string') return '';
    try {
        const o = new URL(u);
        if (!o.hostname.endsWith('playerok.com')) return '';
        const path = o.pathname.replace(/\/$/, '');
        return `https://playerok.com${path}`;
    } catch {
        let s = String(u).split(/[?#]/)[0].replace(/\/$/, '');
        s = s.replace(/^https?:\/\/(www\.)?playerok\.com/i, 'https://playerok.com');
        return s;
    }
}

/**
 * После успешной публикации со страницы товара (бот / графql из content.js):
 * если в сводке есть черновик с тем же URL — переносим в «опубликованные»;
 * иначе добавляем компактную запись, чтобы дашборд не показывал 0.
 */
/**
 * @param {'full'|'match_draft_only'|'bump'} mode full — после publishItem: перенос черновика или новая строка; match_draft_only — только перенос, если черновик есть (уже активный лот); bump — автоподнятие: черновик / обновить опубликованный по URL / новая строка
 * @param {{ itemId?: string, rawPrice?: number } | null} bumpMeta — для mode === 'bump' (цена и id с API)
 */
async function promoteDashboardDraftToPublishedByProductUrl(tabUrl, mode = 'full', bumpMeta = null, publishedItemId = '') {
    const gqlItemId = String(publishedItemId || '').trim();
    let effectiveListingUrl = (tabUrl || '').trim();
    if (!effectiveListingUrl && gqlItemId) {
        effectiveListingUrl = `https://playerok.com/products/${gqlItemId}`;
    }
    const target = normalizeProductPageUrl(effectiveListingUrl);
    if (!target || !target.includes('/products/')) {
        if (tabUrl || publishedItemId) log(`[Dashboard] promote: нет URL вида /products/… (${String(effectiveListingUrl || tabUrl || '').slice(0, 60) || 'пустой href'}) itemId=${gqlItemId.slice(0, 8)}`);
        return;
    }

    const raw = await new Promise(r => chrome.storage.local.get([DASHBOARD_DRAFTS_KEY, DASHBOARD_PUBLISHED_KEY], o => r(o)));
    let drafts = Array.isArray(raw[DASHBOARD_DRAFTS_KEY]) ? raw[DASHBOARD_DRAFTS_KEY] : [];
    const publishedArr = Array.isArray(raw[DASHBOARD_PUBLISHED_KEY]) ? raw[DASHBOARD_PUBLISHED_KEY] : [];

    const idx = drafts.findIndex(d => {
        const du = normalizeProductPageUrl(d.url || '');
        if (du && du === target) return true;
        const did = String(d.itemId || '').trim();
        return Boolean(gqlItemId && did && did === gqlItemId);
    });

    if (idx >= 0) {
        const d = drafts[idx];
        const titleRaw = String(d.title || '').replace(/\s*\[черновик\]\s*$/i, '').trim() || d.title || '';
        const record = {
            id: `pub_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            at: Date.now(),
            title: titleRaw,
            basePriceRub: roundDashPrice(d.basePriceRub),
            salePriceRub: roundDashPrice(d.salePriceRub),
            hasDiscount: !!d.hasDiscount,
            url: effectiveListingUrl || d.url || '',
            itemId: gqlItemId || d.itemId || '',
            quantity: Math.max(1, parseInt(d.quantity, 10) || 1),
            source: 'promoted_from_draft'
        };
        drafts = drafts.filter((_, i) => i !== idx);
        publishedArr.unshift(record);
        await chrome.storage.local.set({
            [DASHBOARD_DRAFTS_KEY]: drafts.slice(0, DASHBOARD_MAX_ROWS),
            [DASHBOARD_PUBLISHED_KEY]: publishedArr.slice(0, DASHBOARD_MAX_ROWS)
        });
        log('[Dashboard] ✅ Черновик перенесён в опубликованные (ручное «Выставить» / сайт)');
        return;
    }

    if (mode === 'match_draft_only') return;

    if (mode === 'full' && gqlItemId) {
        const pubSameIdx = publishedArr.findIndex(p => normalizeProductPageUrl(p.url || '') === target);
        if (pubSameIdx >= 0) {
            const ex = publishedArr[pubSameIdx];
            publishedArr.splice(pubSameIdx, 1);
            publishedArr.unshift({
                ...ex,
                itemId: gqlItemId || ex.itemId || '',
                at: Date.now()
            });
            await chrome.storage.local.set({
                [DASHBOARD_PUBLISHED_KEY]: publishedArr.slice(0, DASHBOARD_MAX_ROWS)
            });
            log('[Dashboard] ✅ Опубликованный лот обновлён (выставить повторно / синхронизация с сайта)');
            return;
        }
    }

    if (mode === 'bump') {
        const pubIdx = publishedArr.findIndex(p => normalizeProductPageUrl(p.url || '') === target);
        if (pubIdx >= 0) {
            const p = publishedArr[pubIdx];
            const price = bumpMeta && bumpMeta.rawPrice != null ? roundDashPrice(bumpMeta.rawPrice) : null;
            const updated = {
                ...p,
                at: Date.now(),
                itemId: (bumpMeta && bumpMeta.itemId) || p.itemId || ''
            };
            if (price != null) {
                updated.basePriceRub = price;
                if (!updated.hasDiscount) updated.salePriceRub = price;
            }
            publishedArr.splice(pubIdx, 1);
            publishedArr.unshift(updated);
            await chrome.storage.local.set({
                [DASHBOARD_PUBLISHED_KEY]: publishedArr.slice(0, DASHBOARD_MAX_ROWS)
            });
            log('[Dashboard] ✅ Запись «опубликовано» обновлена после поднятия лота');
            return;
        }
        const slug = target.split('/').pop() || '';
        const titleGuess = slug ? decodeURIComponent(slug).replace(/-/g, ' ') : 'Поднятие лота';
        const pr = bumpMeta && bumpMeta.rawPrice != null ? roundDashPrice(bumpMeta.rawPrice) : null;
        await appendDashboardPublishedRecord({
            title: titleGuess,
            basePriceRub: pr,
            salePriceRub: pr,
            hasDiscount: false,
            url: target,
            itemId: (bumpMeta && bumpMeta.itemId) || '',
            quantity: 1,
            source: 'bump'
        });
        return;
    }

    // Защита от дублей: не добавлять, если уже есть запись с тем же URL за последние 60 сек
    const now = Date.now();
    const recentDup = publishedArr.find(p => {
        const pu = normalizeProductPageUrl(p.url || '');
        return pu === target && (now - (p.at || 0)) < 60000;
    });
    if (recentDup) {
        log('[Dashboard] ℹ️ Дубликат публикации проигнорирован (60с)');
        return;
    }

    const slug = target.split('/').pop() || '';
    const titleGuess = slug ? decodeURIComponent(slug).replace(/-/g, ' ') : 'Публикация';
    await appendDashboardPublishedRecord({
        title: titleGuess,
        basePriceRub: null,
        salePriceRub: null,
        hasDiscount: false,
        url: target,
        itemId: gqlItemId || '',
        quantity: 1,
        source: 'page_publish'
    });
}

/** Продажа: убрать товар из опубликованных и ручного буста (сумма буста перестаёт учитываться в карточке). */
async function dashboardCleanupSoldInventory({ playerokItemId = '', playerokItemSlug = '' }) {
    const pid = String(playerokItemId || '').trim();
    let normPage = '';
    if (playerokItemSlug) {
        normPage = normalizeProductPageUrl(`https://playerok.com/products/${String(playerokItemSlug).replace(/^\/+/, '')}`);
    }

    const raw = await new Promise(r => chrome.storage.local.get([DASHBOARD_PUBLISHED_KEY, DASHBOARD_BOOST_KEY], o => r(o)));
    let pub = Array.isArray(raw[DASHBOARD_PUBLISHED_KEY]) ? raw[DASHBOARD_PUBLISHED_KEY] : [];
    let boosts = Array.isArray(raw[DASHBOARD_BOOST_KEY]) ? raw[DASHBOARD_BOOST_KEY] : [];

    if (!normPage && pid) {
        const hit = pub.find(p => String(p.itemId || '').trim() === pid);
        if (hit) normPage = normalizeProductPageUrl(hit.url || '');
    }
    const pubLen = pub.length;
    const boostLen = boosts.length;

    pub = pub.filter((p) => {
        if (pid && String(p.itemId || '').trim() === pid) return false;
        if (normPage && normalizeProductPageUrl(p.url || '') === normPage) return false;
        return true;
    });
    boosts = boosts.filter((b) => {
        if (normPage && normalizeProductPageUrl(b.url || '') === normPage) return false;
        return true;
    });

    const changed = pub.length !== pubLen || boosts.length !== boostLen;
    if (changed) {
        await chrome.storage.local.set({
            [DASHBOARD_PUBLISHED_KEY]: pub.slice(0, DASHBOARD_MAX_ROWS),
            [DASHBOARD_BOOST_KEY]: boosts.slice(0, DASHBOARD_MAX_ROWS)
        });
        log('[Dashboard] Продажа: убрано из опубликованных и/или ручного буста');
    }

    // Обновить статус в «Все товары» — пометить как продано
    if (normPage) {
        await patchCompletedCatalogListingByUrl(normPage, { status: 'SOLD', statusLabel: 'Продано (завершено)' });
    }
}

async function appendDashboardSale({ gameTitle, buyerName, orderId, dealUrl, chatId, productId, priceRub, login, password, playerokItemId = '', playerokItemSlug = '' }) {
    const raw = await new Promise(r => chrome.storage.local.get(DASHBOARD_SALES_KEY, o => r(o)));
    const arr = raw[DASHBOARD_SALES_KEY] || [];
    const pr = priceRub != null && !Number.isNaN(Number(priceRub)) ? Math.round(Number(priceRub)) : null;
    arr.unshift({
        id: `sale_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        at: Date.now(),
        gameTitle: gameTitle || '',
        buyerName: buyerName || '',
        orderId: orderId || '',
        dealUrl: dealUrl || '',
        chatId: chatId || '',
        productId: productId || '',
        priceRub: pr,
        login: login || '',
        password: password || '',
        source: 'autofulfill',
        playerokItemId: String(playerokItemId || '').trim(),
        playerokItemSlug: String(playerokItemSlug || '').trim()
    });
    await chrome.storage.local.set({ [DASHBOARD_SALES_KEY]: arr.slice(0, DASHBOARD_MAX_ROWS) });
    await dashboardCleanupSoldInventory({ playerokItemId, playerokItemSlug });
}

async function saveOrderToHistory({ orderId, chatId, buyerName, gameTitle, login, password, productId, priceRub, dealUrl, playerokItemId = '', playerokItemSlug = '' }) {
    const raw = await new Promise(r => chrome.storage.local.get(ORDERS_HISTORY_KEY, o => r(o)));
    const db = raw[ORDERS_HISTORY_KEY] || [];
    const row = {
        id: `${orderId || chatId}_${Date.now()}`,
        orderId: orderId || '',
        chatId: chatId || '',
        buyerName: buyerName || '',
        gameTitle: gameTitle || '',
        login: login || '',
        password: password || '',
        productId: productId || '',
        createdAt: Date.now(),
        status: 'delivered'
    };
    if (priceRub != null && !Number.isNaN(Number(priceRub))) row.priceRub = Math.round(Number(priceRub));
    if (dealUrl) row.dealUrl = dealUrl;
    db.unshift(row);
    await chrome.storage.local.set({ [ORDERS_HISTORY_KEY]: db.slice(0, 500) });

    await appendDashboardSale({
        gameTitle,
        buyerName,
        orderId,
        dealUrl: dealUrl || (orderId ? `https://playerok.com/deal/${orderId}` : ''),
        chatId,
        productId,
        priceRub,
        login,
        password,
        playerokItemId,
        playerokItemSlug
    });
}

async function get2FASentAt() {
    const r = await new Promise(res => chrome.storage.local.get(SENT_AT_KEY, res));
    return r[SENT_AT_KEY] || {};
}
async function get2FAErrAt() {
    const r = await new Promise(res => chrome.storage.local.get(ERR_AT_KEY, res));
    return r[ERR_AT_KEY] || {};
}
async function set2FASentAt(map) {
    await chrome.storage.local.set({ [SENT_AT_KEY]: map });
}
async function set2FAErrAt(map) {
    await chrome.storage.local.set({ [ERR_AT_KEY]: map });
}
async function mark2FASent(chatId) {
    const map = await get2FASentAt();
    map[chatId] = Date.now();
    // Чистим старые записи (>1ч)
    for (const id in map) { if (Date.now() - map[id] > 3600000) delete map[id]; }
    await set2FASentAt(map);
}
async function mark2FAError(chatId) {
    const map = await get2FAErrAt();
    map[chatId] = Date.now();
    for (const id in map) { if (Date.now() - map[id] > 300000) delete map[id]; }
    await set2FAErrAt(map);
}
async function is2FAOnCooldown(chatId) {
    const [sent, err] = await Promise.all([get2FASentAt(), get2FAErrAt()]);
    const recentlySent = sent[chatId] && (Date.now() - sent[chatId]) < COOLDOWN_2FA_MS;
    const recentlyErr = err[chatId] && (Date.now() - err[chatId]) < COOLDOWN_2FA_ERROR_MS;
    return recentlySent || recentlyErr;
}

const _2faInFlight = new Set(); // per-chat mutex против двойного триггера
const _fulfillCompleteInFlight = new Set(); // не дублируем markFulfilled+DOM для одной сделки
const _chatAutoLookupDone = new Set(); // чаты по которым уже запрашивали сделку — не повторяем

// ─── Обработка запроса кода от «старых» покупателей (покупка была до появления бота) ───────────

/** Извлекает логин и пароль из текстового сообщения (тестер или бот мог выдавать в разных форматах). */
function extractCredentialsFromText(text) {
    if (!text) return null;
    const loginMatch = text.match(/(?:логин|login)[:\s]+([^\s\r\n,]+)/i);
    const passMatch = text.match(/(?:пароль|password|pass)[:\s]+([^\s\r\n,]+)/i);
    if (loginMatch && passMatch) {
        return { login: loginMatch[1].trim(), password: passMatch[1].trim() };
    }
    // Формат "login:password" или "login / password"
    const inlineMatch = text.match(/([a-zA-Z0-9@._\-+]{3,64})\s*[:/]\s*([^\s\r\n]{4,64})/);
    if (inlineMatch && inlineMatch[1] && inlineMatch[2]) {
        return { login: inlineMatch[1].trim(), password: inlineMatch[2].trim() };
    }
    return null;
}

/**
 * Ищет UUID для старого покупателя последовательно:
 * 1. orders_history по chatId  2. sp_id_/sp_uuid_/sp_order_ ключи  3. deal_for_chat_ → API
 * Возвращает UUID-строку или null.
 */
async function lookupOldBuyerUuid(chatId) {
    // 1. orders_history — productId = UUID SteamPass
    try {
        const raw = await new Promise(r => chrome.storage.local.get(ORDERS_HISTORY_KEY, o => r(o)));
        const db = raw[ORDERS_HISTORY_KEY] || [];
        const row = db.find(r => r.chatId === chatId && r.productId);
        if (row?.productId) return String(row.productId);
    } catch (_) { }

    // 2. Ключи, которые записывались более ранними версиями бота
    const spKeys = [`sp_id_${chatId}`, `sp_uuid_${chatId}`, `sp_order_chat_${chatId}`, `order_chat_${chatId}`];
    const spData = await new Promise(r => chrome.storage.local.get(spKeys, o => r(o)));
    for (const k of spKeys) {
        const v = spData[k];
        if (!v) continue;
        const uuid = (typeof v === 'string') ? v : (v?.productId || v?.uuid || '');
        if (uuid) return String(uuid);
    }

    // 3. deal_for_chat_ → получаем dealId → запрашиваем деталь сделки → ищем игру на SteamPass
    const dealData = await new Promise(r => chrome.storage.local.get([`deal_for_chat_${chatId}`], o => r(o)));
    const dealId = dealData[`deal_for_chat_${chatId}`];
    if (dealId) {
        try {
            const dd = await apiGetDealDetails(dealId);
            const rawItemName = dd?.deal?.item?.name;
            if (rawItemName) {
                const cleanName = cleanGameTitleFromItemName(rawItemName) || 'game';
                log(`🔍 Старый покупатель: ищу игру "${cleanName}" на SteamPass...`);
                // Используем spFindProductOnly вместо spFindAndBuy (без запроса credentials)
                const productId = await spFindProductOnly(cleanName);
                if (productId) return String(productId);
            }
        } catch (e) {
            console.warn(`[lookupOldBuyerUuid] deal lookup failed: ${e?.message}`);
        }
    }

    return null;
}

/**
 * Возвращает все уникальные записи истории для данного chatId.
 * Используется для определения: у покупателя одна или несколько покупок.
 */
async function lookupAllBuyerPurchases(chatId) {
    try {
        const raw = await new Promise(r => chrome.storage.local.get(ORDERS_HISTORY_KEY, o => r(o)));
        const db = raw[ORDERS_HISTORY_KEY] || [];
        // Дедупликация по productId — оставляем последнюю запись на каждый UUID
        const seen = new Map();
        for (const r of db) {
            if (r.chatId === chatId && r.productId) {
                const prev = seen.get(r.productId);
                if (!prev || (r.issuedAt || 0) > (prev.issuedAt || 0)) seen.set(r.productId, r);
            }
        }
        return [...seen.values()];
    } catch (_) { return []; }
}

/**
 * Пытается сопоставить текст сообщения с одной из покупок.
 * Поддерживает: "1"/"2" (порядковый номер), частичное совпадение по названию игры.
 */
function matchPurchaseByText(text, purchases) {
    if (!text || !purchases?.length) return null;
    const t = text.trim();
    const n = parseInt(t, 10);
    if (!isNaN(n) && n >= 1 && n <= purchases.length) return purchases[n - 1];
    const tl = t.toLowerCase();
    let best = null, bestScore = 0;
    for (const p of purchases) {
        const g = (p.gameTitle || '').toLowerCase();
        if (!g) continue;
        if (g === tl) return p;
        let sc = 0;
        if (g.includes(tl) || tl.includes(g)) sc += Math.min(tl.length, g.length);
        const words = tl.split(/\s+/).filter(w => w.length >= 3);
        for (const w of words) if (g.includes(w)) sc += w.length;
        if (sc > bestScore) { bestScore = sc; best = p; }
    }
    return bestScore >= 3 ? best : null;
}

/**
 * Получает текущие учётные данные из SteamPass по UUID.
 * Возвращает { login, password } или null при ошибке.
 */
async function fetchCurrentCredsFromSteamPass(uuid) {
    try {
        const credUrl = `https://steampass.gg/api/profile/product-credentials/${uuid}?account_platform=1`;
        const credRes = await callSteamPass(credUrl, 'GET');
        // Anti-detect: пометили что только что дёрнули creds — 2FA-прогрев пропустит этот UUID
        try { await chrome.storage.local.set({ [`sp_last_warmup_${uuid}`]: Date.now() }); } catch (_) { }
        const responseData = credRes?.result?.data ?? credRes?.data;
        let creds = responseData?.data ?? responseData;
        if (creds?.steam) creds = creds.steam;
        else if (creds?.uplay) creds = creds.uplay;
        else if (creds?.origin) creds = creds.origin;
        else if (creds?.rockstar) creds = creds.rockstar;
        else if (creds?.microsoft) creds = creds.microsoft;
        else if (creds?.account) creds = creds.account;
        else if (creds && typeof creds === 'object') {
            const sub = Object.values(creds).find(v => v && typeof v === 'object' && (v.login || v.username || v.password));
            if (sub) creds = sub;
        }
        const login = (creds?.login ?? creds?.username ?? creds?.email ?? '').trim();
        const password = (creds?.password ?? creds?.pass ?? '').trim();
        return (login && password) ? { login, password } : null;
    } catch (e) {
        console.warn(`[fetchCurrentCreds] SteamPass error for uuid ${uuid?.slice(0, 8)}:`, e?.message);
        return null;
    }
}

/**
 * Сравнивает выданные данные (из issued_creds_{chatId}) с текущими на SteamPass.
 * Если изменились — отправляет обновлённые данные в чат и возвращает true.
 * Если совпадают или uuid/данные недоступны — возвращает false.
 */
async function checkAndNotifyCredentialChange(chatId, uuid) {
    if (!uuid || !chatId) return false;

    const storedKey = `issued_creds_${chatId}`;
    const stored = await new Promise(r => chrome.storage.local.get([storedKey], o => r(o[storedKey])));
    if (!stored?.login) return false; // нет сохранённых данных — нечего сравнивать

    const current = await fetchCurrentCredsFromSteamPass(uuid);
    if (!current) return false; // SteamPass недоступен — не блокируем 2FA

    const unchanged = current.login.toLowerCase() === stored.login.toLowerCase() && current.password === stored.password;
    if (unchanged) return false;

    // Данные изменились — уведомляем покупателя
    console.log(`⚠️ [CredCheck] Данные изменились в чате ${chatId}: ${stored.login} → ${current.login}`);
    const msg = `⚠️ Данные аккаунта были обновлены! Вот актуальные:\n\nЛогин: ${current.login}\nПароль: ${current.password}\n\n⚠️ Если нужен код 2FA — напишите "код" или "2fa" в чат.`;
    const sendStatus = await apiSendMessage(chatId, msg);
    if (sendStatus?.ok) {
        await chrome.storage.local.set({ [storedKey]: { login: current.login, password: current.password, uuid, issuedAt: Date.now() } });
        await registerChatForMonitor(chatId);
        log(`📤 [CredCheck] Обновлённые данные отправлены в чат ${chatId}`);
    }
    return true;
}

/**
 * Обрабатывает запрос 2FA от старого покупателя (нет order_{chatId} в storage).
 * Логика:
 *  — Если уже отправили новые данные (флаг pending_creds_sent_{chatId}) → шлём 2FA-код
 *  — Иначе: ищем UUID, берём текущие данные из SteamPass, сравниваем с issued_creds_{chatId}.
 *    Если данные изменились (или старые не найдены) → отправляем новые данные и ставим флаг.
 *    Если данные совпадают → сразу шлём 2FA-код.
 */
async function handleOldBuyerCodeRequest(chatId) {
    if (_2faInFlight.has(chatId)) return;

    const pendingKey = `pending_creds_sent_${chatId}`;
    const pendingData = await new Promise(r => chrome.storage.local.get([pendingKey, `order_${chatId}`], o => r(o)));

    // Уже выслали новые данные — покупатель ещё раз попросил код,
    // отдаём в state-машину (она знает: NEW → мгновенно).
    if (pendingData[pendingKey]) {
        const uuid = pendingData[`order_${chatId}`]?.uuid;
        if (!uuid) { console.log(`[OldBuyer] нет uuid в order_ после pending, пропускаю ${chatId}`); return; }
        log(`🎯 [OldBuyer] Повторный запрос кода в чате ${chatId} — делегирую state-машине`);
        _2faInFlight.add(chatId);
        try {
            const tres = await handleBuyer2FATrigger(chatId, 'main');
            if (tres?.code === 'sent') {
                await mark2FASent(chatId);
                await chrome.storage.local.remove([pendingKey]);
                log(`✅ [OldBuyer] 2FA отправлен в чат ${chatId}`);
            } else {
                console.log(`[OldBuyer] handleBuyer2FATrigger → ${tres?.code}`);
            }
        } finally {
            _2faInFlight.delete(chatId);
        }
        return;
    }

    // Негативный кэш чтобы не долбить SteamPass бесконечно
    const failKey = `old_buyer_lookup_failed_${chatId}`;
    const failData = await new Promise(r => chrome.storage.local.get([failKey], r));
    if (failData[failKey] && Date.now() < failData[failKey]) {
        console.log(`[OldBuyer] UUID ранее не найден, жду КД для чата ${chatId}`);
        return;
    }

    // Ищем UUID старого заказа
    const uuid = await lookupOldBuyerUuid(chatId);
    if (!uuid) {
        console.log(`[OldBuyer] UUID не найден для чата ${chatId} — ставлю КД на 30 мин`);
        await chrome.storage.local.set({ [failKey]: Date.now() + 30 * 60 * 1000 });
        return;
    }

    // Успех — сбрасываем возможно зависший кэш (если игра появилась)
    await chrome.storage.local.remove([failKey]);

    // Сохраняем UUID чтобы handle2FARequest мог его найти
    await chrome.storage.local.set({ [`order_${chatId}`]: { uuid, date: Date.now(), source: 'legacy' } });

    // Получаем текущие учётные данные из SteamPass
    const current = await fetchCurrentCredsFromSteamPass(uuid);
    if (!current) {
        console.log(`[OldBuyer] нет актуальных данных из SteamPass для ${chatId}, пропускаю`);
        return;
    }

    // Сравниваем с тем, что было выдано ранее (читаем из storage, не из истории чата)
    const storedKey = `issued_creds_${chatId}`;
    const stored = await new Promise(r => chrome.storage.local.get([storedKey], o => r(o[storedKey])));

    let prevLogin = stored?.login || '';
    let prevPassword = stored?.password || '';

    // Fallback: если storage пустой — пробуем парсинг истории чата (совместимость со старыми заказами)
    if (!prevLogin) {
        try {
            const poll = await pollChatApi(chatId);
            const sellerMessages = (poll?.messages || []).filter(m => m.isFromMe);
            for (const m of sellerMessages.slice().reverse()) {
                const extracted = extractCredentialsFromText(m.text || '');
                if (extracted) { prevLogin = extracted.login; prevPassword = extracted.password; break; }
            }
        } catch (_) { }
    }

    const credentialsUnchanged = prevLogin &&
        current.login.toLowerCase() === prevLogin.toLowerCase() &&
        current.password === prevPassword;

    if (credentialsUnchanged) {
        // Данные не изменились — бутстрапим как старого покупателя и делегируем state-машине
        if (typeof setChatState === 'function') {
            const cur = (typeof getChatState === 'function') ? await getChatState(chatId) : null;
            if (!cur) await setChatState(chatId, STATE_IDLE);
        }
        log(`🎯 [OldBuyer] Данные не изменились — делегирую state-машине для чата ${chatId}`);
        _2faInFlight.add(chatId);
        try {
            const tres = await handleBuyer2FATrigger(chatId, 'main');
            if (tres?.code === 'sent') {
                await mark2FASent(chatId);
                log(`✅ [OldBuyer] 2FA отправлен в чат ${chatId}`);
            } else {
                console.log(`[OldBuyer] handleBuyer2FATrigger → ${tres?.code}`);
            }
        } finally {
            _2faInFlight.delete(chatId);
        }
    } else {
        // Данные изменились (или не были найдены ранее) — отправляем обновлённые данные
        const msg = `⚠️ Данные аккаунта были обновлены! Вот актуальные:\n\nЛогин: ${current.login}\nПароль: ${current.password}\n\n⚠️ Если нужен код 2FA — напишите "код" или "2fa" в чат.`;
        const sendStatus = await apiSendMessage(chatId, msg);
        if (sendStatus?.ok) {
            await chrome.storage.local.set({ [pendingKey]: Date.now() });
            await chrome.storage.local.set({ [storedKey]: { login: current.login, password: current.password, uuid, issuedAt: Date.now() } });
            await registerChatForMonitor(chatId);
            // Только что выдали свежие данные → 5-мин окно на мгновенный код
            if (typeof markChatGreeted === 'function') await markChatGreeted(chatId);
            log(`📤 [OldBuyer] Отправлены обновлённые данные в чат ${chatId} (UUID: ${uuid.slice(0, 8)}...)`);
        } else {
            console.warn(`[OldBuyer] ошибка отправки данных в чат ${chatId}`);
        }
    }
}

async function runShadowMonitor() {
    const stMon = await getStore();
    if (!stMon.isRunning && !isMainLoopRunning) return;

    // Тикаем очередь старых покупателей (открываем 2-мин слот голове, если CD прошёл)
    if (typeof tickOldBuyerQueue === 'function') {
        await tickOldBuyerQueue().catch(e => console.warn('tickOldBuyerQueue:', e?.message));
    }

    const MY_ID = MY_USER_ID || currentUserId;
    try {
        const storage = await chrome.storage.local.get(['monitored_chats', 'manually_removed_chats']);
        const monitoredList = storage['monitored_chats'] || {};
        const chatIds = Object.keys(monitoredList);
        // Blocklist: чаты удалённые вручную — не авто-регистрируем пока TTL не истёк
        const manuallyRemoved = storage['manually_removed_chats'] || {};

        // Предпочитаем вкладку из окна автовыдачи — не «перехватываем» главное окно
        let allTabs = await chrome.tabs.query({ url: "*://*.playerok.com/*" });
        if (allTabs.length === 0) {
            console.log("⚠️ Мониторинг: Нет вкладки Playerok");
            return;
        }
        let tabs = allTabs;
        if (fulfillWorkerWindowId != null) {
            const workerTabs = allTabs.filter(t => t.windowId === fulfillWorkerWindowId);
            if (workerTabs.length > 0) tabs = workerTabs;
        }
        // GQL Spy удалён — используем только Bridge API
        let chats;
        try {
            chats = await fetchChatsViaBridge();
        } catch (e) {
            console.log("⚠️ Мониторинг: Bridge не сработал:", e?.message);
        }
        if (!chats) return;

        chats = chats || [];
        console.log(`🕵️ Мониторинг: ${chatIds.length} в списке, ${chats.length} от API. Мониторим:`, chatIds);

        for (const chat of chats) {
            const inList = !!monitoredList[chat.chatId];
            const text = (chat.text || "").toLowerCase().trim();
            const isFromClient = chat.authorId != null && chat.authorId !== MY_ID;
            const hasTrigger = text.includes("код") || text.includes("2fa") || text.includes("code");

            if (inList) {
                console.log(`✉️ [${chat.chatId}] "${chat.text}" | authorId=${chat.authorId} | от клиента? ${isFromClient} | триггер? ${hasTrigger}`);
            }

            // Авто-регистрация: любое сообщение от клиента — проверяем есть ли заказ.
            // Фильтр по botStartTime не применяем для авто-lookup — безопасно,
            // т.к. если сделки в Playerok нет, ничего не произойдёт.
            // Пропускаем чаты из blocklist «удалено вручную» (TTL 48ч)
            if (isFromClient && !inList && !(manuallyRemoved[chat.chatId] && Date.now() < manuallyRemoved[chat.chatId])) {
                const orderData = await new Promise(r => chrome.storage.local.get(
                    [`order_${chat.chatId}`, `issued_creds_${chat.chatId}`],
                    o => r(o)
                ));
                const hasKnownOrder = !!(orderData[`order_${chat.chatId}`]?.uuid || orderData[`issued_creds_${chat.chatId}`]?.login);
                if (hasKnownOrder) {
                    // Заказ уже в БД — добавляем только новые сообщения (после старта бота)
                    const msgTs = chat.time ? new Date(chat.time).getTime() : 0;
                    if (!botStartTime || !msgTs || msgTs >= botStartTime) {
                        console.log(`📡 [${chat.chatId}] Новое сообщение от клиента (заказ найден) — добавляю в мониторинг.`);
                        await registerChatForMonitor(chat.chatId).catch(() => {});
                        monitoredList[chat.chatId] = Date.now();
                    }
                } else if (!_chatAutoLookupDone.has(chat.chatId)) {
                    // Неизвестный покупатель — запрашиваем сделку у Playerok (без фильтра по времени)
                    _chatAutoLookupDone.add(chat.chatId);
                    console.log(`🔍 [${chat.chatId}] Неизвестный покупатель написал — ищу его сделку...`);
                    (async () => {
                        try {
                            const chatDeal = await apiGetChatDeal(chat.chatId);
                            if (!chatDeal) {
                                console.log(`⏭ [${chat.chatId}] Сделка не найдена — не добавляю в мониторинг.`);
                                return;
                            }
                            const toSave = {};
                            if (chatDeal.dealId) {
                                toSave[`deal_for_chat_${chat.chatId}`] = chatDeal.dealId;
                                toSave[`chat_for_deal_${chatDeal.dealId}`] = chat.chatId;
                            }
                            if (chatDeal.buyerName || chatDeal.itemName) {
                                toSave[`manual_meta_${chat.chatId}`] = {
                                    buyerName: chatDeal.buyerName || null,
                                    gameTitle: chatDeal.itemName || null,
                                };
                            }
                            if (Object.keys(toSave).length) await chrome.storage.local.set(toSave);
                            await registerChatForMonitor(chat.chatId);
                            log(`📡 [${chat.chatId}] Авто-добавлен в мониторинг: ${chatDeal.buyerName || '?'} (${chatDeal.itemName || '?'})`);
                        } catch (e) {
                            console.warn(`[autoLookup] ${chat.chatId}: ${e?.message}`);
                            _chatAutoLookupDone.delete(chat.chatId); // сбрасываем чтобы попробовать снова
                        }
                    })();
                }
            }


            // === КЛАССИЧЕСКИЙ РЕЖИМ ===
            if (!isFromClient) continue;
            if (!isMainLoopRunning) break;

            const pendingSelKey = `pending_game_selection_${chat.chatId}`;

            // === ВЫБОР ИГРЫ (покупатель с несколькими покупками) ===
            // Если бот ранее запросил уточнение — обрабатываем ответ покупателя независимо от hasTrigger
            const pendingSel = await new Promise(r => chrome.storage.local.get([pendingSelKey], o => r(o[pendingSelKey])));
            if (pendingSel) {
                if (hasTrigger) {
                    // Повторный "код" — показываем список снова
                    const glRepeat = (pendingSel.purchases || []).map((p, i) => `${i + 1}. ${p.gameTitle || 'Игра'}`).join('\n');
                    await apiSendMessage(chat.chatId, `Для какой игры нужен код? Напишите номер или название:\n${glRepeat}`).catch(() => {});
                } else {
                    const matchedPurchase = matchPurchaseByText(text, pendingSel.purchases || []);
                    if (matchedPurchase) {
                        await chrome.storage.local.set({ [`order_${chat.chatId}`]: { uuid: matchedPurchase.productId, date: Date.now(), source: 'multi_selection' } });
                        await chrome.storage.local.remove([pendingSelKey]);
                        if (!_2faInFlight.has(chat.chatId)) {
                            _2faInFlight.add(chat.chatId);
                            try {
                                const r2 = await handleBuyer2FATrigger(chat.chatId, 'main');
                                log(`[multi] handleBuyer2FATrigger("${matchedPurchase.gameTitle}") → ${r2?.code}`);
                            } catch (e2) {
                                console.warn('[multi] 2FA error:', e2?.message);
                            } finally {
                                _2faInFlight.delete(chat.chatId);
                            }
                        }
                    } else {
                        const glRetry = (pendingSel.purchases || []).map((p, i) => `${i + 1}. ${p.gameTitle || 'Игра'}`).join('\n');
                        await apiSendMessage(chat.chatId, `Не могу определить игру. Напишите номер:\n${glRetry}`).catch(() => {});
                    }
                }
                continue;
            }

            // Только триггеры ("код", "2fa", "code")
            if (!hasTrigger) continue;

            // Для чатов НЕ в мониторинге — фильтруем старые сообщения только если заказ уже есть в БД.
            // Если autoLookup уже запущен для этого чата — пропускаем триггер в этом цикле,
            // следующий цикл подхватит когда deal_for_chat_ уже будет сохранён.
            if (!inList && _chatAutoLookupDone.has(chat.chatId)) {
                console.log(`⏭ [${chat.chatId}] autoLookup в процессе — жду следующего цикла.`);
                continue;
            }
            if (!inList && botStartTime > 0 && chat.time) {
                const msgTs = new Date(chat.time).getTime();
                if (!isNaN(msgTs) && msgTs < botStartTime) {
                    const hasRecord = await new Promise(r => chrome.storage.local.get(
                        [`order_${chat.chatId}`, `issued_creds_${chat.chatId}`], o => r(o)
                    ));
                    const knownInDb = !!(hasRecord[`order_${chat.chatId}`]?.uuid || hasRecord[`issued_creds_${chat.chatId}`]?.login);
                    if (knownInDb) {
                        console.log(`⏭ [${chat.chatId}] Старое сообщение (до старта бота), заказ в БД — пропускаю.`);
                        continue;
                    }
                }
            }

            // FIX: mutex устанавливается ДО первого await — предотвращает гонку между
            // параллельными вызовами runShadowMonitor (interval + mainLoop)
            if (_2faInFlight.has(chat.chatId)) {
                console.log(`⏭ [${chat.chatId}] 2FA уже выполняется в другом потоке, пропускаю.`);
                continue;
            }
            _2faInFlight.add(chat.chatId);
            try {
                const orderKey = 'order_' + chat.chatId;
                const { [orderKey]: order } = await chrome.storage.local.get([orderKey]);
                if (!order?.uuid) {
                    // Если чат в blocklist «удалено вручную» — не пытаемся снова найти UUID / добавить в монитор
                    if (manuallyRemoved[chat.chatId] && Date.now() < manuallyRemoved[chat.chatId]) {
                        console.log(`⏭ [${chat.chatId}] Чат удалён вручную (blocklist) — пропускаю handleOldBuyerCodeRequest.`);
                        continue;
                    }
                    // FIX: ищем UUID для любого чата, не только !inList
                    _2faInFlight.delete(chat.chatId); // снимаем lock — handleOldBuyerCodeRequest ставит свой
                    await handleOldBuyerCodeRequest(chat.chatId).catch(e => {
                        console.warn(`⚠️ handleOldBuyerCodeRequest [${chat.chatId}]:`, e?.message);
                    });
                    continue; // finally тоже выполнится (delete на отсутствующем ключе — безопасно)
                }


                // FIX: несколько покупок — уточняем для какой игры нужен код
                const allPurchases = await lookupAllBuyerPurchases(chat.chatId);
                if (allPurchases.length > 1) {
                    const gameHint = matchPurchaseByText(text, allPurchases);
                    if (gameHint) {
                        // Покупатель написал "2fa GTA" — угадываем игру из текста триггера
                        await chrome.storage.local.set({ [`order_${chat.chatId}`]: { uuid: gameHint.productId, date: Date.now(), source: 'multi_hint' } });
                        order.uuid = gameHint.productId;
                    } else {
                        // Спрашиваем покупателя
                        const gl = allPurchases.map((p, i) => `${i + 1}. ${p.gameTitle || 'Игра'}`).join('\n');
                        await apiSendMessage(chat.chatId, `Для какой игры нужен код? Напишите номер или название:\n${gl}`).catch(() => {});
                        await chrome.storage.local.set({ [pendingSelKey]: { purchases: allPurchases, askedAt: Date.now() } });
                        continue; // finally удалит _2faInFlight
                    }
                }

                // Cred-check теперь делается ВНУТРИ слота (handleBuyer2FATrigger),
                // здесь не дёргаем SteamPass пре-эмптивно.

                if (!inList) console.log(`🎯 ТРИГГЕР! Поздний запрос 2FA в чате ${chat.chatId} (order есть)`);
                else console.log(`🎯 ТРИГГЕР! Клиент просит код в чате ${chat.chatId}`);

                const tres = await handleBuyer2FATrigger(chat.chatId, 'main');
                if (tres?.code === 'noop') {
                    // У чата нет state и нет issued_creds — это «старый» покупатель,
                    // которого ещё не знаем. Отдаём в legacy-ветку поиска UUID/выдачи кредов.
                    _2faInFlight.delete(chat.chatId);
                    await handleOldBuyerCodeRequest(chat.chatId).catch(e => {
                        console.warn(`⚠️ handleOldBuyerCodeRequest [${chat.chatId}]:`, e?.message);
                    });
                    continue;
                }
                if (tres?.code === 'sent') {
                    await mark2FASent(chat.chatId);
                    console.log(`✅ 2FA отправлен в чат [${chat.chatId}] (state-machine)`);
                    const updatedList = await new Promise(r => chrome.storage.local.get(['monitored_chats'], r));
                    const ml = updatedList['monitored_chats'] || {};
                    delete ml[chat.chatId];
                    await chrome.storage.local.set({ 'monitored_chats': ml });
                    const dealKey = `deal_for_chat_${chat.chatId}`;
                    const rev = await new Promise(r => chrome.storage.local.get([dealKey], r));
                    const dealIdSc = rev[dealKey];
                    if (dealIdSc) {
                        try {
                            const markRes = await apiMarkFulfilled(dealIdSc);
                            if (markRes?.error) log(`⚠️ apiMarkFulfilled (монитор 2FA): ${markRes.error}`);
                            const dealUrl = `https://playerok.com/deal/${dealIdSc}`;
                            await domClickFulfilled(dealUrl);
                            const ord = await getOrder(dealUrl);
                            if (ord) await finishOrderSuccess(ord);
                        } catch (e) {
                            log(`⚠️ Завершение сделки после 2FA (монитор): ${e.message || e}`);
                        }
                    }
                } else if (tres?.code === 'error') {
                    await mark2FAError(chat.chatId);
                    console.log(`⚠️ 2FA error для ${chat.chatId}: ${(tres.text || '').slice(0, 80)}`);
                } else {
                    console.log(`📋 [${chat.chatId}] handleBuyer2FATrigger → ${tres?.code}`);
                }
            } catch (e) {
                console.warn("⚠️ Ошибка 2FA (мониторинг продолжается):", e?.message);
            } finally {
                _2faInFlight.delete(chat.chatId);
            }
        }
    } catch (e) {
        console.error("Monitor Fatal Error:", e);
    }
}

function cleanGameTitleFromItemName(raw) {
    if (!raw) return '';
    let s = String(raw)
        // U+2B00–2BFF: ⭐ и др. звёзды/стрелки (не входят в 2600–27BF)
        .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FEFF}]/gu, '')
        .replace(/[|].*$/i, '')
        .replace(/\s*[-–—].*$/i, '')
        .replace(/\s*\([^)]*\)/g, '')        // strip closed parens: "(Steam Edition)", "(Pre-Order)", etc.
        .replace(/\s*\([^)]*$/, '')           // strip unclosed trailing paren: "Game ("
        .replace(/\s*(ОФФЛАЙН|OFFLINE|АКТИВАЦИЯ|ДОСТУП|АККАУНТ|Steam|Edition|Gold|Premium|Deluxe).*$/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
    return s || String(raw).trim();
}

async function apiScanOrders() {
    if (apiScanInProgress) return null;
    // Устанавливаем флаг ДО первого await — иначе два конкурентных вызова оба пройдут guard
    apiScanInProgress = true;
    try {
        const stScan = await getStore();
        if (!stScan.isRunning && !isMainLoopRunning) return null;
        console.log('📡 Сканирование активных заказов...');
        if (apiPausedUntil > Date.now()) return null;
        if (!currentUserId) {
            try {
                const data = await playerokApi('viewer', VIEWER_QUERY, {});
                if (data?.viewer?.id) { currentUserId = data.viewer.id; MY_USER_ID = data.viewer.id; chrome.storage.local.set({ playerokUserId: data.viewer.id }); }
            } catch (e) {
                log(`🚨 Bridge не отвечает — проверьте авторизацию Playerok (${e.message || 'timeout'})`);
            }
            if (!currentUserId) {
                log('⚠️ ID пользователя не определён. Сканирование пропущено.');
                return null;
            }
        }

        const variables = {
            pagination: { first: 10 },
            filter: {
                userId: currentUserId,
                direction: 'OUT',
                status: ['PAID']
            },
            showForbiddenImage: true
        };

        const extensions = {
            persistedQuery: { version: 1, sha256Hash: DEALS_PERSISTED_HASH }
        };

        const data = await playerokApi('deals', null, variables, extensions);
        const edges = data?.deals?.edges || [];
        const results = [];

        if (edges.length === 0) {
            console.log('📭 Активных заказов (PAID) не найдено.');
        } else {
            log(`📦 Найдено заказов: ${edges.length}`);
        }

        for (const edge of edges) {
            const stLoop = await getStore();
            if (!stLoop.isRunning && !isMainLoopRunning) break;

            const node = edge.node;
            if (!node) continue;
            const dealId = node.id;

            // Самовосстановление: в processedDeals, но сделка всё ещё PAID и в чате нет выдачи — иначе вечный «пропуск»
            if (processedDeals.has(dealId) || processingOrders.has(dealId)) {
                let chatRec = (await chrome.storage.local.get([`chat_for_deal_${dealId}`]))[`chat_for_deal_${dealId}`];
                let dealNodeHeal = null;
                if (!chatRec) {
                    try {
                        const ddr = await apiGetDealDetails(dealId);
                        dealNodeHeal = ddr?.deal;
                        chatRec = ddr?.deal?.chat?.id;
                        if (chatRec) {
                            await chrome.storage.local.set({
                                [`chat_for_deal_${dealId}`]: chatRec,
                                [`deal_for_chat_${chatRec}`]: dealId
                            });
                        }
                    } catch (_) { /* ignore */ }
                } else {
                    try {
                        const ddr = await apiGetDealDetails(dealId);
                        dealNodeHeal = ddr?.deal;
                    } catch (_) { /* ignore */ }
                }
                if (chatRec) {
                    const pollRec = await pollChatApi(chatRec);
                    if (pollRec && !(await sellerDeliveredForThisDeal(dealId, pollRec.messages, dealNodeHeal))) {
                        processedDeals.delete(dealId);
                        processingOrders.delete(dealId);
                        saveProcessedDeals();
                        log(`🔄 [${dealId.slice(-8)}] PAID без выдачи по этой сделке в чате — снимаю «обработан», обработаю снова`);
                    }
                }
            }

            // --- РАННЯЯ ПРОВЕРКА: уже обработан или в процессе ---
            // failedDeals НЕ блокируют навсегда — это временные ошибки, нужно ретраить
            const isPermanentlyProcessed = processingOrders.has(dealId) || processedDeals.has(dealId);
            if (isPermanentlyProcessed) {
                try {
                    const storedChat = await chrome.storage.local.get([`chat_for_deal_${dealId}`]);
                    const knownChatId = storedChat[`chat_for_deal_${dealId}`];
                    if (knownChatId && !_2faInFlight.has(knownChatId)) {
                        const closed = await tryAutoMarkFulfilledWhenChatHas2FA(dealId, knownChatId);
                        if (closed) {
                            log(`⏭ [${dealId.slice(-8)}] Сделка закрыта по чату (2FA + выдача).`);
                            await new Promise(r => setTimeout(r, 200));
                            continue;
                        }
                    }
                    if (knownChatId && !_2faInFlight.has(knownChatId) && !(await is2FAOnCooldown(knownChatId))) {
                        const storedData = await chrome.storage.local.get(['order_' + knownChatId]);
                        const orderInfo = storedData['order_' + knownChatId];
                        if (orderInfo?.uuid) {
                            console.log(`📨 [${dealId.slice(-8)}] Уже обработан, проверяю новый запрос 2FA...`);
                            _2faInFlight.add(knownChatId);
                            try {
                                const twoFASent = await checkChatAndReply2FA(dealId, knownChatId);
                                if (twoFASent) {
                                    const dealUrlEarly = `https://playerok.com/deal/${dealId}`;
                                    const markRes = await apiMarkFulfilled(dealId);
                                    if (markRes?.error) log(`⚠️ apiMarkFulfilled: ${markRes.error}`);
                                    await domClickFulfilled(dealUrlEarly);
                                    let ordEarly = await getOrder(dealUrlEarly);
                                    if (!ordEarly) {
                                        let buyerName = '';
                                        let gameTitle = '';
                                        try {
                                            const dd = await apiGetDealDetails(dealId);
                                            buyerName = dd?.deal?.user?.username || '';
                                            gameTitle = cleanGameTitleFromItemName(dd?.deal?.item?.name || '');
                                        } catch (_) { /* ignore */ }
                                        ordEarly = {
                                            orderUrl: dealUrlEarly,
                                            orderId: dealId,
                                            chatId: knownChatId,
                                            buyerName,
                                            gameTitle,
                                            tabIds: {},
                                            status: ORDER_STATUS.WAITING_2FA
                                        };
                                    }
                                    await finishOrderSuccess(ordEarly);
                                }
                            } finally { _2faInFlight.delete(knownChatId); }
                        }
                    }
                } catch (_) { }
                log(`⏭ [${dealId.slice(-8)}] Заказ уже обработан — пропуск. Если залипло: кнопка «Сбросить обработанные заказы» в окне автовыдачи.`);
                await new Promise(r => setTimeout(r, 200));
                continue;
            }

            // Для ранее упавших заказов — сбрасываем флаг и пробуем снова
            failedDeals.delete(dealId);

            console.log(`⏳ [${dealId}] Запрашиваю детали через API...`);

            let dealData;
            try {
                dealData = await apiGetDealDetails(dealId);
            } catch (e) {
                log(`📡 API deal ошибка [${dealId.slice(-8)}]: ${e.message} — повтор в следующем цикле`);
                // Не добавляем в failedDeals постоянно — временная ошибка, попробуем снова
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }

            const chatId = dealData?.deal?.chat?.id;

            if (!chatId) {
                console.warn(`⛔️ API не вернул ChatID для ${dealId}`);
                failedDeals.add(dealId); // структурная проблема — повтор смысла не имеет
                continue;
            }

            if (chatId === dealId) {
                log(`⚠️ ChatID совпадает с DealID. Пропускаем. [${dealId}]`);
                failedDeals.add(dealId);
                continue;
            }

            console.log(`✅ [${dealId}] ChatID найден: ${chatId}`);
            await registerChatForMonitor(chatId);
            // Сохраняем связь dealId → chatId для 2FA-мониторинга при повторных сканах
            chrome.storage.local.set({
                [`chat_for_deal_${dealId}`]: chatId,
                [`deal_for_chat_${chatId}`]: dealId
            });

            const buyerName = node.user ? node.user.username : 'Неизвестный';
            const gameTitle = cleanGameTitleFromItemName(node.item ? node.item.name : 'Товар');
            const orderUrl = `https://playerok.com/deal/${dealId}`;

            // Помечаем как «в обработке» — снимем метку если выдача не удалась.
            // processingOrders сразу — иначе fulfillHeartbeat успевает запустить вторую цепочку (двойная выдача).
            cappedSetAdd(processedDeals, dealId, 2000);
            processingOrders.add(dealId);

            let credentialsSent = false;
            const poll = await pollChatApi(chatId);
            if (poll && await sellerDeliveredForThisDeal(dealId, poll.messages, dealData?.deal)) {
                log(`⏭ [${dealId.slice(-8)}] В чате уже есть выдача по этой сделке. Пропуск.`);
                saveProcessedDeals();
                credentialsSent = true;
            } else {
                log(`🚀 [SteamPass] Ищу аккаунт для: ${gameTitle}`);
                try {
                    const accountData = await spFindAndBuy(gameTitle, chatId);
                    if (accountData) {
                        const { login, password } = accountData;
                        const msg = `Спасибо за покупку!\n\nЛогин: ${login}\nПароль: ${password}\n\n⚠️ Если нужен код 2FA — напишите "код" или "2fa" в чат.\nЕсли нужен код от других лаунчеров (EA, Ubisoft, Rockstar и т.д.) — это происходит в ручном режиме.`;
                        const sendRes = await apiSendMessage(chatId, msg);
                        if (sendRes.ok) {
                            credentialsSent = true;
                            await chrome.storage.local.set({ [`cred_sent_deal_${dealId}`]: true });
                            saveProcessedDeals();
                            await registerChatForMonitor(chatId);
                            if (typeof markChatGreeted === 'function') await markChatGreeted(chatId);
                            const dItem = dealData?.deal?.item;
                            await saveOrderToHistory({
                                orderId: dealId,
                                chatId,
                                buyerName,
                                gameTitle,
                                login: accountData.login,
                                password: accountData.password,
                                productId: accountData.productId,
                                priceRub: extractDealPriceRub(node),
                                dealUrl: orderUrl,
                                playerokItemId: dItem?.id || node.item?.id || '',
                                playerokItemSlug: dItem?.slug || node.item?.slug || ''
                            });
                            log(`✅ Данные выданы для ${chatId}`);
                            await bumpFulfilledToday();
                        } else {
                            // Отправка не удалась — убираем из processedDeals, попробуем снова
                            processedDeals.delete(dealId);
                            processingOrders.delete(dealId);
                            log(`⚠️ Ошибка отправки сообщения. Заказ будет повторён.`);
                        }
                    } else {
                        // Аккаунт не найден — убираем из processedDeals, попробуем в следующем цикле
                        processedDeals.delete(dealId);
                        processingOrders.delete(dealId);
                        log(`❌ Аккаунт не найден на SteamPass. Заказ будет повторён.`);
                    }
                } catch (e) {
                    processedDeals.delete(dealId);
                    processingOrders.delete(dealId);
                    console.error('SteamPass Error:', e);
                    log(`❌ SteamPass: ${e.message}`);
                }
            }

            results.push({ orderId: dealId, orderUrl, buyerName, gameTitle, chatId, credentialsSent });
            if (credentialsSent) log(`✅ Заказ выдан: ${gameTitle} | Клиент: ${buyerName}`);

            // Anti-detect: разносим выдачу нескольких заказов во времени.
            // Раньше — фикс. 1 сек → SP видит burst из N filter+credentials с интервалом ровно 1 сек.
            // Теперь — 20-75 сек jitter, имитирует обычное «поштучно» поведение продавца.
            const delay = 20000 + Math.floor(Math.random() * 55000);
            console.log(`[SP-stealth] Пауза ${Math.round(delay/1000)}с перед следующим заказом`);
            await new Promise(r => setTimeout(r, delay));
        }
        return results;
    } catch (e) {
        log(`📡 API: Ошибка deals — ${e.message}`);
        apiPausedUntil = Date.now() + 30000;
        return null;
    } finally {
        apiScanInProgress = false;
    }
}

async function pollChatApi(chatId) {
    try {
        const data = await playerokApi('ChatMessages', QUERY_CHAT_MESSAGES, { chatId });
        const messages = (data?.chat?.messages?.edges || []).map(e => e?.node).filter(Boolean);
        return { messages };
    } catch (e) {
        return null;
    }
}

async function apiSendMessage(chatId, text) {
    const operationName = 'createChatMessage';
    const query = `mutation createChatMessage($input: CreateChatMessageInput!) {
  createChatMessage(input: $input) {
    id
    text
    __typename
  }
}`;
    const variables = {
        input: {
            chatId: chatId,
            text: text,
            imagesIds: []
        }
    };
    try {
        await playerokApi(operationName, query, variables);
        log(`✅ Сообщение отправлено в чат [${chatId}]`);
        return { ok: true };
    } catch (e) {
        return { error: e.message };
    }
}

function messageTimeMs(m) {
    const raw = m.created_at || m.createdAt;
    if (!raw) return 0;
    const t = new Date(raw).getTime();
    return Number.isFinite(t) ? t : 0;
}

function hasSellerGreetingOrData(messages) {
    const list = messages || [];
    const sellerText = list.filter(m => m.isFromMe).map(m => (m.text || '').toLowerCase()).join(' ');
    if (/логин|пароль|здравствуйте|спасибо\s*за\s*покупку|данные\s*для\s*аккаунта|бот-помощник/i.test(sellerText)) return true;
    // Playerok/Apollo иногда не ставит isFromMe на наших сообщениях — ловим шаблон выдачи в любом сообщении
    const credBlock = /логин\s*:\s*\S+[\s\S]{0,160}?пароль\s*:\s*\S+/i;
    return list.some(m => credBlock.test(m.text || ''));
}

/** Учитывает только сообщения не раньше сделки (или якоря), иначе повторный заказ того же клиента в том же чате даёт ложное «уже выдали». */
function hasSellerGreetingOrDataSince(messages, sinceMs) {
    if (!sinceMs || sinceMs <= 0) return hasSellerGreetingOrData(messages);
    const slackMs = 120000;
    const list = (messages || []).filter(m => messageTimeMs(m) >= sinceMs - slackMs);
    return hasSellerGreetingOrData(list);
}

/**
 * Есть ли выдача именно по этой сделке: флаг после успешной отправки, иначе эвристика по сообщениям после createdAt сделки / якоря первого скана.
 */
async function sellerDeliveredForThisDeal(dealId, messages, dealNode) {
    if (!dealId) return hasSellerGreetingOrData(messages);
    const credKey = `cred_sent_deal_${dealId}`;
    const st = await chrome.storage.local.get([credKey]);
    if (st[credKey]) return true;
    const raw = dealNode?.createdAt || dealNode?.paidAt;
    let sinceMs = 0;
    if (raw) {
        const t = new Date(raw).getTime();
        if (Number.isFinite(t)) sinceMs = t;
    }
    if (sinceMs > 0) return hasSellerGreetingOrDataSince(messages, sinceMs);
    const anchorKey = `deal_anchor_${dealId}`;
    const a = await chrome.storage.local.get([anchorKey]);
    let anchor = a[anchorKey];
    if (!anchor) {
        anchor = Date.now();
        await chrome.storage.local.set({ [anchorKey]: anchor });
    }
    return hasSellerGreetingOrDataSince(messages, anchor);
}

function hasSellerSent2FACode(messages) {
    const list = messages || [];
    const sellerText = list.filter(m => m.isFromMe).map(m => (m.text || '').toLowerCase()).join(' ');
    if (/код\s*steam\s*guard|steam\s*guard\s*код|ваш\s*код|твой\s+код\s+steam/i.test(sellerText)) return true;
    // Наши сообщения через API иногда без isFromMe — ловим шаблон «🛡 … Steam Guard: XXXX»
    const anyText = list.map(m => (m.text || '').toLowerCase()).join('\n');
    if (/🛡|steam\s*guard\s*:\s*[a-z0-9]{4,8}|твой\s+код\s+steam\s*guard|ваш\s+код\s+steam/i.test(anyText)) return true;
    return false;
}

/**
 * Сделка PAID, выдача уже была, в чате есть наш 2FA — жмём «Я выполнил» и чистим очередь.
 * Нужно для заказов, которые в processedDeals и на каждом скане только «пропуск», без записи в fulfillStore.
 */
async function tryAutoMarkFulfilledWhenChatHas2FA(dealId, chatId) {
    if (!dealId || !chatId) return false;
    if (_fulfillCompleteInFlight.has(dealId)) return false;
    const poll = await pollChatApi(chatId);
    if (!poll?.messages?.length) return false;
    if (!hasSellerSent2FACode(poll.messages)) return false;
    let dealForCred = null;
    try {
        const ddr = await apiGetDealDetails(dealId);
        dealForCred = ddr?.deal;
    } catch (_) { /* ignore */ }
    const credsInChat = await sellerDeliveredForThisDeal(dealId, poll.messages, dealForCred);
    const weMarkedIssued = processedDeals.has(dealId) || processingOrders.has(dealId);
    if (!credsInChat && !weMarkedIssued) return false;

    _fulfillCompleteInFlight.add(dealId);
    try {
        const dealUrl = `https://playerok.com/deal/${dealId}`;
        log(`🖱️ [${dealId.slice(-8)}] Обнаружены выдача + 2FA в чате — отмечаю заказ выполненным`);
        const markRes = await apiMarkFulfilled(dealId);
        if (markRes?.error) log(`⚠️ apiMarkFulfilled: ${markRes.error}`);
        await domClickFulfilled(dealUrl);
        let ord = await getOrder(dealUrl);
        if (!ord) {
            let buyerName = '';
            let gameTitle = '';
            try {
                const dd = await apiGetDealDetails(dealId);
                buyerName = dd?.deal?.user?.username || '';
                gameTitle = cleanGameTitleFromItemName(dd?.deal?.item?.name || '');
            } catch (_) { /* ignore */ }
            ord = {
                orderUrl: dealUrl,
                orderId: dealId,
                chatId,
                buyerName,
                gameTitle,
                tabIds: {},
                status: ORDER_STATUS.WAITING_2FA
            };
        }
        await finishOrderSuccess(ord);
        return true;
    } catch (e) {
        log(`⚠️ Автозакрытие после 2FA: ${e.message || e}`);
        return false;
    } finally {
        _fulfillCompleteInFlight.delete(dealId);
    }
}

async function checkChatAndReply2FA(dealId, chatId) {
    const lastMsg = await fetchChatHistoryHTML(chatId);
    if (!lastMsg) return false;
    if (lastMsg.authorId === MY_USER_ID) return false;
    if (lastMsg.authorId == null) return false;
    if (processedMessageIds.has(lastMsg.id)) return false;
    const createdAt = lastMsg.created_at ? new Date(lastMsg.created_at).getTime() : 0;
    if (createdAt < lastProcessedTime) return false;
    const content = (lastMsg.text ?? lastMsg.content ?? '').toLowerCase();
    const triggers = ['код', 'code', 'f2', '2fa'];
    const isChild = /сошиал|код\s*2|social|рокстар|uplay/.test(content);
    const isMain = triggers.some(t => content.includes(t));
    if (!isMain && !isChild) return false;
    const type = isChild ? 'child' : 'main';
    if (isMain) {
        // Steam-2FA — через state-машину (очередь / 5-мин CD / NEW window)
        const tres = await handleBuyer2FATrigger(chatId, type);
        if (tres?.code === 'sent') {
            await mark2FASent(chatId);
            processedMessageIds.add(lastMsg.id);
            _pruneProcessedMessageIds();
            log(`🔑 2FA код отправлен для чата [${chatId}]`);
            return true;
        }
        if (tres?.code === 'error') {
            await mark2FAError(chatId);
            processedMessageIds.add(lastMsg.id);
            _pruneProcessedMessageIds();
        }
        return false;
    }
    // child (EA/Ubisoft/Rockstar/Social) — оставляем legacy: запрос идёт сразу через handle2FARequest
    if (await is2FAOnCooldown(chatId)) return false;
    const result = await handle2FARequest(chatId, type);
    if (result == null) return false;
    const res = await apiSendMessage(chatId, result);
    if (!res.ok) return false;
    const sentRealCode = result.startsWith?.('🛡');
    if (sentRealCode) {
        await mark2FASent(chatId);
        processedMessageIds.add(lastMsg.id);
        _pruneProcessedMessageIds();
        log(`🔑 2FA код отправлен для чата [${chatId}]`);
        return true;
    }
    await mark2FAError(chatId);
    processedMessageIds.add(lastMsg.id);
    _pruneProcessedMessageIds();
    return false;
}

async function checkChatFor2FA(dealId, chatId) {
    const poll = await pollChatApi(chatId);
    if (!poll?.messages?.length) return false;
    if (hasSellerSent2FACode(poll.messages)) return false;

    const isOutgoing = (m) => m.is_outgoing === true || m.isFromMe === true || m.sender?.is_me === true;
    const incoming = poll.messages.filter(m => !isOutgoing(m));
    for (const msg of incoming) {
        const msgId = msg.id;
        if (processedMessageIds.has(msgId)) continue;

        const text = (msg.text || '').toLowerCase().trim();
        const isMain = text === 'код' || text === 'code' || text.includes('стим') || text.includes('f2') || text.includes('2fa') || text.includes('цифры');
        const isChild = text.includes('сошиал') || text.includes('код 2') || text.includes('social') || text.includes('рокстар') || text.includes('uplay');
        if (!isMain && !isChild) continue;

        const createdAt = (msg.created_at || msg.createdAt) ? new Date(msg.created_at || msg.createdAt).getTime() : 0;
        if (createdAt < lastProcessedTime) continue;

        const type = isChild ? 'child' : 'main';
        if (isMain) {
            const tres = await handleBuyer2FATrigger(chatId, type);
            if (tres?.code === 'sent') {
                await mark2FASent(chatId);
                processedMessageIds.add(msgId);
                _pruneProcessedMessageIds();
                log(`🔑 2FA код отправлен для чата [${chatId}]`);
                return true;
            }
            if (tres?.code === 'error') {
                await mark2FAError(chatId);
                processedMessageIds.add(msgId);
                _pruneProcessedMessageIds();
            } else {
                processedMessageIds.add(msgId);
                _pruneProcessedMessageIds();
            }
            continue;
        }
        // child legacy
        if (await is2FAOnCooldown(chatId)) continue;
        const result = await handle2FARequest(chatId, type);
        if (result == null) continue;
        const res = await apiSendMessage(chatId, result);
        if (!res.ok) continue;
        const sentRealCode = result.startsWith?.('🛡');
        if (sentRealCode) {
            await mark2FASent(chatId);
            processedMessageIds.add(msgId);
            _pruneProcessedMessageIds();
            log(`🔑 2FA код отправлен для чата [${chatId}]`);
            return true;
        }
        await mark2FAError(chatId);
        processedMessageIds.add(msgId);
        _pruneProcessedMessageIds();
    }
    return false;
}

async function apiMarkFulfilled(dealId) {
    for (const { name, query, inputMode } of MUTATIONS_FULFILLED) {
        try {
            const variables = inputMode
                ? { input: { id: dealId, status: 'SENT' } }
                : { dealId };
            await playerokApi(name, query, variables);
            if (!apiMarkFulfilled._lastOk) {
                apiMarkFulfilled._lastOk = name;
                log(`✅ API markFulfilled: используется мутация ${name}`);
            }
            return { ok: true };
        } catch (e) {
            if (e.message?.includes('Cannot query field') || e.message?.includes('GRAPHQL')) continue;
        }
    }
    if (!apiMarkFulfilled._introspectDone) {
        apiMarkFulfilled._introspectDone = true;
        try {
            const intro = await playerokApi('Introspection', `query { __schema { mutationType { fields { name } } } }`, {});
            const names = intro?.__schema?.mutationType?.fields?.map(f => f.name) || [];
            const dealRelated = names.filter(n => /deal|fulfill|complete|mark/i.test(n));
            console.log('🛰 Playerok мутации (deal-related):', dealRelated.length ? dealRelated : names.slice(0, 20));
        } catch (_) { }
    }
    return { error: 'API markFulfilled недоступен. Отметь заказ вручную на Playerok.' };
}

function waitDealTabLoaded(tabId, maxMs = 20000) {
    return new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            try { chrome.tabs.onUpdated.removeListener(onUpd); } catch (_) { }
            clearTimeout(tmax);
            resolve();
        };
        const tmax = setTimeout(finish, maxMs);
        const onUpd = (id, info) => {
            if (id === tabId && info.status === 'complete') setTimeout(finish, 2200);
        };
        chrome.tabs.onUpdated.addListener(onUpd);
        chrome.tabs.get(tabId, (tab) => {
            if (chrome.runtime.lastError) return;
            if (tab?.status === 'complete') setTimeout(finish, 900);
        });
    });
}

/**
 * Нажатие «Я выполнил» на странице сделки.
 * Сначала ищем уже открытую вкладку /deal/… (как у вас из «Выполните заказ») — в фоне SPA часто не рисует кнопку.
 * Закрываем только вкладку, которую сами открыли в этом вызове (раньше finally гробил любую — из‑за этого «не работает»).
 */
async function domClickFulfilled(orderUrl) {
    const dealId = (orderUrl || '').replace(/\/$/, '').split('/').pop()?.split('?')[0]?.split('#')[0] || '';
    if (!dealId || dealId.length < 10) {
        log('⚠️ domClickFulfilled: неверный URL сделки');
        return false;
    }
    log(`🖱️ Ищу кнопку «Я выполнил» (сделка ${dealId.slice(0, 8)}…)`);

    let workerWinId = fulfillWorkerWindowId;
    if (workerWinId == null) {
        const sw = await chrome.storage.local.get([FULFILL_WORKER_WINDOW_KEY]);
        workerWinId = sw[FULFILL_WORKER_WINDOW_KEY] ?? null;
    }

    let tab = null;
    let createdHere = false;
    try {
        const patterns = ['https://playerok.com/*', 'http://playerok.com/*', 'https://www.playerok.com/*'];
        const all = await chrome.tabs.query({ url: patterns });
        const matching = (all || []).filter(t => (t.url || '').includes(dealId));
        let existing = null;
        if (workerWinId != null) {
            existing = matching.find(t => t.windowId === workerWinId) || null;
            if (!existing && matching.length) {
                log('🖱️ Сделка открыта в другом окне — не переключаю основной браузер, открою во вкладке окна автовыдачи');
            }
        } else {
            existing = matching[0] || null;
        }
        if (existing?.id != null) {
            tab = existing;
            log('🖱️ Есть открытая вкладка с этой сделкой — переключаюсь на неё (без закрытия)');
            await chrome.tabs.update(tab.id, { active: true }).catch(() => { });
            if (tab.windowId != null) {
                await chrome.windows.update(tab.windowId, { focused: true }).catch(() => { });
            }
            await sleep(600);
            const cur = await new Promise(r => chrome.tabs.get(tab.id, (t) => r(chrome.runtime.lastError ? null : t)));
            if (cur?.status !== 'complete') await waitDealTabLoaded(tab.id, 18000);
            await sleep(1200);
        } else {
            const createOpts = { url: orderUrl, active: true };
            if (workerWinId != null) {
                createOpts.windowId = workerWinId;
                log('🖱️ Открываю страницу сделки в окне автовыдачи');
            } else {
                log('🖱️ Вкладки сделки нет — открываю с фокусом (Playerok в фоне не отдаёт кнопку)');
            }
            tab = await new Promise((resolve) => {
                chrome.tabs.create(createOpts, (t) => {
                    if (chrome.runtime.lastError) resolve(null);
                    else resolve(t);
                });
            });
            if (!tab?.id && workerWinId != null) {
                log(`⚠️ Вкладка в окне автовыдачи не создалась (${chrome.runtime.lastError?.message || 'unknown'}) — пробую без windowId`);
                tab = await new Promise((resolve) => {
                    chrome.tabs.create({ url: orderUrl, active: true }, (t) => {
                        if (chrome.runtime.lastError) resolve(null);
                        else resolve(t);
                    });
                });
            }
            if (!tab?.id) {
                log('⚠️ domClickFulfilled: не удалось создать вкладку');
                return false;
            }
            createdHere = true;
            if (tab.windowId != null) {
                await chrome.windows.update(tab.windowId, { focused: true }).catch(() => { });
            }
            await waitDealTabLoaded(tab.id, 22000);
            await sleep(2000);
        }

        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content_greeting.js'] }).catch(() => { });
        await sleep(900);
        let clickRes = await sendToTab(tab.id, { action: 'CLICK_FULFILLED' });
        if (clickRes?.error) {
            log(`⚠️ domClickFulfilled: ${clickRes.error} — пауза и повтор`);
            await sleep(2500);
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content_greeting.js'] }).catch(() => { });
            await sleep(700);
            clickRes = await sendToTab(tab.id, { action: 'CLICK_FULFILLED' });
        }
        if (clickRes?.error) {
            log(`⚠️ domClickFulfilled: ${clickRes.error}`);
            return false;
        }
        await sleep(2000);
        log('✅ «Я выполнил» обработан через DOM');
        return true;
    } catch (e) {
        log(`⚠️ domClickFulfilled: ${e.message}`);
        return false;
    } finally {
        if (createdHere && tab?.id) {
            await sleep(800);
            chrome.tabs.remove(tab.id, () => { });
        }
    }
}

// Скрытое окно SteamPass
let hiddenSteamWindowId = null;

async function createHiddenSteamPassWindow() {
    if (hiddenSteamWindowId) {
        try {
            const win = await chrome.windows.get(hiddenSteamWindowId);
            const tab = win.tabs?.[0];
            if (tab?.id) return tab.id;
        } catch (_) { }
    }
    const win = await chrome.windows.create({
        url: STEAMPASS_URL,
        type: 'popup',
        width: 100,
        height: 100,
        left: 0,
        top: 0,
        focused: false
    });
    hiddenSteamWindowId = win.id;
    const tabId = win.tabs?.[0]?.id;
    log(`📂 SteamPass: скрытое окно создано`);
    return tabId;
}

async function closeHiddenSteamPassWindow() {
    if (hiddenSteamWindowId) {
        try {
            await chrome.windows.remove(hiddenSteamWindowId);
        } catch (_) { }
        hiddenSteamWindowId = null;
        log(`📂 SteamPass: окно закрыто`);
    }
}

// Configure Side Panel
chrome.runtime.onInstalled.addListener(() => {
    try {
        chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true });
    } catch (e) {
        console.warn('[sidePanel] API недоступен в этом браузере:', e?.message);
    }
    // loadProcessedUrls вызывается в bg_boost.js (где функция определена)
});
// Load saved username and userId so all modes work without re-logging in
// (loadProcessedUrls + loadGreetingData перенесены в bg_boost.js)
chrome.storage.local.get(['playerokUsername', 'playerokUserId'], (r) => {
    if (r.playerokUsername) currentPlayerokUsername = r.playerokUsername;
    if (r.playerokUserId) { MY_USER_ID = r.playerokUserId; currentUserId = r.playerokUserId; }
});
