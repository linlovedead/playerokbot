{
const MY_ID = "1efe390d-9d9a-6550-59e9-470987b0199b";
const LIST_HASH = "22999f86b7c94a4cb525ed5549d8f24d0d24036214f02a213e8fd7cefc742bbd";

// Поле в схеме — chats (не userChats). operationName = userChats как в браузере.
const CHAT_QUERIES = [
    { name: 'userChats', query: `query userChats { chats(pagination: { first: 20 }, filter: { userId: "${MY_ID}" }) { edges { node { id lastMessage { text createdAt user { id } } } } } }` },
    { name: 'chatsFirst', query: `query chats { chats(first: 20) { edges { node { id lastMessage { text createdAt user { id } } } } } }` },
    { name: 'dealsWithChat', query: `query dealsWithChat { deals(first: 20) { edges { node { id chat { id lastMessage { text createdAt user { id } } } } } } }` },
    { name: 'viewerChats', query: `query viewerChats { viewer { chats(first: 20) { edges { node { id lastMessage { text createdAt user { id } } } } } } }` }
];

function tryGraphQL(operationName, query) {
    return fetch('https://playerok.com/graphql', {
        method: 'POST',
        credentials: 'include',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Apollo-Require-Preflight': 'true',
            'x-apollo-operation-name': operationName
        },
        body: JSON.stringify({ operationName, query })
    }).then(r => r.json());
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "SCAN_ALL_CHATS") {
        // Сначала пробуем introspection, чтобы узнать доступные поля
        if (request.introspect) {
            const introQuery = `query Introspection { __schema { queryType { fields { name } } } }`;
            tryGraphQL('Introspection', introQuery).then(json => {
                if (json?.errors) {
                    console.log("🛰 Introspection недоступен:", json.errors[0]?.message);
                    sendResponse({ success: false, error: json.errors[0]?.message, _introspect: 'disabled', chatRelated: [], fields: [] });
                    return;
                }
                const fields = json?.data?.__schema?.queryType?.fields?.map(f => f.name) || [];
                const chatRelated = fields.filter(n => /chat|conversation|message/i.test(n));
                console.log("🛰 Query-поля (chat-related):", chatRelated, "| все:", fields.slice(0, 30));
                sendResponse({ success: true, fields, chatRelated, _introspect: true });
            }).catch(e => sendResponse({ success: false, error: e.toString(), _introspect: true }));
            return true;
        }

        // Перебираем варианты запросов
        (async () => {
            for (const { name, query } of CHAT_QUERIES) {
                try {
                    const json = await tryGraphQL(name, query);
                    if (json?.errors) continue;
                    const data = json?.data || {};
                    let edges = null;
                    if (data.chats?.edges) { edges = data.chats.edges; }
                    else if (data.userChats?.edges) { edges = data.userChats.edges; }
                    else if (data.viewer?.chats?.edges) { edges = data.viewer.chats.edges; }
                    else if (data.deals?.edges) {
                        edges = data.deals.edges.map(e => {
                            const deal = e.node || e;
                            const chat = deal.chat;
                            return chat ? { node: { id: chat.id, lastMessage: chat.lastMessage } } : null;
                        }).filter(Boolean);
                    }
                    if (Array.isArray(edges)) {
                        const result = edges.map(e => {
                            const node = (e.node || e);
                            const lastMsg = node?.lastMessage || node?.last_message || node?.message;
                            const text = lastMsg?.text ?? lastMsg?.content ?? lastMsg?.body ?? "";
                            const authorId = lastMsg?.user?.id ?? lastMsg?.sender?.id ?? lastMsg?.userId;
                            return { chatId: node.id, text: String(text || ""), authorId: authorId || null, time: lastMsg?.createdAt ?? lastMsg?.created_at };
                        });
                        console.log(`🛰 Шпион: ${name} OK, ${result.length} чатов`);
                        sendResponse({ success: true, chats: result, _usedQuery: name });
                        return;
                    }
                } catch (_) {}
            }
            sendResponse({ success: false, error: "Cannot query field for chats on type Query. Запустите introspection: chrome.runtime.sendMessage({action:'SCAN_ALL_CHATS',introspect:true})" });
        })();
        return true;
    }
    if (request.action === "SCAN_ALL_CHATS_LEGACY") {
        // Старый одиночный запрос userChats (для совместимости)
        const query = `query userChats { userChats(pagination: { first: 20 }, filter: { userId: "${MY_ID}" }) { edges { node { id lastMessage { text createdAt user { id } } } } } }`;
        tryGraphQL('userChats', query).then(json => {
            if (json?.errors) {
                sendResponse({ success: false, error: json.errors[0]?.message || "GraphQL error" });
                return;
            }
            const edges = json?.data?.chats?.edges || json?.data?.userChats?.edges || [];
            const result = edges.map(e => {
                const node = e.node || e;
                const lastMsg = node.lastMessage || node.last_message || node.message;
                const text = lastMsg?.text ?? lastMsg?.content ?? lastMsg?.body ?? "";
                const authorId = lastMsg?.user?.id ?? lastMsg?.sender?.id ?? lastMsg?.userId;
                return {
                    chatId: node.id,
                    text: String(text || ""),
                    authorId: authorId || null,
                    time: lastMsg?.createdAt ?? lastMsg?.created_at
                };
            });
            console.log(`🛰 Шпион: Вижу ${result.length} чатов.`, result.length > 0 ? "Первый чат:" : "", result[0]);
            sendResponse({ success: true, chats: result, _rawKeys: Object.keys(json?.data || {}) });
        })
        .catch(err => {
            console.error("Ошибка сканера:", err);
            sendResponse({ success: false, error: err.toString() });
        });
        return true;
    }
});
console.log("🕵️‍♂️ Шпион V23: Сканер списка чатов запущен");
}
