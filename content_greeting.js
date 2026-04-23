// content_greeting.js — Playerok (deal page, chat)
{
const ELEMENT_TIMEOUT_MS = 5000;
const wait = (ms) => new Promise(r => setTimeout(r, ms));

/** Playerok часто рендерит CTA в fixed-слое: offsetParent === null, но кнопка видима */
function isProbablyVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    if (el.offsetParent !== null) return true;
    const r = el.getBoundingClientRect?.();
    if (r && r.width > 1 && r.height > 1) return true;
    try {
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
    } catch (_) {}
    return false;
}

async function waitForElement(getter, timeoutMs = ELEMENT_TIMEOUT_MS) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const el = getter();
        if (el && isProbablyVisible(el)) return el;
        await wait(300);
    }
    return null;
}

function log(msg) {
    try { chrome.runtime.sendMessage({ action: 'LOG', message: msg }).catch(() => {}); } catch (_) {}
}

function installPlayerokGreetingListener() {
    if (globalThis.__PLAYEROK_GREETING_LISTENER__) {
        console.log('[greeting] listener already registered — skip duplicate inject');
        return;
    }
    globalThis.__PLAYEROK_GREETING_LISTENER__ = true;
    chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (req.action === 'PING' || req.action === 'PING_GREETING') {
        sendResponse({ status: 'PONG', source: 'greeting' });
        return false;
    }
    if (req.action === 'SCAN_ORDERS') {
        sendResponse({ status: 'ok' });
        scanOrders().catch(e => log(`Ошибка сканирования: ${e.message}`));
        return false;
    }
    if (req.action === 'GET_PAGE_DATA') {
        getPageData(req.scrollFirst).then(res => sendResponse(res)).catch(e => sendResponse({ error: e.message }));
        return true;
    }
    if (req.action === 'OPEN_CHAT_AND_SEND') {
        openChatAndSend(req.text, req.buyerName, req.orderUrl).then(res => sendResponse(res)).catch(e => sendResponse({ error: e.message }));
        return true;
    }
    if (req.action === 'START_WATCH_2FA') {
        startWatch2FA(req.orderUrl || (window.location?.href?.split('?')[0]?.split('#')[0] || null));
        sendResponse({ ok: true });
        return false;
    }
    if (req.action === 'SEND_MESSAGE') {
        sendMessageToChat(req.text).then(res => sendResponse(res)).catch(e => sendResponse({ error: e.message }));
        return true;
    }
    if (req.action === 'CLICK_FULFILLED') {
        clickFulfilled().then(res => sendResponse(res)).catch(e => sendResponse({ error: e.message }));
        return true;
    }
    if (req.action === 'CHECK_CHAT_ALREADY_HANDLED') {
        checkChatAlreadyHandled().then(res => sendResponse(res)).catch(e => sendResponse({ error: e.message }));
        return true;
    }
    return false;
    });
}
installPlayerokGreetingListener();

