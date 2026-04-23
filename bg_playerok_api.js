// ==========================================
// bg_playerok_api.js
// ����������� ������� (����� bg_constants.js, bg_tab_manager.js).
// Playerok GraphQL bridge:
//   � bridge tab lifecycle (ensurePlayerokTab, saveBridgeTabId, pingBridge)
//   � playerokApi / playerokApiQueued / playerokApiFile / playerokApiCanvas
//   � Steam & image asset resolution (getCardAssets � helpers)
//   � Chat/spy API (fetchChatsViaBridge, fetchAllChatsFromSpy, fetchChatHistoryHTML)
//   � Base API callers: apiGetDealDetails, checkViewerSession, registerChatForMonitor
// ������ � ����������� ������ background.js ����� ����� ����� importScripts.
// ==========================================
// ==========================================
// PLAYEROK API (Bridge Pattern)
// ==========================================
const PLAYEROK_SALES_URL = 'https://playerok.com/my/sales';
let apiPausedUntil = 0;
let currentUserId = null;
let bridgeTabId = null;

const BRIDGE_TAB_TIMEOUT_MS = 6000;
const BRIDGE_TAB_LOAD_MS = 9000;
/** Не перезагружать вкладку-бридж чаще, чем раз в N мс при ретраях API (иначе «мигает» окно). */
let _playerokBridgeLastReloadMs = 0;
const PLAYEROK_BRIDGE_RELOAD_MIN_GAP_MS = 10000;

async function reloadBridgeTabThrottled(tabId) {
    const now = Date.now();
    if (now - _playerokBridgeLastReloadMs >= PLAYEROK_BRIDGE_RELOAD_MIN_GAP_MS) {
        _playerokBridgeLastReloadMs = now;
        await chrome.tabs.reload(tabId);
        await sleep(2500);
        return;
    }
    await sleep(4000);
}

// Restore bridgeTabId across service worker restarts
chrome.storage.local.get(['bridgeTabId'], (res) => {
    if (res.bridgeTabId) bridgeTabId = res.bridgeTabId;
});
function saveBridgeTabId(id) {
    bridgeTabId = id;
    chrome.storage.local.set({ bridgeTabId: id });
}

// Ping the content bridge to check it's alive; returns true/false
function pingBridge(tabId, timeoutMs = 3000) {
    return new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        try {
            chrome.tabs.sendMessage(tabId, { action: 'PING' }, (resp) => {
                clearTimeout(timer);
                if (chrome.runtime.lastError || !resp) resolve(false);
                else resolve(resp.ok === true);
            });
        } catch (_) { clearTimeout(timer); resolve(false); }
    });
}

/**
 * Отдельное минимизированное окно для API при создании товаров — не использует mainTabId и не крадёт вкладки основного окна.
 * Может работать параллельно с автовыдачей — оба используют этот bridge через общий _apiMutexChain.
 */
let _publisherBridgeCreating = false;
async function ensurePublisherWorkerBridgeTab() {
    if (publisherWorkerWindowId == null) {
        const rw = await new Promise((r) => chrome.storage.local.get([PUBLISHER_WORKER_WINDOW_KEY], r));
        const wid = rw[PUBLISHER_WORKER_WINDOW_KEY];
        if (wid != null) {
            try {
                await chrome.windows.get(wid);
                publisherWorkerWindowId = wid;
            } catch (_) {
                publisherWorkerWindowId = null;
                chrome.storage.local.remove([PUBLISHER_WORKER_WINDOW_KEY]);
            }
        }
    }
    const scorePubUrl = (url) => {
        const u = url || '';
        if (u.includes('/products/completed') || u.includes('/my/products')) return 15;
        if (u.includes('/my/sales') || (u.includes('/sales') && !/\/sales\/\d+/.test(u))) return 12;
        if (u.includes('/profile/')) return 10;
        return 1;
    };
    const homeUrl = getHomeUrl() || 'https://playerok.com/';

    if (publisherWorkerWindowId == null) {
        // Guard: не создаём два окна одновременно при параллельных вызовах (fulfill + publisher)
        if (_publisherBridgeCreating) {
            for (let i = 0; i < 40 && publisherWorkerWindowId == null; i++) await sleep(300);
            if (publisherWorkerWindowId == null) throw new Error('Publisher bridge: timeout waiting for parallel init');
            // fall through — окно уже создано другим вызовом
        } else {
            _publisherBridgeCreating = true;
            try {
                log('🪟 Создание товаров: открываю отдельное минимизированное окно Playerok (GraphQL). Вкладки основного окна не использую.');
                const win = await chrome.windows.create({ url: homeUrl, state: 'minimized', focused: false });
                const tab = win.tabs?.[0];
                if (!tab?.id) throw new Error('Publisher bridge: не удалось создать окно');
                publisherWorkerWindowId = win.id;
                await new Promise((r) => chrome.storage.local.set({ [PUBLISHER_WORKER_WINDOW_KEY]: win.id }, r));
                saveBridgeTabId(tab.id);
                await sleep(BRIDGE_TAB_LOAD_MS);
                try {
                    const checkTab = await chrome.tabs.get(tab.id);
                    if (isPlayerokErrorPageUrl(checkTab.url || '')) {
                        await chrome.tabs.reload(tab.id);
                        await sleep(BRIDGE_TAB_LOAD_MS / 2);
                    }
                } catch (_) { /* ignore */ }
                return tab.id;
            } finally {
                _publisherBridgeCreating = false;
            }
        }
    }

    try {
        const workerTabs = await chrome.tabs.query({ windowId: publisherWorkerWindowId });
        let usable = (workerTabs || []).filter((t) => isUsablePlayerokScannerUrl(t.url || ''));
        usable.sort((a, b) => scorePubUrl(b.url) - scorePubUrl(a.url));
        for (const t of usable) {
            const alive = await pingBridge(t.id, 2500);
            if (alive) {
                saveBridgeTabId(t.id);
                return t.id;
            }
        }
        if (usable.length > 0) {
            log('🔄 Publisher bridge: перезагружаю вкладку в отдельном окне...');
            await chrome.tabs.reload(usable[0].id);
            await sleep(BRIDGE_TAB_LOAD_MS);
            saveBridgeTabId(usable[0].id);
            return usable[0].id;
        }
        const created = await chrome.tabs.create({ windowId: publisherWorkerWindowId, url: homeUrl, active: false });
        if (!created?.id) throw new Error('Publisher bridge: не удалось создать вкладку');
        saveBridgeTabId(created.id);
        await sleep(BRIDGE_TAB_LOAD_MS);
        return created.id;
    } catch (e) {
        console.warn('[ensurePublisherWorkerBridgeTab]', e?.message);
        publisherWorkerWindowId = null;
        await new Promise((r) => chrome.storage.local.remove([PUBLISHER_WORKER_WINDOW_KEY], r));
        const win = await chrome.windows.create({ url: homeUrl, state: 'minimized', focused: false });
        const tab = win.tabs?.[0];
        if (!tab?.id) throw new Error('Publisher bridge: повторное создание окна не удалось');
        publisherWorkerWindowId = win.id;
        await new Promise((r) => chrome.storage.local.set({ [PUBLISHER_WORKER_WINDOW_KEY]: win.id }, r));
        saveBridgeTabId(tab.id);
        await sleep(BRIDGE_TAB_LOAD_MS);
        return tab.id;
    }
}

/** После публикации не держим bridge на вкладке окна publisher — следующий сценарий подстроит свой таб. */
async function clearPublisherBridgeTabIfDedicated() {
    if (!bridgeTabId || publisherWorkerWindowId == null) return;
    try {
        const t = await chrome.tabs.get(bridgeTabId);
        if (t && t.windowId === publisherWorkerWindowId) saveBridgeTabId(null);
    } catch (_) {
        saveBridgeTabId(null);
    }
}

