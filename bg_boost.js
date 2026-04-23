// ==========================================
// bg_boost.js
// Загружается шестым (после bg_fulfill.js).
// Содержит:
//   • LEGACY HELPERS — normalizeBoostListingUrl, processItemUrl, loadProcessedListings
//   • AUTO-BOOST (unchanged flow) — initializeRun, triggerScan, scheduleNextScan
//   • processNextItem, performSleep, TABS ON REMOVED listener (для activeTabs)
//   • SCAN & BOT START — startBot, stopBot, watchdog
// Доступ к глобальному стейту background.js через общий скоуп importScripts.
// ==========================================
// LEGACY HELPERS (user DB, processed orders)
// ==========================================
function normalizeBoostListingUrl(u) {
    if (!u || typeof u !== 'string') return '';
    return u.split('#')[0].split('?')[0].replace(/\/$/, '');
}
function pruneStaleProcessedListings() {
    const now = Date.now();
    for (const [k, t] of processedListingAt) {
        if (!Number.isFinite(t) || (now - t) >= PROCESSED_LISTING_COOLDOWN_MS) processedListingAt.delete(k);
    }
}
function isBoostListingProcessed(url) {
    const key = normalizeBoostListingUrl(url);
    if (!key) return false;
    if (bumpInFlightUrls.has(key)) return true;
    const t = processedListingAt.get(key);
    if (t == null) return false;
    return (Date.now() - t) < PROCESSED_LISTING_COOLDOWN_MS;
}
function markBoostListingProcessed(url) {
    const key = normalizeBoostListingUrl(url);
    if (!key) return;
    processedListingAt.set(key, Date.now());
    pruneStaleProcessedListings();
    const o = {};
    processedListingAt.forEach((v, k) => { o[k] = v; });
    chrome.storage.local.set({ processedListingsAt: o });
}
function saveProcessedListings() {
    pruneStaleProcessedListings();
    const o = {};
    processedListingAt.forEach((v, k) => { o[k] = v; });
    chrome.storage.local.set({ processedListingsAt: o });
}
function loadProcessedUrls() {
    chrome.storage.local.get(['processedListingsAt', 'processedUrls'], (r) => {
        processedListingAt = new Map();
        if (r.processedListingsAt && typeof r.processedListingsAt === 'object') {
            Object.entries(r.processedListingsAt).forEach(([k, v]) => {
                const t = Number(v);
                const key = normalizeBoostListingUrl(k);
                if (key && Number.isFinite(t)) processedListingAt.set(key, t);
            });
        }
        if (Array.isArray(r.processedUrls)) {
            const retro = Date.now() - PROCESSED_LISTING_COOLDOWN_MS - 1000;
            r.processedUrls.forEach((u) => {
                const key = normalizeBoostListingUrl(u);
                if (key && !processedListingAt.has(key)) processedListingAt.set(key, retro);
            });
        }
        pruneStaleProcessedListings();
        const o = {};
        processedListingAt.forEach((v, k) => { o[k] = v; });
        chrome.storage.local.set({ processedListingsAt: o });
        if (Array.isArray(r.processedUrls) && r.processedUrls.length) chrome.storage.local.remove(['processedUrls']);
    });
}
function loadGreetingData() {
    chrome.storage.local.get(['processedOrders', 'userDatabase', 'greetedUsers', 'currentBotMode', 'processedDeals'], (r) => {
        if (r.processedOrders) processedOrders = new Set(r.processedOrders);
        if (r.userDatabase) userDatabase = r.userDatabase;
        if (r.greetedUsers) greetedUsers = new Set(r.greetedUsers);
        if (r.currentBotMode) currentBotMode = r.currentBotMode === 'AUTO_GREETING' ? 'AUTO_FULFILL' : r.currentBotMode;
        if (r.processedDeals) r.processedDeals.forEach(id => processedDeals.add(id));
    });
}
function saveProcessedOrders() { chrome.storage.local.set({ processedOrders: Array.from(processedOrders) }); }
function saveProcessedDeals() { chrome.storage.local.set({ processedDeals: Array.from(processedDeals) }); }
function saveUserDatabase() { chrome.storage.local.set({ userDatabase }); }
function saveGreetedUsers() { chrome.storage.local.set({ greetedUsers: Array.from(greetedUsers) }); }
function markOrderAsProcessed(orderUrl) {
    cappedSetAdd(processedOrders, orderUrl, 2000);
    saveProcessedOrders();
}
function saveUserToDatabase(username, gameTitle, orderUrl) {
    if (!userDatabase[username]) userDatabase[username] = { purchases: [], firstPurchase: new Date().toISOString(), totalPurchases: 0 };
    userDatabase[username].purchases.push({ game: gameTitle, date: new Date().toISOString(), orderUrl, greeted: true });
    userDatabase[username].totalPurchases++;
    saveUserDatabase();
}

function checkFulfillLimit() {
    const todayDate = new Date().toISOString().slice(0, 10);
    return getFulfillCount().then(({ today: fulfillCount, date }) => {
        if (date !== todayDate) return false;
        return (fulfillCount || 0) >= FULFILL_DAILY_LIMIT;
    });
}

// ==========================================
// TABS ON REMOVED
// ==========================================
chrome.tabs.onRemoved.addListener(async (tabId) => {
    if (activeTabs.has(tabId)) {
        activeTabs.delete(tabId);
        delete tabStartTimes[tabId];
        setTimeout(() => processNextItem(), 50);
        return;
    }
    const s = await getStore();
    const orders = s.orders || {};
    for (const [orderUrl, order] of Object.entries(orders)) {
        if (order.tabIds?.chat === tabId || order.tabIds?.steam === tabId) {
            const newTabIds = { ...order.tabIds };
            if (order.tabIds?.chat === tabId) delete newTabIds.chat;
            if (order.tabIds?.steam === tabId) delete newTabIds.steam;
            await updateOrder(orderUrl, { tabIds: newTabIds });
            if (order.buyerName) processingUsers.delete(order.buyerName);
            log(`⚠️ Вкладка заказа закрыта. Heartbeat переоткроет при необходимости.`);
            break;
        }
    }
    if (isBoostRunning && !isSleeping) setTimeout(() => processNextItem(), 50);
});

// ==========================================
// SCAN & BOT START
// ==========================================
// Синхронный lock: предотвращает двойной запуск пока async-инициализация ещё не выставила isLoopRunning
let _startBotLock = false;
let _startBoostBotLock = false;

