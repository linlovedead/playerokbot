'use strict';

const DAILY_LIMIT = 24;
const ORDERS_HISTORY_KEY = 'orders_history_db';
const ACTIVATIONS_TODAY_KEY = 'activations_today';
const ACTIVATIONS_DATE_KEY = 'activations_date';

let allOrders = [];

// ── Activations counter ───────────────────────────────────────────────────────
function getActivationsToday() {
    return new Promise(resolve => {
        chrome.storage.local.get([ACTIVATIONS_TODAY_KEY, ACTIVATIONS_DATE_KEY], (res) => {
            const today = new Date().toISOString().slice(0, 10);
            resolve(res[ACTIVATIONS_DATE_KEY] !== today ? 0 : (res[ACTIVATIONS_TODAY_KEY] || 0));
        });
    });
}

function incrementActivations() {
    const today = new Date().toISOString().slice(0, 10);
    return getActivationsToday().then(count => {
        const newCount = count + 1;
        chrome.storage.local.set({ [ACTIVATIONS_TODAY_KEY]: newCount, [ACTIVATIONS_DATE_KEY]: today });
        return newCount;
    });
}

function updateCounterUI(count) {
    const pct = Math.min(100, Math.round((count / DAILY_LIMIT) * 100));
    const el = document.getElementById('counterValue');
    el.textContent = count + ' / ' + DAILY_LIMIT;
    el.className = 'counter-value' + (count >= DAILY_LIMIT ? ' limit' : count >= 18 ? ' warn' : '');
    const fill = document.getElementById('counterBarFill');
    fill.style.width = pct + '%';
    fill.style.background = count >= DAILY_LIMIT ? '#cf6679' : count >= 18 ? '#ff9800' : '#00ff00';
    document.getElementById('limitWarning').style.display = count >= DAILY_LIMIT ? 'block' : 'none';
}

// ── Storage helpers ───────────────────────────────────────────────────────────
function loadOrders() {
    return new Promise(resolve => {
        chrome.storage.local.get(ORDERS_HISTORY_KEY, (res) => resolve(res[ORDERS_HISTORY_KEY] || []));
    });
}

function saveOrders(orders, cb) {
    chrome.storage.local.set({ [ORDERS_HISTORY_KEY]: orders }, cb || function() {});
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatDate(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return d.toLocaleDateString('ru-RU') + ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function currentQuery() {
    return document.getElementById('searchInput').value.toLowerCase().trim();
}

function filterOrders(orders, q) {
    if (!q) return orders;
    return orders.filter(function(o) {
        return (o.buyerName || '').toLowerCase().includes(q) ||
               (o.gameTitle || '').toLowerCase().includes(q) ||
               (o.orderId   || '').toLowerCase().includes(q) ||
               (o.chatId    || '').toLowerCase().includes(q);
    });
}

// ── Render table ──────────────────────────────────────────────────────────────
function renderOrders(orders) {
    var tbody = document.getElementById('ordersBody');
    var emptyState = document.getElementById('emptyState');
    var table = document.getElementById('ordersTable');
    tbody.innerHTML = '';

    if (!orders || orders.length === 0) {
        emptyState.style.display = 'block';
        table.style.display = 'none';
        return;
    }

    emptyState.style.display = 'none';
    table.style.display = 'table';

    orders.forEach(function(order, idx) {
        var tr = document.createElement('tr');
        tr.dataset.id = order.id;

        var hasCredentials = order.login && order.password;
        var isManual = order.source === 'manual';

        var badgeHtml = isManual
            ? '<span class="badge badge-manual">Вручную</span>'
            : '<span class="badge badge-green">Выдан</span>';

        var actionHtml = hasCredentials
            ? '<button class="btn btn-primary show-data-btn" data-id="' + escapeHtml(order.id) + '" style="font-size:11px;padding:5px 10px;">👁 Показать данные</button>'
            : '<span class="text-dim">Нет данных</span>';

        tr.innerHTML =
            '<td class="text-dim">' + (orders.length - idx) + '</td>' +
            '<td class="text-dim">' + formatDate(order.createdAt) + '</td>' +
            '<td class="text-buyer">' + escapeHtml(order.buyerName || '—') + '</td>' +
            '<td class="text-game">' + escapeHtml(order.gameTitle || '—') + '</td>' +
            '<td>' + badgeHtml + '</td>' +
            '<td>' + actionHtml + '</td>' +
            '<td><button class="btn-delete delete-btn" data-id="' + escapeHtml(order.id) + '" title="Удалить запись">✕</button></td>';
        tbody.appendChild(tr);
    });

    tbody.querySelectorAll('.show-data-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var order = allOrders.find(function(o) { return o.id === btn.dataset.id; });
            if (!order) return;

            if (order.source !== 'manual') {
                getActivationsToday().then(function(count) {
                    if (count >= DAILY_LIMIT) {
                        alert('⛔ Лимит активаций исчерпан (' + DAILY_LIMIT + '/сутки). Повторный просмотр будет доступен завтра.');
                        return;
                    }
                    incrementActivations().then(function(newCount) {
                        updateCounterUI(newCount);
                        openModal(order);
                    });
                });
            } else {
                openModal(order);
            }
        });
    });

    tbody.querySelectorAll('.delete-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            if (!confirm('Удалить эту запись?')) return;
            allOrders = allOrders.filter(function(o) { return o.id !== btn.dataset.id; });
            saveOrders(allOrders, function() { renderOrders(filterOrders(allOrders, currentQuery())); });
        });
    });
}

