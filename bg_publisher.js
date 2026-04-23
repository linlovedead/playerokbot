// ==========================================
// bg_publisher.js
// Загружается последним (после bg_boost.js).
// Содержит:
//   • AUTO-PUBLISHER state vars (publisherRunning, publisherPaused, publisherResumeConfig)
//   • pLog, publisherApplyItemDiscount
//   • startPublisherProcess и все вспомогательные функции:
//     applySteamSinglePlayerFromOptions, resolveAccountsGameCategoryId,
//     resolveSteamAccountRegionFromOptions, fetchObtainingTypeEdgesForCategory,
//     resolveSellGamesPageIdByListName, processSingleGamePublish и т.д.
// Доступ к глобальному стейту background.js через общий скоуп importScripts.
// ==========================================
// AUTO-PUBLISHER (API Based)
// ==========================================
let publisherRunning = false;
let publisherPaused = false;
/** Конфиг с оставшимися играми для возобновления после паузы. */
let publisherResumeConfig = null;

let _publisherLogWriting = false;
let _publisherPendingLogs = [];

async function _writePublisherLogs() {
    if (_publisherLogWriting) return;
    _publisherLogWriting = true;
    try {
        while (_publisherPendingLogs.length > 0) {
            const batch = [..._publisherPendingLogs];
            _publisherPendingLogs = [];
            const result = await new Promise(r => chrome.storage.local.get(['publisher_logs'], r));
            let logs = result.publisher_logs || [];
            logs.push(...batch);
            if (logs.length > 50) logs = logs.slice(-50);
            await new Promise(r => chrome.storage.local.set({ publisher_logs: logs }, r));
        }
    } finally {
        _publisherLogWriting = false;
    }
}

function pLog(msg) {
    const timestamp = new Date().toLocaleTimeString();
    const entry = `[${timestamp}] ${msg}`;
    chrome.runtime.sendMessage({ action: 'PUBLISHER_LOG', text: entry }).catch(() => { });
    _publisherPendingLogs.push(entry);
    _writePublisherLogs();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'START_PUBLISHER') {
        const config = msg.config;
        if (publisherRunning) {
            pLog("Уже запущен!");
            sendResponse({ status: "already_running" });
            return true;
        }
        publisherPaused = false;
        publisherResumeConfig = null;
        publisherRunning = true;
        startPublisherProcess(config);
        sendResponse({ status: "started" });
        return true;
    }
    if (msg.action === 'PAUSE_PUBLISHER') {
        if (!publisherRunning) {
            sendResponse({ status: "not_running" });
            return true;
        }
        publisherPaused = true;
        pLog("⏸️ Пауза запрошена — завершаю текущий товар...");
        sendResponse({ status: "pausing" });
        return true;
    }
    if (msg.action === 'RESUME_PUBLISHER') {
        if (publisherRunning) {
            sendResponse({ status: "already_running" });
            return true;
        }
        if (!publisherResumeConfig) {
            sendResponse({ status: "nothing_to_resume" });
            return true;
        }
        publisherPaused = false;
        publisherRunning = true;
        const cfg = publisherResumeConfig;
        publisherResumeConfig = null;
        pLog(`▶️ Возобновляю. Осталось игр: ${cfg.games.length}`);
        startPublisherProcess(cfg);
        sendResponse({ status: "resumed" });
        return true;
    }
    if (msg.action === 'STOP_PUBLISHER') {
        publisherRunning = false;
        publisherPaused = false;
        publisherResumeConfig = null;
        void clearPublisherBridgeTabIfDedicated();
        pLog("Остановлено пользователем");
        sendResponse({ status: "stopped" });
        return true;
    }
});

/**
 * После createItem: как на сайте — мутация updateItem с финальной ценой (prevPrice на сервере от базы при создании).
 * См. Network: variables.input = { id, price }, addedAttachments: null
 */
async function publisherApplyItemDiscount(itemId, basePrice, salePrice, pLog) {
    const base = Math.max(1, Math.round(Number(basePrice)));
    const sale = Math.max(1, Math.round(Number(salePrice)));
    if (sale >= base) {
        throw new Error('Новая цена должна быть меньше базовой.');
    }
    pLog(`   🏷️ updateItem: база при создании ${base} ₽ → price ${sale} ₽`);

    const MUTATION_UPDATE_ITEM = `mutation updateItem($input: UpdateItemInput!, $addedAttachments: [Upload!]) {
  updateItem(input: $input, addedAttachments: $addedAttachments) {
    id
    __typename
  }
}`;
    await playerokApi('updateItem', MUTATION_UPDATE_ITEM, {
        input: { id: itemId, price: sale },
        addedAttachments: null
    });
    pLog(`   ✅ updateItem выполнен`);
    return sale;
}

async function startPublisherProcess(config) {
    try {
    const loc = config.localCardImages;
    const fStem = config.localCardFilesByStem;
    const hasFiles = fStem && typeof fStem === 'object' && Object.keys(fStem).length > 0;
    const hasUsableLocalMap = (loc && typeof loc === 'object' && Object.keys(loc).length > 0) || hasFiles;
    if (config.imageSource === 'local_card' && !hasUsableLocalMap) {
        config.localCardImages = await new Promise(r => chrome.storage.local.get('publisherLocalCardImagesMap', s => r(s.publisherLocalCardImagesMap || null)));
    }
    const { games, source, actionDelay, publishDelay } = config;
    const duplicateMode = config.duplicateMode || false;
    const duplicateCount = Math.max(1, parseInt(config.duplicateCount, 10) || 1);
    const singlePrice = parseFloat(config.price) || 90;
    // Individual copy prices (from UI per-copy inputs)
    const copyPrices = Array.isArray(config.copyPrices) && config.copyPrices.length > 0
        ? config.copyPrices.map(p => Math.round(parseFloat(p) || singlePrice))
        : null;

    const totalItems = duplicateMode ? games.length * duplicateCount : games.length;
    const priceLog = duplicateMode
        ? (copyPrices ? `Цены: ${copyPrices.join(', ')} руб.` : `Цена: ${singlePrice} руб. x${duplicateCount}`)
        : `Цена: ${singlePrice} руб.`;
    let accPlat = String(config.accountCategoryPlatform || 'auto').toLowerCase();
    if (accPlat === 'ubisoft') accPlat = 'auto';
    const accPlatLab = accPlat === 'steam' ? 'Steam (плитка каталога)'
        : accPlat === 'other_games' ? 'Другие игры (плитка каталога)'
            : 'По игре (поиск в каталоге)';
    pLog(`Начинаем создание товаров. Игр: ${games.length}. Режим: ${source} | ${priceLog}`);
    if (config.smartDuplicateMode && duplicateMode) {
        pLog(`📁 Категория лота Playerok: умное дублирование (3+3+3; «По игре» только при точном совпадении названия с карточкой каталога — иначе 3 пропуск + 3 Steam + 3 другие; название в лоте как в списке, офлайн)`);
    } else {
        pLog(`📁 Категория лота Playerok: ${accPlatLab}`);
    }
    pLog(`🔗 Инициализирую соединение с Playerok (Bridge Tab)...`);

    if (isProcessing || isLoopRunning) {
        pLog(`ℹ️ Автодоставка/Автоподъём активны — публикация работает параллельно через общий Bridge Tab.`);
    }
    await ensurePlayerokTab();
    pLog(`✅ Bridge Tab готов. Начинаем публикацию...`);

    /** Сохраняет оставшиеся игры и уведомляет UI о паузе. */
    function applyPause(remainingGames, lastLabel) {
        publisherResumeConfig = remainingGames.length > 0 ? { ...config, games: remainingGames } : null;
        const cnt = remainingGames.length;
        pLog(`⏸️ На паузе. Осталось игр: ${cnt}${cnt > 0 ? ` (следующая: «${typeof remainingGames[0] === 'string' ? remainingGames[0] : remainingGames[0].name}»)` : '. Список исчерпан.'}`);
        chrome.runtime.sendMessage({ action: 'PUBLISHER_PAUSED', remaining: cnt, lastGame: lastLabel || '' }).catch(() => { });
        publisherRunning = false;
        publisherPaused = false;
    }

    /**
     * Умное дублирование: 3× по игре, 3× Steam, 3× другие игры (офлайн).
     * Если на странице игры нет отдельных «Аккаунты» (кроме ветки Steam) — только Steam ↔ другие игры по 3.
     */
    function applySmartDuplicateCopyCfg(baseCfg, copyIndexZero, hasGamePagePhase) {
        const obt = 'steam_obt_shared_offline';
        const snap = {
            level: String(baseCfg.smartDupAccountLevel || '').trim(),
            countryKey: baseCfg.smartDupAccountCountryKey || 'ru',
            typeKey: baseCfg.smartDupAccountTypeKey || 'steam_acct_empty',
        };
        let phase;
        if (hasGamePagePhase) {
            phase = Math.floor(copyIndexZero / 3) % 3;
        } else {
            phase = Math.floor(copyIndexZero / 3) % 2 === 0 ? 1 : 2;
        }
        const next = {
            ...baseCfg,
            accountCategoryPlatform: phase === 0 ? 'auto' : phase === 1 ? 'steam' : 'other_games',
            gamePageLotCategoryKey: null,
            gamePageObtainingTypeKey: null,
            gamePageAccountLevel: '',
            gamePageAccountCountryKey: null,
            gamePageAccountTypeKey: null,
            steamLotCategoryKey: null,
            steamObtainingTypeKey: null,
            steamAccountLevel: '',
            steamAccountCountryKey: null,
            steamAccountTypeKey: null,
            otherGamesLotCategoryKey: null,
            otherGamesObtainingTypeKey: null,
            otherGamesAccountLevel: '',
            otherGamesAccountCountryKey: null,
            otherGamesAccountTypeKey: null,
        };
        if (phase === 0) {
            next.gamePageLotCategoryKey = 'game_page_accounts';
            next.gamePageObtainingTypeKey = obt;
            next.gamePageAccountLevel = snap.level;
            next.gamePageAccountCountryKey = snap.countryKey;
            next.gamePageAccountTypeKey = snap.typeKey;
        } else if (phase === 1) {
            next.steamLotCategoryKey = 'steam_accounts_with_games';
            next.steamObtainingTypeKey = obt;
            next.steamAccountLevel = snap.level;
            next.steamAccountCountryKey = snap.countryKey;
            next.steamAccountTypeKey = snap.typeKey;
        } else {
            next.otherGamesLotCategoryKey = 'other_games_accounts';
            next.otherGamesObtainingTypeKey = obt;
            next.otherGamesAccountLevel = snap.level;
            next.otherGamesAccountCountryKey = snap.countryKey;
            next.otherGamesAccountTypeKey = snap.typeKey;
        }
        return next;
    }

    let itemsDone = 0;
    for (let i = 0; i < games.length; i++) {
        if (!publisherRunning) break;
        const gameEntry = games[i];
        const gameLabel = (typeof gameEntry === 'object' && gameEntry !== null && gameEntry.name != null)
            ? String(gameEntry.name)
            : String(gameEntry ?? '');

        const copies = duplicateMode ? duplicateCount : 1;
        let smartDupHasGamePagePhase = true;
        if (config.smartDuplicateMode && duplicateMode) {
            try {
                smartDupHasGamePagePhase = await smartDupGameHasPlainAccountsPhase(gameEntry, config, pLog);
            } catch (e) {
                pLog(`🧠 Умное дублирование: проверка «По игре» не удалась (${e.message}) — цикл без фазы «По игре».`);
                smartDupHasGamePagePhase = false;
            }
            if (!smartDupHasGamePagePhase) {
                pLog(`🧠 Для «${gameLabel}» нет фазы «По игре» — копии 1–3 пропускаются (публикаций нет); затем 3× Steam, 3× «Другие игры». Название в лоте всегда как в списке.`);
                if (copies <= 3) {
                    pLog(`⚠️ Умное дублирование: при ${copies} коп. и без «По игре» лотов не будет — для 3 Steam + 3 «Другие игры» после пропуска задайте минимум 9 копий.`);
                }
            }
        }

        for (let d = 0; d < copies; d++) {
            if (!publisherRunning) break;

            let price;
            if (duplicateMode && copyPrices) {
                price = copyPrices[d] ?? copyPrices[copyPrices.length - 1] ?? singlePrice;
            } else {
                price = singlePrice;
            }

            const copyLabel = duplicateMode ? ` (копия ${d + 1}/${copies}, цена ${price} руб.)` : '';
            pLog(`\n============================`);
            pLog(`⏳ [${itemsDone + 1}/${totalItems}] Обработка: ${gameLabel}${copyLabel}`);
            chrome.runtime.sendMessage({ action: 'PUBLISHER_PROGRESS', current: itemsDone + 1, total: totalItems }).catch(() => { });

            const skipByNoGamePage = !!(config.smartDuplicateMode && duplicateMode && !smartDupHasGamePagePhase && d < 3);
            if (skipByNoGamePage) {
                pLog(`🧠 Пропуск копии ${d + 1}/${copies} (нет фазы «По игре» — не создаём лот в чужих категориях).`);
                itemsDone++;
                if (!publisherRunning) break;
                if (d < copies - 1) {
                    pLog(`Пауза перед следующей копией ${publishDelay} сек...`);
                    for (let s = 0; s < publishDelay; s++) {
                        if (!publisherRunning || publisherPaused) break;
                        await sleep(1000);
                    }
                    if (publisherPaused) { applyPause(games.slice(i + 1), gameLabel); return; }
                }
                continue;
            }

            try {
                let copyCfg = { ...config, price };
                if (config.discountEnabled && Array.isArray(config.discountBasePrices) && Array.isArray(config.discountSalePrices)) {
                    copyCfg.discountBasePrice = config.discountBasePrices[d] ?? config.discountBasePrice;
                    copyCfg.discountSalePrice = config.discountSalePrices[d] ?? config.discountSalePrice;
                }
                if (config.smartDuplicateMode && duplicateMode) {
                    const effD = smartDupHasGamePagePhase ? d : (d - 3);
                    const innerPhase = smartDupHasGamePagePhase
                        ? Math.floor(effD / 3) % 3
                        : (Math.floor(effD / 3) % 2 === 0 ? 1 : 2);
                    const phaseLab = !smartDupHasGamePagePhase
                        ? (innerPhase === 1 ? 'Steam (аккаунты с играми)' : 'Другие игры (аккаунты)')
                        : (innerPhase === 0 ? 'По игре (аккаунты)' : innerPhase === 1 ? 'Steam (аккаунты с играми)' : 'Другие игры (аккаунты)');
                    pLog(`🧠 Умное дублирование: копия ${d + 1}/${copies} → ${phaseLab}, офлайн`);
                    copyCfg = applySmartDuplicateCopyCfg(copyCfg, effD, smartDupHasGamePagePhase);
                }
                await processSingleGamePublish(gameEntry, copyCfg);
            } catch (e) {
                pLog(`❌ Ошибка c ${gameLabel}: ${e.message}`);
            }

            itemsDone++;
            if (!publisherRunning) break;

            if (d < copies - 1) {
                pLog(`Пауза перед следующей копией ${publishDelay} сек...`);
                for (let s = 0; s < publishDelay; s++) {
                    if (!publisherRunning || publisherPaused) break;
                    await sleep(1000);
                }
                // Пауза во время задержки между копиями — ждём следующий товар (i+1)
                if (publisherPaused) { applyPause(games.slice(i + 1), gameLabel); return; }
            }
        }

        if (!publisherRunning) break;

        // ── Чекпоинт паузы после завершения всех копий игры ──
        if (publisherPaused) { applyPause(games.slice(i + 1), gameLabel); return; }

        if (i < games.length - 1) {
            pLog(`Ожидание перед следующей игрой ${publishDelay} сек...`);
            for (let s = 0; s < publishDelay; s++) {
                if (!publisherRunning || publisherPaused) break;
                await sleep(1000);
            }
            // Пауза во время задержки между играми
            if (publisherPaused) { applyPause(games.slice(i + 1), gameLabel); return; }
        }
    }

    publisherRunning = false;
    publisherPaused = false;
    publisherResumeConfig = null;
    await clearPublisherBridgeTabIfDedicated();
    chrome.runtime.sendMessage({ action: 'PUBLISHER_FINISHED' }).catch(() => { });
    } catch (e) {
        pLog(`💥 Критическая ошибка паблишера: ${e?.message || e}`);
    } finally {
        // Гарантируем сброс флага при любом завершении (нормальном, paused-return, или исключении)
        if (publisherRunning) {
            publisherRunning = false;
            publisherPaused = false;
            void clearPublisherBridgeTabIfDedicated();
        }
    }
}