// --- GET_PAGE_DATA ---
async function getPageData(scrollFirst = false) {
    console.log('[greeting] GET_PAGE_DATA start, scrollFirst:', scrollFirst);
    if (scrollFirst) {
        window.scrollTo(0, 0);
        await wait(300);
        window.scrollTo(0, document.body?.scrollHeight ?? 0);
        await wait(800);
        console.log('[greeting] Scroll done');
    }

    let username = null;
    const sellerUsername = await new Promise(r => chrome.storage.local.get(['playerokUsername'], d => r(d.playerokUsername || 'Morion21')));
    const profileLinks = document.querySelectorAll?.('a[href*="/profile/"]') ?? [];
    for (const a of profileLinks) {
        if (a?.href?.includes?.(sellerUsername)) continue;
        const t = a?.textContent?.trim?.();
        if (t && t.length > 2 && t.length < 50) { username = t; break; }
    }
    if (!username) {
        try {
            const res = document.evaluate?.("//*[contains(@class, 'user') or contains(@class, 'buyer')]//text()", document.body, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            if (res?.singleNodeValue) username = res.singleNodeValue.textContent?.trim?.();
        } catch (_) {}
    }
    console.log('[greeting] username:', username);

    const isValidGame = (txt) => txt && txt.length > 2 && txt.length < 150 && !/^\d+$/.test(txt) && !/^[a-z0-9_]{3,20}$/.test(txt);
    let gameTitle = null;
    const gameSelectors = [
        "//*[contains(@class, 'product') or contains(@class, 'title') or contains(@class, 'game')]//text()",
        "//h1//text()", "//h2//text()",
        "//*[contains(@class, 'deal')]//*[contains(@class, 'product') or contains(@class, 'title')]//text()",
        "//a[contains(@href,'/products/')]//text()"
    ];
    for (const sel of gameSelectors) {
        try {
            const res = document.evaluate?.(sel, document.body, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            const txt = res?.singleNodeValue?.textContent?.trim?.();
            if (isValidGame(txt)) { gameTitle = txt; break; }
        } catch (_) {}
    }
    if (!gameTitle && document?.title) {
        const t = document.title.replace(/\s*[-|–—]\s*Playerok.*$/i, '').replace(/^Playerok\s*[-|–—]\s*/i, '').trim();
        if (isValidGame(t)) gameTitle = t;
    }
    if (!gameTitle) {
        const productLinks = document.querySelectorAll?.('a[href*="/products/"], a[href*="/item/"]') ?? [];
        for (const a of productLinks) {
            const txt = a?.textContent?.trim?.();
            if (isValidGame(txt) && txt !== username) { gameTitle = txt; break; }
        }
    }
    console.log('[greeting] gameTitle:', gameTitle);
    return { username: username || '', gameTitle: gameTitle || '' };
}

// --- CHECK_CHAT_ALREADY_HANDLED ---
async function checkChatAlreadyHandled() {
    console.log('[greeting] CHECK_CHAT_ALREADY_HANDLED start');
    const chatPhrases = ['Чат', 'Chat', 'Написать', 'Сообщение'];
    let chatBtn = null;
    const orderScope = document.evaluate?.("//*[contains(., 'Выполните заказ')]", document.body, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null)?.singleNodeValue;
    const scope = orderScope || document.body;
    for (const phrase of chatPhrases) {
        try {
            const candidates = document.evaluate?.(`//button[contains(., '${phrase}')] | //a[contains(., '${phrase}')] | //*[@role='button'][contains(., '${phrase}')]`, scope, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            if (!candidates) continue;
            for (let i = 0; i < candidates.snapshotLength; i++) {
                const el = candidates.snapshotItem(i);
                if (el?.offsetParent && !el?.closest?.('nav') && !el?.closest?.('header') && !isInsideSupportContainer(el)) {
                    if (el?.href?.includes?.('/chats') && !el?.href?.includes?.('/chats/')) continue;
                    chatBtn = el;
                    break;
                }
            }
            if (chatBtn) break;
        } catch (_) {}
    }
    if (!chatBtn && orderScope) {
        const data = await getPageData(false);
        const username = data?.username;
        if (username) {
            const buyerEl = [...(orderScope.querySelectorAll?.('a, span, div') ?? [])].find(el => el?.textContent?.trim?.() === username);
            let p = buyerEl?.closest?.('div[class]') || buyerEl?.parentElement;
            for (let i = 0; i < 8 && p; i++) {
                const btn = [...(p?.querySelectorAll?.('button, a') ?? [])].find(b => /^Чат$|^Chat$/.test(b?.textContent?.trim?.() || ''));
                if (btn && !isInsideSupportContainer(btn)) { chatBtn = btn; break; }
                p = p?.parentElement;
            }
        }
    }
    chatBtn = await waitForElement(() => chatBtn);
    if (!chatBtn) return { status: 'ok' };
    chatBtn.click?.();
    await wait(4000);

    const sellerIndicators = /логин|пароль|здравствуйте|спасибо\s*за\s*покупку|бот-помощник|данные\s*для\s*аккаунта/i;
    const isSellerMessage = (el) => {
        if (!el || el.nodeType !== 1) return false;
        const cls = (el.className || '') + (el.getAttribute?.('class') || '');
        if (/own|me|sent|outgoing|self|sender|my-|out/.test(cls)) return true;
        const text = (el.textContent || '').trim();
        if (sellerIndicators.test(text) && text.length > 10) return true;
        return false;
    };

    const messages = document.querySelectorAll?.('[class*="message"], [class*="bubble"], [class*="msg"]') ?? [];
    for (const msg of messages) {
        if (isSellerMessage(msg)) {
            console.log('[greeting] Found seller message, already handled');
            return { status: 'ALREADY_HANDLED' };
        }
        const children = msg?.querySelectorAll?.('*') ?? [];
        for (const c of children) {
            if (isSellerMessage(c)) {
                console.log('[greeting] Found seller message in child, already handled');
                return { status: 'ALREADY_HANDLED' };
            }
        }
    }
    const allWithText = document.querySelectorAll?.('[class*="message"], [class*="bubble"], [class*="msg"], [class*="chat"] [class*="content"]') ?? [];
    for (const el of allWithText) {
        const text = el?.textContent || '';
        if (sellerIndicators.test(text) && text.length > 15) {
            const cls = (el.className || '') + (el.getAttribute?.('class') || '');
            if (/own|me|sent|outgoing|self/.test(cls)) {
                console.log('[greeting] Found seller content in message, already handled');
                return { status: 'ALREADY_HANDLED' };
            }
        }
    }
    console.log('[greeting] No seller messages found, ok to proceed');
    return { status: 'ok' };
}

function isInsideSupportContainer(el) {
    let p = el;
    while (p) {
        const cls = (p.className || '') + (p.id || '');
        if (/support|ticket|admin/i.test(cls)) return true;
        p = p.parentElement;
    }
    return false;
}

function getChatHeaderText() {
    const selectors = ['[class*="chat-header"]', '[class*="chat-title"]', '[class*="chat-name"]', '[class*="conversation-title"]', '[class*="recipient"]', '[class*="chat"] [class*="header"]'];
    for (const sel of selectors) {
        const el = document.querySelector?.(sel);
        if (el?.textContent?.trim?.()) return el.textContent.trim();
    }
    const header = document.querySelector?.('header') || document.querySelector?.('[class*="header"]');
    if (header?.textContent?.trim?.()) return header.textContent.trim();
    return document.querySelector?.('[class*="chat"], [class*="conversation"]')?.querySelector?.('[class*="title"], [class*="name"], h1, h2')?.textContent?.trim?.() || '';
}

function getAllHeaderCandidates() {
    const candidates = [];
    const chatArea = document.querySelector?.('[class*="chat"], [class*="conversation"]');
    for (const tag of ['h1', 'h2', 'h3', 'span']) {
        const els = (chatArea || document).querySelectorAll?.(tag) ?? [];
        for (const el of els) {
            const t = el?.textContent?.trim?.();
            if (t && t.length > 1 && t.length < 80) candidates.push(t);
        }
    }
    const selectors = ['[class*="chat-header"]', '[class*="chat-title"]', '[class*="chat-name"]'];
    for (const sel of selectors) {
        const el = document.querySelector?.(sel);
        if (el?.textContent?.trim?.()) candidates.push(el.textContent.trim());
    }
    return [...new Set(candidates)];
}

// --- Brute Force вставка и отправка (обходит React) ---
async function forceInsertAndSend(el, text) {
    if (!el) return false;
    el.focus();
    const doc = el.ownerDocument || document;
    doc.execCommand('selectAll', false, null);
    doc.execCommand('delete', false, null);
    doc.execCommand('insertText', false, text);
    ['input', 'change', 'blur', 'keyup'].forEach(ev => el.dispatchEvent?.(new Event(ev, { bubbles: true })));
    await wait(500);
    const container = el.closest?.('form') || el.parentElement;
    const root = el.ownerDocument || document;
    const sendBtn = container?.querySelector?.('button[type="submit"]') || container?.querySelector?.('button[class*="send"]') || container?.querySelector?.('button svg')?.closest?.('button') || container?.querySelector?.('svg')?.closest?.('button') || root.querySelector?.('button[class*="send"]') || root.querySelector?.('button[type="submit"]') || root.querySelector?.('svg')?.closest?.('button') || [...(root.querySelectorAll?.('button') ?? [])].find(b => b?.textContent?.includes?.('Отправ') || b?.querySelector?.('svg'));
    if (sendBtn && !sendBtn.disabled) {
        sendBtn.click();
        return true;
    }
    el.dispatchEvent?.(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    return true;
}

function getInputValue(el) {
    if (!el) return '';
    if (el.contentEditable === 'true') return (el.textContent || '').trim();
    return (el.value || '').trim();
}

// --- OPEN_CHAT_AND_SEND ---
function findMessageInput() {
    let el = document.querySelector?.('textarea') || document.querySelector?.('[contenteditable="true"]');
    if (!el) {
        for (const f of document.querySelectorAll?.('iframe') ?? []) {
            try {
                const doc = f?.contentDocument;
                if (doc) el = doc.querySelector?.('textarea') || doc.querySelector?.('[contenteditable="true"]');
                if (el) break;
            } catch (_) {}
        }
    }
    return el ?? null;
}

function getOrderContainer() {
    const byText = [...(document.querySelectorAll?.('*') ?? [])].find(el =>
        el?.textContent?.includes?.('Заказ #') || el?.textContent?.includes?.('Информация о заказе') || el?.textContent?.includes?.('Выполните заказ')
    );
    if (byText) return byText.closest?.('main') || byText.closest?.('[class*="order"]') || byText.closest?.('[class*="Order"]') || byText.closest?.('[class*="deal"]') || byText;
    return document.querySelector?.('main') || document.querySelector?.('.order-page') || document.querySelector?.('[class*="Order"]') || document.querySelector?.('[class*="order"]') || document.querySelector?.('[class*="deal"]');
}

function isSupportButton(el) {
    if (!el) return true;
    if (el?.href?.includes?.('support') || el?.href?.includes?.('ticket')) return true;
    const txt = (el?.textContent || '').trim().toLowerCase();
    if (/поддержка|support|помощь/i.test(txt)) return true;
    return false;
}

async function openChatAndSend(text, buyerName, orderUrl) {
    console.log('[greeting] OPEN_CHAT_AND_SEND start, buyerName:', buyerName, 'orderUrl:', orderUrl);
    const currentUrl = window.location?.href || '';
    const alreadyInChat = /\/chats\//.test(currentUrl) && !/support|ticket/i.test(currentUrl);
    if (alreadyInChat) console.log('[greeting] Уже в чате (/chats/), пропускаю кнопку Чат');

    let chatBtn = null;
    if (!alreadyInChat) {
        const orderContainer = getOrderContainer();
        if (!orderContainer) {
            console.log('[greeting] Order container not found');
            return { error: 'Order container not found' };
        }
        const chatPhrases = ['Чат', 'Chat', 'Написать', 'Сообщение'];
    for (const phrase of chatPhrases) {
        try {
            const candidates = orderContainer.querySelectorAll?.(`button, a[href], [role="button"]`) ?? [];
            for (const el of candidates) {
                if (!el?.textContent?.includes?.(phrase)) continue;
                if (!el?.offsetParent) continue;
                if (isSupportButton(el)) continue;
                if (el?.closest?.('nav') || el?.closest?.('header')) continue;
                if (el?.href?.includes?.('/chats') && !el?.href?.includes?.('/chats/')) continue;
                chatBtn = el;
                break;
            }
            if (chatBtn) break;
        } catch (_) {}
    }
    if (!chatBtn) {
        const data = await getPageData(false);
        const username = data?.username;
        if (username) {
            const buyerEl = [...(orderContainer.querySelectorAll?.('a, span, div') ?? [])].find(el => el?.textContent?.trim?.() === username);
            let p = buyerEl?.closest?.('div[class]') || buyerEl?.parentElement;
            for (let i = 0; i < 8 && p; i++) {
                if (!orderContainer.contains?.(p)) break;
                const btn = [...(p?.querySelectorAll?.('button, a') ?? [])].find(b => /^Чат$|^Chat$/.test(b?.textContent?.trim?.() || ''));
                if (btn && !isSupportButton(btn)) { chatBtn = btn; break; }
                p = p?.parentElement;
            }
        }
    }
        chatBtn = await waitForElement(() => chatBtn);
        if (!chatBtn) {
            console.log('[greeting] Element Chat button not found');
            return { error: 'Element Chat button not found' };
        }
        console.log('[greeting] Chat button found, clicking');
        chatBtn.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
        await wait(800);
        chatBtn.click();
        await wait(5000);
    } else {
        await wait(1500);
    }

    const urlAfter = window.location?.href || '';
    if (/support|ticket/i.test(urlAfter)) {
        log("🚨 Внимание! Попытка отправить данные в поддержку заблокирована.");
        return { error: 'Это чат поддержки, а не покупателя' };
    }

    const normalize = (s) => (String(s || '').toLowerCase().replace(/[^a-zа-я0-9]/g, '')).trim();
    const headerCandidates = [getChatHeaderText(), ...getAllHeaderCandidates()].filter(Boolean);
    let detectedName = '';
    let nameMatch = false;
    const maxAttempts = 3;
    for (let i = 0; i < Math.min(maxAttempts, headerCandidates.length) && !nameMatch; i++) {
        detectedName = headerCandidates[i].replace(/\s*чат\s*с\s*/i, '').replace(/\s*chat\s*with\s*/i, '').replace(/\s*[-–—|•].*$/, '').trim();
        if (detectedName.includes('Поддержка') || detectedName.includes('Support')) {
            log("🚨 STOP: Support Chat detected");
            return { error: 'STOP: Support Chat detected' };
        }
        if (buyerName) {
            const nm = normalize(detectedName).includes(normalize(buyerName)) || normalize(buyerName).includes(normalize(detectedName));
            log(`Проверка: [${buyerName}] vs [${detectedName}] -> ${nm ? 'OK' : 'FAIL'}`);
            if (nm) nameMatch = true;
        } else {
            nameMatch = true;
        }
    }
    if (buyerName && !nameMatch) {
        log("🚨 ВНИМАНИЕ: Имя в чате [" + detectedName + "] странное, но я попробую отправить, если это не Поддержка.");
        if (detectedName.includes('Поддержка') || detectedName.includes('Support')) {
            return { error: 'STOP: Support Chat detected' };
        }
    }
    const supportKeywords = /поддержка|support|playerok|администрация/i;
    if (supportKeywords.test(detectedName || headerCandidates[0] || '')) {
        log("🚨 Внимание! Попытка отправить данные в поддержку заблокирована.");
        return { error: 'Это чат поддержки, а не покупателя' };
    }

    const messageInput = await waitForElement(findMessageInput);
    if (!messageInput) {
        console.log('[greeting] Element message input not found');
        return { error: 'Element message input not found' };
    }
    console.log('[greeting] Input found, forceInsertAndSend');
    await wait(200);
    await forceInsertAndSend(messageInput, text);
    await wait(2000);
    const stillHasText = getInputValue(messageInput).length > 0;
    if (stillHasText) {
        console.log('[greeting] Input not cleared after send — отправка не сработала');
        return { error: 'Failed to clear input after send' };
    }
    console.log('[greeting] Message sent');
    return { ok: true };
}

// --- SEND_MESSAGE ---
async function sendMessageToChat(text) {
    console.log('[greeting] SEND_MESSAGE start');
    const messageInput = await waitForElement(findMessageInput);
    if (!messageInput) return { error: 'Element message input not found' };
    await wait(200);
    await forceInsertAndSend(messageInput, text);
    await wait(2000);
    const stillHasText = getInputValue(messageInput).length > 0;
    if (stillHasText) {
        console.log('[greeting] SEND_MESSAGE: input not cleared after send');
        return { error: 'Failed to clear input after send' };
    }
    console.log('[greeting] SEND_MESSAGE done');
    return { ok: true };
}

// --- CLICK_FULFILLED ---
function normTxt(s) {
    return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function dispatchFullClick(el) {
    if (!el) return;
    try {
        el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    } catch (_) {}
    try {
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, view: window }));
    } catch (_) {}
    if (typeof el.click === 'function') el.click();
}

/** Shadow-aware: узлы внутри shadow не считаются потомками для Element.contains. */
function deepContains(ancestor, el) {
    let n = el;
    for (let i = 0; i < 50 && n; i++) {
        if (n === ancestor) return true;
        if (n instanceof ShadowRoot) {
            n = n.host;
            continue;
        }
        n = n.parentNode;
    }
    return false;
}

function forEachElementDeep(root, fn) {
    if (!root || root.nodeType !== 1) return;
    fn(root);
    if (root.shadowRoot) {
        for (const c of root.shadowRoot.children) {
            forEachElementDeep(c, fn);
        }
    }
    for (const c of root.children || []) {
        forEachElementDeep(c, fn);
    }
}

function walkTextNodesDeep(root, fn) {
    if (!root) return;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) fn(n);
    const visit = (el) => {
        if (!el || el.nodeType !== 1) return;
        if (el.shadowRoot) walkTextNodesDeep(el.shadowRoot, fn);
        for (const c of el.children || []) visit(c);
    };
    visit(root);
}

function dispatchSpaceKey(el) {
    if (!el) return;
    try {
        el.focus?.();
    } catch (_) {}
    try {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true, cancelable: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true, cancelable: true }));
    } catch (_) {}
}