async function ensurePlayerokTab() {
    // isMainLoopRunning — автовыдача реально запущена; без этого флага currentBotMode=AUTO_FULFILL
    // из прошлой сессии ложно включает dedicated-режим даже когда работает только буст.
    const dedicatedBridgeForFulfill = USE_API_MODE && isOrderMode(currentBotMode) && isMainLoopRunning && !isCompletedDeleteRunning;

    // Publisher always uses its own bridge — ignore dedicatedBridgeForFulfill when publisher is active
    if (publisherRunning && !isCompletedDeleteRunning) {
        return await ensurePublisherWorkerBridgeTab();
    }

    // Если идёт сбор каталога «Завершённые», используем уже открытую вкладку этого же окна.
    // Иначе первый GraphQL-запрос (viewer/Apollo) может открыть второй минимизированный Playerok-бридж.
    if (completedCatalogJob && completedCatalogJob.tabId) {
        try {
            const ct = await chrome.tabs.get(completedCatalogJob.tabId);
            if (ct && isUsablePlayerokScannerUrl(ct.url || '')) {
                const alive = await pingBridge(completedCatalogJob.tabId, 4000);
                if (alive) {
                    if (bridgeTabId !== completedCatalogJob.tabId) saveBridgeTabId(completedCatalogJob.tabId);
                    return completedCatalogJob.tabId;
                }
            }
        } catch (_) { /* fall through */ }
    }

    // Массовое удаление «Завершённые»: GraphQL из той же вкладки скана; иначе при AUTO_FULFILL bridge уходит только в окно заказов.
    if (isCompletedDeleteRunning && mainTabId) {
        try {
            const mt = await chrome.tabs.get(mainTabId);
            if (mt && isUsablePlayerokScannerUrl(mt.url || '')) {
                const alive = await pingBridge(mainTabId, 4000);
                if (alive) {
                    if (bridgeTabId !== mainTabId) saveBridgeTabId(mainTabId);
                    return mainTabId;
                }
            }
        } catch (_) { /* fall through */ }
    }

    // SW перезапуск — in-memory id окна автовыдачи теряется; подставляем из storage
    if (dedicatedBridgeForFulfill && fulfillWorkerWindowId == null) {
        const rw = await new Promise((r) => chrome.storage.local.get([FULFILL_WORKER_WINDOW_KEY], r));
        const wid = rw[FULFILL_WORKER_WINDOW_KEY];
        if (wid != null) {
            try {
                await chrome.windows.get(wid);
                fulfillWorkerWindowId = wid;
            } catch (_) {
                chrome.storage.local.remove([FULFILL_WORKER_WINDOW_KEY]);
            }
        }
    }

    // API-автовыдача: GraphQL только из окна воркера. Раньше mainTabId намеренно не брался как бридж,
    // из‑за чего шаг «любая живая playerok» выбирал вкладку из другого окна — запросы шли не в то окно.
    if (dedicatedBridgeForFulfill && fulfillWorkerWindowId != null) {
        try {
            const workerTabs = await chrome.tabs.query({ windowId: fulfillWorkerWindowId });
            let usable = (workerTabs || []).filter(t => isUsablePlayerokScannerUrl(t.url || ''));
            const scoreUrl = (url) => {
                const u = url || '';
                if (u.includes('/my/sales') || (u.includes('/sales') && !/\/sales\/\d+/.test(u))) return 20;
                if (u.includes('/products/completed') || u.includes('/my/products')) return 15;
                if (u.includes('/profile/')) return 5;
                return 1;
            };
            usable.sort((a, b) => {
                if (mainTabId) {
                    if (a.id === mainTabId) return -1;
                    if (b.id === mainTabId) return 1;
                }
                return scoreUrl(b.url) - scoreUrl(a.url);
            });
            for (const t of usable) {
                const alive = await pingBridge(t.id, 2500);
                if (alive) {
                    if (bridgeTabId !== t.id) {
                        log('🔗 Bridge Tab: вкладка окна автовыдачи (GraphQL, не трогаем другие окна).');
                    }
                    saveBridgeTabId(t.id);
                    return t.id;
                }
            }
            if (usable.length > 0) {
                const wt = usable[0];
                log('🔄 Bridge Tab: перезагружаю (content script не отвечает)...');
                await chrome.tabs.reload(wt.id);
                await sleep(BRIDGE_TAB_LOAD_MS);
                saveBridgeTabId(wt.id);
                return wt.id;
            }
            const salesUrl = getSalesUrl() || PLAYEROK_SALES_URL;
            const created = await chrome.tabs.create({ windowId: fulfillWorkerWindowId, url: salesUrl, active: false });
            if (created?.id) {
                log('🔗 Bridge Tab: фоновая вкладка Playerok в окне автовыдачи.');
                saveBridgeTabId(created.id);
                await sleep(BRIDGE_TAB_LOAD_MS);
                return created.id;
            }
        } catch (e) {
            console.warn('[ensurePlayerokTab] fulfill worker bridge', e?.message);
        }
    }

    // --- 1. Приоритет: mainTabId (автовыдача) или boostMainTabId (автопубликация)
    if (mainTabId && !dedicatedBridgeForFulfill && !publisherRunning) {
        try {
            const mt = await chrome.tabs.get(mainTabId);
            if (mt && isUsablePlayerokScannerUrl(mt.url || '')) {
                const alive = await pingBridge(mainTabId, 3000);
                if (alive) {
                    if (bridgeTabId !== mainTabId) saveBridgeTabId(mainTabId);
                    return mainTabId;
                }
            }
        } catch (_) { }
    }

    // --- 1b. Вкладка сканера буста (boostMainTabId) — содержит content_bridge.js и всегда доступна
    if (isBoostRunning && boostMainTabId && !dedicatedBridgeForFulfill && !publisherRunning) {
        try {
            const bt = await chrome.tabs.get(boostMainTabId);
            if (bt && isUsablePlayerokScannerUrl(bt.url || '')) {
                const alive = await pingBridge(boostMainTabId, 3000);
                if (alive) {
                    if (bridgeTabId !== boostMainTabId) saveBridgeTabId(boostMainTabId);
                    return boostMainTabId;
                }
            }
        } catch (_) { }
    }

    // --- 2. Сохранённый bridge tab (не из чужого окна при API-автовыдаче)
    if (bridgeTabId && dedicatedBridgeForFulfill && fulfillWorkerWindowId == null) {
        saveBridgeTabId(null);
    }
    if (bridgeTabId) {
        if (dedicatedBridgeForFulfill && fulfillWorkerWindowId != null) {
            try {
                const bt = await chrome.tabs.get(bridgeTabId);
                if (!bt || bt.windowId !== fulfillWorkerWindowId) saveBridgeTabId(null);
            } catch (_) {
                saveBridgeTabId(null);
            }
        }
    }
    if (bridgeTabId) {
        try {
            const tab = await chrome.tabs.get(bridgeTabId);
            if (tab && isUsablePlayerokScannerUrl(tab.url || '')) {
                const alive = await pingBridge(bridgeTabId);
                if (alive) return bridgeTabId;
                log('🔄 Bridge Tab: перезагружаю (content script не отвечает)...');
                await chrome.tabs.reload(bridgeTabId);
                await sleep(BRIDGE_TAB_LOAD_MS);
                return bridgeTabId;
            }
            if (tab && isPlayerokErrorPageUrl(tab.url || '')) {
                log('⚠️ Bridge Tab попал на 404, перезагружаю...');
                await chrome.tabs.reload(bridgeTabId);
                await sleep(BRIDGE_TAB_LOAD_MS);
                try {
                    const tab2 = await chrome.tabs.get(bridgeTabId);
                    if (tab2 && isUsablePlayerokScannerUrl(tab2.url || '')) return bridgeTabId;
                } catch (_) { }
                saveBridgeTabId(null);
            }
        } catch (_) {
            saveBridgeTabId(null);
        }
    }

    // --- 3. Любая живая вкладка playerok.com (не для API-автовыдачи и не пока работает publisher — иначе уводим фокус с основного окна)
    // Используем два паттерна: *.playerok.com/* (поддомены) и playerok.com/* (основной домен без www)
    if (!dedicatedBridgeForFulfill && !publisherRunning) try {
        const [tabs1, tabs2] = await Promise.all([
            chrome.tabs.query({ url: '*://*.playerok.com/*' }),
            chrome.tabs.query({ url: 'https://playerok.com/*' })
        ]);
        const seenIds = new Set();
        const allTabs = [...tabs1, ...tabs2].filter(t => { if (seenIds.has(t.id)) return false; seenIds.add(t.id); return true; });
        const usable = allTabs.filter(t => isUsablePlayerokScannerUrl(t.url || '') && t.id !== mainTabId && t.id !== boostMainTabId);
        usable.sort((a, b) => {
            const score = (u) => {
                if (u.includes('/products/completed') || u.includes('/my/products')) return 15;
                if (u.includes('/profile/')) return 5;
                return 1;
            };
            return score(b.url) - score(a.url);
        });
        for (const candidate of usable) {
            const alive = await pingBridge(candidate.id, 2000);
            if (alive) {
                if (bridgeTabId !== candidate.id) {
                    log(`🔗 Bridge Tab: выбрана вкладка (${candidate.url?.slice(0, 60)}...)`);
                }
                saveBridgeTabId(candidate.id);
                return candidate.id;
            }
        }
    } catch (_) { }

    // --- 4. Ничего не нашли — но сначала проверяем посвящённое воркерное окно,
    // чтобы не открывать ещё одно окно поверх уже существующего.
    const workerWinId = isOrderMode(currentBotMode)
        ? fulfillWorkerWindowId
        : (publisherRunning ? publisherWorkerWindowId : boostWorkerWindowId);
    if (workerWinId != null) {
        try {
            const workerTabs = await chrome.tabs.query({ windowId: workerWinId });
            let usableWorker = (workerTabs || []).filter(t => isUsablePlayerokScannerUrl(t.url || ''));
            if (isCompletedDeleteRunning && mainTabId) {
                usableWorker.sort((a, b) => {
                    if (a.id === mainTabId) return -1;
                    if (b.id === mainTabId) return 1;
                    return 0;
                });
            }
            if (usableWorker.length > 0) {
                const wt = usableWorker[0];
                log(`🔗 Bridge Tab: использую вкладку воркерного окна (${(wt.url || '').slice(0, 60)}...)`);
                saveBridgeTabId(wt.id);
                return wt.id;
            }
        } catch (_) { }
    }

    // --- 5. Создаём минимизированное окно (не спамить после STOP / вне активных сценариев)
    const stBridge = await getStore();
    const allowDashboardCatalogBridge = !!completedCatalogJob && !!completedCatalogJob.tabId;
    const allowNewBridgeWindow = !!(
        stBridge.isRunning || stBridge.isBoostRunning || isMainLoopRunning || isLoopRunning || isBoostRunning
        || publisherRunning || isCompletedDeleteRunning
        || allowPlayerokBridgeWindowForDashboardCatalog || allowDashboardCatalogBridge
    );
    if (!allowNewBridgeWindow) {
        throw new Error('Bridge: бот остановлен — не создаю новое окно Playerok');
    }
    const fallbackUrl = isCompletedDeleteRunning
        ? (getHomeUrl() || PLAYEROK_SALES_URL)
        : (isOrderMode(currentBotMode) && isMainLoopRunning
            ? (getSalesUrl() || PLAYEROK_SALES_URL)
            : (getHomeUrl() || PLAYEROK_SALES_URL));
    log(`🪟 Bridge Tab: открываю скрытое окно (${fallbackUrl.slice(0, 60)}...)`);
    const win = await chrome.windows.create({ url: fallbackUrl, state: 'minimized', focused: false });
    const newTab = win.tabs?.[0];
    if (!newTab?.id) throw new Error('Не удалось создать вкладку Playerok');
    saveBridgeTabId(newTab.id);
    await sleep(BRIDGE_TAB_LOAD_MS);
    try {
        const checkTab = await chrome.tabs.get(newTab.id);
        if (isPlayerokErrorPageUrl(checkTab.url || '')) {
            log('⚠️ Bridge Tab попал на страницу ошибки — возможно нужна авторизация. Продолжаю попытку...');
            await chrome.tabs.reload(newTab.id);
            await sleep(BRIDGE_TAB_LOAD_MS / 2);
        }
    } catch (_) { }
    return newTab.id;
}