/** Подстраховка атрибутов: «Аккаунт для игры в одиночном режиме» часто приходит отдельным значением в gameCategoryOptions. */
function applySteamSinglePlayerFromOptions(options, attributes, pLog) {
    const blob = (o) => [o.label, o.name, o.value, o.title, o.slug].map(x => String(x || '').toLowerCase()).join(' ');
    const pick =
        options.find(o => o && /аккаунт для игры в одиночном режиме/i.test(blob(o)))
        || options.find(o => {
            if (!o || (o.field == null && o.name == null)) return false;
            const b = blob(o);
            if (!/одиноч|singleplayer|single\s*player|\bsolo\b/i.test(b)) return false;
            return /аккаунт|режим|игр|account|mode/i.test(b) || !!o.field;
        })
        || options.find((o) => {
            if (!o) return false;
            const f = String(o.field || o.name || '').toLowerCase();
            if (/singleplayer|single_player|single-player|solo_mode|offline_mode|one_player/i.test(f)) return true;
            const b = blob(o);
            return /одиноч/.test(b) && (/режим|mode|игр|аккаунт/i.test(b) || !!o.field);
        });
    if (!pick) return;
    const f = pick.field || pick.name;
    const v = pick.value ?? pick.defaultValue;
    if (!f || v == null) return;
    attributes[f] = v;
    pLog(`   Steam: атрибут «одиночный режим» → ${f}=${v}`);
}

/** Разворачиваем gameCategoryOptions с вложенными .options, чтобы не терять характеристики. */
function flattenGameCategoryOptionRows(options) {
    const out = [];
    const visit = (item) => {
        if (item == null) return;
        const node = item.node || item;
        const nested = node && node.options;
        if (Array.isArray(nested) && nested.length > 0) {
            nested.forEach(visit);
            return;
        }
        if (node && typeof node === 'object' && (node.field != null || node.name != null || node.value != null)) {
            out.push(node);
        }
    };
    (options || []).forEach(visit);
    return out;
}

/**
 * Перед createItem: level как число; для глобальной плитки Steam «Аккаунты» сервер часто ждёт platform, хотя его нет в списке опций.
 */
function finalizePublisherAttributesForCreateItem(attributes, platformKey, useSteamStyleAccountAttrs, options, pLog) {
    const out = { ...attributes };
    if (Object.prototype.hasOwnProperty.call(out, 'level') && out.level != null && out.level !== '') {
        const n = parseInt(String(out.level), 10);
        if (!Number.isNaN(n)) out.level = n;
    }
    if (useSteamStyleAccountAttrs) {
        const platEmpty = out.platform == null || String(out.platform).trim() === '';
        if (platEmpty) {
            out.platform = 'pc';
            pLog(`   platform=pc (значение по умолчанию: в опциях категории поля platform нет, сервер всё равно требует)`);
        }
    }
    return out;
}

/** Ключи = UI / config.steamObtainingTypeKey только для «Аккаунты с играми». */
const STEAM_ACCOUNTS_OBTAINING_KEYS = new Set(['steam_obt_full', 'steam_obt_shared_offline', 'steam_obt_autoreg']);
const STEAM_ACCOUNTS_OBTAINING_LABELS = {
    steam_obt_full: 'Полный доступ',
    steam_obt_shared_offline: 'Офлайн',
    steam_obt_autoreg: 'Авторег'
};

/**
 * @param {Array<{id:string,name?:string}>} nodes
 * @param {'steam_obt_full'|'steam_obt_shared_offline'|'steam_obt_autoreg'} key
 * @param {(n:any)=>string} title
 */
function matchSteamAccountsObtainingNode(nodes, key, title) {
    if (key === 'steam_obt_autoreg') {
        return nodes.find((n) => /авторег|авто-рег/i.test(title(n))
            || (/\bавто/i.test(title(n)) && /рег/i.test(title(n))));
    }
    if (key === 'steam_obt_full') {
        return nodes.find((n) => {
            const s = title(n);
            if (/авторег|авто-рег/i.test(s)) return false;
            return /полный\s*доступ/i.test(s);
        });
    }
    if (key === 'steam_obt_shared_offline') {
        let hit = nodes.find((n) => {
            const s = title(n).toLowerCase();
            return s.includes('общий доступ') && (s.includes('офлайн') || s.includes('offline'));
        });
        if (!hit) hit = nodes.find((n) => /общий\s*доступ/i.test(title(n)));
        if (!hit) hit = nodes.find((n) => {
            const s = title(n).toLowerCase();
            return s.includes('офлайн') || s.includes('offline');
        });
        return hit || null;
    }
    return null;
}

/**
 * @param {Array<{node?:{id:string,name?:string}}>} typesEdges
 * @param {'auto'|'steam'|'other_games'} platformKey
 * @param {object} [config] — steamLotCategoryKey, steamObtainingTypeKey, otherGames*
 */
