// ==========================================
// bg_fulfill.js
// Загружается пятым (после bg_dashboard.js).
// Содержит:
//   • FULFILL STORE — getStore/setStore/getOrder/updateOrder/addOrderToQueue
//   • HELPERS — focusTab, sendToTab, log/appendLog, getBoostScanTabId
//   • AUTO-FULFILL main loop — initializeGreetingRun, triggerOrderScan, processNextOrder
//   • FULFILL DISPATCHER (Heartbeat) — fulfillHeartbeat
// Доступ к глобальному стейту background.js через общий скоуп importScripts.
// ==========================================
// ==========================================
// FULFILL STORE (State Machine)
// ==========================================
const STORE_KEY = 'fulfillStore';

async function getStore() {
    return new Promise((r) => chrome.storage.local.get([STORE_KEY], (o) => r(o[STORE_KEY] || {})));
}

// Mutex через очередь — не promise chain, чтобы не удерживать замыкания прошлых вызовов
let _storeMutexRunning = false;
const _storeMutexQueue = [];

function _drainStoreMutex() {
    if (_storeMutexRunning) return;
    _storeMutexRunning = true;
    (async () => {
        while (_storeMutexQueue.length > 0) {
            const { partial, resolve, reject } = _storeMutexQueue.shift();
            try {
                const cur = await getStore();
                await new Promise((r) => chrome.storage.local.set({ [STORE_KEY]: { ...cur, ...partial } }, r));
                resolve();
            } catch (e) {
                reject(e);
            }
        }
        _storeMutexRunning = false;
    })();
}

function setStore(partial) {
    return new Promise((resolve, reject) => {
        _storeMutexQueue.push({ partial, resolve, reject });
        _drainStoreMutex();
    });
}

async function getOrder(orderUrl) {
    const s = await getStore();
    return s.orders?.[orderUrl] || null;
}

async function updateOrder(orderUrl, updates) {
    const s = await getStore();
    const orders = { ...(s.orders || {}) };
    const o = orders[orderUrl] || {};
    orders[orderUrl] = { ...o, ...updates, statusUpdatedAt: Date.now() };
    await setStore({ orders });
}

async function removeOrder(orderUrl) {
    const s = await getStore();
    const ord = s.orders?.[orderUrl];
    if (ord?.chatId) {
        await chrome.storage.local.remove([`${SP_ORDER_PREFIX}${ord.chatId}`, `${SP_ID_PREFIX}${ord.chatId}`]);
    }
    if (ord?.orderId) processingOrders.delete(ord.orderId);
    const orders = { ...(s.orders || {}) };
    delete orders[orderUrl];
    const queue = (s.queue || []).filter((u) => u !== orderUrl);
    await setStore({ orders, queue });
}

async function addOrderToQueue(orderUrl) {
    const s = await getStore();
    const queue = [...(s.queue || [])];
    if (queue.includes(orderUrl)) return;
    queue.push(orderUrl);
    const orders = { ...(s.orders || {}) };
    if (!orders[orderUrl]) {
        orders[orderUrl] = {
            orderUrl,
            status: ORDER_STATUS.NEW,
            tabIds: {},
            steamPassUrl: STEAMPASS_URL,
            createdAt: Date.now(),
            statusUpdatedAt: Date.now()
        };
    }
    await setStore({ queue, orders });
}

async function shiftQueue() {
    const s = await getStore();
    const queue = [...(s.queue || [])];
    if (queue.length === 0) return null;
    const orderUrl = queue.shift();
    await setStore({ queue });
    return orderUrl;
}

const ACTIVE_PHASES = [ORDER_STATUS.GETTING_DATA, ORDER_STATUS.DATA_READY, ORDER_STATUS.GETTING_CREDENTIALS, ORDER_STATUS.SENDING_GREETING];

async function getActiveOrderCount() {
    const s = await getStore();
    const orders = s.orders || {};
    return Object.values(orders).filter(o => ACTIVE_PHASES.includes(o.status)).length;
}

async function getTotalOrderCount() {
    const s = await getStore();
    const orders = s.orders || {};
    return Object.values(orders).filter(o => o.status !== ORDER_STATUS.COMPLETED && o.status !== ORDER_STATUS.ERROR && o.status !== ORDER_STATUS.NEW).length;
}

/** today — учёт для лимита (бот + ручная добавка за сегодня); botCount — только автовыдача. */
async function getFulfillCount() {
    const cal = new Date().toISOString().slice(0, 10);
    const s = await getStore();
    const top = await new Promise((r) => chrome.storage.local.get([
        'fulfillmentsToday', 'lastFulfillDate', 'fulfillManualOffset', 'fulfillManualOffsetDate'
    ], r));
    const storeCount = (s.lastFulfillDate === cal) ? (s.fulfillmentsToday || 0) : 0;
    const topCount = (top.lastFulfillDate === cal) ? (top.fulfillmentsToday || 0) : 0;
    const bot = Math.max(storeCount, topCount);
    const synced =
        (s.lastFulfillDate === cal && (s.fulfillmentsToday || 0) === bot) &&
        (top.lastFulfillDate === cal && (top.fulfillmentsToday || 0) === bot);
    if (bot > 0 && !synced) await setFulfillCount(bot, cal);
    const manual = (top.fulfillManualOffsetDate === cal)
        ? Math.max(0, Math.min(FULFILL_DAILY_LIMIT, parseInt(top.fulfillManualOffset, 10) || 0))
        : 0;
    return {
        today: Math.min(FULFILL_DAILY_LIMIT, bot + manual),
        date: cal,
        botCount: bot,
        manualOffset: manual
    };
}

async function setFulfillCount(count, dateStr) {
    await setStore({ fulfillmentsToday: count, lastFulfillDate: dateStr });
    chrome.storage.local.set({ fulfillmentsToday: count, lastFulfillDate: dateStr });
}

/** Один раз при выдаче логина/пароля клиенту (расход лимита SteamPass), а не при закрытии заказа после 2FA. */
async function bumpFulfilledToday() {
    const cal = new Date().toISOString().slice(0, 10);
    const c = await getFulfillCount();
    if (c.botCount + (c.manualOffset || 0) >= FULFILL_DAILY_LIMIT) return;
    const nextBot = (c.date === cal) ? (c.botCount + 1) : 1;
    await setFulfillCount(nextBot, cal);
}

// ==========================================
// HELPERS
// ==========================================
async function focusTab(tabId) {
    await new Promise((r) => chrome.tabs.update(tabId, { active: true }, () => r()));
    const tab = await new Promise((r) => chrome.tabs.get(tabId, (t) => r(chrome.runtime.lastError ? null : t)));
    if (!tab) return;
    if (tab.windowId) await new Promise((r) => chrome.windows.update(tab.windowId, { focused: true, state: 'normal' }, () => r()));
}


async function log(msg) {
    const timestamp = new Date().toLocaleTimeString();
    pendingLogs.push(`[${timestamp}] ${msg}`);

    if (isLogWriting) return;
    isLogWriting = true;

    try {
        while (pendingLogs.length > 0) {
            const batch = [...pendingLogs];
            pendingLogs = [];

            const result = await new Promise(r => chrome.storage.local.get(['logs'], r));
            let logs = result.logs || [];
            logs.push(...batch);
            if (logs.length > 50) logs = logs.slice(-50);
            await new Promise(r => chrome.storage.local.set({ logs }, r));
        }
    } finally {
        isLogWriting = false;
    }
}

function sendToTab(tabId, msg) {
    return new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, msg, (res) => {
            if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
            else resolve(res || {});
        });
    });
}

function sendToSteamPass(tabId, msg) {
    return sendToTab(tabId, msg);
}

// --- SteamPass HTTP API (через вкладку steampass.gg) ---
async function getSteamPassTab() {
    const tabs = await chrome.tabs.query({ url: '*://*.steampass.gg/*' });
    return tabs[0] || null;
}

async function callSteamPass(url, method = 'GET', body = null) {
    // === CIRCUIT BREAKER CHECK ===
    if (!isSteamPassAvailable()) {
        const waitMin = Math.ceil((spCircuitUntil - Date.now()) / 60000);
        throw new Error(`SteamPass на паузе (ещё ~${waitMin} мин)`);
    }

    const tab = await getSteamPassTab();
    if (!tab) {
        log('🛑 Ошибка: Вкладка SteamPass не открыта!');
        throw new Error('🛑 Ошибка: Вкладка SteamPass не открыта!');
    }

    // Инжектим скрипт только один раз, не каждый вызов
    if (!steamPassInjected) {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content_steampass.js'] }).catch(() => { });
        await sleep(jitter(500));
        steamPassInjected = true;
    }

    log('🌉 Запрос проксирован через вкладку SteamPass...');
    const maxRetries = 3; // было 5 — меньше ретраев = меньше нагрузки
    let retry422Count = 0;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const res = await sendToSteamPass(tab.id, { action: 'STEAM_BRIDGE_REQUEST', url, method, body, token: steamPassBearerToken || null });
        const result = res?.result;

        if ((res.error === 'Site Not Ready' || res.error === 'WAITING_FOR_AUTH') && attempt < maxRetries) {
            log(`⏳ Профиль не готов, жду... (попытка ${attempt}/${maxRetries})`);
            await sleep(jitter(4000));
            continue;
        }

        // Проверяем на rate-limit в тексте ошибки
        const errText = String(res.error || res.result?.data?.message || '').toLowerCase();
        if (errText.includes('too many') || errText.includes('rate limit') || errText.includes('слишком много')) {
            openCircuit(5, 'Rate limit (Too Many Attempts)');
            throw new Error('SteamPass: Too Many Attempts — пауза 5 мин');
        }

        if (res.success === false || res.error) {
            // Сбрасываем флаг инжекции — может скрипт не загрузился
            if (res.error === 'Could not establish connection' || res.error?.includes('Receiving end')) {
                steamPassInjected = false;
            }
            console.error('❌ SteamPass запрос не удался:', url, res.status || '?');
            throw new Error(res.error || `HTTP ${res.status || '?'}`);
        }

        const data = res.result?.data ?? res.data;
        if (result && !result.ok) {
            const errMsgForRetry = data?.message || data?.errors?.[0]?.message || '';
            const errLower = errMsgForRetry.toLowerCase();

            // Rate-limit в ответе API
            if (errLower.includes('too many') || errLower.includes('rate limit') || errLower.includes('слишком много')) {
                openCircuit(5, 'Rate limit от API');
                throw new Error('SteamPass: Rate limit — пауза 5 мин');
            }

            const willRetry422 = result.status === 422 && retry422Count < 3 && (
                errLower.includes('новый код') || errLower.includes('что-то пошло') ||
                errLower.includes('сбой системы') || errLower.includes('следующая попытка')
            );
            if (!willRetry422) {
                console.error('❌ SteamPass ответ:', result.status || '?', errMsgForRetry);
            }

            if (result.status === 401 && attempt < maxRetries) {
                // === 401 COUNTER с circuit breaker ===
                const now = Date.now();
                if (now - sp401Window > 60000) { sp401Count = 0; sp401Window = now; }
                sp401Count++;

                if (sp401Count >= 3) {
                    openCircuit(10, 'Слишком много 401 (токен не обновляется)');
                    throw new Error('SteamPass: 3x 401 подряд — пауза 10 мин');
                }

                log(`🔄 401: Обновляю токен... (${sp401Count}/3 до паузы)`);
                steamPassBearerToken = null;
                const tokRes = await sendToSteamPass(tab.id, { action: 'GET_TOKEN' });
                if (tokRes?.token) {
                    steamPassBearerToken = tokRes.token;
                    chrome.storage.local.set({ [SP_TOKEN_STORAGE_KEY]: tokRes.token });
                }
                await sleep(jitter(3000));
                continue;
            }
            if (result.status === 422) {
                const errMsg = data?.message || data?.errors?.[0]?.message || '';
                const msg = String(errMsg).toLowerCase();
                if (msg.includes('запросите новый код') || msg.includes('новый код') || msg.includes('что-то пошло') ||
                    msg.includes('сбой системы') || msg.includes('следующая попытка') || msg.includes('too many') || msg.includes('попробуйте позже')) {
                    if (retry422Count >= 2) {
                        openCircuit(5, 'Частые ошибки 422 (Rate Limit / Сбой)');
                        throw new Error('SteamPass: 3x 422 подряд — пауза 5 мин');
                    }
                    retry422Count++;
                    const delay = retry422Count === 1 ? 5000 : 10000;
                    log(`🔄 422: Повтор через ${Math.round(delay / 1000)} сек... (${retry422Count}/3)`);
                    await sleep(jitter(delay));
                    continue;
                }
            }
            console.error('❌ SteamPass финальная ошибка:', result.status || '?');
            throw new Error(data?.message || data?.error || `HTTP ${result.status}`);
        }

        // Успех! Сбрасываем счётчик 401
        sp401Count = 0;
        if (data?.error) throw new Error(data.error);
        return { ok: true, status: res.status, data, text: res.text };
    }
}

