document.addEventListener('DOMContentLoaded', async () => {

    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const applyBtn = document.getElementById('applyBtn');

    const statusText = document.getElementById('statusText');
    const logsDiv = document.getElementById('logs');

    const minDelayInp = document.getElementById('minDelay');
    const maxDelayInp = document.getElementById('maxDelay');
    const fulfillManualOffsetInp = document.getElementById('fulfillManualOffset');

    const usernameInput = document.getElementById('usernameInput');

    chrome.storage.local.get(['playerokUsername'], (r) => {
        if (r.playerokUsername && usernameInput) usernameInput.value = r.playerokUsername;
    });

    function saveSettings() {
        const minDelay = parseInt(minDelayInp.value, 10) || 3;
        const maxDelay = parseInt(maxDelayInp.value, 10) || 6;
        const username = (usernameInput && usernameInput.value.trim()) || '';
        const day = new Date().toISOString().slice(0, 10);
        let fulfillManualOffset = parseInt(fulfillManualOffsetInp && fulfillManualOffsetInp.value, 10);
        if (Number.isNaN(fulfillManualOffset) || fulfillManualOffset < 0) fulfillManualOffset = 0;
        if (fulfillManualOffset > 24) fulfillManualOffset = 24;

        const toSave = {
            minDelay,
            maxDelay,
            fulfillManualOffset,
            fulfillManualOffsetDate: day
        };
        if (username) toSave.playerokUsername = username;
        chrome.storage.local.set(toSave);

        chrome.runtime.sendMessage({
            action: 'UPDATE_SETTINGS',
            settings: { minDelay, maxDelay, playerokUsername: username || undefined }
        });
    }

    chrome.storage.local.get(['isRunning', 'logs', 'minDelay', 'maxDelay', 'currentMode', 'userDatabase', 'greetedUsers', 'fulfillManualOffset', 'fulfillManualOffsetDate'], (result) => {
        if (result.isRunning) {
            // Проверяем реальный флаг в background — storage может быть stale после перезагрузки SW
            chrome.runtime.sendMessage({ action: 'GET_RUNNING_STATE' }, (res) => {
                if (chrome.runtime.lastError || !res) {
                    // SW не ответил или упал — сбрасываем залипший флаг
                    chrome.storage.local.set({ isRunning: false });
                    setRunningState(false);
                } else {
                    setRunningState(!!res.isRunning);
                    if (!res.isRunning) chrome.storage.local.set({ isRunning: false });
                }
            });
        }
        if (result.logs) {
            logsDiv.textContent = result.logs.join('\n');
            logsDiv.scrollTop = logsDiv.scrollHeight;
        }
        if (result.currentMode && result.currentMode !== 'Остановлен') {
            statusText.textContent = result.currentMode;
            statusText.style.color = '#00ff00';
        }

        if (result.minDelay) minDelayInp.value = result.minDelay;
        if (result.maxDelay) maxDelayInp.value = result.maxDelay;
        const today = new Date().toISOString().slice(0, 10);
        if (fulfillManualOffsetInp && result.fulfillManualOffsetDate === today && result.fulfillManualOffset != null) {
            fulfillManualOffsetInp.value = String(result.fulfillManualOffset);
        }

        updateGreetingStats();
    });

    startBtn.addEventListener('click', () => {
        saveSettings();
        chrome.storage.local.set({
            isRunning: true,
            logs: ['🚀 Запуск бота...']
        });

        chrome.runtime.sendMessage({ action: 'START', mode: 'AUTO_FULFILL' });
        setRunningState(true);
    });

    stopBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'GLOBAL_STOP' });
        chrome.storage.local.set({ isRunning: false });
        // Показываем промежуточное состояние «Остановка...» — background может завершать
        // текущий запрос (shadow monitor, apiScanOrders) ещё несколько секунд.
        stopBtn.disabled = true;
        startBtn.disabled = true;
        statusText.textContent = 'Остановка...';
        statusText.style.color = '#ff9800';
        // Через 2.5 сек считаем что фон завершил работу и переходим в полный STOP
        setTimeout(() => {
            setRunningState(false);
            statusText.textContent = 'Остановлен';
            statusText.style.color = '#cf6679';
        }, 2500);
    });

    const resetBtn = document.getElementById('resetBtn');

    const clearLogsBtn = document.getElementById('clearLogsBtn');
    clearLogsBtn?.addEventListener('click', () => {
        chrome.storage.local.set({ logs: [] });
        logsDiv.textContent = '';
    });

    const exportLogsBtn = document.getElementById('exportLogsBtn');
    exportLogsBtn?.addEventListener('click', () => {
        const text = logsDiv.textContent || '';
        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `autoscript_log_${new Date().toISOString().slice(0, 10)}.txt`;
        a.click();
        URL.revokeObjectURL(url);
    });

    resetBtn.addEventListener('click', () => {
        if (confirm('Сбросить только мониторинг 2FA (список чатов)?\n\nЭто НЕ снимает «Заказ уже обработан — пропуск». Для залипшего PAID нажмите «Сбросить обработанные заказы» ниже.')) {
            chrome.runtime.sendMessage({ action: 'CLEAR_MONITORED_CHATS' });
            statusText.textContent = 'Мониторинг 2FA сброшен';
            setTimeout(() => {
                if (!startBtn.disabled) statusText.textContent = 'Готов к работе';
            }, 2000);
        }
    });

    const resetFulfillProcessedBtn = document.getElementById('resetFulfillProcessedBtn');
    if (resetFulfillProcessedBtn) {
        resetFulfillProcessedBtn.addEventListener('click', () => {
            if (!confirm('Сбросить список уже обработанных сделок автовыдачи?\n\nНужно, если бот пишет «Заказ уже обработан — пропуск», а выдачи не было. После сброса следующий цикл попробует выдать снова.\n\nМониторинг 2FA и лимит выдач за сегодня не сбрасываются.')) return;
            chrome.runtime.sendMessage({ action: 'RESET_FULFILL_PROCESSED_DEALS' }, () => {
                const err = chrome.runtime.lastError;
                if (err) {
                    statusText.textContent = 'Ошибка: ' + (err.message || 'sendMessage');
                    return;
                }
                statusText.textContent = 'Обработанные заказы сброшены — дождитесь следующего цикла';
                setTimeout(() => {
                    if (!startBtn.disabled) statusText.textContent = 'Готов к работе';
                }, 3500);
            });
        });
    }

    const resetGreetingStatsBtn = document.getElementById('resetGreetingStatsBtn');
    resetGreetingStatsBtn?.addEventListener('click', () => {
        if (!confirm('Обнулить счётчики «приветствий» и «пользователей в БД»?\n\nЛимит 24 выдачи за сегодня, очередь заказов и мониторинг 2FA не затрагиваются.')) return;
        chrome.runtime.sendMessage({ action: 'RESET_GREETING_USER_STATS' }, () => {
            const err = chrome.runtime.lastError;
            if (err) {
                statusText.textContent = 'Ошибка: ' + (err.message || 'sendMessage');
                return;
            }
            updateGreetingStats();
            statusText.textContent = 'Счётчики приветствий / БД обнулены';
            setTimeout(() => {
                if (!startBtn.disabled) statusText.textContent = 'Готов к работе';
            }, 2500);
        });
    });

    const resetBoostHistoryBtn = document.getElementById('resetBoostHistoryBtn');
    if (resetBoostHistoryBtn) {
        resetBoostHistoryBtn.addEventListener('click', () => {
            if (confirm('Очистить список уже обработанных лотов для автоподнятия? Сканер снова сможет брать те же URL (как при первом запуске).')) {
                chrome.runtime.sendMessage({ action: 'CLEAR_PROCESSED_LISTINGS' }, () => {
                    const err = chrome.runtime.lastError;
                    if (err) {
                        statusText.textContent = 'Ошибка: ' + (err.message || 'sendMessage');
                        return;
                    }
                    statusText.textContent = 'История автоподнятия очищена';
                    setTimeout(() => {
                        if (!startBtn.disabled) statusText.textContent = 'Готов к работе';
                    }, 2000);
                });
            }
        });
    }

    applyBtn.addEventListener('click', () => {
        saveSettings();
        const originalText = applyBtn.textContent;
        applyBtn.textContent = 'Сохранено!';
        applyBtn.style.color = '#00ff00';
        setTimeout(() => {
            applyBtn.textContent = originalText;
            applyBtn.style.color = '';
        }, 1000);
    });

    function setRunningState(running) {
        startBtn.disabled = running;
        stopBtn.disabled = !running;

        if (running) {
            statusText.textContent = 'Работает...';
            statusText.style.color = '#00ff00';
        }
    }

    const monitoredListEl = document.getElementById('monitoredList');
    const refreshMonitorBtn = document.getElementById('refreshMonitorBtn');

    function formatMonitoredSince(ts) {
        if (!ts) return '—';
        try {
            return new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        } catch (_) {
            return '—';
        }
    }

    function renderMonitoredList(items) {
        if (!monitoredListEl) return;
        monitoredListEl.textContent = '';

        const countEl = document.getElementById('monitorCount');
        if (countEl) countEl.textContent = items && items.length > 0 ? `${items.length} чатов` : '0 чатов';

        if (!items || items.length === 0) {
            const li = document.createElement('li');
            li.className = 'chat-empty';
            li.textContent = 'Нет активных чатов в мониторинге.';
            monitoredListEl.appendChild(li);
            return;
        }

        items.forEach((row) => {
            const li = document.createElement('li');
            li.className = 'chat-card';

            // Аватар
            const avatar = document.createElement('div');
            const name = row.buyerName || '';
            if (name) {
                avatar.className = 'chat-avatar';
                avatar.textContent = name.charAt(0).toUpperCase();
            } else {
                avatar.className = 'chat-avatar unknown';
                avatar.textContent = '?';
            }

            // Инфо
            const info = document.createElement('div');
            info.className = 'chat-info';

            const nameEl = document.createElement('div');
            nameEl.className = 'chat-name';
            nameEl.textContent = name || 'Неизвестный покупатель';

            const gameEl = document.createElement('div');
            gameEl.className = 'chat-game';
            gameEl.textContent = row.gameTitle || (row.login ? `Логин: ${row.login}` : 'Игра не определена');

            const metaEl = document.createElement('div');
            metaEl.className = 'chat-meta';
            const sinceStr = formatMonitoredSince(row.since);
            const uuidStr = row.uuid ? ` · SP: ${String(row.uuid).slice(0, 6)}…` : '';
            metaEl.textContent = `с ${sinceStr}${uuidStr}`;

            info.appendChild(nameEl);
            info.appendChild(gameEl);
            info.appendChild(metaEl);

            // Кнопки
            const btns = document.createElement('div');
            btns.className = 'chat-btns';

            const openBtn = document.createElement('a');
            openBtn.className = 'btn-chat-open';
            openBtn.href = row.chatUrl;
            openBtn.target = '_blank';
            openBtn.rel = 'noopener';
            openBtn.textContent = '→ Чат';

            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'btn-chat-del';
            delBtn.textContent = 'Удалить';
            delBtn.addEventListener('click', async () => {
                if (!confirm(`Убрать ${name || row.chatId.slice(0, 8)} из мониторинга?\n\nЧат не будет автоматически добавлен снова даже если покупатель напишет.`)) return;
                // Удаляем напрямую из storage — не ждём background,
                // чтобы гарантировать работу даже если Service Worker засыпает.
                try {
                    delBtn.disabled = true;
                    delBtn.textContent = '...';
                    const TTL_48H = 48 * 60 * 60 * 1000;
                    const now = Date.now();
                    const raw = await chrome.storage.local.get(['monitored_chats', 'manually_removed_chats']);
                    const mc = { ...(raw.monitored_chats || {}) };
                    const mr = { ...(raw.manually_removed_chats || {}) };
                    delete mc[row.chatId];
                    mr[row.chatId] = now + TTL_48H;
                    // Чистим протухшие записи blocklist
                    for (const id in mr) { if (now > mr[id]) delete mr[id]; }
                    await chrome.storage.local.set({ monitored_chats: mc, manually_removed_chats: mr });
                    // Сообщаем background для cleanup InFlight/лога (fire-and-forget, ошибки игнорируем)
                    chrome.runtime.sendMessage({ action: 'REMOVE_MONITORED_CHAT', chatId: row.chatId }).catch(() => {});
                    refreshMonitoredList();
                } catch (e) {
                    console.error('[delBtn] Ошибка удаления:', e);
                    alert('Ошибка при удалении: ' + (e?.message || e));
                    delBtn.disabled = false;
                    delBtn.textContent = 'Удалить';
                }
            });

            btns.appendChild(openBtn);
            btns.appendChild(delBtn);

            li.appendChild(avatar);
            li.appendChild(info);
            li.appendChild(btns);
            monitoredListEl.appendChild(li);
        });
    }

    async function refreshMonitoredList() {
        if (!monitoredListEl) return;
        try {
            // Читаем напрямую из storage — не зависим от Service Worker
            const ORDERS_HISTORY_KEY = 'orders_history_db';
            const raw = await chrome.storage.local.get(['monitored_chats', ORDERS_HISTORY_KEY]);
            const mc = raw.monitored_chats || {};
            const history = raw[ORDERS_HISTORY_KEY] || [];
            const ids = Object.keys(mc);
            if (ids.length === 0) { renderMonitoredList([]); return; }

            const extraKeys = ids.flatMap(id => [
                `deal_for_chat_${id}`, `order_${id}`, `issued_creds_${id}`, `manual_meta_${id}`
            ]);
            const extra = await chrome.storage.local.get(extraKeys);

            const items = ids.map(chatId => {
                const ord = extra[`order_${chatId}`];
                const issued = extra[`issued_creds_${chatId}`];
                const meta = extra[`manual_meta_${chatId}`];
                const histRow = history.find(r => r.chatId === chatId);
                return {
                    chatId,
                    since: mc[chatId],
                    dealId: extra[`deal_for_chat_${chatId}`] || null,
                    uuid: (ord && ord.uuid) ? String(ord.uuid) : (issued?.uuid || null),
                    buyerName: histRow?.buyerName || ord?.buyerName || meta?.buyerName || null,
                    gameTitle: histRow?.gameTitle || meta?.gameTitle || null,
                    login: issued?.login || histRow?.login || null,
                    chatUrl: `https://playerok.com/chats/${chatId}`
                };
            }).sort((a, b) => (b.since || 0) - (a.since || 0));

            renderMonitoredList(items);
        } catch (e) {
            console.error('[refreshMonitoredList]', e);
            renderMonitoredList([]);
        }
    }

    if (refreshMonitorBtn) refreshMonitorBtn.addEventListener('click', () => refreshMonitoredList());
    refreshMonitoredList();
    const _monitorRefreshInterval = setInterval(refreshMonitoredList, 15000);
    window.addEventListener('beforeunload', () => clearInterval(_monitorRefreshInterval));

    chrome.storage.onChanged.addListener((changes) => {
        if (changes.logs) {
            logsDiv.textContent = changes.logs.newValue.join('\n');
            logsDiv.scrollTop = logsDiv.scrollHeight;
        }
        if (changes.isRunning) {
            setRunningState(changes.isRunning.newValue);
        }
        if (changes.userDatabase || changes.greetedUsers) {
            updateGreetingStats();
        }
        if (changes.monitored_chats) refreshMonitoredList();
    });

    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.action === 'TIMER_UPDATE') {
            if (msg.seconds > 0) {
                statusText.textContent = `След. действие: ${msg.seconds}с`;
                statusText.style.color = '#ff9800';
            }
        }
        if (msg.action === 'UPDATE_MODE') {
            statusText.textContent = msg.mode;
        }
    });

    function updateGreetingStats() {
        chrome.storage.local.get(['userDatabase', 'greetedUsers'], (result) => {
            const dbCount = Object.keys(result.userDatabase || {}).length;
            const greetedCount = (result.greetedUsers || []).length;

            document.getElementById('dbUserCount').textContent = dbCount;
            document.getElementById('greetingCount').textContent = greetedCount;
        });
    }

    // --- Ручное добавление клиента ---
    const manualAddBtn = document.getElementById('manualAddBtn');
    const manualChatInput = document.getElementById('manualChatInput');
    const manualUuidInput = document.getElementById('manualUuidInput');
    const manualAddStatus = document.getElementById('manualAddStatus');

    function setManualStatus(text, cls) {
        if (!manualAddStatus) return;
        manualAddStatus.textContent = text;
        manualAddStatus.className = cls || '';
    }

    function parseChatId(raw) {
        if (!raw) return '';
        raw = raw.trim();
        // Извлекаем из URL: playerok.com/chat/XXXXX
        const m = raw.match(/\/chats?\/([a-zA-Z0-9_-]+)/);
        if (m) return m[1];
        // Просто ID
        if (/^[a-zA-Z0-9_-]{6,}$/.test(raw)) return raw;
        return '';
    }

    if (manualAddBtn) {
        manualAddBtn.addEventListener('click', () => {
            const chatId = parseChatId(manualChatInput?.value || '');
            if (!chatId) {
                setManualStatus('Укажите URL чата или chatId', 'err');
                return;
            }
            const uuid = (manualUuidInput?.value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '') || null;

            manualAddBtn.disabled = true;
            setManualStatus('Запрос отправлен, ждите...', 'pending');

            chrome.runtime.sendMessage({ action: 'ADD_MANUAL_BUYER', chatId, uuid }, (res) => {
                manualAddBtn.disabled = false;
                if (chrome.runtime.lastError) {
                    setManualStatus('Ошибка: ' + (chrome.runtime.lastError.message || 'sendMessage'), 'err');
                    return;
                }
                if (!res || !res.ok) {
                    setManualStatus('Ошибка: ' + (res?.error || 'нет ответа'), 'err');
                    return;
                }
                const statusMap = {
                    creds_updated: 'Данные обновились — новые отправлены в чат. Ожидаем 2FA.',
                    registered: 'Чат добавлен в мониторинг. Данные актуальны.',
                    lookup_done: 'Готово: данные найдены и отправлены, чат в мониторинге.',
                    no_uuid: 'Чат в мониторинге, но UUID не найден — данные не отправлены. Укажите UUID вручную.',
                };
                setManualStatus(statusMap[res.status] || 'Готово', 'ok');
                manualChatInput.value = '';
                if (manualUuidInput) manualUuidInput.value = '';
                refreshMonitoredList();
            });
        });

        manualChatInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') manualAddBtn.click();
        });
    }
});
