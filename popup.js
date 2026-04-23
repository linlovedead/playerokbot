document.addEventListener('DOMContentLoaded', async () => {

    const HOME_TIPS = [
        'Полные логи автовыдачи — только в окне «Автовыдача».',
        'Сводка по продажам и бустам открывается кнопкой «Сводка».',
        'Лимит SteamPass на выдачи в день — в блоке «Выдач сегодня».',
        'Редактор шаблонов и создание товаров можно держать закрытыми, пока не нужны.',
        'Если буст не берёт лоты — проверьте cooldown или сброс истории в окне автовыдачи.',
        'Имя продавца на Playerok задаётся в настройках автовыдачи.'
    ];

    let overviewTimer = null;

    const mainContent = document.getElementById('mainContent');

    function showMainContent() {
        mainContent.style.display = 'flex';
        startOverviewRefresh();
    }

    function stopOverviewRefresh() {
        if (overviewTimer) {
            clearInterval(overviewTimer);
            overviewTimer = null;
        }
    }

    function pickTip() {
        const el = document.getElementById('homeTip');
        if (!el) return;
        const i = Math.floor(Date.now() / 25000) % HOME_TIPS.length;
        el.textContent = '💡 ' + HOME_TIPS[i];
    }

    const EV_ORDER = ['start', 'stop', 'scan', 'drafts', 'completed', 'bump', 'publish', 'sleep', 'dashboard', 'api', 'warn', 'error', 'info'];
    let _evPrev = {};

    function renderEvents(feed, boostEvents, logsPreview) {
        // Собираем категории из boostLastEvents
        const cats = EV_ORDER.filter(k => boostEvents[k]);
        Object.keys(boostEvents).forEach(k => { if (!cats.includes(k)) cats.push(k); });

        if (cats.length === 0) {
            // Fallback: показываем последние строки fulfill-лога если boost ничего нет
            feed.textContent = '';
            if (logsPreview.length === 0) {
                const li = document.createElement('li');
                li.className = 'ev-empty';
                li.textContent = 'Событий пока нет — после запуска бота появятся строки.';
                feed.appendChild(li);
            } else {
                logsPreview.slice(0, 6).forEach((text) => {
                    const li = document.createElement('li');
                    li.className = 'ev-item lv-info';
                    li.innerHTML = `<span class="ev-text">${text}</span>`;
                    feed.appendChild(li);
                });
            }
            _evPrev = {};
            return;
        }

        // Удаляем строки исчезнувших категорий
        feed.querySelectorAll('[data-cat]').forEach(el => {
            if (!boostEvents[el.dataset.cat]) el.remove();
        });
        feed.querySelector('.ev-empty')?.remove();

        cats.forEach((cat, idx) => {
            const ev = boostEvents[cat];
            let li = feed.querySelector(`[data-cat="${cat}"]`);
            const isNew = !_evPrev[cat] || _evPrev[cat].time !== ev.time;

            if (!li) {
                li = document.createElement('li');
                li.dataset.cat = cat;
                li.innerHTML = `<span class="ev-time"></span><span class="ev-text"></span>`;
                const allRows = feed.querySelectorAll('[data-cat]');
                idx < allRows.length ? feed.insertBefore(li, allRows[idx]) : feed.appendChild(li);
            }

            li.className = `ev-item lv-${ev.level || 'info'}${isNew ? ' ev-fresh' : ''}`;
            li.querySelector('.ev-time').textContent = ev.time;
            li.querySelector('.ev-text').textContent = ev.text;
            li.title = ev.text;

            if (isNew) setTimeout(() => li.classList.remove('ev-fresh'), 3000);
        });

        _evPrev = { ...boostEvents };
    }

    async function refreshOverview() {
        const dot = document.getElementById('homeStatusDot');
        const line = document.getElementById('homeStatusLine');
        const sub = document.getElementById('homeStatusSub');
        const feed = document.getElementById('homeFeed');
        const kFul = document.getElementById('kpiFulfill');
        const kBoost = document.getElementById('kpiBoostToday');
        const kQ = document.getElementById('kpiQueue');
        const kDb = document.getElementById('kpiDb');
        if (!line || !feed) return;

        try {
            const data = await chrome.runtime.sendMessage({ action: 'GET_POPUP_OVERVIEW' });
            if (!data || !data.ok) {
                line.textContent = 'Нет данных (фоновый процесс спит)';
                if (sub) sub.textContent = 'Откройте панель ещё раз или вкладку Playerok.';
                return;
            }

            line.textContent = data.headline || '—';
            if (sub) sub.textContent = data.sub || '';

            if (dot) {
                dot.classList.remove('on', 'pause', 'idle');
                if (data.idle) dot.classList.add('idle');
                else if (String(data.headline || '').includes('пауза')) dot.classList.add('pause');
                else dot.classList.add('on');
            }

            if (kFul) kFul.textContent = `${data.fulfillToday}/${data.fulfillMax}`;
            if (kBoost) {
                const kLabel = document.getElementById('kpiBoostLabel');
                if (data.publisherToday > 0 && !data.boostMetrics) {
                    kBoost.textContent = String(data.publisherToday);
                    if (kLabel) kLabel.textContent = 'Выложено сегодня';
                } else {
                    kBoost.textContent = String(data.activationsToday ?? '0');
                    if (kLabel) kLabel.textContent = 'Бустов сегодня';
                }
            }
            if (kQ) kQ.textContent = data.boostMetrics ? `${data.boostQueue} / ${data.boostBatch}` : '—';
            if (kDb) kDb.textContent = String(data.dbUsers ?? '0');

            renderEvents(feed, data.boostLastEvents || {}, data.logsPreview || []);

            pickTip();
        } catch (e) {
            line.textContent = 'Ошибка сводки';
            if (sub) sub.textContent = String(e.message || e);
        }
    }

    function startOverviewRefresh() {
        stopOverviewRefresh();
        refreshOverview();
        overviewTimer = setInterval(refreshOverview, 4000);
    }

    showMainContent();

    const openFulfillBtn = document.getElementById('openFulfillBtn');
    if (openFulfillBtn) {
        openFulfillBtn.addEventListener('click', () => {
            chrome.tabs.create({ url: chrome.runtime.getURL('auto_fulfill.html') });
        });
    }

    const openHistoryBtn = document.getElementById('openHistoryBtn');
    if (openHistoryBtn) {
        openHistoryBtn.addEventListener('click', () => {
            chrome.tabs.create({ url: chrome.runtime.getURL('orders_history.html') });
        });
    }

    const openDashboardBtn = document.getElementById('openDashboardBtn');
    if (openDashboardBtn) {
        openDashboardBtn.addEventListener('click', () => {
            chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
        });
    }

    const openBoostBtn = document.getElementById('openBoostBtn');
    if (openBoostBtn) {
        openBoostBtn.addEventListener('click', () => {
            chrome.tabs.create({ url: chrome.runtime.getURL('auto_boost.html') });
        });
    }

    const openGeneratorBtn = document.getElementById('openGeneratorBtn');
    if (openGeneratorBtn) {
        openGeneratorBtn.addEventListener('click', () => {
            chrome.tabs.create({ url: chrome.runtime.getURL('card_generator.html') });
        });
    }

    const openPublisherBtn = document.getElementById('openPublisherBtn');
    if (openPublisherBtn) {
        openPublisherBtn.addEventListener('click', () => {
            chrome.tabs.create({ url: chrome.runtime.getURL('auto_publisher.html') });
        });
    }

});