function isModalConsentChecked(modal) {
    let ok = false;
    forEachElementDeep(modal, (el) => {
        if (ok) return;
        if (el.tagName === 'INPUT' && el.type === 'checkbox' && el.checked) ok = true;
        const role = el.getAttribute?.('role');
        if (role === 'checkbox' && el.getAttribute?.('aria-checked') === 'true') ok = true;
        if (role === 'switch' && el.getAttribute?.('aria-checked') === 'true') ok = true;
    });
    return ok;
}

function modalContainsPhraseDeep(root, re) {
    let ok = false;
    walkTextNodesDeep(root, (tn) => {
        if (ok) return;
        if (re.test(tn.textContent || '')) ok = true;
    });
    return ok;
}

function clickConsentViaCoordinates(modal, confirmPhrase) {
    let done = false;
    walkTextNodesDeep(modal, (textNode) => {
        if (done) return;
        if (!confirmPhrase.test(textNode.textContent || '')) return;
        const parent = textNode.parentElement;
        if (!parent) return;
        const r = parent.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return;
        const y = r.top + r.height / 2;
        for (const dx of [8, 14, 22, 32, 44, 58, 76, 100, 130]) {
            const x = r.left - dx;
            const hit = document.elementFromPoint(x, y);
            if (hit && deepContains(modal, hit)) {
                dispatchFullClick(hit);
                log('CLICK_FULFILLED: hit-testing слева от текста согласия');
                done = true;
                return;
            }
        }
    });
    return done;
}