const SP_ORDER_PREFIX = 'order_chat_';
const SP_ID_PREFIX = 'sp_id_';
const SP_2FA_LIMIT = 24;
const SP_2FA_WINDOW_MS = 24 * 60 * 60 * 1000;
const SP_2FA_PROGRESSIVE_CD = [
    0,          // 1-й запрос — сразу
    2 * 60000,  // 2-й запрос — защита (2 мин)
    5 * 60000,  // 3-й — 5 мин
    15 * 60000, // 4-й — 15 мин
    60 * 60000, // 5-й и далее — 1 час
];

async function checkGlobalLimit(uuid) {
    const key = `limit_history_${uuid}`;
    const raw = await new Promise(r => chrome.storage.local.get(key, o => r(o)));
    const arr = raw[key] || [];
    const now = Date.now();
    const cutoff = now - SP_2FA_WINDOW_MS;
    const recent = arr.filter(ts => ts > cutoff);
    return recent.length < SP_2FA_LIMIT;
}

async function checkUserCooldown(chatId) {
    const key = `cooldown_${chatId}`;
    const raw = await new Promise(r => chrome.storage.local.get(key, o => r(o)));
    const rec = raw[key] || { last: 0, count: 0 };

    const count = rec.count || 0;
    const last = rec.last || 0;

    // Сбрасываем счётчик если прошло более 24ч
    if (last && (Date.now() - last) > SP_2FA_WINDOW_MS) {
        return true; // счётчик протух — разрешаем
    }

    const cdIndex = Math.min(count, SP_2FA_PROGRESSIVE_CD.length - 1);
    const cdMs = SP_2FA_PROGRESSIVE_CD[cdIndex];

    if (cdMs === 0) return true;
    return (Date.now() - last) >= cdMs;
}

async function registerRequestSuccess(uuid, chatId) {
    const now = Date.now();
    const histKey = `limit_history_${uuid}`;
    const cooldKey = `cooldown_${chatId}`;
    const raw = await new Promise(r => chrome.storage.local.get([histKey, cooldKey], o => r(o)));

    const arr = (raw[histKey] || []).concat(now);
    const prevRec = raw[cooldKey] || { last: 0, count: 0 };

    // Сбрасываем счётчик если прошло >24ч
    const newCount = (prevRec.last && (now - prevRec.last) > SP_2FA_WINDOW_MS)
        ? 1
        : (prevRec.count || 0) + 1;

    const cdIndex = Math.min(newCount, SP_2FA_PROGRESSIVE_CD.length - 1);
    const nextCdMs = SP_2FA_PROGRESSIVE_CD[cdIndex];
    const cdLabel = nextCdMs === 0 ? 'без КД'
        : nextCdMs < 60000 ? `${nextCdMs / 1000} сек`
            : `${nextCdMs / 60000} мин`;

    console.log(`📊 [${chatId}] 2FA запросов: ${newCount}. Следующий КД: ${cdLabel}`);
    await chrome.storage.local.set({
        [histKey]: arr,
        [cooldKey]: { last: now, count: newCount }
    });
}

// ============================================================================
//  STATE MACHINE + ОЧЕРЕДЬ ВЫДАЧИ 2FA
// ============================================================================
// Состояния (chat_2fa_state_${chatId} = { name, enteredAt, ...meta }):
//   NEW_WAITING_FIRST_CODE — выслан greeting, ждём 1-й «код» (окно 5 мин).
//                             В этом окне код выдаётся МГНОВЕННО (мимо всех таймеров).
//   GRACE_12H              — 5-мин окно истекло, действует 12-часовая льгота:
//                             1 моментальный код + 1 cred-refresh, мимо всех таймеров.
//   OLD_IDLE               — после первой выдачи / истечения 12ч. Все запросы → очередь.
//   OLD_IN_QUEUE           — стоит в очереди (не подошла); расход на спам — отвечаем «вы #N».
//   OLD_IN_SLOT            — бот пригласил «запросите код, у вас 2 мин»; ждём ответа.
//
// Очередь старых (old_buyers_queue) — массив { chatId, addedAt }.
// Глобальный CD — GLOBAL_2FA_MIN_INTERVAL_MS (5 мин) между разными слотами.
// Tick worker — вызывается из bg_dashboard runShadowMonitor.

const STATE_NEW       = 'NEW_WAITING_FIRST_CODE';
const STATE_GRACE     = 'GRACE_12H';
const STATE_IDLE      = 'OLD_IDLE';
const STATE_IN_QUEUE  = 'OLD_IN_QUEUE';
const STATE_IN_SLOT   = 'OLD_IN_SLOT';

const NEW_WAIT_MS     = 5 * 60 * 1000;     // окно «первого кода» свежей покупки
const GRACE_12H_MS    = 12 * 60 * 60 * 1000;
const SLOT_DURATION_MS = 2 * 60 * 1000;    // 2 мин на ответ в слоте старого покупателя
const SPAM_REPLY_COOLDOWN_MS = 30 * 1000;  // не флудим «вы уже в очереди» чаще раза в 30с
const QUEUE_KEY = 'old_buyers_queue';

function _stateKey(chatId) { return `chat_2fa_state_${chatId}`; }

async function getChatState(chatId) {
    if (!chatId) return null;
    const data = await new Promise(r => chrome.storage.local.get([_stateKey(chatId)], r));
    return data[_stateKey(chatId)] || null;
}

async function setChatState(chatId, name, extra = {}) {
    if (!chatId) return;
    const rec = { name, enteredAt: Date.now(), ...extra };
    await new Promise(r => chrome.storage.local.set({ [_stateKey(chatId)]: rec }, r));
    log(`🧭 [${chatId}] state → ${name}`);
}

async function clearChatState(chatId) {
    if (!chatId) return;
    await new Promise(r => chrome.storage.local.remove([_stateKey(chatId)], r));
}

/** Помечает чат как NEW (только что отправили данные / приветствие) — вызывать сразу после успешного greeting. */
async function markChatGreeted(chatId) {
    if (!chatId) return;
    const cur = await getChatState(chatId);
    // не перетираем GRACE/IDLE если повторно зашли в greeting
    if (cur && cur.name !== STATE_NEW) return;
    await setChatState(chatId, STATE_NEW);
}

// ---------- Очередь ----------
async function _readQueue() {
    const data = await new Promise(r => chrome.storage.local.get([QUEUE_KEY], r));
    return Array.isArray(data[QUEUE_KEY]) ? data[QUEUE_KEY] : [];
}
async function _writeQueue(q) {
    await new Promise(r => chrome.storage.local.set({ [QUEUE_KEY]: q }, r));
}

async function enqueueOldBuyer(chatId) {
    const q = await _readQueue();
    if (q.find(e => e.chatId === chatId)) return q.findIndex(e => e.chatId === chatId) + 1;
    q.push({ chatId, addedAt: Date.now() });
    await _writeQueue(q);
    return q.length;
}

async function dequeueOldBuyer(chatId) {
    const q = await _readQueue();
    const idx = q.findIndex(e => e.chatId === chatId);
    if (idx < 0) return false;
    q.splice(idx, 1);
    await _writeQueue(q);
    return true;
}

async function getQueuePosition(chatId) {
    const q = await _readQueue();
    const idx = q.findIndex(e => e.chatId === chatId);
    return idx < 0 ? 0 : idx + 1;
}

/** ETA до обслуживания чата (мс). pos=1 → ждать остаток глобального CD (или 0). */
async function estimateQueueETA(chatId) {
    const pos = await getQueuePosition(chatId);
    if (pos === 0) return 0;
    const lastGlobal = (typeof getLastGlobal2FATime === 'function') ? await getLastGlobal2FATime() : 0;
    const remainCD = Math.max(0, (lastGlobal + GLOBAL_2FA_MIN_INTERVAL_MS) - Date.now());
    // следующие позиции = (pos-1)*5мин + остаток CD до головы
    return remainCD + Math.max(0, pos - 1) * GLOBAL_2FA_MIN_INTERVAL_MS;
}

function _formatMs(ms) {
    if (ms <= 0) return 'сейчас';
    const sec = Math.ceil(ms / 1000);
    if (sec < 60) return `${sec} сек`;
    return `${Math.ceil(sec / 60)} мин`;
}