function startBot() {
    // startBot() используется только для AUTO_FULFILL.
    // AUTO_BOOST запускается через startBoostBot() из background.js.
    if (isLoopRunning || isMainLoopRunning || _startBotLock) {
        log('⚠️ Автовыдача уже запущена — игнорирую повторный запуск.');
        return;
    }
    _startBotLock = true;
    if (!isOrderMode(currentBotMode)) {
        // Если по какой-то причине startBot() вызван в режиме BOOST — перенаправляем
        startBoostBot();
        return;
    }
    lastProcessedTime = Date.now() - 3600000;
    chrome.storage.local.set({ isRunning: true, processed: 0, batch: 0, status: "Инициализация..." });

    function applyUsernameFromTabUrl(tabUrl) {
        const urlUsernameMatch = tabUrl.match(/playerok\.com\/profile\/([^/]+)\//);
        if (urlUsernameMatch && urlUsernameMatch[1]) {
            currentPlayerokUsername = urlUsernameMatch[1];
            chrome.storage.local.set({ playerokUsername: currentPlayerokUsername });
        }
    }

    if (isOrderMode(currentBotMode)) {
        pickPlayerokTabForFulfill((tabId) => {
            mainTabId = tabId;
            waitForPlayerokNavigation(tabId, () => {
                chrome.tabs.get(tabId, (tab) => {
                    if (chrome.runtime.lastError || !tab) { _startBotLock = false; log("❌ Вкладка автовыдачи недоступна."); return; }
                    mainTabId = tab.id;
                    const tabUrl = tab.url || '';
                    applyUsernameFromTabUrl(tabUrl);
                    const salesUrl = getSalesUrl();
                    if (!tabUrl.includes('/sales') || isPlayerokErrorPageUrl(tabUrl)) {
                        log("⚠️ Не на странице заказов. Перехожу...");
                        chrome.tabs.update(mainTabId, { url: salesUrl });
                        waitForTabComplete(mainTabId, () => {
                            log("📍 Страница заказов загружена.");
                            initializeGreetingRun();
                        });
                    } else {
                        log("📍 Страница заказов загружена.");
                        waitForTabComplete(mainTabId, initializeGreetingRun);
                    }
                });
            });
        });
        return;
    }

    pickPlayerokTabForBoost((tabId) => {
        mainTabId = tabId;
        waitForPlayerokNavigation(tabId, () => {
            chrome.tabs.get(tabId, (tab) => {
                if (chrome.runtime.lastError || !tab) {
                    _startBotLock = false;
                    log("❌ Вкладка Playerok недоступна.");
                    return;
                }
                mainTabId = tab.id;
                const tabUrl = tab.url || '';
                applyUsernameFromTabUrl(tabUrl);
                const homeUrl = getHomeUrl();
                if (isPlayerokErrorPageUrl(tabUrl)) {
                    log('⚠️ Вкладка сканера на /404 (или служебной ошибке) — открываю список товаров.');
                }
                if (!tabUrl.includes('/products/completed') || isPlayerokErrorPageUrl(tabUrl)) {
                    chrome.tabs.update(mainTabId, { url: homeUrl });
                    waitForTabComplete(mainTabId, () => {
                        log("📍 Страница товаров загружена.");
                        initializeRun();
                    });
                } else {
                    waitForTabComplete(mainTabId, initializeRun);
                }
            });
        });
    });
}

function waitForTabComplete(tabId, callback) {
    let done = false;
    let fallbackTimer = null;
    const fire = () => {
        if (done) return;
        done = true;
        if (fallbackTimer) {
            clearTimeout(fallbackTimer);
            fallbackTimer = null;
        }
        callback();
    };
    chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
            setTimeout(fire, 5000);
            return;
        }
        if (tab.status === 'complete') {
            setTimeout(fire, 1000);
            return;
        }
        const listener = (id, info) => {
            if (id === tabId && info.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(listener);
                if (fallbackTimer) {
                    clearTimeout(fallbackTimer);
                    fallbackTimer = null;
                }
                setTimeout(fire, 1000);
            }
        };
        chrome.tabs.onUpdated.addListener(listener);
        fallbackTimer = setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            fire();
        }, 20000);
    });
}

function initializeGreetingRun() {
    if (isProcessing && isOrderMode(currentBotMode)) return;
    _startBotLock = false; // real flags выставлены — lock больше не нужен
    isProcessing = true;
    isLoopRunning = true;
    isMainLoopRunning = true;
    isSleeping = false;
    greetingEmptyScanCount = 0;
    void getFulfillCount().then((c) => {
        const hint = c.manualOffset > 0 ? ` (в т.ч. +${c.manualOffset} вручную)` : '';
        log(`🚀 Автовыдача запущена! Лимит: ${c.today}/${FULFILL_DAILY_LIMIT} за сегодня${hint}.`);
    });
    setStore({ isRunning: true, mainTabId: mainTabId }).then(() => { });
    chrome.runtime.sendMessage({ action: 'UPDATE_MODE', mode: 'Автовыдача' });
    // Фиксируем момент старта — shadow monitor будет игнорировать сообщения старше этого момента
    botStartTime = Date.now();
    // Проверяем сессию с задержкой: дать bridge tab время полностью инициализироваться
    setTimeout(() => checkViewerSession().catch(() => { }), 4000);
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    heartbeatTimer = setInterval(fulfillHeartbeat, HEARTBEAT_INTERVAL_MS);
    if (shadowMonitorInterval) clearInterval(shadowMonitorInterval);
    shadowMonitorInterval = setInterval(() => {
        if (!isMainLoopRunning) return;
        runShadowMonitor().catch(e => console.warn('ShadowMonitor interval:', e?.message));
    }, SHADOW_MONITOR_INTERVAL_MS);
    runStableMainLoop();
}

async function runStableMainLoop() {
    console.log('🚀 ЗАПУСК БОТА (V5 Stable)...');
    while (isMainLoopRunning) {
        try {
            console.log("--- 🔄 НОВЫЙ ЦИКЛ ---");
            await runShadowMonitor();
            console.log("📡 Сканирование активных заказов...");
            const orders = await apiScanOrders();
            if (orders && orders.length > 0) await addOrdersFromApi(orders);
        } catch (err) {
            console.error('🔥 CRITICAL LOOP ERROR:', err);
            await sleep(5000);
        }
        if (!isMainLoopRunning) break;
        const settings = await new Promise(r => chrome.storage.local.get(['minDelay', 'maxDelay'], r));
        const min = Math.max(5, parseInt(settings.minDelay, 10) || 7);
        const max = Math.max(min, parseInt(settings.maxDelay, 10) || 12);
        const delay = Math.floor(Math.random() * (max - min + 1) + min) * 1000;
        console.log(`💤 Сплю ${(delay / 1000).toFixed(0)} сек...`);
        await sleep(delay);
    }
    console.log('🛑 Бот остановлен.');
}

async function hasOrderInSendingGreeting() {
    const s = await getStore();
    return Object.values(s.orders || {}).some(o => o.status === ORDER_STATUS.SENDING_GREETING);
}

function scheduleNextOrderScan(fixedDelayMs) {
    if (!isLoopRunning) return;
    getStore().then(s => {
        if (!s.isRunning || !isProcessing) return;
        if (fixedDelayMs != null) {
            setTimeout(triggerOrderScan, fixedDelayMs);
            return;
        }
        getScanDelayMs().then(delay => {
            if (!isLoopRunning) return;
            console.log(`💤 Сплю ${(delay / 1000).toFixed(0)} сек...`);
            log(`💤 Сплю ${(delay / 1000).toFixed(0)} сек...`);
            setTimeout(triggerOrderScan, delay);
        }).catch(() => { if (isLoopRunning) setTimeout(triggerOrderScan, 10000); });
    }).catch(() => { if (isLoopRunning) setTimeout(triggerOrderScan, 10000); });
}

