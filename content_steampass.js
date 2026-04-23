// content_steampass.js — SteamPass.gg (поиск игры, данные, 2FA)
{
    const ELEMENT_TIMEOUT_MS = 5000;
    const wait = (ms) => new Promise(r => setTimeout(r, ms));

    async function waitForElement(getter, timeoutMs = ELEMENT_TIMEOUT_MS) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const el = getter();
            if (el && (el.offsetParent !== null || el.tagName === 'BODY')) return el;
            await wait(300);
        }
        return null;
    }

    function log(msg) {
        try { chrome.runtime.sendMessage({ action: 'LOG', message: `[SteamPass] ${msg}` }).catch(() => { }); } catch (_) { }
    }

    function getAuthTokenFromCookie() {
        const matches = document.cookie.match(new RegExp(
            '(?:^|; )' + 'auth.token'.replace(/([.$?*|{}()[\]\\/+^])/g, '\\$1') + '=([^;]*)'
        ));
        return matches ? decodeURIComponent(matches[1]) : undefined;
    }

    async function performRequest(url, token, method, body, doubleBearer = false) {
        const headers = {
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/json',
            'Authorization': doubleBearer ? `Bearer Bearer ${token}` : `Bearer ${token}`
        };
        const opts = { method: method || 'GET', headers, credentials: 'include' };
        if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
            opts.body = typeof body === 'string' ? body : JSON.stringify(body);
        }
        return fetch(url, opts);
    }

    function extractSteamPassToken() {
        try {
            let t = localStorage.getItem('auth.token') || localStorage.getItem('token');
            if (!t) {
                const auth = localStorage.getItem('auth');
                if (auth) t = JSON.parse(auth)?.token ?? null;
            }
            if (!t) t = sessionStorage.getItem('auth.token') || sessionStorage.getItem('token');
            return t && typeof t === 'string' && t.trim().length > 0 ? (t.startsWith('Bearer ') ? t : `Bearer ${t}`) : null;
        } catch (_) { }
        return null;
    }

    let lastSentToken = null;
    let _tokenMonitorTimer = null;
    let _hadValidToken = false;

    function isProfileLoaded() {
        return !!(document.querySelector('.user-info') || document.querySelector('[href*="profile"]'));
    }

    async function waitForProfile(timeoutMs = 15000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (isProfileLoaded()) return true;
            await wait(500);
        }
        return false;
    }

    function startTokenMonitor() {
        if (_tokenMonitorTimer) return; // уже запущен — не создаём второй таймер
        const check = () => {
            const token = extractSteamPassToken();
            if (token) {
                if (token !== lastSentToken) {
                    chrome.runtime.sendMessage({ action: 'UPDATE_SP_TOKEN', token }).catch(() => { });
                    lastSentToken = token;
                }
                _hadValidToken = true;
            } else if (_hadValidToken) {
                // Сессия истекла (JWT протух) — перезагружаем страницу.
                // Cookie-сессия переживает reload, новый JWT выдаётся автоматически.
                _hadValidToken = false;
                lastSentToken = null;
                try { chrome.runtime.sendMessage({ action: 'LOG', message: '[SteamPass] Токен пропал — сессия истекла или страница перезагружена' }).catch(() => { }); } catch (_) { }
            }
            _tokenMonitorTimer = setTimeout(check, 5000 + Math.floor(Math.random() * 5000));
        };
        _tokenMonitorTimer = setTimeout(check, 3000 + Math.floor(Math.random() * 3000));
    }

    function stopTokenMonitor() {
        if (_tokenMonitorTimer) { clearTimeout(_tokenMonitorTimer); _tokenMonitorTimer = null; }
    }

    function initSteamPass() {
        startTokenMonitor();
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initSteamPass, { once: true });
    } else {
        initSteamPass();
    }

    window.addEventListener('beforeunload', stopTokenMonitor);

    // При разморозке вкладки Chrome (tab freeze/thaw) сразу переотправляем токен.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        const token = extractSteamPassToken();
        if (token && token !== lastSentToken) {
            chrome.runtime.sendMessage({ action: 'UPDATE_SP_TOKEN', token }).catch(() => { });
            lastSentToken = token;
        }
    });

    chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
        if (req.action === 'PING') {
            sendResponse({ status: 'PONG' });
            return false;
        }
        if (req.action === 'GET_TOKEN') {
            sendResponse({ token: extractSteamPassToken() });
            return false;
        }
        if (req.action === 'STEAM_BRIDGE_REQUEST' || req.action === 'STEAM_EXECUTE_REQUEST') {
            (async () => {
                try {
                    let token = getAuthTokenFromCookie();
                    if (!token && req.token) {
                        token = (req.token || '').split(/\s+/).pop()?.trim() || req.token.replace(/^Bearer\s+/gi, '').trim();
                    }
                    if (!token) {
                        sendResponse({ success: false, error: 'Кука auth.token не найдена!' });
                        return;
                    }
                    const useDoubleBearer = req.doubleBearer || req.url?.includes?.('email/code');
                    let res = await performRequest(req.url, token, req.method || 'GET', req.body, useDoubleBearer);
                    if (res.status === 401 && !useDoubleBearer) {
                        console.log('⚠️ 401 получен. Пробую Double Bearer...');
                        res = await performRequest(req.url, token, req.method || 'GET', req.body, true);
                    }
                    const text = await res.text();
                    let data = null;
                    try { data = text ? JSON.parse(text) : null; } catch (_) { }
                    console.log('✅ Bridge: Ответ получен, передаю в background.');
                    sendResponse({ success: true, result: { ok: res.ok, status: res.status, data } });
                } catch (err) {
                    console.error('❌ Bridge Error:', err);
                    sendResponse({ success: false, error: err.message });
                }
            })();
            return true;
        }
        if (req.action === 'BRIDGE_REQUEST' || req.action === 'BRIDGE_FETCH') {
            if (!isProfileLoaded()) {
                sendResponse({ success: false, error: 'WAITING_FOR_AUTH' });
                return false;
            }
            const headers = { 'Accept': 'application/json, text/plain, */*', 'Content-Type': 'application/json' };
            if (req.token) headers['Authorization'] = req.token;
            fetch(req.url, {
                method: req.method || 'GET',
                credentials: 'include',
                headers,
                body: req.body ? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body)) : null
            })
                .then(async (res) => {
                    const text = await res.text();
                    let data = null;
                    try { data = text ? JSON.parse(text) : null; } catch (_) { }
                    sendResponse({ success: true, result: { ok: res.ok, status: res.status, data }, ok: res.ok, status: res.status, data, text });
                })
                .catch((err) => sendResponse({ success: false, error: err.message }));
            return true;
        }
        if (req.action === 'PROXY_STEAM_REQUEST') {
            if (!isProfileLoaded()) {
                sendResponse({ success: false, error: 'WAITING_FOR_AUTH' });
                return false;
            }
            const headers = { 'Accept': 'application/json, text/plain, */*', 'Content-Type': 'application/json' };
            if (req.token) headers['Authorization'] = req.token;
            fetch(req.url, {
                method: req.method || 'GET',
                credentials: 'include',
                headers,
                body: req.body ? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body)) : null
            })
                .then(async (res) => {
                    const text = await res.text();
                    let data = null;
                    try { data = text ? JSON.parse(text) : null; } catch (_) { }
                    if (!res.ok) {
                        sendResponse({ success: false, ok: false, status: res.status, error: data?.message || data?.error || `HTTP ${res.status}`, data, text });
                    } else {
                        sendResponse({ success: true, ok: true, status: res.status, result: { status: res.status, data }, data, text });
                    }
                })
                .catch((err) => sendResponse({ success: false, error: err.message }));
            return true;
        }
        if (req.action === 'STEAMPASS_API') {
            callSteamPassApi(req.url, req.method || 'GET', req.body, req.token).then(sendResponse).catch(e => sendResponse({ error: e.message }));
            return true;
        }
        if (req.action === 'STEAMPASS_SEARCH_AND_GET_DATA') {
            searchAndGetData(req.gameTitle).then(sendResponse).catch(e => sendResponse({ error: e.message }));
            return true;
        }
        if (req.action === 'STEAMPASS_GET_2FA') {
            get2FACode().then(sendResponse).catch(e => sendResponse({ error: e.message }));
            return true;
        }
        return false;
    });

    // --- STEAMPASS_API: fetch из контекста страницы (куки + Bearer) ---
    async function callSteamPassApi(url, method, body, tokenFromBg = null) {
        const authHeader = (tokenFromBg || extractSteamPassToken() || '').trim();
        const opts = {
            method: method || 'GET',
            credentials: 'include',
            headers: { 'Accept': 'application/json, text/plain, */*', 'Content-Type': 'application/json' }
        };
        if (authHeader) opts.headers['Authorization'] = authHeader;
        if (url.includes('product-credentials')) {
            console.log('🔑 Отправляю токен (первые 20 симв):', (authHeader || '').substring(0, 20));
        }
        if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
            opts.body = typeof body === 'string' ? body : JSON.stringify(body);
        }
        const res = await fetch(url, opts);
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (_) { }
        if (!res.ok) {
            console.error('❌ Ошибка SteamPass! Статус:', res.status, 'Токен был:', (authHeader || '').substring(0, 20), text);
            return { ok: false, status: res.status, error: data?.message || data?.error || `HTTP ${res.status}`, data, text };
        }
        return { ok: true, status: res.status, data, text };
    }

    function extractGameName(raw) {
        if (!raw || !String(raw).trim()) return '';
        let s = String(raw).trim()
            // remove all emoji/unicode symbols at start or throughout
            .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}]/gu, '')
            // remove "username —" prefix
            .replace(/^👤\s*[\w\d_-]+\s*[–—\-]\s*/i, '')
            .replace(/✨|🎮|🌟|⭐/g, '')
            // strip everything after | (pipe) — used in our item name template
            .replace(/\s*[|].*$/i, '')
            // strip known suffixes after dash/emdash
            .replace(/\s*[-–—].*$/i, '')
            // strip closed parens: "(Steam Edition)", "(Pre-Order)", etc.
            .replace(/\s*\([^)]*\)/g, '')
            // strip unclosed trailing paren: "Game ("
            .replace(/\s*\([^)]*$/, '')
            .replace(/\s*(ОФФЛАЙН|OFFLINE|АКТИВАЦИЯ|АКТИВАЦИ|ДОСТУП|АККАУНТ|Steam|Edition|Gold|Premium|Deluxe).*$/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
        return s.slice(0, 40);
    }

    // --- STEAMPASS_SEARCH_AND_GET_DATA ---
    async function searchAndGetData(gameTitle) {
        if (!gameTitle || !String(gameTitle).trim()) {
            console.log('[steampass] No gameTitle');
            return { error: 'Нет названия игры' };
        }
        while (document.visibilityState !== 'visible') { await wait(500); }
        const searchTerm = extractGameName(gameTitle) || String(gameTitle).trim().replace(/✨|🎮|👤/g, '').slice(0, 30);
        console.log('[steampass] SEARCH_AND_GET_DATA start, searchTerm:', searchTerm);

        const searchTrigger = await waitForElement(() =>
            document.querySelector?.('.header_search [placeholder="Поиск"]') ||
            document.querySelector?.('.search-input_wrapper [placeholder="Поиск"]') ||
            document.querySelector?.('[placeholder="Поиск"]') ||
            document.querySelector?.('.header_search')
        );
        if (!searchTrigger) {
            console.log('[steampass] Element search trigger not found');
            return { error: 'Element search trigger not found' };
        }
        console.log('[steampass] Search trigger found, clicking');
        searchTrigger.click?.();
        await wait(1500);

        const modalInput = await waitForElement(() =>
            document.querySelector?.('#modal-search-input') ||
            document.querySelector?.('.search-bar_input') ||
            document.querySelector?.('.search-bar__input') ||
            document.querySelector?.('.modal-search input[type="text"]')
        );
        if (!modalInput) {
            console.log('[steampass] Element search input not found');
            return { error: 'Element search input not found' };
        }
        console.log('[steampass] Search input found, typing');
        log("Ввожу в поиск: " + searchTerm);
        modalInput.focus?.();
        await wait(500);
        modalInput.value = searchTerm;
        modalInput.dispatchEvent?.(new Event('input', { bubbles: true }));
        modalInput.dispatchEvent?.(new Event('keyup', { bubbles: true }));
        await wait(2500);

        const gameCards = [...(document.querySelectorAll?.('a.game-card') ?? [])].filter(a => a?.offsetParent);
        const gameLink = gameCards.find?.(a => a?.textContent?.toLowerCase?.().includes?.(searchTerm.toLowerCase().slice(0, 8))) || gameCards[0];
        if (!gameLink) {
            console.log('[steampass] Element game card not found');
            return { error: 'Element game card not found' };
        }
        console.log('[steampass] Game card found, clicking');
        gameLink.click?.();
        await wait(5000);

        let showDataBtn = await waitForElement(() =>
            document.querySelector?.('button.btn.btn-primary') ||
            [...(document.querySelectorAll?.('button') ?? [])].find(b => /показать данные/i.test(b?.textContent || ''))
        );
        if (!showDataBtn) {
            window.scrollTo?.(0, 500);
            await wait(1500);
            showDataBtn = await waitForElement(() =>
                document.querySelector?.('button.btn.btn-primary') ||
                [...(document.querySelectorAll?.('button') ?? [])].find(b => /показать данные/i.test(b?.textContent || ''))
            );
        }
        if (!showDataBtn) {
            console.log('[steampass] Element "Показать данные" button not found');
            return { error: 'Element "Показать данные" button not found' };
        }
        console.log('[steampass] Show data button found, clicking');
        showDataBtn.click?.();
        await wait(2000);

        const ackBtn = await waitForElement(() =>
            [...(document.querySelectorAll?.('button') ?? [])].find(b =>
                /я\s*ознакомился/i.test(b?.textContent || '') && (b?.classList?.contains?.('btn-primary') || b?.offsetParent)
            )
            , 3000);
        if (ackBtn) {
            console.log('[steampass] Модалка "Обратите внимание" — жму "Я ознакомился"');
            ackBtn.click?.();
            await wait(1500);
        }

        const modal = document.querySelector?.('.modal-overlay_search') || document.querySelector?.('[class*="modal"]') || document.querySelector?.('[role="dialog"]') || document.body;
        const allInputs = modal?.querySelectorAll?.('input') ?? [];
        let login = '', password = '';
        for (const i of allInputs) {
            if (i?.type === 'hidden') continue;
            const ctx = (i?.closest?.('div')?.textContent || '').toLowerCase();
            if (ctx?.includes?.('логин') && !login) login = i?.value || '';
            else if (ctx?.includes?.('пароль') && !password) password = i?.value || '';
        }
        if (!login || !password) {
            const visible = [...allInputs].filter(i => i?.type !== 'hidden' && i?.offsetParent);
            login = login || visible[0]?.value || '';
            password = password || visible[1]?.value || '';
        }
        if (!login || !password) {
            console.log('[steampass] Login/password not found in modal');
            return { error: 'Element login/password not found' };
        }
        console.log('[steampass] Data parsed, login:', login);
        log(`Данные получены: ${login}`);
        return { login, password };
    }

    // --- STEAMPASS_GET_2FA ---
    // Кнопка: "Получить код для авторизации" (btn btn-primary btn-outline). API отвечает 10–15 сек.
    const GET_2FA_WAIT_MS = 14000;

    async function get2FACode() {
        console.log('[steampass] GET_2FA start');
        while (document.visibilityState !== 'visible') { await wait(500); }

        const getCodeBtn = await waitForElement(() =>
            document.querySelector?.('button.btn.btn-primary.btn-outline') ||
            document.querySelector?.('button.btn-outline') ||
            [...(document.querySelectorAll?.('button') ?? [])].find(b =>
                /получить\s*код\s*для\s*авторизации/i.test(b?.textContent || '') ||
                /получить\s*(код|2fa)/i.test(b?.textContent || '') ||
                /код\s*для\s*авторизации/i.test(b?.textContent || '')
            )
        );
        if (!getCodeBtn) {
            console.log('[steampass] Element "Получить код для авторизации" not found');
            return { error: 'Element "Получить код для авторизации" not found' };
        }
        console.log('[steampass] 2FA button found, clicking (ждём до 14 сек — API медленный)');
        getCodeBtn.click?.();
        await wait(GET_2FA_WAIT_MS);

        const modal = document.querySelector?.('[class*="modal"]') || document.querySelector?.('[role="dialog"]') || document.body;

        // Check for spam limit block
        const limitWarning = [...(modal?.querySelectorAll?.('.alert, [class*="alert"], [class*="danger"], p, span, div') ?? [])]
            .map(el => el.textContent)
            .find(text => /спам-запрос|временное ограничение/i.test(text || ''));

        if (limitWarning) {
            console.log('[steampass] 🚨 Временное ограничение SteamPass detected!');
            return { error: limitWarning.trim() };
        }

        const is2FACode = (v) => v && v.length >= 4 && v.length <= 8 && /^[A-Z0-9]+$/i.test(v);
        const isLoginOrPass = (i) => {
            const ctx = (i?.closest?.('div')?.textContent || '').toLowerCase();
            return ctx?.includes?.('логин') || ctx?.includes?.('пароль');
        };

        let code = '';
        const allInputs = [...(modal?.querySelectorAll?.('input[type="text"], input:not([type="hidden"])') ?? [])];
        for (const i of allInputs) {
            if (isLoginOrPass(i)) continue;
            const v = (i?.value || '').trim();
            if (is2FACode(v)) { code = v; break; }
        }
        if (!code) {
            const labels = modal?.querySelectorAll?.('label, span, div') ?? [];
            for (const el of labels) {
                if (/код\s*авторизации/i.test(el?.textContent || '') && (el?.textContent?.length || 0) < 100) {
                    const container = el.closest?.('div') || el.parentElement;
                    const inp = container?.querySelector?.('input');
                    if (inp?.value) { code = inp.value.trim(); break; }
                    const m = (container?.textContent || '').match?.(/\b[A-Z0-9]{5}\b/i);
                    if (m) { code = m[0]; break; }
                }
            }
        }
        if (!code) code = modal?.textContent?.match?.(/\b[PQR][A-Z0-9]{4}\b/i)?.[0] || modal?.textContent?.match?.(/\b[A-Z0-9]{5}\b/i)?.[0] || '';
        if (!code) {
            const codeEl = modal?.querySelector?.('[class*="code"], [class*="2fa"]');
            if (codeEl) code = codeEl?.textContent?.trim?.().match?.(/\b[A-Z0-9]{5}\b/i)?.[0] || '';
        }
        if (!code) {
            console.log('[steampass] 2FA code not found');
            return { error: 'Element 2FA code not found' };
        }
        console.log('[steampass] 2FA code:', code);
        log(`Код 2FA: ${code}`);
        return { code };
    }
}