async function clickFulfilled() {
    console.log('[greeting] CLICK_FULFILLED start, url:', location.href);
    log('CLICK_FULFILLED: ищу кнопку на странице сделки…');
    const needles = ['я выполнил', 'я выполнила', 'выполнено', 'я выполнил заказ', 'подтвердить выполнение', 'подтвердить'];
    const findBtn = () => {
        const candidates = document.querySelectorAll?.('button, a[href], [role="button"], input[type="button"], input[type="submit"]') ?? [];
        for (const el of candidates) {
            if (!isProbablyVisible(el)) continue;
            const t = normTxt(el.textContent || el.value || '');
            const aria = normTxt(el.getAttribute?.('aria-label') || el.title || '');
            if (!t && !aria) continue;
            for (const n of needles) {
                if (t === n || t.includes(n) || aria === n || aria.includes(n)) {
                    const dis = el.disabled === true || el.getAttribute?.('aria-disabled') === 'true';
                    if (dis) continue;
                    return el;
                }
            }
        }
        return null;
    };
    const btn = await waitForElement(findBtn, 14000);
    if (!btn) {
        const snippet = (document.body?.innerText || '').slice(0, 400).replace(/\s+/g, ' ');
        console.log('[greeting] "Я выполнил" not found, body preview:', snippet);
        log('CLICK_FULFILLED: кнопка не найдена (возможно не страница сделки или уже ждёт подтверждения покупателя)');
        return { error: 'Element "Я выполнил" button not found' };
    }
    console.log('[greeting] CTA found, label:', (btn.textContent || btn.value || '').slice(0, 80));

    const findModal = () => {
        const modal = document.querySelector?.('[role="dialog"]') || document.querySelector?.('.modal') || document.querySelector?.('[class*="modal"]') || document.querySelector?.('[class*="Modal"]');
        if (modal && isProbablyVisible(modal)) return modal;
        const byTitle = [...(document.querySelectorAll?.('[role="dialog"], [class*="modal" i], [class*="Modal"] *') ?? [])].find(el => /заказ\s*выполнен\?|заказ\s*выполнен|подтверждени[ея]\s*выполнен/i.test(el?.textContent || ''));
        return byTitle?.closest?.('[class*="modal"], [class*="Modal"], [role="dialog"]') || byTitle || null;
    };

    const confirmPhrase = /я\s*подтверждаю\s+выполнение|подтверждаю\s+выполнение\s+заказа|подтверждаю\s+выполнение|выполнени[ея]\s+заказа/i;

    let modal = findModal();
    if (modal && modalContainsPhraseDeep(modal, confirmPhrase)) {
        log('CLICK_FULFILLED: модалка подтверждения уже открыта — не жму «Я выполнил» повторно');
        await wait(400);
    } else {
        log(`CLICK_FULFILLED: нажимаю «${(btn.textContent || btn.value || '').trim().slice(0, 40)}»`);
        dispatchFullClick(btn);
        await wait(1500);
        modal = await waitForElement(findModal, 9000);
    }

    if (!modal) {
        console.log('[greeting] No confirm modal (maybe one-step UI)');
        log('CLICK_FULFILLED: модалка не появилась — возможно одношаговое подтверждение');
        return { ok: true };
    }

    function tryCheckModalConsentDeep(root) {
        let acted = false;
        const inputs = [];
        const roleBoxes = [];
        forEachElementDeep(root, (el) => {
            if (el.tagName === 'INPUT' && el.type === 'checkbox') inputs.push(el);
            const role = el.getAttribute?.('role');
            if (role === 'checkbox' || role === 'switch') roleBoxes.push(el);
            const ds = el.getAttribute?.('data-state');
            if ((role === 'checkbox' || el.tagName === 'BUTTON') && ds === 'unchecked') {
                dispatchFullClick(el);
                acted = true;
            }
        });
        for (const inp of inputs) {
            if (!inp.checked) {
                try {
                    inp.focus?.();
                } catch (_) {}
                dispatchFullClick(inp);
                try {
                    const proto = window.HTMLInputElement?.prototype;
                    const desc = proto && Object.getOwnPropertyDescriptor(proto, 'checked');
                    if (desc?.set) desc.set.call(inp, true);
                    inp.dispatchEvent(new Event('input', { bubbles: true }));
                    inp.dispatchEvent(new Event('change', { bubbles: true }));
                } catch (_) {}
                dispatchSpaceKey(inp);
                acted = true;
            }
        }
        for (const el of roleBoxes) {
            const ac = el.getAttribute?.('aria-checked');
            if (ac === 'true') continue;
            dispatchFullClick(el);
            dispatchSpaceKey(el);
            acted = true;
        }
        let lab = null;
        forEachElementDeep(root, (el) => {
            if (lab) return;
            if (el.tagName === 'LABEL' && confirmPhrase.test(el.textContent || '')) lab = el;
        });
        if (lab) {
            let inner = null;
            forEachElementDeep(lab, (el) => {
                if (inner) return;
                if (el.tagName === 'INPUT' && el.type === 'checkbox') inner = el;
            });
            if (inner && !inner.checked) {
                dispatchFullClick(inner);
                dispatchSpaceKey(inner);
            } else {
                dispatchFullClick(lab);
            }
            acted = true;
        }
        let textHit = null;
        let textHitLen = 9999;
        forEachElementDeep(root, (el) => {
            const tag = el.tagName;
            if (!['SPAN', 'DIV', 'P', 'LABEL'].includes(tag)) return;
            const tx = el.textContent || '';
            if (!confirmPhrase.test(tx) || tx.length >= 160) return;
            if (tx.length < textHitLen) {
                textHitLen = tx.length;
                textHit = el;
            }
        });
        if (textHit) {
            let rowClicked = false;
            let row = textHit;
            for (let i = 0; i < 10 && row; i++) {
                const r = row.getAttribute?.('role');
                if (r === 'button' || r === 'checkbox' || row.tagName === 'BUTTON' || row.tagName === 'LABEL') {
                    dispatchFullClick(row);
                    rowClicked = true;
                    acted = true;
                    break;
                }
                row = row.parentElement;
            }
            const near =
                textHit.closest?.('label')?.querySelector?.('input[type="checkbox"]') ||
                textHit.parentElement?.querySelector?.('input[type="checkbox"]');
            if (near && !near.checked) {
                dispatchFullClick(near);
                dispatchSpaceKey(near);
                acted = true;
            } else if (!rowClicked) {
                dispatchFullClick(textHit);
                acted = true;
            }
        }
        if (clickConsentViaCoordinates(root, confirmPhrase)) acted = true;
        return acted;
    }

    for (let attempt = 0; attempt < 5; attempt++) {
        if (isModalConsentChecked(modal)) break;
        tryCheckModalConsentDeep(modal);
        await wait(450);
        if (isModalConsentChecked(modal)) break;
        await wait(350);
    }
    if (!isModalConsentChecked(modal)) {
        log('CLICK_FULFILLED: состояние галочки не определено как «вкл» — всё равно жму «Подтвердить» если станет активной');
    }

    const findConfirmBtn = () => {
        let found = null;
        forEachElementDeep(modal, (el) => {
            if (found) return;
            const tag = el.tagName;
            const rb = el.getAttribute?.('role');
            if (tag !== 'BUTTON' && rb !== 'button' && !(tag === 'INPUT' && el.type === 'submit')) return;
            if (!isProbablyVisible(el)) return;
            const t = normTxt(el.textContent || el.value);
            if (!/^подтвердить$/i.test(t)) return;
            const dis = el.disabled === true || el.getAttribute?.('aria-disabled') === 'true';
            if (dis) return;
            found = el;
        });
        return found;
    };

    let confirmBtn = await waitForElement(findConfirmBtn, 6000);
    if (!confirmBtn) {
        tryCheckModalConsent(modal);
        await wait(700);
        confirmBtn = await waitForElement(findConfirmBtn, 4000);
    }
    if (confirmBtn) {
        dispatchFullClick(confirmBtn);
        console.log('[greeting] Modal confirmed');
        log('CLICK_FULFILLED: галочка и «Подтвердить» обработаны');
    } else {
        log('CLICK_FULFILLED: «Подтвердить» не найдена или не активна после галочки — проверьте модалку вручную');
        return { error: 'Confirm button disabled or not found after checkbox' };
    }
    return { ok: true };
}