function resolveObtainingTypeId(typesEdges, platformKey, pLog, config) {
    const nodes = (typesEdges || []).map(t => t.node || t).filter(n => n && n.id);
    const title = (n) => String(n.name || '');

    if (platformKey === 'steam' && nodes.length) {
        pLog(`   Список типов: ${nodes.map(n => title(n)).join(' | ')}`);
    }

    const lotKey = config && config.steamLotCategoryKey;
    const obtKey = config && config.steamObtainingTypeKey && String(config.steamObtainingTypeKey).trim();
    const strictSteamAccounts = platformKey === 'steam'
        && lotKey === 'steam_accounts_with_games'
        && obtKey
        && STEAM_ACCOUNTS_OBTAINING_KEYS.has(obtKey);

    if (strictSteamAccounts) {
        const picked = matchSteamAccountsObtainingNode(nodes, obtKey, title);
        if (!picked?.id) {
            const lab = STEAM_ACCOUNTS_OBTAINING_LABELS[obtKey] || obtKey;
            throw new Error(
                `Способ передачи «${lab}» не найден в API для этой категории. Доступные варианты: ${nodes.map(title).join(' | ') || '(пусто)'}`
            );
        }
        pLog(`   ✅ Способ передачи (по выбору): «${title(picked)}» ID: ${picked.id}`);
        return picked.id;
    }

    const gpLot = config && config.gamePageLotCategoryKey;
    const gpObt = config && config.gamePageObtainingTypeKey && String(config.gamePageObtainingTypeKey).trim();
    const strictGamePageAccounts = platformKey === 'auto'
        && gpLot === 'game_page_accounts'
        && gpObt
        && STEAM_ACCOUNTS_OBTAINING_KEYS.has(gpObt);

    if (strictGamePageAccounts && nodes.length) {
        pLog(`   Список типов: ${nodes.map(n => title(n)).join(' | ')}`);
        const picked = matchSteamAccountsObtainingNode(nodes, gpObt, title);
        if (!picked?.id) {
            const lab = STEAM_ACCOUNTS_OBTAINING_LABELS[gpObt] || gpObt;
            throw new Error(
                `Способ передачи «${lab}» не найден в API для этой категории. Доступные варианты: ${nodes.map(title).join(' | ') || '(пусто)'}`
            );
        }
        pLog(`   ✅ Способ передачи (по игре, по выбору): «${title(picked)}» ID: ${picked.id}`);
        return picked.id;
    }

    const ogLot = config && config.otherGamesLotCategoryKey;
    const ogObt = config && config.otherGamesObtainingTypeKey && String(config.otherGamesObtainingTypeKey).trim();
    const strictOtherGamesAccounts = platformKey === 'other_games'
        && ogLot === 'other_games_accounts'
        && ogObt
        && STEAM_ACCOUNTS_OBTAINING_KEYS.has(ogObt);

    if (strictOtherGamesAccounts && nodes.length) {
        pLog(`   Список типов: ${nodes.map(n => title(n)).join(' | ')}`);
        const picked = matchSteamAccountsObtainingNode(nodes, ogObt, title);
        if (!picked?.id) {
            const lab = STEAM_ACCOUNTS_OBTAINING_LABELS[ogObt] || ogObt;
            throw new Error(
                `Способ передачи «${lab}» не найден в API для этой категории. Доступные варианты: ${nodes.map(title).join(' | ') || '(пусто)'}`
            );
        }
        pLog(`   ✅ Способ передачи (другие игры, по выбору): «${title(picked)}» ID: ${picked.id}`);
        return picked.id;
    }

    if (platformKey === 'steam') {
        let hit = nodes.find(n => {
            const s = title(n).toLowerCase();
            return s.includes('общий доступ') && (s.includes('офлайн') || s.includes('offline'));
        });
        if (!hit) hit = nodes.find(n => /общий\s*доступ/i.test(title(n)));
        if (!hit) hit = nodes.find(n => {
            const s = title(n).toLowerCase();
            return s.includes('офлайн') || s.includes('offline');
        });
        if (hit?.id) {
            pLog(`   ✅ Способ передачи (авто, офлайн): «${title(hit)}» ID: ${hit.id}`);
            return hit.id;
        }
        return null;
    }

    for (const n of nodes) {
        const s = title(n);
        if (s.includes('Общий доступ') || s.toLowerCase().includes('офлайн')) {
            pLog(`   ✅ Способ передачи: «${title(n)}» ID: ${n.id}`);
            return n.id;
        }
    }
    return null;
}

/**
 * Ключи стран = выбор в UI (auto_publisher). Сопоставление с value/label из gameCategoryOptions.field === 'region'.
 */
const STEAM_ACCOUNT_COUNTRY_META = {
    ru: { synonyms: ['ru', 'russia', 'rus', 'rf'], labels: ['росси', 'russia'] },
    kz: { synonyms: ['kz', 'kazakhstan', 'kazakh'], labels: ['казах'] },
    tr: { synonyms: ['tr', 'turkey', 'tur', 'turkiye'], labels: ['турци', 'turkey'] },
    us: { synonyms: ['us', 'usa', 'united_states', 'unitedstates'], labels: ['сша', 'america'] },
    pl: { synonyms: ['pl', 'poland'], labels: ['польш', 'poland'] },
    ar: { synonyms: ['ar', 'argentina'], labels: ['аргент', 'argentina'] },
    bg: { synonyms: ['bg', 'bulgaria'], labels: ['болгар', 'bulgaria'] },
    hu: { synonyms: ['hu', 'hungary'], labels: ['венгр', 'hungary'] },
    vn: { synonyms: ['vn', 'vietnam'], labels: ['вьетнам', 'vietnam'] },
    de: { synonyms: ['de', 'germany', 'deutschland'], labels: ['герман', 'germany'] },
    id: { synonyms: ['id', 'indonesia'], labels: ['индонез', 'indonesia'] },
    es: { synonyms: ['es', 'spain', 'espana'], labels: ['испани', 'spain'] },
    cn: { synonyms: ['cn', 'china'], labels: ['кита', 'china'] },
    ro: { synonyms: ['ro', 'romania'], labels: ['румы', 'romania'] },
    sk: { synonyms: ['sk', 'slovakia'], labels: ['словак', 'slovakia'] },
    fr: { synonyms: ['fr', 'france'], labels: ['франц', 'france'] },
    cz: { synonyms: ['cz', 'czech', 'czechia'], labels: ['чех', 'czech'] },
    ee: { synonyms: ['ee', 'estonia'], labels: ['эстон', 'estonia'] },
    other: { synonyms: ['other', 'global', 'world', 'intl', 'international', 'rest', 'misc'], labels: ['другое', 'other', 'разное'] }
};

/**
 * @param {Array<{value?:string,label?:string,name?:string,title?:string}>} regOpts
 * @param {string} countryKey — ключ из STEAM_ACCOUNT_COUNTRY_META
 */
function resolveSteamAccountRegionFromOptions(regOpts, countryKey, pLog) {
    const key = countryKey && String(countryKey).trim();
    if (!key || !STEAM_ACCOUNT_COUNTRY_META[key]) {
        throw new Error(`Неизвестный код страны: ${countryKey}`);
    }
    const meta = STEAM_ACCOUNT_COUNTRY_META[key];
    const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').trim();
    const normVal = (v) => norm(v).replace(/_/g, '');

    for (const syn of meta.synonyms) {
        const sn = normVal(syn);
        for (const o of regOpts) {
            const v = o.value;
            if (v == null || v === '') continue;
            const vn = normVal(String(v));
            if (vn === sn) {
                pLog(`   Страна аккаунта: ${v} (выбор: ${key})`);
                return v;
            }
        }
    }
    for (const o of regOpts) {
        const lab = norm(o.label || o.name || o.title || '');
        for (const frag of meta.labels) {
            if (frag && lab.includes(norm(frag))) {
                pLog(`   Страна аккаунта: ${o.value} (подпись «${o.label || o.name}»)`);
                return o.value;
            }
        }
    }
    const avail = regOpts.map(o => `${o.value}${(o.label || o.name) ? ` (${o.label || o.name})` : ''}`).join(', ');
    throw new Error(`Страна «${key}» не найдена среди регионов API. Доступно: ${avail || '(пусто)'}`);
}

/**
 * Уровень Steam из поля настроек: «20» → 20; «20-30» / «20–30» / «20 — 30» → случайное целое [min..max] на каждый лот.
 * Иное содержимое передаётся строкой как есть.
 * @returns {{ value: string, fromRange: boolean, original?: string, rangeLabel?: string }}
 */
const STEAM_ACCOUNT_TYPE_KEYS = new Set(['steam_acct_empty', 'steam_acct_progress']);

/**
 * «Тип аккаунта»: Пустой аккаунт / С прогрессом — по подписям и value из gameCategoryOptions.
 * @returns {{ field: string, value: string } | null}
 */
function resolveSteamAccountTypeAttribute(options, typeKey, pLog) {
    if (!typeKey || !STEAM_ACCOUNT_TYPE_KEYS.has(typeKey)) return null;
    const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');

    const scoreEmpty = (o) => {
        const lab = norm(o.label || o.name || o.title || '');
        const v = norm(String(o.value ?? ''));
        if (lab.includes('пустой') && (lab.includes('аккаунт') || lab.includes('аккаун'))) return 4;
        if (lab.includes('пустой')) return 2;
        if (/\bempty\b|clean|blank|new_acct|no_progress|without_progress/i.test(v)) return 2;
        return 0;
    };
    const scoreProgress = (o) => {
        const lab = norm(o.label || o.name || o.title || '');
        const v = norm(String(o.value ?? ''));
        if (lab.includes('прогресс')) return 4;
        if (/\bprogress\b|with_progress|withprogress|has_progress/i.test(v)) return 2;
        return 0;
    };

    const pickBest = (scorer) => options.reduce(
        (acc, o) => {
            const s = scorer(o);
            return s > acc.score ? { opt: o, score: s } : acc;
        },
        { opt: null, score: 0 }
    );

    const wantEmpty = typeKey === 'steam_acct_empty';
    const { opt: chosen, score } = wantEmpty ? pickBest(scoreEmpty) : pickBest(scoreProgress);
    const labelNeed = wantEmpty ? 'Пустой аккаунт' : 'С прогрессом';

    if (!chosen || score < 2) {
        const hints = [...new Set(options.map((o) => (o.label || o.name || o.field || '')).filter(Boolean))].slice(0, 30);
        throw new Error(
            `Тип аккаунта «${labelNeed}» не найден в опциях API. Фрагмент подписей: ${hints.join(' | ') || '(нет)'}`
        );
    }
    const field = chosen.field || chosen.name;
    if (!field) {
        throw new Error('Тип аккаунта: у выбранной опции нет field');
    }
    pLog(`   Тип аккаунта: ${field}=${chosen.value} («${chosen.label || chosen.name || ''}»)`);
    return { field, value: chosen.value };
}

