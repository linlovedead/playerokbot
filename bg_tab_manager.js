// ==========================================
// bg_tab_manager.js
// Загружается вторым (после bg_constants.js).
// Управление вкладками и окнами расширения:
//   • определение имени пользователя
//   • воркерные окна для буста, автовыдачи, публикации
//   • сканирование каталога «Завершённые» (для дашборда)
//   • глобальные обработчики chrome.tabs / chrome.windows
// Все состояния (boostWorkerWindowId, completedCatalogJob и т.д.) объявлены
// в background.js и видны здесь через общий глобальный скоуп importScripts.
// ==========================================

/**
 * Ищет никнейм пользователя среди ВСЕХ открытых вкладок playerok.com и в storage.
 * Вызывать перед getHomeUrl(), когда currentPlayerokUsername может быть null.
 */
function detectUsernameFromTabs(callback) {
    if (currentPlayerokUsername) { callback(); return; }
    chrome.tabs.query({ url: '*://*.playerok.com/*' }, (tabs) => {
        for (const t of (tabs || [])) {
            const m = (t.url || '').match(/playerok\.com\/profile\/([^/?#]+)\//);
            if (m && m[1]) {
                currentPlayerokUsername = m[1];
                chrome.storage.local.set({ playerokUsername: currentPlayerokUsername });
                break;
            }
        }
        callback();
    });
}

/** Пока вкладка about:blank / не playerok — не делаем tabs.update (иначе гонка: сначала 404/мусор, потом нормальный URL). */
function waitForPlayerokNavigation(tabId, callback) {
    chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
            callback();
            return;
        }
        const u = tab.url || '';
        if (isUsablePlayerokScannerUrl(u)) {
            callback();
            return;
        }
        let done = false;
        const listener = (id, changeInfo, t) => {
            if (id !== tabId || done) return;
            const nu = (t && t.url) || changeInfo.url || '';
            if (isUsablePlayerokScannerUrl(nu)) {
                done = true;
                chrome.tabs.onUpdated.removeListener(listener);
                callback();
            }
        };
        chrome.tabs.onUpdated.addListener(listener);
        setTimeout(() => {
            if (done) return;
            done = true;
            chrome.tabs.onUpdated.removeListener(listener);
            callback();
        }, 25000);
    });
}

function saveBoostWorkerWindowId(id) {
    boostWorkerWindowId = id === null || id === undefined ? null : id;
    if (boostWorkerWindowId != null) {
        chrome.storage.local.set({ [BOOST_WORKER_WINDOW_KEY]: boostWorkerWindowId });
    } else {
        chrome.storage.local.remove([BOOST_WORKER_WINDOW_KEY]);
    }
}

/**
 * Отдельное окно только для сканера: в основном окне можно открывать любые вкладки Playerok — скрипт не привязан к ним.
 * Раньше брался любой playerok-таб → навигация в другой вкладке ломала mainTabId.
 */