// ── Credentials modal ─────────────────────────────────────────────────────────
function openModal(order) {
    document.getElementById('modalGame').textContent     = order.gameTitle || '—';
    document.getElementById('modalBuyer').textContent    = order.buyerName || '—';
    document.getElementById('modalLogin').textContent    = order.login     || '—';
    document.getElementById('modalPassword').textContent = order.password  || '—';
    document.getElementById('modalMeta').textContent     = 'Заказ: ' + (order.orderId || order.chatId || '—') + ' | Дата: ' + formatDate(order.createdAt);
    document.getElementById('credsModal').classList.add('active');
}

function closeModal() {
    document.getElementById('credsModal').classList.remove('active');
}

function copyFieldById(elementId, btn) {
    var text = document.getElementById(elementId).textContent;
    if (!text || text === '—') return;
    navigator.clipboard.writeText(text).then(function() {
        var orig = btn.textContent;
        btn.textContent = '✅ Скопировано';
        setTimeout(function() { btn.textContent = orig; }, 1500);
    });
}

// ── Add manual modal ──────────────────────────────────────────────────────────
function openAddManualModal() {
    ['mGame', 'mBuyer', 'mLogin', 'mPassword', 'mOrderId'].forEach(function(id) {
        var el = document.getElementById(id);
        el.value = '';
        el.classList.remove('required-field');
    });
    document.getElementById('addManualModal').classList.add('active');
    document.getElementById('mGame').focus();
}

function closeAddManualModal() {
    document.getElementById('addManualModal').classList.remove('active');
}

function saveManualEntry() {
    var valid = true;
    ['mGame', 'mLogin', 'mPassword'].forEach(function(id) {
        var el = document.getElementById(id);
        if (!el.value.trim()) { el.classList.add('required-field'); valid = false; }
        else                  { el.classList.remove('required-field'); }
    });
    if (!valid) return;

    var entry = {
        id:        'manual-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
        createdAt: Date.now(),
        gameTitle: document.getElementById('mGame').value.trim(),
        buyerName: document.getElementById('mBuyer').value.trim() || '—',
        login:     document.getElementById('mLogin').value.trim(),
        password:  document.getElementById('mPassword').value.trim(),
        orderId:   document.getElementById('mOrderId').value.trim() || '',
        source:    'manual'
    };

    allOrders = [entry].concat(allOrders);
    saveOrders(allOrders, function() {
        renderOrders(filterOrders(allOrders, currentQuery()));
        closeAddManualModal();
    });
}

// ── CSV export ────────────────────────────────────────────────────────────────
function exportCsv() {
    if (!allOrders.length) { alert('История пуста.'); return; }
    var rows = [['Дата', 'Игра', 'Покупатель', 'Логин', 'Пароль', 'ID заказа', 'Источник']];
    allOrders.forEach(function(o) {
        rows.push([
            formatDate(o.createdAt),
            o.gameTitle || '',
            o.buyerName || '',
            o.login     || '',
            o.password  || '',
            o.orderId || o.chatId || '',
            o.source === 'manual' ? 'Вручную' : 'Авто'
        ]);
    });
    var csv = rows.map(function(r) {
        return r.map(function(v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\r\n');
    var blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'playerok_orders_' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    URL.revokeObjectURL(url);
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {

    getActivationsToday().then(updateCounterUI);
    loadOrders().then(function(orders) {
        allOrders = orders;
        renderOrders(allOrders);
    });

    document.getElementById('searchInput').addEventListener('input', function(e) {
        renderOrders(filterOrders(allOrders, e.target.value.toLowerCase().trim()));
    });

    document.getElementById('refreshBtn').addEventListener('click', function() {
        loadOrders().then(function(orders) {
            allOrders = orders;
            renderOrders(filterOrders(allOrders, currentQuery()));
        });
    });

    document.getElementById('clearHistoryBtn').addEventListener('click', function() {
        if (!confirm('Удалить всю историю заказов? Это действие необратимо.')) return;
        allOrders = [];
        saveOrders([], function() { renderOrders([]); });
    });

    document.getElementById('exportCsvBtn').addEventListener('click', exportCsv);
    document.getElementById('addManualBtn').addEventListener('click', openAddManualModal);
    document.getElementById('addManualCancelBtn').addEventListener('click', closeAddManualModal);
    document.getElementById('addManualSaveBtn').addEventListener('click', saveManualEntry);

    var copyLoginBtn = document.getElementById('copyLoginBtn');
    var copyPasswordBtn = document.getElementById('copyPasswordBtn');
    if (copyLoginBtn)    copyLoginBtn.addEventListener('click',    function() { copyFieldById('modalLogin',    copyLoginBtn); });
    if (copyPasswordBtn) copyPasswordBtn.addEventListener('click', function() { copyFieldById('modalPassword', copyPasswordBtn); });

    document.getElementById('closeCredsModalBtn').addEventListener('click', closeModal);

    document.getElementById('addManualModal').addEventListener('click', function(e) {
        if (e.target === document.getElementById('addManualModal')) closeAddManualModal();
    });

    document.getElementById('credsModal').addEventListener('click', function(e) {
        if (e.target === document.getElementById('credsModal')) closeModal();
    });

    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') { closeModal(); closeAddManualModal(); }
        if (e.key === 'Enter' && document.getElementById('addManualModal').classList.contains('active')) saveManualEntry();
    });

    chrome.storage.onChanged.addListener(function(changes) {
        if (changes[ORDERS_HISTORY_KEY]) {
            allOrders = changes[ORDERS_HISTORY_KEY].newValue || [];
            renderOrders(filterOrders(allOrders, currentQuery()));
        }
        if (changes[ACTIVATIONS_TODAY_KEY] || changes[ACTIVATIONS_DATE_KEY]) {
            getActivationsToday().then(updateCounterUI);
        }
    });
});