function resolveSteamLevelValueForListing(raw) {
    const s = String(raw || '').trim();
    if (!s) return { value: '', fromRange: false };
    const rangeM = s.match(/^(\d+)\s*[-–—]\s*(\d+)$/u);
    if (rangeM) {
        let a = parseInt(rangeM[1], 10);
        let b = parseInt(rangeM[2], 10);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return { value: s, fromRange: false };
        if (a > b) [a, b] = [b, a];
        const pick = a + Math.floor(Math.random() * (b - a + 1));
        return {
            value: String(pick),
            fromRange: true,
            original: s,
            rangeLabel: `${a}–${b}`
        };
    }
    if (/^\d+$/.test(s)) return { value: s, fromRange: false };
    return { value: s, fromRange: false };
}

/** Подкатегории раздела Steam (ключ — то же, что в UI auto_publisher / config.steamLotCategoryKey). */
const STEAM_LOT_CATEGORY_LABELS = {
    steam_topup: 'Пополнение баланса',
    steam_games: 'Игры',
    steam_accounts_with_games: 'Аккаунты с играми',
    steam_region_change: 'Смена региона',
    steam_clean_accounts: 'Чистые аккаунты',
    steam_services: 'Услуги',
    steam_items: 'Предметы',
    steam_other: 'Другое',
    steam_awards: 'Награды Steam',
    steam_rent: 'Аренда'
};

/**
 * @param {Array<{id:string,name?:string,slug?:string}>} cats
 * @param {string} steamLotCategoryKey
 * @param {(c:any)=>boolean} noUbi
 * @param {(s:string)=>string} norm
 */
function pickSteamLotCategoryNode(cats, steamLotCategoryKey, noUbi, norm) {
    const targetLabel = STEAM_LOT_CATEGORY_LABELS[steamLotCategoryKey];
    if (!targetLabel) return null;
    const nt = norm(targetLabel);
    const pool = (cats || []).filter(noUbi);
    const exact = pool.find(c => norm(c.name) === nt);
    if (exact?.id) return exact;
    if (nt.length >= 6) {
        const loose = pool.find(c => {
            const cn = norm(c.name);
            return cn.includes(nt) || nt.includes(cn);
        });
        if (loose?.id) return loose;
    }
    return null;
}

/** Подкатегории на странице конкретной игры (шаг «Выберите категорию»). Ключ = UI / config.gamePageLotCategoryKey. */
const GAME_PAGE_LOT_CATEGORY_LABELS = {
    game_page_keys: 'Ключи',
    game_page_accounts: 'Аккаунты',
    game_page_rent: 'Аренда',
    game_page_other: 'Другое',
    game_page_services: 'Услуги'
};

/**
 * Ветки вроде «Аккаунты с играми» / Steam — не считать «Аккаунты» для режима «По игре»,
 * иначе умное дублирование отдаёт первые 3 копии в ту же витрину, что и фаза «Steam».
 */
function isSteamishAccountsLotCategory(c, norm) {
    const n = norm(c?.name || '');
    const sl = norm(c.slug || '');
    if (n.includes('ubisoft') || sl.includes('ubisoft')) return false;
    if (n.includes('steam') || sl.includes('steam')) return true;
    if (n.includes('аккаунты с играми') || n.includes('аккаунт с играми')) return true;
    if (n.includes('играми') && (n.includes('аккаунт') || n.includes('аккаунты'))) return true;
    if (sl.includes('accounts-with-games') || sl.includes('accounts_with_games') || sl.includes('accountswithgames')) return true;
    return false;
}

/**
 * @param {Array<{id:string,name?:string,slug?:string}>} pool
 * @param {string} gamePageLotCategoryKey
 * @param {(s:string)=>string} norm
 */
function _pickGamePageLotCategoryNodeFromPool(pool, gamePageLotCategoryKey, norm) {
    const targetLabel = GAME_PAGE_LOT_CATEGORY_LABELS[gamePageLotCategoryKey];
    if (!targetLabel) return null;
    const nt = norm(targetLabel);
    const cats = pool || [];
    const exact = cats.find(c => norm(c.name) === nt);
    if (exact?.id) return exact;
    const slugNeedles = {
        game_page_keys: ['key', 'keys', 'ключ'],
        game_page_accounts: ['account', 'accounts', 'аккаунт'],
        game_page_rent: ['rent', 'rental', 'аренд'],
        game_page_other: ['other', 'друг'],
        game_page_services: ['service', 'услуг', 'услуги']
    };
    const needles = slugNeedles[gamePageLotCategoryKey] || [];
    for (const h of needles) {
        const nh = norm(h);
        const bySlug = cats.find(c => norm(c.slug || '').includes(nh));
        if (bySlug?.id) return bySlug;
    }
    if (nt.length >= 4) {
        const loose = cats.find(c => {
            const cn = norm(c.name);
            return cn.includes(nt) || nt.includes(cn);
        });
        if (loose?.id) return loose;
    }
    return null;
}

/**
 * @param {Array<{id:string,name?:string,slug?:string}>} cats
 * @param {string} gamePageLotCategoryKey
 * @param {(s:string)=>string} norm
 */
function pickGamePageLotCategoryNode(cats, gamePageLotCategoryKey, norm) {
    if (gamePageLotCategoryKey === 'game_page_accounts') {
        const plainPool = (cats || []).filter(c => !isSteamishAccountsLotCategory(c, norm));
        const preferred = _pickGamePageLotCategoryNodeFromPool(plainPool, gamePageLotCategoryKey, norm);
        if (preferred?.id) return preferred;
    }
    return _pickGamePageLotCategoryNodeFromPool(cats || [], gamePageLotCategoryKey, norm);
}

/** Ключ UI `other_games_accounts` → `game_page_accounts` для общего pickGamePageLotCategoryNode. */
function otherGamesPickKeyToGamePageKey(k) {
    if (!k || typeof k !== 'string' || !k.startsWith('other_games_')) return null;
    return `game_page_${k.slice('other_games_'.length)}`;
}

/**
 * Категория лота «Аккаунты» на Playerok: общая или привязка к Steam и т.п.
 * @param {Array<{id:string,name?:string,slug?:string}>} cats
 * @param {'auto'|'steam'|'other_games'} platform
 * @param {string|null} [steamLotCategoryKey] — при platform === 'steam' имя подкатегории из UI
 * @param {string|null} [gamePageLotCategoryKey] — при platform === 'auto' подкатегория на странице игры (Ключи, Аккаунты, …)
 * @param {string|null} [otherGamesLotCategoryKey] — при platform === 'other_games' подкатегория у плитки «Другие игры»
 * @returns {{ id: string, label: string, steamUsedGenericFallback?: boolean }}
 */
function resolveAccountsGameCategoryId(cats, platform, steamLotCategoryKey, gamePageLotCategoryKey, otherGamesLotCategoryKey) {
    const norm = (s) => String(s || '').toLowerCase();
    const listLabel = () => (cats || []).map(c => `${c.name || '?'} [${c.slug || '—'}]`).join('; ');

    if (!cats || !cats.length) {
        throw new Error('Список категорий игры пуст');
    }

    const generic = cats.find(c => c.name === 'Аккаунты' || c.slug === 'accounts');
    const genericId = generic?.id;

    if (!platform || platform === 'auto') {
        const gpKey = gamePageLotCategoryKey && String(gamePageLotCategoryKey).trim();
        if (gpKey && GAME_PAGE_LOT_CATEGORY_LABELS[gpKey]) {
            const picked = pickGamePageLotCategoryNode(cats, gpKey, norm);
            if (picked?.id) {
                return { id: picked.id, label: picked.name || GAME_PAGE_LOT_CATEGORY_LABELS[gpKey] };
            }
            throw new Error(
                `Подкатегория «${GAME_PAGE_LOT_CATEGORY_LABELS[gpKey]}» не найдена для этой игры. Доступно: ${listLabel()}`
            );
        }
        if (!genericId) throw new Error(`Категория «Аккаунты» не найдена. Доступно: ${listLabel()}`);
        return { id: genericId, label: generic.name || 'Аккаунты' };
    }

    if (platform === 'steam') {
        const noUbi = (c) => {
            const n = norm(c.name);
            const sl = norm(c.slug || '');
            return !n.includes('ubisoft') && !sl.includes('ubisoft');
        };
        const key = steamLotCategoryKey && String(steamLotCategoryKey).trim();
        if (key && STEAM_LOT_CATEGORY_LABELS[key]) {
            const picked = pickSteamLotCategoryNode(cats, key, noUbi, norm);
            if (picked?.id) {
                return { id: picked.id, label: picked.name || STEAM_LOT_CATEGORY_LABELS[key] };
            }
            throw new Error(
                `Подкатегория Steam «${STEAM_LOT_CATEGORY_LABELS[key]}» не найдена в ответе API для этой карточки. Доступно: ${listLabel()}`
            );
        }
        const isSteamHint = (c) => {
            const n = norm(c.name);
            const sl = norm(c.slug || '');
            return n.includes('steam') || sl.includes('steam');
        };
        const isAccountsWithGames = (c) => {
            const n = norm(c.name);
            const sl = norm(c.slug || '');
            if (!noUbi(c)) return false;
            return n.includes('аккаунты с играми') || n.includes('аккаунт с играми')
                || (n.includes('играми') && (n.includes('аккаунт') || n.includes('аккаунты')))
                || sl.includes('accounts-with-games') || sl.includes('accounts_with_games')
                || sl.includes('accountswithgames');
        };

        const awgSteam = cats.find(c => isAccountsWithGames(c) && isSteamHint(c));
        const awgAny = cats.filter(isAccountsWithGames);
        const awgPick = awgSteam || awgAny.find(isSteamHint) || awgAny[0];
        if (awgPick?.id) {
            return { id: awgPick.id, label: awgPick.name || 'Аккаунты с играми (Steam)' };
        }

        const steamCat = cats.find(c => {
            if (!noUbi(c)) return false;
            const n = norm(c.name);
            const sl = norm(c.slug || '');
            return n.includes('steam') || sl.includes('steam');
        });
        if (!steamCat?.id) {
            // У части игр Playerok в API отдаёт только общую «Аккаунты» (как при ручном выборе игры и офлайн-аккаунта),
            // без отдельного узла Steam / «Аккаунты с играми» — тогда подтип и «офлайн» подбираются по режиму Steam ниже.
            if (genericId) {
                return {
                    id: genericId,
                    label: generic.name || 'Аккаунты',
                    steamUsedGenericFallback: true
                };
            }
            throw new Error(`Категория Steam / «Аккаунты с играми» не найдена для этой игры. Доступно: ${listLabel()}`);
        }
        return { id: steamCat.id, label: steamCat.name || 'Steam' };
    }

    if (platform === 'other_games') {
        const ogKey = otherGamesLotCategoryKey && String(otherGamesLotCategoryKey).trim();
        const gpMapped = ogKey && otherGamesPickKeyToGamePageKey(ogKey);
        if (gpMapped && GAME_PAGE_LOT_CATEGORY_LABELS[gpMapped]) {
            const picked = pickGamePageLotCategoryNode(cats, gpMapped, norm);
            if (picked?.id) {
                return { id: picked.id, label: picked.name || GAME_PAGE_LOT_CATEGORY_LABELS[gpMapped] };
            }
            throw new Error(
                `Подкатегория «${GAME_PAGE_LOT_CATEGORY_LABELS[gpMapped]}» не найдена для «Другие игры». Доступно: ${listLabel()}`
            );
        }
        if (!genericId) throw new Error(`Категория «Аккаунты» не найдена. Доступно: ${listLabel()}`);
        return { id: genericId, label: generic.name || 'Аккаунты' };
    }

    if (!genericId) throw new Error(`Категория «Аккаунты» не найдена. Доступно: ${listLabel()}`);
    return { id: genericId, label: generic.name || 'Аккаунты' };
}