function pickPlayerokTabForBoost(callback) {
    chrome.storage.local.get([BOOST_WORKER_WINDOW_KEY, 'playerokUsername'], (r) => {
        if (r.playerokUsername) {
            currentPlayerokUsername = r.playerokUsername;
        }
        // Если username всё ещё неизвестен — сканируем открытые вкладки Playerok
        detectUsernameFromTabs(() => {
            const homeUrl = getHomeUrl();

            function tryUseWindow(winId) {
                chrome.tabs.query({ windowId: winId }, (tabs) => {
                    if (chrome.runtime.lastError) {
                        saveBoostWorkerWindowId(null);
                        openFreshWindow();
                        return;
                    }
                    const list = (tabs || []).filter(t => {
                        const u = t.url || '';
                        return isUsablePlayerokScannerUrl(u);
                    });
                    const onCompleted = list.find(t => (t.url || '').includes('/products/completed'));
                    if (onCompleted) { callback(onCompleted.id); return; }
                    const anyProducts = list.find(t => (t.url || '').includes('/products/'));
                    if (anyProducts) { callback(anyProducts.id); return; }
                    const anyProfile = list.find(t => /playerok\.com\/profile\//.test(t.url || ''));
                    if (anyProfile) { callback(anyProfile.id); return; }
                    if (list.length) { callback(list[0].id); return; }
                    chrome.tabs.create({ windowId: winId, url: homeUrl, active: true }, (tab) => {
                        if (chrome.runtime.lastError || !tab?.id) {
                            boostLog(`❌ Не удалось открыть вкладку в окне автопубликации: ${chrome.runtime.lastError?.message || 'unknown'}`);
                            return;
                        }
                        callback(tab.id);
                    });
                });
            }

            function openFreshWindow() {
                chrome.windows.create({
                    url: homeUrl,
                    focused: false,
                    width: 1100,
                    height: 800,
                    type: 'normal'
                }, (win) => {
                    if (chrome.runtime.lastError || !win?.id || !win.tabs?.[0]?.id) {
                        boostLog(`❌ Не удалось открыть окно автопубликации: ${chrome.runtime.lastError?.message || 'unknown'}`);
                        return;
                    }
                    saveBoostWorkerWindowId(win.id);
                    boostLog('🪟 Открыто отдельное окно только для сканера. В основном окне можно спокойно открывать другие вкладки Playerok.');
                    callback(win.tabs[0].id);
                });
            }

            const wid = r[BOOST_WORKER_WINDOW_KEY] ?? boostWorkerWindowId;
            if (wid != null) {
                chrome.windows.get(wid, (win) => {
                    if (chrome.runtime.lastError || !win) {
                        saveBoostWorkerWindowId(null);
                        openFreshWindow();
                        return;
                    }
                    tryUseWindow(wid);
                });
            } else {
                openFreshWindow();
            }
        }); // end detectUsernameFromTabs
    }); // end storage.get
}

/** Отдельное окно для автовыдачи — по тому же принципу, что и pickPlayerokTabForBoost. */
function pickPlayerokTabForFulfill(callback) {
    chrome.storage.local.get([FULFILL_WORKER_WINDOW_KEY, 'playerokUsername'], (r) => {
        if (r.playerokUsername) currentPlayerokUsername = r.playerokUsername;
        detectUsernameFromTabs(() => {
            const salesUrl = getSalesUrl();

            function tryUseWindow(winId) {
                chrome.tabs.query({ windowId: winId }, (tabs) => {
                    if (chrome.runtime.lastError) {
                        fulfillWorkerWindowId = null;
                        chrome.storage.local.remove([FULFILL_WORKER_WINDOW_KEY]);
                        openFreshWindow();
                        return;
                    }
                    const list = (tabs || []).filter(t => isUsablePlayerokScannerUrl(t.url || ''));
                    const onSales = list.find(t => (t.url || '').includes('/sales'));
                    if (onSales) { callback(onSales.id); return; }
                    const anyProfile = list.find(t => /playerok\.com\/profile\//.test(t.url || ''));
                    if (anyProfile) { callback(anyProfile.id); return; }
                    if (list.length) { callback(list[0].id); return; }
                    chrome.tabs.create({ windowId: winId, url: salesUrl, active: true }, (tab) => {
                        if (chrome.runtime.lastError || !tab?.id) {
                            log(`❌ Не удалось открыть вкладку в окне автовыдачи: ${chrome.runtime.lastError?.message || 'unknown'}`);
                            return;
                        }
                        callback(tab.id);
                    });
                });
            }

            function openFreshWindow() {
                chrome.windows.create({ url: salesUrl, focused: false, width: 1100, height: 800, type: 'normal' }, (win) => {
                    if (chrome.runtime.lastError || !win?.id || !win.tabs?.[0]?.id) {
                        log(`❌ Не удалось открыть окно автовыдачи: ${chrome.runtime.lastError?.message || 'unknown'}`);
                        return;
                    }
                    fulfillWorkerWindowId = win.id;
                    chrome.storage.local.set({ [FULFILL_WORKER_WINDOW_KEY]: win.id });
                    log('🪟 Открыто отдельное окно для автовыдачи. В основном окне можно открывать другие страницы.');
                    callback(win.tabs[0].id);
                });
            }

            const wid = r[FULFILL_WORKER_WINDOW_KEY] ?? fulfillWorkerWindowId;
            if (wid != null) {
                chrome.windows.get(wid, (win) => {
                    if (chrome.runtime.lastError || !win) {
                        fulfillWorkerWindowId = null;
                        chrome.storage.local.remove([FULFILL_WORKER_WINDOW_KEY]);
                        openFreshWindow();
                        return;
                    }
                    tryUseWindow(wid);
                });
            } else {
                openFreshWindow();
            }
        }); // end detectUsernameFromTabs
    }); // end storage.get
}

// ==========================================
// ИНИЦИАЛИЗАЦИЯ ВОРКЕРНЫХ ОКОН ИЗ STORAGE
// ==========================================
chrome.storage.local.get([BOOST_WORKER_WINDOW_KEY, FULFILL_WORKER_WINDOW_KEY, PUBLISHER_WORKER_WINDOW_KEY], (r) => {
    if (r[BOOST_WORKER_WINDOW_KEY] != null) boostWorkerWindowId = r[BOOST_WORKER_WINDOW_KEY];
    if (r[FULFILL_WORKER_WINDOW_KEY] != null) fulfillWorkerWindowId = r[FULFILL_WORKER_WINDOW_KEY];
    if (r[PUBLISHER_WORKER_WINDOW_KEY] != null) publisherWorkerWindowId = r[PUBLISHER_WORKER_WINDOW_KEY];
});

chrome.windows.onRemoved.addListener((windowId) => {
    if (boostWorkerWindowId != null && windowId === boostWorkerWindowId) {
        boostWorkerWindowId = null;
        chrome.storage.local.remove([BOOST_WORKER_WINDOW_KEY]);
    }
    if (fulfillWorkerWindowId != null && windowId === fulfillWorkerWindowId) {
        fulfillWorkerWindowId = null;
        chrome.storage.local.remove([FULFILL_WORKER_WINDOW_KEY]);
    }
    if (publisherWorkerWindowId != null && windowId === publisherWorkerWindowId) {
        publisherWorkerWindowId = null;
        chrome.storage.local.remove([PUBLISHER_WORKER_WINDOW_KEY]);
    }
    if (completedCatalogJob != null && completedCatalogJob.windowId === windowId) {
        finishCompletedCatalogJob({ ok: false, error: 'Окно закрыто до завершения сбора.', items: [], draftCount: 0 });
    }
});

// ==========================================
// СВОДКА: СКАН «ЗАВЕРШЁННЫЕ» (ДАШБОРД)
// ==========================================

function clearCompletedCatalogJobTimer() {
    if (completedCatalogJob && completedCatalogJob.timeoutId) {
        clearTimeout(completedCatalogJob.timeoutId);
        completedCatalogJob.timeoutId = null;
    }
}

function clearCompletedCatalogArmTimer() {
    if (completedCatalogJob && completedCatalogJob.armTimer) {
        clearTimeout(completedCatalogJob.armTimer);
        completedCatalogJob.armTimer = null;
    }
}

function tryStartCompletedCatalogScanFromTab(tabId) {
    if (!completedCatalogJob || completedCatalogJob.tabId !== tabId) return;
    if (completedCatalogJob.loadHandled) return;
    chrome.tabs.get(tabId, (t) => {
        if (!completedCatalogJob || completedCatalogJob.tabId !== tabId) return;
        if (completedCatalogJob.loadHandled) return;
        if (chrome.runtime.lastError || !t || !t.url) return;
        const url = t.url;
        const phase = completedCatalogJob.scanPhase || 'completed';
        if (phase === 'completed' && !/\/products\/completed/i.test(url)) return;
        if (phase === 'drafts' && !/\/products\/drafts/i.test(url)) return;
        if (phase === 'published' && !/\/products(?:\/active)?\/?$/i.test(new URL(url).pathname)) return;
        completedCatalogJob.loadHandled = true;
        log(`[Dashboard] Сводка: старт скана (${phase}), вкладка ${tabId} — ${url.slice(0, 72)}`);
        scheduleCompletedCatalogContentScan(tabId);
    });
}

function armCompletedCatalogScan(tabId) {
    if (!completedCatalogJob || completedCatalogJob.tabId !== tabId) return;
    clearCompletedCatalogArmTimer();
    completedCatalogJob.armTimer = setTimeout(() => {
        if (completedCatalogJob) completedCatalogJob.armTimer = null;
        tryStartCompletedCatalogScanFromTab(tabId);
    }, 500);
}

async function injectCatalogContentScripts(tabId) {
    try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content_bridge.js'] });
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js', 'content_greeting.js', 'content_playerok.js'] });
        log(`[Dashboard] Повторно подгружены content-scripts (вкладка ${tabId})`);
    } catch (e) {
        log(`[Dashboard] injectCatalogContentScripts: ${e && e.message ? e.message : e}`);
    }
}

function finishCompletedCatalogJob(result) {
    const job = completedCatalogJob;
    if (!job) return;
    clearCompletedCatalogJobTimer();
    clearCompletedCatalogArmTimer();
    completedCatalogJob = null;
    const winId = job.windowId;
    const respond = job.sendResponse;
    if (winId != null) {
        try {
            chrome.windows.remove(winId, () => { void chrome.runtime.lastError; });
        } catch (_) { /* */ }
    }
    try {
        if (typeof respond === 'function') respond(result);
    } catch (_) { /* */ }
}

function scheduleCompletedCatalogContentScan(tabId) {
    const scanPhase = (completedCatalogJob && completedCatalogJob.scanPhase) || 'completed';
    const maxAttempts = 14;
    const delayMs = 1100;
    const trySend = (attempt) => {
        chrome.tabs.sendMessage(tabId, { action: 'RUN_COMPLETED_CATALOG_SCAN', scanPhase }, () => {
            if (chrome.runtime.lastError) {
                const err = chrome.runtime.lastError.message || '';
                if (attempt === 5 || attempt === 11) {
                    injectCatalogContentScripts(tabId).then(() => {
                        setTimeout(() => trySend(attempt + 1), 500);
                    });
                    return;
                }
                if (attempt < maxAttempts) {
                    setTimeout(() => trySend(attempt + 1), delayMs);
                } else {
                    finishCompletedCatalogJob({
                        ok: false,
                        error: 'Не удалось запустить скан на странице: ' + err,
                        items: [],
                        draftCount: 0
                    });
                }
            }
        });
    };
    setTimeout(() => trySend(0), scanPhase === 'drafts' || scanPhase === 'published' ? 1400 : 1800);
}

// Переход по фазам сканирования каталога (completed → drafts → published)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!completedCatalogJob || completedCatalogJob.tabId !== tabId) return;
    const urlEvt = typeof changeInfo.url === 'string';
    const completeEvt = changeInfo.status === 'complete';
    if (!urlEvt && !completeEvt) return;
    if (urlEvt && completedCatalogJob.scanPhase === 'drafts' && /\/products\/drafts/i.test(changeInfo.url || '')) {
        completedCatalogJob.loadHandled = false;
    }
    if (urlEvt && completedCatalogJob.scanPhase === 'published') {
        try {
            const pname = new URL(changeInfo.url || '').pathname;
            if (/\/products(?:\/active)?\/?$/i.test(pname)) completedCatalogJob.loadHandled = false;
        } catch (_) { /* */ }
    }
    armCompletedCatalogScan(tabId);
});