function cleanGameTitle(rawTitle) {
    if (!rawTitle || typeof rawTitle !== 'string') return '';
    const stopWords = /(?:^|\s)(ОФФЛАЙН|АКТИВАЦИЯ|АВТОВЫДАЧА|ДОСТУП|АККАУНТ|OFFLINE|ACTIVATION|STEAM|KEY|GIFT|RU|GLOBAL|CIS|RU\/CIS)(?=\s|$)/gi;
    let s = rawTitle
        .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2B00}-\u{2BFF}]/gu, '')
        .replace(stopWords, ' ')
        .replace(/[✨🔥⚡️🎮🎲★☆⭐🌟*]/g, '')
        .replace(/\s*\([^)]*\)/g, '')        // strip closed parens: "(Steam Edition)", "(Pre-Order)", etc.
        .replace(/\s*\([^)]*$/, '')           // strip unclosed trailing paren: "Game ("
        .replace(/\s+/g, ' ')
        .trim();
    const cropPatterns = [/\s+-\s+/, /\s+\u2013\s+/, /\s*:\s*/];
    for (const sep of cropPatterns) {
        const idx = s.search(sep);
        if (idx > 0) s = s.slice(0, idx);
    }
    return s.trim().slice(0, 60);
}

function extractDistinctiveWords(fullName) {
    if (!fullName || typeof fullName !== 'string') return [];
    const s = String(fullName).trim();
    const parts = s.split(/\s+[-–—]\s+|\s*:\s*/);
    const words = new Set();
    for (const p of parts) {
        for (const w of p.split(/\s+/)) {
            const t = w.replace(/[^\w\u0400-\u04FF]/g, '').toLowerCase();
            if (t.length >= 4) words.add(t);
        }
    }
    return [...words];
}

function pickProductFromItems(items, searchQuery, fullGameName = '') {
    if (!items?.length) return null;
    const distinctive = extractDistinctiveWords(fullGameName || searchQuery);
    const titleWords = (searchQuery || '').toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
    const allWords = [...new Set([...distinctive, ...titleWords])];
    const score = (item) => {
        const name = (item.name ?? item.title ?? item.productName ?? '').toLowerCase();
        if (!name) return 0;
        let s = 0;
        for (const w of allWords) {
            if (name.includes(w)) s += w.length * (distinctive.includes(w) ? 3 : 1);
            if (name.startsWith(w)) s += 2;
        }
        return s;
    };
    const scored = items.map((item) => ({ item, s: score(item) }));
    const best = scored.sort((a, b) => b.s - a.s)[0];
    return best?.s > 0 ? best.item : items[0];
}

async function spFindProductOnly(gameName) {
    if (!isSteamPassAvailable()) return null;

    const searchTerm = cleanGameTitle(gameName) || 'game';
    const filterUrl = 'https://steampass.gg/api/product/filter';
    try {
        const res = await callSteamPass(filterUrl, 'POST', { name: searchTerm });
        const data = res?.data?.data ?? res?.data;
        const items = Array.isArray(data) ? data : data?.items ?? data?.products ?? data?.results ?? data?.data ?? [];
        if (!items?.length) return null;
        
        const chosen = pickProductFromItems(items, searchTerm, gameName);
        const first = items[0];
        let productId = chosen?.uuid ?? chosen?.id ?? chosen?.productId ?? chosen?.product_id;
        if (!productId && chosen) productId = (chosen.href?.match(/[a-f0-9-]{36}/i) || [])[0] ?? (chosen.url?.match(/[a-f0-9-]{36}/i) || [])[0];
        if (!productId && first) productId = first?.uuid ?? first?.id ?? first?.productId ?? first?.product_id ?? (first.href?.match(/[a-f0-9-]{36}/i) || [])[0] ?? (first.url?.match(/[a-f0-9-]{36}/i) || [])[0];
        
        return productId ? String(productId) : null;
    } catch (e) {
        return null;
    }
}

async function spFindAndBuy(gameName, chatId) {
    if (!isSteamPassAvailable()) {
        console.log(`❌ [SteamPass] Поиск отменен, circuit breaker открыт`);
        throw new Error('SteamPass временно недоступен (пауза)');
    }

    const searchTerm = cleanGameTitle(gameName) || 'game';
    const filterUrl = 'https://steampass.gg/api/product/filter';
    let productId = null;
    try {
        const res = await callSteamPass(filterUrl, 'POST', { name: searchTerm });
        console.log('📦 SteamPass RAW Response:', JSON.stringify(res, null, 2));
        const data = res?.data?.data ?? res?.data;
        const items = Array.isArray(data) ? data : data?.items ?? data?.products ?? data?.results ?? data?.data ?? [];
        if (!items?.length) {
            const rawDump = JSON.stringify(res?.data ?? res).slice(0, 200);
            log(`❌ SteamPass filter пустой. Сырой ответ: ${rawDump}`);
            throw new Error(`Игра не найдена: ${searchTerm}`);
        }
        const chosen = pickProductFromItems(items, searchTerm, gameName);
        const first = items[0];
        productId = chosen?.uuid ?? chosen?.id ?? chosen?.productId ?? chosen?.product_id;
        if (!productId && chosen) productId = (chosen.href?.match(/[a-f0-9-]{36}/i) || [])[0] ?? (chosen.url?.match(/[a-f0-9-]{36}/i) || [])[0];
        if (!productId && first) productId = first?.uuid ?? first?.id ?? first?.productId ?? first?.product_id ?? (first.href?.match(/[a-f0-9-]{36}/i) || [])[0] ?? (first.url?.match(/[a-f0-9-]{36}/i) || [])[0];
    } catch (e) {
        if (e.message?.includes('Игра не найдена')) throw e;
        log(`❌ SteamPass внутренняя ошибка при поиске "${searchTerm}": ${e.message}`);
        console.error(`❌ Поиск SteamPass для "${searchTerm}":`, e);
        throw new Error(`Игра не найдена: ${searchTerm} [${e.message}]`);
    }
    if (!productId) throw new Error(`Игра не найдена: ${searchTerm}`);

    const productIdStr = String(productId);
    await chrome.storage.local.set({ [`${SP_ID_PREFIX}${chatId}`]: { productId: productIdStr, game: gameName } });
    await chrome.storage.local.set({ [`${SP_ORDER_PREFIX}${chatId}`]: { productId: productIdStr, game: gameName } });
    await chrome.storage.local.set({ ['sp_uuid_' + chatId]: productIdStr });

    console.log('⏳ Жду прогрузки профиля SteamPass...');
    // Быстрая, но рандомизированная задержка
    await sleep(jitter(2500));

    const credUrl = `https://steampass.gg/api/profile/product-credentials/${productId}?account_platform=1`;
    console.log('🎯 Использую Spy URL:', credUrl);
    console.log('🔑 Запрашиваю пароль для UUID:', productId);
    const maxCredRetries = 3;
    let lastCredRes = null;
    let lastError = null;
    for (let attempt = 1; attempt <= maxCredRetries; attempt++) {
        try {
            const credRes = await callSteamPass(credUrl, 'GET');
            lastCredRes = credRes;
            const responseData = credRes?.result?.data ?? credRes?.data;
            console.log('📦 CREDENTIALS RAW JSON:', JSON.stringify(responseData, null, 2));

            let accountContainer = responseData?.data ?? responseData;
            let credentials = accountContainer;

            if (accountContainer?.steam) credentials = accountContainer.steam;
            else if (accountContainer?.uplay) credentials = accountContainer.uplay;
            else if (accountContainer?.origin) credentials = accountContainer.origin;
            else if (accountContainer?.rockstar) credentials = accountContainer.rockstar;
            else if (accountContainer?.microsoft) credentials = accountContainer.microsoft;
            else if (accountContainer?.account) credentials = accountContainer.account;
            else if (accountContainer && typeof accountContainer === 'object') {
                const sub = Object.values(accountContainer).find(v => v && typeof v === 'object' && (v.login || v.username || v.password || v.pass));
                if (sub) credentials = sub;
            }

            const login = credentials?.login ?? credentials?.username ?? credentials?.email ?? credentials?.login_username ?? '';
            const password = credentials?.password ?? credentials?.pass ?? credentials?.login_password ?? '';

            if (login && password) {
                console.log(`🎉 УСПЕХ! Данные найдены: ${login}:${password.substring(0, 3)}***`);
                log('🔑 УСПЕХ! Логин и пароль получены через Bridge.');
                await chrome.storage.local.set({ ['sp_uuid_' + chatId]: productIdStr });
                await chrome.storage.local.set({ ['order_' + chatId]: { uuid: productIdStr, date: Date.now() } });
                // Сохраняем выданные данные для последующей сверки при 2FA-запросах
                await chrome.storage.local.set({ [`issued_creds_${chatId}`]: { login, password, uuid: productIdStr, issuedAt: Date.now() } });
                // Anti-detect: только что fetched creds — следующий 2FA не должен делать прогрев
                await chrome.storage.local.set({ [`sp_last_warmup_${productIdStr}`]: Date.now() });
                console.log('💾 Заказ сохранен в память для', chatId);
                await registerChatForMonitor(chatId);
                return { login, password, productId: productIdStr };
            }
            console.error('❌ Не нашел поля login/password в объекте:', JSON.stringify(credentials));
            console.error(`❌ URL: ${credUrl}`);
            console.error(`❌ Код ответа: ${credRes?.status || '?'}`);
            if (attempt < maxCredRetries) {
                log(`⏳ Пустой ответ, жду... (попытка ${attempt}/${maxCredRetries})`);
                await sleep(jitter(3000));
            }
        } catch (e) {
            lastError = e;
            console.error(`❌ Ошибка получения пароля (попытка ${attempt}):`, e.message);
            // Если слишком много запросов - выходим сразу, не ретраим
            if (e.message?.includes('Too Many Attempts') || e.message?.includes('Rate limit')) {
                throw e;
            }
            if (attempt < maxCredRetries) {
                log(`⏳ Ошибка, жду... (попытка ${attempt}/${maxCredRetries})`);
                await sleep(jitter(3000));
                continue;
            }
            throw e;
        }
    }
    const statusInfo = lastCredRes?.status ? ` (HTTP ${lastCredRes.status})` : (lastError ? ` (${lastError.message})` : '');
    throw new Error('Не удалось получить логин/пароль' + statusInfo);
}

let twoFALock = Promise.resolve();
let twoFABusy = false;

