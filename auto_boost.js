document.addEventListener('DOMContentLoaded', () => {
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const deleteCompletedBtn = document.getElementById('deleteCompletedBtn');
    const applyBtn = document.getElementById('applyBtn');

    const statusText = document.getElementById('statusText');
    const progressText = document.getElementById('progressText');
    const progressBar = document.getElementById('progressBar');
    const logsDiv = document.getElementById('logs');

    const minDelayInp = document.getElementById('minDelay');
    const maxDelayInp = document.getElementById('maxDelay');
    const sleepTimeInp = document.getElementById('sleepTime');
    const boostIncludeDraftsCb = document.getElementById('boostIncludeDrafts');
    const boostFocusPlayerokTabCb = document.getElementById('boostFocusPlayerokTab');

    function saveSettings() {
        const minDelay = parseInt(minDelayInp.value, 10) || 3;
        const maxDelay = parseInt(maxDelayInp.value, 10) || 6;
        const sleepTime = parseInt(sleepTimeInp.value, 10) || 3;
        const boostIncludeDrafts = !!(boostIncludeDraftsCb && boostIncludeDraftsCb.checked);
        const boostFocusPlayerokTab = !!(boostFocusPlayerokTabCb && boostFocusPlayerokTabCb.checked);

        chrome.storage.local.set({ minDelay, maxDelay, sleepTime, boostIncludeDrafts, boostFocusPlayerokTab });
        chrome.runtime.sendMessage({
            action: 'UPDATE_SETTINGS',
            settings: { minDelay, maxDelay, sleepTime, boostIncludeDrafts, boostFocusPlayerokTab }
        });
    }

    chrome.storage.local.get(['isBoostRunning', 'boostLogs', 'processed', 'minDelay', 'maxDelay', 'sleepTime', 'currentMode',
        'daily_publisher_published', 'daily_publisher_published_date',
        'daily_boost_bumps', 'daily_boost_bumps_date',
        'boostIncludeDrafts', 'boostFocusPlayerokTab'], (result) => {
        if (result.isBoostRunning) {
            setRunningState(true);
        }
        if (result.boostLogs) {
            logsDiv.textContent = result.boostLogs.join('\n');
            logsDiv.scrollTop = logsDiv.scrollHeight;
        }
        if (result.currentMode && result.currentMode !== 'Остановлен') {
            statusText.textContent = result.currentMode;
            statusText.style.color = '#00ff00';
        }

        if (result.minDelay) minDelayInp.value = result.minDelay;
        if (result.maxDelay) maxDelayInp.value = result.maxDelay;
        if (result.sleepTime) sleepTimeInp.value = result.sleepTime;
        if (boostIncludeDraftsCb) boostIncludeDraftsCb.checked = !!result.boostIncludeDrafts;
        if (boostFocusPlayerokTabCb) boostFocusPlayerokTabCb.checked = !!result.boostFocusPlayerokTab;

        updateProgress(result.processed || 0);
        updateDailyStatsCounter(result);
    });

    startBtn.addEventListener('click', () => {
        saveSettings();
        chrome.storage.local.set({
            isBoostRunning: true,
            boostLogs: ['🚀 Запуск бота...']
        });

        chrome.runtime.sendMessage({ action: 'START', mode: 'AUTO_BOOST' });
        setRunningState(true);
    });

    stopBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'STOP_BOOST' });
        chrome.storage.local.set({ isBoostRunning: false });
        setRunningState(false);
        statusText.textContent = 'Остановлен';
        statusText.style.color = '#cf6679';
    });

    deleteCompletedBtn?.addEventListener('click', () => {
        if (!confirm('Удалить лоты из вкладки «Завершённые» на Playerok? Нужен STOP у автопубликации. Продолжить?')) return;
        deleteCompletedBtn.disabled = true;
        chrome.runtime.sendMessage({ action: 'START_DELETE_COMPLETED' }, (res) => {
            deleteCompletedBtn.disabled = false;
            if (chrome.runtime.lastError) {
                statusText.textContent = chrome.runtime.lastError.message;
                statusText.style.color = '#cf6679';
                return;
            }
            if (res && res.ok) {
                statusText.textContent = 'Удаление завершённых…';
                statusText.style.color = '#ff9800';
            } else if (res && res.error) {
                statusText.textContent = res.error;
                statusText.style.color = '#cf6679';
                alert(res.error);
            }
        });
    });

    const clearLogsBtn = document.getElementById('clearLogsBtn');
    clearLogsBtn?.addEventListener('click', () => {
        chrome.storage.local.set({ boostLogs: [] });
        logsDiv.textContent = '';
    });

    const exportLogsBtn = document.getElementById('exportLogsBtn');
    exportLogsBtn?.addEventListener('click', () => {
        const text = logsDiv.textContent || '';
        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `autoscript_boost_log_${new Date().toISOString().slice(0, 10)}.txt`;
        a.click();
        URL.revokeObjectURL(url);
    });

    boostIncludeDraftsCb?.addEventListener('change', () => {
        chrome.storage.local.set({ boostIncludeDrafts: boostIncludeDraftsCb.checked });
    });
    boostFocusPlayerokTabCb?.addEventListener('change', () => {
        chrome.storage.local.set({ boostFocusPlayerokTab: boostFocusPlayerokTabCb.checked });
    });

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

    function updateProgress(processed) {
        progressText.textContent = `Обработано: ${processed}`;
        progressBar.style.width = '100%';
    }

    function updateDailyStatsCounter(res) {
        const el = document.getElementById('dailyStatsCounter');
        if (!el) return;
        const today = new Date().toISOString().slice(0, 10);
        const pub = res.daily_publisher_published_date === today ? (Number(res.daily_publisher_published) || 0) : 0;
        const bump = res.daily_boost_bumps_date === today ? (Number(res.daily_boost_bumps) || 0) : 0;
        el.textContent = `выложено ${pub} · поднято ${bump}`;
        el.style.color = '#00ff00';
    }

    chrome.storage.onChanged.addListener((changes) => {
        if (changes.boostLogs) {
            logsDiv.textContent = (changes.boostLogs.newValue || []).join('\n');
            logsDiv.scrollTop = logsDiv.scrollHeight;
        }
        if (changes.processed) {
            updateProgress(changes.processed.newValue);
        }
        if (changes.isBoostRunning) {
            setRunningState(changes.isBoostRunning.newValue);
        }
        if (changes.daily_publisher_published || changes.daily_publisher_published_date
            || changes.daily_boost_bumps || changes.daily_boost_bumps_date) {
            chrome.storage.local.get([
                'daily_publisher_published', 'daily_publisher_published_date',
                'daily_boost_bumps', 'daily_boost_bumps_date'
            ], (r) => updateDailyStatsCounter(r));
        }
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
});