function triggerOrderScan() {
    if (!isProcessing || isSleeping) return;
    hasOrderInSendingGreeting().then(inSending => {
        if (inSending) {
            scheduleNextOrderScan(CHECK_CHAT_INTERVAL);
            return;
        }
        if (USE_API_MODE) {
            if (apiPausedUntil > Date.now()) {
                scheduleNextOrderScan(CHECK_ORDERS_INTERVAL);
                return;
            }
            apiScanOrders()
                .then((orders) => (orders && orders.length > 0 ? addOrdersFromApi(orders) : null))
                .then(() => scheduleNextOrderScan())
                .catch(() => scheduleNextOrderScan(CHECK_ORDERS_INTERVAL));
        } else doTriggerOrderScan();
    }).catch(() => { if (isProcessing) scheduleNextOrderScan(CHECK_ORDERS_INTERVAL); });
}

async function mergeOrderFromApiScan(apiOrder) {
    const orderUrl = apiOrder.orderUrl || `https://playerok.com/deal/${apiOrder.orderId}`;
    const s = await getStore();
    let queue = [...(s.queue || [])];
    const orders = { ...(s.orders || {}) };
    const existing = orders[orderUrl];

    if (apiOrder.credentialsSent) {
        processingOrders.add(apiOrder.orderId);
        cappedSetAdd(processedDeals, apiOrder.orderId, 2000);
        saveProcessedDeals();
        if (apiOrder.buyerName) processingUsers.add(apiOrder.buyerName);
    }

    if (!existing) {
        if (processedOrders.has(orderUrl)) return;
        if (!queue.includes(orderUrl)) queue.push(orderUrl);
        const status = apiOrder.credentialsSent ? ORDER_STATUS.WAITING_2FA : ORDER_STATUS.NEW;
        orders[orderUrl] = {
            orderUrl,
            orderId: apiOrder.orderId,
            chatId: apiOrder.chatId,
            buyerName: apiOrder.buyerName,
            gameTitle: apiOrder.gameTitle,
            status,
            tabIds: {},
            steamPassUrl: STEAMPASS_URL,
            createdAt: Date.now(),
            statusUpdatedAt: Date.now()
        };
        await setStore({ queue, orders });
        if (apiOrder.chatId) await registerChatForMonitor(apiOrder.chatId);
        if (apiOrder.credentialsSent && apiOrder.chatId && apiOrder.orderId) {
            await chrome.storage.local.set({ [`deal_for_chat_${apiOrder.chatId}`]: apiOrder.orderId });
        }
        return;
    }

    const patch = {
        orderId: apiOrder.orderId,
        chatId: apiOrder.chatId || existing.chatId,
        buyerName: apiOrder.buyerName || existing.buyerName,
        gameTitle: apiOrder.gameTitle || existing.gameTitle,
        statusUpdatedAt: Date.now()
    };
    if (apiOrder.credentialsSent) patch.status = ORDER_STATUS.WAITING_2FA;
    orders[orderUrl] = { ...existing, ...patch };
    await setStore({ orders });
    if (apiOrder.chatId) await registerChatForMonitor(apiOrder.chatId);
    if (apiOrder.credentialsSent && apiOrder.chatId && apiOrder.orderId) {
        await chrome.storage.local.set({ [`deal_for_chat_${apiOrder.chatId}`]: apiOrder.orderId });
    }
}

async function addOrdersFromApi(apiOrders) {
    if (!apiOrders || apiOrders.length === 0) return;
    for (const o of apiOrders) await mergeOrderFromApiScan(o);
    const withCred = apiOrders.filter((o) => o.credentialsSent);
    if (withCred.length) {
        const x = withCred[0];
        log(`📡 API: ${withCred.length} заказ(ов) с выдачей; например [${x.gameTitle || '?'}] → [${x.buyerName || '?'}]`);
    }
}

function doTriggerOrderScan() {
    chrome.tabs.get(mainTabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
            chrome.tabs.query({ url: '*://*.playerok.com/*' }, (tabs) => {
                const salesTab = tabs.find(t => t.url?.includes('/sales') && !/\/sales\/\d+/.test(t.url)) || tabs.find(t => t.url?.includes('playerok.com'));
                if (salesTab) { mainTabId = salesTab.id; setStore({ mainTabId }); setTimeout(() => triggerOrderScan(), 2000); }
                else { log("❌ Вкладка заказов недоступна."); setTimeout(() => triggerOrderScan(), 5000); }
            });
            return;
        }
        if (tab.status !== 'complete') { setTimeout(() => triggerOrderScan(), 2000); return; }
        if (!tab.url?.includes('playerok.com')) { setTimeout(() => triggerOrderScan(), 5000); return; }

        chrome.tabs.sendMessage(mainTabId, { action: "PING" }, (res) => {
            if (chrome.runtime.lastError || !res) {
                chrome.scripting.executeScript({ target: { tabId: mainTabId, allFrames: true }, files: ['content_greeting.js'] })
                    .then(() => setTimeout(() => tryScanOrders(), 4000))
                    .catch(() => setTimeout(() => triggerOrderScan(), 5000));
            } else tryScanOrders();
        });
    });
}

function tryScanOrders() {
    chrome.tabs.sendMessage(mainTabId, { action: "SCAN_ORDERS" }, (scanRes) => {
        if (chrome.runtime.lastError || (scanRes?.status === 'error')) setTimeout(triggerOrderScan, 5000);
    });
}

async function addOrdersToQueue(orders) {
    if (!orders || orders.length === 0) {
        greetingEmptyScanCount++;
        const rescanDelay = 20000;
        const s = await getStore();
        const activeCount = await getActiveOrderCount();
        if (greetingEmptyScanCount >= 3 && activeCount === 0 && (Date.now() - lastGreetingReloadTime) > GREETING_RELOAD_COOLDOWN) {
            lastGreetingReloadTime = Date.now();
            greetingEmptyScanCount = 0;
            if (mainTabId) chrome.tabs.reload(mainTabId, {}, () => setTimeout(() => triggerOrderScan(), 5000));
        } else {
            setTimeout(() => triggerOrderScan(), rescanDelay);
        }
        return;
    }
    greetingEmptyScanCount = 0;
    const fresh = orders.filter(url => !processedOrders.has(url));
    const s = await getStore();
    const existing = Object.keys(s.orders || {});
    const unique = fresh.filter(url => !existing.includes(url) && !(s.queue || []).includes(url));
    if (unique.length === 0) {
        setTimeout(() => triggerOrderScan(), 25000);
        return;
    }
    for (const url of unique) await addOrderToQueue(url);
    log(`📦 Новых заказов: ${unique.length}. Очередь: ${(s.queue || []).length + unique.length}`);
    setTimeout(triggerOrderScan, 25000);
}

