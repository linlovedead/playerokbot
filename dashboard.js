
'use strict';

// ── Storage keys ─────────────────────────────────────────────────────────────
var K = {
    lots:       'dashboard_lots_v1',
    drafts:     'dashboard_drafts_v1',
    published:  'dashboard_published_v1',
    sales:      'dashboard_sales_v1',
    boost:      'dashboard_boost_spent_v1',
    completed:  'dashboard_completed_catalog_v1',
    running:    'isRunning',
    mode:       'currentMode',
    processed:  'processed',
    batch:      'batch',
    actToday:   'daily_boost_bumps',
    actDate:    'daily_boost_bumps_date',
    pubToday:   'daily_publisher_published',
    pubDate:    'daily_publisher_published_date',
    username:   'playerokUsername'
};

var ALL_KEYS = Object.values(K);

// ── Cache ─────────────────────────────────────────────────────────────────────
var drafts = [], published = [], sales = [];
var manualBoosts = [];
/** @type {{ fetchedAt?: number, username?: string, sourceUrl?: string, items?: Array<{id:string,slug:string,title:string,gameTitle:string,priceRub:number|null,status:string,url:string}> } | null} */
var completedCatalog = null;
/** Черновик формы «добавить по ссылке» — не теряется при авто-обновлении сводки (render). */
var publishedFormDraft = { url: '', title: '', price: '' };
var botRunning = false, botProcessed = 0, actToday = 0, pubToday = 0;

// ── Multiselect state ─────────────────────────────────────────────────────────
/** Текущая активная панель с мультиселектом: 'drafts' | 'published' | 'completed' | '' */
var selPanel = '';
/** Set строк-ключей выбранных элементов */
var selSet = new Set();

function rowKey(row) {
    if (row.id) return String(row.id);
    if (row.url) return String(row.url);
    return String(row.at || '') + '_' + String(row.title || '');
}

function selToggle(key) {
    if (selSet.has(key)) selSet.delete(key);
    else selSet.add(key);
}

function selClear() { selSet = new Set(); }

function selAll(rows) {
    rows.forEach(function(r) { selSet.add(rowKey(r)); });
}

function selCount() { return selSet.size; }

/** Текущая страница пагинации списка «Все товары» */
var completedCatalogPage = 0;
var COMPLETED_PAGE_SIZE = 50;

/** Дебаунс для storage.onChanged — исключает множественные render() при пачке записей */
var _renderDebounceTimer = null;
function scheduleRender() {
    if (_renderDebounceTimer) return;
    _renderDebounceTimer = setTimeout(function() { _renderDebounceTimer = null; render(); }, 300);
}

function stableBoostId(e) {
    if (e.id != null && String(e.id) !== '') return String(e.id);
    var u = String(e.url || '').trim().slice(0, 120);
    return 'gen-' + String(Number(e.at) || 0) + '-' + String(Number(e.rub) || 0) + '-' + String(u.length) + '-' + u.replace(/\s/g, '').slice(0, 48);
}

function normalizeBoostList(raw) {
    if (!raw) return [];
    if (!Array.isArray(raw)) return [];
    return raw.filter(function(e) { return e && typeof e === 'object'; }).map(function(e) {
        return {
            id: stableBoostId(e),
            at: Number(e.at) || 0,
            url: String(e.url || '').trim(),
            title: String(e.title || '').trim(),
            rub: Math.max(0, Number(e.rub) || 0)
        };
    }).filter(function(e) { return e.url.length > 0; });
}

function sumBoostRub(entries) {
    return entries.reduce(function(a, e) { return a + (isFinite(e.rub) ? e.rub : 0); }, 0);
}

function normalizeBoostUrl(u) {
    var s = String(u || '').trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
    return s;
}

function persistManualBoosts(next, cb) {
    manualBoosts = next;
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
    chrome.storage.local.set({ [K.boost]: next }, function() {
        if (cb) cb();
        else render();
    });
}

function addManualBoost(url, title, rub) {
    var u = normalizeBoostUrl(url);
    if (!u || !/^https?:\/\//i.test(u)) {
        alert('Укажите ссылку на товар (страница лота на Playerok).');
        return;
    }
    var r = Number(rub);
    if (!isFinite(r) || r < 0) r = 0;
    var entry = {
        id: String(Date.now()) + '-' + Math.random().toString(36).slice(2, 9),
        at: Date.now(),
        url: u,
        title: String(title || '').trim(),
        rub: r
    };
    persistManualBoosts([entry].concat(manualBoosts));
}

function removeManualBoost(id) {
    persistManualBoosts(manualBoosts.filter(function(e) { return e.id !== id; }));
}

function normalizePublishedProductUrl(u) {
    if (!u || typeof u !== 'string') return '';
    var s = normalizeBoostUrl(u.trim());
    try {
        var o = new URL(s);
        if (!o.hostname.endsWith('playerok.com')) return '';
        return (o.origin + o.pathname).replace(/\/$/, '');
    } catch (e) {
        return s.split('?')[0].replace(/\/$/, '');
    }
}

function publishedRowMatch(p, row) {
    if (row.id && p.id) return p.id === row.id;
    var u1 = normalizePublishedProductUrl(p.url || '');
    var u2 = normalizePublishedProductUrl(row.url || '');
    return u1 && u2 && u1 === u2 && Number(p.at) === Number(row.at);
}

function addPublishedManual(url, title, priceStr) {
    var target = normalizePublishedProductUrl(url);
    if (!target || target.indexOf('/products/') === -1) {
        alert('Укажите ссылку на товар Playerok (должна содержать /products/…).');
        return;
    }
    var slug = target.split('/').pop() || '';
    var titleGuess = String(title || '').trim() || decodeURIComponent(slug).replace(/-/g, ' ');
    var pr = Number(priceStr);
    var base = (isFinite(pr) && pr >= 0) ? Math.round(pr) : null;
    var rec = {
        id: 'pub_m_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9),
        at: Date.now(),
        title: titleGuess,
        basePriceRub: base,
        salePriceRub: base,
        hasDiscount: false,
        url: target,
        itemId: '',
        quantity: 1,
        source: 'manual_dashboard'
    };
    chrome.storage.local.get(K.published, function(res) {
        if (chrome.runtime && chrome.runtime.lastError) return;
        var arr = res[K.published] || [];
        arr.unshift(rec);
        chrome.storage.local.set({ [K.published]: arr.slice(0, 2000) }, function() {
            publishedFormDraft = { url: '', title: '', price: '' };
            render();
        });
    });
}

function removeDraftRow(row, cb) {
    function finish(ok) { if (cb) cb(ok); else render(); }
    chrome.storage.local.get(K.drafts, function(res) {
        if (chrome.runtime && chrome.runtime.lastError) { finish(false); return; }
        var arr = (res[K.drafts] || []).filter(function(d) {
            if (row.id && d.id) return d.id !== row.id;
            var u1 = normalizePublishedProductUrl(d.url || '');
            var u2 = normalizePublishedProductUrl(row.url || '');
            if (u1 && u2 && u1 === u2) return false;
            if (row.itemId && d.itemId && row.itemId === d.itemId) return false;
            return true;
        });
        chrome.storage.local.set({ [K.drafts]: arr }, function() { finish(true); });
    });
}

function removePublishedRow(row, cb) {
    function finish(ok) {
        if (cb) cb(ok);
        else render();
    }
    if (row._k === 'pub') {
        chrome.storage.local.get(K.published, function(res) {
            if (chrome.runtime && chrome.runtime.lastError) { finish(false); return; }
            var arr = (res[K.published] || []).filter(function(p) { return !publishedRowMatch(p, row); });
            chrome.storage.local.set({ [K.published]: arr }, function() { finish(true); });
        });
        return;
    }
    if (row._k === 'legacy' && row.url) {
        chrome.storage.local.get(K.lots, function(res) {
            if (chrome.runtime && chrome.runtime.lastError) { finish(false); return; }
            var lots = res[K.lots] || [];
            var uLegacy = row.url;
            var next = lots.filter(function(l) {
                if (l.isDraft) return true;
                return l.url !== uLegacy && normalizePublishedProductUrl(l.url || '') !== normalizePublishedProductUrl(uLegacy);
            });
            chrome.storage.local.set({ [K.lots]: next }, function() { finish(true); });
        });
        return;
    }
    alert('Эту запись нельзя удалить автоматически.');
    finish(false);
}

