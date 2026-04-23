'use strict';

/**
 * Разбор строки списка игр: несколько форматов в одном поле.
 * 1) «Название - login: u pass: p» (или — | логин/пароль, pass/password)
 * 2) «Название login: u pass: p» (без дефиса перед login)
 * 3) Вставка из Excel: «название<TAB>логин<TAB>пароль»
 * 4) «название;логин;пароль»
 * Иначе — целиком считается названием игры (как раньше).
 */
function parsePublisherGameRow(line) {
    const s = String(line || '').trim();
    if (!s) return { name: '' };

    const RE_DIV = '[-|\\u2013|\\u2014]';
    const RE_LOGIN = '(?:логин|login)';
    const RE_PASS = '(?:пароль|pass|password)';

    const withDash = new RegExp(
        '^(.+?)\\s*' + RE_DIV + '\\s*' + RE_LOGIN + '\\s*:\\s*(.+?)\\s+' + RE_PASS + '\\s*:\\s*(.+)$',
        'iu'
    );
    let m = s.match(withDash);
    if (m) {
        return { name: m[1].trim(), itemLogin: m[2].trim(), itemPassword: m[3].trim() };
    }

    const spaced = new RegExp(
        '^(.+?)\\s+' + RE_LOGIN + '\\s*:\\s*(.+?)\\s+' + RE_PASS + '\\s*:\\s*(.+)$',
        'iu'
    );
    m = s.match(spaced);
    if (m) {
        const title = m[1].trim().replace(new RegExp('\\s*' + RE_DIV + '\\s*$', 'iu'), '');
        return { name: title, itemLogin: m[2].trim(), itemPassword: m[3].trim() };
    }

    if (s.includes('\t')) {
        const parts = s.split(/\t+/).map(p => p.trim()).filter(p => p.length > 0);
        if (parts.length >= 3) {
            return { name: parts[0], itemLogin: parts[1], itemPassword: parts[2] };
        }
    }

    const semi = s.split(';').map(p => p.trim());
    if (semi.length === 3 && semi.every(p => p.length > 0)) {
        return { name: semi[0], itemLogin: semi[1], itemPassword: semi[2] };
    }

    return { name: s };
}

function publisherRowToGameEntry(parsed) {
    if (!parsed || !parsed.name) return null;
    if (parsed.itemLogin != null && parsed.itemPassword != null
        && String(parsed.itemLogin).length > 0 && String(parsed.itemPassword).length > 0) {
        return {
            name: parsed.name,
            itemLogin: String(parsed.itemLogin),
            itemPassword: String(parsed.itemPassword)
        };
    }
    return parsed.name;
}

/** Должен совпадать с background.js → normalizePublisherLocalCardKey (сопоставление файла и игры). */
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

function localCardFileStemMatchesGameName(fileStem, gameName) {
    const normFile = normalizePublisherLocalCardKey(fileStem);
    const normGame = normalizePublisherLocalCardKey(gameName);
    if (!normFile || !normGame) return false;
    if (normFile === normGame) return true;
    const cf = normFile.replace(/\s/g, '');
    const cg = normGame.replace(/\s/g, '');
    return cf.length >= 4 && cf === cg;
}

function localCardFileStemMatchesAnyGame(fileStem, games) {
    for (const ge of games) {
        const n = (typeof ge === 'object' && ge && ge.name != null) ? String(ge.name) : String(ge ?? '');
        if (n && localCardFileStemMatchesGameName(fileStem, n)) return true;
    }
    return false;
}

/**
 * Только те файлы, что подходят под список игр; значения — File (без чтения в RAM).
 * В background читается по одному при публикации лота.
 */
function buildLocalCardFilesByStem(fileList, gamesFilter) {
    const files = [...fileList].filter(f => /\.(png|jpe?g|webp)$/i.test(f.name));
    if (!files.length) return {};
    const useFilter = Array.isArray(gamesFilter) && gamesFilter.length > 0;
    const map = {};
    for (const f of files) {
        const path = f.webkitRelativePath || f.name;
        const base = path.replace(/^.*[/\\]/, '') || f.name;
        const stem = base.replace(/\.[^.]+$/i, '').trim();
        if (!stem) continue;
        if (useFilter && !localCardFileStemMatchesAnyGame(stem, gamesFilter)) continue;
        map[stem] = f;
    }
    return map;
}