// ==========================================
// AUTO-BOOST (unchanged flow)
// ==========================================
function initializeRun() {
    // Load cumulative processed count from storage so "Поднято всего" accumulates across sessions.
    // Set lastBigSleepTotal to the loaded value so the batch-sleep check doesn't fire prematurely.
    chrome.storage.local.get(['processed'], (s) => {
        totalProcessed = Number(s['processed']) || 0;
        lastBigSleepTotal = totalProcessed;
    });
    _startBoostBotLock = false; // real flag выставлен — lock больше не нужен
    batchProcessed = 0;
    skippedItems = 0;
    activeTabs.clear();
    tabStartTimes = {};
    queue = [];
    isBoostRunning = true;   // независимый флаг — не isProcessing
    isSleeping = false;
    isScanning = false;
    isInjecting = false;
    nextScanTime = 0;
    pendingTabsCount = 0;
    emptyScanCount = 0;
    lastHeartbeat = Date.now();
    lastSuccessTime = Date.now();
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    updateStatusUI();
    boostLog("🚀 Бот запущен (Автопубликация)");
    boostFocusHintLogged = false;
    if (boostMainTabId) {
        try {
            chrome.tabs.update(boostMainTabId, { autoDiscardable: false }, () => { });
        } catch (_) { }
    }
    chrome.storage.local.set({ isBoostRunning: true });
    triggerScan();
}

async function triggerScan() {
    if (!isBoostRunning || !boostMainTabId || isScanning || isInjecting) {
        if (isBoostRunning) console.log(`[DEBUG] triggerScan skipped.`);
        return;
    }
    isScanning = true;

    chrome.tabs.get(boostMainTabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
            boostLog("❌ Вкладка не найдена, останавливаю бота.");
            stopBoost();
            return;
        }
        chrome.storage.local.get(['boostIncludeDrafts', 'boostFocusPlayerokTab'], (stor) => {
            const includeDrafts = !!stor.boostIncludeDrafts;
            const focusPlayerok = !!stor.boostFocusPlayerokTab;

            const pingAndScan = () => {
                const sendPing = () => {
                    chrome.tabs.sendMessage(boostMainTabId, { action: "PING" }, (res) => {
                        const err = chrome.runtime.lastError;
                        if (!res || res.status !== 'PONG') {
                            const reason = err ? err.message : (res ? JSON.stringify(res) : 'no response');
                            boostLog(`⚠️ Скрипт-шпион не отвечает (${reason}). Пробую внедрить...`);
                            injectAndRetry(boostMainTabId);
                        } else {
                            boostLog(`🔌 Подключение установлено. Отправляю SCAN...`);
                            chrome.tabs.sendMessage(boostMainTabId, {
                                action: "SCAN",
                                depthHint: emptyScanCount,
                                includeDrafts
                            }, (scanRes) => {
                                const scanErr = chrome.runtime.lastError;
                                if (scanErr) {
                                    boostLog(`⚠️ Ошибка SCAN: ${scanErr.message}`);
                                    isScanning = false;
                                } else if (scanRes && scanRes.status === 'WRONG_PAGE') {
                                    boostLog(`⚠️ Не та страница, ожидаю...`);
                                    isScanning = false;
                                } else {
                                    boostLog(`✅ Сканирование запущено.`);
                                }
                            });
                        }
                    });
                };
                // Проактивно внедряем content.js (guard в скрипте от дублей) — убирает первый PING «Receiving end does not exist»
                chrome.scripting.executeScript({ target: { tabId: boostMainTabId }, files: ['content.js'] })
                    .catch(() => { })
                    .finally(() => {
                        const ms = focusPlayerok ? 220 : 90;
                        setTimeout(sendPing, ms);
                    });
            };

            if (focusPlayerok && tab.windowId != null) {
                if (!boostFocusHintLogged) {
                    boostLog(`👁 Фокус на вкладку товаров (настройка включена; дальше без повторов в этом запуске).`);
                    boostFocusHintLogged = true;
                }
                chrome.windows.update(tab.windowId, { focused: true }, () => {
                    chrome.tabs.update(boostMainTabId, { active: true }, () => {
                        setTimeout(pingAndScan, focusPlayerok ? 650 : 0);
                    });
                });
            } else {
                pingAndScan();
            }
        });
    });
}



function injectAndRetry(tabId) {
    if (isInjecting) return;
    isInjecting = true;
    isScanning = false;
    chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
        .then(() => {
            boostLog("✅ Скрипт внедрен успешно! Пробую снова...");
            retryTimer = setTimeout(() => { isInjecting = false; triggerScan(); }, 1200);
        })
        .catch((e) => {
            boostLog(`❌ Ошибка внедрения: ${e.message}`);
            isInjecting = false;
            if (isBoostRunning) setTimeout(triggerScan, 1200);
        });
}

function stopBot() {
    _startBotLock = false;
    isProcessing = false;
    isLoopRunning = false;
    isMainLoopRunning = false;
    isSleeping = false;
    isScanning = false;
    isInjecting = false;
    // publisherRunning НЕ сбрасываем здесь — publisher управляется независимо через STOP_PUBLISHER.
    // Автовыдача и создание товаров могут работать одновременно.
    isCompletedDeleteRunning = false;
    completedDeleteEmptyRounds = 0;
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (shadowMonitorInterval) { clearInterval(shadowMonitorInterval); shadowMonitorInterval = null; }
    // steampassKeepAliveTimer — глобальный, не останавливается при STOP (сессия нужна и в паузе)
    cancelSleeps(); // Immediately wake up from any sleep(ms) — loops exit via isMainLoopRunning/isProcessing/publisherRunning checks
    setStore({ isRunning: false });
    activeTabs.forEach(tid => chrome.tabs.sendMessage(tid, { action: "GLOBAL_STOP" }).catch(() => { }));
    if (mainTabId) {
        chrome.tabs.sendMessage(mainTabId, { action: "GLOBAL_STOP" }).catch(() => { });
        try {
            chrome.tabs.update(mainTabId, { autoDiscardable: true }, () => { });
        } catch (_) { }
    }

    getStore().then(s => {
        const orders = s.orders || {};
        Object.values(orders).forEach(o => cleanupOrderTabs(o));
    });

    activeTabs.clear();
    processingUsers.clear();
    tabStartTimes = {};
    queue = [];
    bumpInFlightUrls.clear();
    nextScanTime = 0;
    pendingTabsCount = 0;
    clearTimeout(scanTimer);
    clearTimeout(retryTimer);

    chrome.storage.local.set({ isRunning: false, status: "Остановлен", currentMode: "Остановлен" });
    log("🛑 Бот остановлен");
}

// ==========================================
// BOOST INDEPENDENT LOOP
// Отдельный цикл автопубликации (буста), работает параллельно с автовыдачей.
// Использует isBoostRunning (не isProcessing), boostMainTabId (не mainTabId),
// boostLog (пишет в boostLogs, не logs).
// ==========================================