/** Playerok иногда отвечает 403 на gameCategory* для отдельных игр (предзаказ и т.п.). */
function isPlayerokForbiddenError(err) {
    const m = String(err?.message || err || '');
    return /HTTP 403\b|FORBIDDEN|Access denied/i.test(m);
}

async function resolveOtherGamesSellGame(extSell) {
    const GENERIC_NAMES = ['другие игры', 'другое', 'other games', 'others', 'игры'];
    const resGeneric = await playerokApi('SellGames', null, { pagination: { first: 24 }, filter: { name: 'Другие игры' } }, extSell);
    const genericGames = resGeneric?.games?.edges || [];
    const node = genericGames.find(e => GENERIC_NAMES.includes(e.node.name.trim().toLowerCase()))?.node
        || genericGames[0]?.node;
    return node || null;
}

/** Карточка «Steam» на сетке выбора игры (как вручную: Steam → Аккаунты с играми). */
async function resolveSteamPlatformSellGame(extSell) {
    const res = await playerokApi('SellGames', null, { pagination: { first: 24 }, filter: { name: 'Steam' } }, extSell);
    const edges = res?.games?.edges || [];
    if (!edges.length) return null;
    const low = (s) => String(s || '').trim().toLowerCase();
    const exact = edges.find((e) => low(e.node?.name) === 'steam')?.node;
    const bySlug = edges.find((e) => low(e.node?.slug) === 'steam')?.node;
    return exact || bySlug || edges[0]?.node || null;
}

/** Как в мастере продажи: до «Способ передачи» уходит gameCategoryAgreements с userId. */
const HASH_GAME_CATEGORY_AGREEMENTS = '3ea4b047196ed9f84aa5eb652299c4bd73f2e99e9fdf4587877658d9ea6330f6';
/** Карточка категории с типами получения (обход 403 на gameCategoryObtainingTypes у части сессий). */
const HASH_GAME_PAGE_CATEGORY = '7759f743651176ddad6afefb5f2e889ec9984cae08a015281879cd61e94bdb60';

async function publisherPrefetchCategoryAgreements(gameCategoryId, userId, pLog) {
    if (!gameCategoryId || !userId) return;
    try {
        const ext = { persistedQuery: { version: 1, sha256Hash: HASH_GAME_CATEGORY_AGREEMENTS } };
        const vars = { pagination: { first: 20 }, filter: { gameCategoryId, userId } };
        await playerokApi('gameCategoryAgreements', null, vars, ext);
        pLog('   ℹ️ gameCategoryAgreements (как на сайте перед «Способ передачи»)');
    } catch (e) {
        pLog(`   ⚠️ gameCategoryAgreements: ${(e && e.message) ? e.message.slice(0, 160) : e}`);
    }
}

function findObtainingTypeEdgesInGameCategory(cat) {
    if (!cat || typeof cat !== 'object') return null;
    const keys = ['gameCategoryObtainingTypes', 'obtainingTypes', 'categoryObtainingTypes'];
    for (const k of keys) {
        const e = cat[k]?.edges;
        if (Array.isArray(e) && e.length) return e;
    }
    for (const k of Object.keys(cat)) {
        const v = cat[k];
        if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
        const e = v.edges;
        if (!Array.isArray(e) || !e.length || !e[0]?.node?.id) continue;
        const n = e[0].node;
        if (n.name != null && (n.gameCategoryId != null || n.sequence != null)) return e;
    }
    return null;
}

async function fetchObtainingTypeEdgesForCategory(accountsCatId, extObt, pLog) {
    const varsObt = { pagination: { first: 20 }, filter: { gameCategoryId: accountsCatId } };
    let types = [];
    try {
        const resObt = await playerokApi('gameCategoryObtainingTypes', null, varsObt, extObt);
        types = resObt?.gameCategoryObtainingTypes?.edges || resObt?.edges || [];
    } catch (e) {
        if (!isPlayerokForbiddenError(e)) throw e;
        pLog(`   ⚠️ gameCategoryObtainingTypes отклонён — пробую GamePageCategory…`);
    }
    if (!types.length) {
        const extGpc = { persistedQuery: { version: 1, sha256Hash: HASH_GAME_PAGE_CATEGORY } };
        const resGpc = await playerokApi('GamePageCategory', null, { id: accountsCatId }, extGpc);
        const edges = findObtainingTypeEdgesInGameCategory(resGpc?.gameCategory);
        if (edges?.length) {
            types = edges;
            pLog(`   ✅ Типы передачи взяты из GamePageCategory (${types.length})`);
        }
    }
    return types;
}

/**
 * Карточка игры в SellGames по строке списка (режим «авто» и Steam «страница игры»).
 * @param {string} searchName — для filter.name
 * @param {string} titleName — всегда используется как название в лоте (как в списке), без подмены на карточку каталога
 * @returns {{ gameId: string, actualGameName: string, usedGenericCatalogFallback: boolean, exactCatalogMatch: boolean, matchedCatalogName?: string }}
 */
async function resolveSellGamesPageIdByListName(searchName, titleName, strictGameSearch, extSell, pLog) {
    const listTitle = String(titleName ?? '').trim();
    const varsSell = { pagination: { first: 24 }, filter: { name: searchName } };
    const resSell = await playerokApi('SellGames', null, varsSell, extSell);
    const gamesFound = resSell?.games?.edges || [];
    if (gamesFound.length === 0) throw new Error('Игра не найдена в поиске');

    const GENERIC_NAMES = ['другие игры', 'другое', 'other games', 'others', 'игры'];
    let gameNode = gamesFound.find((e) => e.node.name.toLowerCase() === searchName.trim().toLowerCase())?.node;
    const exactMatchFound = !!gameNode;

    if (!exactMatchFound && strictGameSearch) {
        let genericNode = gamesFound.find((e) => GENERIC_NAMES.includes(e.node.name.trim().toLowerCase()))?.node;
        if (!genericNode) {
            pLog(`   🔍 Точное совпадение не найдено. Ищу категорию «Другие игры»...`);
            const resGeneric = await playerokApi('SellGames', null, { pagination: { first: 24 }, filter: { name: 'Другие игры' } }, extSell);
            const genericGames = resGeneric?.games?.edges || [];
            genericNode = genericGames.find((e) => GENERIC_NAMES.includes(e.node.name.trim().toLowerCase()))?.node
                || genericGames[0]?.node;
        }
        if (!genericNode) {
            throw new Error(`Игра "${listTitle}" не найдена точно, и категория «Другие игры» тоже не найдена`);
        }
        pLog(`   ⚠️ Точного совпадения нет → карточка каталога «${genericNode.name}» (ID: ${genericNode.id}). Название в лоте: «${listTitle}» (как в списке)`);
        return {
            gameId: genericNode.id,
            actualGameName: listTitle,
            usedGenericCatalogFallback: true,
            exactCatalogMatch: false,
            matchedCatalogName: genericNode.name
        };
    }

    if (!exactMatchFound) gameNode = gamesFound[0].node;
    const matchedName = gameNode.name;
    pLog(`   ✅ Карточка каталога «${matchedName}» (ID: ${gameNode.id}). Название в лоте: «${listTitle}» (как в списке)`);
    return {
        gameId: gameNode.id,
        actualGameName: listTitle,
        usedGenericCatalogFallback: false,
        exactCatalogMatch: exactMatchFound,
        matchedCatalogName: matchedName
    };
}

/**
 * Для умного дублирования: есть ли на странице игры «обычные» аккаунты без ветки Steam / «с играми».
 */
async function smartDupGameHasPlainAccountsPhase(gameEntry, config, pLog) {
    const HASH_SELL = 'e1b724d0d9c60001ebea9a782a6070156fbb4e9ce4c39f7305446ee2ad599073';
    const HASH_CATEGORIES = 'bae7bf0752ed8dbad42bd590d8a2bc908a86650c9ab9e69abb340c3b0f0a4718';
    const gameObj = (typeof gameEntry === 'object' && gameEntry !== null) ? gameEntry : null;
    let actualGameName = gameObj ? gameObj.name : gameEntry;
    const rawGameName = String(actualGameName ?? '');
    const extSell = { persistedQuery: { version: 1, sha256Hash: HASH_SELL } };
    const extCat = { persistedQuery: { version: 1, sha256Hash: HASH_CATEGORIES } };
    pLog(`🧠 Проверка категории «По игре» для умного дублирования: ${rawGameName}`);
    const resolved = await resolveSellGamesPageIdByListName(
        actualGameName,
        rawGameName,
        !!config.strictGameSearch,
        extSell,
        pLog
    );
    if (resolved.usedGenericCatalogFallback || !resolved.exactCatalogMatch) {
        pLog(`🧠 В каталоге нет карточки с тем же названием, что в списке (часто так бывает без строгого поиска) — фаза «По игре» отключена: первые 3 копии без публикации, далее Steam / «Другие игры» (без лишних лотов в «Другие игры» на этапе «по игре»).`);
        return false;
    }
    const resCat = await playerokApi('gameWithCategories', null, { id: resolved.gameId }, extCat);
    let cats = [];
    if (resCat?.game?.categories) cats = resCat.game.categories;
    else if (resCat?.game?.profile?.categories) cats = resCat.game.profile.categories;
    else if (resCat?.gameProfile?.categories) cats = resCat.gameProfile.categories;
    else if (resCat?.categories) cats = resCat.categories;
    if (!cats.length) return false;
    const norm = (s) => String(s || '').toLowerCase();
    const plainPool = cats.filter(c => !isSteamishAccountsLotCategory(c, norm));
    const hit = _pickGamePageLotCategoryNodeFromPool(plainPool, 'game_page_accounts', norm);
    return !!(hit && hit.id);
}

