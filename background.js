// webRequest spy removed — caused all SteamPass requests to be intercepted/slowed

// ==========================================
// МОДУЛИ (importScripts — классический service worker, общий глобальный скоуп)
// ==========================================
importScripts('bg_constants.js');
importScripts('bg_tab_manager.js');
importScripts('bg_playerok_api.js');
importScripts('bg_dashboard.js');
importScripts('bg_fulfill.js');
importScripts('bg_boost.js');
importScripts('bg_publisher.js');

// --- ПЕРЕНЕСЕНО → bg_constants.js ---
// CONFIGURATION, getHomeUrl, getSalesUrl,
// isExtensionOrEmptyTabUrl, isPlayerokErrorPageUrl, isUsablePlayerokScannerUrl,
// BOOST_WORKER_WINDOW_KEY, FULFILL_WORKER_WINDOW_KEY, PUBLISHER_WORKER_WINDOW_KEY

// --- ПЕРЕНЕСЕНО → bg_tab_manager.js ---
// detectUsernameFromTabs, waitForPlayerokNavigation,
// saveBoostWorkerWindowId, pickPlayerokTabForBoost, pickPlayerokTabForFulfill

// --- ПЕРЕНЕСЕНО → bg_constants.js ---
// STEAMPASS_URL, FULFILL_CONCURRENT, FULFILL_2FA_TIMEOUT_MS, FULFILL_DAILY_LIMIT,
// HEARTBEAT_INTERVAL_MS, ORDER_STALE_MS, CHECK_ORDERS_INTERVAL, CHECK_CHAT_INTERVAL,
// getScanDelayMs, getPublisherPanelDelayMs, ORDER_STATUS

// === AUTO-BOOST STATE ===
// PROCESSED_LISTING_COOLDOWN_MS — перенесено → bg_constants.js
let processedListingAt = new Map();
let bumpInFlightUrls = new Set();
let queue = [];
let isProcessing = false;
let isSleeping = false;
let totalProcessed = 0;
let batchProcessed = 0;
let skippedItems = 0;
let activeTabs = new Set();
let tabStartTimes = {};
let lastBigSleepTotal = 0;
let pendingTabsCount = 0;
let lastHeartbeat = Date.now();
let lastSuccessTime = Date.now();
let emptyScanCount = 0;
let isBumping = false;
let isLogWriting = false;
let pendingLogs = [];

// === GLOBAL (для popup и режимов) ===
let currentBotMode = 'AUTO_BOOST';
let currentPlayerokUsername = null; // resolved at runtime from viewer API or active tab URL
let mainTabId = null;
/** Окно браузера, в котором крутится только сканер автопубликации (отдельно от основного окна). */
let boostWorkerWindowId = null;
let fulfillWorkerWindowId = null;
// FULFILL_WORKER_WINDOW_KEY — перенесено → bg_constants.js
/** Окно только для GraphQL при «Создании товаров» — не трогаем вкладку основного окна. */
let publisherWorkerWindowId = null;
// PUBLISHER_WORKER_WINDOW_KEY — перенесено → bg_constants.js
/** Один раз за запуск — лог про фокус, чтобы не спамить при каждом SCAN */
let boostFocusHintLogged = false;
let isScanning = false;
/** Массовое удаление лотов со вкладки «Завершённые» (GraphQL removeItem). */
let isCompletedDeleteRunning = false;
let _dashboardAutoRefreshLastTs = 0;
let _dashboardAutoRefreshInFlight = false;
let completedDeleteEmptyRounds = 0;
let isInjecting = false;
let retryTimer = null;
let scanTimer = null;
let nextScanTime = 0;

// === LEGACY (для автопубликации и user DB) ===
let processedOrders = new Set();
const processingOrders = new Set();
const processedDeals = new Set();
const failedDeals = new Set();
let processingUsers = new Set();
let greetedUsers = new Set();
let userDatabase = {};
let greetingEmptyScanCount = 0;
let lastGreetingReloadTime = 0;
// GREETING_RELOAD_COOLDOWN, isOrderMode, USE_API_MODE — перенесено → bg_constants.js

let lastProcessedTime = Date.now() - 3600000;
const processedMessageIds = new Set();
/** Метка последней очистки processedMessageIds — для TTL-based сброса */
let _processedMessageIdsClearedAt = Date.now();
/** Момент запуска бота — используем для фильтрации старых непрочитанных сообщений */
let botStartTime = 0;

// cappedSetAdd — перенесено → bg_constants.js

let isLoopRunning = false;
let isMainLoopRunning = false;
/** Независимый флаг цикла автопубликации (буста) — не связан с isMainLoopRunning/isProcessing автовыдачи. */
let isBoostRunning = false;
/** Вкладка сканера автопубликации — отдельная от mainTabId (который используется автовыдачей). */
let boostMainTabId = null;
let shadowMonitorInterval = null;
let steampassKeepAliveTimer = null;
// SHADOW_MONITOR_INTERVAL_MS, STEAMPASS_KEEPALIVE_MS — перенесено → bg_constants.js
// activeSleeps, sleep, cancelSleeps — перенесено → bg_constants.js

let steamPassBearerToken = null;
// SP_TOKEN_STORAGE_KEY — перенесено → bg_constants.js

// === CIRCUIT BREAKER: защита от каскадных ошибок ===
let spCircuitOpen = false;
let spCircuitUntil = 0;
let sp401Count = 0;
let sp401Window = 0;
let steamPassInjected = false; // Не переинжектим скрипт каждый раз

function isSteamPassAvailable() {
    if (spCircuitOpen && Date.now() < spCircuitUntil) return false;
    if (spCircuitOpen && Date.now() >= spCircuitUntil) {
        spCircuitOpen = false;
        sp401Count = 0;
        log('🟢 SteamPass: circuit breaker сброшен, пробую снова.');
    }
    return true;
}

function openCircuit(minutes, reason) {
    spCircuitOpen = true;
    spCircuitUntil = Date.now() + minutes * 60 * 1000;
    log(`🛑 SteamPass: ${reason}. Пауза ${minutes} мин до ${new Date(spCircuitUntil).toLocaleTimeString()}.`);
}

// jitter — перенесено → bg_constants.js

// Token is captured via content_steampass.js → UPDATE_SP_TOKEN message (no webRequest needed)

chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'UPDATE_SP_TOKEN' && msg.token) {
        steamPassBearerToken = msg.token;
        chrome.storage.local.set({ [SP_TOKEN_STORAGE_KEY]: msg.token });
    }
    if (msg.action === 'UPDATE_SETTINGS' && msg.settings && msg.settings.playerokUsername) {
        currentPlayerokUsername = msg.settings.playerokUsername;
    }
});

chrome.storage.local.get([SP_TOKEN_STORAGE_KEY], (o) => {
    const raw = o[SP_TOKEN_STORAGE_KEY];
    if (raw) steamPassBearerToken = raw;
});

// Глобальный keepalive SteamPass — стартует при загрузке background, не зависит от бота.
// Само-рекаррентный таймер с рандомизированной задержкой 25-95 мин и разным endpoint —
// антифроду сложнее увидеть «бьющий ровно в час» fingerprint бота.
function _scheduleSteamPassKeepalive() {
    const delay = (typeof nextSteamPassKeepaliveDelay === 'function')
        ? nextSteamPassKeepaliveDelay()
        : STEAMPASS_KEEPALIVE_MS;
    setTimeout(async () => {
        try { await steamPassSessionPing(); } catch (_) { }
        _scheduleSteamPassKeepalive();
    }, delay);
    console.log(`[SteamPass] keepalive: следующий пинг через ~${Math.round(delay / 60000)} мин`);
}
_scheduleSteamPassKeepalive();

// Watchdog: каждые 10 минут проверяем, что вкладка SteamPass живая и сессия валидна.
// Если нет ответа на PING → сбрасываем steamPassInjected (следующий callSteamPass переинжектит скрипт).
// Если токен изменился — обновляем кэш.
setInterval(async () => {
    try {
        const tabs = await chrome.tabs.query({ url: '*://*.steampass.gg/*' });
        if (!tabs.length) return; // вкладка не открыта — ничего не делаем
        const tab = tabs[0];
        const pong = await sendToTab(tab.id, { action: 'PING' }).catch(() => null);
        if (!pong || pong.error) {
            // Content script не отвечает — переинжектим сразу, не ждём следующего callSteamPass
            steamPassInjected = false;
            log('⚠️ SteamPass watchdog: нет ответа на PING — переинжектирую content_steampass.js');
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content_steampass.js'] }).catch(() => { });
            steamPassInjected = true;
            return;
        }
        // Вкладка жива — обновляем токен
        const tokRes = await sendToTab(tab.id, { action: 'GET_TOKEN' }).catch(() => null);
        if (tokRes?.token && tokRes.token !== steamPassBearerToken) {
            steamPassBearerToken = tokRes.token;
            chrome.storage.local.set({ [SP_TOKEN_STORAGE_KEY]: tokRes.token });
            log('🔄 SteamPass watchdog: токен обновлён');
        } else if (!tokRes?.token && steamPassBearerToken) {
            log('⚠️ SteamPass watchdog: токен пуст — сессия, вероятно, истекла. Ждём reload страницы...');
            steamPassBearerToken = null;
        }
    } catch (_) { /* watchdog не должен роняить background */ }
}, 10 * 60 * 1000);
// --- ПЕРЕНЕСЕНО → bg_tab_manager.js ---
// chrome.storage.local.get (worker window IDs init), chrome.windows.onRemoved,
// completedCatalogJob state, allowPlayerokBridgeWindowForDashboardCatalog state,
// clearCompletedCatalogJobTimer, clearCompletedCatalogArmTimer,
// tryStartCompletedCatalogScanFromTab, armCompletedCatalogScan,
// injectCatalogContentScripts, finishCompletedCatalogJob, scheduleCompletedCatalogContentScan,
// chrome.tabs.onUpdated (catalog + content_bridge_main + 404 redirect)

// — Сводка: скан «Завершённые» — состояние (видно bg_tab_manager.js через общий скоуп)
let completedCatalogJob = null;
/** Пока true — ensurePlayerokTab может открыть минимизированное окно Playerok для GraphQL, даже если бот в стопе (дашборд «Обновить список»). */
let allowPlayerokBridgeWindowForDashboardCatalog = false;

// --- ПЕРЕНЕСЕНО → bg_playerok_api.js ---
// PLAYEROK_SALES_URL, bridgeTabId state, ensurePlayerokTab, pingBridge, saveBridgeTabId,
// reloadBridgeTabThrottled, ensurePublisherWorkerBridgeTab, clearPublisherBridgeTabIfDedicated,
// _apiMutexChain, playerokApiQueued, playerokApi, playerokApiFile, playerokApiCanvas,
// Steam/image asset resolution (getCardAssets and helpers),
// apiGetDealDetails, checkViewerSession, chat monitoring functions

// --- ПЕРЕНЕСЕНО → bg_dashboard.js ---
// PERSISTENT 2FA COOLDOWN, catalog parsing, dashboard operations,
// 2FA per-chat helpers, extractCredentials, handleOldBuyerCodeRequest,
// runShadowMonitor, apiScanOrders, fulfill API helpers, domClickFulfilled

// --- ПЕРЕНЕСЕНО → bg_fulfill.js ---
// FULFILL STORE (getStore/setStore/...), HELPERS (focusTab, sendToTab, log),
// AUTO-FULFILL loop (initializeGreetingRun, triggerOrderScan, processNextOrder),
// FULFILL DISPATCHER (fulfillHeartbeat)