let _boostLogWriting = false;
let _pendingBoostLogs = [];

function _boostEventCategory(msg) {
    if (/черновик|draft/i.test(msg))          return 'drafts';
    if (/завершённ|завершен|complete/i.test(msg)) return 'completed';
    if (/поднят|bump|буст|boost/i.test(msg))  return 'bump';
    if (/выложен|опублик|publish/i.test(msg)) return 'publish';
    if (/сканир|скан|scan/i.test(msg))        return 'scan';
    if (/сплю|sleep|пауза|задержк/i.test(msg)) return 'sleep';
    if (/запуск|старт|start|🚀/i.test(msg))   return 'start';
    if (/стоп|остановл|stop|🛑/i.test(msg))   return 'stop';
    if (/ошибк|error|❌/i.test(msg))          return 'error';
    if (/предупреждени|warn|⚠️/i.test(msg))  return 'warn';
    if (/dashboard|Dashboard/i.test(msg))     return 'dashboard';
    if (/api|API/i.test(msg))                 return 'api';
    return 'info';
}

function _boostEventLevel(msg) {
    if (/❌|ошибк|error/i.test(msg))           return 'error';
    if (/⚠️|предупреждени|warn/i.test(msg))   return 'warn';
    if (/✅|поднят|выложен|опублик|завершен/i.test(msg)) return 'success';
    if (/💤|сплю|sleep/i.test(msg))            return 'sleep';
    return 'info';
}

async function boostLog(msg) {
    const timestamp = new Date().toLocaleTimeString();
    _pendingBoostLogs.push(`[${timestamp}] ${msg}`);

    // Обновляем last-events (не ждём, fire-and-forget)
    const category = _boostEventCategory(msg);
    const level = _boostEventLevel(msg);
    chrome.storage.local.get(['boostLastEvents'], (r) => {
        const events = r.boostLastEvents || {};
        events[category] = { text: msg, time: timestamp, level };
        chrome.storage.local.set({ boostLastEvents: events });
    });

    if (_boostLogWriting) return;
    _boostLogWriting = true;
    try {
        while (_pendingBoostLogs.length > 0) {
            const batch = [..._pendingBoostLogs];
            _pendingBoostLogs = [];
            const result = await new Promise(r => chrome.storage.local.get(['boostLogs'], r));
            let logs = result.boostLogs || [];
            logs.push(...batch);
            if (logs.length > 50) logs = logs.slice(-50);
            await new Promise(r => chrome.storage.local.set({ boostLogs: logs }, r));
        }
    } finally {
        _boostLogWriting = false;
    }
}