// --- START_WATCH_2FA ---
function startWatch2FA(orderUrl) {
    if (window._watch2FAObserver) return;
    const url = orderUrl || (window.location?.href?.split?.('?')[0]?.split?.('#')[0] || null);
    console.log('[greeting] START_WATCH_2FA, orderUrl:', url);

    const re2fa = /\b2fa\b|2фа|код|дайте\s*код|пришли\s*код|скинь\s*код/i;
    const seen = new Set();
    const input = findMessageInput();
    if (!input) { console.log('[greeting] No input for 2FA watch'); return; }

    const sidebar = document.querySelector?.('[class*="sidebar"], [class*="threads"], [class*="chat-list"], [class*="conversation-list"]');
    let chatArea = input.closest?.('[class*="message-list"], [class*="messages"], [class*="chat-body"], [class*="chat-content"]') || input.closest?.('[class*="chat"], [class*="conversation"], [class*="panel"]');
    if (!chatArea || (sidebar?.contains?.(chatArea))) chatArea = input.closest?.('[class*="chat"], [class*="messages"], [class*="panel"]') || document.body;
    if (sidebar && chatArea?.contains?.(sidebar)) chatArea = document.querySelector?.('[class*="message-list"], [class*="messages"]') || input.parentElement?.closest?.('[class*="chat"]') || input.parentElement;
    const root = chatArea || document.body;

    const isIncomingMessage = (msgEl) => {
        let el = msgEl;
        for (let i = 0; i < 5 && el; i++) {
            const cls = (el.className || '') + (el.getAttribute?.('class') || '');
            if (/own|me|sent|outgoing|self|sender|my-|out/.test(cls)) return false;
            if (/incoming|received|from-user|other|buyer/.test(cls)) return true;
            el = el.parentElement;
        }
        return true;
    };

    const checkElement = (el) => {
        if (!el || el.nodeType !== 1) return false;
        if (!re2fa.test(el.textContent || '')) return false;
        const msgEl = el.closest?.('[class*="message"], [class*="bubble"], [class*="msg"]') || el;
        if (!root?.contains?.(msgEl)) return false;
        if (sidebar?.contains?.(msgEl)) return false;
        const key = msgEl.textContent?.slice?.(0, 80) || '';
        if (seen.has(key)) return false;
        seen.add(key);
        if (!isIncomingMessage(msgEl)) return false;
        const text = (msgEl.textContent || '').trim();
        if (/логин|пароль|напишите|покупку|бот-помощник|спасибо|здравствуйте|данные\s+для|код\s+временно|подожди\s+3\s+минуты|steam\s*guard/i.test(text)) return false;
        if (text.length > 50) return false;
        console.log('[greeting] 2FA detected, sending WAIT_FOR_2FA_DETECTED');
        chrome.runtime.sendMessage({ action: 'WAIT_FOR_2FA_DETECTED', orderUrl: url });
        if (window._watch2FAObserver) { window._watch2FAObserver.disconnect(); window._watch2FAObserver = null; }
        return true;
    };

    const scanLastMessages = () => {
        const msgs = [...(root.querySelectorAll?.('[class*="message"], [class*="bubble"], [class*="msg"]') ?? [])];
        const lastMsgs = msgs.slice(-10);
        for (const m of lastMsgs) {
            if (checkElement(m)) return true;
        }
        return false;
    };
    if (scanLastMessages()) return;

    const obs = new MutationObserver((mutations) => {
        for (const m of mutations) {
            m.addedNodes?.forEach?.(n => {
                if (n?.nodeType === 1) {
                    if (re2fa.test(n.textContent || '')) checkElement(n);
                    try { n.querySelectorAll?.('*')?.forEach?.(checkElement); } catch (_) {}
                }
            });
        }
    });
    obs.observe(root, { childList: true, subtree: true, characterData: true });
    window._watch2FAObserver = obs;
    const scanExisting = () => {
        try {
            const msgs = root.querySelectorAll?.('[class*="message"], [class*="bubble"], [class*="msg"]') ?? [];
            msgs.forEach(m => checkElement(m));
        } catch (_) {}
    };
    scanExisting();
    const intervalId = setInterval(scanExisting, 2500);
    const origDisconnect = obs.disconnect.bind(obs);
    obs.disconnect = () => { clearInterval(intervalId); origDisconnect(); };
}