// ==========================================
// API MUTEX — защита от конкурентных запросов
// publisher + fulfill могут работать параллельно,
// но bridge tab должен обрабатывать запросы по очереди
// ==========================================
// Используем очередь вместо promise chain — иначе цепочка .then() растёт бесконечно
// и удерживает замыкания всех прошедших запросов (утечка памяти при длительной работе).
let _apiMutexRunning = false;
const _apiMutexQueue = [];

function _drainApiMutex() {
    if (_apiMutexRunning) return;
    _apiMutexRunning = true;
    (async () => {
        while (_apiMutexQueue.length > 0) {
            const { fn, resolve, reject } = _apiMutexQueue.shift();
            try { resolve(await fn()); }
            catch (e) { reject(e); }
        }
        _apiMutexRunning = false;
    })();
}

/**
 * Обёртка над playerokApi с mutex-очередью.
 * Гарантирует что только один GraphQL запрос выполняется через bridge tab в момент времени.
 * Используется в publisher и fulfill параллельно — без конфликтов.
 */
function playerokApiQueued(fn) {
    return new Promise((resolve, reject) => {
        _apiMutexQueue.push({ fn, resolve, reject });
        _drainApiMutex();
    });
}

async function playerokApi(operationName, query, variables = {}, extensions = null) {
    let tabId = await ensurePlayerokTab();
    const payload = { action: 'EXECUTE_GRAPHQL', operationName, variables };
    if (extensions) payload.extensions = extensions;
    else payload.query = query;

    const sendWithTimeout = () => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Bridge timeout 6s')), BRIDGE_TAB_TIMEOUT_MS);
        chrome.tabs.sendMessage(tabId, payload, (response) => {
            clearTimeout(timer);
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else if (!response) reject(new Error('Нет ответа от Bridge'));
            else if (!response.success) reject(new Error(response.error || 'Unknown error'));
            else resolve(response.data);
        });
    });

    try {
        return await sendWithTimeout();
    } catch (e) {
        const msg = e.message || '';
        // 502/503/504 — server-side hiccup, wait and retry
        if (/HTTP 50[234]/.test(msg)) {
            await sleep(8000);
            try { return await sendWithTimeout(); } catch (_) { }
        }
        // 429 — не перезагружаем bridge (иначе всплывающее окно дёргается); паузу делает вызывающий код
        if (/429|Too many requests/i.test(msg)) {
            throw e;
        }
        // Bridge timeout or connection error — reload tab (с троттлингом) и retry
        try {
            await reloadBridgeTabThrottled(tabId);
            return await sendWithTimeout();
        } catch (_) {
            apiPausedUntil = Date.now() + 30000;
            throw e;
        }
    }
}

async function playerokApiFile(operationName, query, variables = {}, fileUrl) {
    let tabId = await ensurePlayerokTab();
    const payload = { action: 'EXECUTE_GRAPHQL_FILE', operationName, query, variables, fileUrl };

    const sendWithTimeout = () => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Bridge timeout 15s (FileUpload)')), 15000);
        chrome.tabs.sendMessage(tabId, payload, (response) => {
            clearTimeout(timer);
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else if (!response) reject(new Error('Нет ответа от Bridge'));
            else if (!response.success) reject(new Error(response.error || 'Unknown error'));
            else resolve(response.data);
        });
    });

    try {
        return await sendWithTimeout();
    } catch (e) {
        const msgF = e.message || '';
        if (/429|Too many requests/i.test(msgF)) throw e;
        try {
            await reloadBridgeTabThrottled(tabId);
            await new Promise(r => setTimeout(r, 1500));
            return await sendWithTimeout();
        } catch (_) {
            apiPausedUntil = Date.now() + 30000;
            throw e;
        }
    }
}

async function playerokApiCanvas(operationName, query, variables, templateBase64, coords, bannerUrl, screenshotUrls, preRenderedCardDataUrl = null) {
    let tabId = await ensurePlayerokTab();
    const payload = {
        action: 'GENERATE_AND_UPLOAD', operationName, query, variables, templateBase64, coords, bannerUrl, screenshotUrls,
        preRenderedCardDataUrl: preRenderedCardDataUrl || null
    };

    const sendWithTimeout = () => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Bridge timeout 30s (Canvas Upload)')), 30000);
        chrome.tabs.sendMessage(tabId, payload, (response) => {
            clearTimeout(timer);
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else if (!response) reject(new Error('Нет ответа от Bridge (Canvas)'));
            else if (!response.success) reject(new Error(response.error || 'Unknown Canvas error'));
            else resolve(response.data);
        });
    });

    try {
        return await sendWithTimeout();
    } catch (e) {
        // Don't retry on 4xx API errors — only on bridge/network/timeout failures
        const msg = e.message || '';
        if (/HTTP 4\d\d/.test(msg) || msg.includes('BAD_REQUEST') || msg.includes('Invalid data')) throw e;
        // Never retry createItem mutations — the server may have already created the item.
        // Retrying after a lost bridge response (e.g. SPA navigation destroyed the content script)
        // would create a duplicate listing. Other mutations / queries are safe to retry.
        if (operationName === 'createItem') throw e;
        try {
            await reloadBridgeTabThrottled(tabId);
            await new Promise(r => setTimeout(r, 2500));
            return await sendWithTimeout();
        } catch (_) {
            throw e;
        }
    }
}

/** Баннер в Steam: у новинок часто нет background_raw — берём header/capsule/первый скрин. */
function extractSteamBannerAndShots(data) {
    if (!data) return { banner: null, screenshots: [] };
    // Берём до 8 скринов: shots[0] — обычно тот же "главный момент" что и background/background_raw,
    // поэтому в миниатюры всегда начинаем с shots[1], чтобы не дублировать баннер.
    const shots = (data.screenshots || []).slice(0, 8).map(s => s.path_full).filter(Boolean);
    const headerBanner = data.background_raw || data.background || data.header_image || data.capsule_image || data.capsule || null;
    const banner = headerBanner || shots[0] || null;
    // shots[0] = герой; баннер = shots[0] или wide art с той же сценой → миниатюры с shots[1].
    const screenshots = shots.slice(1, 6);
    return { banner, screenshots };
}