// Инжектируем перехватчик fetch (world:MAIN) в каждую вкладку playerok.com.
// chrome.scripting.executeScript с world:MAIN гарантированно обходит CSP.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'loading' && changeInfo.status !== 'complete') return;
    const url = (tab && tab.url) || '';
    if (!/https?:\/\/(www\.)?playerok\.com\//i.test(url)) return;
    chrome.tabs.get(tabId, (t) => {
        if (chrome.runtime.lastError || !t) return;
        chrome.scripting.executeScript({
            target: { tabId, allFrames: false },
            files: ['content_bridge_main.js'],
            world: 'MAIN',
            injectImmediately: true
        }).catch(() => { });
    });
});

// Автоматический редирект воркер-вкладки с 404/ошибки на нужную страницу.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!mainTabId || tabId !== mainTabId) return;
    if (changeInfo.status !== 'complete') return;
    const url = tab.url || '';
    if (!isPlayerokErrorPageUrl(url)) return;

    chrome.storage.local.get(['playerokUsername'], (r) => {
        if (r.playerokUsername && !currentPlayerokUsername) currentPlayerokUsername = r.playerokUsername;
        const targetUrl = isOrderMode(currentBotMode) ? getSalesUrl() : getHomeUrl();
        log(`🔄 Воркер попал на /404 — перехожу на ${targetUrl}`);
        chrome.tabs.update(mainTabId, { url: targetUrl });
    });
});