function startBoostBot() {
    if (isBoostRunning || _startBoostBotLock) {
        boostLog('⚠️ Автопубликация уже запущена.');
        return;
    }
    _startBoostBotLock = true;
    lastProcessedTime = Date.now() - 3600000;

    function applyUsernameFromTabUrl(tabUrl) {
        const urlUsernameMatch = tabUrl.match(/playerok\.com\/profile\/([^/]+)\//);
        if (urlUsernameMatch && urlUsernameMatch[1]) {
            currentPlayerokUsername = urlUsernameMatch[1];
            chrome.storage.local.set({ playerokUsername: currentPlayerokUsername });
        }
    }

    pickPlayerokTabForBoost((tabId) => {
        boostMainTabId = tabId;
        waitForPlayerokNavigation(tabId, () => {
            chrome.tabs.get(tabId, (tab) => {
                if (chrome.runtime.lastError || !tab) {
                    _startBoostBotLock = false;
                    boostLog("❌ Вкладка Playerok недоступна.");
                    return;
                }
                boostMainTabId = tab.id;
                const tabUrl = tab.url || '';
                applyUsernameFromTabUrl(tabUrl);
                const homeUrl = getHomeUrl();
                if (isPlayerokErrorPageUrl(tabUrl)) {
                    boostLog('⚠️ Вкладка сканера на /404 — открываю список товаров.');
                }
                if (!tabUrl.includes('/products/completed') || isPlayerokErrorPageUrl(tabUrl)) {
                    chrome.tabs.update(boostMainTabId, { url: homeUrl });
                    waitForTabComplete(boostMainTabId, () => {
                        boostLog("📍 Страница товаров загружена.");
                        initializeRun();
                    });
                } else {
                    waitForTabComplete(boostMainTabId, initializeRun);
                }
            });
        });
    });
}

function stopBoost() {
    _startBoostBotLock = false;
    isBoostRunning = false;
    isSleeping = false;
    isScanning = false;
    isInjecting = false;
    activeTabs.forEach(tid => chrome.tabs.sendMessage(tid, { action: "GLOBAL_STOP" }).catch(() => { }));
    if (boostMainTabId) {
        chrome.tabs.sendMessage(boostMainTabId, { action: "GLOBAL_STOP" }).catch(() => { });
        try { chrome.tabs.update(boostMainTabId, { autoDiscardable: true }, () => { }); } catch (_) { }
        boostMainTabId = null;
    }
    activeTabs.clear();
    tabStartTimes = {};
    queue = [];
    bumpInFlightUrls.clear();
    nextScanTime = 0;
    pendingTabsCount = 0;
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    chrome.storage.local.set({ isBoostRunning: false });
    boostLog("🛑 Автопубликация остановлена");
}

function updateStatusUI() {
    chrome.storage.local.set({ status: `🚀 Очередь: ${queue.length} | Готово: ${batchProcessed} | Пропуск: ${skippedItems}` });
}

function addToQueue(items) {
    lastHeartbeat = Date.now();
    lastSuccessTime = Date.now(); // Keep watchdog alive if we are successfully scanning (even if 0 items)
    if (!items || items.length === 0) {
        emptyScanCount++;
        boostLog(`🔍 Поиск завершен. Товар со статусом 'Истек срок' не найден. Жду и обновляю... (${emptyScanCount})`);
        scheduleNextScan(4000 + Math.min(emptyScanCount * 2000, 10000));
        return;
    }
    const freshItems = items.filter(obj => {
        const urlStr = typeof obj === 'string' ? obj : obj.url;
        return !isBoostListingProcessed(urlStr);
    });
    const uniqueItems = freshItems.filter(obj => {
        const urlStr = typeof obj === 'string' ? obj : obj.url;
        const uq = normalizeBoostListingUrl(urlStr);
        return !queue.some(q => normalizeBoostListingUrl(typeof q === 'string' ? q : q.url) === uq);
    });

    if (uniqueItems.length === 0) {
        emptyScanCount++;
        if (items.length > 0 && freshItems.length === 0) {
            boostLog(`⚪ Найдено ${items.length} карточек; все в cooldown автоподнятия (~${Math.round(PROCESSED_LISTING_COOLDOWN_MS / 86400000)} сут. с последнего успеха) или уже в работе. Повтор сразу: кнопка «Сбросить историю автоподнятия» в панели. (${emptyScanCount})`);
        } else if (items.length > 0) {
            boostLog(`⚪ Найдено ${items.length} карточек, новые уже в очереди или совпадают с обработанными. Жду... (${emptyScanCount})`);
        } else {
            boostLog(`🔍 Поиск завершен. Новых товаров нет. Жду и обновляю... (${emptyScanCount})`);
        }
        scheduleNextScan(4000 + Math.min(emptyScanCount * 2000, 10000));
        return;
    }

    emptyScanCount = 0;

    const toAdd = uniqueItems.slice(0, BATCH_LIMIT_BIG - queue.length);
    if (toAdd.length > 0) {
        queue.push(...toAdd);
        boostLog(`🏁 Добавлено: ${toAdd.length}. Очередь: [${queue.length}] товаров`);
    }
    updateStatusUI();

    if (queue.length >= BATCH_LIMIT_BIG) {
        if (boostMainTabId) chrome.tabs.sendMessage(boostMainTabId, { action: "STOP_SCANNING" }).catch(() => { });
    }

    if (queue.length > 0) {
        processNextItem();
    }
}

function scheduleNextScan(ms) {
    if (!isBoostRunning) return;
    nextScanTime = Date.now() + ms;
    scanTimer = setTimeout(() => {
        if (!boostMainTabId) {
            triggerScan();
            return;
        }
        chrome.tabs.get(boostMainTabId, (tab) => {
            if (chrome.runtime.lastError || !tab) {
                triggerScan();
                return;
            }
            const u = tab.url || '';
            if (isPlayerokErrorPageUrl(u)) {
                boostLog('⚠️ Сканер на /404 — перехожу на список товаров вместо reload.');
                chrome.tabs.update(boostMainTabId, { url: getHomeUrl() }, () => {
                    waitForTabComplete(boostMainTabId, () => setTimeout(triggerScan, 1500));
                });
                return;
            }
            chrome.tabs.reload(boostMainTabId, {}, () => setTimeout(triggerScan, 4000));
        });
    }, ms);
}

async function apiBumpProduct(itemId, obtainingTypeId, rawPrice = 0) {
    const MUTATION_VALIDATE = `mutation validateItemData($input: ValidateItemDataInput!) { validateItemData(input: $input) }`;
    const MUTATION_PUBLISH = `mutation publishItem($input: PublishItemInput!) {
  publishItem(input: $input) {
    id
  }
}`;
    const QUERY_PRIORITY_STATUSES = `query itemPriorityStatuses($itemId: UUID!, $price: NonNegativeFloat!) {
  itemPriorityStatuses(itemId: $itemId, price: $price) {
    id
    price
  }
}`;

    try {
        // Step 1: Get the free priority status UUID dynamically
        let freeStatusId = null;

        try {
            const lotRub = rawPrice > 0 ? Math.round(Number(rawPrice)) : null;
            const pricesToTry = [0, rawPrice > 0 ? rawPrice : null].filter(p => p !== null);
            for (const p of pricesToTry) {
                const psData = await playerokApi('itemPriorityStatuses', QUERY_PRIORITY_STATUSES, { itemId, price: p });
                const statuses = psData?.itemPriorityStatuses || [];
                const slotPrices = statuses.map(s => {
                    const rub = s.price;
                    const n = rub === null || rub === undefined ? 0 : Number(rub);
                    return `${n}₽`;
                }).join(', ');
                const hintLab = p === 0
                    ? 'подсказка 0 (стандартный запрос бесплатного статуса)'
                    : `подсказка ${p} (по цене лота)`;
                boostLog(`📋 itemPriorityStatuses: ${hintLab}; цена лота из API: ${lotRub != null ? lotRub + ' ₽' : '—'} | ответ: ${statuses.length} слот. → ${slotPrices} (это тарифы поднятия, не цена товара)`);
                const found = statuses.find(s => s.price === 0 || s.price === null);
                if (found) { freeStatusId = found.id; boostLog(`✅ UUID найден динамически: ${found.id.substring(0, 8)}...`); break; }
            }
        } catch (e) {
            boostLog(`⚠️ itemPriorityStatuses: ${e.message}`);
        }

        if (!freeStatusId) {
            boostLog(`🚨 СТОП: Бесплатный статус не найден для этого товара! Отмена.`);
            return { error: "NO_FREE_STATUS" };
        }

        // Step 2: validateItemData — activates publish session
        const obtainingId = obtainingTypeId || "1ee8a458-c783-6a10-e546-9b7c5400cad0";
        try {
            await playerokApi('validateItemData', MUTATION_VALIDATE, {
                input: { itemId, obtainingTypeId: obtainingId }
            });
            boostLog(`✅ validateItemData OK`);
        } catch (e) {
            boostLog(`⚠️ validateItemData: ${e.message}`);
        }

        await sleep(1200);

        // Step 3: publishItem LOCAL (free)
        boostLog(`📡 publishItem LOCAL, priorityStatuses=[${freeStatusId.substring(0, 8)}...]`);
        await playerokApi('publishItem', MUTATION_PUBLISH, {
            input: {
                itemId: itemId,
                transactionProviderId: "LOCAL",
                priorityStatuses: [freeStatusId]
            }
        });
        return { ok: true };
    } catch (e) {
        const msg = e.message || '';
        // Item already active/sold/wrong state — skip it (not a real error)
        if (msg.includes('нельзя обновить') || msg.includes('cannot update')) {
            boostLog(`⏭️ Пропускаю (товар уже активен/продан): ${msg.substring(0, 80)}`);
            return { ok: true, skipped: true };
        }
        // Any other error (wrong UUID, API error, etc.) — real failure
        return { error: msg };
    }
}

/** Платное поднятие (Премиум и т.п.): validateItemData → itemPriorityStatuses → increaseItemPriorityStatus (или publishItem). */
async function apiPaidPriorityBump(itemId, rawPrice = 0) {
    const MUTATION_VALIDATE = `mutation validateItemData($input: ValidateItemDataInput!) { validateItemData(input: $input) }`;
    const QUERY_PRIORITY_STATUSES = `query itemPriorityStatuses($itemId: UUID!, $price: NonNegativeFloat!) {
  itemPriorityStatuses(itemId: $itemId, price: $price) {
    id
    name
    price
  }
}`;
    const MUTATION_INCREASE = `mutation increaseItemPriorityStatus($input: PublishItemInput!) {
  increaseItemPriorityStatus(input: $input) {
    id
    __typename
  }
}`;
    const MUTATION_PUBLISH_PAID = `mutation publishItem($input: PublishItemInput!) {
  publishItem(input: $input) {
    id
    __typename
  }
}`;

    // Step 1: activate validate session (now returns Boolean, no subfields)
    try {
        await playerokApi('validateItemData', MUTATION_VALIDATE, { input: { itemId } });
        boostLog(`✅ validateItemData OK`);
    } catch (e) {
        return { ok: false, error: e.message || 'validateItemData failed' };
    }

    await sleep(600);

    // Step 2: get available priority statuses via separate query
    let statuses = [];
    const lotRubPaid = rawPrice > 0 ? Math.round(Number(rawPrice)) : null;
    const pricesToTry = [rawPrice > 0 ? rawPrice : null, 0].filter(p => p !== null);
    for (const p of pricesToTry) {
        try {
            const psData = await playerokApi('itemPriorityStatuses', QUERY_PRIORITY_STATUSES, { itemId, price: p });
            const list = psData?.itemPriorityStatuses || [];
            const slotPrices = list.map(s => `${Number(s.price) || 0}₽`).join(', ');
            const hintLab = p === 0 ? 'подсказка 0' : `подсказка ${p} (цена лота)`;
            boostLog(`📋 itemPriorityStatuses: ${hintLab}; лот ${lotRubPaid != null ? lotRubPaid + ' ₽' : '—'} | ${list.length} слот.: ${slotPrices} (тарифы приоритета)`);
            if (list.length > 0) { statuses = list; break; }
        } catch (e) {
            boostLog(`⚠️ itemPriorityStatuses(price=${p}): ${e.message}`);
        }
    }

    // Step 3: choose cheapest paid status
    const paid = statuses.filter(s => s.price !== null && s.price !== undefined && Number(s.price) > 0);
    let chosen = paid.find(s => /премиум|premium|вип|vip|платн|топ/i.test(String(s.name || '')));
    if (!chosen && paid.length) {
        chosen = paid.slice().sort((a, b) => Number(a.price) - Number(b.price))[0];
    }
    if (!chosen) {
        return {
            ok: false,
            error: 'Нет платных статусов для этого лота. Откройте карточку на Playerok и проверьте «Поднять в топ».'
        };
    }

    const priceRub = Math.round(Number(chosen.price));
    boostLog(`💳 Выбран статус: ${chosen.name || chosen.id.slice(0, 8)} — ${priceRub} ₽`);
    const input = {
        itemId,
        transactionProviderId: 'LOCAL',
        priorityStatuses: [chosen.id]
    };

    // Step 4: apply bump
    try {
        await playerokApi('increaseItemPriorityStatus', MUTATION_INCREASE, { input });
        boostLog(`✅ increaseItemPriorityStatus (${priceRub} ₽)`);
        return { ok: true, priceRub };
    } catch (e1) {
        const m1 = e1.message || '';
        boostLog(`⚠️ increaseItemPriorityStatus: ${m1} — пробую publishItem`);
        try {
            await playerokApi('publishItem', MUTATION_PUBLISH_PAID, { input });
            boostLog(`✅ publishItem (платный статус, ${priceRub} ₽)`);
            return { ok: true, priceRub };
        } catch (e2) {
            return { ok: false, error: (m1 || '') + ' · ' + (e2.message || '') };
        }
    }
}

function dashboardPaidBoostShouldRemove(p, payload) {
    if (!payload) return false;
    if (payload.publishedId && p.id) return p.id === payload.publishedId;
    if (payload.publishedId && !p.id) return false;
    const u1 = normalizeProductPageUrl(p.url || '');
    const u2 = normalizeProductPageUrl(payload.url || '');
    return !!(u1 && u2 && u1 === u2 && Number(p.at) === Number(payload.at));
}

async function dashboardRecordPaidBoostAndRemovePublished(payload, priceRub) {
    const raw = await new Promise(r => chrome.storage.local.get([DASHBOARD_PUBLISHED_KEY, DASHBOARD_BOOST_KEY], o => r(o)));
    let pub = Array.isArray(raw[DASHBOARD_PUBLISHED_KEY]) ? raw[DASHBOARD_PUBLISHED_KEY] : [];
    pub = pub.filter((p) => !dashboardPaidBoostShouldRemove(p, payload));
    const boosts = Array.isArray(raw[DASHBOARD_BOOST_KEY]) ? raw[DASHBOARD_BOOST_KEY] : [];
    const urlNorm = normalizeProductPageUrl(payload.url || '') || (payload.url || '');
    const entry = {
        id: `boost_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        at: Date.now(),
        url: urlNorm,
        title: String(payload.title || '').trim(),
        rub: Math.max(0, Math.round(Number(priceRub) || 0))
    };
    boosts.unshift(entry);
    await chrome.storage.local.set({
        [DASHBOARD_PUBLISHED_KEY]: pub.slice(0, DASHBOARD_MAX_ROWS),
        [DASHBOARD_BOOST_KEY]: boosts.slice(0, DASHBOARD_MAX_ROWS)
    });
    log(`[Dashboard] ✅ Платный буст ${entry.rub} ₽ → ручной буст, лот убран из опубликованных`);
}


/** Платный буст на странице Playerok → список «Ручной буст» (перехват increaseItemPriorityStatus). */
async function appendDashboardSiteBoostRecord({ href, itemId, priceRub }) {
    const target = normalizeProductPageUrl(href);
    if (!target || !target.includes('/products/')) return;
    const slug = target.split('/').pop() || '';
    const titleGuess = slug ? decodeURIComponent(slug).replace(/-/g, ' ') : 'Буст на сайте';
    const raw = await new Promise(r => chrome.storage.local.get(DASHBOARD_BOOST_KEY, o => r(o)));
    const arr = Array.isArray(raw[DASHBOARD_BOOST_KEY]) ? raw[DASHBOARD_BOOST_KEY] : [];
    const now = Date.now();
    const rub = Math.max(0, Math.round(Number(priceRub) || 0));
    const dup = arr.find((e) => {
        const eu = normalizeProductPageUrl(e.url || '');
        return eu === target && (now - (Number(e.at) || 0)) < 15000;
    });
    if (dup) {
        log('[Dashboard] Дубликат буста с сайта (15 с) — пропуск');
        return;
    }
    arr.unshift({
        id: 'site_' + now + '_' + Math.random().toString(36).slice(2, 9),
        at: now,
        url: target,
        title: titleGuess,
        rub
    });
    await chrome.storage.local.set({ [DASHBOARD_BOOST_KEY]: arr.slice(0, DASHBOARD_MAX_ROWS) });
    log('[Dashboard] Буст с сайта записан: ' + rub + ' ₽');
}







async function processNextItem() {
    if (!isBoostRunning || isSleeping) return;
    if (queue.length === 0) {
        scheduleNextScan(1000);
        return;
    }
    if (totalProcessed > 0 && totalProcessed % BATCH_LIMIT_BIG === 0 && totalProcessed !== lastBigSleepTotal) {
        lastBigSleepTotal = totalProcessed;
        performSleep(SLEEP_DURATION_SECONDS * 1000, `💤 Партия готова. Отдых ${SLEEP_DURATION_SECONDS}с...`);
        return;
    }
    if (isBumping) return;
    isBumping = true;

    try {
        while (queue.length > 0 && isBoostRunning && !isSleeping) {
            const itemObj = queue.shift();
            const url = typeof itemObj === 'string' ? itemObj : itemObj.url;
            const urlKey = normalizeBoostListingUrl(url);
            const slug = urlKey.split('/').filter(Boolean).pop() || '';

            bumpInFlightUrls.add(urlKey);
            try {
                let itemId = typeof itemObj === 'string' ? null : itemObj.itemId;
                let obtainingTypeId = typeof itemObj === 'string' ? '' : (itemObj.obtainingTypeId || '');
                let rawPrice = typeof itemObj === 'string' ? 0 : (itemObj.rawPrice || 0);

                if (!itemId) {
                    boostLog(`🔍 Поищу UUID через GraphQL для ${slug.substring(0, 8)}...`);
                    await sleep(1500);
                    if (!isBoostRunning) break;
                    let attempts = 0;
                    while (attempts < 3 && isBoostRunning) {
                        try {
                            const data = await playerokApi('item', QUERY_ITEM_BY_SLUG, { slug });
                            itemId = data?.item?.id || '';
                            obtainingTypeId = data?.item?.obtainingType?.id || '';
                            rawPrice = data?.item?.rawPrice || 0;
                            boostLog(`🔑 ObtainingType: ${obtainingTypeId.substring(0, 8) || 'пусто'}, Price: ${rawPrice}`);
                            break;
                        } catch (e) {
                            const msg = e.message || '';
                            if (msg.includes('429') || msg.includes('Too many requests')) {
                                boostLog(`⚠️ Playerok API устал (429 Too Many Requests). Ждем 15 секунд...`);
                                await sleep(15000);
                                if (!isBoostRunning) break;
                                attempts++;
                            } else {
                                boostLog(`❌ GraphQL item query: ${msg}`);
                                break;
                            }
                        }
                    }
                }

                if (!itemId) {
                    boostLog(`❌ Не удалось получить UUID для ${slug.substring(0, 8)}`);
                    continue;
                }

                if (obtainingTypeId) {
                    const premiumTypes = ["1f000196", "1f0bfa0b", "1f0b4a02"];
                    if (premiumTypes.some(pt => obtainingTypeId.startsWith(pt))) {
                        boostLog(`⏭️ Пропускаю платную (GraphQL): ${url}`);
                        markBoostListingProcessed(urlKey);
                        continue;
                    }
                }

                const delay = await getScanDelayMs();
                boostLog(`⏳ Жду ${(delay / 1000).toFixed(1)} сек перед поднятием...`);
                await sleep(delay);
                if (!isBoostRunning) break;
                lastSuccessTime = Date.now();

                boostLog(`🚀 API Поднятие: ${itemId.substring(0, 8)}...`);

                const res = await apiBumpProduct(itemId, obtainingTypeId, rawPrice);

                totalProcessed++;
                batchProcessed++;
                lastSuccessTime = Date.now();

                if (res.ok && !res.skipped) {
                    markBoostListingProcessed(urlKey);
                    boostLog(`✅ Успех: Товар поднят! ${url}`);
                    incrementDailyPair(DAILY_BOOST_BUMPS_KEY, DAILY_BOOST_BUMPS_DATE_KEY);
                    promoteDashboardDraftToPublishedByProductUrl(url, 'bump', { itemId, rawPrice })
                        .catch(e => boostLog(`[Dashboard] promote bump: ${e.message}`));
                } else if (res.ok && res.skipped) {
                    markBoostListingProcessed(urlKey);
                    boostLog(`⏭️ Уже активен/пропуск API: ${url}`);
                } else if (!res.ok) {
                    boostLog(`❌ Ошибка API: ${res.error} | ${url}`);
                    if (res.error === 'NO_FREE_STATUS') {
                        markBoostListingProcessed(urlKey);
                    }
                }

                chrome.storage.local.set({ processed: totalProcessed, batch: batchProcessed });
                updateStatusUI();

                if (totalProcessed % BATCH_LIMIT_BIG === 0) {
                    isBumping = false;
                    processNextItem();
                    return;
                }
            } finally {
                bumpInFlightUrls.delete(urlKey);
            }
        }
    } finally {
        isBumping = false;
        setTimeout(processNextItem, 1000);
    }
}

async function performSleep(ms, msg) {
    if (isSleeping) return;
    isSleeping = true;
    boostLog(msg);
    nextScanTime = Date.now() + ms;
    await sleep(ms);
    if (!isBoostRunning) {
        boostLog("🛑 Отдых прерван.");
        return;
    }
    boostLog("⏰ Отдых завершен.");
    isSleeping = false;
    nextScanTime = 0;
    if (boostMainTabId) chrome.tabs.reload(boostMainTabId, {}, () => setTimeout(triggerScan, 3000));
    else triggerScan();
}



function handleItemDone(success, tabId, url, instantNext = false, dashboardPromoteMode = null) {
    if (success && url && dashboardPromoteMode) {
        promoteDashboardDraftToPublishedByProductUrl(url, dashboardPromoteMode).catch(e => boostLog(`[Dashboard] promote: ${e.message}`));
    }
    if (success && url) markBoostListingProcessed(url);
    if (activeTabs.has(tabId)) {
        activeTabs.delete(tabId);
        delete tabStartTimes[tabId];
        chrome.tabs.remove(tabId, () => { });
        if (success) { totalProcessed++; batchProcessed++; lastSuccessTime = Date.now(); chrome.storage.local.set({ processed: totalProcessed, batch: batchProcessed }); }
        updateStatusUI();
        if (instantNext) processNextItem();
        else setTimeout(() => processNextItem(), random(10000, 15000));
    }
}

// Broadcast Timer
setInterval(() => {
    if (nextScanTime > 0) {
        const diff = Math.ceil((nextScanTime - Date.now()) / 1000);
        if (diff >= 0) chrome.runtime.sendMessage({ action: 'TIMER_UPDATE', seconds: diff }).catch(() => { });
    }
}, 1000);

// GLOBAL WATCHDOG (автопубликация)
setInterval(() => {
    if (!isBoostRunning || isSleeping) return;
    if (Date.now() - lastSuccessTime > WATCHDOG_TIMEOUT) {
        boostLog("💀 WATCHDOG: Хард Ресет!");
        activeTabs.forEach(tid => chrome.tabs.remove(tid).catch(() => { }));
        activeTabs.clear();
        tabStartTimes = {};
        queue = [];
        pendingTabsCount = 0;
        isScanning = false;
        isInjecting = false;
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
        lastSuccessTime = Date.now();
        if (boostMainTabId) {
            chrome.tabs.update(boostMainTabId, { url: getHomeUrl() }, () => {
                // Wait for page load, then restart scan (NOT startBot to avoid duplicate cycles)
                waitForTabComplete(boostMainTabId, () => {
                    boostLog("📍 Страница обновлена после Watchdog.");
                    initializeRun();
                });
            });
        }
    }
}, 30000);

setInterval(() => {
    if (!isBoostRunning) return;
    const now = Date.now();
    activeTabs.forEach(tabId => {
        if (now - tabStartTimes[tabId] > TIMEOUT_MS) { boostLog(`⏰ Таймаут вкладки ${tabId}`); handleItemDone(false, tabId); }
    });
}, 5000);

// Инициализация при загрузке SW — функции определены выше
loadProcessedUrls();
loadGreetingData();