function makePublishedPanel() {
    selPanel = 'published';
    var root = document.createElement('div');

    // ── Add form ──
    var form = document.createElement('div'); form.className = 'mb-form';
    var ft = document.createElement('div'); ft.className = 'mb-form-title'; ft.textContent = 'Добавить лот по ссылке';
    form.appendChild(ft);

    var r1 = document.createElement('div'); r1.className = 'mb-row';
    var inpUrl = document.createElement('input');
    inpUrl.type = 'text'; inpUrl.placeholder = 'https://playerok.com/products/…';
    var inpTitle = document.createElement('input');
    inpTitle.type = 'text'; inpTitle.placeholder = 'Название (необязательно)';
    r1.appendChild(inpUrl); r1.appendChild(inpTitle);

    var r2 = document.createElement('div'); r2.className = 'mb-row';
    var inpPrice = document.createElement('input');
    inpPrice.type = 'number'; inpPrice.min = '0'; inpPrice.step = '1'; inpPrice.placeholder = 'Цена (необяз.)';
    var btnAdd = document.createElement('button');
    btnAdd.type = 'button'; btnAdd.className = 'btn-add'; btnAdd.textContent = 'В сводку';
    function syncPubDraft() {
        publishedFormDraft.url = inpUrl.value;
        publishedFormDraft.title = inpTitle.value;
        publishedFormDraft.price = inpPrice.value;
    }
    inpUrl.addEventListener('input', syncPubDraft);
    inpTitle.addEventListener('input', syncPubDraft);
    inpPrice.addEventListener('input', syncPubDraft);
    inpUrl.value = publishedFormDraft.url;
    inpTitle.value = publishedFormDraft.title;
    inpPrice.value = publishedFormDraft.price;
    btnAdd.onclick = function() {
        addPublishedManual(inpUrl.value, inpTitle.value, inpPrice.value);
    };
    r2.appendChild(inpPrice); r2.appendChild(btnAdd);
    form.appendChild(r1); form.appendChild(r2);
    root.appendChild(form);

    // ── Bulk toolbar ──
    if (published.length > 0) {
        var pubToolbar = document.createElement('div');
        pubToolbar.className = 'bulk-toolbar';

        var btnSelAll = document.createElement('button');
        btnSelAll.type = 'button'; btnSelAll.className = 'btn-mini btn-sel-all';
        var allSel = published.every(function(r) { return selSet.has(rowKey(r)); });
        btnSelAll.textContent = allSel ? 'Снять все' : 'Выбрать все';
        btnSelAll.onclick = function() {
            if (published.every(function(r) { return selSet.has(rowKey(r)); })) selClear();
            else selAll(published);
            showPanel('published');
        };
        pubToolbar.appendChild(btnSelAll);

        var cnt = published.filter(function(r) { return selSet.has(rowKey(r)); }).length;
        var selInfo = document.createElement('span');
        selInfo.className = 'bulk-sel-info';
        selInfo.textContent = cnt > 0 ? 'Выбрано: ' + cnt : '';
        pubToolbar.appendChild(selInfo);

        if (cnt > 0) {
            var btnBulkBoost = document.createElement('button');
            btnBulkBoost.type = 'button'; btnBulkBoost.className = 'btn-mini btn-bulk-pub';
            btnBulkBoost.textContent = 'Буст выбранных (' + cnt + ')';
            btnBulkBoost.onclick = function() {
                var sel = published.filter(function(r) { return selSet.has(rowKey(r)); });
                if (!confirm('Платное поднятие ' + sel.length + ' лотов? Суммы попадут в «Ручной буст».')) return;
                batchBoostPublished(sel);
            };
            pubToolbar.appendChild(btnBulkBoost);

            var btnBulkDel = document.createElement('button');
            btnBulkDel.type = 'button'; btnBulkDel.className = 'btn-mini btn-bulk-del';
            btnBulkDel.textContent = 'Удалить из сводки (' + cnt + ')';
            btnBulkDel.onclick = function() {
                var sel = published.filter(function(r) { return selSet.has(rowKey(r)); });
                if (!confirm('Удалить ' + sel.length + ' лот(ов) из сводки? (с сайта не удаляет)')) return;
                batchDeletePublished(sel);
            };
            pubToolbar.appendChild(btnBulkDel);
        }

        root.appendChild(pubToolbar);
    }

    var lt = document.createElement('div'); lt.className = 'mb-list-title'; lt.textContent = 'Список лотов';
    root.appendChild(lt);

    if (!published.length) {
        var empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'Пока пусто — вставьте ссылку на товар выше.';
        root.appendChild(empty);
        return root;
    }
    published.forEach(function(r) {
        root.appendChild(makeLotRow(r, { publishedActions: true, multisel: true }));
    });
    return root;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function todayMs() { var d = new Date(); d.setHours(0,0,0,0); return d.getTime(); }

function fmt(n) {
    var num = Number(n);
    return (n == null || isNaN(num)) ? '—' : Math.round(num).toLocaleString('ru-RU');
}

function fmtDate(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString('ru-RU', {day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
}

function fmtTime(ts) {
    if (!ts) return '—';
    var d = new Date(ts), now = new Date();
    if (d.toDateString() === now.toDateString()) {
        return 'сегодня в ' + d.toLocaleTimeString('ru-RU', {hour:'2-digit',minute:'2-digit'});
    }
    var yest = new Date(now); yest.setDate(yest.getDate()-1);
    if (d.toDateString() === yest.toDateString()) {
        return 'вчера в ' + d.toLocaleTimeString('ru-RU', {hour:'2-digit',minute:'2-digit'});
    }
    return fmtDate(ts);
}

function copy(txt) { try { navigator.clipboard.writeText(txt); } catch(e) {} }

function el(id) { return document.getElementById(id); }

function lotValue(row) {
    if (row._k === 'legacy') {
        var n = Number(row.priceRub);
        return isFinite(n) ? n * (row.quantity || 1) : 0;
    }
    var s = Number(row.salePriceRub), b = Number(row.basePriceRub);
    var v = isFinite(s) ? s : (isFinite(b) ? b : 0);
    return v * (row.quantity || 1);
}

function sumLots(rows) { return rows.reduce(function(a,r){ return a + lotValue(r); }, 0); }

function countDistinctGames(itemRows) {
    var m = {};
    (itemRows || []).forEach(function(r) {
        var g = String((r.gameTitle || r.categoryName || '—').trim()) || '—';
        m[g] = 1;
    });
    return Object.keys(m).length;
}

// ── Load caches from storage result ──────────────────────────────────────────
function loadDrafts(res) {
    var modern = (res[K.drafts]   || []).map(function(r){ return Object.assign({}, r, {_k:'draft'}); });
    var legacy  = (res[K.lots]    || []).filter(function(r){ return r.isDraft; })
                                        .map(function(r){ return Object.assign({}, r, {_k:'legacy'}); });
    return modern.concat(legacy).sort(function(a,b){ return (b.at||0)-(a.at||0); });
}

function loadPublished(res) {
    var modern = (res[K.published] || []).map(function(r){ return Object.assign({}, r, {_k:'pub'}); });
    var legacy  = (res[K.lots]     || []).filter(function(r){ return !r.isDraft; })
                                         .map(function(r){ return Object.assign({}, r, {_k:'legacy'}); });
    return modern.concat(legacy).sort(function(a,b){ return (b.at||0)-(a.at||0); });
}

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
    if (typeof chrome === 'undefined' || !chrome.storage) {
        el('tsLabel').textContent = '⚠ chrome.storage недоступен — обновите вкладку (F5)';
        return;
    }
    chrome.storage.local.get(ALL_KEYS, function(res) {
        if (chrome.runtime && chrome.runtime.lastError) {
            el('tsLabel').textContent = '⚠ Ошибка storage: ' + chrome.runtime.lastError.message;
            return;
        }
        try { applyRender(res); } catch(e) {
            el('tsLabel').textContent = '⚠ Ошибка рендера: ' + e.message;
            console.error('[Dashboard] render error', e);
        }
    });
}

function applyRender(res) {
    var ts = todayMs();

    drafts    = loadDrafts(res);
    published = loadPublished(res);
    sales     = (res[K.sales] || []).slice().sort(function(a,b){ return (b.at||0)-(a.at||0); });
    manualBoosts = normalizeBoostList(res[K.boost]);
    var rawComp = res[K.completed];
    completedCatalog = rawComp && typeof rawComp === 'object' && Array.isArray(rawComp.items) ? rawComp : null;
    botRunning   = !!res[K.running];
    botProcessed = res[K.processed] || 0;
    var today    = new Date().toISOString().slice(0,10);
    actToday = (res[K.actDate] === today) ? (res[K.actToday] || 0) : 0;
    pubToday = (res[K.pubDate] === today) ? (res[K.pubToday] || 0) : 0;

    // Username
    var uname = res[K.username] || '';
    if (uname) { el('userLine').style.display='block'; el('userName').textContent = uname; }

    el('tsLabel').textContent = 'Обновлено: ' + new Date().toLocaleTimeString('ru-RU', {hour:'2-digit',minute:'2-digit',second:'2-digit'});

    // ── Drafts
    var dSum = sumLots(drafts), dLast = drafts.length ? drafts[0].at : 0;
    el('vDrafts').textContent       = String(drafts.length);
    el('sDraftsSum').textContent    = fmt(dSum) === '—' ? '0' : fmt(dSum);
    el('sDraftsLast').textContent   = dLast ? 'Посл.: ' + fmtTime(dLast) : '';

    // ── Published
    var pSum = sumLots(published), pLast = published.length ? published[0].at : 0;
    el('vPublished').textContent    = String(published.length);
    el('sPublishedSum').textContent = fmt(pSum) === '—' ? '0' : fmt(pSum);
    el('sPublishedLast').textContent = pLast ? 'Посл.: ' + fmtTime(pLast) : '';

    // ── Completed catalog (Playerok «Завершённые»)
    // Apollo-кэш содержит ВСЁ (active/draft/sold/expired/...), но карточка показывает
    // только фактически завершённые статусы. Active идут в «Опубликованные», drafts — в «Черновики».
    var compItemsAll = completedCatalog && completedCatalog.items ? completedCatalog.items : [];
    var COMPLETED_STATUSES = { SOLD: 1, COMPLETED: 1, FINISHED: 1, EXPIRED: 1, DECLINED: 1, BLOCKED: 1 };
    var compItems = compItemsAll.filter(function(r) {
        return COMPLETED_STATUSES[String(r.status || '').toUpperCase()] === 1;
    });
    var compSum = compItems.reduce(function(a, r) {
        var p = Number(r.priceRub);
        return a + (isFinite(p) ? p : 0);
    }, 0);
    var compWithP = compItems.filter(function(r) { return isFinite(Number(r.priceRub)); }).length;
    el('vCompleted').textContent = String(compItems.length);
    el('sCompletedSub').innerHTML = 'Сумма цен: <strong style="color:#ccc">' + (fmt(compSum) === '—' ? '0' : fmt(compSum)) + '</strong> ₽ · игр: ' + countDistinctGames(compItems);
    var cf = completedCatalog && completedCatalog.fetchedAt;
    el('sCompletedLast').textContent = cf ? 'Загр.: ' + fmtTime(cf) : '';

    // ── Sales
    var totSum = 0, todSum = 0, todCnt = 0, withP = 0;
    sales.forEach(function(s) {
        var p = Number(s.priceRub);
        if (isFinite(p)) { totSum += p; withP++; }
        if (s.at >= ts)  { todCnt++; if (isFinite(p)) todSum += p; }
    });
    el('vSales').textContent = String(sales.length);
    var subEl = el('sSalesSub');
    if (todCnt > 0) {
        subEl.innerHTML = 'Всего: <strong style="color:#ccc">' + fmt(totSum) + ' ₽</strong> · <span class="hi">сегодня ' + todCnt + ' шт. · ' + fmt(todSum) + ' ₽</span>';
    } else {
        subEl.innerHTML = 'Выручка: <strong style="color:#ccc">' + (fmt(totSum) === '—' ? '0' : fmt(totSum)) + ' ₽</strong> · с ценой ' + withP + ' из ' + sales.length;
    }
    var sLast = sales.length ? sales[0].at : 0;
    el('sSalesLast').textContent = sLast ? 'Посл.: ' + fmtTime(sLast) : '';

    // ── Revenue card
    el('vRevenue').textContent   = (sales.length || drafts.length || published.length) ? (fmt(totSum) === '—' ? '0 ₽' : fmt(totSum) + ' ₽') : '—';
    el('sRevenueToday').textContent = todSum > 0 ? fmt(todSum) : '0';
    el('sRevenueCnt').textContent   = String(sales.length);

    var boostSum = sumBoostRub(manualBoosts);
    el('vManualBoost').textContent = manualBoosts.length ? (fmt(boostSum) + ' ₽') : '—';
    el('vManualBoostCnt').textContent = String(manualBoosts.length);
    var netEl = el('sRevenueNet');
    if (boostSum > 0) {
        var netGross = totSum - boostSum;
        netEl.style.display = 'block';
        netEl.textContent = 'После бустов: ' + fmt(netGross) + ' ₽ (−' + fmt(boostSum) + ' ₽ на бусты)';
    } else {
        netEl.style.display = 'none';
    }

    var commEl = el('sRevenueComm');
    if (totSum > 0) {
        var netBase = boostSum > 0 ? (totSum - boostSum) : totSum;
        var netAfterCommCard = Math.round(netBase * 0.8);
        commEl.style.display = 'block';
        commEl.textContent = 'К выводу (−20% комиссии): ' + fmt(netAfterCommCard) + ' ₽';
    } else {
        commEl.style.display = 'none';
    }

    // ── Bot card
    var dot = el('botDot');
    dot.className = 'dot ' + (botRunning ? 'on' : 'off');
    el('botTxt').textContent = botRunning ? 'Работает' : 'Стоп';
    var bSubEl = el('sBotSub');
    // innerHTML must keep <strong id="sBotProc"> — otherwise the node is removed and el('sBotProc') is null
    var botSubParts = ['Поднято: <strong id="sBotProc" style="color:#ccc">' + botProcessed + '</strong>'];
    if (pubToday > 0) botSubParts.push('<span class="hi">выложено сегодня ' + pubToday + '</span>');
    if (actToday > 0) botSubParts.push('<span class="hi">поднято сегодня ' + actToday + '</span>');
    bSubEl.innerHTML = botSubParts.join(' · ');
    el('sBotLast').textContent = sLast ? 'Посл. продажа: ' + fmtTime(sLast) : '';

    // Re-render open panel if any
    var openCard = document.querySelector('.stat-card.open');
    var panelKind = openCard && openCard.dataset ? openCard.dataset.panel : '';
    if (panelKind) { showPanel(panelKind); }
}

// ── Detail panel ──────────────────────────────────────────────────────────────
function closeAll() {
    document.querySelectorAll('.stat-card').forEach(function(c) {
        c.classList.remove('open');
    });
}

function showPanel(kind) {
    if (!kind) return;
    var panel = el('detailPanel'), title = el('detailTitle'), body = el('detailBody');
    var expBtn = el('btnExport');
    if (!panel || !title || !body || !expBtn) return;

    // Сбрасываем выделение при переходе на другую панель
    if (kind !== selPanel) selClear();

    body.innerHTML = '';
    expBtn.style.display = 'none';
    expBtn.onclick = null;

    if (kind === 'drafts') {
        title.textContent = 'Черновики';
        selPanel = 'drafts';

        // ── Toolbar ──
        var draftToolbar = document.createElement('div');
        draftToolbar.className = 'bulk-toolbar';

        var btnClearDrafts = document.createElement('button');
        btnClearDrafts.type = 'button';
        btnClearDrafts.className = 'btn btn-grey';
        btnClearDrafts.textContent = 'Очистить всё';
        btnClearDrafts.disabled = drafts.length === 0;
        btnClearDrafts.title = 'Удалить все черновики сводки';
        btnClearDrafts.onclick = function() {
            var n = drafts.length;
            if (!n) return;
            if (!confirm('Удалить все черновики из сводки (' + n + ' шт.)?')) return;
            chrome.storage.local.get([K.drafts, K.lots], function(res) {
                if (chrome.runtime.lastError) { alert('Ошибка: ' + chrome.runtime.lastError.message); return; }
                var lots = (res[K.lots] || []).filter(function(l) { return !l.isDraft; });
                chrome.storage.local.set({ [K.drafts]: [], [K.lots]: lots }, function() {
                    if (chrome.runtime.lastError) { alert('Ошибка: ' + chrome.runtime.lastError.message); return; }
                    selClear(); render();
                });
            });
        };
        draftToolbar.appendChild(btnClearDrafts);

        if (drafts.length > 0) {
            // Select all / none
            var btnSelAll = document.createElement('button');
            btnSelAll.type = 'button'; btnSelAll.className = 'btn-mini btn-sel-all';
            btnSelAll.textContent = 'Выбрать все';
            btnSelAll.onclick = function() {
                var allSelected = drafts.every(function(r) { return selSet.has(rowKey(r)); });
                if (allSelected) selClear();
                else selAll(drafts);
                showPanel('drafts');
            };
            draftToolbar.appendChild(btnSelAll);

            var selInfo = document.createElement('span');
            selInfo.className = 'bulk-sel-info';
            var cnt = drafts.filter(function(r) { return selSet.has(rowKey(r)); }).length;
            selInfo.textContent = cnt > 0 ? 'Выбрано: ' + cnt : '';
            draftToolbar.appendChild(selInfo);

            if (cnt > 0) {
                var btnBulkPub = document.createElement('button');
                btnBulkPub.type = 'button'; btnBulkPub.className = 'btn-mini btn-bulk-pub';
                btnBulkPub.textContent = 'Выставить выбранные (' + cnt + ')';
                btnBulkPub.onclick = function() { batchPublishDrafts(drafts.filter(function(r) { return selSet.has(rowKey(r)); })); };
                draftToolbar.appendChild(btnBulkPub);

                var btnBulkDel = document.createElement('button');
                btnBulkDel.type = 'button'; btnBulkDel.className = 'btn-mini btn-bulk-del';
                btnBulkDel.textContent = 'Удалить из сводки (' + cnt + ')';
                btnBulkDel.onclick = function() {
                    var sel = drafts.filter(function(r) { return selSet.has(rowKey(r)); });
                    if (!confirm('Удалить ' + sel.length + ' черновик(ов) из сводки?')) return;
                    batchDeleteDrafts(sel);
                };
                draftToolbar.appendChild(btnBulkDel);
            }
        }

        body.appendChild(draftToolbar);

        if (!drafts.length) {
            var emptyDrafts = document.createElement('div');
            emptyDrafts.className = 'empty';
            emptyDrafts.textContent = 'Пока нет черновиков.';
            body.appendChild(emptyDrafts);
        } else {
            drafts.forEach(function(r) { body.appendChild(makeLotRow(r, { draftActions: true, multisel: true })); });
        }

    } else if (kind === 'published') {
        title.textContent = 'Опубликованные лоты';
        body.appendChild(makePublishedPanel());

    } else if (kind === 'completed') {
        title.textContent = 'Все товары (завершённые на Playerok)';
        body.appendChild(makeCompletedCatalogPanel());

    } else if (kind === 'sales') {
        title.textContent = 'Автопродажи';
        expBtn.style.display = 'block';
        expBtn.onclick = exportCSV;
        if (!sales.length) { body.innerHTML = '<div class="empty">Пока нет продаж.</div>'; }
        else {
            body.appendChild(makeTopGames());
            sales.forEach(function(s){ body.appendChild(makeSaleRow(s)); });
        }

    } else if (kind === 'revenue') {
        title.textContent = 'Разбивка выручки';
        expBtn.style.display = 'block';
        expBtn.onclick = exportRevenueCSV;
        body.appendChild(makeRevBlock());

    } else if (kind === 'manualBoost') {
        title.textContent = 'Ручные бусты';
        body.appendChild(makeManualBoostPanel());

    } else if (kind === 'bot') {
        title.textContent = 'Статус бота';
        body.appendChild(makeBotBlock());
    }

    panel.classList.add('open');
}

function toggleCard(cardId, kind) {
    var card = el(cardId);
    var wasOpen = card.classList.contains('open');
    closeAll();
    var panel = el('detailPanel');
    if (wasOpen) { panel.classList.remove('open'); return; }
    card.classList.add('open');
    showPanel(kind);
}

// ── Detail builders ───────────────────────────────────────────────────────────
function makeLotRow(row, opts) {
    opts = opts || {};
    var key = rowKey(row);
    var div = document.createElement('div');
    div.className = 'row-item' + (selSet.has(key) ? ' row-selected' : '');

    // Multiselect checkbox
    if (opts.multisel) {
        var cbWrap = document.createElement('label');
        cbWrap.className = 'row-cb-wrap';
        cbWrap.title = 'Выбрать';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'row-cb';
        cb.checked = selSet.has(key);
        cb.addEventListener('change', function() {
            selToggle(key);
            showPanel(selPanel);
        });
        cbWrap.appendChild(cb);
        div.appendChild(cbWrap);
        // click on row also toggles (but not on buttons/links)
        div.addEventListener('click', function(e) {
            if (e.target === cb || e.target === cbWrap) return;
            if (e.target.tagName === 'BUTTON' || e.target.tagName === 'A' || e.target.tagName === 'INPUT') return;
            selToggle(key);
            showPanel(selPanel);
        });
    }

    var tDiv = document.createElement('div'); tDiv.className = 'row-title';
    tDiv.appendChild(document.createTextNode((row.title || '—') + ' '));
    var badge = document.createElement('span');
    var isDraft = row._k === 'draft' || (row._k === 'legacy' && row.isDraft);
    badge.className = 'badge ' + (isDraft ? 'badge-draft' : 'badge-pub');
    var badgeTxt = 'в продаже';
    if (isDraft) badgeTxt = 'черновик';
    else if (row.source === 'bump') badgeTxt = 'поднят ботом';
    else if (row.source === 'manual_dashboard') badgeTxt = 'вручную';
    else if (row.source === 'playerok_draft_scan') badgeTxt = 'с Playerok';
    badge.textContent = badgeTxt;
    tDiv.appendChild(badge);

    var mDiv = document.createElement('div'); mDiv.className = 'row-meta';
    if (row._k === 'legacy') {
        mDiv.textContent = fmtDate(row.at) + ' · ' + fmt(row.priceRub) + ' ₽ · кол-во ' + (row.quantity || 1);
    } else {
        mDiv.textContent = fmtDate(row.at) + ' · база ' + fmt(row.basePriceRub) + ' ₽ · скидка ' + (row.hasDiscount ? fmt(row.salePriceRub) + ' ₽' : '—') + ' · кол-во ' + (row.quantity || 1);
    }

    div.appendChild(tDiv);
    div.appendChild(mDiv);
    if (row.url && /^https?:\/\//i.test(row.url)) {
        var lDiv = document.createElement('div'); lDiv.className = 'row-line';
        var a = document.createElement('a'); a.href = row.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Открыть на Playerok';
        lDiv.appendChild(a); div.appendChild(lDiv);
    }

    if (opts.draftActions && isDraft) {
        var dAct = document.createElement('div'); dAct.className = 'pub-actions';
        var btnPubDraft = document.createElement('button');
        btnPubDraft.type = 'button';
        btnPubDraft.className = 'btn-mini';
        btnPubDraft.style.cssText = 'background:#1e88e5;color:#fff;font-weight:600;border:0;cursor:pointer';
        btnPubDraft.textContent = 'Выставить';
        btnPubDraft.onclick = function() {
            if (!confirm('Опубликовать черновик на Playerok (как «Выставить» на сайте)?')) return;
            btnPubDraft.disabled = true;
            var slugGuess = '';
            try {
                var pu = row.url && String(row.url).split('?')[0];
                var sm = pu && pu.match(/\/(?:products|item)\/([^/]+)\/?$/i);
                if (sm) slugGuess = decodeURIComponent(sm[1] || '').trim();
            } catch (e) { /* */ }
            var payload = {
                url: row.url || '',
                slug: slugGuess,
                title: row.title || '',
                itemId: String(row.itemId || '').trim(),
                obtainingTypeId: String(row.obtainingTypeId || '').trim(),
                rawPrice: Number(row.salePriceRub) || Number(row.basePriceRub) || 0,
                salePriceRub: Number(row.salePriceRub) || 0,
                basePriceRub: Number(row.basePriceRub) || 0
            };
            chrome.runtime.sendMessage({ action: 'DASHBOARD_PUBLISH_ITEM', payload: payload }, function(res) {
                btnPubDraft.disabled = false;
                if (chrome.runtime.lastError) {
                    alert('Ошибка: ' + chrome.runtime.lastError.message);
                    return;
                }
                if (res && res.ok) {
                    alert(res.skipped ? 'На сайте лот уже в подходящем состоянии.' : 'Лот выставлен.');
                    render();
                } else {
                    alert((res && res.error) ? res.error : 'Не выполнено. Откройте Playerok в этом браузере и войдите в аккаунт.');
                }
            });
        };
        dAct.appendChild(btnPubDraft);
        var btnDelDraft = document.createElement('button');
        btnDelDraft.type = 'button'; btnDelDraft.className = 'btn-mini';
        btnDelDraft.style.cssText = 'color:#fca5a5';
        btnDelDraft.textContent = 'Из сводки';
        btnDelDraft.title = 'Удалить только из сводки расширения (на сайте лот остаётся)';
        btnDelDraft.onclick = function() {
            if (!confirm('Удалить черновик «' + (row.title || '—') + '» из сводки?\n(на сайте лот не удаляется)')) return;
            removeDraftRow(row);
        };
        dAct.appendChild(btnDelDraft);

        var btnDelSite = document.createElement('button');
        btnDelSite.type = 'button'; btnDelSite.className = 'btn-mini';
        btnDelSite.style.cssText = 'color:#f87171;font-weight:700;border-color:rgba(239,68,68,0.4)';
        btnDelSite.textContent = 'Удалить на сайте';
        btnDelSite.title = 'Удалить лот на Playerok через API (потребуется открытый Playerok в браузере)';
        btnDelSite.onclick = function() {
            if (!confirm('Удалить лот «' + (row.title || '—') + '» на сайте Playerok?\n\nЭто действие необратимо!')) return;
            btnDelSite.disabled = true;
            deleteItemOnSite(row, function() {
                removeDraftRow(row, function() { render(); });
            });
        };
        dAct.appendChild(btnDelSite);

        if (row.url && /^https?:\/\//i.test(row.url)) {
            var btnOpenDraft = document.createElement('button');
            btnOpenDraft.type = 'button'; btnOpenDraft.className = 'btn-mini';
            btnOpenDraft.textContent = 'Открыть лот';
            btnOpenDraft.onclick = function() { window.open(row.url, '_blank', 'noopener'); };
            dAct.appendChild(btnOpenDraft);
        }
        div.appendChild(dAct);
    }

    if (opts.publishedActions && !isDraft) {
        var act = document.createElement('div'); act.className = 'pub-actions';
        var btnOpen = document.createElement('button');
        btnOpen.type = 'button'; btnOpen.className = 'btn-mini'; btnOpen.textContent = 'Открыть лот';
        btnOpen.onclick = function() {
            if (row.url && /^https?:\/\//i.test(row.url)) window.open(row.url, '_blank', 'noopener');
        };
        var btnApi = document.createElement('button');
        btnApi.type = 'button'; btnApi.className = 'btn-mini';
        btnApi.style.cssText = 'color:#81c784;font-weight:600';
        btnApi.textContent = 'Буст';
        btnApi.onclick = function() {
            if (!confirm('Платное поднятие через Playerok (как на сайте)? Списание по тарифу, сумма попадёт в «Ручной буст», лот исчезнет из списка опубликованных.')) return;
            btnApi.disabled = true;
            var payload = {
                url: row.url || '',
                title: row.title || '',
                publishedId: row.id || '',
                at: row.at || 0,
                itemId: row.itemId || '',
                rawPrice: Number(row.salePriceRub) || Number(row.basePriceRub) || 0
            };
            chrome.runtime.sendMessage({ action: 'DASHBOARD_PAID_BUMP', payload: payload }, function(res) {
                btnApi.disabled = false;
                if (chrome.runtime.lastError) {
                    alert('Ошибка: ' + chrome.runtime.lastError.message);
                    return;
                }
                if (res && res.ok) {
                    alert('Готово. В «Ручной буст» записано ' + res.priceRub + ' ₽ (из ответа сайта).');
                    render();
                } else {
                    alert((res && res.error) ? res.error : 'Не выполнено. Убедитесь, что вы залогинены на playerok.com (достаточно минимизированной вкладки расширения).');
                }
            });
        };
        var btnDel = document.createElement('button');
        btnDel.type = 'button'; btnDel.className = 'btn-mini';
        btnDel.style.cssText = 'color:#fca5a5';
        btnDel.textContent = 'Из сводки';
        btnDel.title = 'Убрать из сводки расширения (на сайте лот остаётся)';
        btnDel.onclick = function() {
            if (!confirm('Убрать лот из «Опубликованные» в сводке?\n(на сайте лот не удаляется)')) return;
            removePublishedRow(row);
        };

        var btnDelSitePub = document.createElement('button');
        btnDelSitePub.type = 'button'; btnDelSitePub.className = 'btn-mini';
        btnDelSitePub.style.cssText = 'color:#f87171;font-weight:700;border-color:rgba(239,68,68,0.4)';
        btnDelSitePub.textContent = 'Удалить на сайте';
        btnDelSitePub.title = 'Удалить лот на Playerok через API';
        btnDelSitePub.onclick = function() {
            if (!confirm('Удалить лот «' + (row.title || '—') + '» на сайте Playerok?\n\nЭто действие необратимо!')) return;
            btnDelSitePub.disabled = true;
            deleteItemOnSite(row, function() {
                removePublishedRow(row, function() { render(); });
            });
        };

        act.appendChild(btnOpen);
        act.appendChild(btnApi);
        act.appendChild(btnDel);
        act.appendChild(btnDelSitePub);
        div.appendChild(act);
    }

    return div;
}

function makeSaleRow(row) {
    var div = document.createElement('div'); div.className = 'row-sale';
    var ts = todayMs();

    var tDiv = document.createElement('div'); tDiv.className = 'row-title'; tDiv.textContent = row.gameTitle || '—';
    var mDiv = document.createElement('div'); mDiv.className = 'row-meta';
    mDiv.textContent = fmtDate(row.at) + (row.at >= ts ? ' · сегодня' : '') + ' · ' + (row.buyerName || '—') + ' · ' + fmt(row.priceRub) + ' ₽';

    div.appendChild(tDiv);
    div.appendChild(mDiv);
    div.appendChild(makeCredLine('Логин',  row.login));
    div.appendChild(makeCredLine('Пароль', row.password));

    var dealDiv = document.createElement('div'); dealDiv.className = 'row-line';
    var dk = document.createElement('span'); dk.className = 'k'; dk.textContent = 'Сделка';
    dealDiv.appendChild(dk);
    if (row.dealUrl && /^https?:\/\//i.test(row.dealUrl)) {
        var a = document.createElement('a'); a.href = row.dealUrl; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Страница сделки';
        dealDiv.appendChild(a);
    } else { dealDiv.appendChild(document.createTextNode('—')); }
    div.appendChild(dealDiv);
    return div;
}

function makeCredLine(label, val) {
    var line = document.createElement('div'); line.className = 'row-line';
    var k = document.createElement('span'); k.className = 'k'; k.textContent = label;
    var v = document.createElement('span'); v.className = 'mono'; v.textContent = val || '—';
    line.appendChild(k); line.appendChild(v);
    if (val) {
        var b = document.createElement('button'); b.className = 'btn-mini'; b.textContent = 'Копировать';
        b.onclick = function(){ copy(val); };
        line.appendChild(b);
    }
    return line;
}

function completedCatalogStatusLabel(r) {
    if (r.statusLabel && String(r.statusLabel).trim()) return String(r.statusLabel).trim();
    var m = { SOLD: 'Продано (завершено)', COMPLETED: 'Завершён', FINISHED: 'Завершён', DRAFT: 'Черновик', APPROVED: 'В продаже', EXPIRED: 'Истёк', DECLINED: 'Отклонён', BLOCKED: 'Заблокирован', PENDING_APPROVAL: 'На модерации', PENDING_MODERATION: 'На проверке изменений' };
    var st = String(r.status || '').trim();
    return m[st] || st || '—';
}

/** Синхронно с background: скидка покупателю только при заметном перекосе цен (иначе это удержание Playerok). */
function completedCatalogIsRealBuyerDiscount(r) {
    var base = Number(r.basePriceRub);
    var sale = Number(r.salePriceRub != null && r.salePriceRub !== '' ? r.salePriceRub : r.priceRub);
    if (isFinite(base) && isFinite(sale) && base > sale) {
        var ratio = base / sale;
        var pct = (1 - sale / base) * 100;
        return ratio >= 1.28 || pct >= 22;
    }
    return !!r.hasDiscount;
}

function completedCatalogIsDraft(r) {
    var st = String(r.status || '').toUpperCase();
    var sl = String(r.statusLabel || '').toLowerCase();
    return st === 'DRAFT' || sl.indexOf('черновик') !== -1;
}

function titleCaseCatalogWord(w) {
    w = String(w || '').trim();
    if (!w) return w;
    if (/^\d+([.,]\d+)?$/.test(w)) return w;
    if (w.length <= 2 && /[a-zа-яё]/i.test(w)) return w.toUpperCase();
    var lower = w.toLowerCase();
    return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function polishCatalogPipeSegment(part) {
    part = String(part || '').trim().replace(/\s+/g, ' ');
    if (!part) return part;
    var sub = part.split(/\s+/).map(titleCaseCatalogWord).join(' ');
    sub = sub.replace(/\bSteam\b/i, 'Steam');
    sub = sub.replace(/\bОфлайн\b/gi, 'Оффлайн');
    return sub;
}

/** Читаемый заголовок: «Battlefield 2 | Оффлайн Steam | Аккаунт» вместо слитной транслитерации. */
function formatCompletedCatalogDisplayTitle(r) {
    var title = String(r.title || '').trim();
    var gameTitle = (r.gameTitle && r.gameTitle !== '—') ? String(r.gameTitle).trim() : '';
    var categoryName = (r.categoryName && String(r.categoryName).trim()) ? String(r.categoryName).trim() : '';
    function tailFromCat(c) {
        if (!c) return '';
        if (/^аккаунты$/i.test(c)) return 'Аккаунт';
        if (/^ключи$/i.test(c)) return 'Ключ';
        return c;
    }
    var tail = tailFromCat(categoryName);
    if (/\s*\|\s*/.test(title)) {
        return title.split(/\s*\|\s*/).map(polishCatalogPipeSegment).join(' | ');
    }
    var lower = title.toLowerCase().replace(/\s+/g, ' ');
    lower = lower.replace(/\b(igra|игра)\b/g, ' ').replace(/\s+/g, ' ').trim();
    var re = /^(.+?)\s+(offlayn|offline|oflayn|offlain|офлайн|оффлайн)\s+steam(?:\s+(akkaunt|account|akk|аккаунт|kljuch|klyuch|key|ключ))?\s*$/i;
    var m = lower.match(re);
    if (m) {
        var gamePart = gameTitle || polishCatalogPipeSegment(m[1].replace(/-/g, ' '));
        if (!tail) {
            var tmk = (m[3] || '').toLowerCase();
            tail = /ключ|key|klyuch|kljuch/.test(tmk) ? 'Ключ' : 'Аккаунт';
        }
        return gamePart + ' | Оффлайн Steam | ' + tail;
    }
    if (gameTitle && tail) {
        return polishCatalogPipeSegment(gameTitle) + ' | Оффлайн Steam | ' + tail;
    }
    if (gameTitle) {
        return polishCatalogPipeSegment(gameTitle) + ' | Оффлайн Steam | ' + (tail || 'Аккаунт');
    }
    return polishCatalogPipeSegment(title.replace(/-/g, ' '));
}

function makeCompletedRow(r, opts) {
    opts = opts || {};
    var key = rowKey(r);
    var div = document.createElement('div');
    div.className = 'row-item' + (selSet.has(key) ? ' row-selected' : '');

    if (opts.multisel) {
        var cbWrap = document.createElement('label');
        cbWrap.className = 'row-cb-wrap';
        cbWrap.title = 'Выбрать';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'row-cb';
        cb.checked = selSet.has(key);
        cb.addEventListener('change', function() {
            selToggle(key);
            showPanel(selPanel);
        });
        cbWrap.appendChild(cb);
        div.appendChild(cbWrap);
        div.addEventListener('click', function(e) {
            if (e.target === cb || e.target === cbWrap) return;
            if (e.target.tagName === 'BUTTON' || e.target.tagName === 'A' || e.target.tagName === 'INPUT') return;
            selToggle(key);
            showPanel(selPanel);
        });
    }

    var tDiv = document.createElement('div'); tDiv.className = 'row-title';
    tDiv.textContent = formatCompletedCatalogDisplayTitle(r) + ' ';
    var badge = document.createElement('span');
    var st = String(r.status || '').toUpperCase();
    var badgeClass = 'badge-pub';
    if (completedCatalogIsDraft(r)) badgeClass = 'badge-draft';
    else if (st === 'SOLD' || st === 'COMPLETED' || st === 'FINISHED') badgeClass = 'badge-sold';
    badge.className = 'badge ' + badgeClass;
    var badgeTxt = completedCatalogStatusLabel(r);
    if (r.boostedMark) badgeTxt += ' ↑';
    badge.textContent = badgeTxt;
    tDiv.appendChild(badge);
    div.appendChild(tDiv);

    var stLine = document.createElement('div'); stLine.className = 'row-meta';
    var stHuman = completedCatalogStatusLabel(r);
    var stText = 'Статус: ' + stHuman + (r.status && String(r.status).trim() && stHuman !== r.status ? ' · код: ' + r.status : '');
    if (r.boostedMark && (/истёк|истек|EXPIRED/i.test(stHuman + '|' + (r.status || '')) || String(r.status || '').toUpperCase() === 'EXPIRED')) {
        stText += ' · 🚀 поднято (пока было в продаже)';
    }
    stLine.textContent = stText;
    div.appendChild(stLine);

    div.appendChild(makeCredLine('Категория лота', (r.categoryName && String(r.categoryName).trim()) ? r.categoryName : '—'));
    var base = r.basePriceRub;
    var sale = (r.salePriceRub != null && r.salePriceRub !== '') ? r.salePriceRub : r.priceRub;
    var realBuyerDisc = completedCatalogIsRealBuyerDiscount(r);
    var hasPair = isFinite(Number(base)) && isFinite(Number(sale)) && Number(base) > Number(sale);
    if (hasPair && !realBuyerDisc) {
        div.appendChild(makeCredLine('Цена для покупателя', (fmt(sale) === '—' || sale == null) ? '—' : fmt(sale) + ' ₽'));
        div.appendChild(makeCredLine('Сумма до удержания (оценка)', (fmt(base) === '—' || base == null) ? '—' : fmt(base) + ' ₽'));
        var hold = Number(base) - Number(sale);
        var hpct = isFinite(hold) && Number(base) > 0 ? Math.round((hold / Number(base)) * 100) : 0;
        div.appendChild(makeCredLine('Удержание платформы (оценка)', isFinite(hold) && hold > 0 ? fmt(hold) + ' ₽ (~' + hpct + '%)' : '—'));
        div.appendChild(makeCredLine('Скидка покупателю', '— (скидка — когда на карточке розовый % и зачёркнутая старая цена)'));
    } else if (hasPair && realBuyerDisc) {
        div.appendChild(makeCredLine('Старая цена (как на сайте)', (fmt(base) === '—' || base == null) ? '—' : fmt(base) + ' ₽'));
        div.appendChild(makeCredLine('Цена со скидкой', (fmt(sale) === '—' || sale == null) ? '—' : fmt(sale) + ' ₽'));
        var pct2 = Math.round((1 - Number(sale) / Number(base)) * 100);
        div.appendChild(makeCredLine('Скидка покупателю', 'да · −' + pct2 + '% · экономия ' + fmt(Number(base) - Number(sale)) + ' ₽'));
    } else {
        div.appendChild(makeCredLine('Базовая цена', (fmt(base) === '—' || base == null) ? '—' : fmt(base) + ' ₽'));
        div.appendChild(makeCredLine('Цена продажи', (fmt(sale) === '—' || sale == null) ? '—' : fmt(sale) + ' ₽'));
        var discTxt = '—';
        if (r.hasDiscount && isFinite(Number(base)) && isFinite(Number(sale)) && Number(base) > Number(sale)) {
            var pct3 = Math.round((1 - Number(sale) / Number(base)) * 100);
            discTxt = 'да · −' + pct3 + '% · экономия ' + fmt(Number(base) - Number(sale)) + ' ₽';
        } else if (r.hasDiscount) {
            discTxt = 'указана у лота';
        }
        div.appendChild(makeCredLine('Скидка покупателю', discTxt));
    }

    if (r.url && /^https?:\/\//i.test(r.url)) {
        var lDiv = document.createElement('div'); lDiv.className = 'row-line';
        var a = document.createElement('a'); a.href = r.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Карточка товара';
        lDiv.appendChild(a); div.appendChild(lDiv);
    }

    var compAct = document.createElement('div');
    compAct.className = 'pub-actions';

    if (completedCatalogIsDraft(r)) {
        var btnPub = document.createElement('button');
        btnPub.type = 'button';
        btnPub.className = 'btn-mini';
        btnPub.style.cssText = 'background:rgba(30,136,229,0.2);color:#60a5fa;font-weight:700;border:1px solid rgba(30,136,229,0.4);cursor:pointer';
        btnPub.textContent = 'Выставить';
        btnPub.onclick = function () {
            if (!confirm('Опубликовать этот черновик на Playerok (как кнопка «Выставить» на сайте)?')) return;
            btnPub.disabled = true;
            var payload = {
                url: r.url || '',
                slug: String(r.slug || '').trim(),
                title: r.title || '',
                itemId: String(r.id || '').trim(),
                obtainingTypeId: String(r.obtainingTypeId || '').trim(),
                rawPrice: Number(r.salePriceRub) || Number(r.priceRub) || Number(r.basePriceRub) || 0,
                salePriceRub: Number(r.salePriceRub) || Number(r.priceRub) || 0,
                basePriceRub: Number(r.basePriceRub) || 0
            };
            chrome.runtime.sendMessage({ action: 'DASHBOARD_PUBLISH_ITEM', payload: payload }, function (res) {
                btnPub.disabled = false;
                if (chrome.runtime.lastError) { alert('Ошибка: ' + chrome.runtime.lastError.message); return; }
                if (res && res.ok) {
                    alert(res.skipped ? 'На сайте лот уже в подходящем состоянии.' : 'Лот выставлен.');
                    render();
                } else {
                    alert((res && res.error) ? res.error : 'Не выполнено. Откройте Playerok в этом браузере и войдите в аккаунт.');
                }
            });
        };
        compAct.appendChild(btnPub);
    }

    // «Удалить на сайте» доступно для всех статусов кроме уже удалённых/проданных
    var st2 = String(r.status || '').toUpperCase();
    var alreadyGone = (st2 === 'SOLD' || st2 === 'COMPLETED' || st2 === 'FINISHED' || st2 === 'DELETED' || st2 === 'CANCELLED');
    if (!alreadyGone) {
        var btnDelComp = document.createElement('button');
        btnDelComp.type = 'button'; btnDelComp.className = 'btn-mini';
        btnDelComp.style.cssText = 'color:#f87171;font-weight:700;border-color:rgba(239,68,68,0.4)';
        btnDelComp.textContent = 'Удалить на сайте';
        btnDelComp.title = 'Удалить лот на Playerok через API (необратимо)';
        btnDelComp.onclick = function() {
            if (!confirm('Удалить лот «' + (formatCompletedCatalogDisplayTitle(r) || '—') + '» на сайте?\n\nЭто необратимо!')) return;
            btnDelComp.disabled = true;
            // Для completed catalog используем r.id как itemId
            var rowForDelete = { itemId: String(r.id || '').trim(), url: r.url || '', title: r.title || '' };
            deleteItemOnSite(rowForDelete, function() {
                alert('Лот удалён на сайте.');
                render();
            });
        };
        compAct.appendChild(btnDelComp);
    }

    if (compAct.childNodes.length > 0) div.appendChild(compAct);
    return div;
}

function makeCompletedCatalogPanel() {
    selPanel = 'completed';
    var root = document.createElement('div');
    var form = document.createElement('div'); form.className = 'mb-form';
    var ft = document.createElement('div'); ft.className = 'mb-form-title'; ft.textContent = 'Загрузить с Playerok';
    form.appendChild(ft);
    var row = document.createElement('div'); row.className = 'mb-row';
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = 'Ник (пусто = аккаунт из расширения)';
    var uname = '';
    try {
        var line = document.getElementById('userName');
        if (line) uname = line.textContent.trim();
    } catch (e) { /* */ }
    inp.value = uname;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-add';
    btn.textContent = 'Обновить список';
    var hint = document.createElement('div');
    hint.className = 'pub-form-hint';
    hint.innerHTML = 'Откроется <strong>отдельное окно браузера</strong> с Playerok. Сначала <strong>завершённые</strong>, затем <strong>черновики</strong> — черновики с <code>/item/</code> и <code>/products/</code> попадут в карточку «Черновики» и в этот список. Кнопка <strong>Выставить</strong> — в «Черновики» (и у черновиков здесь). На тысячи лотов скан дольше: жмите «Показать ещё» на сайте заранее или дождитесь конца окна.';
    btn.onclick = function() {
        btn.disabled = true;
        var nick = inp.value.trim();
        chrome.runtime.sendMessage({ action: 'DASHBOARD_FETCH_COMPLETED_CATALOG', username: nick || undefined }, function(res) {
            btn.disabled = false;
            if (chrome.runtime.lastError) {
                alert('Ошибка: ' + chrome.runtime.lastError.message);
                return;
            }
            if (!res || !res.ok) {
                alert((res && res.error) ? res.error : 'Не удалось загрузить.');
                return;
            }
            var dc = res.draftCount != null ? res.draftCount : 0;
            var pc = res.publishedCount != null ? res.publishedCount : 0;
            alert('Готово: завершённых в снимке — ' + (res.count || 0) + '. В черновики сводки добавлено: ' + dc + '. В опубликованные добавлено: ' + pc + '.');
            completedCatalogPage = 0;
            render();
        });
    };
    var btnClearList = document.createElement('button');
    btnClearList.type = 'button';
    btnClearList.className = 'btn btn-grey';
    btnClearList.style.marginLeft = '8px';
    btnClearList.textContent = 'Очистить список';
    var compLenNow = (completedCatalog && completedCatalog.items) ? completedCatalog.items.length : 0;
    btnClearList.disabled = compLenNow === 0;
    btnClearList.title = 'Удалить только снимок завершённых товаров (черновики и продажи не трогает).';
    btnClearList.onclick = function() {
        var n = (completedCatalog && completedCatalog.items) ? completedCatalog.items.length : 0;
        if (!n) return;
        if (!confirm('Удалить все записи из списка «Все товары» (' + n + ' шт.)?')) return;
        chrome.storage.local.remove([K.completed], function() {
            if (chrome.runtime.lastError) {
                alert('Ошибка: ' + chrome.runtime.lastError.message);
                return;
            }
            render();
        });
    };
    row.appendChild(inp); row.appendChild(btn); row.appendChild(btnClearList);
    form.appendChild(row); form.appendChild(hint); root.appendChild(form);

    // Тот же фильтр, что и в карточке: показываем только завершённые статусы.
    var itemsAll = completedCatalog && completedCatalog.items ? completedCatalog.items : [];
    var COMPLETED_STATUSES_LIST = { SOLD: 1, COMPLETED: 1, FINISHED: 1, EXPIRED: 1, DECLINED: 1, BLOCKED: 1 };
    var items = itemsAll.filter(function(r) {
        return COMPLETED_STATUSES_LIST[String(r.status || '').toUpperCase()] === 1;
    });
    if (!items.length) {
        var empty = document.createElement('div'); empty.className = 'empty';
        empty.textContent = itemsAll.length
            ? 'В Apollo-кэше найдено ' + itemsAll.length + ' лотов, но среди них нет завершённых/истёкших/проданных.'
            : 'Пока пусто — нажмите 🔄 на карточке или «Обновить список».';
        root.appendChild(empty);
        return root;
    }

    var linkRow = document.createElement('div'); linkRow.className = 'mb-list-title';
    if (completedCatalog.sourceUrl) {
        var la = document.createElement('a');
        la.href = completedCatalog.sourceUrl;
        la.target = '_blank';
        la.rel = 'noopener';
        la.textContent = 'Открыть страницу на Playerok';
        linkRow.appendChild(la);
    } else {
        linkRow.textContent = 'Список';
    }
    root.appendChild(linkRow);

    // ── Пагинация: показываем COMPLETED_PAGE_SIZE записей за раз ──────────────────
    var totalPages = Math.ceil(items.length / COMPLETED_PAGE_SIZE);
    if (completedCatalogPage >= totalPages) completedCatalogPage = 0;

    var pageStart = completedCatalogPage * COMPLETED_PAGE_SIZE;
    var pageItems = items.slice(pageStart, pageStart + COMPLETED_PAGE_SIZE);

    // ── Bulk toolbar для завершённых ──
    var compToolbar = document.createElement('div');
    compToolbar.className = 'bulk-toolbar';

    var btnSelAllComp = document.createElement('button');
    btnSelAllComp.type = 'button'; btnSelAllComp.className = 'btn-mini btn-sel-all';
    var allCompSel = pageItems.length > 0 && pageItems.every(function(r) { return selSet.has(rowKey(r)); });
    btnSelAllComp.textContent = allCompSel ? 'Снять все' : 'Выбрать все на странице';
    btnSelAllComp.onclick = function() {
        if (pageItems.every(function(r) { return selSet.has(rowKey(r)); })) {
            pageItems.forEach(function(r) { selSet.delete(rowKey(r)); });
        } else {
            pageItems.forEach(function(r) { selSet.add(rowKey(r)); });
        }
        showPanel('completed');
    };
    compToolbar.appendChild(btnSelAllComp);

    // Только черновики из pageItems — их можно выставить
    var pageItemsDrafts = pageItems.filter(function(r) { return completedCatalogIsDraft(r); });
    var cntSel = pageItems.filter(function(r) { return selSet.has(rowKey(r)); }).length;
    var cntSelDraft = pageItemsDrafts.filter(function(r) { return selSet.has(rowKey(r)); }).length;

    var selInfoComp = document.createElement('span');
    selInfoComp.className = 'bulk-sel-info';
    selInfoComp.textContent = cntSel > 0 ? 'Выбрано: ' + cntSel : '';
    compToolbar.appendChild(selInfoComp);

    if (cntSelDraft > 0) {
        var btnBulkPubComp = document.createElement('button');
        btnBulkPubComp.type = 'button'; btnBulkPubComp.className = 'btn-mini btn-bulk-pub';
        btnBulkPubComp.textContent = 'Выставить черновики (' + cntSelDraft + ')';
        btnBulkPubComp.onclick = function() {
            var sel = pageItemsDrafts.filter(function(r) { return selSet.has(rowKey(r)); });
            if (!confirm('Выставить ' + sel.length + ' черновик(ов) на Playerok?')) return;
            batchPublishCompleted(sel);
        };
        compToolbar.appendChild(btnBulkPubComp);
    }

    root.appendChild(compToolbar);

    pageItems.forEach(function(r) { root.appendChild(makeCompletedRow(r, { multisel: true })); });

    if (totalPages > 1) {
        var pgBar = document.createElement('div');
        pgBar.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:12px;flex-wrap:wrap;padding:0 16px 14px;';

        var pgInfo = document.createElement('span');
        pgInfo.style.cssText = 'color:#64748b;font-size:11px;flex:1';
        pgInfo.textContent = 'Страница ' + (completedCatalogPage + 1) + ' из ' + totalPages + ' · всего ' + items.length + ' лотов';

        var btnPrev = document.createElement('button');
        btnPrev.type = 'button'; btnPrev.className = 'btn-mini';
        btnPrev.textContent = '← Назад';
        btnPrev.disabled = completedCatalogPage === 0;
        btnPrev.onclick = function() { completedCatalogPage--; showPanel('completed'); };

        var btnNext = document.createElement('button');
        btnNext.type = 'button'; btnNext.className = 'btn-mini';
        btnNext.textContent = 'Далее →';
        btnNext.disabled = completedCatalogPage >= totalPages - 1;
        btnNext.onclick = function() { completedCatalogPage++; showPanel('completed'); };

        pgBar.appendChild(btnPrev);
        pgBar.appendChild(pgInfo);
        pgBar.appendChild(btnNext);
        root.appendChild(pgBar);
    }

    return root;
}

function makeTopGames() {
    var map = {};
    sales.forEach(function(s) {
        var g = (s.gameTitle || '—').trim();
        if (!map[g]) map[g] = {cnt:0, sum:0};
        map[g].cnt++;
        var p = Number(s.priceRub);
        if (isFinite(p)) map[g].sum += p;
    });
    var sorted = Object.keys(map).map(function(k){ return {name:k, cnt:map[k].cnt, sum:map[k].sum}; })
                    .sort(function(a,b){ return b.cnt - a.cnt; }).slice(0, 8);
    if (!sorted.length) return document.createElement('div');
    var maxCnt = sorted[0].cnt;

    var wrap = document.createElement('div'); wrap.className = 'top-games';
    var t = document.createElement('div'); t.className = 'top-title'; t.textContent = 'Топ игр';
    wrap.appendChild(t);
    sorted.forEach(function(g) {
        var row = document.createElement('div'); row.className = 'game-row';
        var n = document.createElement('div'); n.className = 'game-name'; n.title = g.name; n.textContent = g.name;
        var tr = document.createElement('div'); tr.className = 'game-track';
        var fi = document.createElement('div'); fi.className = 'game-fill'; fi.style.width = Math.round(g.cnt/maxCnt*100)+'%';
        tr.appendChild(fi);
        var c = document.createElement('div'); c.className = 'game-cnt'; c.textContent = g.cnt+'x';
        var s = document.createElement('div'); s.className = 'game-sum'; s.textContent = g.sum > 0 ? fmt(g.sum)+' ₽' : '—';
        row.appendChild(n); row.appendChild(tr); row.appendChild(c); row.appendChild(s);
        wrap.appendChild(row);
    });
    var sep = document.createElement('hr'); sep.className = 'sep';
    var wrapper = document.createElement('div');
    wrapper.appendChild(wrap); wrapper.appendChild(sep);
    return wrapper;
}

function makeRevBlock() {
    var ts = todayMs();
    var totSum=0, todSum=0, todCnt=0, weekSum=0, weekCnt=0, withP=0, avg=0;
    var weekStart = ts - 6*86400000;
    sales.forEach(function(s) {
        var p = Number(s.priceRub), ok = isFinite(p);
        if (ok) { totSum += p; withP++; }
        if (s.at >= ts)        { todCnt++; if (ok) todSum += p; }
        if (s.at >= weekStart) { weekCnt++; if (ok) weekSum += p; }
    });
    if (withP) avg = Math.round(totSum/withP);

    var block = document.createElement('div'); block.className = 'rev-block';
    function row(label, val, cls) {
        var d = document.createElement('div'); d.className = 'rev-line' + (cls ? ' '+cls : '');
        d.innerHTML = '<span>' + label + '</span><span>' + val + '</span>';
        block.appendChild(d);
    }
    var sec = function(t){ var d = document.createElement('div'); d.className = 'rev-section'; d.textContent = t; block.appendChild(d); };
    sec('Сегодня');
    row('Продаж сегодня', todCnt + ' шт.', 'hi');
    row('Выручка сегодня', todSum > 0 ? fmt(todSum) + ' ₽' : '—', 'hi');
    sec('За 7 дней');
    row('Продаж за неделю', weekCnt + ' шт.');
    row('Выручка за неделю', weekSum > 0 ? fmt(weekSum) + ' ₽' : '—');
    sec('Всего');
    row('Всего продаж', sales.length + ' шт.');
    row('Выручка (известная цена)', fmt(totSum) + ' ₽');
    row('Средний чек', avg > 0 ? fmt(avg) + ' ₽' : '—');
    row('Выставлено (черновики)', fmt(sumLots(drafts)) + ' ₽');
    row('Выставлено (в продаже)', fmt(sumLots(published)) + ' ₽');
    var ccItems = completedCatalog && completedCatalog.items ? completedCatalog.items : [];
    var ccSum = ccItems.reduce(function(a, r) {
        var p = Number(r.priceRub);
        return a + (isFinite(p) ? p : 0);
    }, 0);
    if (ccItems.length) {
        sec('Завершённые лоты (снимок Playerok)');
        row('Лотов в снимке', ccItems.length + ' шт.');
        row('Сумма цен в снимке', ccSum > 0 ? fmt(ccSum) + ' ₽' : '—');
        row('Уникальных игр', countDistinctGames(ccItems) + '');
    }
    row('Итого выручка', fmt(totSum) + ' ₽', 'total');

    var boostSum = sumBoostRub(manualBoosts);
    sec('Ручные бусты (учёт вручную)');
    row('Записей', manualBoosts.length + ' шт.');
    row('Потрачено на платный буст', boostSum > 0 ? fmt(boostSum) + ' ₽' : '—');

    sec('Итоговые вычеты');
    var commAmount = Math.round(totSum * 0.2);
    var netAfterComm = Math.round(totSum * 0.8) - boostSum;
    row('Комиссия сайта 20%', totSum > 0 ? '−' + fmt(commAmount) + ' ₽' : '—');
    row('Ручные бусты', boostSum > 0 ? '−' + fmt(boostSum) + ' ₽' : '—');
    var netCls = 'total' + (netAfterComm < 0 ? ' neg' : '');
    row('Чистая прибыль к выводу', totSum > 0 ? fmt(netAfterComm) + ' ₽' : '—', netCls);

    var note = document.createElement('div'); note.className = 'rev-note';
    note.textContent = 'Комиссия сайта 20% вычитается из каждой продажи. Ручные бусты — платное поднятие лотов на Playerok (добавляйте на карточке «Ручной буст»). Чистая прибыль к выводу = выручка × 0.8 − бусты.';
    block.appendChild(note);
    return block;
}

function makeManualBoostPanel() {
    var root = document.createElement('div');

    var form = document.createElement('div'); form.className = 'mb-form';
    var ft = document.createElement('div'); ft.className = 'mb-form-title'; ft.textContent = 'Новая запись';
    form.appendChild(ft);

    var r1 = document.createElement('div'); r1.className = 'mb-row';
    var inpUrl = document.createElement('input');
    inpUrl.type = 'text'; inpUrl.placeholder = 'Ссылка на лот (вставьте с Playerok)';
    var inpTitle = document.createElement('input');
    inpTitle.type = 'text'; inpTitle.placeholder = 'Название (необязательно)';
    r1.appendChild(inpUrl); r1.appendChild(inpTitle);

    var r2 = document.createElement('div'); r2.className = 'mb-row';
    var inpRub = document.createElement('input');
    inpRub.type = 'number'; inpRub.min = '0'; inpRub.step = '1'; inpRub.placeholder = '₽';
    inpRub.value = '';
    var btnAdd = document.createElement('button');
    btnAdd.type = 'button'; btnAdd.className = 'btn-add'; btnAdd.textContent = 'Добавить';
    btnAdd.onclick = function() {
        addManualBoost(inpUrl.value, inpTitle.value, inpRub.value);
        inpUrl.value = ''; inpTitle.value = ''; inpRub.value = '';
    };
    r2.appendChild(inpRub); r2.appendChild(btnAdd);

    form.appendChild(r1); form.appendChild(r2);
    root.appendChild(form);

    var lt = document.createElement('div'); lt.className = 'mb-list-title'; lt.textContent = 'История';
    root.appendChild(lt);

    var sorted = manualBoosts.slice().sort(function(a, b) { return (b.at || 0) - (a.at || 0); });
    if (!sorted.length) {
        var empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'Пока пусто. Платный буст на Playerok подхватывается автоматически; с кнопки «Буст» в опубликованных — тоже. Ниже можно добавить запись вручную (URL + сумма).';
        root.appendChild(empty);
        return root;
    }

    sorted.forEach(function(e) {
        var wrap = document.createElement('div'); wrap.className = 'mb-item';
        var head = document.createElement('div'); head.className = 'mb-item-head';
        var t = document.createElement('div'); t.className = 'mb-item-title';
        t.textContent = e.title || 'Лот';
        var rub = document.createElement('div'); rub.className = 'mb-item-rub';
        rub.textContent = fmt(e.rub) + ' ₽';
        head.appendChild(t); head.appendChild(rub);

        var meta = document.createElement('div'); meta.className = 'mb-item-meta';
        meta.textContent = fmtDate(e.at);

        var actions = document.createElement('div'); actions.className = 'mb-item-actions';
        if (e.url && /^https?:\/\//i.test(e.url)) {
            var a = document.createElement('a'); a.href = e.url; a.target = '_blank'; a.rel = 'noopener';
            a.textContent = 'Открыть товар';
            actions.appendChild(a);
        }
        var del = document.createElement('button'); del.className = 'btn-mini'; del.textContent = 'Удалить';
        del.onclick = (function(id) { return function() { removeManualBoost(id); }; })(e.id);
        actions.appendChild(del);

        wrap.appendChild(head); wrap.appendChild(meta); wrap.appendChild(actions);
        root.appendChild(wrap);
    });

    return root;
}

function makeBotBlock() {
    var block = document.createElement('div'); block.className = 'bot-block';
    function row(label, val, cls) {
        var d = document.createElement('div'); d.className = 'bot-row';
        var k = document.createElement('span'); k.className = 'k'; k.textContent = label;
        var v = document.createElement('span'); v.className = 'v' + (cls ? ' '+cls : ''); v.textContent = val;
        d.appendChild(k); d.appendChild(v); block.appendChild(d);
    }
    row('Статус', botRunning ? 'Работает' : 'Остановлен', botRunning ? 'on' : 'off');
    row('Поднято всего', botProcessed + ' лотов');
    row('Выложено сегодня', pubToday + ' лот.');
    row('Поднято сегодня', actToday + ' лот.');
    row('Всего продаж', sales.length + ' шт.');
    var lastSale = sales.length ? sales[0].at : 0;
    row('Последняя продажа', lastSale ? fmtTime(lastSale) : '—');
    return block;
}

// ── Batch operations ──────────────────────────────────────────────────────────

/** Собрать payload для выставления из строки черновика */
function makePubPayload(row) {
    var slugGuess = '';
    try {
        var pu = row.url && String(row.url).split('?')[0];
        var sm = pu && pu.match(/\/(?:products|item)\/([^/]+)\/?$/i);
        if (sm) slugGuess = decodeURIComponent(sm[1] || '').trim();
    } catch (e) { /* */ }
    return {
        url: row.url || '',
        slug: row.slug || slugGuess,
        title: row.title || '',
        itemId: String(row.itemId || row.id || '').trim(),
        obtainingTypeId: String(row.obtainingTypeId || '').trim(),
        rawPrice: Number(row.salePriceRub) || Number(row.priceRub) || Number(row.basePriceRub) || 0,
        salePriceRub: Number(row.salePriceRub) || Number(row.priceRub) || 0,
        basePriceRub: Number(row.basePriceRub) || 0
    };
}

/**
 * Выставить черновики пачкой — единая bridge-сессия в background.
 */
function batchPublishDrafts(rows) {
    if (!rows.length) return;
    var items = rows.map(makePubPayload);
    chrome.runtime.sendMessage({ action: 'DASHBOARD_BATCH_PUBLISH', items: items }, function(res) {
        if (chrome.runtime.lastError) { alert('Ошибка: ' + chrome.runtime.lastError.message); return; }
        var r = res || {};
        var msg = 'Готово: выставлено ' + (r.done || 0) + (r.skipped ? ', уже активных ' + r.skipped : '') + (r.failed ? ', ошибок ' + r.failed : '') + ' из ' + rows.length + '.';
        if (r.errors && r.errors.length) msg += '\n' + r.errors.slice(0, 3).join('\n');
        selClear();
        alert(msg);
        render();
    });
}

/**
 * Пакетно удаляет черновики из сводки (только из расширения, не с сайта).
 */
function batchDeleteDrafts(rows) {
    if (!rows.length) return;
    var remaining = rows.length;
    rows.forEach(function(row) {
        removeDraftRow(row, function() {
            remaining--;
            if (remaining === 0) { selClear(); render(); }
        });
    });
}

/**
 * Последовательно бустит опубликованные лоты (платный буст).
 * Буст идёт по одному — каждый платный, нельзя ошибиться с ценой.
 */
function batchBoostPublished(rows) {
    if (!rows.length) return;
    var total = rows.length;
    var done = 0, failed = 0;
    var idx = 0;

    function next() {
        if (idx >= rows.length) {
            selClear();
            alert('Платный буст завершён: ' + done + ' из ' + total + (failed ? ', ошибок: ' + failed : '') + '.');
            render();
            return;
        }
        var row = rows[idx++];
        var payload = {
            url: row.url || '',
            title: row.title || '',
            publishedId: row.id || '',
            at: row.at || 0,
            itemId: row.itemId || '',
            rawPrice: Number(row.salePriceRub) || Number(row.basePriceRub) || 0
        };
        chrome.runtime.sendMessage({ action: 'DASHBOARD_PAID_BUMP', payload: payload }, function(res) {
            if (chrome.runtime.lastError || !res || !res.ok) failed++;
            else done++;
            setTimeout(next, 1200);
        });
    }
    next();
}

/**
 * Пакетно удаляет опубликованные лоты из сводки (только из расширения, не с сайта).
 */
function batchDeletePublished(rows) {
    if (!rows.length) return;
    var remaining = rows.length;
    rows.forEach(function(row) {
        removePublishedRow(row, function() {
            remaining--;
            if (remaining === 0) { selClear(); render(); }
        });
    });
}

/**
 * Выставить черновики из каталога завершённых — единая bridge-сессия.
 */
function batchPublishCompleted(rows) {
    if (!rows.length) return;
    var items = rows.map(function(r) {
        return {
            url: r.url || '',
            slug: String(r.slug || '').trim(),
            title: r.title || '',
            itemId: String(r.id || '').trim(),
            obtainingTypeId: String(r.obtainingTypeId || '').trim(),
            rawPrice: Number(r.salePriceRub) || Number(r.priceRub) || Number(r.basePriceRub) || 0,
            salePriceRub: Number(r.salePriceRub) || Number(r.priceRub) || 0,
            basePriceRub: Number(r.basePriceRub) || 0
        };
    });
    chrome.runtime.sendMessage({ action: 'DASHBOARD_BATCH_PUBLISH', items: items }, function(res) {
        if (chrome.runtime.lastError) { alert('Ошибка: ' + chrome.runtime.lastError.message); return; }
        var r = res || {};
        var msg = 'Готово: выставлено ' + (r.done || 0) + (r.skipped ? ', уже активных ' + r.skipped : '') + (r.failed ? ', ошибок ' + r.failed : '') + ' из ' + rows.length + '.';
        if (r.errors && r.errors.length) msg += '\n' + r.errors.slice(0, 3).join('\n');
        selClear();
        alert(msg);
        render();
    });
}

/**
 * Удалить один лот на сайте через API.
 * afterFn — колбек после успешного удаления (напр. removeDraftRow/removePublishedRow).
 */
function deleteItemOnSite(row, afterFn) {
    var payload = {
        itemId: String(row.itemId || row.id || '').trim(),
        url: row.url || '',
        title: row.title || ''
    };
    if (!payload.itemId && !payload.url) {
        alert('Нет ссылки или id лота — невозможно удалить на сайте.');
        return;
    }
    chrome.runtime.sendMessage({ action: 'DASHBOARD_DELETE_ITEM', payload: payload }, function(res) {
        if (chrome.runtime.lastError) {
            alert('Ошибка расширения: ' + chrome.runtime.lastError.message);
            return;
        }
        if (res && res.ok) {
            if (afterFn) afterFn();
            else render();
        } else {
            var err = (res && res.error) || 'Не удалось удалить';
            // Лот в активной сделке — нельзя удалять
            if (err.toLowerCase().indexOf('deal') !== -1 || err.toLowerCase().indexOf('сделк') !== -1) {
                alert('Нельзя удалить: лот участвует в активной сделке.');
            } else {
                alert('Ошибка: ' + err + '\n\nУбедитесь что вы залогинены на playerok.com.');
            }
        }
    });
}

// ── CSV export ────────────────────────────────────────────────────────────────
function exportCSV() {
    if (!sales.length) return;
    var rows = [['Дата','Игра','Покупатель','Логин','Пароль','Цена ₽','Сделка']];
    sales.forEach(function(s) {
        rows.push([fmtDate(s.at), s.gameTitle||'', s.buyerName||'', s.login||'', s.password||'', s.priceRub != null ? s.priceRub : '', s.dealUrl||'']);
    });
    var csv = rows.map(function(r){ return r.map(function(v){ return '"'+String(v).replace(/"/g,'""')+'"'; }).join(','); }).join('\r\n');
    var blob = new Blob(['\uFEFF'+csv], {type:'text/csv;charset=utf-8'});
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = url; a.download = 'playerok_sales_' + new Date().toISOString().slice(0,10) + '.csv';
    a.click(); URL.revokeObjectURL(url);
}

function exportRevenueCSV() {
    var ts = todayMs();
    var weekStart = ts - 6 * 86400000;
    var totSum = 0, todSum = 0, todCnt = 0, weekSum = 0, weekCnt = 0;
    sales.forEach(function(s) {
        var p = Number(s.priceRub);
        var ok = isFinite(p);
        if (ok) totSum += p;
        if (s.at >= ts)        { todCnt++; if (ok) todSum += p; }
        if (s.at >= weekStart) { weekCnt++; if (ok) weekSum += p; }
    });
    var boostSum = sumBoostRub(manualBoosts);
    var commFn = function(v) { return Math.round(v * 0.2); };
    var netFn  = function(v) { return Math.round(v * 0.8); };

    var rows = [
        ['Период', 'Продаж (шт.)', 'Выручка (₽)', 'Комиссия 20% (₽)', 'После комиссии (₽)'],
        ['Сегодня',    todCnt,  todSum,  commFn(todSum),  netFn(todSum)],
        ['За 7 дней',  weekCnt, weekSum, commFn(weekSum), netFn(weekSum)],
        ['Всего',      sales.length, totSum, commFn(totSum), netFn(totSum)],
        [],
        ['Расходы', '', '', '', ''],
        ['Ручные бусты (записей)', manualBoosts.length, boostSum, '', ''],
        [],
        ['Итог', '', '', '', ''],
        ['Чистая прибыль к выводу (−20% −бусты)', '', Math.round(totSum * 0.8) - boostSum, '', '']
    ];

    var csv = rows.map(function(r) {
        if (!r.length) return '';
        return r.map(function(v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\r\n');

    var blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'playerok_revenue_' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    URL.revokeObjectURL(url);
}

// ── Diagnostics ───────────────────────────────────────────────────────────────
function runDiag() {
    var panel = el('diagPanel');
    if (panel.style.display === 'block') { panel.style.display = 'none'; return; }
    panel.style.display = 'block';
    panel.textContent = '⏳ Читаю chrome.storage.local...';

    if (typeof chrome === 'undefined' || !chrome.storage) {
        panel.textContent = '❌ chrome API недоступен!\n\nЭта вкладка потеряла связь с расширением.\nЗакройте её и откройте дашборд заново из попапа расширения.';
        return;
    }

    chrome.storage.local.get(null, function(all) {
        var err = chrome.runtime && chrome.runtime.lastError;
        if (err) {
            panel.textContent = '❌ Ошибка storage: ' + err.message + '\n\nЗакройте вкладку и откройте дашборд заново из попапа.';
            return;
        }
        var out = '=== ДИАГНОСТИКА chrome.storage.local ===\n';
        out += 'Всего ключей: ' + Object.keys(all).length + '\n\n';

        var checks = [K.drafts, K.published, K.lots, K.sales, K.boost, K.completed, K.running, K.processed, K.batch, K.actToday, K.pubToday, K.username];
        checks.forEach(function(k) {
            var v = all[k];
            if (Array.isArray(v)) {
                out += k + ': [' + v.length + ' элем.]\n';
                if (v.length) out += '  ↳ ' + JSON.stringify(v[0]).slice(0,150) + '\n';
            } else if (v === undefined) {
                out += k + ': (не существует)\n';
            } else {
                out += k + ': ' + JSON.stringify(v) + '\n';
            }
        });

        var hasData = (all[K.drafts]||[]).length > 0 || (all[K.published]||[]).length > 0 || (all[K.sales]||[]).length > 0;
        out += '\n✅ storage доступен.\n';
        if (hasData) {
            out += '📦 ДАННЫЕ ЕСТЬ. Если карточки показывают 0 — нажмите "Обновить" или F5.';
        } else {
            out += '📭 Данных нет. Перезагрузи расширение (chrome://extensions → 🔄) и попробуй снова.';
        }
        panel.textContent = out;
    });
}

// ── Export / Import ───────────────────────────────────────────────────────────
var RUNTIME_SKIP_KEYS = ['isRunning', 'currentMode', 'logs', 'batch'];

function exportAllData() {
    el('tsLabel').textContent = '⏳ Формирую бэкап...';
    chrome.storage.local.get(null, function(all) {
        if (chrome.runtime && chrome.runtime.lastError) {
            el('tsLabel').textContent = '⚠ Ошибка чтения storage: ' + chrome.runtime.lastError.message;
            return;
        }
        var data = {};
        Object.keys(all).forEach(function(k) {
            if (RUNTIME_SKIP_KEYS.indexOf(k) === -1) data[k] = all[k];
        });
        var backup = {
            _meta: {
                version: 2,
                app: 'Playerok Auto-Helper Pro',
                exportedAt: new Date().toISOString(),
                keys: Object.keys(data).length,
                drafts:    (data[K.drafts]    || []).length,
                published: (data[K.published] || []).length,
                sales:     (data[K.sales]     || []).length
            },
            data: data
        };
        var json = JSON.stringify(backup, null, 2);
        var blob = new Blob(['\uFEFF' + json], { type: 'application/json;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'playerok_backup_' + new Date().toISOString().slice(0, 10) + '.json';
        a.click();
        URL.revokeObjectURL(url);
        el('tsLabel').textContent = '✅ Бэкап сохранён (' + Object.keys(data).length + ' ключей)';
    });
}

function importAllData(file) {
    var reader = new FileReader();
    reader.onload = function(ev) {
        var backup;
        try {
            // Strip BOM if present
            var text = ev.target.result.replace(/^\uFEFF/, '');
            backup = JSON.parse(text);
        } catch (ex) {
            alert('❌ Не удалось прочитать файл: ' + ex.message);
            return;
        }
        if (!backup || !backup.data || !backup._meta) {
            alert('❌ Файл не является бэкапом Playerok Auto-Helper Pro.\n\nОжидается файл, созданный кнопкой «Экспорт БД».');
            return;
        }
        var meta = backup._meta;
        var dateStr = meta.exportedAt
            ? new Date(meta.exportedAt).toLocaleString('ru-RU')
            : 'неизвестно';
        var summary = [
            'Дата бэкапа:     ' + dateStr,
            'Ключей в файле:  ' + meta.keys,
            'Черновики:       ' + (meta.drafts    || '?'),
            'Опубликованные:  ' + (meta.published || '?'),
            'Продажи:         ' + (meta.sales     || '?')
        ].join('\n');

        if (!confirm(
            '⬆️ Восстановление данных\n\n' + summary +
            '\n\n⚠️ Текущие данные будут ПЕРЕЗАПИСАНЫ.\nПродолжить?'
        )) return;

        el('tsLabel').textContent = '⏳ Импортирую...';
        chrome.storage.local.set(backup.data, function() {
            if (chrome.runtime && chrome.runtime.lastError) {
                el('tsLabel').textContent = '⚠ Ошибка импорта: ' + chrome.runtime.lastError.message;
                alert('❌ Ошибка при записи данных: ' + chrome.runtime.lastError.message);
                return;
            }
            el('tsLabel').textContent = '✅ Импорт завершён — обновляю...';
            setTimeout(function() { location.reload(); }, 800);
        });
    };
    reader.readAsText(file, 'utf-8');
}

// ── Init: attach all listeners after DOM ready ────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {

    el('btnRefresh').addEventListener('click', function() {
        el('tsLabel').textContent = 'Обновление...';
        render();
    });

    el('btnDiag').addEventListener('click', runDiag);

    el('btnExportAll').addEventListener('click', exportAllData);

    el('btnImportAll').addEventListener('click', function() {
        el('importFileInput').value = '';
        el('importFileInput').click();
    });

    el('importFileInput').addEventListener('change', function() {
        var file = this.files && this.files[0];
        if (file) importAllData(file);
    });

    el('btnClear').addEventListener('click', function() {
        if (!confirm('Удалить сводку? История заказов не изменится.')) return;
        chrome.storage.local.remove([K.lots, K.drafts, K.published, K.sales, K.boost, K.completed], function() {
            closeAll(); el('detailPanel').classList.remove('open'); render();
        });
    });

    el('cDrafts').dataset.panel    = 'drafts';
    el('cPublished').dataset.panel = 'published';
    el('cCompleted').dataset.panel = 'completed';
    el('cSales').dataset.panel     = 'sales';
    el('cRevenue').dataset.panel   = 'revenue';
    el('cManualBoost').dataset.panel = 'manualBoost';
    el('cBot').dataset.panel       = 'bot';

    ['cCompleted','cDrafts','cPublished','cSales','cRevenue','cManualBoost','cBot'].forEach(function(id) {
        el(id).addEventListener('click', function() {
            var kind = this.dataset.panel;
            var wasOpen = this.classList.contains('open');
            closeAll();
            var panel = el('detailPanel');
            if (wasOpen) { panel.classList.remove('open'); return; }
            this.classList.add('open');
            showPanel(kind);
        });
    });

    // Storage change listener с дебаунсом — исключает шквал render() при активном боте
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
        var watched = Object.values(K);
        chrome.storage.onChanged.addListener(function(changes, area) {
            if (area !== 'local') return;
            for (var k in changes) {
                if (watched.indexOf(k) !== -1) { scheduleRender(); return; }
            }
        });
    }

    // ── Refresh каталога «Все товары» ─────────────────────────────────────────
    var _catalogRefreshInProgress = false;

    function triggerCatalogRefresh(force) {
        if (_catalogRefreshInProgress) return;
        _catalogRefreshInProgress = true;
        var btn = el('sCompletedRefreshBtn');
        // При force (ручной клик) показываем спиннер. При авто — не мигаем.
        if (force && btn) { btn.textContent = '⏳ загрузка…'; btn.style.color = '#facc15'; }
        chrome.storage.local.get([K.username], function(s) {
            var nick = String((s && s[K.username]) || '').trim();
            chrome.runtime.sendMessage(
                { action: 'DASHBOARD_AUTO_REFRESH_CATALOG', username: nick || undefined, force: !!force },
                function(res) {
                    void chrome.runtime.lastError;
                    _catalogRefreshInProgress = false;
                    var btn2 = el('sCompletedRefreshBtn');
                    if (!btn2) return;
                    // Авто-режим: молчим при любых ошибках. Показываем только зелёный успех.
                    if (!force) {
                        if (res && res.ok && !res.skipped) {
                            btn2.textContent = '✓ обновлено';
                            btn2.style.color = '#4ade80';
                            setTimeout(function() {
                                var b = el('sCompletedRefreshBtn');
                                if (b) { b.textContent = '🔄 обновить'; b.style.color = '#94a3b8'; }
                            }, 3000);
                        }
                        // При ошибке авто-режима — старые данные остаются в UI, кнопка нейтральна.
                        return;
                    }
                    // Force (ручной клик): показываем полный статус
                    if (res && res.ok) {
                        btn2.textContent = '✓ обновлено';
                        btn2.style.color = '#4ade80';
                    } else {
                        var errMsg = (res && res.error) ? res.error : 'нет вкладки Playerok';
                        var humanMsg;
                        if (errMsg === 'no_playerok_tab' || errMsg === 'no_live_bridge') humanMsg = 'нет вкладки Playerok';
                        else if (errMsg.indexOf('Apollo cache empty') !== -1) humanMsg = 'откройте /products';
                        else if (errMsg === 'no_username') humanMsg = 'запусти бота';
                        else humanMsg = errMsg.slice(0, 30);
                        btn2.textContent = '⚠ ' + humanMsg;
                        btn2.style.color = '#f87171';
                    }
                    setTimeout(function() {
                        var b = el('sCompletedRefreshBtn');
                        if (b) { b.textContent = '🔄 обновить'; b.style.color = '#94a3b8'; }
                    }, 4000);
                }
            );
        });
    }

    // Кнопка 🔄 на карточке
    var refreshBtn = el('sCompletedRefreshBtn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', function(e) {
            e.stopPropagation(); // не раскрывать карточку
            triggerCatalogRefresh(true);
        });
    }

    // Первый запуск при загрузке sidepanel. Дальше — только по клику на 🔄.
    // (visibilitychange убран: он срабатывал на каждое переключение окна и
    //  триггерил навигацию вкладки playerok, что ломало content-скрипты других модулей.)
    triggerCatalogRefresh(false);

    // Initial render
    render();
});