async function processSingleGamePublish(gameName, config) {
    // gameName: string | { name, steamAppId?, bannerUrl?, screenshotUrls?, itemLogin?, itemPassword? }
    const gameObj = (typeof gameName === 'object' && gameName !== null) ? gameName : null;
    const listingTitle = String(gameObj ? gameObj.name : gameName ?? '').trim();
    let actualGameName = listingTitle;

    try {
        const HASH_SELL = "e1b724d0d9c60001ebea9a782a6070156fbb4e9ce4c39f7305446ee2ad599073";
        const HASH_CATEGORIES = "bae7bf0752ed8dbad42bd590d8a2bc908a86650c9ab9e69abb340c3b0f0a4718";
        const HASH_OBTAINING = "15b0991414821528251930b4c8161c299eb39882fd635dd5adb1a81fb0570aea";
        const HASH_FIELDS = "6fdadfb9b05880ce2d307a1412bc4f2e383683061c281e2b65a93f7266ea4a49";
        const HASH_OPTIONS = "ffa5a575b990f54411c60edc07558d7ee27fa60f32b08f2a0af68dd2d31ebb25";

        const rawGameName = listingTitle;
        pLog(`\n⏳ [1/1] Обработка: ${actualGameName}`);

        const extSell = { persistedQuery: { version: 1, sha256Hash: HASH_SELL } };
        let accPlatform = String(config.accountCategoryPlatform || 'auto').toLowerCase();
        if (accPlatform === 'ubisoft') accPlatform = 'auto';
        const platformKey = (accPlatform === 'steam' || accPlatform === 'other_games')
            ? accPlatform
            : 'auto';

        let gameId = null;

        if (platformKey === 'steam') {
            actualGameName = rawGameName;
            pLog(`1. Режим Steam: только плитка «Steam» в каталоге (подкатегория — как в настройках); название товара в лоте — «${rawGameName}» из списка`);
            const steamNode = await resolveSteamPlatformSellGame(extSell);
            if (!steamNode?.id) throw new Error('Раздел «Steam» не найден в каталоге Playerok (поиск SellGames по имени «Steam»)');
            gameId = steamNode.id;
            pLog(`   ✅ Карточка каталога: «${steamNode.name}» (ID: ${gameId}). Название товара в лоте: «${rawGameName}»`);
        } else if (platformKey === 'other_games') {
            actualGameName = rawGameName;
            pLog(`1. Режим «Другие игры»: плитка каталога; каждая строка списка — отдельный лот «${rawGameName}»`);
            const ogNode = await resolveOtherGamesSellGame(extSell);
            if (!ogNode?.id) throw new Error('Карточка «Другие игры» не найдена в каталоге Playerok');
            gameId = ogNode.id;
            pLog(`   ✅ Карточка: «${ogNode.name}» (ID: ${gameId}). Название товара в лоте: «${rawGameName}»`);
        } else {
            pLog(`1. Поиск ID игры: ${listingTitle}`);
            const resolved = await resolveSellGamesPageIdByListName(
                listingTitle,
                rawGameName,
                !!config.strictGameSearch,
                extSell,
                pLog
            );
            gameId = resolved.gameId;
            actualGameName = resolved.actualGameName;
        }

        const useSteamStyleAccountAttrs = (platformKey === 'steam' && config.steamLotCategoryKey === 'steam_accounts_with_games')
            || (platformKey === 'auto' && config.gamePageLotCategoryKey === 'game_page_accounts')
            || (platformKey === 'other_games' && config.otherGamesLotCategoryKey === 'other_games_accounts');
        /** Офлайн без деталей в характеристиках — только «По игре» и «Другие игры» (у плитки Steam поля остаются в UI и в API). */
        const obtainingIsOffline = platformKey === 'steam'
            ? config.steamObtainingTypeKey === 'steam_obt_shared_offline'
            : platformKey === 'other_games'
                ? config.otherGamesObtainingTypeKey === 'steam_obt_shared_offline'
                : config.gamePageObtainingTypeKey === 'steam_obt_shared_offline';
        const accountsOfflineNoSteamDetails = obtainingIsOffline
            && ((platformKey === 'auto' && config.gamePageLotCategoryKey === 'game_page_accounts')
                || (platformKey === 'other_games' && config.otherGamesLotCategoryKey === 'other_games_accounts'));

        await sleep(config.actionDelay * 1000);

        let gameIdForCategories = gameId;
        let accountsCatId;
        let accountsCatLabel;
        let accResolved;
        let offlineTypeId;
        const extCat = { persistedQuery: { version: 1, sha256Hash: HASH_CATEGORIES } };
        const extObt = { persistedQuery: { version: 1, sha256Hash: HASH_OBTAINING } };

        let viewerId = MY_USER_ID || currentUserId;
        if (!viewerId) {
            try {
                const vd = await playerokApi('viewer', VIEWER_QUERY, {});
                viewerId = vd?.viewer?.id || null;
            } catch (_) { /* bridge ещё не прогрелся */ }
        }

        for (let obtPass = 0; obtPass < 2; obtPass++) {
            // 2. Получение ID Категории "Аккаунты"
            pLog(`2. Запрос категорий...`);
            const varsCat = { id: gameIdForCategories };
            const resCat = await playerokApi('gameWithCategories', null, varsCat, extCat);

            let cats = [];
            if (resCat?.game?.categories) cats = resCat.game.categories;
            else if (resCat?.game?.profile?.categories) cats = resCat.game.profile.categories;
            else if (resCat?.gameProfile?.categories) cats = resCat.gameProfile.categories;
            else if (resCat?.categories) cats = resCat.categories;

            pLog(`   📂 Категории игры (${cats.length}): ${cats.map(c => c.name || c.slug || '?').join(', ')}`);
            accResolved = resolveAccountsGameCategoryId(
                cats,
                platformKey,
                platformKey === 'steam' ? (config.steamLotCategoryKey || null) : null,
                platformKey === 'auto' ? (config.gamePageLotCategoryKey || null) : null,
                platformKey === 'other_games' ? (config.otherGamesLotCategoryKey || null) : null
            );
            accountsCatId = accResolved.id;
            accountsCatLabel = accResolved.label;
            if (accResolved.steamUsedGenericFallback) {
                pLog(`   ℹ️ Steam: отдельной ветки Steam в API нет — лот в общей «${accountsCatLabel}», тип получения — как для Steam (офлайн).`);
            }
            const _modeLab = platformKey === 'auto' ? 'по игре' : platformKey === 'other_games' ? 'другие игры' : platformKey;
            pLog(`   ✅ Категория лота: «${accountsCatLabel}» (режим: ${_modeLab}) ID: ${accountsCatId}`);

            await sleep(config.actionDelay * 1000);

            await publisherPrefetchCategoryAgreements(accountsCatId, viewerId, pLog);
            await sleep(config.actionDelay * 1000);

            pLog(`3. Запрос типов доступа...`);
            let types = [];
            try {
                types = await fetchObtainingTypeEdgesForCategory(accountsCatId, extObt, pLog);
            } catch (obtErr) {
                if (obtPass !== 0 || !isPlayerokForbiddenError(obtErr)) throw obtErr;
                types = [];
            }
            offlineTypeId = resolveObtainingTypeId(types, platformKey, pLog, config);
            if (offlineTypeId) {
                break;
            }
            if (obtPass === 0) {
                const fallbackGame = await resolveOtherGamesSellGame(extSell);
                if (fallbackGame?.id && fallbackGame.id !== gameIdForCategories) {
                    pLog(`   ⚠️ Не удалось выбрать способ передачи для этой игры. Повтор через «${fallbackGame.name}»; в названии лота — «${rawGameName}».`);
                    gameIdForCategories = fallbackGame.id;
                    actualGameName = rawGameName;
                    await sleep(config.actionDelay * 1000);
                    continue;
                }
            }
            throw new Error('Способ передачи не найден (см. список типов в логе). Для Steam → «Аккаунты с играми» или «По игре» → «Аккаунты» задайте вариант в интерфейсе.');
        }
        if (!offlineTypeId) throw new Error('Способ передачи не выбран — проверьте лог и настройки «Способ передачи».');

        await sleep(config.actionDelay * 1000);

        // 4. Поля ввода (тип ITEM_DATA — это логин/пароль для листинга)
        pLog(`4. Запрос полей (Логин/Пароль)...`);
        const varsFields = { pagination: { first: 20 }, filter: { gameCategoryId: accountsCatId, obtainingTypeId: offlineTypeId, type: "ITEM_DATA" } };
        const extFields = { persistedQuery: { version: 1, sha256Hash: HASH_FIELDS } };
        const resFields = await playerokApi('gameCategoryDataFields', null, varsFields, extFields);

        let fields = [];
        if (resFields?.gameCategoryDataFields?.edges) fields = resFields.gameCategoryDataFields.edges;
        else if (Array.isArray(resFields?.gameCategoryDataFields)) fields = resFields.gameCategoryDataFields;
        else if (resFields?.edges) fields = resFields.edges;
        else if (Array.isArray(resFields)) fields = resFields;
        // VERY aggressive fallback if they changed the object structure
        else if (resFields?.gameCategoryDataFields) {
            // sometimes it's an object with numbered keys or we just want its values
            if (typeof resFields.gameCategoryDataFields === 'object') {
                fields = Object.values(resFields.gameCategoryDataFields).filter(v => v && typeof v === 'object' && (v.id || v.node));
            }
        }

        const dataFieldsInput = [];

        const commentTempl = config.commentTemplate != null ? String(config.commentTemplate) : '';
        const itemComment = commentTempl.replace(/НАЗВАНИЕ ИГРЫ/g, actualGameName).trim();

        if (fields.length === 0) {
            pLog(`   ⚠️ Поля ITEM_DATA не найдены для этой категории — dataFields будет пустым.`);
        } else {
            pLog(`   ✅ Найдено полей: ${fields.length}`);

            const dummyLogin = "seller_" + Math.random().toString(36).slice(2, 10);
            const dummyPass = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6).toUpperCase() + "!";

            const credLogin = gameObj && gameObj.itemLogin != null ? String(gameObj.itemLogin).trim() : '';
            const credPass = gameObj && gameObj.itemPassword != null ? String(gameObj.itemPassword).trim() : '';
            if (credLogin || credPass) {
                pLog(`   🔑 Логин/пароль из списка (остальные поля — по правилам Playerok как раньше)`);
            }

            for (const f of fields) {
                const node = f.node ? f.node : f;
                const lbl = (node.label || '').toLowerCase();
                const fld = String(node.field || node.slug || '').toLowerCase();
                // Одно общее поле «данные для входа (логин, пароль, … комментарий в списке…)» —
                // не считать комментарием из‑за слова «комментарий» в длинной подписи.
                const isCatchAllEntryField = lbl.includes('данные для входа')
                    || lbl.includes('для входа') && lbl.includes('логин')
                    || (lbl.includes('логин') && lbl.includes('пароль'));
                const isCommentDataField = !isCatchAllEntryField && (
                    lbl.includes('комментар') || lbl.includes('comment')
                    || fld === 'comment' || fld.endsWith('_comment'));
                const isPasswordField = !isCatchAllEntryField && (
                    lbl.includes('пароль') || lbl.includes('password')
                    || (lbl.includes('pass') && !lbl.includes('комментар')));

                let val;
                if (isCommentDataField) {
                    val = itemComment;
                } else if (isCatchAllEntryField) {
                    if (credLogin && credPass) {
                        val = `login: ${credLogin} pass: ${credPass}`;
                    } else {
                        val = `login: ${dummyLogin} pass: ${dummyPass}`;
                    }
                } else if (isPasswordField) {
                    val = credPass || dummyPass;
                } else {
                    val = credLogin || dummyLogin;
                }

                if (node.id) {
                    dataFieldsInput.push({ fieldId: node.id, value: val });
                    const usedCombined = isCatchAllEntryField && credLogin && credPass && val.includes(credLogin);
                    const usedRealPass = isPasswordField && credPass && val === credPass;
                    const usedRealLogin = !isCommentDataField && !isPasswordField && !isCatchAllEntryField && credLogin && val === credLogin;
                    const displayVal = (usedCombined || usedRealPass || usedRealLogin) ? '***' : val;
                    pLog(`      Поле "${node.label || node.id}": ${isCommentDataField && !val ? '(пусто)' : displayVal}`);
                }
            }
        }

        await sleep(config.actionDelay * 1000);

        // 5. Запрос опций (чтобы заполнить required атрибуты)
        pLog(`5. Формируем атрибуты игры...`);
        const varsOpts = { id: accountsCatId };
        const extOpts = { persistedQuery: { version: 1, sha256Hash: HASH_OPTIONS } };
        const resOpts = await playerokApi('gameCategoryOptions', null, varsOpts, extOpts);
        let options = [];
        if (resOpts?.gameCategoryOptions && Array.isArray(resOpts.gameCategoryOptions)) {
            options = resOpts.gameCategoryOptions;
        } else if (resOpts?.edges) {
            options = resOpts.edges.map(e => e.node || e);
        } else if (Array.isArray(resOpts)) {
            options = resOpts;
        } else if (resOpts && typeof resOpts === 'object') {
            if (resOpts.options && Array.isArray(resOpts.options)) options = resOpts.options;
            else options = Object.values(resOpts).filter(v => v && typeof v === 'object');
        }

        if (!Array.isArray(options)) options = [];
        // Unroll 'node' wrappers safely
        options = options.map(o => o.node ? o.node : o);

        options = flattenGameCategoryOptionRows(options);

        let attributes = {};
        try {
            // platform — always 'pc'
            if (options.some(o => o.field === 'platform')) {
                attributes.platform = 'pc';
            }
            // region — для Steam «Аккаунты с играми» из UI; иначе авто global/kz/ru
            if (options.some(o => o.field === 'region')) {
                const regOpts = options.filter(o => o.field === 'region');
                const regNames = regOpts.map(o => o.value).filter(Boolean);
                const userCountryKey = useSteamStyleAccountAttrs && !accountsOfflineNoSteamDetails
                    ? (platformKey === 'steam'
                        ? config.steamAccountCountryKey
                        : platformKey === 'other_games'
                            ? config.otherGamesAccountCountryKey
                            : config.gamePageAccountCountryKey)
                    : null;
                const userCountry = userCountryKey ? String(userCountryKey).trim() : '';
                if (userCountry) {
                    attributes.region = resolveSteamAccountRegionFromOptions(regOpts, userCountry, pLog);
                } else if (regNames.includes('global')) attributes.region = 'global';
                else if (regNames.includes('kz')) attributes.region = 'kz';
                else if (regNames.includes('ru')) attributes.region = 'ru';
                else if (regNames.length > 0) attributes.region = regNames[0];
                else attributes.region = 'global';
            }
            // edition — use whatever the API provides
            if (options.some(o => o.field === 'edition')) {
                const edNames = options.filter(o => o.field === 'edition').map(o => o.value).filter(Boolean);
                if (edNames.includes('standard')) attributes.edition = 'standard';
                else if (edNames.length > 0) attributes.edition = edNames[0];
                else attributes.edition = 'standard';
            }
            // Any other fields the API returns — include them with first available value
            for (const opt of options) {
                const f = opt.field || opt.name;
                const v = opt.value ?? opt.defaultValue;
                if (!f || v == null || ['platform', 'region', 'edition'].includes(f) || (f in attributes)) continue;
                if (accountsOfflineNoSteamDetails) {
                    const lab = String(opt.label || opt.name || opt.title || '').toLowerCase();
                    const fl = String(f).toLowerCase();
                    const skipDetail = (fl.includes('level') && (fl.includes('steam') || lab.includes('уровень')))
                        || lab.includes('уровень')
                        || (lab.includes('тип') && lab.includes('аккаунт'))
                        || (fl.includes('account') && (fl.includes('type') || fl.includes('progress') || fl.includes('empty')));
                    if (skipDetail) continue;
                }
                attributes[f] = v;
            }
            if (useSteamStyleAccountAttrs) {
                const obt = platformKey === 'steam'
                    ? config.steamObtainingTypeKey
                    : platformKey === 'other_games'
                        ? config.otherGamesObtainingTypeKey
                        : config.gamePageObtainingTypeKey;
                const useSinglePlayerHint = !obt || obt === 'steam_obt_shared_offline';
                if (useSinglePlayerHint) {
                    applySteamSinglePlayerFromOptions(options, attributes, pLog);
                }
            }
            if (useSteamStyleAccountAttrs && accountsOfflineNoSteamDetails) {
                pLog('   ℹ️ Офлайн-аккаунт: не задаю тип / уровень / страну из настроек (как на сайте).');
            }
            if (useSteamStyleAccountAttrs && !accountsOfflineNoSteamDetails) {
                const typeKeySrc = platformKey === 'steam'
                    ? config.steamAccountTypeKey
                    : platformKey === 'other_games'
                        ? config.otherGamesAccountTypeKey
                        : config.gamePageAccountTypeKey;
                const typeKey = typeKeySrc && String(typeKeySrc).trim();
                if (typeKey) {
                    const typeAttr = resolveSteamAccountTypeAttribute(options, typeKey, pLog);
                    if (typeAttr) attributes[typeAttr.field] = typeAttr.value;
                }
                const lvlSrc = platformKey === 'steam'
                    ? config.steamAccountLevel
                    : platformKey === 'other_games'
                        ? config.otherGamesAccountLevel
                        : config.gamePageAccountLevel;
                const lvlRaw = lvlSrc != null ? String(lvlSrc).trim() : '';
                if (lvlRaw) {
                    const lvlOpt = options.find((o) => {
                        const f = String(o.field || o.name || '').toLowerCase();
                        const lab = String(o.label || o.name || o.title || '').toLowerCase();
                        if ((f.includes('steam') && f.includes('level'))
                            || (lab.includes('уровень') && lab.includes('steam'))
                            || (lab.includes('steam') && lab.includes('уровень'))) return true;
                        if ((platformKey === 'auto' || platformKey === 'other_games') && lab.includes('уровень')) return true;
                        return false;
                    });
                    const fieldName = lvlOpt && (lvlOpt.field || lvlOpt.name);
                    const lvlResolved = resolveSteamLevelValueForListing(lvlRaw);
                    if (fieldName && lvlResolved.value) {
                        attributes[fieldName] = lvlResolved.value;
                        if (lvlResolved.fromRange) {
                            pLog(`   Уровень Steam → ${fieldName}=${lvlResolved.value} (случайно из «${lvlResolved.original}», диапазон ${lvlResolved.rangeLabel})`);
                        } else {
                            pLog(`   Уровень Steam → ${fieldName}=${lvlResolved.value}`);
                        }
                    } else if (!fieldName) {
                        pLog(`   ⚠️ Поле уровня Steam в опциях не найдено — «${lvlRaw}» не отправлено.`);
                    }
                }
            }
            attributes = finalizePublisherAttributesForCreateItem(
                attributes,
                platformKey,
                useSteamStyleAccountAttrs,
                options,
                pLog
            );
        } catch (e) {
            pLog(`   ⚠️ Ошибка парсинга опций: ${e.message}`);
            attributes = {};
        }
        const optionsDebug = options.map(o => `${o.field || o.name}=${o.value}`).join(', ');
        pLog(`   Опции API (${options.length}): ${optionsDebug}`);
        pLog(`   Атрибуты → ${JSON.stringify(attributes)}`);

        // 6. Мутация: Create Item
        pLog(`6. Публикация черновика на сервер...`);
        const QUERY_CREATE = `mutation createItem($input: CreateItemInput!, $attachments: [Upload!]!) { createItem(input: $input, attachments: $attachments) { id slug status __typename } }`;
        const QUERY_CREATE_EMPTY = `mutation createItem($input: CreateItemInput!) { createItem(input: $input, attachments: []) { id slug status __typename } }`;

        const saleCfg = parseFloat(config.discountSalePrice);
        const discountOn = !!(config.discountEnabled && !Number.isNaN(saleCfg) && saleCfg >= 1);
        let itemPrice = Math.round(parseFloat(config.price) || 90);
        if (discountOn) {
            itemPrice = Math.max(1, Math.round(parseFloat(config.discountBasePrice) || itemPrice));
        }

        const nameTempl = config.nameTemplate || 'НАЗВАНИЕ ИГРЫ';
        const itemName = nameTempl.replace(/НАЗВАНИЕ ИГРЫ/g, actualGameName);

        const descTempl = config.descTemplate || 'Оффлайн активация "НАЗВАНИЕ ИГРЫ". Без ограничений!';
        const itemDesc = descTempl.replace(/НАЗВАНИЕ ИГРЫ/g, actualGameName);

        pLog(`   Название: "${itemName}" | Цена: ${itemPrice} руб.`);

        const baseInput = {
            gameCategoryId: accountsCatId,
            obtainingTypeId: offlineTypeId,
            attributes: attributes,
            name: itemName,
            price: itemPrice,
            description: itemDesc
        };
        if (itemComment) baseInput.comment = itemComment;
        if (dataFieldsInput.length > 0) baseInput.dataFields = dataFieldsInput;

        const createInput = { input: baseInput, attachments: [null] };

        let resCreate;
        try {
            // ── Шаг А: Создание с фото через канвас (основной путь) ─────────
            {
                const storageVal = await new Promise(r => chrome.storage.local.get(['generatorTemplate', 'generatorCoords'], r));
                const tpl = storageVal.generatorTemplate;
                const coords = storageVal.generatorCoords || {
                    banner: [91, 250, 1221, 620],
                    ss: [[91, 680, 441, 880], [481, 680, 831, 880], [871, 680, 1221, 880]]
                };

                const catalogHints = {
                    steamAppId: gameObj?.steamAppId || null,
                    bannerUrl: gameObj?.bannerUrl || null,
                    screenshotUrls: Array.isArray(gameObj?.screenshotUrls) ? gameObj.screenshotUrls : [],
                    localCardImages: config.localCardImages || null,
                    localCardFilesByStem: config.localCardFilesByStem || null,
                    steamgriddbApiKey: config.steamgriddbApiKey || ''
                };
                const assetNameCandidates = [rawGameName, actualGameName].filter((v, i, a) => v && a.indexOf(v) === i);
                let imgSrc = config.imageSource || 'steam';
                if (imgSrc === 'local_card') {
                    const nF = catalogHints.localCardFilesByStem ? Object.keys(catalogHints.localCardFilesByStem).length : 0;
                    const nI = catalogHints.localCardImages ? Object.keys(catalogHints.localCardImages).length : 0;
                    if (nF) pLog(`   📁 Локальные карточки: ${nF} файлов (читается по одной на лот)`);
                    else if (nI) pLog(`   📁 Локальных карточек в памяти (data URL): ${nI}`);
                }
                let assets = await getCardAssets(assetNameCandidates, imgSrc, catalogHints);
                if (imgSrc === 'local_card' && !assets.preRenderedCardDataUrl) {
                    const fb = (config.cardImageFallbackSource || '').trim();
                    if (fb && fb !== 'local_card') {
                        pLog(`   🖼️ Локального файла нет → резерв: ${fb}`);
                        assets = await getCardAssets(assetNameCandidates, fb, { ...catalogHints, localCardImages: null, localCardFilesByStem: null });
                    } else {
                        const hint = assetNameCandidates[0] || actualGameName || '';
                        throw new Error(
                            `Нет локальной карточки для «${hint}». Имя файла (без .png) должно совпадать со строкой в списке игр.`
                        );
                    }
                }
                const preCard = assets.preRenderedCardDataUrl || null;
                if (!preCard && (!assets.bannerUrl && !(assets.screenshotUrls && assets.screenshotUrls.some(Boolean)))) {
                    throw new Error('Нет изображений для обложки (проверь источник фото или папку с карточками).');
                }
                // ── Предзагрузка изображений в service worker для обхода CORS ──────────────
                // Контент-скрипт (playerok.com) не может загрузить картинки SteamGridDB/ag.ru
                // из-за отсутствия CORS-заголовков. Поэтому загружаем их здесь, где действуют
                // host_permissions, и передаём в bridge как base64 data URL.
                if (!preCard && (imgSrc === 'steamgriddb' || imgSrc === 'agru')) {
                    pLog(`   🔄 Предзагрузка картинок из внешнего CDN (${imgSrc}) в фоне...`);
                    try {
                        const prefetched = await prefetchImagesToDataUrls(assets.bannerUrl, assets.screenshotUrls);
                        assets = { ...assets, ...prefetched };
                        pLog(`   ✅ Предзагрузка завершена`);
                    } catch (e) {
                        pLog(`   ⚠️ Предзагрузка не удалась: ${e.message}`);
                    }
                }

                const needTplComposite = !preCard;
                if (needTplComposite && !tpl) {
                    throw new Error("Не загружен шаблон в редакторе шаблонов! Открой его и загрузи картинку.");
                }
                const TINY_PX = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
                const tplForBridge = needTplComposite ? tpl : TINY_PX;

                pLog(`   🖼️ Картинки: ${preCard ? 'готовая карточка (локальный PNG)' : `кандидаты имён → ${JSON.stringify(assetNameCandidates)}`}${catalogHints.steamAppId ? ` | AppID ${catalogHints.steamAppId}` : ''}${catalogHints.bannerUrl && catalogHints.screenshotUrls?.length ? ' | набор из каталога' : ''}`);

                pLog(`   Загружаем фото + публикуем...`);
                let lastErr = null;
                async function doCanvas(attrsVariant) {
                    createInput.input.attributes = attrsVariant;
                    if (preCard) {
                        return await playerokApiCanvas('createItem', QUERY_CREATE, createInput, tplForBridge, coords, null, null, preCard);
                    }
                    return await playerokApiCanvas('createItem', QUERY_CREATE, createInput, tpl, coords, assets.bannerUrl, assets.screenshotUrls);
                }
                for (const attrsVariant of [baseInput.attributes, {}]) {
                    try {
                        resCreate = await doCanvas(attrsVariant);
                        lastErr = null;
                        break;
                    } catch (e) {
                        const msg = e.message || '';
                        if (msg.includes('429')) {
                            pLog(`   ⏳ Rate limit (429), жду 60 сек...`);
                            await sleep(60000);
                            try {
                                resCreate = await doCanvas(attrsVariant);
                                lastErr = null;
                                break;
                            } catch (e2) { lastErr = e2; break; }
                        }
                        if (msg.includes('400')) {
                            pLog(`   ⚠️ 400 с attrs=${JSON.stringify(attrsVariant)}`);
                            lastErr = e; continue;
                        }
                        lastErr = e; break;
                    }
                }
                if (lastErr) throw lastErr;
            }
        } catch (e) {
            const errObj = e.message || String(e);
            console.error("CREATE ITEM PAYLOAD ERROR:", errObj);
            const strChunks = errObj.match(/.{1,150}/g) || [];
            for (let i = 0; i < strChunks.length; i++) {
                pLog(`   ❌ Ошибка создания (${i + 1}/${strChunks.length}): ${strChunks[i]}`);
            }
            throw new Error("Не удалось создать товар.");
        }

        if (!resCreate || !resCreate.createItem || !resCreate.createItem.id) {
            throw new Error("Не удалось извлечь ID созданного товара.");
        }
        const newItemId = resCreate.createItem.id;
        const itemSlug = resCreate.createItem.slug || newItemId;
        pLog(`   ✅ Создан черновик! ID: ${newItemId.substring(0, 8)}...`);

        await sleep(config.actionDelay * 1000);

        let publishPrice = itemPrice;
        if (discountOn) {
            publishPrice = await publisherApplyItemDiscount(
                newItemId,
                config.discountBasePrice ?? itemPrice,
                config.discountSalePrice,
                pLog
            );
            await sleep(config.actionDelay * 1000);
        }

        const basePriceRub = Math.round(itemPrice);
        const salePriceRub = Math.round(publishPrice);

        // Draft mode — stop here, don't publish
        if (config.saveDraft) {
            pLog(`📝 Сохранено в черновик! ID: ${newItemId.substring(0, 8)}...`);
            pLog(`   🔗 https://playerok.com/products/${itemSlug}`);
            await appendDashboardDraftRecord({
                title: `${actualGameName} [Черновик]`,
                basePriceRub,
                salePriceRub,
                hasDiscount: discountOn,
                url: `https://playerok.com/products/${itemSlug}`,
                itemId: newItemId,
                quantity: 1
            });
            chrome.runtime.sendMessage({
                action: 'PUBLISHER_SUCCESS',
                gameName: actualGameName + ' [Черновик]',
                url: `https://playerok.com/products/${itemSlug}`
            }).catch(() => { });
            return;
        }

        // 7. validateItemData (Эмуляция открытия модалки публикации на сайте)
        pLog(`7. Валидация товара перед публикацией...`);
        const MUTATION_VALIDATE = `mutation validateItemData($input: ValidateItemDataInput!) { validateItemData(input: $input) }`;
        await playerokApi('validateItemData', MUTATION_VALIDATE, {
            input: { itemId: newItemId, obtainingTypeId: offlineTypeId }
        });

        await sleep(config.actionDelay * 1000);

        // 8. Publish Local
        pLog(`8. Финальная публикация (бесплатная)...`);
        const QUERY_PUBLISH = `mutation publishItem($input: PublishItemInput!) { publishItem(input: $input) { id status } }`;
        const QUERY_PRIORITY = `query itemPriorityStatuses($itemId: UUID!, $price: NonNegativeFloat!) { itemPriorityStatuses(itemId: $itemId, price: $price) { id price } }`;

        const prioPriceArg = parseFloat(publishPrice);
        const resPrio = await playerokApi('itemPriorityStatuses', QUERY_PRIORITY, { itemId: newItemId, price: prioPriceArg });
        const statuses = resPrio?.itemPriorityStatuses || [];
        const slotLog = statuses.map(s => {
            const rub = s.price;
            const n = rub === null || rub === undefined ? 0 : Number(rub);
            return `${n}₽`;
        }).join(', ');
        pLog(`   📋 itemPriorityStatuses (цена лота ${Math.round(Number(publishPrice) || 0)} ₽, аргумент API ${prioPriceArg}): ${statuses.length} слот. → ${slotLog || '—'} (тарифы приоритета, не путать с ценой товара)`);
        const freeStatusId = statuses.find(s => s.price === 0 || s.price === null)?.id;
        if (!freeStatusId) throw new Error("Не найден бесплатный статус публикации");

        const publishInput = {
            input: {
                itemId: newItemId,
                transactionProviderId: "LOCAL",
                priorityStatuses: [freeStatusId]
            }
        };
        const resPublish = await playerokApi('publishItem', QUERY_PUBLISH, publishInput);

        const pubStatus = resPublish?.publishItem?.status || '';
        const okStatuses = ['PUBLISHED', 'MODERATION', 'PENDING_APPROVAL', 'ACTIVE'];
        if (okStatuses.includes(pubStatus)) {
            const statusLabel = pubStatus === 'PENDING_APPROVAL' ? '⏳ Ожидает одобрения' : '🎉 Опубликовано';
            pLog(`${statusLabel} (статус: ${pubStatus})`);
            pLog(`   🔗 https://playerok.com/products/${itemSlug}`);
            await appendDashboardPublishedRecord({
                title: actualGameName,
                basePriceRub,
                salePriceRub,
                hasDiscount: discountOn,
                url: `https://playerok.com/products/${itemSlug}`,
                itemId: newItemId,
                quantity: 1
            });
            chrome.runtime.sendMessage({
                action: 'PUBLISHER_SUCCESS',
                gameName: actualGameName,
                url: `https://playerok.com/products/${itemSlug}`
            }).catch(() => { });
            incrementDailyPair(DAILY_PUBLISHER_PUBLISHED_KEY, DAILY_PUBLISHER_PUBLISHED_DATE_KEY);
        } else {
            throw new Error(`Статус после публикации: ${pubStatus || 'нет ответа'}`);
        }

    } catch (err) {
        if (err.message && err.message.includes("ИГРА ПРОПУЩЕНА")) {
            // Already logged
        } else {
            pLog(`❌ Ошибка c ${actualGameName}: ${err.message}`);
        }
    }
}