/** Парсинг кода из JSON SteamPass (формат ответа менялся — обходим вложенность и типовые поля). */
function extract2FACodeFromSteamPassPayload(payload) {
    const codeLike = (s) => {
        if (s == null) return null;
        const t = String(s).trim();
        if (!t) return null;
        if (/^[A-Z0-9]{5,8}$/i.test(t)) return t;
        const g = t.match(/\b([A-Z0-9]{5,8})\b/i);
        return g ? g[1] : null;
    };
    const seen = new Set();
    function walk(x, depth) {
        if (x == null || depth > 8) return null;
        if (typeof x === 'string') return codeLike(x);
        if (typeof x === 'number' && Number.isFinite(x)) {
            const t = String(Math.trunc(x));
            return /^\d{5,8}$/.test(t) ? t : null;
        }
        if (typeof x !== 'object') return null;
        if (seen.has(x)) return null;
        seen.add(x);

        const directKeys = [
            'code', 'two_factor_code', 'code2fa', 'twoFactorCode', 'email_code', 'emailCode',
            'guard_code', 'guardCode', 'steam_code', 'steamCode', 'auth_code', 'authCode',
            'otp', 'otpCode', 'token', 'twoFactor', 'email_code_value'
        ];
        for (const k of directKeys) {
            if (x[k] == null) continue;
            const got = codeLike(x[k]);
            if (got) return got;
            if (typeof x[k] === 'object') {
                const inner = walk(x[k], depth + 1);
                if (inner) return inner;
            }
        }
        const msg = x.message ?? x.msg ?? x.error_message;
        if (typeof msg === 'string') {
            const got = codeLike(msg);
            if (got) return got;
            const inText = msg.match(/(?:код|code|guard)\s*[:：]?\s*([A-Z0-9]{5,8})\b/i);
            if (inText) return inText[1];
        }
        const nestKeys = ['data', 'result', 'payload', 'credentials', 'response', 'email', 'guard', 'steam'];
        for (const k of nestKeys) {
            if (x[k] != null && typeof x[k] === 'object') {
                const inner = walk(x[k], depth + 1);
                if (inner) return inner;
            }
        }
        for (const [k, v] of Object.entries(x)) {
            if (v == null || typeof v !== 'object') continue;
            if (/^(meta|links|_)/i.test(k)) continue;
            const inner = walk(v, depth + 1);
            if (inner) return inner;
        }
        return null;
    }
    return walk(payload, 0);
}

async function handle2FARequest(chatId, type) {
    if (twoFABusy) console.log(`⏳ [${chatId}] Ожидание очереди 2FA (другой запрос в обработке)...`);
    const prev = twoFALock;
    let release;
    twoFALock = new Promise(r => { release = r; });
    await prev;
    twoFABusy = true;
    try {
        return await doHandle2FARequest(chatId, type);
    } finally {
        twoFABusy = false;
        release();
    }
}

async function doHandle2FARequest(chatId, type) {
    if (!isSteamPassAvailable()) {
        return '2фа код временно не доступен, повторите попытку позже';
    }

    const orderKey = 'order_' + chatId;
    const keys = [orderKey, `${SP_ID_PREFIX}${chatId}`, `${SP_ORDER_PREFIX}${chatId}`, 'sp_uuid_' + chatId];
    const data = await new Promise(r => chrome.storage.local.get(keys, o => r(o)));
    const order = data[orderKey];
    const stored = data[keys[1]] ?? data[keys[2]];
    const uuid = String(order?.uuid ?? stored?.uuid ?? stored?.productId ?? data['sp_uuid_' + chatId] ?? '').trim();

    if (!uuid) {
        console.log(`❌ Нет UUID для чата ${chatId}`);
        return null;
    }

    // Проверка глобального или per-game бана SteamPass
    const banKey = `steampass_ban_${uuid}`;
    const globalBanKey = `steampass_ban_global`;
    const banData = await new Promise(r => chrome.storage.local.get([banKey, globalBanKey], o => r(o)));

    if (banData[banKey] && Date.now() < banData[banKey]) {
        const banTime = new Date(banData[banKey]).toLocaleTimeString('ru-RU');
        return `⚠️ Временно ограничено получение кодов для этой игры из-за спама. Попробуй после ${banTime}.`;
    }

    if (banData[globalBanKey] && Date.now() < banData[globalBanKey]) {
        const banTime = new Date(banData[globalBanKey]).toLocaleTimeString('ru-RU');
        return `⚠️ Твой аккаунт временно ограничен из-за спама. Попробуй после ${banTime}.`;
    }

    log(`🛡 Запрос 2FA для ${chatId} (UUID: ${uuid})...`);

    // Глобальные timer-проверки делает handleBuyer2FATrigger / tickOldBuyerQueue.
    // Здесь оставляем только uuid-уровневую защиту от спама на стороне SteamPass.
    if (!(await checkGlobalLimit(uuid))) return '⚠️ Лимит кодов исчерпан.';


    try {
        // ANTI-DETECT: страничная навигация и прогревочный creds-fetch — большие триггеры
        // для SP («Вы запросили данные N раз»). Делаем их максимум раз в WARMUP_TTL_MS на UUID.
        const WARMUP_TTL_MS = 30 * 60 * 1000; // 30 мин — после этого можно ещё раз «прогреть»
        const warmupKey = `sp_last_warmup_${uuid}`;
        const navKey = `sp_last_nav_${uuid}`;
        const wd = await new Promise(r => chrome.storage.local.get([warmupKey, navKey], r));
        const lastWarmup = wd[warmupKey] || 0;
        const lastNav = wd[navKey] || 0;
        const needWarmup = (Date.now() - lastWarmup) > WARMUP_TTL_MS;
        const needNav = (Date.now() - lastNav) > WARMUP_TTL_MS;

        const tab = await getSteamPassTab();
        if (tab?.id && needNav) {
            const productUrl = `https://steampass.gg/catalog/steam/${uuid}`;
            if (!tab.url?.includes(`/catalog/steam/${uuid}`)) {
                console.log("🔥 Открываю страницу продукта для корректного Referer...");
                await chrome.tabs.update(tab.id, { url: productUrl });
                await sleep(jitter(4000));
                await chrome.storage.local.set({ [navKey]: Date.now() });
            }
        }
        if (needWarmup) {
            console.log("🔥 Прогрев сессии SteamPass перед запросом кода...");
            try {
                await callSteamPass(`https://steampass.gg/api/profile/product-credentials/${uuid}?account_platform=1`, 'GET');
                await chrome.storage.local.set({ [warmupKey]: Date.now() });
            } catch (_) { }
        } else {
            console.log(`⏭ [SP-stealth] Прогрев пропущен — был ${Math.round((Date.now()-lastWarmup)/60000)} мин назад.`);
        }
        // Расширенный jitter: 4-12 сек вместо 3.5±25%. Реальный человек не отвечает за 3 сек.
        await sleep(4000 + Math.floor(Math.random() * 8000));

        const url = `https://steampass.gg/api/email/code/${type}`;
        const maxCodeAttempts = 2; // было 4 — сокращено до 2 чтобы не делать добавочные bulk-запросы к SteamPass
        let codeStr = null;
        for (let att = 0; att < maxCodeAttempts; att++) {
            if (att > 0) {
                log(`🔄 2FA: ещё нет кода — пауза и повтор ${att + 1}/${maxCodeAttempts}...`);
                await sleep(jitter(7000)); // большая пауза перед ретрайем
                // Не делаем повторный product-credentials GET — лишний запрос приводил к блокам SteamPass
            }
            const res = await callSteamPass(url, 'POST', { uuid, account_platform: 1 });
            const resData = res?.data ?? res?.result?.data ?? res;
            let payload = resData;
            if (resData && typeof resData === 'object' && resData.data != null) payload = resData.data;
            codeStr = extract2FACodeFromSteamPassPayload(payload);
            if (!codeStr && resData && typeof resData === 'object') {
                codeStr = extract2FACodeFromSteamPassPayload(resData);
            }
            if (codeStr) break;
            if (att === maxCodeAttempts - 1) {
                const dbg = (() => {
                    try { return JSON.stringify(payload ?? resData)?.slice(0, 420); } catch (_) { return String(payload); }
                })();
                console.warn('[2FA] SteamPass /email/code: код не извлечён, фрагмент ответа:', dbg);
            }
        }

        if (codeStr) {
            await registerRequestSuccess(uuid, chatId);
            await setLastGlobal2FATime();
            log(`✅ Код получен: ${codeStr}`);
            return `🛡 Твой код Steam Guard: ${codeStr}`;
        }
    } catch (e) {
        console.warn(`⚠️ API 2FA не сработал:`, e?.message);

        // SteamPass Anti-Spam Error Detection ("Сделано много спам-запросов... ограничение до 2026-03-05 17:44:22 UTC")
        const errMsg = (e?.message || '').toLowerCase();
        if (errMsg.includes('временное ограничение') || errMsg.includes('спам-запрос')) {
            log(`🛑 SteamPass повесил бан на 2FA для UUID ${uuid}`);
            const timeMatch = (e?.message || '').match(/до\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+UTC/i);

            let banUntilTs = Date.now() + 60 * 60 * 1000; // по умолчанию 1 час, если не распарсили
            if (timeMatch && timeMatch[1]) {
                const strDate = timeMatch[1].replace(' ', 'T') + 'Z';
                const parsedTs = new Date(strDate).getTime();
                if (!isNaN(parsedTs) && parsedTs > Date.now()) {
                    banUntilTs = parsedTs + 60000; // +1 минута для уверенности
                }
            }

            const banKey = `steampass_ban_${uuid}`;
            await chrome.storage.local.set({ [banKey]: banUntilTs });

            const banTimeStr = new Date(banUntilTs).toLocaleTimeString('ru-RU');
            return `⚠️ Получение кодов временно ограничено из-за частых запросов. Защита спадет в ${banTimeStr}.`;
        }
    }

    log('⚠️ 2FA: SteamPass не вернул распознанный код — в чат уйдёт заглушка; см. консоль Service Worker (строка [2FA] SteamPass).');
    return 'Код временно не доступен, повторите попытку позже';
}

async function getSteamPass2FA(chatId) {
    return handle2FARequest(chatId, 'main');
}