/**
 * Известные AppID, когда storesearch путает серии (WWE 2K25 vs 2K26, DS1 vs DS2).
 * Поддерживайте список при выходе новых частей.
 */
function resolveKnownSteamAppIdFromTitle(name) {
    const raw = String(name || '');
    if (/\bWWE\s*2K\s*26\b/i.test(raw)) return 3717070;
    if (/\bDeath\s+Stranding\s*2\b/i.test(raw)) return 3280350;
    return null;
}

/** Один источник: store appdetails по числовому AppID (без неверного storesearch). */
async function fetchSteamStoreAssetsByAppId(appId) {
    const id = parseInt(String(appId), 10);
    if (!id || id <= 0) return { banner: null, screenshots: [] };
    try {
        const r2 = await fetch(`https://store.steampowered.com/api/appdetails?appids=${id}&cc=RU&l=russian`);
        const d2 = await r2.json();
        if (d2?.[id]?.success) {
            const ex = extractSteamBannerAndShots(d2[id].data);
            return { banner: ex.banner, screenshots: ex.screenshots };
        }
    } catch (e) { console.error('[fetchSteamStoreAssetsByAppId]', e.message); }
    return { banner: null, screenshots: [] };
}

/** Прямые URL на CDN Steam (без API-ключей; обычно открываются из РФ). */
function buildSteamCdnBannerCandidates(appId) {
    const id = parseInt(String(appId), 10);
    if (!id || id <= 0) return [];
    const paths = [
        '/header.jpg',
        '/library_hero.jpg',
        '/library_600x900.jpg',
        '/capsule_616x353.jpg',
        '/capsule_467x181.jpg',
        '/page_bg_generated.jpg'
    ];
    const bases = [
        'https://cdn.akamai.steamstatic.com/steam/apps',
        'https://cdn.cloudflare.steamstatic.com/steam/apps',
        'https://steamcdn-a.akamaihd.net/steam/apps'
    ];
    const out = [];
    for (const b of bases) {
        for (const p of paths) out.push(`${b}/${id}${p}`);
    }
    return out;
}

async function probeFirstWorkingImageUrl(urls) {
    for (const url of urls) {
        try {
            const res = await fetch(url, { method: 'HEAD' });
            const ct = (res.headers.get('content-type') || '').toLowerCase();
            if (res.ok && (ct.includes('image') || ct.includes('jpeg') || ct.includes('png') || ct.includes('webp'))) {
                return url;
            }
        } catch (_) { /* try GET */ }
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 14000);
            const res = await fetch(url, { method: 'GET', signal: ctrl.signal });
            clearTimeout(timer);
            const ct = (res.headers.get('content-type') || '').toLowerCase();
            if (res.ok && (ct.includes('image') || ct.includes('jpeg') || ct.includes('png') || ct.includes('webp') || ct.includes('octet-stream'))) {
                return url;
            }
        } catch (_) { /* next */ }
    }
    return null;
}

async function quickImageUrlOk(url) {
    const u = await probeFirstWorkingImageUrl([url]);
    return !!u;
}