document.addEventListener('DOMContentLoaded', () => {
    const gamesListInput = document.getElementById('gamesList');
    const nameTemplateInput = document.getElementById('nameTemplate');
    const commentTemplateInput = document.getElementById('commentTemplate');
    const descTemplateInput = document.getElementById('descTemplate');
    const sourceToggle = { value: 'steampass' }; // Режим работы жёстко = steampass
    const actionDelayInput = document.getElementById('actionDelay');
    const publishDelayInput = document.getElementById('publishDelay');
    const priceInput = document.getElementById('priceInput');
    const duplicateCountInput = document.getElementById('duplicateCount');
    const copyPricesList = document.getElementById('copyPricesList');
    const duplicateModeBtn = document.getElementById('duplicateModeBtn');
    const singlePriceBlock = document.getElementById('singlePriceBlock');
    const rangePriceBlock = document.getElementById('rangePriceBlock');
    const publisherCategoryBlock = document.getElementById('publisherCategoryBlock');
    const smartDupRow = document.getElementById('smartDupRow');
    const smartDuplicateCheckbox = document.getElementById('smartDuplicateCheckbox');

    const startBtn = document.getElementById('startBtn');
    const pauseBtn = document.getElementById('pauseBtn');
    const stopBtn = document.getElementById('stopBtn');
    const pauseStatus = document.getElementById('pauseStatus');

    /** true — процесс на паузе, ждёт Resume */
    let isPaused = false;

    function setPausedUI(remaining) {
        isPaused = true;
        startBtn.disabled = true;
        pauseBtn.disabled = false;
        pauseBtn.textContent = '▶️ Продолжить';
        pauseBtn.className = 'btn resume';
        stopBtn.disabled = false;
        if (pauseStatus) {
            pauseStatus.style.display = 'block';
            pauseStatus.textContent = `⏸️ На паузе. Осталось игр: ${remaining}. Нажмите «Продолжить» или «Остановить».`;
        }
    }

    function setRunningUI() {
        isPaused = false;
        startBtn.disabled = true;
        pauseBtn.disabled = false;
        pauseBtn.textContent = '⏸️ Пауза';
        pauseBtn.className = 'btn pause';
        stopBtn.disabled = false;
        if (pauseStatus) pauseStatus.style.display = 'none';
    }

    function setIdleUI() {
        isPaused = false;
        startBtn.disabled = false;
        pauseBtn.disabled = true;
        pauseBtn.textContent = '⏸️ Пауза';
        pauseBtn.className = 'btn pause';
        stopBtn.disabled = true;
        if (pauseStatus) pauseStatus.style.display = 'none';
    }

    const logsDiv = document.getElementById('logs');
    const outputContainer = document.getElementById('outputContainer');

    const progressBar = document.getElementById('progressBar');
    const progressText = document.getElementById('progressText');

    let duplicateMode = false;
    /** Цикл категорий по 3 копии: по игре → Steam → другие игры (только при включённом дублировании). */
    let smartDuplicateMode = false;
    let discountMode = false;
    let saveDraft = false;
    let useCatalog = false;
    let strictGameSearch = false;
    /** 'auto' | 'steam' | 'other_games' — один активный режим каталога Playerok. */
    let accountCategoryPlatform = 'auto';

    /** Ключ подкатегории в разделе Steam (см. background STEAM_LOT_CATEGORY_LABELS). */
    const STEAM_LOT_CATEGORY_OPTIONS = [
        { key: 'steam_topup', label: '🚫 Пополнение баланса' },
        { key: 'steam_games', label: '🚫 Игры' },
        { key: 'steam_accounts_with_games', label: '✅ Аккаунты с играми' },
        { key: 'steam_region_change', label: '🚫 Смена региона' },
        { key: 'steam_clean_accounts', label: '🚫 Чистые аккаунты' },
        { key: 'steam_services', label: '🚫 Услуги' },
        { key: 'steam_items', label: '🚫 Предметы' },
        { key: 'steam_other', label: '🚫 Другое' },
        { key: 'steam_awards', label: '🚫 Награды Steam' },
        { key: 'steam_rent', label: '🚫 Аренда' }
    ];

    /** Подкатегория на странице выбранной игры (background GAME_PAGE_LOT_CATEGORY_LABELS). */
    const GAME_PAGE_LOT_CATEGORY_OPTIONS = [
        { key: 'game_page_keys', label: '🚫 Ключи' },
        { key: 'game_page_accounts', label: '✅ Аккаунты' },
        { key: 'game_page_rent', label: '🚫 Аренда' },
        { key: 'game_page_other', label: '🚫 Другое' },
        { key: 'game_page_services', label: '🚫 Услуги' }
    ];

    /** Плитка «Другие игры» (ключи → background otherGamesPickKeyToGamePageKey). */
    const OTHER_GAMES_LOT_CATEGORY_OPTIONS = [
        { key: 'other_games_keys', label: '🚫 Ключи' },
        { key: 'other_games_accounts', label: '✅ Аккаунты' },
        { key: 'other_games_rent', label: '🚫 Аренда' },
        { key: 'other_games_other', label: '🚫 Другое' },
        { key: 'other_games_services', label: '🚫 Услуги' }
    ];

    /** По игре / Steam: три ключа = background STEAM_ACCOUNTS_OBTAINING_KEYS. */
    const STEAM_ACCOUNTS_OBTAINING_OPTIONS = [
        { key: 'steam_obt_full', label: '🚫 Полный доступ' },
        { key: 'steam_obt_shared_offline', label: '✅ Офлайн' },
        { key: 'steam_obt_autoreg', label: '🚫 Авторег' }
    ];

    /** «Другие игры» → Аккаунты: как на Playerok, только два пункта. */
    const OTHER_GAMES_OBTAINING_OPTIONS = [
        { key: 'steam_obt_full', label: '🚫 Полный доступ' },
        { key: 'steam_obt_shared_offline', label: '✅ Офлайн аккаунт' }
    ];

    /** Steam → «Аккаунты с играми», ключи = background STEAM_ACCOUNT_TYPE_KEYS. */
    const STEAM_ACCOUNT_TYPE_OPTIONS = [
        { key: 'steam_acct_empty', label: 'Пустой аккаунт' },
        { key: 'steam_acct_progress', label: 'С прогрессом' }
    ];

    /** Ключи совпадают с background STEAM_ACCOUNT_COUNTRY_META. */
    const STEAM_ACCOUNT_COUNTRY_OPTIONS = [
        { key: 'ru', label: 'Россия' },
        { key: 'kz', label: 'Казахстан' },
        { key: 'tr', label: 'Турция' },
        { key: 'us', label: 'США' },
        { key: 'pl', label: 'Польша' },
        { key: 'ar', label: 'Аргентина' },
        { key: 'bg', label: 'Болгария' },
        { key: 'hu', label: 'Венгрия' },
        { key: 'vn', label: 'Вьетнам' },
        { key: 'de', label: 'Германия' },
        { key: 'id', label: 'Индонезия' },
        { key: 'es', label: 'Испания' },
        { key: 'cn', label: 'Китай' },
        { key: 'ro', label: 'Румыния' },
        { key: 'sk', label: 'Словакия' },
        { key: 'fr', label: 'Франция' },
        { key: 'cz', label: 'Чехия' },
        { key: 'ee', label: 'Эстония' },
        { key: 'other', label: 'Другое' }
    ];

    let catalogGames = []; // { name, id, banner }

    const gamesListBlock = document.getElementById('gamesListBlock');
    const gamesCatalogBlock = document.getElementById('gamesCatalogBlock');
    const gamesSourceListBtn = document.getElementById('gamesSourceListBtn');
    const gamesSourceCatalogBtn = document.getElementById('gamesSourceCatalogBtn');
    const catalogFetchStatus = document.getElementById('catalogFetchStatus');
    const publisherFetchCatalogBtn = document.getElementById('publisherFetchCatalogBtn');

    function setGamesSourceMode(catalog, skipSave) {
        useCatalog = catalog;
        if (!gamesSourceListBtn || !gamesSourceCatalogBtn || !gamesListBlock || !gamesCatalogBlock) return;
        if (catalog) {
            gamesSourceListBtn.style.background = '#333';
            gamesSourceListBtn.style.color = '#888';
            gamesSourceListBtn.style.borderColor = '#555';
            gamesSourceCatalogBtn.style.background = '#1a3a3a';
            gamesSourceCatalogBtn.style.color = '#4dd0e1';
            gamesSourceCatalogBtn.style.borderColor = '#4dd0e1';
            gamesListBlock.style.display = 'none';
            gamesCatalogBlock.style.display = 'block';
        } else {
            gamesSourceListBtn.style.background = '#00ff00';
            gamesSourceListBtn.style.color = '#000';
            gamesSourceListBtn.style.borderColor = '#00cc00';
            gamesSourceCatalogBtn.style.background = '#333';
            gamesSourceCatalogBtn.style.color = '#888';
            gamesSourceCatalogBtn.style.borderColor = '#555';
            gamesListBlock.style.display = 'block';
            gamesCatalogBlock.style.display = 'none';
        }
        if (!skipSave) saveSettings();
    }

    gamesSourceListBtn?.addEventListener('click', () => setGamesSourceMode(false));
    gamesSourceCatalogBtn?.addEventListener('click', () => setGamesSourceMode(true));

    publisherFetchCatalogBtn?.addEventListener('click', async () => {
        publisherFetchCatalogBtn.disabled = true;
        catalogFetchStatus.textContent = '⏳ Загружаю каталог...';
        try {
            const games = await fetchSteamPassCatalogForPublisher((done, total) => {
                catalogFetchStatus.textContent = `⏳ Загружено: ${done}${total ? ' / ' + total : ''} игр`;
            });
            catalogGames = games;
            catalogFetchStatus.textContent = `✅ Загружено ${games.length} игр. Готово к созданию.`;
            catalogFetchStatus.style.color = '#4caf50';
        } catch (e) {
            catalogFetchStatus.textContent = `❌ Ошибка: ${e.message}`;
            catalogFetchStatus.style.color = '#cf6679';
        }
        publisherFetchCatalogBtn.disabled = false;
    });

    async function fetchSteamPassCatalogForPublisher(onProgress) {
        const PER_PAGE = 100;
        const BODY = JSON.stringify({ orders: [['release_date', 'desc']] });
        const all = [];
        let page = 1, total = null;
        while (true) {
            const r = await fetch(`https://steampass.gg/api/product/filter?page=${page}&per_page=${PER_PAGE}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: BODY
            });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const data = await r.json();
            const items = Array.isArray(data?.data) ? data.data : [];
            if (!items.length) break;
            if (page === 1) total = data?.total || null;
            items.forEach(item => {
                // Extract Steam App ID from any CDN URL in the item data (most reliable image source)
                const cdnUrls = [item.background_url, item.image_url, item.icon_url].filter(Boolean);
                let steamAppId = null;
                for (const url of cdnUrls) {
                    const m = url.match(/\/steam\/apps\/(\d+)\//);
                    if (m) { steamAppId = m[1]; break; }
                }
                all.push({
                    name: item.name || item.title || '',
                    id: item.id,
                    steamAppId,
                    banner: item.background_url || item.image_url || null,
                    screenshots: Array.isArray(item.screenshots)
                        ? item.screenshots.slice(0, 3).map(s => typeof s === 'string' ? s : (s.path_full || s.path || s.url)).filter(Boolean)
                        : []
                });
            });
            if (onProgress) onProgress(all.length, total);
            if (items.length < PER_PAGE) break;
            if (total && all.length >= total) break;
            page++;
            if (page > 300) break;
            await new Promise(r => setTimeout(r, 150));
        }
        return all.filter(g => g.name);
    }

    const modePublishBtn = document.getElementById('modePublishBtn');
    const modeDraftBtn = document.getElementById('modeDraftBtn');
    const publishModeHint = document.getElementById('publishModeHint');

    function setPublishMode(draft) {
        saveDraft = draft;
        if (draft) {
            modePublishBtn.style.background = '#333';
            modePublishBtn.style.color = '#888';
            modePublishBtn.style.borderColor = '#555';
            modeDraftBtn.style.background = '#1a3a3a';
            modeDraftBtn.style.color = '#4dd0e1';
            modeDraftBtn.style.borderColor = '#4dd0e1';
            publishModeHint.textContent = 'Товар создаётся как черновик — не виден покупателям до ручной публикации.';
        } else {
            modePublishBtn.style.background = '#00ff00';
            modePublishBtn.style.color = '#000';
            modePublishBtn.style.borderColor = '#00cc00';
            modeDraftBtn.style.background = '#333';
            modeDraftBtn.style.color = '#888';
            modeDraftBtn.style.borderColor = '#555';
            publishModeHint.textContent = 'Товар будет опубликован сразу после создания.';
        }
        saveSettings();
    }

    modePublishBtn?.addEventListener('click', () => setPublishMode(false));
    modeDraftBtn?.addEventListener('click', () => setPublishMode(true));

    const discountModeBtn = document.getElementById('discountModeBtn');
    const discountFields = document.getElementById('discountFields');
    const discountSingleRow = document.getElementById('discountSingleRow');
    const discountCopyList = document.getElementById('discountCopyList');
    const discountBasePriceInput = document.getElementById('discountBasePrice');
    const discountSalePriceInput = document.getElementById('discountSalePrice');
    const discountPreview = document.getElementById('discountPreview');

    function renderDiscountCopyFields(count) {
        if (!discountCopyList) return;
        const n = Math.max(1, Math.min(20, parseInt(count, 10) || 1));
        const existingB = [...discountCopyList.querySelectorAll('.discount-base-input')].map(i => parseFloat(i.value));
        const existingS = [...discountCopyList.querySelectorAll('.discount-sale-input')].map(i => parseFloat(i.value));
        discountCopyList.innerHTML = '';
        for (let i = 0; i < n; i++) {
            const base = !Number.isNaN(existingB[i]) && existingB[i] > 0 ? existingB[i] : (100 + i * 5);
            const sale = !Number.isNaN(existingS[i]) && existingS[i] > 0 ? existingS[i] : (90 + i * 5);
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:8px;';
            row.innerHTML = `<span style="color:#888;font-size:11px;min-width:72px;">Копия ${i + 1}:</span>
                <span style="color:#aaa;font-size:11px;">база</span>
                <input type="number" class="discount-base-input" value="${base}" min="1" max="999999" style="width:80px;">
                <span style="color:#aaa;font-size:11px;">→</span>
                <input type="number" class="discount-sale-input" value="${sale}" min="1" max="999999" style="width:80px;">
                <span style="color:#888;font-size:11px;">₽ новая</span>`;
            discountCopyList.appendChild(row);
        }
        discountCopyList.querySelectorAll('input').forEach(inp => inp.addEventListener('input', () => { updateDiscountPreview(); saveSettings(); }));
    }

    function syncDiscountRowsUI() {
        const multi = !!(duplicateMode && discountMode);
        if (discountSingleRow) discountSingleRow.style.display = multi ? 'none' : 'flex';
        if (discountCopyList) {
            discountCopyList.style.display = multi ? 'flex' : 'none';
            if (multi) renderDiscountCopyFields(parseInt(duplicateCountInput.value, 10) || 1);
        }
        updateDiscountPreview();
    }

    function updateDiscountPreview() {
        if (!discountPreview) return;
        if (!discountMode) {
            discountPreview.textContent = '';
            return;
        }
        if (duplicateMode && discountCopyList && discountCopyList.style.display !== 'none') {
            const rows = discountCopyList.querySelectorAll('.discount-base-input');
            const parts = [];
            rows.forEach((bInp, i) => {
                const sInp = discountCopyList.querySelectorAll('.discount-sale-input')[i];
                if (!sInp) return;
                const base = parseFloat(bInp.value) || 0;
                const sale = parseFloat(sInp.value) || 0;
                if (base > 0 && sale > 0 && sale < base) {
                    parts.push(`коп.${i + 1}: ${Math.round(sale)} ₽ (база ${Math.round(base)})`);
                }
            });
            discountPreview.textContent = parts.length ? `По копиям: ${parts.join(' · ')}` : '';
            return;
        }
        if (!discountBasePriceInput || !discountSalePriceInput) return;
        const base = parseFloat(discountBasePriceInput.value) || 0;
        const sale = parseFloat(discountSalePriceInput.value) || 0;
        if (base > 0 && sale > 0 && sale < base) {
            const pct = Math.round((1 - sale / base) * 1000) / 10;
            discountPreview.textContent = `В API: price: ${Math.round(sale)} (база ${Math.round(base)} ₽, ≈ −${pct}%)`;
        } else if (base > 0 && sale > 0) {
            discountPreview.textContent = `В API: price: ${Math.round(sale)} (новая должна быть меньше базовой)`;
        } else {
            discountPreview.textContent = '';
        }
    }

    function setDiscountMode(active) {
        discountMode = active;
        if (active) {
            discountModeBtn.textContent = '✅ ВКЛ';
            discountModeBtn.style.background = '#1a3d1a';
            discountModeBtn.style.color = '#4caf50';
            discountModeBtn.style.borderColor = '#4caf50';
            if (discountFields) discountFields.style.display = 'block';
        } else {
            discountModeBtn.textContent = '⬜ ВЫКЛ';
            discountModeBtn.style.background = '#333';
            discountModeBtn.style.color = '#888';
            discountModeBtn.style.borderColor = '#555';
            if (discountFields) discountFields.style.display = 'none';
        }
        syncDiscountRowsUI();
        saveSettings();
    }

    discountModeBtn?.addEventListener('click', () => setDiscountMode(!discountMode));
    discountBasePriceInput?.addEventListener('input', () => { updateDiscountPreview(); saveSettings(); });
    discountSalePriceInput?.addEventListener('input', () => { updateDiscountPreview(); saveSettings(); });

    const strictSearchBtn = document.getElementById('strictSearchBtn');

    function setStrictGameSearch(active) {
        strictGameSearch = active;
        if (!strictSearchBtn) return;
        if (active) {
            strictSearchBtn.textContent = '✅ ВКЛ';
            strictSearchBtn.style.background = '#1a3d1a';
            strictSearchBtn.style.color = '#4caf50';
            strictSearchBtn.style.borderColor = '#4caf50';
        } else {
            strictSearchBtn.textContent = '⬜ ВЫКЛ';
            strictSearchBtn.style.background = '#333';
            strictSearchBtn.style.color = '#888';
            strictSearchBtn.style.borderColor = '#555';
        }
        saveSettings();
    }

    strictSearchBtn?.addEventListener('click', () => setStrictGameSearch(!strictGameSearch));

    const publisherCatAutoBtn = document.getElementById('publisherCatAutoBtn');
    const publisherCatSteamBtn = document.getElementById('publisherCatSteamBtn');
    const publisherCatOtherGamesBtn = document.getElementById('publisherCatOtherGamesBtn');
    const publisherGamePageLotRow = document.getElementById('publisherGamePageLotRow');
    const publisherGamePageLotCategory = document.getElementById('publisherGamePageLotCategory');
    const publisherGamePageObtainingRow = document.getElementById('publisherGamePageObtainingRow');
    const publisherGamePageObtainingType = document.getElementById('publisherGamePageObtainingType');
    const publisherGamePageAccountAttrsRow = document.getElementById('publisherGamePageAccountAttrsRow');
    const publisherGpAccountTypeChips = document.getElementById('publisherGpAccountTypeChips');
    const publisherGamePageLevel = document.getElementById('publisherGamePageLevel');
    const publisherGpCountryChips = document.getElementById('publisherGpCountryChips');
    const publisherOtherGamesRow = document.getElementById('publisherOtherGamesRow');
    const publisherOtherGamesLotCategory = document.getElementById('publisherOtherGamesLotCategory');
    const publisherOtherGamesObtainingRow = document.getElementById('publisherOtherGamesObtainingRow');
    const publisherOtherGamesObtainingType = document.getElementById('publisherOtherGamesObtainingType');
    const publisherOtherGamesAccountAttrsRow = document.getElementById('publisherOtherGamesAccountAttrsRow');
    const publisherOgAccountTypeChips = document.getElementById('publisherOgAccountTypeChips');
    const publisherOtherGamesLevel = document.getElementById('publisherOtherGamesLevel');
    const publisherOgCountryChips = document.getElementById('publisherOgCountryChips');
    const publisherSteamLotRow = document.getElementById('publisherSteamLotRow');
    const publisherSteamLotCategory = document.getElementById('publisherSteamLotCategory');
    const publisherSteamObtainingRow = document.getElementById('publisherSteamObtainingRow');
    const publisherSteamObtainingType = document.getElementById('publisherSteamObtainingType');
    const publisherSteamAccountAttrsRow = document.getElementById('publisherSteamAccountAttrsRow');
    const publisherSteamAccountTypeChips = document.getElementById('publisherSteamAccountTypeChips');
    const publisherSteamLevel = document.getElementById('publisherSteamLevel');
    const publisherSteamCountryChips = document.getElementById('publisherSteamCountryChips');

    function updateSteamAccountTypeChipStyles() {
        if (!publisherSteamAccountTypeChips) return;
        publisherSteamAccountTypeChips.querySelectorAll('label').forEach((lab) => {
            const inp = lab.querySelector('input[type="radio"]');
            lab.classList.toggle('steam-country-chip-on', !!(inp && inp.checked));
        });
    }

    function getSelectedSteamAccountTypeKey() {
        if (!publisherSteamAccountTypeChips) return 'steam_acct_empty';
        const c = publisherSteamAccountTypeChips.querySelector('input[name="publisherSteamAccountType"]:checked');
        return c ? c.value : 'steam_acct_empty';
    }

    function fillPublisherSteamAccountTypeChips() {
        if (!publisherSteamAccountTypeChips) return;
        publisherSteamAccountTypeChips.innerHTML = STEAM_ACCOUNT_TYPE_OPTIONS.map((o) => (
            `<label><input type="radio" name="publisherSteamAccountType" value="${o.key}">${o.label}</label>`
        )).join('');
        publisherSteamAccountTypeChips.querySelectorAll('input[name="publisherSteamAccountType"]').forEach((inp) => {
            inp.addEventListener('change', () => {
                updateSteamAccountTypeChipStyles();
                saveSettings();
            });
        });
        const first = publisherSteamAccountTypeChips.querySelector('input[value="steam_acct_empty"]');
        if (first) first.checked = true;
        updateSteamAccountTypeChipStyles();
    }
    fillPublisherSteamAccountTypeChips();

    function updateSteamCountryChipStyles() {
        if (!publisherSteamCountryChips) return;
        publisherSteamCountryChips.querySelectorAll('label').forEach((lab) => {
            const inp = lab.querySelector('input[type="radio"]');
            lab.classList.toggle('steam-country-chip-on', !!(inp && inp.checked));
        });
    }

    function getSelectedSteamCountryKey() {
        if (!publisherSteamCountryChips) return 'ru';
        const c = publisherSteamCountryChips.querySelector('input[name="publisherSteamCountry"]:checked');
        return c ? c.value : 'ru';
    }

    function fillPublisherSteamCountryChips() {
        if (!publisherSteamCountryChips) return;
        publisherSteamCountryChips.innerHTML = STEAM_ACCOUNT_COUNTRY_OPTIONS.map((o) => (
            `<label><input type="radio" name="publisherSteamCountry" value="${o.key}">${o.label}</label>`
        )).join('');
        publisherSteamCountryChips.querySelectorAll('input[name="publisherSteamCountry"]').forEach((inp) => {
            inp.addEventListener('change', () => {
                updateSteamCountryChipStyles();
                saveSettings();
            });
        });
        const ru = publisherSteamCountryChips.querySelector('input[value="ru"]');
        if (ru) ru.checked = true;
        updateSteamCountryChipStyles();
    }
    fillPublisherSteamCountryChips();

    function fillPublisherSteamLotCategorySelect() {
        if (!publisherSteamLotCategory) return;
        publisherSteamLotCategory.innerHTML = STEAM_LOT_CATEGORY_OPTIONS.map(
            (o) => `<option value="${o.key}">${o.label}</option>`
        ).join('');
    }
    fillPublisherSteamLotCategorySelect();

    function fillPublisherGamePageLotSelect() {
        if (!publisherGamePageLotCategory) return;
        publisherGamePageLotCategory.innerHTML = GAME_PAGE_LOT_CATEGORY_OPTIONS.map(
            (o) => `<option value="${o.key}">${o.label}</option>`
        ).join('');
        publisherGamePageLotCategory.value = 'game_page_accounts';
    }
    fillPublisherGamePageLotSelect();

    function fillPublisherGamePageObtainingSelect() {
        if (!publisherGamePageObtainingType) return;
        publisherGamePageObtainingType.innerHTML = STEAM_ACCOUNTS_OBTAINING_OPTIONS.map((o) => (
            `<option value="${o.key}">${o.label}</option>`
        )).join('');
        publisherGamePageObtainingType.value = 'steam_obt_shared_offline';
    }
    fillPublisherGamePageObtainingSelect();

    function fillPublisherOtherGamesLotSelect() {
        if (!publisherOtherGamesLotCategory) return;
        publisherOtherGamesLotCategory.innerHTML = OTHER_GAMES_LOT_CATEGORY_OPTIONS.map(
            (o) => `<option value="${o.key}">${o.label}</option>`
        ).join('');
        publisherOtherGamesLotCategory.value = 'other_games_accounts';
    }
    fillPublisherOtherGamesLotSelect();

    function fillPublisherOtherGamesObtainingSelect() {
        if (!publisherOtherGamesObtainingType) return;
        publisherOtherGamesObtainingType.innerHTML = OTHER_GAMES_OBTAINING_OPTIONS.map((o) => (
            `<option value="${o.key}">${o.label}</option>`
        )).join('');
        publisherOtherGamesObtainingType.value = 'steam_obt_shared_offline';
    }
    fillPublisherOtherGamesObtainingSelect();

    function getOtherGamesObtainingKey() {
        const v = publisherOtherGamesObtainingType?.value;
        return OTHER_GAMES_OBTAINING_OPTIONS.some((o) => o.key === v)
            ? v
            : 'steam_obt_shared_offline';
    }

    function updateOgAccountTypeChipStyles() {
        if (!publisherOgAccountTypeChips) return;
        publisherOgAccountTypeChips.querySelectorAll('label').forEach((lab) => {
            const inp = lab.querySelector('input[type="radio"]');
            lab.classList.toggle('steam-country-chip-on', !!(inp && inp.checked));
        });
    }

    function getSelectedOgAccountTypeKey() {
        if (!publisherOgAccountTypeChips) return 'steam_acct_empty';
        const c = publisherOgAccountTypeChips.querySelector('input[name="publisherOgAccountType"]:checked');
        return c ? c.value : 'steam_acct_empty';
    }

    function fillPublisherOgAccountTypeChips() {
        if (!publisherOgAccountTypeChips) return;
        publisherOgAccountTypeChips.innerHTML = STEAM_ACCOUNT_TYPE_OPTIONS.map((o) => (
            `<label><input type="radio" name="publisherOgAccountType" value="${o.key}">${o.label}</label>`
        )).join('');
        publisherOgAccountTypeChips.querySelectorAll('input[name="publisherOgAccountType"]').forEach((inp) => {
            inp.addEventListener('change', () => {
                updateOgAccountTypeChipStyles();
                saveSettings();
            });
        });
        const first = publisherOgAccountTypeChips.querySelector('input[value="steam_acct_empty"]');
        if (first) first.checked = true;
        updateOgAccountTypeChipStyles();
    }
    fillPublisherOgAccountTypeChips();

    function updateOgCountryChipStyles() {
        if (!publisherOgCountryChips) return;
        publisherOgCountryChips.querySelectorAll('label').forEach((lab) => {
            const inp = lab.querySelector('input[type="radio"]');
            lab.classList.toggle('steam-country-chip-on', !!(inp && inp.checked));
        });
    }

    function getSelectedOgCountryKey() {
        if (!publisherOgCountryChips) return 'ru';
        const c = publisherOgCountryChips.querySelector('input[name="publisherOgCountry"]:checked');
        return c ? c.value : 'ru';
    }

    function fillPublisherOgCountryChips() {
        if (!publisherOgCountryChips) return;
        publisherOgCountryChips.innerHTML = STEAM_ACCOUNT_COUNTRY_OPTIONS.map((o) => (
            `<label><input type="radio" name="publisherOgCountry" value="${o.key}">${o.label}</label>`
        )).join('');
        publisherOgCountryChips.querySelectorAll('input[name="publisherOgCountry"]').forEach((inp) => {
            inp.addEventListener('change', () => {
                updateOgCountryChipStyles();
                saveSettings();
            });
        });
        const ru = publisherOgCountryChips.querySelector('input[value="ru"]');
        if (ru) ru.checked = true;
        updateOgCountryChipStyles();
    }
    fillPublisherOgCountryChips();

    function updateGpAccountTypeChipStyles() {
        if (!publisherGpAccountTypeChips) return;
        publisherGpAccountTypeChips.querySelectorAll('label').forEach((lab) => {
            const inp = lab.querySelector('input[type="radio"]');
            lab.classList.toggle('steam-country-chip-on', !!(inp && inp.checked));
        });
    }

    function getSelectedGpAccountTypeKey() {
        if (!publisherGpAccountTypeChips) return 'steam_acct_empty';
        const c = publisherGpAccountTypeChips.querySelector('input[name="publisherGpAccountType"]:checked');
        return c ? c.value : 'steam_acct_empty';
    }

    function fillPublisherGpAccountTypeChips() {
        if (!publisherGpAccountTypeChips) return;
        publisherGpAccountTypeChips.innerHTML = STEAM_ACCOUNT_TYPE_OPTIONS.map((o) => (
            `<label><input type="radio" name="publisherGpAccountType" value="${o.key}">${o.label}</label>`
        )).join('');
        publisherGpAccountTypeChips.querySelectorAll('input[name="publisherGpAccountType"]').forEach((inp) => {
            inp.addEventListener('change', () => {
                updateGpAccountTypeChipStyles();
                saveSettings();
            });
        });
        const first = publisherGpAccountTypeChips.querySelector('input[value="steam_acct_empty"]');
        if (first) first.checked = true;
        updateGpAccountTypeChipStyles();
    }
    fillPublisherGpAccountTypeChips();

    function updateGpCountryChipStyles() {
        if (!publisherGpCountryChips) return;
        publisherGpCountryChips.querySelectorAll('label').forEach((lab) => {
            const inp = lab.querySelector('input[type="radio"]');
            lab.classList.toggle('steam-country-chip-on', !!(inp && inp.checked));
        });
    }

    function getSelectedGpCountryKey() {
        if (!publisherGpCountryChips) return 'ru';
        const c = publisherGpCountryChips.querySelector('input[name="publisherGpCountry"]:checked');
        return c ? c.value : 'ru';
    }

    function fillPublisherGpCountryChips() {
        if (!publisherGpCountryChips) return;
        publisherGpCountryChips.innerHTML = STEAM_ACCOUNT_COUNTRY_OPTIONS.map((o) => (
            `<label><input type="radio" name="publisherGpCountry" value="${o.key}">${o.label}</label>`
        )).join('');
        publisherGpCountryChips.querySelectorAll('input[name="publisherGpCountry"]').forEach((inp) => {
            inp.addEventListener('change', () => {
                updateGpCountryChipStyles();
                saveSettings();
            });
        });
        const ru = publisherGpCountryChips.querySelector('input[value="ru"]');
        if (ru) ru.checked = true;
        updateGpCountryChipStyles();
    }
    fillPublisherGpCountryChips();

    function fillPublisherSteamObtainingSelect() {
        if (!publisherSteamObtainingType) return;
        publisherSteamObtainingType.innerHTML = STEAM_ACCOUNTS_OBTAINING_OPTIONS.map((o) => (
            `<option value="${o.key}">${o.label}</option>`
        )).join('');
        publisherSteamObtainingType.value = 'steam_obt_shared_offline';
    }
    fillPublisherSteamObtainingSelect();

    function syncPublisherSteamLotRow() {
        if (!publisherSteamLotRow) return;
        const steamOn = accountCategoryPlatform === 'steam';
        publisherSteamLotRow.style.display = steamOn ? 'block' : 'none';
        const showAccountsExtras = steamOn && publisherSteamLotCategory?.value === 'steam_accounts_with_games';
        if (publisherSteamObtainingRow) {
            publisherSteamObtainingRow.style.display = showAccountsExtras ? 'block' : 'none';
        }
        if (publisherSteamAccountAttrsRow) {
            publisherSteamAccountAttrsRow.style.display = showAccountsExtras ? 'block' : 'none';
        }
    }

    function syncPublisherGamePageRows() {
        const autoOn = accountCategoryPlatform === 'auto';
        if (publisherGamePageLotRow) publisherGamePageLotRow.style.display = autoOn ? 'block' : 'none';
        const gpAccounts = autoOn && (publisherGamePageLotCategory?.value || '') === 'game_page_accounts';
        if (publisherGamePageObtainingRow) {
            publisherGamePageObtainingRow.style.display = gpAccounts ? 'block' : 'none';
        }
        const obtOffline = (publisherGamePageObtainingType?.value || '') === 'steam_obt_shared_offline';
        const showGpSteamDetails = gpAccounts && !obtOffline;
        if (publisherGamePageAccountAttrsRow) {
            publisherGamePageAccountAttrsRow.style.display = showGpSteamDetails ? 'block' : 'none';
        }
    }

    function syncPublisherOtherGamesRows() {
        const ogOn = accountCategoryPlatform === 'other_games';
        if (publisherOtherGamesRow) publisherOtherGamesRow.style.display = ogOn ? 'block' : 'none';
        if (!ogOn) {
            if (publisherOtherGamesObtainingRow) publisherOtherGamesObtainingRow.style.display = 'none';
            if (publisherOtherGamesAccountAttrsRow) publisherOtherGamesAccountAttrsRow.style.display = 'none';
            return;
        }
        const ogAccounts = (publisherOtherGamesLotCategory?.value || '') === 'other_games_accounts';
        if (publisherOtherGamesObtainingRow) {
            publisherOtherGamesObtainingRow.style.display = ogAccounts ? 'block' : 'none';
        }
        const isOfflineObt = getOtherGamesObtainingKey() === 'steam_obt_shared_offline';
        if (publisherOtherGamesAccountAttrsRow) {
            publisherOtherGamesAccountAttrsRow.style.display = ogAccounts && !isOfflineObt ? 'block' : 'none';
        }
    }

    function syncAccountCategoryButtons() {
        const active = {
            background: '#1a3d1a',
            color: '#4caf50',
            borderColor: '#4caf50'
        };
        const inactive = {
            background: '#333',
            color: '#888',
            borderColor: '#555'
        };
        const autoOn = accountCategoryPlatform === 'auto';
        const steamOn = accountCategoryPlatform === 'steam';
        const otherGamesOn = accountCategoryPlatform === 'other_games';
        if (publisherCatAutoBtn) {
            publisherCatAutoBtn.textContent = autoOn ? 'По игре: ✅' : 'По игре: ⬜';
            Object.assign(publisherCatAutoBtn.style, autoOn ? active : inactive);
        }
        if (publisherCatSteamBtn) {
            publisherCatSteamBtn.textContent = steamOn ? 'Steam: ✅' : 'Steam: ⬜';
            Object.assign(publisherCatSteamBtn.style, steamOn ? active : inactive);
        }
        if (publisherCatOtherGamesBtn) {
            publisherCatOtherGamesBtn.textContent = otherGamesOn ? 'Другие игры: ✅' : 'Другие игры: ⬜';
            Object.assign(publisherCatOtherGamesBtn.style, otherGamesOn ? active : inactive);
        }
        const strictBlock = document.getElementById('strictSearchBlock');
        const strictHintEl = document.getElementById('strictSearchHint');
        if (strictSearchBtn) {
            const onlyAuto = accountCategoryPlatform === 'auto';
            strictSearchBtn.disabled = !onlyAuto;
            strictSearchBtn.style.cursor = onlyAuto ? 'pointer' : 'not-allowed';
            strictSearchBtn.style.opacity = onlyAuto ? '1' : '0.55';
            if (strictBlock) strictBlock.style.opacity = onlyAuto ? '1' : '0.72';
            if (strictHintEl) {
                strictHintEl.textContent = onlyAuto
                    ? 'Если название не найдено точно — лот уйдёт в «Другие игры», название товара не перезапишется.'
                    : 'Используется только в режиме «По игре». В Steam строка списка задаёт только название лота, не карточку каталога.';
            }
        }
        syncPublisherSteamLotRow();
        syncPublisherGamePageRows();
        syncPublisherOtherGamesRows();
    }

    function syncPublisherSmartDupRowAndCategory() {
        if (smartDupRow) smartDupRow.style.display = duplicateMode ? 'block' : 'none';
        if (publisherCategoryBlock) {
            publisherCategoryBlock.style.display = (duplicateMode && smartDuplicateMode) ? 'none' : '';
        }
    }

    function setAccountCategoryPlatform(mode) {
        accountCategoryPlatform = mode === 'steam' || mode === 'auto' || mode === 'other_games'
            ? mode
            : 'auto';
        syncAccountCategoryButtons();
        saveSettings();
    }

    publisherCatAutoBtn?.addEventListener('click', () => setAccountCategoryPlatform('auto'));
    publisherCatSteamBtn?.addEventListener('click', () => setAccountCategoryPlatform('steam'));
    publisherCatOtherGamesBtn?.addEventListener('click', () => setAccountCategoryPlatform('other_games'));
    publisherOtherGamesLotCategory?.addEventListener('change', () => {
        syncPublisherOtherGamesRows();
        saveSettings();
    });
    publisherOtherGamesObtainingType?.addEventListener('change', () => {
        syncPublisherOtherGamesRows();
        saveSettings();
    });
    publisherOtherGamesLevel?.addEventListener('input', () => saveSettings());
    publisherGamePageLotCategory?.addEventListener('change', () => {
        syncPublisherGamePageRows();
        saveSettings();
    });
    publisherGamePageObtainingType?.addEventListener('change', () => {
        syncPublisherGamePageRows();
        saveSettings();
    });
    publisherGamePageLevel?.addEventListener('input', () => saveSettings());
    publisherSteamLotCategory?.addEventListener('change', () => {
        syncPublisherSteamLotRow();
        saveSettings();
    });
    publisherSteamObtainingType?.addEventListener('change', () => {
        syncPublisherSteamLotRow();
        saveSettings();
    });
    publisherSteamLevel?.addEventListener('input', () => saveSettings());
    syncAccountCategoryButtons();

    function setDuplicateMode(active) {
        duplicateMode = active;
        if (!active) {
            smartDuplicateMode = false;
            if (smartDuplicateCheckbox) smartDuplicateCheckbox.checked = false;
        }
        if (active) {
            duplicateModeBtn.textContent = '✅ ВКЛ';
            duplicateModeBtn.style.background = '#1a3d1a';
            duplicateModeBtn.style.color = '#4caf50';
            duplicateModeBtn.style.borderColor = '#4caf50';
            singlePriceBlock.style.display = 'none';
            rangePriceBlock.style.display = 'block';
            renderCopyPrices(parseInt(duplicateCountInput.value) || 3);
        } else {
            duplicateModeBtn.textContent = '⬜ ВЫКЛ';
            duplicateModeBtn.style.background = '#333';
            duplicateModeBtn.style.color = '#888';
            duplicateModeBtn.style.borderColor = '#555';
            singlePriceBlock.style.display = 'block';
            rangePriceBlock.style.display = 'none';
        }
        syncPublisherSmartDupRowAndCategory();
        syncDiscountRowsUI();
        saveSettings();
    }

    // Render N price inputs for copy prices
    function renderCopyPrices(count) {
        const existing = [...copyPricesList.querySelectorAll('input')].map(i => parseFloat(i.value) || 90);
        copyPricesList.innerHTML = '';
        for (let i = 0; i < count; i++) {
            const wrap = document.createElement('div');
            wrap.style.cssText = 'display:flex;align-items:center;gap:6px;';
            wrap.innerHTML = `<span style="color:#888;font-size:11px;min-width:60px;">Копия ${i + 1}:</span>
                <input type="number" class="copy-price-input" value="${existing[i] || (90 + i * 5)}" min="1" max="99999" style="width:90px;">
                <span style="color:#888;font-size:11px;">руб.</span>`;
            copyPricesList.appendChild(wrap);
        }
        copyPricesList.querySelectorAll('input').forEach(inp => inp.addEventListener('input', saveSettings));
    }

    function getCopyPrices() {
        return [...copyPricesList.querySelectorAll('input')].map(i => parseFloat(i.value) || 90);
    }

    duplicateCountInput.addEventListener('input', () => {
        renderCopyPrices(parseInt(duplicateCountInput.value) || 1);
        if (duplicateMode && discountMode) renderDiscountCopyFields(parseInt(duplicateCountInput.value) || 1);
        saveSettings();
    });

    duplicateModeBtn?.addEventListener('click', () => setDuplicateMode(!duplicateMode));
    syncPublisherSmartDupRowAndCategory();

    smartDuplicateCheckbox?.addEventListener('change', () => {
        smartDuplicateMode = !!(duplicateMode && smartDuplicateCheckbox.checked);
        syncPublisherSmartDupRowAndCategory();
        saveSettings();
    });

    const genModeBadge = document.getElementById('genModeBadge');
    const publisherImageSource = document.getElementById('publisherImageSource');
    const publisherSgdbRow = document.getElementById('publisherSgdbRow');
    const publisherSteamGridDbKey = document.getElementById('publisherSteamGridDbKey');
    const publisherLocalCardsFolder = document.getElementById('publisherLocalCardsFolder');
    const imgAutoBlock = document.getElementById('imgAutoBlock');
    const imgLocalBlock = document.getElementById('imgLocalBlock');
    const imgModeAutoBtn = document.getElementById('imgModeAutoBtn');
    const imgModeLocalBtn = document.getElementById('imgModeLocalBtn');

    // true = режим Папка, false = режим Авто
    let imgModeLocal = false;

    function setImgMode(local, skipSave) {
        imgModeLocal = local;
        if (local) {
            if (imgAutoBlock) imgAutoBlock.style.display = 'none';
            if (imgLocalBlock) imgLocalBlock.style.display = 'block';
            // local_card не в <select> (только Авто-источники) — режим папки задаётся флагом imgModeLocal
            if (imgModeLocalBtn) {
                imgModeLocalBtn.style.background = '#1a3a3a';
                imgModeLocalBtn.style.color = '#4dd0e1';
                imgModeLocalBtn.style.borderColor = '#4dd0e1';
            }
            if (imgModeAutoBtn) {
                imgModeAutoBtn.style.background = '#333';
                imgModeAutoBtn.style.color = '#888';
                imgModeAutoBtn.style.borderColor = '#555';
            }
        } else {
            if (imgAutoBlock) imgAutoBlock.style.display = 'block';
            if (imgLocalBlock) imgLocalBlock.style.display = 'none';
            if (imgModeAutoBtn) {
                imgModeAutoBtn.style.background = '#00ff00';
                imgModeAutoBtn.style.color = '#000';
                imgModeAutoBtn.style.borderColor = '#00cc00';
            }
            if (imgModeLocalBtn) {
                imgModeLocalBtn.style.background = '#333';
                imgModeLocalBtn.style.color = '#888';
                imgModeLocalBtn.style.borderColor = '#555';
            }
            updatePublisherImageSourceUI();
        }
        if (!skipSave) saveSettings();
    }

    imgModeAutoBtn?.addEventListener('click', () => setImgMode(false));
    imgModeLocalBtn?.addEventListener('click', () => setImgMode(true));

    // Сохранение настроек при изменении
    function saveSettings() {
        if (typeof chrome !== 'undefined' && chrome.storage) {
            chrome.storage.local.set({
                publisherGames: gamesListInput.value,
                publisherNameTemplate: nameTemplateInput.value,
                publisherCommentTemplate: commentTemplateInput.value,
                publisherDescTemplate: descTemplateInput.value,
                publisherSource: sourceToggle.value,
                publisherActionDelay: actionDelayInput.value,
                publisherPublishDelay: publishDelayInput.value,
                publisherPrice: priceInput.value,
                publisherCopyPrices: JSON.stringify(getCopyPrices()),
                publisherDuplicateMode: duplicateMode,
                publisherSmartDuplicate: duplicateMode && smartDuplicateMode,
                publisherDuplicateCount: duplicateCountInput.value,
                publisherSaveDraft: saveDraft,
                publisherUseCatalog: useCatalog,
                publisherStrictGameSearch: strictGameSearch,
                publisherImgModeLocal: imgModeLocal,
                publisherImageSource: imgModeLocal ? 'local_card' : (publisherImageSource?.value || 'steam'),
                publisherCardFallback: 'steam',
                publisherDiscountMode: discountMode,
                publisherDiscountBase: discountBasePriceInput.value,
                publisherDiscountSale: discountSalePriceInput.value,
                publisherDiscountBases: (duplicateMode && discountMode && discountCopyList)
                    ? JSON.stringify([...discountCopyList.querySelectorAll('.discount-base-input')].map(i => i.value))
                    : '',
                publisherDiscountSales: (duplicateMode && discountMode && discountCopyList)
                    ? JSON.stringify([...discountCopyList.querySelectorAll('.discount-sale-input')].map(i => i.value))
                    : '',
                publisherAccountCategoryPlatform: accountCategoryPlatform,
                publisherGamePageLotCategory: publisherGamePageLotCategory?.value || 'game_page_accounts',
                publisherGamePageObtainingType: publisherGamePageObtainingType?.value || 'steam_obt_shared_offline',
                publisherGamePageLevel: publisherGamePageLevel?.value || '',
                publisherGamePageAccountType: getSelectedGpAccountTypeKey(),
                publisherGamePageCountry: getSelectedGpCountryKey(),
                publisherSteamLotCategory: publisherSteamLotCategory?.value || 'steam_accounts_with_games',
                publisherSteamObtainingType: publisherSteamObtainingType?.value || 'steam_obt_shared_offline',
                publisherSteamAccountType: getSelectedSteamAccountTypeKey(),
                publisherSteamLevel: publisherSteamLevel?.value || '',
                publisherSteamCountry: getSelectedSteamCountryKey(),
                publisherOtherGamesLotCategory: publisherOtherGamesLotCategory?.value || 'other_games_accounts',
                publisherOtherGamesObtainingType: getOtherGamesObtainingKey(),
                publisherOtherGamesLevel: publisherOtherGamesLevel?.value || '',
                publisherOtherGamesAccountType: getSelectedOgAccountTypeKey(),
                publisherOtherGamesCountry: getSelectedOgCountryKey()
            });
        }
    }

    function updatePublisherImageSourceUI() {
        if (imgModeLocal) return; // в режиме Папка — ничего не меняем
        const v = publisherImageSource?.value || 'steam';
        if (publisherSgdbRow) publisherSgdbRow.style.display = v === 'steamgriddb' ? 'block' : 'none';
    }

    publisherImageSource?.addEventListener('change', () => {
        updatePublisherImageSourceUI();
        saveSettings();
    });
    publisherSteamGridDbKey?.addEventListener('input', () => {
        if (typeof chrome !== 'undefined' && chrome.storage) {
            chrome.storage.local.set({ steamgriddbApiKey: publisherSteamGridDbKey.value });
        }
    });

    function applyGeneratorMode(mode) {
        if (!genModeBadge) return;
        if (mode === 'steampass_catalog') {
            genModeBadge.textContent = '🌐 Режим: Каталог SteamPass (изображения со SteamPass)';
            genModeBadge.style.color = '#4caf50';
        } else {
            genModeBadge.textContent = '📝 Режим: Список (изображения из Steam)';
            genModeBadge.style.color = '#2196F3';
        }
    }

    /** Пока false — не обрабатываем storage.onChanged (иначе гонка: сохранение пустого списка до restore). */
    let publisherStorageRestored = false;

    // Логика загрузки сохраненных настроек
    if (typeof chrome !== 'undefined' && chrome.storage) {
        chrome.storage.local.get([
            'publisherGames', 'publisherNameTemplate', 'publisherCommentTemplate',
            'publisherDescTemplate', 'publisherSource',
            'publisherActionDelay', 'publisherPublishDelay',
            'publisherPrice', 'publisherCopyPrices',
            'publisherDuplicateMode', 'publisherSmartDuplicate', 'publisherDuplicateCount',
            'publisherSaveDraft', 'publisherUseCatalog', 'generatorMode',
            'publisherDiscountMode', 'publisherDiscountBase', 'publisherDiscountSale',
            'publisherDiscountBases', 'publisherDiscountSales',
            'publisherDiscountPercent', 'publisherStrictGameSearch',
            'publisherImageSource', 'publisherImgModeLocal', 'steamgriddbApiKey',
            'publisherAccountCategoryPlatform',
            'publisherGamePageLotCategory', 'publisherGamePageObtainingType',
            'publisherGamePageLevel', 'publisherGamePageCountry', 'publisherGamePageAccountType',
            'publisherSteamLotCategory', 'publisherSteamObtainingType',
            'publisherSteamLevel', 'publisherSteamCountry', 'publisherSteamAccountType',
            'publisherOtherGamesLotCategory', 'publisherOtherGamesObtainingType',
            'publisherOtherGamesLevel', 'publisherOtherGamesCountry', 'publisherOtherGamesAccountType'
        ], (res) => {
            try {
                if (typeof res.publisherGames === 'string' && gamesListInput) {
                    gamesListInput.value = res.publisherGames;
                }
                if (res.publisherNameTemplate && nameTemplateInput) nameTemplateInput.value = res.publisherNameTemplate;
                if (res.publisherCommentTemplate && commentTemplateInput) commentTemplateInput.value = res.publisherCommentTemplate;
                if (res.publisherDescTemplate && descTemplateInput) descTemplateInput.value = res.publisherDescTemplate;
                if (res.publisherSource) sourceToggle.value = res.publisherSource;
                if (res.publisherActionDelay && actionDelayInput) actionDelayInput.value = res.publisherActionDelay;
                if (res.publisherPublishDelay && publishDelayInput) publishDelayInput.value = res.publisherPublishDelay;
                if (res.publisherPrice && priceInput) priceInput.value = res.publisherPrice;
                if (res.publisherDuplicateCount && duplicateCountInput) duplicateCountInput.value = res.publisherDuplicateCount;
                if (res.publisherDuplicateMode) {
                    setDuplicateMode(true);
                    if (res.publisherCopyPrices && copyPricesList) {
                        try {
                            const saved = JSON.parse(res.publisherCopyPrices);
                            const inputs = copyPricesList.querySelectorAll('input');
                            saved.forEach((v, i) => { if (inputs[i]) inputs[i].value = v; });
                        } catch (_) { }
                    }
                }
                if (res.publisherDuplicateMode && res.publisherSmartDuplicate) {
                    smartDuplicateMode = true;
                    if (smartDuplicateCheckbox) smartDuplicateCheckbox.checked = true;
                }
                syncPublisherSmartDupRowAndCategory();
                if (res.publisherSaveDraft) setPublishMode(true);
                if (res.publisherStrictGameSearch) setStrictGameSearch(true);
                if (res.publisherAccountCategoryPlatform === 'steam'
                    || res.publisherAccountCategoryPlatform === 'other_games') {
                    accountCategoryPlatform = res.publisherAccountCategoryPlatform;
                } else {
                    accountCategoryPlatform = 'auto';
                }
                syncAccountCategoryButtons();
                if (publisherGamePageLotCategory && res.publisherGamePageLotCategory) {
                    const okG = GAME_PAGE_LOT_CATEGORY_OPTIONS.some((o) => o.key === res.publisherGamePageLotCategory);
                    if (okG) publisherGamePageLotCategory.value = res.publisherGamePageLotCategory;
                }
                if (publisherGamePageObtainingType && res.publisherGamePageObtainingType) {
                    const okObt = STEAM_ACCOUNTS_OBTAINING_OPTIONS.some((o) => o.key === res.publisherGamePageObtainingType);
                    if (okObt) publisherGamePageObtainingType.value = res.publisherGamePageObtainingType;
                }
                if (publisherGpAccountTypeChips && res.publisherGamePageAccountType) {
                    const okTg = STEAM_ACCOUNT_TYPE_OPTIONS.some((o) => o.key === res.publisherGamePageAccountType);
                    if (okTg) {
                        const inp = publisherGpAccountTypeChips.querySelector(
                            `input[name="publisherGpAccountType"][value="${res.publisherGamePageAccountType}"]`
                        );
                        if (inp) {
                            inp.checked = true;
                            updateGpAccountTypeChipStyles();
                        }
                    }
                }
                if (publisherGamePageLevel && typeof res.publisherGamePageLevel === 'string') {
                    publisherGamePageLevel.value = res.publisherGamePageLevel;
                }
                if (publisherGpCountryChips && res.publisherGamePageCountry) {
                    const okCg = STEAM_ACCOUNT_COUNTRY_OPTIONS.some((o) => o.key === res.publisherGamePageCountry);
                    if (okCg) {
                        const inp = publisherGpCountryChips.querySelector(
                            `input[name="publisherGpCountry"][value="${res.publisherGamePageCountry}"]`
                        );
                        if (inp) {
                            inp.checked = true;
                            updateGpCountryChipStyles();
                        }
                    }
                }
                if (publisherSteamLotCategory && res.publisherSteamLotCategory) {
                    const ok = STEAM_LOT_CATEGORY_OPTIONS.some((o) => o.key === res.publisherSteamLotCategory);
                    if (ok) publisherSteamLotCategory.value = res.publisherSteamLotCategory;
                }
                if (publisherSteamObtainingType && res.publisherSteamObtainingType) {
                    const okO = STEAM_ACCOUNTS_OBTAINING_OPTIONS.some((o) => o.key === res.publisherSteamObtainingType);
                    if (okO) publisherSteamObtainingType.value = res.publisherSteamObtainingType;
                }
                if (publisherSteamAccountTypeChips && res.publisherSteamAccountType) {
                    const okT = STEAM_ACCOUNT_TYPE_OPTIONS.some((o) => o.key === res.publisherSteamAccountType);
                    if (okT) {
                        const inp = publisherSteamAccountTypeChips.querySelector(
                            `input[name="publisherSteamAccountType"][value="${res.publisherSteamAccountType}"]`
                        );
                        if (inp) {
                            inp.checked = true;
                            updateSteamAccountTypeChipStyles();
                        }
                    }
                }
                if (publisherSteamLevel && typeof res.publisherSteamLevel === 'string') {
                    publisherSteamLevel.value = res.publisherSteamLevel;
                }
                if (publisherSteamCountryChips && res.publisherSteamCountry) {
                    const okC = STEAM_ACCOUNT_COUNTRY_OPTIONS.some((o) => o.key === res.publisherSteamCountry);
                    if (okC) {
                        const inp = publisherSteamCountryChips.querySelector(
                            `input[name="publisherSteamCountry"][value="${res.publisherSteamCountry}"]`
                        );
                        if (inp) {
                            inp.checked = true;
                            updateSteamCountryChipStyles();
                        }
                    }
                }
                if (publisherOtherGamesLotCategory && res.publisherOtherGamesLotCategory) {
                    const okOg = OTHER_GAMES_LOT_CATEGORY_OPTIONS.some((o) => o.key === res.publisherOtherGamesLotCategory);
                    if (okOg) publisherOtherGamesLotCategory.value = res.publisherOtherGamesLotCategory;
                }
                if (publisherOtherGamesObtainingType && res.publisherOtherGamesObtainingType) {
                    const okOo = OTHER_GAMES_OBTAINING_OPTIONS.some((o) => o.key === res.publisherOtherGamesObtainingType);
                    if (okOo) publisherOtherGamesObtainingType.value = res.publisherOtherGamesObtainingType;
                }
                if (publisherOgAccountTypeChips && res.publisherOtherGamesAccountType) {
                    const okOt = STEAM_ACCOUNT_TYPE_OPTIONS.some((o) => o.key === res.publisherOtherGamesAccountType);
                    if (okOt) {
                        const inp = publisherOgAccountTypeChips.querySelector(
                            `input[name="publisherOgAccountType"][value="${res.publisherOtherGamesAccountType}"]`
                        );
                        if (inp) {
                            inp.checked = true;
                            updateOgAccountTypeChipStyles();
                        }
                    }
                }
                if (publisherOtherGamesLevel && typeof res.publisherOtherGamesLevel === 'string') {
                    publisherOtherGamesLevel.value = res.publisherOtherGamesLevel;
                }
                if (publisherOgCountryChips && res.publisherOtherGamesCountry) {
                    const okOc = STEAM_ACCOUNT_COUNTRY_OPTIONS.some((o) => o.key === res.publisherOtherGamesCountry);
                    if (okOc) {
                        const inp = publisherOgCountryChips.querySelector(
                            `input[name="publisherOgCountry"][value="${res.publisherOtherGamesCountry}"]`
                        );
                        if (inp) {
                            inp.checked = true;
                            updateOgCountryChipStyles();
                        }
                    }
                }
                syncPublisherGamePageRows();
                syncPublisherOtherGamesRows();
                syncPublisherSteamLotRow();
                if (publisherImageSource) {
                    if (res.publisherImgModeLocal) {
                        // Режим Папка: сначала показываем папку, затем восстанавливаем fallback
                        setImgMode(true, true);
                    } else {
                        // Режим Авто: восстанавливаем выбранный источник
                        if (res.publisherImageSource && res.publisherImageSource !== 'local_card') {
                            publisherImageSource.value = res.publisherImageSource;
                        } else {
                            publisherImageSource.value = (res.generatorMode === 'steampass_catalog') ? 'steampass' : 'steam';
                        }
                        setImgMode(false, true);
                    }
                }
                if (publisherSteamGridDbKey && res.steamgriddbApiKey) {
                    publisherSteamGridDbKey.value = res.steamgriddbApiKey;
                }
                updatePublisherImageSourceUI();
                if (res.publisherDiscountMode) setDiscountMode(true);
                if (res.publisherDiscountBase && discountBasePriceInput) {
                    discountBasePriceInput.value = res.publisherDiscountBase;
                }
                if (res.publisherDiscountSale != null && discountSalePriceInput) {
                    discountSalePriceInput.value = res.publisherDiscountSale;
                } else if (res.publisherDiscountPercent != null && res.publisherDiscountBase && discountBasePriceInput) {
                    const b = parseFloat(res.publisherDiscountBase) || 0;
                    const pct = parseFloat(res.publisherDiscountPercent) || 0;
                    if (b > 0 && pct > 0 && discountSalePriceInput) {
                        discountSalePriceInput.value = String(Math.max(1, Math.round(b * (1 - pct / 100))));
                    }
                }
                if (res.publisherDuplicateMode && res.publisherDiscountMode && res.publisherDiscountBases && res.publisherDiscountSales && discountCopyList) {
                    try {
                        const bs = JSON.parse(res.publisherDiscountBases);
                        const ss = JSON.parse(res.publisherDiscountSales);
                        syncDiscountRowsUI();
                        const inputsB = discountCopyList.querySelectorAll('.discount-base-input');
                        const inputsS = discountCopyList.querySelectorAll('.discount-sale-input');
                        bs.forEach((v, i) => { if (inputsB[i]) inputsB[i].value = v; });
                        ss.forEach((v, i) => { if (inputsS[i]) inputsS[i].value = v; });
                    } catch (_) { syncDiscountRowsUI(); }
                } else {
                    syncDiscountRowsUI();
                }
                updateDiscountPreview();
                const genMode = res.generatorMode || 'list';
                const shouldUseCatalog = res.publisherUseCatalog ?? (genMode === 'steampass_catalog');
                setGamesSourceMode(shouldUseCatalog, true);
                applyGeneratorMode(genMode);
                saveSettings();
            } catch (e) {
                console.error('[Publisher] Ошибка восстановления настроек:', e);
            } finally {
                publisherStorageRestored = true;
            }
        });

        // Restore publisher logs on open
        chrome.storage.local.get(['publisher_logs'], (r) => {
            if (r.publisher_logs && r.publisher_logs.length > 0) {
                logsDiv.textContent = r.publisher_logs.join('\n');
                logsDiv.scrollTop = logsDiv.scrollHeight;
            }
        });

        chrome.storage.onChanged.addListener((changes) => {
            if (!publisherStorageRestored) return;
            if (changes.generatorMode) {
                applyGeneratorMode(changes.generatorMode.newValue);
                setGamesSourceMode(changes.generatorMode.newValue === 'steampass_catalog');
            }
            if (changes.publisher_logs) {
                logsDiv.textContent = changes.publisher_logs.newValue.join('\n');
                logsDiv.scrollTop = logsDiv.scrollHeight;
            }
        });
    }


    gamesListInput.addEventListener('input', saveSettings);
    nameTemplateInput.addEventListener('input', saveSettings);
    commentTemplateInput.addEventListener('input', saveSettings);
    descTemplateInput.addEventListener('input', saveSettings);
    // sourceToggle is now hardcoded — no listener needed
    actionDelayInput.addEventListener('input', saveSettings);
    publishDelayInput.addEventListener('input', saveSettings);
    priceInput.addEventListener('input', saveSettings);

    function log(msg) {
        logsDiv.textContent += msg + '\n';
        logsDiv.scrollTop = logsDiv.scrollHeight;
        console.log(`[Publisher] ${msg}`);
    }

    function addOutputItem(text, link = null) {
        const div = document.createElement('div');
        div.className = 'output-item';
        if (link) {
            div.innerHTML = `✅ <a href="${link}" target="_blank">${text}</a>`;
        } else {
            div.innerHTML = `✅ ${text}`;
        }
        outputContainer.appendChild(div);
        outputContainer.scrollTop = outputContainer.scrollHeight;
    }

    function updateProgress(current, total) {
        progressText.innerText = `${current} / ${total}`;
        const percent = total > 0 ? Math.round((current / total) * 100) : 0;
        progressBar.style.width = `${percent}%`;
    }

    // Обработчик Пауза / Продолжить
    pauseBtn.addEventListener('click', () => {
        if (isPaused) {
            // Resume
            log('▶️ Возобновляю создание товаров...');
            if (pauseStatus) pauseStatus.style.display = 'none';
            chrome.runtime.sendMessage({ action: 'RESUME_PUBLISHER' }, (res) => {
                if (res && res.status === 'resumed') {
                    setRunningUI();
                } else if (res && res.status === 'nothing_to_resume') {
                    log('ℹ️ Нечего возобновлять — список исчерпан.');
                    setIdleUI();
                } else {
                    log('⚠️ Не удалось возобновить: ' + (res ? res.status : 'нет ответа'));
                }
            });
        } else {
            // Pause
            log('⏸️ Запрашиваю паузу — дождусь завершения текущего товара...');
            pauseBtn.disabled = true;
            chrome.runtime.sendMessage({ action: 'PAUSE_PUBLISHER' }, () => { });
        }
    });

    // Обработчик Старт
    startBtn.addEventListener('click', async () => {
        try {
            let games = [];

            if (useCatalog) {
                if (!catalogGames.length) {
                    alert('Сначала загрузите каталог SteamPass (нажмите «Загрузить каталог SteamPass»)!');
                    return;
                }
                games = catalogGames.map(g => ({ name: g.name, steamAppId: g.steamAppId || null, bannerUrl: g.banner, screenshotUrls: g.screenshots || [] }));
            } else {
                const gamesText = gamesListInput.value.trim();
                if (!gamesText) {
                    alert('Введите хотя бы одну игру!');
                    return;
                }
                const lines = gamesText.split('\n').map(g => g.trim()).filter(g => g.length > 0);
                games = lines.map(line => publisherRowToGameEntry(parsePublisherGameRow(line))).filter(Boolean);
            }

            if (games.length === 0) return;

            setRunningUI();

            logsDiv.textContent = '';
            outputContainer.innerHTML = '';
            chrome.storage.local.set({ publisher_logs: [] });
            const progressTotal = duplicateMode
                ? games.length * (parseInt(duplicateCountInput.value, 10) || 1)
                : games.length;
            updateProgress(0, progressTotal);

            const withCred = games.filter(g => typeof g === 'object' && g && g.itemLogin).length;
            if (!useCatalog && withCred > 0) {
                log(`🔑 Строк с логином/паролем из списка: ${withCred} (остальные — только название)`);
            }

            // Режим «Папка» задаётся флагом imgModeLocal — в <select> нет option local_card, иначе value сбрасывался бы на steam.
            const publisherImgSrc = imgModeLocal ? 'local_card' : (publisherImageSource?.value || 'steam');

            let localCardFilesByStem = null;
            if (publisherImgSrc === 'local_card') {
                if (!publisherLocalCardsFolder?.files?.length) {
                    alert('Выберите папку с готовыми карточками (PNG/JPG/WebP; имя файла совпадает с названием игры в списке).');
                    setIdleUI();
                    return;
                }
                const folderImagesCount = [...publisherLocalCardsFolder.files].filter(f => /\.(png|jpe?g|webp)$/i.test(f.name)).length;
                localCardFilesByStem = buildLocalCardFilesByStem(publisherLocalCardsFolder.files, games);
                if (!Object.keys(localCardFilesByStem).length) {
                    if (!folderImagesCount) {
                        alert('В папке нет изображений (.png, .jpg, .webp).');
                    } else {
                        alert('В папке есть картинки, но имена файлов (без расширения) не совпадают со списком игр. Проверьте написание — как в строке списка / каталога.');
                    }
                    setIdleUI();
                    return;
                }
                log(`📁 Режим папки: ${Object.keys(localCardFilesByStem).length} файлов привязано к списку (чтение по одному при каждом лоте, без загрузки всей папки в ОЗУ)${folderImagesCount > Object.keys(localCardFilesByStem).length ? `; в папке всего ${folderImagesCount} картинок` : ''}`);
            }

            let steamgriddbApiKey = (publisherSteamGridDbKey?.value || '').trim();
            if (!steamgriddbApiKey) {
                steamgriddbApiKey = await new Promise(r => chrome.storage.local.get('steamgriddbApiKey', s => (r((s.steamgriddbApiKey || '').trim()))));
            }
            if (publisherImgSrc === 'steamgriddb' && !steamgriddbApiKey) {
                alert('Нужен API-ключ SteamGridDB — введите в поле ниже или в «Редакторе шаблонов».');
                setIdleUI();
                return;
            }

            const generatorMode = await new Promise(resolve => {
                chrome.storage.local.get('generatorMode', r => resolve(r.generatorMode || 'list'));
            });

            const baseDisc = parseFloat(discountBasePriceInput.value) || 100;
            const saleDisc = parseFloat(discountSalePriceInput.value) || 90;

            const config = {
                games: games,
                nameTemplate: nameTemplateInput.value,
                commentTemplate: commentTemplateInput.value,
                descTemplate: descTemplateInput.value,
                source: sourceToggle.value,
                imageSource: publisherImgSrc,
                cardImageFallbackSource: imgModeLocal ? '' : 'steam',
                steamgriddbApiKey: steamgriddbApiKey || '',
                generatorMode,
                saveDraft,
                strictGameSearch,
                accountCategoryPlatform,
                gamePageLotCategoryKey: accountCategoryPlatform === 'auto'
                    ? (publisherGamePageLotCategory?.value || 'game_page_accounts')
                    : null,
                gamePageObtainingTypeKey: accountCategoryPlatform === 'auto'
                    && (publisherGamePageLotCategory?.value || '') === 'game_page_accounts'
                    ? (publisherGamePageObtainingType?.value || 'steam_obt_shared_offline')
                    : null,
                gamePageAccountLevel: accountCategoryPlatform === 'auto'
                    && (publisherGamePageLotCategory?.value || '') === 'game_page_accounts'
                    ? (publisherGamePageLevel?.value || '').trim()
                    : '',
                gamePageAccountCountryKey: accountCategoryPlatform === 'auto'
                    && (publisherGamePageLotCategory?.value || '') === 'game_page_accounts'
                    ? getSelectedGpCountryKey()
                    : null,
                gamePageAccountTypeKey: accountCategoryPlatform === 'auto'
                    && (publisherGamePageLotCategory?.value || '') === 'game_page_accounts'
                    ? getSelectedGpAccountTypeKey()
                    : null,
                steamLotCategoryKey: accountCategoryPlatform === 'steam'
                    ? (publisherSteamLotCategory?.value || 'steam_accounts_with_games')
                    : null,
                steamObtainingTypeKey: accountCategoryPlatform === 'steam'
                    && (publisherSteamLotCategory?.value || '') === 'steam_accounts_with_games'
                    ? (publisherSteamObtainingType?.value || 'steam_obt_shared_offline')
                    : null,
                steamAccountLevel: accountCategoryPlatform === 'steam'
                    && (publisherSteamLotCategory?.value || '') === 'steam_accounts_with_games'
                    ? (publisherSteamLevel?.value || '').trim()
                    : '',
                steamAccountCountryKey: accountCategoryPlatform === 'steam'
                    && (publisherSteamLotCategory?.value || '') === 'steam_accounts_with_games'
                    ? getSelectedSteamCountryKey()
                    : null,
                steamAccountTypeKey: accountCategoryPlatform === 'steam'
                    && (publisherSteamLotCategory?.value || '') === 'steam_accounts_with_games'
                    ? getSelectedSteamAccountTypeKey()
                    : null,
                otherGamesLotCategoryKey: accountCategoryPlatform === 'other_games'
                    ? (publisherOtherGamesLotCategory?.value || 'other_games_accounts')
                    : null,
                otherGamesObtainingTypeKey: accountCategoryPlatform === 'other_games'
                    && (publisherOtherGamesLotCategory?.value || '') === 'other_games_accounts'
                    ? getOtherGamesObtainingKey()
                    : null,
                otherGamesAccountLevel: accountCategoryPlatform === 'other_games'
                    && (publisherOtherGamesLotCategory?.value || '') === 'other_games_accounts'
                    ? (publisherOtherGamesLevel?.value || '').trim()
                    : '',
                otherGamesAccountCountryKey: accountCategoryPlatform === 'other_games'
                    && (publisherOtherGamesLotCategory?.value || '') === 'other_games_accounts'
                    ? getSelectedOgCountryKey()
                    : null,
                otherGamesAccountTypeKey: accountCategoryPlatform === 'other_games'
                    && (publisherOtherGamesLotCategory?.value || '') === 'other_games_accounts'
                    ? getSelectedOgAccountTypeKey()
                    : null,
                actionDelay: parseInt(actionDelayInput.value) || 2,
                publishDelay: parseInt(publishDelayInput.value) || 10,
                price: parseFloat(priceInput.value) || 90,
                duplicateMode: duplicateMode,
                duplicateCount: parseInt(duplicateCountInput.value) || 1,
                smartDuplicateMode: duplicateMode && smartDuplicateMode,
                smartDupAccountLevel: (publisherSteamLevel?.value || '').trim(),
                smartDupAccountCountryKey: getSelectedSteamCountryKey(),
                smartDupAccountTypeKey: getSelectedSteamAccountTypeKey(),
                copyPrices: duplicateMode ? getCopyPrices() : [],
                discountEnabled: discountMode,
                discountBasePrice: baseDisc,
                discountSalePrice: saleDisc
            };
            if (publisherImgSrc === 'local_card' && localCardFilesByStem) {
                config.localCardFilesByStem = localCardFilesByStem;
            }

            if (discountMode) {
                if (duplicateMode && discountCopyList) {
                    const bases = [...discountCopyList.querySelectorAll('.discount-base-input')].map(i => parseFloat(i.value) || 0);
                    const sales = [...discountCopyList.querySelectorAll('.discount-sale-input')].map(i => parseFloat(i.value) || 0);
                    const n = parseInt(duplicateCountInput.value, 10) || 1;
                    if (bases.length !== n || sales.length !== n) {
                        alert('Число пар «база / новая» должно совпадать с количеством копий. Обновите поля скидки.');
                        startBtn.disabled = false;
                        stopBtn.disabled = true;
                        return;
                    }
                    for (let i = 0; i < n; i++) {
                        if (!(bases[i] >= 1) || !(sales[i] >= 1)) {
                            alert(`Копия ${i + 1}: укажите базовую и новую цену (не меньше 1 ₽).`);
                            startBtn.disabled = false;
                            stopBtn.disabled = true;
                            return;
                        }
                        if (sales[i] >= bases[i]) {
                            alert(`Копия ${i + 1}: новая цена должна быть меньше базовой.`);
                            startBtn.disabled = false;
                            stopBtn.disabled = true;
                            return;
                        }
                    }
                    config.discountBasePrices = bases;
                    config.discountSalePrices = sales;
                    config.discountBasePrice = bases[0];
                    config.discountSalePrice = sales[0];
                } else {
                    if (!(saleDisc >= 1) || !(baseDisc >= 1)) {
                        alert('Укажите базовую цену и новую цену (не меньше 1 ₽).');
                        startBtn.disabled = false;
                        stopBtn.disabled = true;
                        return;
                    }
                    if (saleDisc >= baseDisc) {
                        alert('Новая цена должна быть меньше базовой (как «по скидке» на сайте).');
                        startBtn.disabled = false;
                        stopBtn.disabled = true;
                        return;
                    }
                }
            }

            log(`🚀 Запуск создания товаров...`);
            log(`📂 Всего игр: ${games.length} (${useCatalog ? 'Каталог SteamPass' : 'Свой список'})`);
            log(`🌐 Режим: ${config.source === 'steampass' ? 'SteamPass.gg' : 'Личные аккаунты'}`);
            const _srcLab = {
                steam: 'Steam', steampass: 'SteamPass', agru: 'AG.ru',
                steamgriddb: 'SteamGridDB', local_card: 'Локальная карточка (папка)'
            };
            log(`🖼️ Источник фото: ${_srcLab[config.imageSource] || config.imageSource}`);
            log(`📋 Публикация: ${saveDraft ? 'Черновик (без публикации)' : 'Сразу опубликовать'}`);
            const _steamSub = STEAM_LOT_CATEGORY_OPTIONS.find((o) => o.key === config.steamLotCategoryKey);
            const _steamObt = STEAM_ACCOUNTS_OBTAINING_OPTIONS.find((o) => o.key === config.steamObtainingTypeKey);
            const _steamC = STEAM_ACCOUNT_COUNTRY_OPTIONS.find((o) => o.key === config.steamAccountCountryKey);
            const _steamT = STEAM_ACCOUNT_TYPE_OPTIONS.find((o) => o.key === config.steamAccountTypeKey);
            const _gpSub = GAME_PAGE_LOT_CATEGORY_OPTIONS.find((o) => o.key === config.gamePageLotCategoryKey);
            const _gpObt = STEAM_ACCOUNTS_OBTAINING_OPTIONS.find((o) => o.key === config.gamePageObtainingTypeKey);
            const _gpC = STEAM_ACCOUNT_COUNTRY_OPTIONS.find((o) => o.key === config.gamePageAccountCountryKey);
            const _gpT = STEAM_ACCOUNT_TYPE_OPTIONS.find((o) => o.key === config.gamePageAccountTypeKey);
            const _ogSub = OTHER_GAMES_LOT_CATEGORY_OPTIONS.find((o) => o.key === config.otherGamesLotCategoryKey);
            const _ogObt = STEAM_ACCOUNTS_OBTAINING_OPTIONS.find((o) => o.key === config.otherGamesObtainingTypeKey);
            const _ogC = STEAM_ACCOUNT_COUNTRY_OPTIONS.find((o) => o.key === config.otherGamesAccountCountryKey);
            const _ogT = STEAM_ACCOUNT_TYPE_OPTIONS.find((o) => o.key === config.otherGamesAccountTypeKey);
            const _platLab = accountCategoryPlatform === 'steam' ? 'Steam (плитка каталога)'
                : accountCategoryPlatform === 'other_games' ? 'Другие игры (плитка каталога)'
                    : 'По игре (поиск в каталоге)';
            let _catLab;
            if (config.smartDuplicateMode) {
                _catLab = 'умное дублирование: 3+3+3; «По игре» только при точном совпадении строки с карточкой каталога, иначе 3 пропуск + Steam + другие; название в лоте как в списке';
            } else {
                _catLab = accountCategoryPlatform === 'steam'
                ? `${_platLab} → ${_steamSub ? _steamSub.label : 'подкатегория'}`
                    + (config.steamObtainingTypeKey && _steamObt ? `; передача: ${_steamObt.label}` : '')
                    + ((_steamT ? `; тип: ${_steamT.label}` : '')
                        + (_steamC ? `; страна: ${_steamC.label}` : '')
                        + (config.steamAccountLevel ? `; уровень: ${config.steamAccountLevel}` : ''))
                : accountCategoryPlatform === 'auto'
                    ? `${_platLab} → ${_gpSub ? _gpSub.label : 'подкатегория'}`
                        + (config.gamePageObtainingTypeKey && _gpObt ? `; передача: ${_gpObt.label}` : '')
                        + (config.gamePageObtainingTypeKey !== 'steam_obt_shared_offline'
                            ? ((_gpT ? `; тип: ${_gpT.label}` : '')
                                + (_gpC ? `; страна: ${_gpC.label}` : '')
                                + (config.gamePageAccountLevel ? `; уровень: ${config.gamePageAccountLevel}` : ''))
                            : '')
                    : accountCategoryPlatform === 'other_games'
                        ? `${_platLab} → ${_ogSub ? _ogSub.label : 'подкатегория'}`
                            + (config.otherGamesObtainingTypeKey && _ogObt ? `; передача: ${_ogObt.label}` : '')
                            + (config.otherGamesObtainingTypeKey !== 'steam_obt_shared_offline'
                                ? ((_ogT ? `; тип: ${_ogT.label}` : '')
                                    + (_ogC ? `; страна: ${_ogC.label}` : '')
                                    + (config.otherGamesAccountLevel ? `; уровень: ${config.otherGamesAccountLevel}` : ''))
                                : '')
                        : _platLab;
            }
            log(`📁 Категория лота: ${_catLab}`);
            log(`⏳ Инициализация GraphQL: отдельное минимизированное окно Playerok (вкладки основного окна не трогаю).`);
            if (discountMode) {
                if (duplicateMode && config.discountBasePrices) {
                    log(`🏷️ Скидки по копиям (база → новая): ${config.discountBasePrices.map((b, i) => `${Math.round(b)}→${Math.round(config.discountSalePrices[i])}`).join(' | ')}`);
                } else {
                    log(`🏷️ После создания: updateItem price: ${Math.round(saleDisc)} ₽ (база ${Math.round(baseDisc)} ₽)`);
                }
            }

            // Режим папки больше не дублирует data URL в storage (лимит ~10 MB). Старый ключ убираем при каждом старте.
            await new Promise(r => chrome.storage.local.remove('publisherLocalCardImagesMap', r));

            // Отправляем сигнал в background.js для начала работы
            if (typeof chrome !== 'undefined' && chrome.runtime) {
                chrome.runtime.sendMessage({ action: 'START_PUBLISHER', config: config }, (res) => {
                    if (chrome.runtime.lastError) {
                        log(`❌ Ошибка связи с background: ${chrome.runtime.lastError.message}`);
                        log('Попробуйте перезагрузить расширение в chrome://extensions');
                        setIdleUI();
                        return;
                    }
                    if (res && res.status === 'already_running') {
                        log('⚠️ Публикация уже запущена!');
                    } else {
                        log('✅ Публикация запущена в background...');
                    }
                });
            }
        } catch (err) {
            log(`❌ Ошибка при запуске: ${err.message}`);
            console.error('[Publisher] startBtn click error:', err);
            setIdleUI();
        }
    });

    // Обработчик Стоп
    stopBtn.addEventListener('click', () => {
        log('🛑 Отправка сигнала остановки...');

        if (typeof chrome !== 'undefined' && chrome.runtime) {
            chrome.runtime.sendMessage({ action: 'STOP_PUBLISHER' }, () => {
                log('Создание товаров остановлено.');
                setIdleUI();
            });
        } else {
            setIdleUI();
            log('Создание товаров остановлено (локальный тест).');
        }
    });

    // Слушатель событий от background / content scripts для обновления UI
    if (typeof chrome !== 'undefined' && chrome.runtime) {
        chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
            if (msg.action === 'PUBLISHER_PROGRESS') {
                updateProgress(msg.current, msg.total);
            }
            if (msg.action === 'PUBLISHER_SUCCESS') {
                addOutputItem(msg.gameName, msg.url);
            }
            if (msg.action === 'PUBLISHER_PAUSED') {
                setPausedUI(msg.remaining);
            }
            if (msg.action === 'PUBLISHER_FINISHED') {
                setIdleUI();
            }
        });
    }
});