// ============================================================================
//  ВНЕШНИЙ ВХОД для триггеров «код / 2fa» из чата
// ============================================================================
// Вызывается из shadowMonitor / order state machine. Отвечает за state-машину
// и очередь. Сам отправляет ответы покупателю через apiSendMessage.
// Возвращает { code: 'sent'|'queued'|'creds_refreshed'|'spam'|'noop'|'error', text? }
async function handleBuyer2FATrigger(chatId, type = 'main') {
    if (!chatId) return { code: 'noop' };
    let st = await getChatState(chatId);

    // Бутстрап: если у чата есть issued_creds, но state не выставлен — считаем его старым.
    if (!st) {
        const data = await new Promise(r => chrome.storage.local.get([`issued_creds_${chatId}`], r));
        if (data[`issued_creds_${chatId}`]?.login) {
            st = { name: STATE_IDLE, enteredAt: Date.now() };
            await setChatState(chatId, STATE_IDLE);
        } else {
            // Нет данных вообще — пусть классическая старая ветка (handleOldBuyerCodeRequest) разбирается.
            return { code: 'noop' };
        }
    }

    // Авто-переходы по таймеру
    if (st.name === STATE_NEW && Date.now() - st.enteredAt > NEW_WAIT_MS) {
        await setChatState(chatId, STATE_GRACE);
        st = await getChatState(chatId);
    }
    if (st.name === STATE_GRACE && Date.now() - st.enteredAt > GRACE_12H_MS) {
        await setChatState(chatId, STATE_IDLE);
        st = await getChatState(chatId);
    }

    // === NEW: первый код — мгновенно, мимо всех таймеров ===
    if (st.name === STATE_NEW) {
        log(`🚀 [${chatId}] NEW → выдача первого кода (без таймеров).`);
        const reply = await handle2FARequest(chatId, type);
        if (reply) await apiSendMessage(chatId, reply);
        if (reply?.startsWith?.('🛡')) {
            await setChatState(chatId, STATE_IDLE);
            return { code: 'sent' };
        }
        return { code: 'error', text: reply };
    }

    // === GRACE: 1 моментальный код или 1 cred-refresh (если креды реально поменялись) ===
    if (st.name === STATE_GRACE) {
        if (st.codeIssued) {
            // Расход уже состоялся → к старой логике
            await setChatState(chatId, STATE_IDLE);
        } else {
            // Сначала пробуем cred-refresh (он внутри сравнит и решит, нужен ли)
            const refreshed = (typeof checkAndNotifyCredentialChange === 'function')
                ? await checkAndNotifyCredentialChange(chatId, await _resolveUuidForChat(chatId)).catch(() => false)
                : false;
            if (refreshed) {
                log(`🔄 [${chatId}] GRACE → отправлены обновлённые данные. Ждём повторный «код».`);
                // Креды обновили — слот кода ещё не израсходован, остаёмся в GRACE
                return { code: 'creds_refreshed' };
            }
            log(`🎁 [${chatId}] GRACE → выдача 1 моментального кода.`);
            const reply = await handle2FARequest(chatId, type);
            if (reply) await apiSendMessage(chatId, reply);
            if (reply?.startsWith?.('🛡')) {
                await setChatState(chatId, STATE_IDLE);
                return { code: 'sent' };
            }
            return { code: 'error', text: reply };
        }
    }

    // === OLD_IDLE: ставим в очередь, пробуем сразу обслужить если можно ===
    if (st.name === STATE_IDLE) {
        const pos = await enqueueOldBuyer(chatId);
        await setChatState(chatId, STATE_IN_QUEUE, { queuedAt: Date.now() });
        log(`📥 [${chatId}] OLD → очередь, позиция #${pos}`);
        const served = await tickOldBuyerQueue();
        if (served?.servedChatId === chatId) return { code: 'sent' };
        // Не обслужен сейчас — отвечаем ETA
        const eta = await estimateQueueETA(chatId);
        await apiSendMessage(chatId, `📋 Вы #${pos} в очереди на выдачу кода. Ориентировочно ~${_formatMs(eta)}. Когда подойдёт ваше время, бот пришлёт уведомление — напишите «код» ещё раз в течение 2 минут.`).catch(() => { });
        return { code: 'queued' };
    }

    // === OLD_IN_QUEUE: спам — отвечаем местом ===
    if (st.name === STATE_IN_QUEUE) {
        const now = Date.now();
        if (st.lastSpamReplyAt && (now - st.lastSpamReplyAt) < SPAM_REPLY_COOLDOWN_MS) {
            return { code: 'spam' }; // молча игнорим
        }
        const pos = await getQueuePosition(chatId);
        if (pos === 0) {
            // вылетел из очереди → начнём заново
            await setChatState(chatId, STATE_IDLE);
            return await handleBuyer2FATrigger(chatId, type);
        }
        const eta = await estimateQueueETA(chatId);
        await apiSendMessage(chatId, `📋 Вы уже #${pos} в очереди. ETA ~${_formatMs(eta)}.`).catch(() => { });
        await setChatState(chatId, STATE_IN_QUEUE, { queuedAt: st.queuedAt, lastSpamReplyAt: now });
        return { code: 'spam' };
    }

    // === OLD_IN_SLOT: бот пригласил, покупатель ответил «код» — обслуживаем ===
    if (st.name === STATE_IN_SLOT) {
        if (st.slotDeadline && Date.now() > st.slotDeadline) {
            // дедлайн истёк, переводим обратно в IDLE
            await dequeueOldBuyer(chatId);
            await setChatState(chatId, STATE_IDLE);
            await apiSendMessage(chatId, `⏱ Слот истёк. Напишите «код» ещё раз чтобы занять место в очереди.`).catch(() => { });
            return { code: 'noop' };
        }
        // Сначала проверяем cred-refresh внутри слота (это и так разовая SP-проверка)
        const refreshed = (typeof checkAndNotifyCredentialChange === 'function')
            ? await checkAndNotifyCredentialChange(chatId, await _resolveUuidForChat(chatId)).catch(() => false)
            : false;
        if (refreshed) {
            log(`🔄 [${chatId}] SLOT → данные изменились, отправлены новые. Покупатель должен снова написать «код».`);
            await dequeueOldBuyer(chatId);
            await setChatState(chatId, STATE_IDLE);
            await setLastGlobal2FATime(); // мы дёрнули SteamPass — соблюдаем 5 мин для следующего
            return { code: 'creds_refreshed' };
        }
        log(`🎯 [${chatId}] SLOT → выдача кода в слоте.`);
        const reply = await handle2FARequest(chatId, type);
        if (reply) await apiSendMessage(chatId, reply);
        if (reply?.startsWith?.('🛡')) {
            await dequeueOldBuyer(chatId);
            await setChatState(chatId, STATE_IDLE);
            return { code: 'sent' };
        }
        // ошибка — оставляем в слоте до дедлайна, покупатель может ещё раз написать
        return { code: 'error', text: reply };
    }

    return { code: 'noop' };
}

async function _resolveUuidForChat(chatId) {
    const data = await new Promise(r => chrome.storage.local.get([
        `order_${chatId}`, `${SP_ID_PREFIX}${chatId}`, `${SP_ORDER_PREFIX}${chatId}`, `sp_uuid_${chatId}`
    ], r));
    return String(data[`order_${chatId}`]?.uuid
        ?? data[`${SP_ID_PREFIX}${chatId}`]?.productId
        ?? data[`${SP_ORDER_PREFIX}${chatId}`]?.productId
        ?? data[`sp_uuid_${chatId}`]
        ?? '').trim() || null;
}

// ============================================================================
//  TICK очереди старых покупателей — вызывается из shadowMonitor
// ============================================================================
let _queueTickBusy = false;
async function tickOldBuyerQueue() {
    if (_queueTickBusy) return null;
    _queueTickBusy = true;
    try {
        // Глобальный 5-мин CD — бот «спит» честно
        const lastGlobal = await getLastGlobal2FATime();
        const remainCD = (lastGlobal + GLOBAL_2FA_MIN_INTERVAL_MS) - Date.now();
        if (remainCD > 0) return null;

        // Не открываем новый слот, если уже есть активный
        const q = await _readQueue();
        if (q.length === 0) return null;
        for (const entry of q) {
            const st = await getChatState(entry.chatId);
            if (st?.name === STATE_IN_SLOT && st.slotDeadline > Date.now()) {
                // Активный слот ещё не истёк — ждём ответа
                return null;
            }
            if (st?.name === STATE_IN_SLOT && st.slotDeadline <= Date.now()) {
                // дедлайн истёк — выкидываем и идём дальше
                await dequeueOldBuyer(entry.chatId);
                await setChatState(entry.chatId, STATE_IDLE);
                log(`⏱ [${entry.chatId}] Слот истёк без ответа — выбрасываем из очереди.`);
                await apiSendMessage(entry.chatId, `⏱ Время слота вышло — вы выбыли из очереди. Напишите «код» чтобы занять место заново.`).catch(() => { });
                continue;
            }
        }

        // Берём голову очереди в IN_QUEUE
        const fresh = await _readQueue();
        const head = fresh.find(async () => true);
        if (!fresh.length) return null;
        const headEntry = fresh[0];
        const headState = await getChatState(headEntry.chatId);
        if (!headState || (headState.name !== STATE_IN_QUEUE && headState.name !== STATE_IDLE)) {
            // голова в неожиданном состоянии — пропускаем
            return null;
        }
        // Открываем слот
        const slotDeadline = Date.now() + SLOT_DURATION_MS;
        await setChatState(headEntry.chatId, STATE_IN_SLOT, { slotDeadline });
        log(`🛎 [${headEntry.chatId}] Очередь → открываю слот на 2 мин.`);
        await apiSendMessage(headEntry.chatId, `🛎 Ваша очередь! Напишите «код» в течение 2 минут чтобы получить 2FA. Если не успеете — нужно будет занять место в очереди заново.`).catch(() => { });
        return { openedSlot: headEntry.chatId };
    } finally {
        _queueTickBusy = false;
    }
}

async function spGet2FACode(chatId) {
    return getSteamPass2FA(chatId);
}

/** Поддержка сессии SteamPass с рандомизированным fingerprint.
 *  Каждый вызов выбирает другой endpoint / параметры — чтобы антифрод не видел одинаковый
 *  «бьющий каждый час» запрос. Работает независимо от состояния бота. */
const _SP_KEEPALIVE_NAMES = ['', ' ', 'a', 'the', 'ru', 'en', 'pro', 'ed', 'go', 'gam', 'cyber', 'red', 'far'];
const _SP_KEEPALIVE_RECIPES = [
    () => {
        const name = _SP_KEEPALIVE_NAMES[Math.floor(Math.random() * _SP_KEEPALIVE_NAMES.length)];
        const page = 1 + Math.floor(Math.random() * 3);
        const per = [1, 3, 5, 10, 20][Math.floor(Math.random() * 5)];
        return { url: `https://steampass.gg/api/product/filter?page=${page}&per_page=${per}`, method: 'POST', body: { name } };
    },
    () => ({ url: 'https://steampass.gg/api/profile', method: 'GET', body: null }),
    () => ({ url: `https://steampass.gg/api/profile/orders?page=1&per_page=${5 + Math.floor(Math.random() * 10)}`, method: 'GET', body: null }),
    () => ({ url: 'https://steampass.gg/api/profile/balance', method: 'GET', body: null }),
];

async function steamPassSessionPing() {
    if (!isSteamPassAvailable()) return;
    try {
        const tab = await getSteamPassTab();
        if (!tab?.id) return;
        const recipe = _SP_KEEPALIVE_RECIPES[Math.floor(Math.random() * _SP_KEEPALIVE_RECIPES.length)]();
        await callSteamPass(recipe.url, recipe.method, recipe.body);
        console.log(`[SteamPass] keepalive OK (${recipe.method} ${recipe.url.split('?')[0].split('/').slice(-2).join('/')})`);
    } catch (e) {
        const m = e?.message || String(e);
        console.warn('[SteamPass keepalive]', m);
        log(`⚠️ SteamPass keepalive: ${m}`);
    }
}

/** Случайный интервал [25, 95) минут — подальше от ровного часа. */
function nextSteamPassKeepaliveDelay() {
    const min = 25 * 60 * 1000;
    const max = 95 * 60 * 1000;
    return min + Math.floor(Math.random() * (max - min));
}