function buildSteamSearchVariants(name) {
    const raw = String(name || '').trim();
    const add = (arr, s) => {
        const t = String(s || '').trim();
        if (t.length > 1 && !arr.includes(t)) arr.push(t);
    };
    const out = [];
    add(out, raw);
    let noPipe = raw.replace(/\s*\|\s*Оффлайн\s+Steam.*$/i, '').replace(/\s*\|\s*Аккаунт.*$/i, '').trim();
    add(out, noPipe);
    noPipe = noPipe.replace(/\s*\|\s*[^|]+(\s*\|\s*[^|]+)*$/g, '').trim();
    add(out, noPipe);
    const colon = raw.split(/[:\u2013\u2014]/)[0].trim();
    add(out, colon);
    add(out, raw.replace(/\s*[:\u2013\u2014]\s*On the Beach\s*$/i, '').trim());
    add(out, raw.replace(/\s*[:\u2013\u2014]\s*Director'?s Cut\s*$/i, '').trim());
    const wwe = raw.match(/(WWE\s*2K\s*\d+)/i);
    if (wwe) add(out, wwe[1].replace(/\s+/g, ' ').trim());
    const ds = raw.match(/(Death\s+Stranding\s*2[^\w]?)/i);
    if (ds) add(out, 'Death Stranding 2');
    return out;
}

/** Отсечь неверную часть серии: 2K25 вместо 2K26, Death Stranding без «2». */
function strictSteamProductMatch(searchTerm, apiName) {
    const t = String(searchTerm || '').toLowerCase();
    const n = String(apiName || '').toLowerCase();
    const wweY = t.match(/\b2k\s*(\d{2})\b/i);
    if (wweY) {
        const inStore = n.match(/\b2k\s*(\d{2})\b/i);
        if (!inStore || inStore[1] !== wweY[1]) return false;
    }
    if (/\bdeath\s+stranding\s*2\b/.test(t) || /\bstranding\s*2\b/.test(t)) {
        if (!/\bstranding\s*2\b/.test(n) && !/\bds\s*2\b/.test(n)) return false;
    }
    return true;
}

/** Сходство имён для Steam storesearch / appdetails.name (WWE 2K26, Death Stranding 2, …). */
function scoreItemName(itemName, searchName) {
    const norm = (s) => String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
    const ni = norm(itemName);
    const qs = norm(searchName);
    if (!ni || !qs) return 0;
    if (ni === qs) return 100;
    const mainQ = qs.split(/[:\u2013\u2014\-]/)[0].trim();
    const mainN = ni.split(/[:\u2013\u2014\-]/)[0].trim();
    if (mainQ.length > 3 && mainN === mainQ) return 94;
    if (mainQ.length > 3 && ni.startsWith(mainQ)) return 86;
    if (mainQ.length > 3 && ni.includes(mainQ)) return 72;
    const q2k = qs.match(/2k\s*(\d{2})/i);
    const n2k = ni.match(/2k\s*(\d{2})/i);
    if (q2k && n2k && q2k[1] === n2k[1] && /wwe/.test(qs) && /wwe/.test(ni)) return 90;
    const qWords = qs.split(/\s+/).filter(w => w.length > 2);
    let hit = 0;
    for (const w of qWords) if (ni.includes(w)) hit++;
    if (qWords.length && hit / qWords.length >= 0.65) return 68;
    const qt = new Set(qs.split(/\s+/).filter(t => t.length > 2));
    const nt = new Set(ni.split(/\s+/).filter(t => t.length > 2));
    let inter = 0;
    for (const t of qt) if (nt.has(t)) inter++;
    const u = qt.size + nt.size - inter;
    return u ? Math.round((inter / u) * 50) : 0;
}

/** Ключ для сопоставления имени игры с файлом карточки (без расширения). */
function normalizePublisherLocalCardKey(name) {
    return String(name || '')
        .replace(/\[\d{4,10}\]\s*$/, '')
        .replace(/[✨🎮™®©]/g, '')
        .replace(/ОФФЛАЙН АКТИВАЦИЯ/gi, '')
        .replace(/[\u2013\u2014\-_.]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function resolveLocalCardDataUrl(localMap, name) {
    if (!localMap || typeof localMap !== 'object') return null;
    const target = normalizePublisherLocalCardKey(name);
    if (!target) return null;
    const entries = [];
    for (const [k, v] of Object.entries(localMap)) {
        if (!v || typeof v !== 'string') continue;
        if (!/^data:image\//i.test(v)) continue;
        const normK = normalizePublisherLocalCardKey(k);
        if (normK === target) return v;
        entries.push([normK, v]);
    }
    // Запасной вариант: файл без пробела (nba2k14) vs имя с пробелом (nba 2k14)
    const targetCompact = target.replace(/\s/g, '');
    if (targetCompact.length >= 4) {
        for (const [normK, v] of entries) {
            if (normK.replace(/\s/g, '') === targetCompact) return v;
        }
    }
    console.log(`[resolveLocalCardDataUrl] Не найдено совпадение для: "${name}" (target: "${target}"). Доступные ключи:`, Object.keys(localMap).map(k => normalizePublisherLocalCardKey(k)));
    return null;
}

/** Карта имя_файла → Blob/File из папки (без предзагрузки). */
function resolveLocalCardBlob(fileMap, name) {
    if (!fileMap || typeof fileMap !== 'object') return null;
    const target = normalizePublisherLocalCardKey(name);
    if (!target) return null;
    const entries = [];
    for (const [k, v] of Object.entries(fileMap)) {
        if (!v || typeof v !== 'object' || typeof v.arrayBuffer !== 'function') continue;
        const normK = normalizePublisherLocalCardKey(k);
        if (normK === target) return v;
        entries.push([normK, v]);
    }
    const targetCompact = target.replace(/\s/g, '');
    if (targetCompact.length >= 4) {
        for (const [normK, blob] of entries) {
            if (normK.replace(/\s/g, '') === targetCompact) return blob;
        }
    }
    return null;
}

async function blobToImageDataUrl(blob) {
    if (!blob || typeof blob.arrayBuffer !== 'function') return null;
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    const mime = (blob.type && /^image\//i.test(blob.type)) ? blob.type : 'image/png';
    return `data:${mime};base64,${btoa(binary)}`;
}

/** Обложки с ag.ru (HTML state + страница скриншотов). */
async function fetchAgRuGameAssets(searchName) {
    const q = String(searchName || '').trim();
    if (!q) return null;
    try {
        const r = await fetch(`https://ag.ru/games?search=${encodeURIComponent(q)}`);
        if (!r.ok) return null;
        const html = await r.text();
        const keyRe = /"g-[a-z0-9][a-z0-9\-]*":\{/g;
        const games = [];
        let km;
        while ((km = keyRe.exec(html)) !== null) {
            const chunk = html.substring(km.index, km.index + 1200);
            const slugM = chunk.match(/"slug":"([^"]+)"/);
            const nameM = chunk.match(/"name":"([^"]+)"/);
            const imgM = chunk.match(/"background_image":"(https:\\u002F\\u002Fcdn\.ag\.ru[^"]+)"/);
            if (slugM && nameM && imgM) {
                games.push({
                    slug: slugM[1],
                    name: nameM[1],
                    banner: imgM[1].replace(/\\u002F/g, '/')
                });
            }
        }
        if (!games.length) return null;
        let best = null, bestSc = -1;
        for (const g of games) {
            const sc = scoreItemName(g.name, q);
            if (sc > bestSc) { bestSc = sc; best = g; }
        }
        if (!best || bestSc < 22) return null;
        const r2 = await fetch(`https://ag.ru/games/${encodeURIComponent(best.slug)}/screenshots`);
        const html2 = r2.ok ? await r2.text() : '';
        const reSs = /"image":"(https:\\u002F\\u002Fcdn\.ag\.ru\\u002Fmedia\\u002Fscreenshots[^"]+)"/g;
        const shots = [];
        let m;
        while ((m = reSs.exec(html2)) !== null) {
            const u = m[1].replace(/\\u002F/g, '/');
            if (!shots.includes(u)) shots.push(u);
            if (shots.length >= 8) break;
        }
        return { bannerUrl: best.banner, screenshotUrls: shots };
    } catch (e) {
        console.error('[fetchAgRuGameAssets]', e);
        return null;
    }
}

/** SteamGridDB: heroes + horizontal grids. */
async function fetchSteamGridDbAssets(searchName, apiKey) {
    const q = String(searchName || '').trim();
    if (!q || !apiKey) return null;
    try {
        const r = await fetch(
            `https://www.steamgriddb.com/api/v2/search/autocomplete/${encodeURIComponent(q)}`,
            { headers: { Authorization: `Bearer ${apiKey}` } }
        );
        if (!r.ok) return null;
        const data = await r.json();
        const items = data?.data || [];
        if (!items.length) return null;
        let best = null, bestSc = -1;
        for (const it of items) {
            const sc = scoreItemName(it.name || '', q);
            if (sc > bestSc) { bestSc = sc; best = it; }
        }
        if (!best || bestSc < 20) return null;
        const gameId = best.id;
        const rH = await fetch(`https://www.steamgriddb.com/api/v2/heroes/game/${gameId}`, {
            headers: { Authorization: `Bearer ${apiKey}` }
        });
        const dH = rH.ok ? await rH.json() : { data: [] };
        const heroes = dH?.data || [];
        const bannerUrl = heroes.find(h => h.url)?.url || null;
        // Скриншоты — игровые кадры из /screenshots (основной источник для слотов карточки)
        const rS = await fetch(`https://www.steamgriddb.com/api/v2/screenshots/game/${gameId}`, {
            headers: { Authorization: `Bearer ${apiKey}` }
        });
        const dS = rS.ok ? await rS.json() : { data: [] };
        let screenshotUrls = (dS?.data || []).filter(s => s.url).slice(0, 6).map(s => s.url);
        // Fallback: горизонтальные grids если скриншотов нет
        if (!screenshotUrls.length) {
            const rG = await fetch(`https://www.steamgriddb.com/api/v2/grids/game/${gameId}?dimensions=460x215,920x430`, {
                headers: { Authorization: `Bearer ${apiKey}` }
            });
            const dG = rG.ok ? await rG.json() : { data: [] };
            screenshotUrls = (dG?.data || []).filter(g => g.url).slice(0, 6).map(g => g.url);
        }
        return { bannerUrl: bannerUrl || screenshotUrls[0] || null, screenshotUrls };
    } catch (e) {
        console.error('[fetchSteamGridDbAssets]', e);
        return null;
    }
}

/**
 * Для источников, у которых CDN не отдаёт CORS-заголовки (SteamGridDB, ag.ru и т.п.),
 * загружаем картинки в service worker'е (где host_permissions обходят CORS)
 * и конвертируем в base64 data URL — так bridge может вставить их в canvas без ошибок.
 * Примечание: FileReader недоступен в MV3 service worker — используем ArrayBuffer + btoa.
 */
async function prefetchImagesToDataUrls(bannerUrl, screenshotUrls) {
    async function toDataUrl(url) {
        if (!url || typeof url !== 'string' || url.startsWith('data:')) return url;
        try {
            const r = await fetch(url);
            if (!r.ok) return url;
            const mime = r.headers.get('content-type') || 'image/jpeg';
            const buf = await r.arrayBuffer();
            // btoa works with binary string; convert ArrayBuffer via Uint8Array
            const bytes = new Uint8Array(buf);
            let binary = '';
            for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
            return `data:${mime};base64,${btoa(binary)}`;
        } catch (_) {
            return url; // fallback; bridge will try anyway
        }
    }
    const newBanner = await toDataUrl(bannerUrl);
    const ssArr = Array.isArray(screenshotUrls) ? screenshotUrls : [];
    // Конвертируем первые 3 скриншота в data URL (content script не может загрузить
    // SteamGridDB/ag.ru CDN из-за CORS; service worker обходит это через host_permissions).
    const newSS = await Promise.all(ssArr.slice(0, 3).map(u => toDataUrl(u)));
    // Остальные слоты (если есть) оставляем как есть (fallback — они уже data: или Steam CDN)
    const tail = ssArr.slice(3).map(u => u);
    return { bannerUrl: newBanner, screenshotUrls: [...newSS, ...tail] };
}

/** Когда нет AppID в merge — один лёгкий storesearch, чтобы добрать id для CDN-баннера. */
async function tryResolveSteamAppIdLoose(searchName) {
    const variants = buildSteamSearchVariants(searchName);
    for (const term of variants.slice(0, 8)) {
        for (const { lang, cc } of [{ lang: 'english', cc: 'US' }, { lang: 'russian', cc: 'RU' }]) {
            try {
                const r1 = await fetch(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=${lang}&cc=${cc}`);
                const d1 = await r1.json();
                if (!d1?.items?.length) continue;
                const sorted = [...d1.items].sort((a, b) => scoreItemName(b.name || '', term) - scoreItemName(a.name || '', term));
                for (const chosen of sorted.slice(0, 10)) {
                    const sc = scoreItemName(chosen.name || '', term);
                    if (sc < 14) continue;
                    const nm = chosen.name || '';
                    if (strictSteamProductMatch(term, nm)) return chosen.id;
                    if (sc >= 58) return chosen.id;
                }
            } catch (_) { /* next */ }
        }
    }
    return null;
}

/**
 * Картинки для карточки: Steam и SteamPass комбинируются по слотам (основной источник + добор пропусков).
 * hints (каталог): steamAppId — приоритет; bannerUrl + screenshotUrls — один продукт целиком.
 * nameOrNames: строка или массив имён (сырое имя из списка и имя с Playerok).
 */
async function getCardAssets(nameOrNames, imageSource, hints) {
    // imageSource: 'steam' | 'steampass' (default: 'steam')
    const useSteamFirst = !imageSource || imageSource === 'steam';
    const namesList = Array.isArray(nameOrNames) ? nameOrNames : [nameOrNames];
    const uniqueNames = [...new Set(namesList.filter(Boolean).map(s => String(s).trim()).filter(Boolean))];
    console.log('[getCardAssets] ▶ start', {
        imageSource: imageSource || 'steam(default)',
        steamFirst: useSteamFirst,
        steampassFirst: !useSteamFirst,
        names: uniqueNames,
        hintsAppId: hints?.steamAppId || null
    });

    // Готовый PNG карточки (имя файла = название игры) — загрузка без сборки шаблона
    if (imageSource === 'local_card') {
        const fileMap = hints && hints.localCardFilesByStem;
        const localMap = hints && hints.localCardImages;
        const nFiles = fileMap && typeof fileMap === 'object' ? Object.keys(fileMap).length : 0;
        const nData = localMap && typeof localMap === 'object' ? Object.keys(localMap).length : 0;
        console.log(`[getCardAssets] Режим local_card. Файлов (lazy): ${nFiles}, data URL в памяти: ${nData}`);
        if (nFiles) {
            for (const n of uniqueNames) {
                const blob = resolveLocalCardBlob(fileMap, n);
                if (blob) {
                    const dataUrl = await blobToImageDataUrl(blob);
                    if (dataUrl) {
                        console.log('[getCardAssets] local_card (file) →', n);
                        return { bannerUrl: null, screenshotUrls: [], preRenderedCardDataUrl: dataUrl };
                    }
                }
            }
        }
        if (nData) {
            for (const n of uniqueNames) {
                const dataUrl = resolveLocalCardDataUrl(localMap, n);
                if (dataUrl) {
                    console.log('[getCardAssets] local_card (map) →', n);
                    return { bannerUrl: null, screenshotUrls: [], preRenderedCardDataUrl: dataUrl };
                }
            }
        }
        console.warn('[getCardAssets] local_card: файл не найден для', uniqueNames);
        return { bannerUrl: null, screenshotUrls: [], preRenderedCardDataUrl: null };
    }

    function padScreenshotSlots(arr, n) {
        const a = Array.isArray(arr) ? arr : [];
        return Array.from({ length: n }, (_, i) => a[i] || null);
    }

    /**
     * Резервы: если баннер пустой — пробуем CDN Steam по appId; если мало скринов — повтор appdetails
     * и добор уникальных URL с CDN (header/capsule/library — разные кадры).
     */
    async function applyImageFallbacks(input, ctx) {
        const name = ctx.name || '';
        const hints = ctx.hints || {};
        let resolvedAppId = ctx.resolvedAppId || null;
        if (!resolvedAppId || resolvedAppId <= 0) {
            if (hints.steamAppId) resolvedAppId = parseInt(String(hints.steamAppId), 10);
        }
        if (!resolvedAppId || resolvedAppId <= 0) resolvedAppId = resolveKnownSteamAppIdFromTitle(name);
        if ((!resolvedAppId || resolvedAppId <= 0) && name) {
            const guessed = await tryResolveSteamAppIdLoose(name);
            if (guessed) {
                resolvedAppId = guessed;
                console.log('[getCardAssets] AppID для баннера (доп. поиск по имени):', resolvedAppId, name);
            }
        }

        let bannerUrl = input.bannerUrl && String(input.bannerUrl).trim() ? input.bannerUrl : null;
        let screenshotUrls = (Array.isArray(input.screenshotUrls) ? input.screenshotUrls : []).filter(Boolean);

        if (!bannerUrl && resolvedAppId > 0) {
            const cdn = await probeFirstWorkingImageUrl(buildSteamCdnBannerCandidates(resolvedAppId));
            if (cdn) {
                bannerUrl = cdn;
                console.log(`[getCardAssets] Резерв баннера: Steam CDN (probe) → ${cdn}`);
            }
        }

        if (resolvedAppId > 0 && screenshotUrls.length < 3) {
            const byId = await fetchSteamStoreAssetsByAppId(resolvedAppId);
            if (byId.banner && !bannerUrl) bannerUrl = byId.banner;
            const add = (byId.screenshots || []).filter(Boolean);
            for (const u of add) {
                if (screenshotUrls.length >= 5) break;
                if (!screenshotUrls.includes(u)) screenshotUrls.push(u);
            }
        }

        if (resolvedAppId > 0 && screenshotUrls.length < 3) {
            const cdnList = buildSteamCdnBannerCandidates(resolvedAppId);
            for (const u of cdnList) {
                if (screenshotUrls.length >= 5) break;
                if (screenshotUrls.includes(u)) continue;
                if (await quickImageUrlOk(u)) screenshotUrls.push(u);
            }
        }

        if (!bannerUrl && screenshotUrls.length) bannerUrl = screenshotUrls[0];

        // CDN часто режет HEAD/403 — probe пустой, а GET в canvas с тем же URL срабатывает.
        if (!bannerUrl && resolvedAppId > 0) {
            bannerUrl = `https://cdn.akamai.steamstatic.com/steam/apps/${resolvedAppId}/header.jpg`;
            console.log('[getCardAssets] баннер: принудительный header.jpg по AppID (загрузка на стороне канвы)', resolvedAppId);
        }

        const result = { bannerUrl, screenshotUrls: padScreenshotSlots(screenshotUrls, 5) };
        console.log('[getCardAssets] ◀ applyImageFallbacks', {
            resolvedAppId,
            banner: result.bannerUrl ? String(result.bannerUrl).slice(0, 72) + '…' : null,
            ssCount: screenshotUrls.length
        });
        return result;
    }

    if (imageSource === 'agru') {
        for (const n of uniqueNames) {
            const ag = await fetchAgRuGameAssets(n);
            if (ag && (ag.bannerUrl || (ag.screenshotUrls && ag.screenshotUrls.length))) {
                return await applyImageFallbacks(
                    { bannerUrl: ag.bannerUrl, screenshotUrls: padScreenshotSlots(ag.screenshotUrls, 5) },
                    { name: n, hints: hints || {}, resolvedAppId: null }
                );
            }
        }
    }

    if (imageSource === 'steamgriddb') {
        const sgKey = (hints && hints.steamgriddbApiKey) || '';
        for (const n of uniqueNames) {
            const sg = await fetchSteamGridDbAssets(n, sgKey);
            if (sg && (sg.bannerUrl || (sg.screenshotUrls && sg.screenshotUrls.length))) {
                return await applyImageFallbacks(
                    { bannerUrl: sg.bannerUrl, screenshotUrls: padScreenshotSlots(sg.screenshotUrls, 5) },
                    { name: n, hints: hints || {}, resolvedAppId: null }
                );
            }
        }
    }

    // --- Подсказки из каталога SteamPass (один товар = один набор картинок) ---
    if (hints && hints.steamAppId) {
        const byId = await fetchSteamStoreAssetsByAppId(hints.steamAppId);
        if (byId.banner || (byId.screenshots && byId.screenshots.length)) {
            return await applyImageFallbacks(
                { bannerUrl: byId.banner, screenshotUrls: padScreenshotSlots(byId.screenshots, 5) },
                { name: uniqueNames[0] || '', hints, resolvedAppId: parseInt(String(hints.steamAppId), 10) }
            );
        }
    }
    if (hints && hints.bannerUrl && Array.isArray(hints.screenshotUrls) && hints.screenshotUrls.length > 0) {
        return await applyImageFallbacks(
            {
                bannerUrl: hints.bannerUrl,
                screenshotUrls: padScreenshotSlots(hints.screenshotUrls, 5)
            },
            { name: uniqueNames[0] || '', hints, resolvedAppId: hints.steamAppId ? parseInt(String(hints.steamAppId), 10) : null }
        );
    }

    function pickBestSteamPassItem(items, searchName) {
        if (!items?.length) return null;
        const ranked = [...items].sort((a, b) => scoreItemName(a.name || a.title || '', searchName) - scoreItemName(b.name || b.title || '', searchName));
        const best = ranked[ranked.length - 1];
        const sc = scoreItemName(best.name || best.title || '', searchName);
        if (sc >= 22) return best;
        if (items.length === 1 && sc >= 14) return best;
        return null;
    }

    async function tryFromSteamPass(searchName) {
        try {
            const r1 = await fetch('https://steampass.gg/api/product/filter', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: String(searchName).replace(/\s+/g, ' ').trim() })
            });
            const d1 = await r1.json();
            if (d1?.data?.length > 0) {
                const item = pickBestSteamPassItem(d1.data, searchName);
                if (!item) {
                    console.warn('[getCardAssets] SteamPass filter есть, но score не прошёл порог', { searchName, count: d1.data.length });
                    return { banner: null, screenshots: [] };
                }
                const productId = item.id;
                const catalogBanner = item.background_url || item.image_url || null;
                const r2 = await fetch(`https://steampass.gg/api/product/${productId}`);
                const d2 = await r2.json();
                const p = d2?.product || d2?.data || {};
                let banner = p.background_url || p.image_url || catalogBanner;
                const shots = Array.isArray(p.screenshots)
                    ? p.screenshots.slice(0, 8).map(s => typeof s === 'string' ? s : (s.path_full || s.path || s.url || s.path_thumbnail || '')).filter(Boolean)
                    : [];
                if (!banner && shots.length) banner = shots[0];
                console.log('[getCardAssets] SteamPass ok', {
                    q: searchName,
                    picked: item.name || item.title,
                    productId,
                    ss: shots.length
                });
                return { banner, screenshots: shots };
            }
            console.log('[getCardAssets] SteamPass filter пусто', { q: searchName });
        } catch (e) { console.error('[getCardAssets] SteamPass error:', e.message); }
        return { banner: null, screenshots: [] };
    }

    /** Несколько вариантов имени SteamPass — добираем недостающие слоты из другого запроса. */
    async function collectSteamPassMerged(name) {
        const merged = { banner: null, screenshots: Array(5).fill(null) };
        for (const v of buildSteamSearchVariants(name)) {
            const r = await tryFromSteamPass(v);
            if (r.banner && !merged.banner) merged.banner = r.banner;
            const arr = r.screenshots || [];
            for (let i = 0; i < 5; i++) {
                if (!merged.screenshots[i] && arr[i]) merged.screenshots[i] = arr[i];
            }
            if (merged.banner && merged.screenshots.filter(Boolean).length >= 3) break;
        }
        return merged;
    }

    /**
     * Основной пакет + запасной.
     * Если primary уже даёт 3+ скрина — не миксуем secondary (сохраняем единый визуальный стиль).
     * Иначе добираем недостающие слоты из secondary.
     */
    function mergeAssetPacks(primary, secondary) {
        const p = primary || {};
        const s = secondary || {};
        const pB = p.banner || p.bannerUrl || null;
        const sB = s.banner || s.bannerUrl || null;
        const rawP = p.screenshots || p.screenshotUrls;
        const rawS = s.screenshots || s.screenshotUrls;
        const pArr = (Array.isArray(rawP) ? rawP : []).filter(Boolean);
        const sArr = (Array.isArray(rawS) ? rawS : []).filter(Boolean);
        let bannerUrl = pB || sB || null;
        let screenshotUrls;
        if (pArr.length >= 3) {
            // Primary богатый — берём только его скрины, стиль однородный.
            screenshotUrls = pArr.slice(0, 5);
        } else {
            // Добираем из secondary только незаполненные позиции.
            const merged = pArr.slice(0, 5);
            for (const u of sArr) {
                if (merged.length >= 5) break;
                if (!merged.includes(u)) merged.push(u);
            }
            screenshotUrls = merged;
        }
        if (!bannerUrl) {
            const first = screenshotUrls.find(Boolean);
            if (first) bannerUrl = first;
        }
        console.log('[getCardAssets] mergeAssetPacks', {
            primarySs: pArr.length,
            secondarySs: sArr.length,
            onlyPrimary: pArr.length >= 3,
            hasBanner: !!bannerUrl,
            screenshotUrlsLen: (screenshotUrls || []).length
        });
        return { bannerUrl, screenshotUrls };
    }

    async function tryFromSteam(searchName) {
        const variants = buildSteamSearchVariants(searchName);
        for (const term of variants) {
            for (const { lang, cc } of [{ lang: 'english', cc: 'US' }, { lang: 'russian', cc: 'RU' }]) {
                try {
                    const r1 = await fetch(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=${lang}&cc=${cc}`);
                    const d1 = await r1.json();
                    if (!d1?.items?.length) continue;
                    const sorted = [...d1.items].sort((a, b) => scoreItemName(b.name || '', term) - scoreItemName(a.name || '', term));
                    for (const chosen of sorted.slice(0, 10)) {
                        const scStore = scoreItemName(chosen.name || '', term);
                        if (scStore < 18) continue;
                        const id = chosen.id;
                        const r2 = await fetch(`https://store.steampowered.com/api/appdetails?appids=${id}&cc=RU&l=russian`);
                        const d2 = await r2.json();
                        if (!d2?.[id]?.success) continue;
                        const data = d2[id].data;
                        const apiName = data.name || chosen.name || '';
                        const verify = Math.max(scStore, scoreItemName(apiName, term));
                        if (verify < 20) continue;
                        if (!strictSteamProductMatch(term, apiName)) continue;
                        const ex = extractSteamBannerAndShots(data);
                        if (ex.banner || ex.screenshots.length) {
                            return { banner: ex.banner, screenshots: ex.screenshots, appId: id };
                        }
                    }
                } catch (e) { console.error('[getCardAssets] Steam', e.message); }
            }
        }
        return { banner: null, screenshots: [], appId: null };
    }

    async function resolveOneName(name) {
        let steam = { banner: null, screenshots: [], appId: null };
        let usedKnownAppId = false;
        const knownAid = resolveKnownSteamAppIdFromTitle(name);
        if (knownAid) {
            const byId = await fetchSteamStoreAssetsByAppId(knownAid);
            if (byId.banner || (byId.screenshots && byId.screenshots.length)) {
                steam = { banner: byId.banner, screenshots: byId.screenshots || [], appId: knownAid };
                usedKnownAppId = true;
                console.log(`[getCardAssets] "${name}" → Steam по известному AppID ${knownAid}`);
            }
        }
        if (!usedKnownAppId) {
            const tr = await tryFromSteam(name);
            steam = { banner: tr.banner, screenshots: tr.screenshots || [], appId: tr.appId || null };
        }
        const sp = await collectSteamPassMerged(name);
        const steamSS = (steam.screenshots || []).filter(Boolean).length;
        const spSS = (sp.screenshots || []).filter(Boolean).length;
        console.log(`[getCardAssets] "${name}" → Steam: banner=${!!steam.banner} ss=${steamSS} | SteamPass: banner=${!!sp.banner} ss=${spSS}`);
        let out;
        if (useSteamFirst) {
            out = mergeAssetPacks(steam, sp);
        } else {
            console.log('[getCardAssets] порядок: SteamPass primary → Steam secondary (резерв)');
            out = mergeAssetPacks(sp, steam);
        }
        const resolvedAppId = steam.appId || knownAid || null;
        console.log('[getCardAssets] до резервов CDN', {
            banner: out.bannerUrl ? 'yes' : 'no',
            ss: (out.screenshotUrls || []).filter(Boolean).length,
            resolvedAppId
        });
        return await applyImageFallbacks(out, { name, hints: hints || {}, resolvedAppId });
    }

    for (const n of uniqueNames) {
        const out = await resolveOneName(n);
        if (out.bannerUrl || (out.screenshotUrls && out.screenshotUrls.some(Boolean))) return out;
    }
    return await applyImageFallbacks(
        { bannerUrl: null, screenshotUrls: [] },
        { name: uniqueNames[0] || '', hints: hints || {}, resolvedAppId: null }
    );
}

const DEALS_PERSISTED_HASH = 'c3b623b5fe0758cf91b2335ebf36ff65f8650a6672a792a3ca7a36d270d396fb';

const VIEWER_QUERY = `query viewer { viewer { id username } }`;

const QUERY_DEAL = `query deal($id: UUID!) {
  deal(id: $id) {
    id
    createdAt
    chat {
      id
    }
    item {
      id
      slug
      name
    }
    user {
      id
      username
    }
  }
}`;

async function apiGetDealDetails(dealId) {
    try {
        return await playerokApi('deal', QUERY_DEAL, { id: dealId });
    } catch (e) {
        log(`📡 API deal: ${e.message}`);
        throw e;
    }
}

// Запрашиваем у Playerok последнюю сделку по chatId.
// Пробуем несколько вариантов схемы — Playerok мог переименовать поля.
// Возвращает { dealId, itemName, buyerName } или null.

// Запрашиваем у Playerok данные чата и его сделки.
// Шаг 1: chat(UUID!) → deals { id } + lastMessage.user (ник покупателя из последнего сообщения)
// Шаг 2: deal(UUID!) → item.name  (если нашли dealId на шаге 1)
const QUERY_CHAT_INFO = `query chatInfo($id: UUID!) {
  chat(id: $id) {
    id
    deals { id }
    lastMessage { user { id username } }
  }
}`;

async function apiGetChatDeal(chatId) {
    let dealId = null;
    let buyerName = null;
    let itemName = null;

    // Шаг 1: получаем базовую инфу о чате
    try {
        const data = await playerokApi('chatInfo', QUERY_CHAT_INFO, { id: chatId });
        const chatNode = data?.chat;
        if (chatNode) {
            // deals — либо объект с id, либо массив; берём первый попавшийся id
            const deals = chatNode.deals;
            if (deals) {
                if (Array.isArray(deals) && deals[0]?.id) dealId = deals[0].id;
                else if (deals?.id) dealId = deals.id;
            }
            // ник из последнего сообщения (обычно покупатель пишет последним)
            buyerName = chatNode.lastMessage?.user?.username || null;
        }
    } catch (e) {
        console.warn(`[apiGetChatDeal] chatInfo failed: ${e?.message}`);
    }

    // Шаг 2: по dealId получаем название игры
    if (dealId) {
        try {
            const dd = await apiGetDealDetails(dealId);
            itemName = dd?.deal?.item?.name || null;
            // deal.user — покупатель (поле buyer не существует в схеме)
            if (dd?.deal?.user?.username) buyerName = dd.deal.user.username;
        } catch (e) {
            console.warn(`[apiGetChatDeal] dealDetails failed: ${e?.message}`);
        }
    }

    if (!dealId && !buyerName) return null;
    return { dealId, itemName, buyerName };
}

// Настройте запросы по данным из Network (playerok.com/graphql) → вкладка Network → Payload
const QUERY_CHAT_MESSAGES = `query ChatMessages($chatId: ID!) { chat(id: $chatId) { id messages(first: 20) { edges { node { id text isFromMe createdAt } } } } }`;

// Playerok мог сменить имя мутации. Варианты для перебора (проверь Network при ручной отметке заказа):
const MUTATIONS_FULFILLED = [
    { name: 'updateDeal', query: `mutation updateDeal($input: UpdateItemDealInput!) { updateDeal(input: $input) { id status __typename } }`, inputMode: true },
    { name: 'FulfillDeal', query: `mutation FulfillDeal($dealId: ID!) { fulfillDeal(dealId: $dealId) { id } }` },
    { name: 'CompleteDeal', query: `mutation CompleteDeal($dealId: ID!) { completeDeal(dealId: $dealId) { id } }` },
    { name: 'MarkDealFulfilled', query: `mutation MarkDealFulfilled($dealId: ID!) { markDealFulfilled(dealId: $dealId) { id } }` },
];

async function checkViewerSession() {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const data = await playerokApi('viewer', VIEWER_QUERY, {});
            if (!data?.viewer?.id) {
                if (attempt < maxAttempts) {
                    console.warn(`[checkViewerSession] viewer null, попытка ${attempt}/${maxAttempts}, жду 5 сек...`);
                    await sleep(5000);
                    continue;
                }
                log('🚨 ОШИБКА: Нужно зайти в аккаунт Playerok');
                return false;
            }
            currentUserId = data.viewer.id;
            MY_USER_ID = data.viewer.id; // dynamic — no hardcoded IDs
            chrome.storage.local.set({ playerokUserId: data.viewer.id });
            if (data.viewer.username) {
                currentPlayerokUsername = data.viewer.username;
                chrome.storage.local.set({ playerokUsername: currentPlayerokUsername });
            }
            log(`✅ Bridge подключен. Авторизован как [${data.viewer.username || 'id:' + data.viewer.id}]`);
            return true;
        } catch (e) {
            if (attempt < maxAttempts) {
                console.warn(`[checkViewerSession] ошибка попытка ${attempt}/${maxAttempts}: ${e.message}, жду 5 сек...`);
                await sleep(5000);
                continue;
            }
            log('🚨 ОШИБКА: Нужно зайти в аккаунт Playerok');
            return false;
        }
    }
    return false;
}

