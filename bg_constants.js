// ==========================================
// bg_constants.js
// Загружается первым через importScripts() в background.js.
// Только константы и чистые утилиты — без мутаций стейта расширения.
// ==========================================

// ==========================================
// CONFIGURATION
// ==========================================
const CONCURRENT_LIMIT = 3;
const BATCH_LIMIT_BIG = 999;
const SLEEP_DURATION_SECONDS = 30;
const TIMEOUT_MS = 60000;
const WATCHDOG_TIMEOUT = 120000;
const HOME_URL_FALLBACK = 'https://playerok.com';
const SALES_URL_FALLBACK = 'https://playerok.com/my/sales';

// Dynamic URL — строится только если username уже известен
function getHomeUrl() { return currentPlayerokUsername ? `https://playerok.com/profile/${currentPlayerokUsername}/products/completed` : HOME_URL_FALLBACK; }
function getSalesUrl() { return currentPlayerokUsername ? `https://playerok.com/profile/${currentPlayerokUsername}/sales` : SALES_URL_FALLBACK; }

// ==========================================
// URL PREDICATES — чистые функции, без chrome.* API
// ==========================================
function isExtensionOrEmptyTabUrl(url) {
    if (!url) return true;
    if (url.startsWith('chrome-extension://') || url.startsWith('moz-extension://')) return true;
    if (url === 'chrome://newtab/' || url === 'about:blank') return true;
    return false;
}

/** Служебные страницы Playerok (404 и т.д.) — нельзя брать как «рабочую» вкладку сканера. */
function isPlayerokErrorPageUrl(url) {
    if (!url || !url.includes('playerok.com')) return false;
    try {
        const path = new URL(url.split('#')[0]).pathname;
        return path === '/404' || path === '/403' || path === '/500' || /^\/error(\/|$)/i.test(path);
    } catch (_) {
        return /playerok\.com\/404(\/|$|\?|#)/.test(url);
    }
}

function isUsablePlayerokScannerUrl(url) {
    return url.includes('playerok.com') && !isExtensionOrEmptyTabUrl(url) && !isPlayerokErrorPageUrl(url);
}

// ==========================================
// STORAGE KEYS
// ==========================================
const SP_TOKEN_STORAGE_KEY = 'steamPassBearerToken';
const BOOST_WORKER_WINDOW_KEY = 'boostWorkerWindowId';
const FULFILL_WORKER_WINDOW_KEY = 'fulfillWorkerWindowId';
const PUBLISHER_WORKER_WINDOW_KEY = 'publisherWorkerWindowId';

// ==========================================
// STEAMPASS & FULFILL CONSTANTS
// ==========================================
const STEAMPASS_URL = 'https://steampass.gg';
const FULFILL_CONCURRENT = 3;       // макс. заказов в работе; активных (не WAITING_2FA) — только 1
const FULFILL_2FA_TIMEOUT_MS = 600000; // 10 мин — зависание в WAITING_2FA
const FULFILL_DAILY_LIMIT = 24;
const HEARTBEAT_INTERVAL_MS = 7000;
const ORDER_STALE_MS = 300000;      // 5 мин — протухание статуса
const CHECK_ORDERS_INTERVAL = 5000; // fallback
const CHECK_CHAT_INTERVAL = 3000;   // 3 сек — опрос чата

/** Случайная пауза (мс) из полей «Задержка (сек)» окна автоподъёма. */
async function getScanDelayMs() {
    const r = await new Promise(res => chrome.storage.local.get(['minDelay', 'maxDelay'], res));
    const min = Math.max(2, parseInt(r.minDelay, 10) || 3);
    const max = Math.max(min, parseInt(r.maxDelay, 10) || 6);
    return Math.floor(Math.random() * (max - min + 1) + min) * 1000;
}

/** Случайная пауза (мс) из полей «Задержка (сек)» окна автопубликации. */
async function getPublisherPanelDelayMs() {
    const r = await new Promise(res => chrome.storage.local.get(['minDelay', 'maxDelay'], res));
    const min = Math.max(2, parseInt(r.minDelay, 10) || 7);
    const max = Math.max(min, parseInt(r.maxDelay, 10) || 12);
    return random(min, max) * 1000;
}

// ==========================================
// ORDER STATE MACHINE STATUSES
// ==========================================
const ORDER_STATUS = {
    NEW: 'NEW',
    GETTING_DATA: 'GETTING_DATA',
    DATA_READY: 'DATA_READY',
    GETTING_CREDENTIALS: 'GETTING_CREDENTIALS',
    SENDING_GREETING: 'SENDING_GREETING',
    WAITING_2FA: 'WAITING_2FA',
    GETTING_2FA: 'GETTING_2FA',
    COMPLETED: 'COMPLETED',
    ERROR: 'ERROR'
};

// ==========================================
// TIMING & BEHAVIOUR CONSTANTS
// ==========================================
/** Повторно не брать тот же лот в очередь, пока не прошёл cooldown. */
const PROCESSED_LISTING_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const GREETING_RELOAD_COOLDOWN = 60000;
const SHADOW_MONITOR_INTERVAL_MS = 20000; // 2FA мониторинг каждые 20 сек (было 8 — слишком часто для SteamPass)
/** 1 раз в час — достаточно для сессии SteamPass, не палит бот (было 5 мин → 288/день → бан). */
const STEAMPASS_KEEPALIVE_MS = 60 * 60 * 1000;

const isOrderMode = (m) => m === 'AUTO_FULFILL';
const USE_API_MODE = true; // API для Playerok + скрытое окно SteamPass

// ==========================================
// MEMORY GUARD
// ==========================================
/**
 * Добавить в Set с автоочисткой при превышении лимита.
 * Бесконечный рост processedDeals/greetedUsers/processedOrders на сервере с 6 ГБ ОЗУ
 * приводил к краш-сборщику Chrome и выгрузке расширения.
 */
function cappedSetAdd(set, value, maxSize = 2000) {
    if (set.size >= maxSize) {
        const toDelete = Math.ceil(maxSize * 0.2);
        // Collect keys first to avoid modifying the Set during iteration
        const keys = [];
        for (const entry of set) {
            keys.push(entry);
            if (keys.length >= toDelete) break;
        }
        keys.forEach(entry => set.delete(entry));
    }
    set.add(value);
}

// ==========================================
// SLEEP / WAKE UTILITIES
// ==========================================
/** activeSleeps живёт здесь; cancelSleeps() сбрасывает все активные паузы (например, при STOP). */
let activeSleeps = [];

const sleep = ms => new Promise(r => {
    const t = setTimeout(() => { r(); activeSleeps = activeSleeps.filter(x => x.r !== r); }, ms);
    activeSleeps.push({ r, t });
});

function cancelSleeps() {
    activeSleeps.forEach(x => { clearTimeout(x.t); x.r(); });
    activeSleeps = [];
}

// ==========================================
// GRAPHQL QUERY/MUTATION CONSTANTS
// ==========================================
/** Получить item (id, rawPrice, obtainingType.id) по slug — используется в автопубликации. */
const QUERY_ITEM_BY_SLUG = `query item($slug: String!) { item(slug: $slug) { id rawPrice ... on MyItem { obtainingType { id } } } }`;

// ==========================================
// MATH UTILITIES
// ==========================================
/** Jitter: рандомизация задержек (±20%) чтобы не палиться фиксированными интервалами. */
const jitter = (baseMs) => Math.floor(baseMs * (0.8 + Math.random() * 0.4));

function random(min, max) { return Math.floor(Math.random() * (max - min + 1) + min); }