// random — перенесено → bg_constants.js

// ==========================================
// FULFILL DISPATCHER (Heartbeat)
// ==========================================
let heartbeatTimer = null;

async function fulfillHeartbeat() {
    const s = await getStore();
    if (!s.isRunning) return;
    if (!s.mainTabId && !USE_API_MODE) return;

    if (USE_API_MODE) {
        try {
            const data = await playerokApi('viewer', VIEWER_QUERY, {});
            if (data?.viewer?.id) currentUserId = data.viewer.id;
        } catch (_) {
            currentUserId = null;
        }
    }

    const { today } = await getFulfillCount();
    if (today >= FULFILL_DAILY_LIMIT) {
        log(`🛑 Лимит SteamPass (${FULFILL_DAILY_LIMIT}). Поменяйте аккаунт.`);
        return;
    }

    const orders = s.orders || {};
    const now = Date.now();

    for (const [orderUrl, order] of Object.entries(orders)) {
        if (order.status === ORDER_STATUS.COMPLETED || order.status === ORDER_STATUS.ERROR) continue;
        if (order.status === ORDER_STATUS.NEW) continue;

        // WAITING_2FA ждёт покупателя и 2FA — отдельный лимит FULFILL_2FA_TIMEOUT_MS (10 мин).
        // Иначе ORDER_STALE_MS (5 мин) убивает сделку раньше, dealId остаётся в processedDeals → вечный «пропуск».
        const stale =
            order.status !== ORDER_STATUS.WAITING_2FA &&
            order.statusUpdatedAt &&
            now - order.statusUpdatedAt > ORDER_STALE_MS;
        if (stale) {
            log(`⏱ Заказ ${orderUrl.slice(-12)} протух в статусе ${order.status}`);
            await updateOrder(orderUrl, { status: ORDER_STATUS.ERROR, error: 'timeout' });
            await cleanupOrderTabs(order, { keepOpen: true });
            continue;
        }

        if (order.status === ORDER_STATUS.WAITING_2FA) {
            if (now - order.statusUpdatedAt > FULFILL_2FA_TIMEOUT_MS) {
                log(`⏱ Заказ завис в WAITING_2FA > 10 мин. Перевожу в ERROR, освобождаю поток.`);
                if (order.buyerName) processingUsers.delete(order.buyerName);
                await updateOrder(orderUrl, { status: ORDER_STATUS.ERROR, error: '2fa_timeout' });
                await cleanupOrderTabs(order);
                await removeOrder(orderUrl);
            } else if (USE_API_MODE && order.chatId) {
                if (await tryAutoMarkFulfilledWhenChatHas2FA(order.orderId, order.chatId)) {
                    continue;
                }
                const sent = await checkChatFor2FA(order.orderId, order.chatId);
                if (sent) {
                    const markRes = await apiMarkFulfilled(order.orderId);
                    if (!markRes?.error) log(`✅ API: markFulfilled через GraphQL`);
                    await domClickFulfilled(order.orderUrl);
                    await finishOrderSuccess(order);
                } else {
                    const poll2 = await pollChatApi(order.chatId);
                    if (poll2 && hasSellerSent2FACode(poll2.messages)) {
                        log('🖱️ Код 2FA уже в чате (например с монитора) — жму «Я выполнил» и закрываю сделку');
                        try {
                            const markRes = await apiMarkFulfilled(order.orderId);
                            if (!markRes?.error) log(`✅ API: markFulfilled после 2FA`);
                            else log(`⚠️ apiMarkFulfilled: ${markRes.error}`);
                            await domClickFulfilled(order.orderUrl);
                            await finishOrderSuccess(order);
                        } catch (e) {
                            log(`⚠️ Завершение после 2FA: ${e.message || e}`);
                        }
                    }
                }
            } else {
                const chatId = order.tabIds?.chat;
                const lastReload = order.lastChatReload || order.statusUpdatedAt || 0;
                const lastFocus = order.lastFocusAt || 0;
                if (chatId && (now - lastReload) > 40000) {
                    log("🔄 Чат [" + (order.buyerName || '?') + "] заснул. Перезагружаю для проверки сообщений...");
                    await new Promise((r) => chrome.tabs.reload(chatId, {}, r));
                    await sleep(6000);
                    chrome.scripting.executeScript({ target: { tabId: chatId }, files: ['content_greeting.js'] }).catch(() => { });
                    await sleep(1500);
                    await sendToTab(chatId, { action: 'START_WATCH_2FA', orderUrl: orderUrl });
                    await updateOrder(orderUrl, { lastChatReload: Date.now() });
                } else if (chatId && (now - lastFocus) > 120000) {
                    await focusTab(chatId);
                    await sleep(1500);
                    const st = await getStore();
                    if (st.mainTabId) await focusTab(st.mainTabId);
                    await updateOrder(orderUrl, { lastFocusAt: Date.now() });
                }
            }
            continue;
        }

        if (order.status === ORDER_STATUS.GETTING_DATA) {
            if (now - (order.statusUpdatedAt || 0) > 3000) await stepGettingData(order);
            continue;
        }
        if (order.status === ORDER_STATUS.DATA_READY) {
            await stepDataReady(order);
            continue;
        }
        if (order.status === ORDER_STATUS.GETTING_CREDENTIALS) {
            const retries = order.steamRetries ?? 0;
            const minDelay = retries === 0 ? 8000 : 3000;
            if (now - (order.statusUpdatedAt || 0) > minDelay) await stepGettingCredentials(order);
            continue;
        }
        if (order.status === ORDER_STATUS.SENDING_GREETING) {
            const reloadedAt = order.greetingReloadedAt || 0;
            if (reloadedAt && (now - reloadedAt) < 6000) continue;
            await stepSendingGreeting(order);
            continue;
        }
        if (order.status === ORDER_STATUS.GETTING_2FA) {
            const hasActive = Object.values(orders).some(o => ACTIVE_PHASES.includes(o.status));
            if (!hasActive) await stepGetting2FA(order);
            continue;
        }
    }

    const activeCount = await getActiveOrderCount();
    const totalCount = await getTotalOrderCount();
    const queue = s.queue || [];
    const canPull = activeCount < 1 && totalCount < FULFILL_CONCURRENT && queue.length > 0;
    if (canPull) {
        const orderUrl = await shiftQueue();
        if (orderUrl) {
            const ord = await getOrder(orderUrl);
            if (ord && ord.status === ORDER_STATUS.NEW) {
                await stepNew(orderUrl);
            }
        }
    }
}

async function cleanupOrderTabs(order, opts = {}) {
    const ids = order.tabIds || {};
    const keepOpen = opts.keepOpen; // DEBUG: true = не закрывать вкладки (для отладки при ошибке)
    if (keepOpen) return;
    // DEBUG: закомментировано для отладки — вкладки остаются открытыми
    // if (ids.chat) chrome.tabs.remove(ids.chat, () => {});
    // if (ids.steam) chrome.tabs.remove(ids.steam, () => {});
}

async function stepNew(orderUrl) {
    const ord = await getOrder(orderUrl);
    if (USE_API_MODE && ord?.chatId) {
        if (processingUsers.has(ord.buyerName) || greetedUsers.has(ord.buyerName)) {
            await updateOrder(orderUrl, { status: ORDER_STATUS.ERROR, error: 'user_busy' });
            return;
        }
        processingUsers.add(ord.buyerName);
        await updateOrder(orderUrl, { status: ORDER_STATUS.DATA_READY });
        log(`📡 API: 👤 ${ord.buyerName} — 🎮 ${ord.gameTitle}`);
        return;
    }
    const tab = await new Promise((r) => chrome.tabs.create({ url: orderUrl, active: false }, (t) => r(t)));
    if (chrome.runtime.lastError || !tab) {
        await updateOrder(orderUrl, { status: ORDER_STATUS.ERROR, error: 'tab_create_failed' });
        return;
    }
    await updateOrder(orderUrl, { status: ORDER_STATUS.GETTING_DATA, tabIds: { chat: tab.id } });
    log(`▶ Открываю заказ: ${orderUrl.split('/').pop()}`);
}

async function stepGettingData(order) {
    const chatId = order.tabIds?.chat;
    if (!chatId) {
        await updateOrder(order.orderUrl, { status: ORDER_STATUS.ERROR, error: 'no_chat_tab' });
        return;
    }
    const tab = await new Promise((r) => chrome.tabs.get(chatId, (t) => r(chrome.runtime.lastError ? null : t)));
    if (!tab) {
        const newTab = await new Promise((r) => chrome.tabs.create({ url: order.orderUrl, active: false }, (t) => r(t)));
        if (newTab) await updateOrder(order.orderUrl, { tabIds: { ...order.tabIds, chat: newTab.id } });
        return;
    }

    chrome.scripting.executeScript({ target: { tabId: chatId }, files: ['content_greeting.js'] }).catch(() => { });
    await focusTab(chatId);
    await sleep(500);

    const pageData = await sendToTab(chatId, { action: 'GET_PAGE_DATA', scrollFirst: true });
    if (pageData.error || !pageData.username) {
        await updateOrder(order.orderUrl, { status: ORDER_STATUS.ERROR, error: pageData.error || 'no_username' });
        await cleanupOrderTabs(order, { keepOpen: true });
        return;
    }
    const gameTitle = cleanGameTitleFromItemName((pageData.gameTitle || '').trim() || (await sendToTab(chatId, { action: 'GET_PAGE_DATA' })).gameTitle?.trim() || '');
    const username = pageData.username;

    const chatCheck = await sendToTab(chatId, { action: 'CHECK_CHAT_ALREADY_HANDLED' });
    if (chatCheck?.status === 'ALREADY_HANDLED') {
        log(`⏭ Заказ уже обработан вручную. Пропускаю.`);
        markOrderAsProcessed(order.orderUrl);
        await removeOrder(order.orderUrl);
        await cleanupOrderTabs(order);
        return;
    }

    loadGreetingData();
    if (processingUsers.has(username) || greetedUsers.has(username)) {
        await updateOrder(order.orderUrl, { status: ORDER_STATUS.ERROR, error: 'user_busy' });
        await cleanupOrderTabs(order, { keepOpen: true });
        return;
    }
    if (!gameTitle) {
        await updateOrder(order.orderUrl, { status: ORDER_STATUS.ERROR, error: 'no_game_title' });
        await cleanupOrderTabs(order, { keepOpen: true });
        return;
    }
    processingUsers.add(username);

    await updateOrder(order.orderUrl, { status: ORDER_STATUS.DATA_READY, buyerName: username, gameTitle });
    log(`👤 ${username} — ${gameTitle}`);
}

