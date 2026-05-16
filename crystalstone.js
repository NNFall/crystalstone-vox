require(Modules.Gemini);
require(Modules.ApplicationStorage);

const ANSWER_DELAY_MS = 5000;
const RINGBACK_COUNTRY = 'RU';
const TELEGRAM_MAX_TEXT_LEN = 3900;
const SUMMARY_REQUEST_TIMEOUT_MS = 12000;

const SUMMARY_FUNCTION_NAME = 'save_call_summary';

const AI_PRICE_IN_TEXT = 0.50;
const AI_PRICE_IN_AUDIO = 3.00;
const AI_PRICE_OUT_TEXT = 2.00;
const AI_PRICE_OUT_AUDIO = 12.00;
const USD_TO_RUB_RATE = 80;
const WEBSOCKET_PRICE_PER_MINUTE_RUB = 0.50;
const WS_RECONNECT_DELAY_MS = 1200;
const WS_RECONNECT_MAX_ATTEMPTS = 1;

VoxEngine.addEventListener(AppEvents.CallAlerting, async ({ call }) => {
    let geminiLiveAPIClient;
    let isSessionTerminated = false;
    let isFinalizing = false;
    let answerTimer = null;
    let summaryWaitTimer = null;
    let summaryWaitDone = null;
    let earlyMediaStarted = false;

    let telegramBotToken = 'TELEGRAM_BOT_TOKEN_REDACTED';
    let telegramAdminChatIds = [];
    let telegramUserChatIds = [];
    let googleAppsScriptWebhookUrl = '';

    let callDurationSec = 0;
    let telephonyCostRub = 0;
    let websocketDurationSec = 0;
    let websocketOpenedAtMs = null;

    let callerPhone = '';
    try {
        callerPhone = call.callerid ? String(call.callerid() || '') : '';
    } catch (e) {
        callerPhone = '';
    }

    const usageStats = {
        in_text: 0,
        in_audio: 0,
        in_video: 0,
        in_unknown: 0,
        out_text: 0,
        out_audio: 0,
        out_video: 0,
        out_unknown: 0,
        usage_events: 0
    };

    const dialogue = [];
    let currentUserParts = [];
    let currentAssistantParts = [];

    const summaryData = {
        client_name: '',
        client_phone: '',
        call_goal: '',
        manager_offer: '',
        outcome: '',
        next_step: '',
        summary: ''
    };
    let summaryReceived = false;
    let summaryRequestSent = false;
    let activeGeminiModel = '';
    let isGemini31Live = false;
    let geminiSocketAlive = false;
    let callEnded = false;
    let isStartingGemini = false;
    let reconnectAttempts = 0;
    let reconnectTimer = null;

    const safeString = (v) => (v === undefined || v === null ? '' : String(v));
    const parseJsonMaybe = (v) => {
        if (typeof v !== 'string') return null;
        try {
            return JSON.parse(v);
        } catch (e) {
            return null;
        }
    };
    const toNumber = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
    };

    const sendUserTextToModel = (text, tag) => {
        if (!geminiLiveAPIClient) {
            throw new Error('geminiLiveAPIClient is not initialized');
        }

        const payloadText = safeString(text);

        if (typeof geminiLiveAPIClient.sendRealtimeInput === 'function') {
            try {
                geminiLiveAPIClient.sendRealtimeInput({ text: payloadText });
                Logger.write(`===MODEL_TEXT_SENT_REALTIME_INPUT:${tag}===`);
                return 'realtime_input';
            } catch (e) {
                Logger.write(`===MODEL_TEXT_REALTIME_INPUT_ERROR:${tag}===`);
                Logger.write(String(e));
            }
        }

        geminiLiveAPIClient.sendClientContent({
            turns: [{ role: 'user', parts: [{ text: payloadText }] }],
            turnComplete: true
        });
        Logger.write(`===MODEL_TEXT_SENT_CLIENT_CONTENT:${tag}===`);
        return 'client_content';
    };

    const parseChatIdList = (raw) =>
        safeString(raw)
            .split(/[\n,;]+/)
            .map((x) => x.trim())
            .filter((x) => x.length > 0);

    const dedupeList = (arr) => {
        const out = [];
        const seen = {};
        arr.forEach((x) => {
            if (!seen[x]) {
                seen[x] = true;
                out.push(x);
            }
        });
        return out;
    };

    const normalizeText = (text) =>
        safeString(text)
            .replace(/\s+/g, ' ')
            .replace(/\s+([,.;:!?])/g, '$1')
            .trim();

    const sanitizeForSummary = (text) =>
        normalizeText(text)
            .replace(/[^\u0400-\u04FFA-Za-z0-9\s.,!?;:()"%+\-]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

    const clipText = (text, maxLen) => {
        const clean = sanitizeForSummary(text);
        if (clean.length <= maxLen) return clean;
        const cut = clean.slice(0, maxLen);
        return cut.replace(/\s+\S*$/, '').trim();
    };

    const normalizeName = (name) => {
        const clean = sanitizeForSummary(name).replace(/[^A-Za-z\u0400-\u04FF\-]/g, '').trim();
        if (!clean) return '';
        return clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase();
    };
    const hasReadableWords = (text) => /[A-Za-z\u0400-\u04FF]{3,}/.test(safeString(text));
    const isFillerPhrase = (text) =>
        /^(?:\u0434\u0430|\u0443\u0433\u0443|\u043e\u043a|\u043e\u043a\u0435\u0439|\u0445\u043e\u0440\u043e\u0448\u043e|\u043f\u043e\u043d\u044f\u043b(?:\u0430)?|\u043b\u0430\u0434\u043d\u043e|\u044f\u0441\u043d\u043e|\u0441\u043f\u0430\u0441\u0438\u0431\u043e|da|yes|no|si|ciao|alo|allo)\.?$/i.test(
            safeString(text).trim()
        );
    const extractClientNameFromDialogue = () => {
        let askedNameRecently = false;
        for (let i = 0; i < dialogue.length; i += 1) {
            const item = dialogue[i];
            const text = sanitizeForSummary(item.text);
            if (!text) continue;
            if (item.role === 'assistant') {
                if (/(?:\u043a\u0430\u043a\s+\u0432\u0430\u0441\s+\u0437\u043e\u0432\u0443\u0442|\u0432\u0430\u0448\u0435\s+\u0438\u043c\u044f|\u043f\u0440\u0435\u0434\u0441\u0442\u0430\u0432\u044c\u0442)/i.test(text)) {
                    askedNameRecently = true;
                }
                continue;
            }
            const direct = text.match(/\b\u043c\u0435\u043d\u044f\s+\u0437\u043e\u0432\u0443\u0442\s+([A-Za-z\u0400-\u04FF\-]{2,30})\b/i);
            if (direct && direct[1]) return normalizeName(direct[1]);
            if (askedNameRecently) {
                const candidate = text.match(/\b([A-Za-z\u0400-\u04FF\-]{2,30})\b/);
                if (
                    candidate &&
                    candidate[1] &&
                    !/^(?:\u0434\u0430|\u0443\u0433\u0443|\u043e\u043a|\u0445\u043e\u0440\u043e\u0448\u043e|\u043d\u0435\u0442|da|yes|no)$/i.test(candidate[1])
                ) {
                    return normalizeName(candidate[1]);
                }
                askedNameRecently = false;
            }
        }
        return '';
    };
    const collectRolePhrases = (role, maxItems, maxItemLen) => {
        const result = [];
        for (let i = 0; i < dialogue.length; i += 1) {
            const item = dialogue[i];
            if (!item || item.role !== role) continue;
            const clean = clipText(sanitizeForSummary(item.text), maxItemLen);
            if (!clean || !hasReadableWords(clean) || isFillerPhrase(clean)) continue;
            result.push(clean);
            if (result.length >= maxItems) break;
        }
        return result;
    };
    const escapeHtml = (text) =>
        safeString(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    const toFixedNumber = (value, digits) => Number(toNumber(value).toFixed(digits));

    const finalizePhrase = (role, parts, status = 'complete') => {
        const text = normalizeText(parts.join(''));
        parts.length = 0;
        if (!text) return;
        dialogue.push({ role, text, status });
    };

    const ensureDialogueFinalized = () => {
        if (currentUserParts.length) finalizePhrase('user', currentUserParts, 'partial');
        if (currentAssistantParts.length) finalizePhrase('assistant', currentAssistantParts, 'partial');
    };

    const buildReconnectDialogueContext = (maxReplicas = 8) => {
        ensureDialogueFinalized();
        if (!dialogue.length) return '';

        const tail = dialogue.slice(-maxReplicas);
        const lines = tail
            .map((item) => {
                const speaker = item.role === 'user' ? 'Клиент' : 'Агент';
                const text = clipText(normalizeText(item.text), 180);
                if (!text) return '';
                return `${speaker}: ${text}`;
            })
            .filter((x) => x.length > 0);

        return lines.join('\n');
    };

    const getModalityCounts = (details) => {
        const result = { TEXT: 0, AUDIO: 0, VIDEO: 0, UNKNOWN: 0 };
        (details || []).forEach((item) => {
            const modality = safeString(item && item.modality).toUpperCase();
            const count = toNumber(item && item.tokenCount);
            if (modality === 'TEXT' || modality.indexOf('TEXT') >= 0) result.TEXT += count;
            else if (modality === 'AUDIO' || modality.indexOf('AUDIO') >= 0) result.AUDIO += count;
            else if (modality === 'VIDEO' || modality.indexOf('VIDEO') >= 0 || modality.indexOf('IMAGE') >= 0) result.VIDEO += count;
            else result.UNKNOWN += count;
        });
        return result;
    };

    const hasUsageFields = (obj) =>
        Boolean(
            obj &&
                (obj.promptTokenCount !== undefined ||
                    obj.responseTokenCount !== undefined ||
                    obj.promptTokensDetails !== undefined ||
                    obj.responseTokensDetails !== undefined)
        );

    const applyUsageFromRecord = (record, sourceTag, fingerprintRegistry) => {
        if (!record) return false;

        const promptTotal = toNumber(record.promptTokenCount);
        const responseTotal = toNumber(record.responseTokenCount);

        const promptRaw = record.promptTokensDetails || [];
        const responseRaw = record.responseTokensDetails || [];

        const fingerprint = `${promptTotal}|${responseTotal}|${JSON.stringify(promptRaw)}|${JSON.stringify(responseRaw)}`;
        if (fingerprintRegistry[fingerprint]) {
            Logger.write(`===USAGE_METADATA_DUPLICATE_SKIPPED:${sourceTag}===`);
            return false;
        }
        fingerprintRegistry[fingerprint] = true;

        const promptDetails = getModalityCounts(promptRaw);
        const responseDetails = getModalityCounts(responseRaw);

        usageStats.in_text += promptDetails.TEXT;
        usageStats.in_audio += promptDetails.AUDIO;
        usageStats.in_video += promptDetails.VIDEO;
        usageStats.in_unknown += promptDetails.UNKNOWN;

        usageStats.out_text += responseDetails.TEXT;
        usageStats.out_audio += responseDetails.AUDIO;
        usageStats.out_video += responseDetails.VIDEO;
        usageStats.out_unknown += responseDetails.UNKNOWN;

        const knownPrompt = promptDetails.TEXT + promptDetails.AUDIO + promptDetails.VIDEO + promptDetails.UNKNOWN;
        const knownResponse = responseDetails.TEXT + responseDetails.AUDIO + responseDetails.VIDEO + responseDetails.UNKNOWN;

        if (promptTotal > knownPrompt) usageStats.in_unknown += promptTotal - knownPrompt;
        if (responseTotal > knownResponse) usageStats.out_unknown += responseTotal - knownResponse;

        usageStats.usage_events += 1;

        Logger.write(`===USAGE_METADATA_APPLIED:${sourceTag}===`);
        Logger.write(
            JSON.stringify({
                promptTotal,
                responseTotal,
                promptDetails,
                responseDetails,
                totalEvents: usageStats.usage_events
            })
        );

        return true;
    };

    const applyUsageMetadata = (rawEvent, sourceTag) => {
        if (!rawEvent) return false;

        const candidates = [];
        const localFingerprints = {};
        const pushCandidate = (obj, tag) => {
            if (!obj || typeof obj !== 'object') return;
            candidates.push({ obj, tag });
            if (obj.usageMetadata && typeof obj.usageMetadata === 'object') {
                candidates.push({ obj: obj.usageMetadata, tag: `${tag}.usageMetadata` });
            }
        };

        pushCandidate(rawEvent, 'raw');
        if (rawEvent.data) pushCandidate(rawEvent.data, 'raw.data');
        if (rawEvent.payload) pushCandidate(rawEvent.payload, 'raw.payload');
        if (rawEvent.data && rawEvent.data.payload) pushCandidate(rawEvent.data.payload, 'raw.data.payload');

        const pushParsedJson = (value, tag) => {
            const parsed = parseJsonMaybe(value);
            if (!parsed || typeof parsed !== 'object') return;
            pushCandidate(parsed, tag);
            if (parsed.payload && typeof parsed.payload === 'object') {
                pushCandidate(parsed.payload, `${tag}.payload`);
            }
        };

        pushParsedJson(rawEvent.data, 'raw.data_json');
        pushParsedJson(rawEvent.text, 'raw.text_json');
        pushParsedJson(rawEvent.message, 'raw.message_json');
        pushParsedJson(rawEvent.rawMessage, 'raw.raw_message_json');

        if (rawEvent.data && typeof rawEvent.data === 'object') {
            pushParsedJson(rawEvent.data.text, 'raw.data.text_json');
            pushParsedJson(rawEvent.data.message, 'raw.data.message_json');
            pushParsedJson(rawEvent.data.rawMessage, 'raw.data.raw_message_json');
        }

        let appliedAny = false;
        candidates.forEach(({ obj, tag }) => {
            if (!hasUsageFields(obj)) return;
            const applied = applyUsageFromRecord(obj, `${sourceTag}:${tag}`, localFingerprints);
            if (applied) appliedAny = true;
        });

        return appliedAny;
    };

    const extractEventData = (event) => {
        let data = event && event.data ? event.data : {};
        if (typeof data === 'string') {
            data = parseJsonMaybe(data) || {};
        }
        if ((!data || typeof data !== 'object' || !Object.keys(data).length) && event && typeof event.text === 'string') {
            const parsedText = parseJsonMaybe(event.text);
            if (parsedText && typeof parsedText === 'object') {
                data = parsedText;
            }
        }
        const payload =
            data && data.payload
                ? data.payload
                : event && event.payload
                ? event.payload
                : {};
        const customEvent = safeString((data && data.customEvent) || (event && event.customEvent));
        return { data, payload, customEvent };
    };

    const startWebSocketTimer = () => {
        if (websocketOpenedAtMs === null) {
            websocketOpenedAtMs = Date.now();
            Logger.write('===WS_TIMER_STARTED===');
        }
    };

    const stopWebSocketTimer = (tag) => {
        if (websocketOpenedAtMs === null) return;
        const seconds = (Date.now() - websocketOpenedAtMs) / 1000;
        if (seconds > 0) {
            websocketDurationSec += seconds;
        }
        websocketOpenedAtMs = null;
        Logger.write(`===WS_TIMER_STOPPED:${tag} sec=${seconds.toFixed(3)} total=${websocketDurationSec.toFixed(3)}===`);
    };

    const calcAiCosts = () => {
        const costInTextUsd = (usageStats.in_text / 1_000_000) * AI_PRICE_IN_TEXT;
        const costInAudioUsd = (usageStats.in_audio / 1_000_000) * AI_PRICE_IN_AUDIO;
        const costOutTextUsd = (usageStats.out_text / 1_000_000) * AI_PRICE_OUT_TEXT;
        const costOutAudioUsd = (usageStats.out_audio / 1_000_000) * AI_PRICE_OUT_AUDIO;

        const totalAiUsd = costInTextUsd + costInAudioUsd + costOutTextUsd + costOutAudioUsd;
        const totalAiRub = totalAiUsd * USD_TO_RUB_RATE;
        const effectiveWebSocketSec = websocketDurationSec > 0 ? websocketDurationSec : callDurationSec;
        const websocketRub = (effectiveWebSocketSec / 60) * WEBSOCKET_PRICE_PER_MINUTE_RUB;
        const totalVoximplantRub = telephonyCostRub + websocketRub;
        const totalRub = totalAiRub + totalVoximplantRub;

        return {
            costInTextUsd,
            costInAudioUsd,
            costOutTextUsd,
            costOutAudioUsd,
            totalAiUsd,
            totalAiRub,
            websocketRub,
            effectiveWebSocketSec,
            totalVoximplantRub,
            totalRub
        };
    };

    const getSummaryOrFallback = () => {
        if (summaryReceived && normalizeText(summaryData.summary)) {
            return {
                client_name: sanitizeForSummary(summaryData.client_name),
                client_phone: sanitizeForSummary(summaryData.client_phone || callerPhone),
                call_goal: clipText(summaryData.call_goal, 300),
                manager_offer: clipText(summaryData.manager_offer, 300),
                outcome: clipText(summaryData.outcome, 200),
                next_step: clipText(summaryData.next_step, 200),
                summary: clipText(summaryData.summary, 350)
            };
        }

        ensureDialogueFinalized();

        const userTexts = collectRolePhrases('user', 2, 120).join(' ').trim();
        const assistantTexts = collectRolePhrases('assistant', 2, 140).join(' ').trim();

        const inferredName = extractClientNameFromDialogue();
        const callGoal = clipText(summaryData.call_goal || userTexts, 220);
        const managerOffer = clipText(summaryData.manager_offer || assistantTexts, 220);
        const outcome = clipText(summaryData.outcome || 'Разговор завершен.', 200);
        const nextStep = clipText(summaryData.next_step || 'Требуется обработка менеджером.', 200);
        const compactSummary = clipText(
            summaryData.summary ||
                `Клиент обратился с запросом: ${callGoal || 'не указано'}. ` +
                    `${managerOffer ? `Менеджер предложил: ${managerOffer}. ` : ''}` +
                    `Итог: ${outcome}. Следующий шаг: ${nextStep}.`,
            350
        );

        return {
            client_name: sanitizeForSummary(summaryData.client_name || inferredName),
            client_phone: sanitizeForSummary(summaryData.client_phone || callerPhone),
            call_goal: callGoal,
            manager_offer: managerOffer,
            outcome,
            next_step: nextStep,
            summary: compactSummary
        };
    };

    const formatDialogueForHtml = () => {
        ensureDialogueFinalized();

        if (!dialogue.length) {
            return 'Реплики не найдены.';
        }

        const lines = dialogue.map((item) => {
            const speaker = item.role === 'user' ? 'Клиент' : 'Агент';
            const statusNote =
                item.status === 'interrupted'
                    ? ' [прервано]'
                    : item.status === 'partial'
                    ? ' [незавершено]'
                    : '';
            return `${speaker}: ${item.text}${statusNote}`;
        });

        return lines.join('\n');
    };

    const trimMessage = (text) => {
        const t = safeString(text);
        if (t.length <= TELEGRAM_MAX_TEXT_LEN) return t;
        return `${t.slice(0, TELEGRAM_MAX_TEXT_LEN - 16)}\n... (truncated)`;
    };

    const sendTelegramMessage = (chatId, htmlText, tag, done) => {
        if (!telegramBotToken) {
            Logger.write(`===TG_SKIP_NO_BOT_TOKEN:${tag}===`);
            done();
            return;
        }

        if (!chatId) {
            Logger.write(`===TG_SKIP_EMPTY_CHAT_ID:${tag}===`);
            done();
            return;
        }

        if (typeof Net === 'undefined' || typeof Net.httpRequest !== 'function') {
            Logger.write(`===TG_SKIP_NET_UNAVAILABLE:${tag}===`);
            done();
            return;
        }

        const telegramUrl = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;

        const options = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            postData: JSON.stringify({
                chat_id: chatId,
                text: trimMessage(htmlText),
                parse_mode: 'HTML',
                disable_web_page_preview: true
            })
        };

        Logger.write(`===TG_SEND_START:${tag} chat=${chatId}===`);

        Net.httpRequest(
            telegramUrl,
            (res) => {
                Logger.write(`===TG_SEND_DONE:${tag} chat=${chatId} code=${res.code}===`);
                Logger.write(safeString(res.text));
                done();
            },
            options
        );
    };

    const sendTelegramToMany = (chatIds, htmlText, tag, done) => {
        const ids = dedupeList(chatIds || []);
        if (!ids.length) {
            Logger.write(`===TG_NO_RECIPIENTS:${tag}===`);
            done();
            return;
        }

        let idx = 0;
        const sendNext = () => {
            if (idx >= ids.length) {
                done();
                return;
            }
            const chatId = ids[idx++];
            sendTelegramMessage(chatId, htmlText, `${tag}#${idx}`, sendNext);
        };

        sendNext();
    };
    const buildGoogleSheetsPayload = () => {
        const ai = calcAiCosts();
        const summary = getSummaryOrFallback();
        const dialogueText = formatDialogueForHtml();

        return {
            project: 'crystal_stone',
            script_name: 'crystalstone.js',
            exported_at_utc: new Date().toISOString(),
            model: safeString(activeGeminiModel),
            caller_phone: safeString(callerPhone),
            client_phone: safeString(summary.client_phone || callerPhone),
            client_name: safeString(summary.client_name),
            call_duration_sec: Math.round(toNumber(callDurationSec)),
            telephony_cost_rub: toFixedNumber(telephonyCostRub, 4),
            websocket_duration_sec: toFixedNumber(ai.effectiveWebSocketSec, 3),
            websocket_cost_rub: toFixedNumber(ai.websocketRub, 4),
            voximplant_total_rub: toFixedNumber(ai.totalVoximplantRub, 4),
            ai_cost_usd: toFixedNumber(ai.totalAiUsd, 6),
            ai_cost_rub: toFixedNumber(ai.totalAiRub, 4),
            total_cost_rub: toFixedNumber(ai.totalRub, 4),
            summary: safeString(summary.summary),
            call_goal: safeString(summary.call_goal),
            manager_offer: safeString(summary.manager_offer),
            outcome: safeString(summary.outcome),
            next_step: safeString(summary.next_step),
            recording_status: 'not_configured_in_this_script',
            recording_url: '',
            recording_error: '',
            dialogue_text: safeString(dialogueText),
            usage: {
                in_text: toNumber(usageStats.in_text),
                in_audio: toNumber(usageStats.in_audio),
                in_video: toNumber(usageStats.in_video),
                in_unknown: toNumber(usageStats.in_unknown),
                out_text: toNumber(usageStats.out_text),
                out_audio: toNumber(usageStats.out_audio),
                out_video: toNumber(usageStats.out_video),
                out_unknown: toNumber(usageStats.out_unknown),
                usage_events: toNumber(usageStats.usage_events)
            },
            summary_fields: {
                client_name: safeString(summary.client_name),
                client_phone: safeString(summary.client_phone || callerPhone),
                call_goal: safeString(summary.call_goal),
                manager_offer: safeString(summary.manager_offer),
                outcome: safeString(summary.outcome),
                next_step: safeString(summary.next_step)
            },
            dialogue_items: dialogue.map((item) => ({
                role: safeString(item.role),
                text: safeString(item.text),
                status: safeString(item.status)
            }))
        };
    };

    const sendGoogleAppsScriptWebhook = (payload, tag, done) => {
        if (!googleAppsScriptWebhookUrl) {
            Logger.write(`===GAS_SKIP_NO_URL:${tag}===`);
            done();
            return;
        }

        if (typeof Net === 'undefined' || typeof Net.httpRequest !== 'function') {
            Logger.write(`===GAS_SKIP_NET_UNAVAILABLE:${tag}===`);
            done();
            return;
        }

        const options = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            postData: JSON.stringify(payload)
        };

        Logger.write(`===GAS_SEND_START:${tag}===`);
        Net.httpRequest(
            googleAppsScriptWebhookUrl,
            (res) => {
                Logger.write(`===GAS_SEND_DONE:${tag} code=${res.code}===`);
                Logger.write(safeString(res.text));
                done();
            },
            options
        );
    };
    const buildAdminReportHtml = () => {
        const ai = calcAiCosts();
        const summary = getSummaryOrFallback();
        const lines = [];

        lines.push('<b>Звонок завершен</b>');
        lines.push(`<b>Номер:</b> ${escapeHtml(summary.client_phone || callerPhone || 'неизвестно')}`);
        lines.push(`<b>Длительность:</b> ${escapeHtml(String(callDurationSec || 0))} сек`);
        lines.push(`<b>Телефония:</b> ${escapeHtml(telephonyCostRub.toFixed(4))} руб`);
        lines.push(`<b>WebSocket:</b> ${escapeHtml(ai.websocketRub.toFixed(4))} руб (${escapeHtml(ai.effectiveWebSocketSec.toFixed(0))} сек)`);
        lines.push(`<b>Voximplant всего:</b> ${escapeHtml(ai.totalVoximplantRub.toFixed(4))} руб`);
        lines.push(`<b>AI:</b> ${escapeHtml(ai.totalAiRub.toFixed(4))} руб (${escapeHtml(ai.totalAiUsd.toFixed(6))} USD)`);
        lines.push(`<b>Итоговая стоимость:</b> ${escapeHtml(ai.totalRub.toFixed(4))} руб`);
        lines.push('');
        lines.push('<b>Токены:</b>');
        lines.push(
            escapeHtml(
                `in(text=${usageStats.in_text}, audio=${usageStats.in_audio}, video=${usageStats.in_video}, unknown=${usageStats.in_unknown}); ` +
                    `out(text=${usageStats.out_text}, audio=${usageStats.out_audio}, video=${usageStats.out_video}, unknown=${usageStats.out_unknown})`
            )
        );
        lines.push('');
        lines.push('<b>Диалог:</b>');
        lines.push(escapeHtml(formatDialogueForHtml()));

        return lines.join('\n');
    };

    const buildSummaryReportHtml = () => {
        const summary = getSummaryOrFallback();
        const lines = [];

        lines.push('<b>Новый звонок (суммаризация)</b>');
        lines.push(`<b>Номер:</b> ${escapeHtml(summary.client_phone || callerPhone || 'неизвестно')}`);
        lines.push(`<b>Имя:</b> ${escapeHtml(summary.client_name || 'не указано')}`);
        lines.push(`<b>Запрос:</b> ${escapeHtml(summary.call_goal || 'не указано')}`);
        lines.push(`<b>Что предложили:</b> ${escapeHtml(summary.manager_offer || 'не указано')}`);
        lines.push(`<b>Итог:</b> ${escapeHtml(summary.outcome || 'не указано')}`);
        lines.push(`<b>Следующий шаг:</b> ${escapeHtml(summary.next_step || 'не указано')}`);
        lines.push('');
        lines.push(`<b>Кратко:</b> ${escapeHtml(summary.summary || 'не указано')}`);

        return lines.join('\n');
    };

    const closeGeminiClient = () => {
        geminiSocketAlive = false;
        try {
            if (geminiLiveAPIClient) {
                stopWebSocketTimer('close_client');
                Logger.write('===GEMINI_CLIENT_CLOSE_START===');
                geminiLiveAPIClient.close();
                Logger.write('===GEMINI_CLIENT_CLOSE_DONE===');
            }
        } catch (e) {
            Logger.write('===GEMINI_CLIENT_CLOSE_ERROR===');
            Logger.write(String(e));
        }
        geminiLiveAPIClient = null;
    };

    const sendAllReportsAndTerminate = () => {
        const adminIds = dedupeList(telegramAdminChatIds);
        const summaryRecipients = dedupeList([].concat(telegramAdminChatIds, telegramUserChatIds));

        Logger.write('===REPORT_RECIPIENTS===');
        Logger.write(JSON.stringify({ adminIds, summaryRecipients }));

        const adminText = buildAdminReportHtml();
        const summaryText = buildSummaryReportHtml();
        const googleSheetsPayload = buildGoogleSheetsPayload();

        sendTelegramToMany(adminIds, adminText, 'ADMIN_REPORT', () => {
            sendTelegramToMany(summaryRecipients, summaryText, 'SUMMARY_REPORT', () => {
                sendGoogleAppsScriptWebhook(googleSheetsPayload, 'GOOGLE_SHEETS_WEBHOOK', () => {
                    if (!isSessionTerminated) {
                        isSessionTerminated = true;
                        Logger.write('===VOX_TERMINATE===');
                        VoxEngine.terminate();
                    }
                });
            });
        });
    };

    const finishSummaryWait = (reason) => {
        if (!summaryWaitDone) return;

        if (summaryWaitTimer) {
            clearTimeout(summaryWaitTimer);
            summaryWaitTimer = null;
        }

        const cb = summaryWaitDone;
        summaryWaitDone = null;
        Logger.write(`===SUMMARY_WAIT_FINISH:${reason}===`);
        cb(reason);
    };

    const requestSummaryViaFunction = (done) => {
        if (summaryReceived) {
            Logger.write('===SUMMARY_REQUEST_SKIP:already_received===');
            done('already_received');
            return;
        }

        if (!geminiLiveAPIClient || !geminiSocketAlive) {
            Logger.write('===SUMMARY_REQUEST_SKIP:no_active_gemini_socket===');
            done('no_active_socket');
            return;
        }

        if (isGemini31Live && typeof geminiLiveAPIClient.sendRealtimeInput !== 'function') {
            Logger.write('===SUMMARY_REQUEST_SKIP:gemini_3_1_requires_realtime_input_for_runtime_text===');
            done('gemini_3_1_realtime_input_unavailable');
            return;
        }

        if (!summaryRequestSent) {
            summaryRequestSent = true;

            const requestText = `
Разговор завершен. Обязательно вызови функцию ${SUMMARY_FUNCTION_NAME}.
Заполни поля:
- client_name
- client_phone
- call_goal
- manager_offer
- outcome
- next_step
- summary

Требования:
- Пиши значения на русском языке.
- summary: 2-4 предложения, без длинных цитат из расшифровки.
- call_goal / manager_offer / outcome / next_step: кратко и предметно, по 1-2 предложения.
- Если данных нет, пиши "не указано".
- Никакого дополнительного текста, только function call.
            `;

            Logger.write('===SUMMARY_REQUEST_SEND_START===');
            try {
                sendUserTextToModel(requestText, 'summary_request');
                Logger.write('===SUMMARY_REQUEST_SEND_DONE===');
            } catch (e) {
                Logger.write('===SUMMARY_REQUEST_SEND_ERROR===');
                Logger.write(String(e));
                done('send_error');
                return;
            }
        } else {
            Logger.write('===SUMMARY_REQUEST_ALREADY_SENT===');
        }

        summaryWaitDone = done;
        summaryWaitTimer = setTimeout(() => {
            summaryWaitTimer = null;
            finishSummaryWait('timeout');
        }, SUMMARY_REQUEST_TIMEOUT_MS);
    };

    const finalizeSession = (reason) => {
        if (isFinalizing || isSessionTerminated) return;
        isFinalizing = true;

        Logger.write(`===FINALIZE_START:${reason}===`);

        if (answerTimer) {
            clearTimeout(answerTimer);
            answerTimer = null;
        }
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }

        requestSummaryViaFunction((summaryReason) => {
            Logger.write(`===FINALIZE_AFTER_SUMMARY:${summaryReason}===`);
            closeGeminiClient();
            sendAllReportsAndTerminate();
        });
    };

    const setCallMetaFromEvent = (event) => {
        if (!event) return;

        if (event.duration !== undefined) callDurationSec = toNumber(event.duration);
        if (event.cost !== undefined) telephonyCostRub = toNumber(event.cost);

        const evNumber = safeString(event.callerid || event.number || event.phone || '');
        if (evNumber) callerPhone = evNumber;
    };

    call.addEventListener(CallEvents.Disconnected, (event) => {
        Logger.write('===CALL_DISCONNECTED===');
        Logger.write(JSON.stringify(event || {}));
        callEnded = true;
        setCallMetaFromEvent(event);
        finalizeSession('call_disconnected');
    });

    call.addEventListener(CallEvents.Failed, (event) => {
        Logger.write('===CALL_FAILED===');
        Logger.write(JSON.stringify(event || {}));
        callEnded = true;
        setCallMetaFromEvent(event);
        finalizeSession('call_failed');
    });

    const scheduleGeminiReconnect = (reason) => {
        if (reconnectAttempts >= WS_RECONNECT_MAX_ATTEMPTS) {
            Logger.write(`===WS_RECONNECT_LIMIT_REACHED:${reason} attempts=${reconnectAttempts}===`);
            return false;
        }
        if (reconnectTimer || isStartingGemini) {
            Logger.write(`===WS_RECONNECT_ALREADY_PENDING:${reason}===`);
            return true;
        }

        reconnectAttempts += 1;
        const attempt = reconnectAttempts;
        Logger.write(
            `===WS_RECONNECT_SCHEDULED:${reason} attempt=${attempt}/${WS_RECONNECT_MAX_ATTEMPTS} delay_ms=${WS_RECONNECT_DELAY_MS}===`
        );

        reconnectTimer = setTimeout(async () => {
            reconnectTimer = null;

            if (callEnded || isFinalizing || isSessionTerminated) {
                Logger.write('===WS_RECONNECT_ABORTED:session_not_active===');
                return;
            }

            geminiLiveAPIClient = null;

            try {
                await startGeminiSession(true);
                Logger.write(`===WS_RECONNECT_DONE:attempt=${attempt}===`);
            } catch (e) {
                Logger.write('===WS_RECONNECT_ERROR===');
                Logger.write(String(e));
                finalizeSession('websocket_reconnect_error');
            }
        }, WS_RECONNECT_DELAY_MS);

        return true;
    };

    const onWebSocketClose = (event) => {
        Logger.write('===ON_WEB_SOCKET_CLOSE===');
        Logger.write(JSON.stringify(event || {}));
        stopWebSocketTimer('ws_close_event');
        geminiSocketAlive = false;

        if (isFinalizing || isSessionTerminated) {
            Logger.write('===ON_WEB_SOCKET_CLOSE_IGNORED:already_finalizing===');
            return;
        }

        if (!callEnded && scheduleGeminiReconnect('websocket_close')) {
            return;
        }

        finalizeSession('websocket_close');
    };

    const startPreAnswerTone = () => {
        try {
            call.startEarlyMedia();
            call.playProgressTone(RINGBACK_COUNTRY);
            earlyMediaStarted = true;
            Logger.write(`===EARLY_MEDIA_RINGBACK_STARTED:${RINGBACK_COUNTRY}===`);
        } catch (e) {
            Logger.write('===EARLY_MEDIA_RINGBACK_FAILED===');
            Logger.write(String(e));
        }
    };
    const startGeminiSession = async (isReconnect = false) => {
        if (isStartingGemini) {
            Logger.write(`===START_GEMINI_SKIPPED_ALREADY_STARTING:reconnect=${isReconnect}===`);
            return;
        }
        isStartingGemini = true;
        try {
            const [apiKeyEntry, tgBotEntry, tgAdminEntry, tgUserEntry, tgLegacyChatEntry, gasWebhookEntry, gasWebhookLegacyEntry] =
                await Promise.all([
                    ApplicationStorage.get('GEMINI_API_KEY'),
                    ApplicationStorage.get('TELEGRAM_BOT_TOKEN'),
                    ApplicationStorage.get('TELEGRAM_CHAT_ID_ADMIN'),
                    ApplicationStorage.get('TELEGRAM_CHAT_ID_USER'),
                    ApplicationStorage.get('TELEGRAM_CHAT_ID'),
                    ApplicationStorage.get('GOOGLE_APPS_SCRIPT_WEBHOOK_URL'),
                    ApplicationStorage.get('GOOGLE_SHEETS_WEBHOOK_URL')
                ]);

            const GEMINI_API_KEY = apiKeyEntry && apiKeyEntry.value;
            const GEMINI_MODEL = 'gemini-3.1-flash-live-preview';
            activeGeminiModel = GEMINI_MODEL;
            isGemini31Live = /3\.1.*live/i.test(GEMINI_MODEL);

            telegramBotToken = safeString(tgBotEntry && tgBotEntry.value).trim();
            googleAppsScriptWebhookUrl = safeString(
                (gasWebhookEntry && gasWebhookEntry.value) || (gasWebhookLegacyEntry && gasWebhookLegacyEntry.value)
            ).trim();

            const adminRaw = safeString((tgAdminEntry && tgAdminEntry.value) || (tgLegacyChatEntry && tgLegacyChatEntry.value));
            const userRaw = safeString(tgUserEntry && tgUserEntry.value);

            telegramAdminChatIds = parseChatIdList(adminRaw);
            telegramUserChatIds = parseChatIdList(userRaw);

            Logger.write('===CONFIG_LOADED===');
            Logger.write(
                JSON.stringify({
                    hasGeminiKey: Boolean(GEMINI_API_KEY),
                    hasTelegramToken: Boolean(telegramBotToken),
                    hasGoogleSheetsWebhook: Boolean(googleAppsScriptWebhookUrl),
                    adminChats: telegramAdminChatIds,
                    userChats: telegramUserChatIds,
                    callerPhone
                })
            );

            if (!GEMINI_API_KEY) {
                Logger.write('===NO_GEMINI_API_KEY_IN_APPLICATION_STORAGE===');
                finalizeSession('no_gemini_key');
                return;
            }

            const GEMINI_CONNECT_CONFIG = {
                responseModalities: ['AUDIO'],

                thinkingConfig: {
                    thinkingLevel: 'minimal'
                },

                historyConfig: {
                    initialHistoryInClientContent: true
                },

                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: { voiceName: 'Iapetus' }
                    }
                },

                realtimeInputConfig: {
                    automaticActivityDetection: {
                        prefixPaddingMs: 20,
                        silenceDurationMs: 100,
                        endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
                        startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH'
                    },
                    activityHandling: 'START_OF_ACTIVITY_INTERRUPTS'
                },

                inputAudioTranscription: {},
                outputAudioTranscription: {},

                tools: [
                    {
                        functionDeclarations: [
                            {
                                name: SUMMARY_FUNCTION_NAME,
                                description:
                                    'Сохранить итоговую суммаризацию звонка для CRM и уведомлений в Telegram.',
                                parameters: {
                                    type: 'object',
                                    properties: {
                                        client_name: { type: 'string', description: 'Имя клиента' },
                                        client_phone: { type: 'string', description: 'Подтвержденный номер телефона клиента' },
                                        call_goal: { type: 'string', description: 'Что хотел клиент' },
                                        manager_offer: { type: 'string', description: 'Что предложил менеджер' },
                                        outcome: { type: 'string', description: 'Итог разговора' },
                                        next_step: { type: 'string', description: 'Следующее действие после звонка' },
                                        summary: { type: 'string', description: 'Короткая итоговая суммаризация (2-4 предложения)' }
                                    },
                                    required: ['summary', 'call_goal', 'outcome']
                                }
                            }
                        ]
                    }
                ],

                systemInstruction: {
                    parts: [
                        {
                            text: `
Роль и личность:
Ты — Сергей, профессиональный, вежливый и компетентный менеджер компании «Crystal Stone». Твоя задача — принимать входящие звонки, консультировать клиентов, собирать первичную информацию по заказам и запросам, фиксировать ключевые данные и маршрутизировать запросы дальше по компании.

Ты общаешься как живой менеджер:
— спокойно,
— уверенно,
— доброжелательно,
— по-человечески,
— без лишней официальности.

Твой голос — мужской, уверенный, спокойный.
Стиль общения: разговорный, естественный. Говори короткими предложениями. Делай паузы. Слушай клиента внимательно. Не перебивай. Не используй сложные термины без необходимости. Не читай длинные списки монологом.
Темп речи: средний, ближе к живому разговорному.

Главное правило:
Задавай только ОДИН вопрос за раз. Дождись ответа клиента, прежде чем продолжать.

Поведение в голосовом разговоре:
— не говори слишком длинно;
— не перегружай клиента деталями;
— сначала ответь по сути, потом уточняй недостающие данные;
— если клиент уже начал объяснять задачу, не возвращай его резко в скрипт;
— мягко встраивай нужные уточнения по ходу;
— внимательно фиксируй размеры, адреса, телефоны, договоры, никнеймы, названия материалов;
— если что-то важно прозвучало нечетко, попроси повторить именно этот фрагмент;
— после получения размеров, телефона, никнейма, адреса или номера договора кратко повторяй данные для подтверждения;
— используй живые короткие фразы-связки, когда это уместно: «Понял вас», «Да, конечно», «Хорошо», «Так, записываю», «Ясно», «Спасибо», «Угу», «Понял, спасибо», «Да, все верно», «Хорошо, отметил»;
— не вставляй такие фразы слишком часто и не превращай речь в набор междометий;
— если клиент замолчал, можно вежливо спросить: «Вы меня слышите?» или «Да, я вас слушаю».

Информация о компании (База знаний):
Название: Crystal Stone.
Опыт: На рынке с 2005 года.
Чем занимаемся: Изделия из камня для премиальных интерьеров под ключ — от замера до установки.
Ассортимент: столешницы для кухни и санузла, острова, подоконники, мойки, панно, камины, лестницы, бассейны, облицовка стен, полов и фасадов, барные стойки, ресепшн. Также распиливаем камень клиента, реставрируем камень, делаем сложную гравировку.
Материалы: натуральный камень (гранит, мрамор, кварцит, оникс), кварцевый агломерат, широкоформатная керамика.
География: работаем по всей России.
Шоу-рум: Москва.
Производство: г. Мытищи, ул. Коминтерна, 17.
Офис в Санкт-Петербурге: ул. Чугунная, 14Ж.
Тип клиентов: частные лица, оптовые покупатели, дизайнеры, архитекторы, мебельные салоны.
Контакты: 8 (800) 550-65-10.
MAX/Telegram: +7 (981) 858-84-90.
Почта: info@crystalstone.ru.
График: в выходные дни офисы и шоу-румы не работают. Менеджеры работают по будням с 9:00 до 18:00.

========================
ОБЩАЯ ЛОГИКА РАЗГОВОРА
========================

Твоя цель в каждом звонке:
1. Понять, с чем обратился клиент.
2. Коротко и понятно ответить по теме.
3. Собрать только те данные, которые действительно нужны.
4. Зафиксировать следующий шаг.
5. В конце разговора обязательно сохранить суммаризацию через функцию.

Не пытайся за один раз задать несколько вопросов.
Не устраивай длинный допрос.
Не усложняй разговор.

Если клиент говорит быстро, сумбурно или длинно:
— сначала спокойно выслушай;
— затем кратко подведи итог своими словами;
— потом задай следующий один уточняющий вопрос.

Пример хорошей манеры:
«Понял вас. Правильно понимаю, вам нужен расчет по столешнице?»

Если клиент сразу начал с сути, например:
— «Мне нужна столешница»
— «Есть ли у вас такой камень»
— «У меня рекламация»
— «Нужен замерщик»

Тогда сначала коротко отреагируй по существу, а уже потом мягко добери имя, город, удобный номер или другие нужные данные.

========================
СТАРТ РАЗГОВОРА
========================
Предпочтительное начало разговора:
«Здравствуйте! Меня зовут Сергей, я менеджер компании Crystal Stone. Подскажите, из какого города вы звоните?»
После ответа:
«Понял, спасибо. А как я могу к вам обращаться?»
После ответа:
«Очень приятно, [Имя]. Скажите, по какому вопросу звоните?»
Но:
если клиент с первых секунд уже формулирует запрос, не перебивай его и не возвращай резко в начало. В таком случае:
1. коротко подтверди, что услышал запрос;
2. продолжи разговор по сути;
3. имя, город и другие данные уточняй по ходу, в естественный момент.
========================
ПОДТВЕРЖДЕНИЕ НОМЕРА
========================
Во время звонка тебе заранее известен номер клиента из системы:
${callerPhone || 'неизвестен'}
Правило работы с номером:
— не проси клиента сразу продиктовать номер заново;
— сначала кратко подтверди его;
— спрашивай коротко и естественно;
— только если клиент говорит, что номер другой или неактуальный, тогда попроси назвать актуальный.
Правильная формулировка:
«Подскажите, пожалуйста, номер, с которого вы сейчас звоните — ${callerPhone || 'неизвестен'} — актуальный для связи?»
Если клиент говорит «да», «верно», «актуальный»:
— зафиксируй этот номер и не переспрашивай его снова без необходимости.
Если клиент говорит «нет», «другой номер», «лучше другой»:
— попроси назвать актуальный номер;
— внимательно выслушай;
— кратко повтори и подтверди.

Если номер уже подтвержден, в дальнейшей беседе не возвращайся к этому вопросу без причины.
========================
СТРУКТУРА ДИАЛОГА И СЦЕНАРИИ
========================
СЦЕНАРИЙ А. Клиент хочет заказать изделие / сделать расчет / диктует размеры
Если клиент хочет заказать изделие, расчет или консультацию по изготовлению:
скажи:
«Да, конечно. Мы изготавливаем изделия из натурального камня, кварцевого агломерата и керамики. Скажите, вы уже определились с материалом или пока подбираете?»

Если клиент уже знает материал:
«Отлично. Чтобы подготовить точный расчет, нам нужны размеры, чертеж или схема. Как вам удобнее: продиктовать сейчас или отправить нам в мессенджер либо на почту?»

Если клиент пока не определился с материалом:
«Ничего страшного, поможем подобрать. Сначала давайте поймем, какое именно изделие вам нужно и какие примерно размеры.»

Если клиент говорит, что продиктует размеры:
скажи:
«Да, конечно. Записываю, диктуйте.»

Пока клиент диктует:
— слушай внимательно;
— не перебивай;
— если информация длинная, можешь мягко подтверждать: «Так, записал», «Да, дальше»;
— после диктовки обязательно кратко повтори ключевые размеры.

Пример:
«Понял, записал: длина 2400, глубина 600, плюс остров 1800 на 900. Всё верно?»

Если клиент хочет отправить в мессенджер:
скажи:
«Да, конечно. Нам можно написать в MAX или Telegram по номеру +7 (981) 858-84-90.»

Если клиент диктует никнейм Telegram:
— внимательно слушай буквы и символы;
— если диктует по буквам на английском, фиксируй особенно внимательно;
— потом скажи:
«Да, записал ваш никнейм.»

После этого можно добавить:
«Также удобно написать нам прямо с сайта — кнопка в правом нижнем углу. Если нужно, я могу повторить номер для мессенджера.»

Если клиент хочет отправить на почту:
скажи:
«Да, конечно. Наша почта — info@crystalstone.ru.»

Если клиент спрашивает про срочность:
скажи:
«Понял вас. Я обязательно отмечу, что запрос срочный, и менеджер свяжется с вами максимально быстро в рабочее время.»

Завершение Сценария А:
«Я всё зафиксировал. Менеджер свяжется с вами в ближайшее рабочее время и займется вашим расчетом. Подскажите, пожалуйста, вам удобнее, чтобы с вами связались по телефону или в мессенджере?»

Если удобно по телефону:
— уточни, нужен ли звонок именно на подтвержденный номер.

Если удобно в мессенджере:
— уточни, куда именно удобнее написать.

Если клиенту больше ничего не нужно:
«Хорошо, всё записал. Спасибо за звонок.»
СЦЕНАРИЙ Б. Клиент спрашивает про наличие
Если клиент спрашивает про готовое изделие в наличии, например:
— «Есть столешница в наличии?»
— «Есть готовый подоконник?»
Отвечай:
«Готовых изделий у нас, как правило, нет — мы делаем всё на заказ по индивидуальным размерам. Подскажите, вы уже знаете примерные размеры?»
После этого переходи к Сценарию А.
Если клиент спрашивает про наличие материала, слэба, плиты или стоимость материала:
скажи:
«Точную информацию по наличию и базе материалов менеджеры проверяют в рабочее время. Скажите, пожалуйста, как называется материал, который вас интересует? Я зафиксирую и передам запрос.»
После ответа:
«Хорошо, записал. Менеджер свяжется с вами в рабочее время и даст точную информацию по наличию и стоимости.»
Никогда не обещай наличие конкретного материала прямо сейчас.
Никогда не придумывай остатки, артикулы, количество слэбов или цены.
СЦЕНАРИЙ В. Общие вопросы
Если клиент спрашивает:
— «Вы делаете столешницы?»
— «А гравировку делаете?»
— «А с керамикой работаете?»
— «Делаете ли вы камины?»
Отвечай коротко и уверенно:
«Да, конечно. Мы делаем изделия из камня на заказ, в том числе сложные и нестандартные проекты.»
Далее:
«Подскажите, пожалуйста, что именно вас интересует?»
Если клиент уже знает изделие и размеры:
переходи к Сценарию А.
Если клиент пока просто узнает и не готов назвать размеры:
скажи:
«Понял вас. Тогда давайте я зафиксирую ваш запрос, и менеджер подробно вас проконсультирует в рабочее время. Подскажите, как с вами удобнее связаться?»
При необходимости дополнительно спроси:
«И в какое время вам удобнее принять звонок?»

СЦЕНАРИЙ Г. Клиент — дизайнер, архитектор, мебельщик, партнер
Если клиент представляется как дизайнер, архитектор, мебельный салон, комплектатор или партнер:
скажи:
«Рад знакомству. Да, конечно, мы активно сотрудничаем с дизайнерами, архитекторами и мебельными салонами по всей России. Будем рады сотрудничеству.»
Если клиент спрашивает про комиссию, вознаграждение, скидки, партнерские условия:
скажи:
«Да, у нас есть партнерская система. Менеджер сможет подробнее рассказать по условиям и посчитать проект уже с учетом партнерской скидки. Подскажите, у вас сейчас уже есть конкретный проект или вы пока знакомитесь с условиями?»
Если есть проект:
переходи к Сценарию А.
Если проекта пока нет:
скажи:
«Понял вас. Тогда я передам ваши контакты менеджеру по партнерскому направлению. Подскажите, когда вам удобнее принять звонок?»

СЦЕНАРИЙ Д. Рекламация / сервис / доработка
Если клиент сообщает о проблеме:
— пятно,
— трещина,
— скол,
— дефект,
— нужно доделать отверстие,
— нужна доработка после установки,
— сервисный запрос,
скажи:
«Понял вас. Давайте я зафиксирую заявку. Назовите, пожалуйста, номер договора, номер счета или точный адрес, где устанавливали изделие.»
После ответа:
— кратко повтори ключевые данные;
— затем спроси:
«Подскажите, пожалуйста, в двух словах, что именно произошло?»
После ответа:
«Спасибо, я всё записал. Передам информацию в сервисный отдел, с вами свяжутся в ближайшее рабочее время.»

СЦЕНАРИЙ Е. Распил камня клиента
Если клиент спрашивает про распил, обработку или работу с его материалом:
скажи:
«Да, конечно, мы можем распилить и обработать ваш материал.»
Дальше:
«Подскажите, пожалуйста, что именно нужно сделать и какие размеры?»

Затем переходи к Сценарию А.

СЦЕНАРИЙ Ж. Вызов замерщика

Если клиент хочет вызвать замерщика:
скажи:
«Да, конечно. Подскажите, пожалуйста, по какому адресу нужен замер?»

После ответа:
«Спасибо. А что именно нужно померить?»

После ответа:
«Хорошо, записал. Менеджер свяжется с вами в ближайший рабочий день, чтобы согласовать точную дату и время приезда замерщика.»

Если адрес звучит нечетко:
— попроси повторить именно адрес;
— потом кратко повтори адрес обратно для подтверждения.

СЦЕНАРИЙ З. Шоу-рум / офис / приезд / работа в выходные

Если клиент спрашивает про шоу-рум, офис, посещение или график:
сначала уточни:
«Подскажите, пожалуйста, офис в каком городе вас интересует?»

Если речь про Москву:
«В Москве у нас шоу-рум, а производство находится в Мытищах, на улице Коминтерна, 17.»

Если речь про Санкт-Петербург:
«В Санкт-Петербурге офис находится по адресу: улица Чугунная, 14Ж.»

Если клиент спрашивает про выходные:
«К сожалению, в выходные дни офисы и шоу-румы не работают.»

После этого:
«Менеджер может связаться с вами в будние дни и согласовать удобное время визита.»

========================
НЕИЗВЕСТНЫЕ И НЕСТАНДАРТНЫЕ ВОПРОСЫ
========================

Если клиент задает вопрос, ответа на который нет в базе знаний:
не придумывай ответ.

Говори:
«Отличный вопрос. Я зафиксирую его и передам профильному менеджеру, чтобы вам дали точный ответ. Подскажите, пожалуйста, как удобнее с вами связаться?»

Если клиент задает слишком технический вопрос:
не фантазируй и не выдавай предположения за факт.

Если клиент спрашивает про точную цену:
скажи:
«Точный расчет делает менеджер по размерам, материалу и задаче. Я могу зафиксировать ваш запрос, чтобы вам подготовили расчет.»

Если клиент давит и просит сказать хотя бы примерную цену:
не называй цифры.
Скажи:
«Чтобы не вводить вас в заблуждение, лучше передать запрос на точный расчет менеджеру.»

========================
ЖИВАЯ РЕЧЬ И ЕСТЕСТВЕННОСТЬ
========================

Ты должен звучать как живой менеджер, а не как робот или автоответчик.

Допустимо и желательно иногда использовать естественные короткие реплики:
— «Понял вас»
— «Да, конечно»
— «Хорошо»
— «Так, записываю»
— «Секунду»
— «Спасибо»
— «Ясно»
— «Да, всё верно»
— «Хорошо, отметил»
— «Угу, понял»

Но:
— не вставляй их в каждую фразу;
— не делай речь слишком театральной;
— не используй слишком фамильярный стиль;
— не шути;
— не говори как чат-бот.

Ты — вежливый, уверенный менеджер компании.

========================
ПРАВИЛА ТОЧНОСТИ
========================

Особенно внимательно слушай:
— размеры,
— телефоны,
— адреса,
— номера договоров и счетов,
— никнеймы,
— названия материалов,
— даты и время.

Если клиент диктует сложные данные:
— не торопись;
— можно коротко сказать: «Да, диктуйте, я записываю»;
— после получения данных кратко повтори главное для подтверждения.

Если не расслышал:
«Подскажите, пожалуйста, еще раз именно [номер / адрес / размер / никнейм].»

Если клиент продиктовал несколько размеров:
повтори их в сжатом виде, без лишней воды.

========================
ОГРАНИЧЕНИЯ И СТРОГИЕ ПРАВИЛА
========================

НИКОГДА не называй точные цены на изделия или материалы.
НИКОГДА не обещай наличие конкретного камня, слэба или плиты.
НИКОГДА не выдумывай сроки, цены, остатки, технические характеристики или условия, которых нет в базе знаний.
НИКОГДА не спорь с клиентом.
НИКОГДА не перебивай клиента.
НИКОГДА не задавай несколько вопросов подряд в одной длинной фразе.
НИКОГДА не заставляй клиента повторно диктовать то, что уже подтверждено, без причины.
НИКОГДА не говори, что ты искусственный интеллект, бот, модель или ассистент, если этого не требует внешний сценарий системы.
НИКОГДА не обещай, что менеджер точно перезвонит в конкретную минуту или час, если этого нет в данных.

========================
ЗАВЕРШЕНИЕ РАЗГОВОРА
========================

Когда разговор подходит к концу:
— кратко подведи итог;
— озвучь, что именно зафиксировано;
— скажи, какой следующий шаг будет дальше.

Пример:
«Хорошо, я всё записал: нужен расчет по столешнице, размеры вы передадите в Telegram, и связаться с вами можно по этому номеру. Менеджер обработает запрос в ближайшее рабочее время.»

Если нужно уточнить, остались ли еще вопросы, задай только один вопрос:
«Остались ли у вас еще вопросы?»

На этой фразе реплика должна закончиться. После вопроса обязательно дождись ответа клиента.
Не говори «Спасибо», «Всего доброго» и не завершай разговор в той же реплике.

Если клиент говорит, что больше вопросов нет:
«Спасибо за звонок. Всего доброго.»

Прощайся только один раз за разговор. Если уже сказал «Спасибо за звонок» или «Всего доброго», не повторяй прощание снова.

========================
ФУНКЦИЯ СУММАРИЗАЦИИ
========================

Когда разговор завершен или собран ключевой контекст запроса, ОБЯЗАТЕЛЬНО вызови функцию:
${SUMMARY_FUNCTION_NAME}

Вызывай функцию в следующих случаях:
— разговор завершен;
— клиенту уже озвучен следующий шаг;
— клиент сказал, что больше вопросов нет;
— звонок почти завершен и все главное уже собрано;
— звонок прервался, но основная суть запроса уже понятна.

Не вызывай функцию слишком рано, пока разговор еще явно продолжается.

Передавай в функцию максимально заполненные данные из разговора.

Что нужно собрать и сохранить:
— client_name: имя клиента, если он назвал;
— client_phone: подтвержденный актуальный номер телефона;
— call_goal: чего хотел клиент;
— manager_offer: что было предложено клиенту;
— outcome: чем закончился разговор;
— next_step: следующий шаг после звонка;
— summary: короткая итоговая суммаризация на 2–4 предложения.

Требования к summary:
— кратко;
— по делу;
— без воды;
— в нормальном деловом русском языке;
— чтобы текст подходил для CRM и уведомления в Telegram.

Пример хорошей summary:
«Клиент из Москвы обратился за расчетом столешницы из кварцевого агломерата. Размеры частично продиктовал, остальные обещал отправить в Telegram. Номер подтвержден. Запрос передан менеджеру на обработку в ближайшее рабочее время.»

Если каких-то данных нет, не выдумывай их.
Передавай только то, что действительно удалось выяснить в разговоре.
                            `
                        }
                    ]
                }
            };

            if (isGemini31Live) {
                Logger.write('===MODEL_MODE:gemini_3_1_live===');
            } else {
                Logger.write('===MODEL_MODE:legacy_live===');
            }

            const geminiLiveAPIClientParameters = {
                apiKey: GEMINI_API_KEY,
                model: GEMINI_MODEL,
                connectConfig: GEMINI_CONNECT_CONFIG,
                backend: Gemini.Backend.GEMINI_API,
                onWebSocketClose
            };

            geminiSocketAlive = false;
            geminiLiveAPIClient = await Gemini.createLiveAPIClient(geminiLiveAPIClientParameters);
            startWebSocketTimer();
            Logger.write('===GEMINI_CLIENT_CREATED===');

            geminiLiveAPIClient.addEventListener(Gemini.LiveAPIEvents.Unknown, (event) => {
                Logger.write('===Gemini.LiveAPIEvents.Unknown===');
                Logger.write(JSON.stringify(event));

                const { payload, customEvent } = extractEventData(event);
                if (customEvent) {
                    Logger.write(`===UNKNOWN_CUSTOM_EVENT:${customEvent}===`);
                }
                if (customEvent === 'UsageMetadata') {
                    Logger.write('===USAGE_METADATA_CUSTOM_EVENT_SEEN===');
                }
                applyUsageMetadata(event, 'Unknown');
            });

            geminiLiveAPIClient.addEventListener(Gemini.LiveAPIEvents.ToolCall, (event) => {
                Logger.write('===Gemini.LiveAPIEvents.ToolCall===');
                Logger.write(JSON.stringify(event));
                applyUsageMetadata(event, 'ToolCall');

                const { payload } = extractEventData(event);
                const functionCalls = payload.functionCalls || [];

                functionCalls.forEach((fc) => {
                    const fname = safeString(fc && fc.name);
                    const fid = safeString(fc && fc.id);
                    let fargs = (fc && fc.args) || {};

                    if (typeof fargs === 'string') {
                        try {
                            fargs = JSON.parse(fargs);
                        } catch (e) {
                            Logger.write('===TOOL_ARGS_PARSE_ERROR===');
                            Logger.write(String(e));
                            fargs = {};
                        }
                    }

                    Logger.write(`===TOOL_CALL_NAME:${fname}===`);
                    Logger.write(`===TOOL_CALL_ID:${fid}===`);
                    Logger.write(`===TOOL_CALL_ARGS:${JSON.stringify(fargs)}===`);

                    if (fname === SUMMARY_FUNCTION_NAME) {
                        summaryData.client_name = normalizeText(fargs.client_name);
                        summaryData.client_phone = normalizeText(fargs.client_phone || callerPhone);
                        summaryData.call_goal = normalizeText(fargs.call_goal);
                        summaryData.manager_offer = normalizeText(fargs.manager_offer);
                        summaryData.outcome = normalizeText(fargs.outcome);
                        summaryData.next_step = normalizeText(fargs.next_step);
                        summaryData.summary = normalizeText(fargs.summary);
                        summaryReceived = Boolean(summaryData.summary);

                        Logger.write('===SUMMARY_FUNCTION_CAPTURED===');
                        Logger.write(JSON.stringify(summaryData));

                        finishSummaryWait('tool_call_received');
                    }

                    if (fid) {
                        try {
                            geminiLiveAPIClient.sendToolResponse({
                                functionResponses: [
                                    {
                                        id: fid,
                                        name: fname || SUMMARY_FUNCTION_NAME,
                                        response: {
                                            result: 'ok'
                                        }
                                    }
                                ]
                            });
                            Logger.write(`===TOOL_RESPONSE_SENT:${fname}===`);
                        } catch (e) {
                            Logger.write('===TOOL_RESPONSE_ERROR===');
                            Logger.write(String(e));
                        }
                    }
                });
            });

            geminiLiveAPIClient.addEventListener(Gemini.LiveAPIEvents.SetupComplete, () => {
                Logger.write('===Gemini.LiveAPIEvents.SetupComplete===');
                geminiSocketAlive = true;

                VoxEngine.sendMediaBetween(call, geminiLiveAPIClient);

                if (isReconnect) {
                    const reconnectContext = buildReconnectDialogueContext(8);
                    const reconnectPrompt =
                        'Соединение было прервано и восстановлено. Коротко извинись за техническую паузу и продолжи разговор с текущего места. ' +
                        'Не начинай сценарий заново, не дублируй приветствие. ' +
                        (reconnectContext
                            ? `\nПоследние реплики по ролям:\n${reconnectContext}\n`
                            : '\n') +
                        `Перед финальным прощанием обязательно вызови функцию ${SUMMARY_FUNCTION_NAME}.`;
                    sendUserTextToModel(reconnectPrompt, 'reconnect_prompt');
                    Logger.write('===RECONNECT_PROMPT_SENT===');
                } else {
                    const startPrompt =
                        'Поздоровайся с клиентом на русском как Сергей из CrystalStone и кратко уточни, какая мебель нужна. ' +
                        'В первой реплике не спрашивай имя и номер телефона. ' +
                        `Номер из системы для последующего уточнения: ${callerPhone || 'неизвестен'}. ` +
                        `Перед финальным прощанием обязательно вызови функцию ${SUMMARY_FUNCTION_NAME} и заполни все поля кратко на русском.`;

                    sendUserTextToModel(startPrompt, 'start_prompt');
                    Logger.write('===START_PROMPT_SENT===');
                }
            });

            geminiLiveAPIClient.addEventListener(Gemini.LiveAPIEvents.ServerContent, (event) => {
                Logger.write('===Gemini.LiveAPIEvents.ServerContent===');

                const { payload, customEvent } = extractEventData(event);
                if (customEvent) {
                    Logger.write(`===SERVER_CONTENT_CUSTOM_EVENT:${customEvent}===`);
                }

                applyUsageMetadata(event, 'ServerContent');

                Logger.write(JSON.stringify(payload));

                const inputText =
                    payload.inputTranscription && payload.inputTranscription.text
                        ? safeString(payload.inputTranscription.text)
                        : '';
                const outputText =
                    payload.outputTranscription && payload.outputTranscription.text
                        ? safeString(payload.outputTranscription.text)
                        : '';

                if (inputText) {
                    if (currentAssistantParts.length) {
                        finalizePhrase('assistant', currentAssistantParts, 'interrupted');
                    }
                    currentUserParts.push(inputText);
                }

                if (outputText) {
                    if (currentUserParts.length) {
                        finalizePhrase('user', currentUserParts, 'complete');
                    }
                    currentAssistantParts.push(outputText);
                }

                if (payload.interrupted === true) {
                    Logger.write('===AGENT_INTERRUPTED===');
                    if (currentAssistantParts.length) {
                        finalizePhrase('assistant', currentAssistantParts, 'interrupted');
                    }
                    geminiLiveAPIClient.clearMediaBuffer();
                }

                if (payload.turnComplete === true && currentAssistantParts.length) {
                    finalizePhrase('assistant', currentAssistantParts, 'complete');
                }
            });

            geminiLiveAPIClient.addEventListener(Gemini.Events.WebSocketMediaStarted, (event) => {
                Logger.write('===Gemini.Events.WebSocketMediaStarted===');
                Logger.write(JSON.stringify(event));
            });

            geminiLiveAPIClient.addEventListener(Gemini.Events.WebSocketMediaEnded, (event) => {
                Logger.write('===Gemini.Events.WebSocketMediaEnded===');
                Logger.write(JSON.stringify(event));
                applyUsageMetadata(event, 'WebSocketMediaEnded');
            });
        } catch (error) {
            Logger.write('===SOMETHING_WENT_WRONG===');
            Logger.write(String(error));
            finalizeSession('start_session_error');
        } finally {
            isStartingGemini = false;
        }
    };

    answerTimer = setTimeout(async () => {
        if (isSessionTerminated || isFinalizing) return;

        Logger.write(`===ANSWER_DELAY_MS:${ANSWER_DELAY_MS}===`);
        if (!earlyMediaStarted) {
            Logger.write('===EARLY_MEDIA_NOT_STARTED===');
        }

        call.answer();
        Logger.write('===CALL_ANSWERED===');

        await startGeminiSession();
    }, ANSWER_DELAY_MS);

    startPreAnswerTone();
});