// ==========================================
// MESSAGE HANDLERS
// ==========================================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    lastHeartbeat = Date.now();

    if (request.action === 'START') {
        if (request.mode === 'AUTO_BOOST') {
            if (!isOrderMode(currentBotMode)) {
                currentBotMode = 'AUTO_BOOST';
                chrome.storage.local.set({ currentBotMode: 'AUTO_BOOST' });
            }
            startBoostBot();
        } else {
            if (request.mode === 'AUTO_FULFILL') {
                currentBotMode = 'AUTO_FULFILL';
                chrome.storage.local.set({ currentBotMode: 'AUTO_FULFILL' });
            }
            startBot();
        }
        return;
    }
    if (request.action === 'STOP_BOOST') { stopBoost(); return; }
    if (request.action === 'START_DELETE_COMPLETED') {
        (() => {
            if (isCompletedDeleteRunning) {
                sendResponse({ ok: false, error: 'Удаление уже выполняется' });
                return;
            }
            if (isOrderMode(currentBotMode) && isMainLoopRunning) {
                sendResponse({ ok: false, error: 'Сначала остановите автовыдачу' });
                return;
            }
            if (isProcessing) {
                sendResponse({ ok: false, error: 'Остановите автопубликацию (STOP в окне автопубликации)' });
                return;
            }
            if (publisherRunning) {
                sendResponse({ ok: false, error: 'Дождитесь окончания «Создание товаров»' });
                return;
            }
            isCompletedDeleteRunning = true;
            completedDeleteEmptyRounds = 0;
            log('🗑 Массовое удаление: «Завершённые» → GraphQL removeItem (UUID из страницы, как при автопубликации).');
            chrome.storage.local.set({ currentMode: 'Удаление завершённых' });
            sendResponse({ ok: true });
            beginDeleteCompletedFlow();
        })();
        return true;
    }
    if (request.action === 'STOP' || request.action === 'GLOBAL_STOP') { stopBot(); return; }
    if (request.action === 'RESET_SESSION') {
        processedListingAt.clear();
        bumpInFlightUrls.clear();
        saveProcessedListings();
        totalProcessed = 0;
        batchProcessed = 0;
        skippedItems = 0;
        lastBigSleepTotal = 0;
        greetedUsers.clear();
        userDatabase = {};
        processedOrders.clear();
        processedDeals.clear();
        const resetDay = new Date().toISOString().slice(0, 10);
        setStore({ orders: {}, queue: [], fulfillmentsToday: 0, lastFulfillDate: resetDay });
        chrome.storage.local.set({ fulfillmentsToday: 0, lastFulfillDate: resetDay });
        chrome.storage.local.remove(['fulfillManualOffset', 'fulfillManualOffsetDate']);
        saveGreetedUsers();
        saveUserDatabase();
        saveProcessedOrders();
        saveProcessedDeals();
        chrome.storage.local.get(null, (all) => {
            const rk = Object.keys(all || {}).filter((k) => k.startsWith('cred_sent_deal_') || k.startsWith('deal_anchor_'));
            if (rk.length) chrome.storage.local.remove(rk);
        });
        // Сбрасываем персистентные cooldown и in-flight mutex
        _2faInFlight.clear();
        _fulfillCompleteInFlight.clear();
        chrome.storage.local.remove([SENT_AT_KEY, ERR_AT_KEY]);
        chrome.storage.local.set({ processed: 0, batch: 0, logs: ["🧹 История очищена"] });
        log("🧹 Сессия сброшена");
        return;
    }
    if (request.action === 'CLEAR_MONITORED_CHATS') {
        chrome.storage.local.set({ monitored_chats: {} });
        _2faInFlight.clear();
        log("🧹 Мониторинг чатов сброшен (список обработанных PAID-заказов не трогался — см. «Сбросить обработанные заказы»).");
        sendResponse({ ok: true });
        return;
    }
    if (request.action === 'RESET_FULFILL_PROCESSED_DEALS') {
        (async () => {
            try {
                processedDeals.clear();
                processingOrders.clear();
                saveProcessedDeals();
                const all = await new Promise((r) => chrome.storage.local.get(null, r));
                const rk = Object.keys(all || {}).filter((k) =>
                    k.startsWith('cred_sent_deal_') || k.startsWith('deal_anchor_')
                );
                if (rk.length) await new Promise((r) => chrome.storage.local.remove(rk, r));
                log(`🧹 Сброшены обработанные сделки автовыдачи (в памяти + ${rk.length} служебн. ключей). Следующий цикл сможет выдать снова.`);
                sendResponse({ ok: true, removedKeys: rk.length });
            } catch (e) {
                sendResponse({ ok: false, error: e.message || String(e) });
            }
        })();
        return true;
    }
    if (request.action === 'RESET_GREETING_USER_STATS') {
        greetedUsers.clear();
        userDatabase = {};
        saveGreetedUsers();
        saveUserDatabase();
        log("🧹 Сброшены счётчики «приветствия» и «пользователи в БД». Лимит выдач за сегодня и мониторинг 2FA не менялись.");
        sendResponse({ ok: true });
        return;
    }
    if (request.action === 'LIST_MONITORED_CHATS') {
        (async () => {
            try {
                const items = await getMonitoredChatsDetail();
                sendResponse({ ok: true, items });
            } catch (e) {
                sendResponse({ ok: false, error: e.message || String(e) });
            }
        })();
        return true;
    }
    if (request.action === 'ADD_MANUAL_BUYER') {
        (async () => {
            const chatId = String(request.chatId || '').trim();
            if (!chatId) { sendResponse({ ok: false, error: 'no_chatId' }); return; }
            try {
                // Сбрасываем флаг "уже выслали данные" — чтобы handleOldBuyerCodeRequest перепроверил кредсы
                await chrome.storage.local.remove([`pending_creds_sent_${chatId}`]);

                // Если UUID передан вручную — используем его без запросов к Playerok API
                if (request.uuid) {
                    await chrome.storage.local.set({ [`order_${chatId}`]: { uuid: request.uuid, date: Date.now(), source: 'manual' } });
                    log(`👤 [Ручное добавление] Установлен UUID ${request.uuid.slice(0, 8)}… для чата ${chatId.slice(0, 8)}…`);
                    await registerChatForMonitor(chatId);
                    const changed = await checkAndNotifyCredentialChange(chatId, request.uuid);
                    log(`👤 [Ручное добавление] Чат ${chatId.slice(0, 8)}… в мониторинге. Данные ${changed ? 'обновлены и отправлены' : 'не изменились'}.`);
                    sendResponse({ ok: true, status: changed ? 'creds_updated' : 'registered' });
                    return;
                }

                // Запрашиваем последнюю сделку по chatId из Playerok API.
                // Это даёт актуальный dealId, itemName, buyerName — нужно для повторных покупателей,
                // у которых в storage может быть old uuid от предыдущей покупки.
                let freshDealId = null;
                try {
                    const chatDeal = await apiGetChatDeal(chatId);
                    if (chatDeal) {
                        const toSave = {};
                        if (chatDeal.dealId) {
                            freshDealId = chatDeal.dealId;
                            toSave[`deal_for_chat_${chatId}`] = chatDeal.dealId;
                            toSave[`chat_for_deal_${chatDeal.dealId}`] = chatId;
                        }
                        if (chatDeal.buyerName || chatDeal.itemName) {
                            toSave[`manual_meta_${chatId}`] = {
                                buyerName: chatDeal.buyerName || null,
                                gameTitle: chatDeal.itemName || null,
                            };
                        }
                        if (Object.keys(toSave).length) await chrome.storage.local.set(toSave);
                        log(`👤 [Ручное добавление] Playerok: сделка ${chatDeal.dealId ? String(chatDeal.dealId).slice(0, 8) + '…' : 'не найдена'} (${chatDeal.itemName || '?'}) покупатель: ${chatDeal.buyerName || '?'}`);
                    } else {
                        log(`👤 [Ручное добавление] Playerok не вернул данные для чата ${chatId.slice(0, 8)}… — ищу в истории`);
                    }
                } catch (_) { /* не критично — продолжаем */ }

                // Если нашли актуальную сделку через API, сбрасываем старый issued_creds чтобы
                // не использовать UUID от предыдущей покупки — handleOldBuyerCodeRequest найдёт новый
                if (freshDealId) {
                    await chrome.storage.local.remove([`issued_creds_${chatId}`, `order_${chatId}`]);
                }

                // Добавляем в мониторинг сразу — карточка появится в UI даже если UUID не найден
                await registerChatForMonitor(chatId);

                // Полный поиск UUID (история → sp_* ключи → deal → SteamPass) + отправка данных
                log(`👤 [Ручное добавление] Ищу UUID для чата ${chatId.slice(0, 8)}…`);
                await handleOldBuyerCodeRequest(chatId);
                // Проверяем нашли ли UUID
                const afterLookup = await new Promise(r => chrome.storage.local.get([`order_${chatId}`], o => r(o)));
                if (!afterLookup[`order_${chatId}`]?.uuid) {
                    sendResponse({ ok: true, status: 'no_uuid' });
                } else {
                    sendResponse({ ok: true, status: 'lookup_done' });
                }
            } catch (e) {
                sendResponse({ ok: false, error: e.message || String(e) });
            }
        })();
        return true;
    }
    if (request.action === 'REMOVE_MONITORED_CHAT') {
        (async () => {
            const chatId = String(request.chatId || '').trim();
            if (!chatId) { sendResponse({ ok: false, error: 'no_chatId' }); return; }
            // UI уже удалил chatId из monitored_chats напрямую.
            // Здесь только обновляем blocklist и чистим in-flight.
            const raw = await new Promise((r) => chrome.storage.local.get(['manually_removed_chats'], r));
            const mrRaw = raw.manually_removed_chats || {};
            mrRaw[chatId] = Date.now() + 48 * 60 * 60 * 1000; // TTL 48ч
            for (const id in mrRaw) { if (Date.now() > mrRaw[id]) delete mrRaw[id]; }
            await new Promise((r) => chrome.storage.local.set({ manually_removed_chats: mrRaw }, r));
            _2faInFlight.delete(chatId);
            log(`🧹 Чат ${chatId.slice(0, 8)}… убран из мониторинга 2FA (blocklist на 48ч).`);
            sendResponse({ ok: true, removed: true });
        })();
        return true;
    }
    if (request.action === 'CLEAR_PROCESSED_LISTINGS') {
        processedListingAt.clear();
        bumpInFlightUrls.clear();
        saveProcessedListings();
        log('🧹 История обработанных лотов (автоподнятие) очищена — сканер снова увидит эти URL');
        sendResponse({ ok: true });
        return;
    }
    if (request.action === 'PING') {
        if (sender.tab && activeTabs.has(sender.tab.id)) tabStartTimes[sender.tab.id] = Date.now();
        sendResponse({ status: 'PONG' });
        return;
    }
    if (request.action === 'GET_RUNNING_STATE') {
        // Возвращает реальный runtime-флаг (не storage) — используется UI для проверки
        // что бот действительно жив, а не просто isRunning:true осталось с прошлой сессии
        sendResponse({ isRunning: isLoopRunning || isMainLoopRunning });
        return true;
    }
    if (request.action === 'GET_POPUP_OVERVIEW') {
        (async () => {
            try {
                const keys = ['isRunning', 'currentBotMode', 'currentMode', 'status', 'processed', 'batch',
                    'daily_boost_bumps', 'daily_boost_bumps_date',
                    'daily_publisher_published', 'daily_publisher_published_date',
                    'playerokUsername', 'logs', 'userDatabase', 'boostLastEvents'];
                const raw = await new Promise((r) => chrome.storage.local.get(keys, r));
                const fulfill = await getFulfillCount();
                const today = new Date().toISOString().slice(0, 10);
                const activationsToday = raw.daily_boost_bumps_date === today ? (Number(raw.daily_boost_bumps) || 0) : 0;
                const publisherToday = raw.daily_publisher_published_date === today ? (Number(raw.daily_publisher_published) || 0) : 0;
                const ud = raw.userDatabase;
                const dbUsers = ud && typeof ud === 'object' ? Object.keys(ud).length : 0;
                const logsArr = Array.isArray(raw.logs) ? raw.logs : [];
                const logsPreview = logsArr.slice(-8).reverse().map((s) => String(s).slice(0, 200));
                const boostLastEvents = raw.boostLastEvents || {};
                const mode = raw.currentBotMode || currentBotMode || 'AUTO_BOOST';
                const storeRunning = !!raw.isRunning;
                let headline = 'Бот не запущен';
                let sub = '';
                if (publisherRunning) {
                    headline = publisherPaused ? 'Создание товаров: пауза' : 'Создание товаров: работает';
                    sub = raw.playerokUsername ? `@${raw.playerokUsername}` : '';
                } else if (storeRunning && isOrderMode(mode)) {
                    headline = 'Автовыдача: активна';
                    sub = raw.currentMode && raw.currentMode !== 'Остановлен' ? String(raw.currentMode) : '';
                } else if (storeRunning) {
                    headline = 'Автопубликация: активна';
                    sub = String(raw.status || '').slice(0, 120);
                } else {
                    sub = raw.playerokUsername ? `Аккаунт: ${raw.playerokUsername}` : 'Запуск — из окон «Автовыдача» или «Автопубликация»';
                }
                const boostMetrics = storeRunning && !isOrderMode(mode) && !publisherRunning;
                sendResponse({
                    ok: true,
                    headline,
                    sub,
                    fulfillToday: fulfill.today,
                    fulfillMax: FULFILL_DAILY_LIMIT,
                    activationsToday,
                    publisherToday,
                    boostQueue: queue.length,
                    boostBatch: batchProcessed,
                    dbUsers,
                    idle: !storeRunning && !publisherRunning,
                    boostMetrics,
                    logsPreview,
                    boostLastEvents
                });
            } catch (e) {
                sendResponse({ ok: false, error: e.message || String(e) });
            }
        })();
        return true;
    }
    if (request.action === 'DASHBOARD_APPEND_SALE') {
        (async () => {
            try {
                await appendDashboardSale(request.payload || {});
                sendResponse({ ok: true });
            } catch (e) {
                sendResponse({ ok: false, error: e.message || String(e) });
            }
        })();
        return true;
    }
    if (request.action === 'DASHBOARD_PAID_BUMP') {
        (async () => {
            allowPlayerokBridgeWindowForDashboardCatalog = true;
            try {
                const payload = request.payload || {};
                let itemId = String(payload.itemId || '').trim();
                const url = String(payload.url || '');
                let idata = null;
                if (!itemId && url) {
                    const slug = url.split('/').pop().replace(/\?.*$/, '');
                    const QUERY_ITEM = `query item($slug: String!) {
  item(slug: $slug) {
    id
    rawPrice
    ... on MyItem { obtainingType { id } }
  }
}`;
                    idata = await playerokApiQueued(() => playerokApi('item', QUERY_ITEM, { slug }));
                    itemId = idata?.item?.id || '';
                }
                if (!itemId) {
                    sendResponse({ ok: false, error: 'Нет itemId. Откройте любую страницу Playerok в браузере (авторизуйтесь) и повторите.' });
                    return;
                }
                const rawPrice = Number(idata?.item?.rawPrice || payload.rawPrice || 0);
                const bumpRes = await playerokApiQueued(() => apiPaidPriorityBump(itemId, rawPrice));
                if (!bumpRes.ok) {
                    sendResponse({ ok: false, error: bumpRes.error || 'Ошибка буста' });
                    return;
                }
                await dashboardRecordPaidBoostAndRemovePublished(payload, bumpRes.priceRub);
                sendResponse({ ok: true, priceRub: bumpRes.priceRub });
            } catch (e) {
                sendResponse({ ok: false, error: e.message || String(e) });
            } finally {
                allowPlayerokBridgeWindowForDashboardCatalog = false;
            }
        })();
        return true;
    }
    if (request.action === 'DASHBOARD_PUBLISH_ITEM') {
        (async () => {
            allowPlayerokBridgeWindowForDashboardCatalog = true;
            try {
                const payload = request.payload || {};
                let itemId = String(payload.itemId || '').trim();
                const url = String(payload.url || '');
                let obtainingTypeId = String(payload.obtainingTypeId || '').trim();
                let idata = null;
                const QUERY_ITEM = `query item($slug: String!) {
  item(slug: $slug) {
    id
    rawPrice
    ... on MyItem { obtainingType { id } }
  }
}`;
                if (!itemId && url) {
                    const slug = parsePublicProductSlugFromUrl(url) || url.split('/').pop().replace(/\?.*$/, '');
                    if (slug) {
                        idata = await playerokApiQueued(() => playerokApi('item', QUERY_ITEM, { slug }));
                        itemId = idata?.item?.id || '';
                        if (!obtainingTypeId) obtainingTypeId = idata?.item?.obtainingType?.id || '';
                    }
                } else if (itemId && !obtainingTypeId && url) {
                    const slug = parsePublicProductSlugFromUrl(url) || url.split('/').pop().replace(/\?.*$/, '');
                    if (slug) {
                        idata = await playerokApiQueued(() => playerokApi('item', QUERY_ITEM, { slug }));
                        obtainingTypeId = idata?.item?.obtainingType?.id || '';
                    }
                }
                if (!itemId) {
                    sendResponse({ ok: false, error: 'Нет id лота. Откройте Playerok в браузере (войдите в аккаунт) и повторите.' });
                    return;
                }
                const slugPayload = String(payload.slug || '').trim();
                const effectiveUrl = (url && /^https?:\/\//i.test(url))
                    ? url
                    : (slugPayload ? `https://playerok.com/products/${encodeURIComponent(slugPayload)}` : '');
                const rawPrice = Number(idata?.item?.rawPrice || payload.rawPrice || payload.salePriceRub || payload.basePriceRub || 0);
                const pubRes = await playerokApiQueued(() => apiBumpProduct(itemId, obtainingTypeId, rawPrice));
                if (pubRes.error) {
                    sendResponse({ ok: false, error: pubRes.error || 'Не удалось выставить' });
                    return;
                }
                await promoteDashboardDraftToPublishedByProductUrl(effectiveUrl, 'full', null, itemId);
                await patchCompletedCatalogListingByUrl(effectiveUrl, {
                    status: 'APPROVED',
                    statusLabel: 'В продаже'
                });
                sendResponse({ ok: true, skipped: !!pubRes.skipped });
            } catch (e) {
                sendResponse({ ok: false, error: e.message || String(e) });
            }
        })();
        return true;
    }
    // ── Delete item on site ──────────────────────────────────────────────────────
    if (request.action === 'DASHBOARD_DELETE_ITEM') {
        (async () => {
            allowPlayerokBridgeWindowForDashboardCatalog = true;
            try {
                const payload = request.payload || {};
                let itemId = String(payload.itemId || '').trim();
                const url = String(payload.url || '');

                // Resolve itemId from URL/slug if not provided
                if (!itemId && url) {
                    const slug = url.split('/').filter(Boolean).pop().replace(/\?.*$/, '');
                    if (slug) {
                        const QUERY_ITEM = `query item($slug: String!) { item(slug: $slug) { id } }`;
                        const idata = await playerokApiQueued(() => playerokApi('item', QUERY_ITEM, { slug }));
                        itemId = idata?.item?.id || '';
                    }
                }
                if (!itemId) {
                    sendResponse({ ok: false, error: 'Не удалось определить id лота. Откройте Playerok в браузере (войдите в аккаунт) и повторите.' });
                    return;
                }

                const MUTATION_DELETE = `mutation removeItem($id: UUID!) { removeItem(id: $id) { id } }`;
                await playerokApiQueued(() => playerokApi('removeItem', MUTATION_DELETE, { id: itemId }));
                sendResponse({ ok: true });
            } catch (e) {
                // Some items can't be deleted (sold, in deal) — surface the error
                sendResponse({ ok: false, error: e.message || String(e) });
            } finally {
                allowPlayerokBridgeWindowForDashboardCatalog = false;
            }
        })();
        return true;
    }

    // ── Batch publish (single bridge session for all items) ──────────────────────
    if (request.action === 'DASHBOARD_BATCH_PUBLISH') {
        (async () => {
            allowPlayerokBridgeWindowForDashboardCatalog = true;
            const items = Array.isArray(request.items) ? request.items : [];
            let done = 0, failed = 0, skipped = 0;
            const errors = [];
            const QUERY_ITEM = `query item($slug: String!) {
  item(slug: $slug) {
    id
    rawPrice
    ... on MyItem { obtainingType { id } }
  }
}`;
            try {
                for (const payload of items) {
                    try {
                        let itemId = String(payload.itemId || '').trim();
                        let obtainingTypeId = String(payload.obtainingTypeId || '').trim();
                        const url = String(payload.url || '');
                        let idata = null;

                        if (!itemId && url) {
                            const slug = (url.match(/\/(?:products|item)\/([^/?#]+)/i) || [])[1] || url.split('/').pop().replace(/\?.*$/, '');
                            if (slug) {
                                idata = await playerokApiQueued(() => playerokApi('item', QUERY_ITEM, { slug }));
                                itemId = idata?.item?.id || '';
                                if (!obtainingTypeId) obtainingTypeId = idata?.item?.obtainingType?.id || '';
                            }
                        } else if (itemId && !obtainingTypeId && url) {
                            const slug = (url.match(/\/(?:products|item)\/([^/?#]+)/i) || [])[1] || '';
                            if (slug) {
                                idata = await playerokApiQueued(() => playerokApi('item', QUERY_ITEM, { slug }));
                                obtainingTypeId = idata?.item?.obtainingType?.id || '';
                            }
                        }

                        if (!itemId) { failed++; errors.push(`Нет id: ${payload.title || payload.url || '?'}`); continue; }

                        const rawPrice = Number(idata?.item?.rawPrice || payload.rawPrice || payload.salePriceRub || payload.basePriceRub || 0);
                        const slugPayload = String(payload.slug || '').trim();
                        const effectiveUrl = (url && /^https?:\/\//i.test(url)) ? url : (slugPayload ? `https://playerok.com/products/${encodeURIComponent(slugPayload)}` : '');

                        const pubRes = await playerokApiQueued(() => apiBumpProduct(itemId, obtainingTypeId, rawPrice));
                        if (pubRes.error) { failed++; errors.push(`${payload.title || '?'}: ${pubRes.error}`); }
                        else {
                            if (pubRes.skipped) skipped++;
                            else done++;
                            if (effectiveUrl) {
                                await promoteDashboardDraftToPublishedByProductUrl(effectiveUrl, 'full', null, itemId);
                                await patchCompletedCatalogListingByUrl(effectiveUrl, { status: 'APPROVED', statusLabel: 'В продаже' });
                            }
                        }
                    } catch (e) {
                        failed++;
                        errors.push(e.message || String(e));
                    }
                    // Small delay between items
                    await new Promise(r => setTimeout(r, 600));
                }
                sendResponse({ ok: true, done, failed, skipped, errors });
            } catch (e) {
                sendResponse({ ok: false, error: e.message || String(e), done, failed, skipped });
            } finally {
                allowPlayerokBridgeWindowForDashboardCatalog = false;
            }
        })();
        return true;
    }

    if (request.action === 'DASHBOARD_AUTO_REFRESH_CATALOG') {
        (async () => {
            try {
                if (_dashboardAutoRefreshInFlight) {
                    sendResponse({ ok: false, error: 'busy', skipped: true });
                    return;
                }
                const DEBOUNCE_MS = 10000;
                const now = Date.now();
                if (!request.force && now - _dashboardAutoRefreshLastTs < DEBOUNCE_MS) {
                    sendResponse({ ok: true, skipped: true, reason: 'debounce' });
                    return;
                }
                let target = String(request.username || '').trim();
                if (!target) {
                    const s = await new Promise((r) => chrome.storage.local.get(['playerokUsername'], r));
                    target = String(s.playerokUsername || '').trim();
                }
                if (!target) {
                    sendResponse({ ok: false, error: 'no_username' });
                    return;
                }
                _dashboardAutoRefreshInFlight = true;
                const { items, activeCount } = await fetchCatalogFromLiveApollo(target);
                _dashboardAutoRefreshLastTs = Date.now();
                sendResponse({ ok: true, count: items.length, activeCount });
            } catch (e) {
                // Тишина для ожидаемых кейсов (нет вкладки + бот остановлен) — в UI останется кэш.
                sendResponse({ ok: false, error: e?.message || String(e) });
            } finally {
                _dashboardAutoRefreshInFlight = false;
            }
        })();
        return true;
    }

    if (request.action === 'DASHBOARD_FETCH_COMPLETED_CATALOG') {
        (async () => {
            try {
                if (_dashboardAutoRefreshInFlight) { // We can use the same lock or a new one
                    sendResponse({ ok: false, error: 'Сводка уже обновляется...' });
                    return;
                }
                _dashboardAutoRefreshInFlight = true;
                
                // Directly utilize API fetch without ANY UI windows!
                await fetchCatalogFromLiveGraphQL(sendResponse);

            } catch (e) {
                sendResponse({ ok: false, error: e?.message || String(e) });
            } finally {
                _dashboardAutoRefreshInFlight = false;
            }
        })();
        return true;
    }

    if (request.action === 'COMPLETED_CATALOG_SCAN_RESULT') {
        (async () => {
            const job = completedCatalogJob;
            if (!job) return;
            if (job.tabId && bridgeTabId !== job.tabId) saveBridgeTabId(job.tabId);
            const err = request.error ? String(request.error) : '';
            const phase = request.scanPhase === 'drafts' ? 'drafts'
                : request.scanPhase === 'published' ? 'published'
                : 'completed';
            if (phase === 'completed') {
                if (err) {
                    finishCompletedCatalogJob({ ok: false, error: err, items: [], draftCount: 0, publishedCount: 0 });
                    return;
                }
                const items = (Array.isArray(request.items) ? request.items : []).slice(0, DASHBOARD_MAX_CATALOG_ITEMS);
                const sourceUrl = String(request.sourceUrl || job.pageUrl || '');
                const payload = {
                    fetchedAt: Date.now(),
                    username: job.target,
                    sourceUrl: sourceUrl || job.pageUrl,
                    items
                };
                await chrome.storage.local.set({ [DASHBOARD_COMPLETED_CATALOG_KEY]: payload });
                job.catalogCount = items.length;
                const draftLikeImports = items.filter((it) => {
                    if (!it || typeof it !== 'object') return false;
                    const st = String(it.status || '').toUpperCase();
                    const sl = String(it.statusLabel || '').toLowerCase();
                    return st === 'DRAFT' || sl.includes('черновик');
                }).map((it) => ({
                    title: it.title,
                    url: it.url,
                    itemId: String(it.id || '').trim(),
                    basePriceRub: it.basePriceRub,
                    salePriceRub: it.salePriceRub != null ? it.salePriceRub : it.priceRub,
                    hasDiscount: !!it.hasDiscount,
                    quantity: 1
                }));
                if (draftLikeImports.length) {
                    const extra = await mergeDashboardDraftImportsFromScan(draftLikeImports);
                    job.draftExtraFromCompleted = extra;
                    if (extra) log(`[Dashboard] Черновики с вкладки «завершённые» (по статусу): +${extra}`);
                }
                log(`[Dashboard] Завершённые: ${items.length} шт. → открываю черновики (${job.target})`);
                job.scanPhase = 'drafts';
                clearCompletedCatalogArmTimer();
                job.armTimer = null;
                job.loadHandled = false;
                const draftsUrl = `https://playerok.com/profile/${encodeURIComponent(job.target)}/products/drafts`;
                chrome.tabs.update(job.tabId, { url: draftsUrl }, () => {
                    if (chrome.runtime.lastError) {
                        log(`[Dashboard] Вкладка черновиков: ${chrome.runtime.lastError.message}`);
                        // Пропускаем черновики — переходим сразу к опубликованным
                        job.scanPhase = 'published';
                        job.loadHandled = false;
                        const pubUrl = `https://playerok.com/profile/${encodeURIComponent(job.target)}/products`;
                        chrome.tabs.update(job.tabId, { url: pubUrl }, () => { void chrome.runtime.lastError; });
                    }
                });
                return;
            }
            if (phase === 'drafts') {
                const draftImports = Array.isArray(request.draftImports) ? request.draftImports : [];
                if (err) log(`[Dashboard] Скан черновиков: ${err}`);
                let draftCount = 0;
                if (draftImports.length) draftCount = await mergeDashboardDraftImportsFromScan(draftImports);
                const totalDrafts = draftCount + (job.draftExtraFromCompleted || 0);
                job.draftCount = totalDrafts;
                log(`[Dashboard] Черновики: ${draftImports.length} шт. → открываю опубликованные (${job.target})`);
                job.scanPhase = 'published';
                clearCompletedCatalogArmTimer();
                job.armTimer = null;
                job.loadHandled = false;
                const publishedUrl = `https://playerok.com/profile/${encodeURIComponent(job.target)}/products`;
                chrome.tabs.update(job.tabId, { url: publishedUrl }, () => {
                    if (chrome.runtime.lastError) {
                        log(`[Dashboard] Вкладка опубликованных: ${chrome.runtime.lastError.message}`);
                        finishCompletedCatalogJob({
                            ok: true,
                            count: job.catalogCount,
                            draftCount: job.draftCount || 0,
                            publishedCount: 0,
                            items: []
                        });
                    }
                });
                return;
            }
            // phase === 'published'
            const publishedImports = Array.isArray(request.publishedImports) ? request.publishedImports : [];
            if (err) log(`[Dashboard] Скан опубликованных: ${err}`);
            let publishedCount = 0;
            if (publishedImports.length) publishedCount = await mergeDashboardPublishedImportsFromScan(publishedImports);
            finishCompletedCatalogJob({
                ok: true,
                count: job.catalogCount,
                draftCount: job.draftCount || 0,
                publishedCount,
                items: []
            });
        })();
        return false;
    }
    if (request.action === 'READY_TO_SCAN') {
        if (isCompletedDeleteRunning) return;
        if (isProcessing && !isOrderMode(currentBotMode) && request.url?.includes("playerok.com")) {
            isInjecting = false;
            if (retryTimer) clearTimeout(retryTimer);
            if (!isScanning) {
                isScanning = true;
                chrome.storage.local.get(['boostIncludeDrafts'], (stor) => {
                    chrome.tabs.sendMessage(mainTabId, {
                        action: "SCAN",
                        includeDrafts: !!stor.boostIncludeDrafts
                    }, () => { });
                });
            }
        }
        return;
    }
    if (request.action === 'FOUND_ITEMS') {
        if (request.purpose === 'delete_completed') {
            processCompletedDeletions(request.items, request.meta).catch((e) => {
                log(`❌ Удаление завершённых: ${e?.message || e}`);
                isCompletedDeleteRunning = false;
            });
        } else if (sender.tab && sender.tab.id === boostMainTabId) {
            // Карточки от вкладки автопубликации — всегда идут в очередь буста
            isScanning = false; // на случай если буст переиспользует старый isScanning
            addToQueue(request.items);
        } else if (!isOrderMode(currentBotMode)) {
            // Карточки от старого цикла (mainTabId) — только если не режим автовыдачи
            isScanning = false;
            addToQueue(request.items);
        }
        return;
    }
    if (request.action === 'ITEM_DONE') {
        handleItemDone(request.success, sender.tab.id, sender.tab.url, false, request.success ? 'full' : null);
        return;
    }
    if (request.action === 'ITEM_ALREADY_ACTIVE') {
        handleItemDone(true, sender.tab.id, sender.tab.url, true, 'match_draft_only');
        return;
    }
    if (request.action === 'PAGE_PUBLISH_DETECTED') {
        // Ручная публикация / «Выставить» / «Выставить повторно» на Playerok
        const href = request.href || '';
        const pubItemId = request.itemId || '';
        log(`[Dashboard] PAGE_PUBLISH_DETECTED href="${href.slice(0, 60)}" itemId="${pubItemId.slice(0, 8)}"`);
        if (href || pubItemId) {
            promoteDashboardDraftToPublishedByProductUrl(href, 'full', null, pubItemId)
                .catch(e => log(`[Dashboard] page_pub_detected err: ${e.message}`));
            // Обновить статус в «Все товары» — убрать DRAFT-метку
            if (href) {
                patchCompletedCatalogListingByUrl(href, { status: 'APPROVED', statusLabel: 'В продаже' })
                    .catch(e => log(`[Dashboard] page_pub_catalog_patch err: ${e.message}`));
            }
        } else {
            log(`[Dashboard] PAGE_PUBLISH_DETECTED: нет href и itemId — пропуск`);
        }
        return;
    }
    if (request.action === 'PAGE_ITEM_DELETED') {
        (async () => {
            try {
                const delItemId = String(request.itemId || '').trim();
                const delHref = String(request.href || '').trim();
                log(`[Dashboard] PAGE_ITEM_DELETED itemId="${delItemId.slice(0, 8)}" href="${delHref.slice(0, 60)}"`);
                await applyDashboardRemoveListing(delItemId, delHref);
                // Удалить из снимка «Все товары»
                await removeFromCompletedCatalog(delItemId, delHref);
            } catch (e) {
                log(`[Dashboard] PAGE_ITEM_DELETED err: ${e.message}`);
            }
        })();
        return;
    }
    if (request.action === 'PAGE_PAID_BUMP_DETECTED') {
        (async () => {
            try {
                await appendDashboardSiteBoostRecord({
                    href: request.href || '',
                    itemId: request.itemId || '',
                    priceRub: request.priceRub || 0
                });
            } catch (e) {
                log(`[Dashboard] site_boost: ${e.message}`);
            }
        })();
        return;
    }
    if (request.action === 'UPDATE_MODE') {
        chrome.storage.local.set({ currentMode: request.mode });
        return;
    }
    if (request.action === 'LOG') {
        if (sender.tab && sender.tab.id === boostMainTabId) {
            boostLog(request.message);
        } else {
            log(request.message);
        }
        return;
    }
    if (request.action === 'AM_I_TASK') {
        sendResponse({ process: sender.tab && activeTabs.has(sender.tab.id) });
        return;
    }
    if (request.action === 'TOO_MANY_REQUESTS') {
        log("🛑 Лимит запросов (429). Сплю 2 минуты...");
        handleItemDone(false, sender.tab.id);
        performSleep(120000, "🛑 429 Error. Пауза 2 мин...");
        return;
    }
    if (request.action === 'RELOAD_NEEDED') {
        if (sender.tab) chrome.tabs.reload(sender.tab.id);
        return;
    }
    if (request.action === 'TRIGGER_2FA_FROM_SCAN') {
        const chatId = request.chatId || (request.url && (request.url.match(/\/chat\/([^/?]+)/) || [])[1]);
        if (chatId) {
            (async () => {
                try {
                    log(`🚀 [${chatId}] Активация 2FA через живой мониторинг!`);
                    const orderKey = 'order_' + chatId;
                    const store = await chrome.storage.local.get([orderKey]);
                    const uuid = store[orderKey]?.uuid;
                    if (!uuid) return;
                    const text = (request.text || '').toLowerCase();
                    const isChild = /сошиал|код\s*2|social|рокстар|uplay/.test(text);
                    const type = isChild ? 'child' : 'main';
                    if (isChild) {
                        // Дочерние коды (EA/Ubisoft/Rockstar) — мануальные, оставляем legacy
                        const res = await handle2FARequest(chatId, type);
                        if (res) {
                            const sendRes = await apiSendMessage(chatId, res);
                            if (sendRes?.ok && res.startsWith?.('🛡')) await mark2FASent(chatId);
                        }
                    } else {
                        const tres = await handleBuyer2FATrigger(chatId, type);
                        if (tres?.code === 'sent') await mark2FASent(chatId);
                    }
                } catch (e) {
                    console.error('TRIGGER_2FA_FROM_SCAN:', e);
                }
            })();
        }
        return;
    }
    if (request.action === 'SWITCH_MODE') {
        if (currentBotMode !== request.mode) {
            stopBot();
        }
        currentBotMode = request.mode;
        chrome.storage.local.set({ currentBotMode: request.mode });
        log(`🔄 Режим: ${request.mode === 'AUTO_BOOST' ? 'Автопубликация' : 'Автовыдача'}`);
        return;
    }
    if (request.action === 'CHECK_USER') {
        const username = request.username;
        sendResponse({ isNew: !userDatabase.hasOwnProperty(username), greeted: greetedUsers.has(username), inProgress: processingUsers.has(username) });
        return true;
    }
    if (request.action === 'RESERVE_USER') {
        const username = request.username;
        if (processingUsers.has(username)) sendResponse({ reserved: false });
        else { processingUsers.add(username); log(`🔒 Резерв: ${username}`); sendResponse({ reserved: true }); }
        return true;
    }
    if (request.action === 'RELEASE_USER') {
        processingUsers.delete(request.username);
        return false;
    }
    if (request.action === 'FOUND_ORDERS') {
        addOrdersToQueue(request.orders);
        return;
    }
    if (request.action === 'WAIT_FOR_2FA_DETECTED') {
        const orderUrl = request.orderUrl || (sender.tab?.url && sender.tab.url.includes('playerok.com') ? sender.tab.url.split('?')[0].split('#')[0] : null);
        if (orderUrl) {
            updateOrder(orderUrl, { status: ORDER_STATUS.GETTING_2FA }).then(() => { });
        }
        return;
    }
});

// --- ПЕРЕНЕСЕНО → bg_boost.js ---
// LEGACY HELPERS, AUTO-BOOST (initializeRun, triggerScan, processNextItem),
// TABS ON REMOVED (activeTabs), SCAN & BOT START (startBot, stopBot, watchdog)

// --- ПЕРЕНЕСЕНО → bg_publisher.js ---
// AUTO-PUBLISHER (publisherRunning state, startPublisherProcess, all publisher helpers)