async function stepDataReady(order) {
    if (USE_API_MODE && order.chatId) {
        if (processingOrders.has(order.orderId)) return;
        processingOrders.add(order.orderId);
        cappedSetAdd(processedDeals, order.orderId, 2000);
        saveProcessedDeals();
        log(`🔒 Заказ ${order.orderId} добавлен в обработку.`);
        await updateOrder(order.orderUrl, { status: ORDER_STATUS.GETTING_CREDENTIALS, steamRetries: 0 });
        return;
    }
    if (order.tabIds?.steam) {
        const tab = await new Promise((r) => chrome.tabs.get(order.tabIds.steam, (t) => r(chrome.runtime.lastError ? null : t)));
        if (tab) {
            await updateOrder(order.orderUrl, { status: ORDER_STATUS.GETTING_CREDENTIALS, steamRetries: 0 });
            return;
        }
    }
    const steamTab = await new Promise((r) => chrome.tabs.create({ url: STEAMPASS_URL, active: false }, (t) => r(t)));
    if (!steamTab) {
        await updateOrder(order.orderUrl, { status: ORDER_STATUS.ERROR, error: 'steam_tab_failed' });
        return;
    }
    await updateOrder(order.orderUrl, { tabIds: { ...order.tabIds, steam: steamTab.id }, status: ORDER_STATUS.GETTING_CREDENTIALS, steamRetries: 0 });
    log(`📂 SteamPass открыт`);
}

async function ensureSteamTabAndRollbackIfNeeded(order, rollbackToDataReady = false) {
    const steamId = order.tabIds?.steam;
    const steamTab = steamId ? await new Promise((r) => chrome.tabs.get(steamId, (t) => r(chrome.runtime.lastError ? null : t))) : null;
    if (steamTab) return steamTab.id;
    const newTab = await new Promise((r) => chrome.tabs.create({ url: STEAMPASS_URL, active: false }, (t) => r(t)));
    if (!newTab) return null;
    const updates = { tabIds: { ...order.tabIds, steam: newTab.id }, steamRetries: 0 };
    if (rollbackToDataReady) {
        updates.status = ORDER_STATUS.DATA_READY;
        log(`🔄 SteamPass вкладка закрыта. Переоткрываю и откатываю на поиск игры.`);
    }
    await updateOrder(order.orderUrl, updates);
    return rollbackToDataReady ? null : newTab.id;
}

async function stepGettingCredentials(order) {
    if (USE_API_MODE && order.chatId) {
        const retries = order.steamRetries ?? 0;
        log(`Попытка получения данных (API): ${retries + 1}/3`);
        try {
            const credRes = await spFindAndBuy(order.gameTitle, order.chatId);
            log(`📋 Данные: ${credRes.login}`);
            await updateOrder(order.orderUrl, { login: credRes.login, password: credRes.password });
            await updateOrder(order.orderUrl, { status: ORDER_STATUS.SENDING_GREETING });
            return;
        } catch (e) {
            const newRetries = retries + 1;
            if (newRetries >= 3) {
                processingOrders.delete(order.orderId);
                if (order.buyerName) processingUsers.delete(order.buyerName);
                await updateOrder(order.orderUrl, { status: ORDER_STATUS.ERROR, error: e.message || 'no_credentials' });
                return;
            }
            log(`⚠️ API SteamPass: ${e.message}. Повтор ${newRetries}/3`);
            await updateOrder(order.orderUrl, { steamRetries: newRetries });
            return;
        }
    }

    const steamId = order.tabIds?.steam;
    if (!steamId) return;
    const validSteamId = await ensureSteamTabAndRollbackIfNeeded(order, false);
    if (validSteamId === null && !order.tabIds?.steam) return;
    const currentSteamId = validSteamId ?? order.tabIds?.steam;
    if (!currentSteamId) return;

    const retries = order.steamRetries ?? 0;
    log(`Попытка получения данных: ${retries + 1}/3`);
    chrome.scripting.executeScript({ target: { tabId: currentSteamId }, files: ['content_steampass.js'] }).catch(() => { });
    await focusTab(currentSteamId);
    await sleep(500);

    const credRes = await sendToSteamPass(currentSteamId, { action: 'STEAMPASS_SEARCH_AND_GET_DATA', gameTitle: order.gameTitle });
    if (credRes.error || !credRes.login || !credRes.password) {
        const newRetries = retries + 1;
        if (newRetries >= 3) {
            processingOrders.delete(order.orderId);
            if (order.buyerName) processingUsers.delete(order.buyerName);
            await updateOrder(order.orderUrl, { status: ORDER_STATUS.ERROR, error: credRes.error || 'no_credentials' });
            await cleanupOrderTabs(order, { keepOpen: true });
            return;
        }
        await updateOrder(order.orderUrl, { steamRetries: newRetries });
        return;
    }
    log(`📋 Данные: ${credRes.login}`);
    await updateOrder(order.orderUrl, { login: credRes.login, password: credRes.password });
    await updateOrder(order.orderUrl, { status: ORDER_STATUS.SENDING_GREETING });
}

async function stepSendingGreeting(order) {
    const chatId = order.chatId || order.tabIds?.chat;
    if (!chatId) return;
    const GREETING = `Здравствуйте! Я ваш бот-помощник. 👋\r\n\r\nСпасибо за покупку! Вот данные для аккаунта:\r\n\r\nЛогин: ${order.login}\r\nПароль: ${order.password}\r\n\r\n⚠️ Если нужен код 2FA — напишите "код" или "2fa" в чат.\r\nЕсли нужен код от других лаунчеров (EA, Ubisoft, Rockstar и т.д.) — это происходит в ручном режиме.`;
    if (USE_API_MODE && order.chatId) {
        const poll = await pollChatApi(order.chatId);
        let dealNodeGreet = null;
        if (order.orderId) {
            try {
                const ddg = await apiGetDealDetails(order.orderId);
                dealNodeGreet = ddg?.deal;
            } catch (_) { /* ignore */ }
        }
        if (poll && await sellerDeliveredForThisDeal(order.orderId, poll.messages, dealNodeGreet)) {
            log(`⏭ Ручная выдача: в чате [${order.buyerName}] уже есть выдача по этой сделке`);
            markOrderAsProcessed(order.orderUrl);
            await removeOrder(order.orderUrl);
            if (order.buyerName) processingUsers.delete(order.buyerName);
            return;
        }
        const res = await apiSendMessage(order.chatId, GREETING);
        if (res.ok) {
            if (order.orderId) await chrome.storage.local.set({ [`cred_sent_deal_${order.orderId}`]: true });
            log(`📡 API: Сообщение отправлено [${order.buyerName}]`);
            await bumpFulfilledToday();
            await markChatGreeted(order.chatId);
            await updateOrder(order.orderUrl, { status: ORDER_STATUS.WAITING_2FA, lastChatReload: Date.now(), lastFocusAt: Date.now() });
        } else {
            log(`❌ API: Ошибка отправки — ${res.error}`);
            processingOrders.delete(order.orderId);
            await updateOrder(order.orderUrl, { status: ORDER_STATUS.ERROR, error: res.error });
            if (order.buyerName) processingUsers.delete(order.buyerName);
        }
        return;
    }
    await focusTab(chatId);
    await sleep(500);
    log("📨 Попытка отправки сообщения для " + (order.buyerName || '?'));
    chrome.scripting.executeScript({ target: { tabId: chatId }, files: ['content_greeting.js'] }).catch(() => { });
    await sleep(300);
    const openRes = await sendToTab(chatId, { action: 'OPEN_CHAT_AND_SEND', text: GREETING, buyerName: order.buyerName, orderUrl: order.orderUrl });
    if (openRes?.ok) {
        log(`✅ Приветствие + данные отправлены`);
        await bumpFulfilledToday();
        await markChatGreeted(order.chatId || chatId);
        await sendToTab(chatId, { action: 'START_WATCH_2FA', orderUrl: order.orderUrl });
        await updateOrder(order.orderUrl, { status: ORDER_STATUS.WAITING_2FA, lastChatReload: Date.now(), lastFocusAt: Date.now() });
        log(`⏳ Ожидание команды 2fa (макс 1 мин)...`);
        return;
    }
    log("❌ Ошибка отправки: " + (openRes?.error || "Неизвестная ошибка"));
    const retries = (order.greetingRetries || 0) + 1;
    if (retries >= 5) {
        processingOrders.delete(order.orderId);
        if (order.buyerName) processingUsers.delete(order.buyerName);
        await updateOrder(order.orderUrl, { status: ORDER_STATUS.ERROR, error: openRes?.error || 'greeting_failed_after_5_retries' });
        await cleanupOrderTabs(order, { keepOpen: true });
        log("🛑 Превышено 5 попыток отправки. Заказ переведён в ERROR.");
        return;
    }
    await updateOrder(order.orderUrl, { greetingRetries: retries, greetingReloadedAt: Date.now() });
    chrome.tabs.reload(chatId, {}, () => { });
}

async function stepGetting2FA(order) {
    const chatId = order.chatId || order.tabIds?.chat;
    if (USE_API_MODE && order.chatId) {
        try {
            const { code } = await spGet2FACode(order.chatId);
            const res = await apiSendMessage(order.chatId, code);
            if (res.ok) log(`📡 API: Код 2FA отправлен [${order.buyerName}]`);
        } catch (e) {
            log(`⚠️ 2FA API: ${e.message}. Fallback на DOM.`);
            const steamTabId = await createHiddenSteamPassWindow();
            if (steamTabId) {
                chrome.scripting.executeScript({ target: { tabId: steamTabId }, files: ['content_steampass.js'] }).catch(() => { });
                await sleep(5000);
                await sendToSteamPass(steamTabId, { action: 'STEAMPASS_SEARCH_AND_GET_DATA', gameTitle: order.gameTitle });
                await sleep(6000);
                const codeRes = await sendToSteamPass(steamTabId, { action: 'STEAMPASS_GET_2FA' });
                await closeHiddenSteamPassWindow();
                if (codeRes?.code) {
                    const res = await apiSendMessage(order.chatId, codeRes.code);
                    if (res.ok) log(`📡 API: Код 2FA отправлен [${order.buyerName}]`);
                }
            }
        }
        await sleep(2000);
        const markRes = await apiMarkFulfilled(order.orderId || order.orderUrl?.split('/').pop());
        if (!markRes?.error) {
            log(`✅ API: markFulfilled через GraphQL`);
        }
        // Всегда жмём кнопку через DOM — GraphQL-мутации Playerok могут не работать
        await domClickFulfilled(order.orderUrl);
        await finishOrderSuccess(order);
        return;
    }
    const steamId = order.tabIds?.steam;
    if (!chatId) return;
    const validSteamId = await ensureSteamTabAndRollbackIfNeeded(order, true);
    if (validSteamId === null) return;
    const currentSteamId = validSteamId;
    if (!currentSteamId) return;

    chrome.scripting.executeScript({ target: { tabId: currentSteamId }, files: ['content_steampass.js'] }).catch(() => { });
    await focusTab(currentSteamId);
    await sleep(1500);

    const codeRes = await sendToSteamPass(currentSteamId, { action: 'STEAMPASS_GET_2FA' });
    if (codeRes.code) {
        await focusTab(chatId);
        await sleep(500);
        await sendToTab(chatId, { action: 'SEND_MESSAGE', text: codeRes.code });
        log(`🔐 Код 2FA отправлен`);
    }
    await sleep(3000);
    await focusTab(chatId);
    await sleep(300);
    const clickRes = await sendToTab(chatId, { action: 'CLICK_FULFILLED' });
    if (clickRes?.error) log(`⚠️ CLICK_FULFILLED: ${clickRes.error}`);

    await finishOrderSuccess(order);
}