let apiScanInProgress = false;

async function updateMonitoredChats(chatId) {
    const key = 'monitored_chats';
    const data = await chrome.storage.local.get([key]);
    let chats = data[key] || {};
    chats[chatId] = Date.now();
    const limit = Date.now() - (48 * 60 * 60 * 1000); // 48ч — кто купил вчера, может вернуться за кодом сегодня
    for (const id in chats) {
        if (chats[id] < limit) delete chats[id];
    }
    await chrome.storage.local.set({ [key]: chats });
}

async function registerChatForMonitor(chatId) {
    if (!chatId) return;
    await updateMonitoredChats(chatId);
    console.log(`📡 [${chatId}] Чат добавлен в список мониторинга 2FA.`);
}

async function getMonitoredChatsDetail() {
    const raw = await new Promise((r) => chrome.storage.local.get(['monitored_chats', ORDERS_HISTORY_KEY], r));
    const mc = raw.monitored_chats || {};
    const history = raw[ORDERS_HISTORY_KEY] || [];
    const ids = Object.keys(mc);
    if (ids.length === 0) return [];
    const extraKeys = ids.flatMap((id) => [`deal_for_chat_${id}`, `order_${id}`, `issued_creds_${id}`, `manual_meta_${id}`]);
    const data = await new Promise((r) => chrome.storage.local.get(extraKeys, r));
    return ids.map((chatId) => {
        const ord = data[`order_${chatId}`];
        const issued = data[`issued_creds_${chatId}`];
        const meta = data[`manual_meta_${chatId}`];
        // Ищем имя покупателя и название игры в истории заказов
        const histRow = history.find(r => r.chatId === chatId);
        return {
            chatId,
            since: mc[chatId],
            dealId: data[`deal_for_chat_${chatId}`] || null,
            uuid: (ord && ord.uuid) ? String(ord.uuid) : (issued?.uuid || null),
            buyerName: histRow?.buyerName || ord?.buyerName || meta?.buyerName || null,
            gameTitle: histRow?.gameTitle || meta?.gameTitle || null,
            login: issued?.login || histRow?.login || null,
            chatUrl: `https://playerok.com/chats/${chatId}`
        };
    }).sort((a, b) => (b.since || 0) - (a.since || 0));
}