// --- SCAN_ORDERS ---
async function scanOrders() {
    console.log('[greeting] SCAN_ORDERS start');
    log("🔍 Сканирую страницу заказов...");
    await wait(2000);
    const orderUrls = [];
    const seen = new Set();

    const addLink = (link) => {
        if (!link?.href?.includes?.('playerok.com')) return;
        const h = link.href.split('?')[0].split('#')[0];
        if (seen.has(h)) return;
        if (h.includes('/deal/') || h.includes('/sales/') || /\/profile\/[^/]+\/sales\//.test(h)) { seen.add(h); orderUrls.push(link.href); }
    };

    const addFromElement = (el) => {
        if (el?.tagName === 'A' && el.href) addLink(el);
        else {
            const a = el?.closest?.('a') || el?.querySelector?.('a[href*="deal"], a[href*="sales"], a[href*="order"]');
            if (a?.href) addLink(a);
        }
    };

    const findByText = (txt) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, null, false);
        let node;
        while (node = walker.nextNode()) {
            if (node.nodeType === 3 && node.textContent?.includes?.(txt)) addFromElement(node.parentElement);
            else if (node.textContent?.trim?.().includes?.(txt)) addFromElement(node);
        }
    };

    try { findByText('Выполните заказ'); } catch (_) {}
    try {
        const r = document.evaluate?.("//a[contains(., 'Выполните заказ')]", document.body, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        if (r) for (let i = 0; i < r.snapshotLength; i++) addLink(r.snapshotItem(i));
    } catch (_) {}

    document.querySelectorAll?.('a[href*="deal"], a[href*="sales"], a[href*="order"]')?.forEach?.(addLink);
    window.scrollTo(0, 0);
    await wait(500);
    window.scrollTo(0, document.body?.scrollHeight ?? 0);
    await wait(1200);
    if (orderUrls.length === 0) { findByText('Выполните заказ'); document.querySelectorAll?.('a[href*="deal"], a[href*="sales"], a[href*="order"]')?.forEach?.(addLink); }

    console.log('[greeting] SCAN_ORDERS found:', orderUrls.length);
    log(`📦 Найдено заказов: ${orderUrls.length}`);
    chrome.runtime.sendMessage({ action: 'FOUND_ORDERS', orders: orderUrls });
}
}