async function finishOrderSuccess(order) {
    const { today: fulfilledToday } = await getFulfillCount();

    let playerokItemId = order.playerokItemId || '';
    let playerokItemSlug = order.playerokItemSlug || '';
    const oid = order.orderId || '';
    if (oid && (!playerokItemId || !playerokItemSlug)) {
        try {
            const dd = await apiGetDealDetails(oid);
            const it = dd?.deal?.item;
            if (it?.id) playerokItemId = it.id;
            if (it?.slug) playerokItemSlug = it.slug;
        } catch (_) { /* ignore */ }
    }

    await saveOrderToHistory({
        orderId: oid,
        chatId: order.chatId || '',
        buyerName: order.buyerName || '',
        gameTitle: order.gameTitle || '',
        login: order.login || '',
        password: order.password || '',
        productId: order.productId || '',
        priceRub: order.priceRub != null && order.priceRub !== '' ? order.priceRub : null,
        dealUrl: order.orderUrl || '',
        playerokItemId,
        playerokItemSlug
    });

    if (order.buyerName) {
        processingUsers.delete(order.buyerName);
        cappedSetAdd(greetedUsers, order.buyerName, 2000);
        saveUserToDatabase(order.buyerName, order.gameTitle, order.orderUrl);
        saveGreetedUsers();
    }
    markOrderAsProcessed(order.orderUrl);
    if (oid) {
        chrome.storage.local.remove([`cred_sent_deal_${oid}`, `deal_anchor_${oid}`]);
    }
    await removeOrder(order.orderUrl);
    await cleanupOrderTabs(order);

    lastSuccessTime = Date.now();
    log(`✅ Автовыдача завершена: ${order.buyerName} (${fulfilledToday}/${FULFILL_DAILY_LIMIT} за сегодня)`);

    if (fulfilledToday >= FULFILL_DAILY_LIMIT) {
        log(`🛑 Лимит SteamPass. Поменяйте аккаунт.`);
        stopBot();
        return;
    }
}

async function finishOrderError(order, returnToQueue = false) {
    if (order.buyerName) processingUsers.delete(order.buyerName);
    await cleanupOrderTabs(order, { keepOpen: true });
    await removeOrder(order.orderUrl);
    if (returnToQueue) await addOrderToQueue(order.orderUrl);
}

/** removeItem с повтором при 429; паузы из настроек «Задержка (сек)» панели автопубликации. */
async function playerokRemoveItemWith429Retry(itemId) {
    const maxAttempts = 12;
    let waitMs = await getPublisherPanelDelayMs();
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (!isCompletedDeleteRunning) return { ok: false, cancelled: true };
        try {
            await playerokApiQueued(() => playerokApi('removeItem', MUTATION_REMOVE_ITEM, { id: itemId }));
            return { ok: true };
        } catch (e) {
            const msg = String(e.message || e);
            if (/429|Too many requests/i.test(msg)) {
                log(`⚠️ Лимит Playerok (429), пауза ~${Math.round(waitMs / 1000)} с (из min/max задержки)… (${attempt + 1}/${maxAttempts})`);
                await sleep(waitMs);
                waitMs = Math.min(Math.round(waitMs * 1.45) + (await getPublisherPanelDelayMs()), 180000);
                continue;
            }
            return { ok: false, error: msg };
        }
    }
    return { ok: false, error: 'removeItem: слишком много 429 подряд' };
}

async function processCompletedDeletions(items, meta) {
    if (!isCompletedDeleteRunning) return;
    const list = (items || []).filter(i => i && (i.url || i.slug));
    const prefetched = meta && typeof meta.prefetchedId === 'number'
        ? meta.prefetchedId
        : list.filter(x => x.itemId).length;

    if (list.length === 0) {
        completedDeleteEmptyRounds++;
        if (completedDeleteEmptyRounds >= 2) {
            log('✅ Удаление «Завершённые»: на странице нет карточек лотов. Останов.');
            isCompletedDeleteRunning = false;
            completedDeleteEmptyRounds = 0;
            return;
        }
        log('🔍 Нет карточек в этой порции — обновление списка...');
    } else {
        completedDeleteEmptyRounds = 0;
        if (prefetched < list.length) {
            log(`🗑 Удаляю ${list.length} лотов (для ${list.length - prefetched} запрашиваю id через item(slug), кэш Apollo пуст)...`);
        } else {
            log(`🗑 Удаляю ${list.length} лотов (removeItem)...`);
        }
        log('🗑 Сначала вся найденная пачка, затем обновление страницы и новый скан.');
        for (const it of list) {
            if (!isCompletedDeleteRunning) break;
            let itemId = String(it.itemId || '').trim();
            let slug = parsePublicProductSlugFromUrl(it.url || '');
            if (!slug) slug = String(it.slug || '').trim();
            if (slug && RESERVED_PRODUCT_PATH_SLUGS.has(slug.toLowerCase())) slug = '';
            if (!itemId && !slug) {
                log(`⏭️ Пропуск (не страница лота): ${String(it.url || '').slice(0, 72)}`);
                continue;
            }
            if (!itemId && slug) {
                let attempts = 0;
                while (attempts < 3 && !itemId && isCompletedDeleteRunning) {
                    try {
                        const data = await playerokApiQueued(() => playerokApi('item', QUERY_ITEM_ID_BY_SLUG, { slug }));
                        itemId = String(data?.item?.id || '').trim();
                        if (!itemId) {
                            const enc = encodeURIComponent(slug);
                            if (enc !== slug) {
                                const dataEnc = await playerokApiQueued(() => playerokApi('item', QUERY_ITEM_ID_BY_SLUG, { slug: enc }));
                                itemId = String(dataEnc?.item?.id || '').trim();
                            }
                        }
                        if (!itemId && /%[0-9A-Fa-f]{2}/.test(slug)) {
                            try {
                                const dec = decodeURIComponent(slug);
                                if (dec !== slug) {
                                    const dataDec = await playerokApiQueued(() => playerokApi('item', QUERY_ITEM_ID_BY_SLUG, { slug: dec }));
                                    itemId = String(dataDec?.item?.id || '').trim();
                                }
                            } catch (_) { /* ignore */ }
                        }
                        break;
                    } catch (e) {
                        const msg = e.message || '';
                        if (/429|Too many requests/i.test(msg)) {
                            const _baseDelay = await getPublisherPanelDelayMs(); const w = _baseDelay * 2; // Bug #8 fix: was calling getPublisherPanelDelayMs() twice (double storage read)
                            log(`⚠️ 429 при item(slug), жду ~${Math.round(w / 1000)} с (2× задержка из настроек)...`);
                            await sleep(w);
                            attempts++;
                        } else {
                            log(`⚠️ item(${slug.slice(0, 28)}…): ${msg}`);
                            break;
                        }
                    }
                }
            }
            if (!itemId) {
                log(`⏭️ Нет id — пропуск: ${String(it.url || slug).slice(-52)}`);
                await sleep(await getPublisherPanelDelayMs());
                continue;
            }
            if (!String(it.itemId || '').trim() && slug) {
                await sleep(await getPublisherPanelDelayMs());
            }
            const rem = await playerokRemoveItemWith429Retry(itemId);
            if (rem.cancelled) break;
            if (rem.ok) {
                log(`✅ Удалён: ${(it.url || itemId).slice(-52)}`);
                await applyDashboardRemoveListing(itemId, it.url || '');
            } else {
                log(`❌ removeItem: ${rem.error || 'unknown'}`);
            }
            await sleep(await getPublisherPanelDelayMs());
        }
    }

    if (!isCompletedDeleteRunning) return;
    if (!mainTabId) {
        isCompletedDeleteRunning = false;
        return;
    }
    log('🔄 Пачка на этом экране обработана — перезагрузка «Завершённые» и новый скан карточек.');
    chrome.tabs.get(mainTabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
            isCompletedDeleteRunning = false;
            return;
        }
        chrome.tabs.reload(mainTabId, {}, () => {
            waitForTabComplete(mainTabId, () => {
                setTimeout(() => {
                    chrome.scripting.executeScript({ target: { tabId: mainTabId }, files: ['content.js'] })
                        .catch(() => { });
                    const dh = Math.min(8, completedDeleteEmptyRounds * 2 + 3);
                    setTimeout(() => {
                        chrome.tabs.sendMessage(mainTabId, { action: 'SCAN_DELETE_COMPLETED', depthHint: dh }, () => { });
                    }, 750);
                }, 350);
            });
        });
    });
}

function beginDeleteCompletedFlow() {
    pickPlayerokTabForBoost((tabId) => {
        mainTabId = tabId;
        waitForPlayerokNavigation(tabId, () => {
            chrome.tabs.get(tabId, (tab) => {
                if (chrome.runtime.lastError || !tab) {
                    log('❌ Вкладка Playerok недоступна.');
                    isCompletedDeleteRunning = false;
                    return;
                }
                mainTabId = tab.id;
                const tabUrl = tab.url || '';
                const mProf = tabUrl.match(/playerok\.com\/profile\/([^/]+)\//);
                if (mProf && mProf[1] && mProf[1] !== 'Morion21') {
                    currentPlayerokUsername = mProf[1];
                    chrome.storage.local.set({ playerokUsername: currentPlayerokUsername });
                }
                const homeUrl = getHomeUrl();
                const runScan = () => {
                    waitForTabComplete(mainTabId, () => {
                        chrome.scripting.executeScript({ target: { tabId: mainTabId }, files: ['content.js'] })
                            .catch(() => { });
                        setTimeout(() => {
                            chrome.tabs.sendMessage(mainTabId, { action: 'SCAN_DELETE_COMPLETED', depthHint: 0 }, () => {
                                if (chrome.runtime.lastError) {
                                    log(`⚠️ ${chrome.runtime.lastError.message}`);
                                }
                            });
                        }, 900);
                    });
                };
                if (!tabUrl.includes('/products/completed') || isPlayerokErrorPageUrl(tabUrl)) {
                    chrome.tabs.update(mainTabId, { url: homeUrl }, runScan);
                } else {
                    runScan();
                }
            });
        });
    });
}