// MY_USER_ID resolved dynamically from viewer API — never hardcoded
let MY_USER_ID = null; // populated by checkViewerSession()

// Поле в схеме — chats (не userChats). operationName = userChats как в браузере.
// Built dynamically so userId uses the resolved MY_USER_ID at call time
function getBridgeChatQueries() {
    return [
        MY_USER_ID
            ? { name: 'userChats', query: `query userChats { chats(pagination: { first: 20 }, filter: { userId: "${MY_USER_ID}" }) { edges { node { id lastMessage { text createdAt user { id } } } } } }` }
            : null,
        { name: 'chatsFirst', query: `query chats { chats(first: 20) { edges { node { id lastMessage { text createdAt user { id } } } } } }` },
        { name: 'dealsWithChat', query: `query dealsWithChat { deals(first: 20) { edges { node { id chat { id lastMessage { text createdAt user { id } } } } } } }` },
        { name: 'viewerChats', query: `query viewerChats { viewer { chats(first: 20) { edges { node { id lastMessage { text createdAt user { id } } } } } } }` }
    ].filter(Boolean);
}

function parseChatsFromData(data) {
    let edges = null;
    if (data?.chats?.edges) edges = data.chats.edges;
    else if (data?.userChats?.edges) edges = data.userChats.edges;
    else if (data?.viewer?.chats?.edges) edges = data.viewer.chats.edges;
    else if (data?.deals?.edges) {
        edges = data.deals.edges.map(e => {
            const deal = e.node || e;
            const chat = deal.chat;
            return chat ? { node: { id: chat.id, lastMessage: chat.lastMessage } } : null;
        }).filter(Boolean);
    }
    if (!Array.isArray(edges)) return null;
    return edges.map(e => {
        const node = (e.node || e);
        const lastMsg = node?.lastMessage || node?.last_message || node?.message;
        const text = lastMsg?.text ?? lastMsg?.content ?? lastMsg?.body ?? "";
        const authorId = lastMsg?.user?.id ?? lastMsg?.sender?.id ?? lastMsg?.userId;
        return { chatId: node.id, text: String(text || ""), authorId: authorId || null, time: lastMsg?.createdAt ?? lastMsg?.created_at };
    });
}

async function fetchChatsViaBridge() {
    for (const { name, query } of getBridgeChatQueries()) {
        try {
            const data = await playerokApi(name, query, {});
            const chats = parseChatsFromData(data);
            if (chats) {
                console.log(`🛰 Bridge: ${name} OK, ${chats.length} чатов`);
                return chats;
            }
        } catch (_) { }
    }
    return null;
}

async function fetchAllChatsFromSpy() {
    try {
        const tabs = await chrome.tabs.query({ url: '*://*.playerok.com/*' });
        if (!tabs.length) return null;

        const sendWithTimeout = () => Promise.race([
            chrome.tabs.sendMessage(tabs[0].id, { action: 'SCAN_ALL_CHATS' }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
        ]);

        let response;
        try {
            response = await sendWithTimeout();
        } catch (e) {
            if (e.message?.includes('Receiving end does not exist')) {
                await chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, files: ['content_playerok.js'] });
                await new Promise(r => setTimeout(r, 500));
                response = await sendWithTimeout().catch(() => null);
            } else {
                return null;
            }
        }
        if (response?.success && response.chats) return response.chats;
        return await fetchChatsViaBridge();
    } catch (e) {
        return await fetchChatsViaBridge();
    }
}

async function fetchChatHistoryHTML(chatId) {
    const chats = await fetchAllChatsFromSpy();
    if (!chats) return null;
    const chat = chats.find(c => c.chatId === chatId);
    if (!chat) return null;
    return {
        id: `msg_${chatId}_${Date.now()}`,
        text: chat.text || '',
        content: chat.text || '',
        authorId: chat.authorId,
        created_at: chat.time,
        createdAt: chat.time
    };
}
