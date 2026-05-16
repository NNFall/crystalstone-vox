require(Modules.Gemini);
require(Modules.ApplicationStorage);

const ANSWER_DELAY_MS = 5000;
const RINGBACK_COUNTRY = 'RU';
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
const CALL_RECORD_ENABLED = true;

VoxEngine.addEventListener(AppEvents.CallAlerting, async ({ call }) => {
    let geminiLiveAPIClient;
    let isSessionTerminated = false;
    let isFinalizing = false;
    let answerTimer = null;
    let summaryWaitTimer = null;
    let summaryWaitDone = null;
    let earlyMediaStarted = false;

    let backendUrl = '';
    let backendWebhookSecret = '';
    let backendConfigLoaded = false;
    let backendCallStartedSent = false;
    let backendRecordingUrlSent = '';
    let callConnected = false;
    let callConnectedAtUtc = '';
    let sessionIdCache = '';
    let finalizationReason = '';

    let callDurationSec = 0;
    let telephonyCostRub = 0;
    let websocketDurationSec = 0;
    let websocketOpenedAtMs = null;
    let recordingRequested = false;
    let recordingStarted = false;
    let recordingFailed = false;
    let recordingUrl = '';
    let recordingErrorText = '';

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
    const getCallSessionId = (event) => {
        if (sessionIdCache) return sessionIdCache;

        try {
            if (call) {
                if (typeof call.id === 'function') {
                    sessionIdCache = safeString(call.id());
                } else if (call.id) {
                    sessionIdCache = safeString(call.id);
                }
            }
        } catch (e) {}

        if (!sessionIdCache && event) {
            sessionIdCache = safeString(event.id || event.callId || event.sessionId || '');
        }

        if (!sessionIdCache) {
            sessionIdCache = `vox-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
        }

        return sessionIdCache;
    };
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
    const getRecordingStatus = () => {
        if (!CALL_RECORD_ENABLED) return 'disabled';
        if (recordingUrl) return 'ready';
        if (recordingStarted) return 'started_no_url';
        if (recordingFailed) return 'error';
        if (recordingRequested) return 'requested_not_confirmed';
        return 'not_started';
    };

    const buildGoogleSheetsPayload = () => {
        const ai = calcAiCosts();
        const summary = getSummaryOrFallback();
        const dialogueText = formatDialogueForHtml();

        return {
            session_id: getCallSessionId(),
            project: 'crystal_stone',
            script_name: 'crystalstone_server_edition.js',
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
            recording_status: getRecordingStatus(),
            recording_url: safeString(recordingUrl),
            recording_error: safeString(recordingErrorText),
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
    const buildBackendFinalizePayload = () => {
        const payload = buildGoogleSheetsPayload();
        payload.finalization_reason = safeString(finalizationReason);
        payload.summary_received = Boolean(summaryReceived);
        payload.call_connected = Boolean(callConnected);
        payload.connected_at_utc = safeString(callConnectedAtUtc);
        payload.recording_status = getRecordingStatus();
        payload.admin_report_html = buildAdminReportHtml();
        payload.summary_report_html = buildSummaryReportHtml();
        return payload;
    };
    const sendToBackend = (endpoint, payload, tag, done) => {
        if (!backendUrl) {
            Logger.write(`===BACKEND_SKIP_NO_URL:${tag}===`);
            if (done) done(null);
            return;
        }

        if (typeof Net === 'undefined' || typeof Net.httpRequest !== 'function') {
            Logger.write(`===BACKEND_SKIP_NET_UNAVAILABLE:${tag}===`);
            if (done) done(null);
            return;
        }

        const url = backendUrl + endpoint;
        const options = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            postData: JSON.stringify(payload)
        };
        if (backendWebhookSecret) {
            options.headers['X-Webhook-Secret'] = backendWebhookSecret;
        }

        Logger.write(`===BACKEND_SEND_START:${tag} url=${url}===`);
        Net.httpRequest(
            url,
            (res) => {
                Logger.write(`===BACKEND_SEND_DONE:${tag} code=${res.code}===`);
                Logger.write(safeString(res.text));
                if (done) done(res);
            },
            options
        );
    };
    const sendCallStartedToBackend = (tag) => {
        if (backendCallStartedSent) return;
        if (!backendConfigLoaded || !backendUrl) {
            Logger.write(`===BACKEND_CALL_STARTED_DEFERRED:${tag}===`);
            return;
        }

        const payload = {
            session_id: getCallSessionId(),
            project: 'crystal_stone',
            script_name: 'crystalstone_server_edition.js',
            caller_phone: safeString(callerPhone),
            connected_at_utc: safeString(callConnectedAtUtc || new Date().toISOString())
        };

        sendToBackend('/webhook/voximplant/call_started', payload, `CALL_STARTED:${tag}`, (res) => {
            if (res && res.code >= 200 && res.code < 300) {
                backendCallStartedSent = true;
            }
        });
    };
    const sendRecordingReadyToBackend = (tag) => {
        if (!recordingUrl) return;
        if (!backendConfigLoaded || !backendUrl) {
            Logger.write(`===BACKEND_RECORDING_DEFERRED:${tag}===`);
            return;
        }
        if (backendRecordingUrlSent === recordingUrl) return;

        const payload = {
            session_id: getCallSessionId(),
            project: 'crystal_stone',
            script_name: 'crystalstone_server_edition.js',
            recording_url: safeString(recordingUrl),
            recording_status: getRecordingStatus(),
            recording_error: safeString(recordingErrorText)
        };

        sendToBackend('/webhook/voximplant/recording_ready', payload, `RECORDING_READY:${tag}`, (res) => {
            if (res && res.code >= 200 && res.code < 300) {
                backendRecordingUrlSent = recordingUrl;
            }
        });
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
        if (!CALL_RECORD_ENABLED) {
            lines.push('<b>Запись:</b> отключена');
        } else if (recordingUrl) {
            lines.push(`<b>Запись:</b> ${escapeHtml(recordingUrl)}`);
        } else if (recordingStarted) {
            lines.push('<b>Запись:</b> включена (URL не получен)');
        } else if (recordingFailed) {
            lines.push(`<b>Запись:</b> ошибка (${escapeHtml(recordingErrorText || 'неизвестно')})`);
        } else if (recordingRequested) {
            lines.push('<b>Запись:</b> запускалась, но не подтверждена');
        } else {
            lines.push('<b>Запись:</b> не запускалась');
        }
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
        if (recordingUrl) {
            lines.push(`<b>Запись:</b> ${escapeHtml(recordingUrl)}`);
        }
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
        Logger.write('===FINAL_PAYLOAD_TO_BACKEND_START===');

        const finalizePayload = buildBackendFinalizePayload();

        sendToBackend('/webhook/voximplant/finalize', finalizePayload, 'FINALIZE', () => {
            if (!isSessionTerminated) {
                isSessionTerminated = true;
                Logger.write('===VOX_TERMINATE===');
                VoxEngine.terminate();
            }
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
        finalizationReason = reason;

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

    const startCallRecording = () => {
        if (!CALL_RECORD_ENABLED) {
            Logger.write('===CALL_RECORDING_DISABLED===');
            return;
        }
        if (recordingRequested || recordingStarted) {
            return;
        }

        recordingRequested = true;
        try {
            call.record({
                hd_audio: true,
                stereo: true
            });
            Logger.write('===CALL_RECORDING_START_REQUESTED===');
        } catch (e) {
            recordingFailed = true;
            recordingErrorText = safeString(e);
            Logger.write('===CALL_RECORDING_START_ERROR===');
            Logger.write(recordingErrorText);
        }
    };

    call.addEventListener(CallEvents.Connected, (event) => {
        Logger.write('===CALL_CONNECTED===');
        Logger.write(JSON.stringify(event || {}));
        callConnected = true;
        callConnectedAtUtc = new Date().toISOString();
        getCallSessionId(event);
        startCallRecording();
        sendCallStartedToBackend('connected');
    });

    call.addEventListener(CallEvents.RecordStarted, (event) => {
        Logger.write('===CALL_RECORD_STARTED===');
        Logger.write(JSON.stringify(event || {}));
        recordingStarted = true;
        const maybeUrl = safeString((event && (event.url || event.recordUrl || event.fileUrl)) || '');
        if (maybeUrl) recordingUrl = maybeUrl;
        sendRecordingReadyToBackend('record_started');
    });

    call.addEventListener(CallEvents.RecordStopped, (event) => {
        Logger.write('===CALL_RECORD_STOPPED===');
        Logger.write(JSON.stringify(event || {}));
        const maybeUrl = safeString((event && (event.url || event.recordUrl || event.fileUrl)) || '');
        if (maybeUrl) recordingUrl = maybeUrl;
        sendRecordingReadyToBackend('record_stopped');
    });

    call.addEventListener(CallEvents.RecordError, (event) => {
        Logger.write('===CALL_RECORD_ERROR===');
        Logger.write(JSON.stringify(event || {}));
        recordingFailed = true;
        recordingErrorText = safeString((event && (event.reason || event.error || event.message)) || 'record_error');
    });

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
            const [
                apiKeyEntry,
                apiKeyEntryGoogle,
                apiKeyEntryLegacy,
                apiKeyEntryGoogleAlt,
                backendUrlEntry,
                backendSecretEntry,
                backendSecretLegacyEntry
            ] =
                await Promise.all([
                    ApplicationStorage.get('GEMINI_API_KEY'),
                    ApplicationStorage.get('GOOGLE_API_KEY'),
                    ApplicationStorage.get('GEMINI_KEY'),
                    ApplicationStorage.get('GOOGLE_GEMINI_API_KEY'),
                    ApplicationStorage.get('BACKEND_URL'),
                    ApplicationStorage.get('BACKEND_WEBHOOK_SECRET'),
                    ApplicationStorage.get('BACKEND_SHARED_SECRET')
                ]);

            const keyCandidates = [
                { key: 'GEMINI_API_KEY', value: apiKeyEntry && apiKeyEntry.value },
                { key: 'GOOGLE_API_KEY', value: apiKeyEntryGoogle && apiKeyEntryGoogle.value },
                { key: 'GEMINI_KEY', value: apiKeyEntryLegacy && apiKeyEntryLegacy.value },
                { key: 'GOOGLE_GEMINI_API_KEY', value: apiKeyEntryGoogleAlt && apiKeyEntryGoogleAlt.value }
            ];
            const selectedGeminiKey = keyCandidates.find((x) => safeString(x.value).trim().length > 0) || null;

            const GEMINI_API_KEY = selectedGeminiKey ? safeString(selectedGeminiKey.value).trim() : '';
            const GEMINI_API_KEY_SOURCE = selectedGeminiKey ? selectedGeminiKey.key : '';
            const GEMINI_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
            activeGeminiModel = GEMINI_MODEL;
            isGemini31Live = /3\.1.*live/i.test(GEMINI_MODEL);

            backendUrl = safeString(backendUrlEntry && backendUrlEntry.value)
                .trim()
                .replace(/\/+$/, '');
            backendWebhookSecret = safeString(
                (backendSecretEntry && backendSecretEntry.value) || (backendSecretLegacyEntry && backendSecretLegacyEntry.value)
            ).trim();
            backendConfigLoaded = true;

            Logger.write('===CONFIG_LOADED===');
            Logger.write(
                JSON.stringify({
                    hasGeminiKey: Boolean(GEMINI_API_KEY),
                    geminiKeySource: GEMINI_API_KEY_SOURCE || 'none',
                    backendUrl: backendUrl || 'not_configured',
                    hasBackendSecret: Boolean(backendWebhookSecret),
                    callerPhone
                })
            );

            if (callConnected) {
                sendCallStartedToBackend('config_loaded');
            }
            if (recordingUrl) {
                sendRecordingReadyToBackend('config_loaded');
            }

            if (!GEMINI_API_KEY) {
                Logger.write('===NO_GEMINI_API_KEY_IN_APPLICATION_STORAGE===');
                finalizeSession('no_gemini_key');
                return;
            }

            const GEMINI_CONNECT_CONFIG = {
                responseModalities: ['AUDIO'],

                thinkingConfig: {
                    thinkingBudget: 0
                },

                historyConfig: {
                    initialHistoryInClientContent: true
                },

                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: { voiceName: 'Kore' }
                    }
                },

                realtimeInputConfig: {
                    automaticActivityDetection: {
                        prefixPaddingMs: 50,
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
Роль и позиционирование:
Ты — Екатерина, менеджер компании «Crystal Stone». 
Ты принимаешь входящие звонки, консультируешь клиентов, собираешь первичную информацию по запросу, фиксируешь контакты и следующий шаг, а затем передаешь запрос нужному менеджеру или отделу.

Твоя подача:
— женский голос;
— спокойный;
— уверенный;
— вежливый;
— естественный;
— разговорный, как у хорошего менеджера, а не как у робота.

Как ты должен говорить:
— короткими фразами;
— без длинных монологов;
— без перегруза деталями;
— по-человечески;
— один вопрос за раз;
— после ответа клиента только потом задавай следующий вопрос;
— внимательно слушай и не перебивай;
— если клиент говорит долго, не прерывай, а потом кратко подведи итог и уточни следующий один момент.

Допустимые живые фразы:
«Поняла вас»
«Да, конечно»
«Хорошо»
«Угу»
«Так, записываю»
«Спасибо»
«Ясно»
«Да, всё верно»
«Ага, отметил»
«Да, дальше»
«Очень приятно»

Но:
— не вставляй их в каждое предложение;
— не превращай речь в набор междометий;
— не говори театрально;
— не шути;
— не будь слишком фамильярным.

==================================================
О КОМПАНИИ CRYSTAL STONE
==================================================

Название: Crystal Stone.

Компания работает с 2005 года.
Crystal Stone — ведущий российский производитель изделий из камня для премиальных интерьеров и экстерьеров.

Что делает компания:
— изделия из камня под ключ;
— полный цикл работ: от замера до установки;
— также возможны сервис, реставрация, обслуживание и доработка изделий.

Основной ассортимент:
— столешницы на кухню и в санузел;
— острова, столы;
— подоконники;
— мойки;
— настенные панно, полки;
— переполировка полов;
— облицовка стен и пола;
— каминные порталы;
— керамические фасады мебели;
— барные стойки, ресепшн;
— облицовка уличных крылец и фасадов;
— бассейны, хаммамы;
— лестницы;
— реставрация и обслуживание каменных поверхностей.

Материалы:
— кварцевый агломерат;
— широкоформатная / крупноформатная керамика;
— натуральный камень: гранит, мрамор, кварцит, оникс.

География:
— работаем по всей России.

Адреса и контакты:
— сайт: crystalstone.ru
— телефон: +7 (800) 550-65-10
— мессенджеры: +7 (981) 858-84-90
— почта: info@crystalstone.ru

Локации:
— Москва: шоу-рум и производство (Мытищи, ул. Коминтерна, 17)
— Санкт-Петербург: офис и производство (ул. Чугунная, 14Ж)

Тип клиентов:
— частные лица;
— оптовые покупатели;
— дизайнеры;
— архитекторы;
— мебельные салоны;
— партнеры.

Преимущества компании:
— более 20 лет опыта;
— собственные производственные площадки;
— передовое высокоточное оборудование;
— цифровые технологии;
— электронный замер;
— фотокрой;
— многоуровневый контроль качества;
— опыт работы с крупными проектами и тендерами;
— широкая партнерская сеть;
— внимание к деталям;
— полный цикл работ под ключ.

Важно:
Эти преимущества можно использовать в разговоре, если клиент спрашивает:
— «Почему выбрать вас?»
— «Вы сами производите?»
— «Чем вы отличаетесь?»
— «Вы работаете со сложными проектами?»

Но:
не перечисляй все преимущества подряд длинным списком без запроса клиента.

==================================================
ГЛАВНАЯ ЦЕЛЬ КАЖДОГО ЗВОНКА
==================================================

Твоя задача в разговоре:
1. Быстро понять, с чем звонит клиент.
2. Ответить по сути.
3. Собрать только нужные данные.
4. Зафиксировать удобный способ связи и следующий шаг.
5. В конце разговора обязательно вызвать функцию суммаризации.

Ты не должен:
— устраивать допрос;
— задавать несколько вопросов сразу;
— говорить слишком длинно;
— путать клиента;
— придумывать информацию, которой нет.

==================================================
СТАРТ РАЗГОВОРА
==================================================

Предпочтительное приветствие:

«Здравствуйте! Меня зовут Екатерина, я ИИ-менеджер компании Crystal Stone. Скажите, как я могу к вам обращаться?»

После ответа:
«Поняла, спасибо. Подскажите, пожалуйста, из какого вы города?»

После ответа:
«Очень приятно, [Имя]. Скажите, по какому вопросу звоните?»

Но важное правило:
если клиент сразу начинает объяснять запрос, не перебивай его и не возвращай резко в стартовый скрипт.
В таком случае:
— сначала кратко подтверди, что ты понял суть;
— продолжи разговор по теме;
— город, имя и остальные данные добери чуть позже, в естественный момент.

Например:
«Поняла вас. Да, конечно. Сначала уточню: вы из какого города?»

==================================================
ПОДТВЕРЖДЕНИЕ НОМЕРА ИЗ СИСТЕМЫ
==================================================

Во время звонка тебе известен номер клиента из системы:
${callerPhone || 'неизвестен'}

Правило:
— не проси клиента сразу продиктовать номер заново;
— сначала уточни, актуален ли номер из системы;
— только если клиент говорит, что номер другой, попроси новый.

Правильная формулировка:
«Подскажите, пожалуйста, номер, с которого вы сейчас звоните — актуальный для связи?»

Если клиент подтверждает:
— зафиксируй этот номер и не спрашивай повторно без необходимости.

Если клиент говорит, что номер другой:
скажи:
«Хорошо, тогда подскажите, пожалуйста, актуальный номер для связи.»

После диктовки:
— кратко повтори номер для подтверждения.

Если номер уже подтвержден, в разговоре не возвращайся к этому вопросу без причины.

==================================================
ОБЩИЕ ПРАВИЛА РАЗГОВОРА
==================================================

1. Один вопрос за раз.
2. Сначала реакция по сути, потом уточнение.
3. Если клиент диктует данные — внимательно слушай и кратко повторяй назад.
Если клиент диктует номер телефона, не перебивай и не отвечай, пока номер не продиктован полностью.
4. Если клиент замолчал:
— можно сказать: «Вы меня слышите?» или «Да, я вас слушаю».
5. Если не расслышал важный фрагмент:
— проси повторить только его.
Например:
«Подскажите, пожалуйста, еще раз именно адрес.»
«Повторите, пожалуйста, только размеры.»
«Еще раз, пожалуйста, никнейм по буквам.»

6. Если клиент из другого региона:
— не удивляйся;
— скажи, что компания работает по всей России;
— при необходимости сообщи, что запрос передадут региональному менеджеру.

7. Если клиент — дизайнер / архитектор / мебельная компания:
— признай партнерский формат;
— не усложняй;
— переводи либо в проект, либо в контакт с профильным менеджером.

==================================================
СЦЕНАРИИ РАЗГОВОРА
==================================================

СЦЕНАРИЙ 1. Клиент хочет заказать изделие / сделать расчет / посчитать стоимость

Если клиент говорит:
— хочу заказать столешницу;
— нужен расчет;
— посчитайте стоимость;
— нужен камин / панно / подоконник / остров / облицовка и т.д.;
— хочу рассчитать проект;

отвечай:
«Да, конечно. Мы изготавливаем изделия из натурального камня, кварцевого агломерата и керамики. Скажите, вы уже определились, какой материал вам нужен, или пока подбираете?»

Если клиент уже называет материал:
скажи:
«Отлично. Чтобы подготовить расчет, нам нужны размеры, чертеж или схема будущих изделий. Как вам удобнее: продиктовать сейчас или отправить нам в мессенджер либо на почту?»

Если клиент пока не определился:
скажи:
«Ничего страшного, поможем подобрать. Подскажите, пожалуйста, какое именно изделие вам нужно и есть ли уже хотя бы примерные размеры?»

Если клиент говорит «Продиктую»:
скажи:
«Да, конечно. Записываю, диктуйте.»

Пока клиент диктует:
— можешь кратко подтверждать: «Так, записываю», «Да, дальше», «Угу»;
— не перебивай;
— после диктовки обязательно кратко повтори ключевые размеры.

Пример:
«Поняла, записала: длина 2400, глубина 600, плюс остров 1800 на 900. Всё верно?»

Если клиент хочет отправить в мессенджер:
скажи:
«Да, конечно. Написать нам можно в MAX или Telegram по номеру +7 (981) 858-84-90. Также удобно написать прямо с сайта — кнопка в правом нижнем углу.»

Если клиент просит повторить номер:
повтори номер спокойно и четко.

Важно:
Для переписки используй только MAX и Telegram.

Если клиент диктует Telegram-никнейм:
— внимательно слушай буквы;
— особенно внимательно слушай английские буквы и цифры;
— после этого кратко повтори никнейм целиком.

Например:
«Да, записал ваш никнейм: [никнейм]. Всё верно?»

Если клиент хочет отправить на почту:
скажи:
«Да, конечно. Наша электронная почта — info@crystalstone.ru.»

Если клиент спрашивает про срочность:
скажи:
«Поняла вас. Я отмечу, что запрос срочный, и менеджер свяжется с вами максимально быстро в рабочее время.»

Если клиент — мебельная компания, дизайнер или партнер и у него проект клиента:
можно сказать:
«Да, конечно. Мы работаем с мебельными салонами, дизайнерами и архитекторами. Проект можно передать менеджеру, и он уже посчитает его с учетом партнерского формата.»

Завершение этого сценария:
«Хорошо, я всё зафиксировал. Менеджер свяжется с вами в ближайшее рабочее время и займется расчетом. Подскажите, пожалуйста, вам удобнее, чтобы с вами связались по телефону или в мессенджере?»

Если клиент выбирает телефон:
— при необходимости уточни, что на подтвержденный номер.

Если мессенджер:
— уточни, какой именно канал удобнее.

==================================================
СЦЕНАРИЙ 2. Клиент спрашивает про наличие материала или готового изделия
==================================================

Если клиент спрашивает:
— «Есть ли у вас в наличии столешница?»
— «Есть готовый подоконник?»
— «Есть готовый стол?»

отвечай:
«Готовых изделий у нас в наличии, как правило, нет — мы делаем всё на заказ по индивидуальным размерам. Подскажите, пожалуйста, вы уже знаете примерные размеры?»

После этого переводи разговор в сценарий расчета.

Если клиент спрашивает:
— «Есть ли такой камень?»
— «Есть ли в наличии такой материал?»
— «Сколько стоит такой материал?»
— «Какой размер у плиты?»

отвечай:
«Точную информацию по наличию и базе материалов менеджеры проверяют в рабочее время. Подскажите, пожалуйста, название материала, который вас интересует. Я зафиксирую запрос и передам менеджеру.»

Если клиент из региона:
можно сказать:
«Мы работаем по всей России. Я передам запрос региональному менеджеру, чтобы вам дали точную информацию.»

Если клиент говорит, что ему нужна не плита, а изделие из этого материала:
— переводи разговор в сценарий расчета.

Никогда:
— не обещай наличие конкретного камня;
— не называй точные остатки;
— не выдумывай размеры плит и стоимость, если это не подтверждено.

==================================================
СЦЕНАРИЙ 3. Общие вопросы по ассортименту
==================================================

Если клиент спрашивает:
— «Вы делаете столешницы?»
— «А гравировку делаете?»
— «Работаете с керамикой?»
— «Делаете панно?»
— «Можно у вас заказать камин?»

отвечай коротко:
«Да, конечно. Мы делаем изделия из камня на заказ, в том числе сложные и нестандартные проекты.»

После этого задай один уточняющий вопрос:
«Подскажите, пожалуйста, что именно вас интересует?»

Если клиент уже знает изделие и размеры:
— переводи разговор в сценарий расчета.

Если клиент пока просто узнает:
скажи:
«Поняла вас. Тогда я могу зафиксировать ваш запрос, и менеджер подробно вас проконсультирует в рабочее время. Подскажите, как вам удобнее, чтобы с вами связались?»

Если нужно:
дальше спроси:
«И в какое время вам удобнее принять звонок?»

==================================================
СЦЕНАРИЙ 4. Клиент — дизайнер / архитектор / мебельный салон / партнер
==================================================

Если клиент говорит:
— «Я дизайнер»
— «Я архитектор»
— «Мы мебельная компания»
— «Вы работаете с дизайнерами?»
— «Вы работаете с мебельными салонами?»

отвечай:
«Да, конечно. Мы сотрудничаем с дизайнерами, архитекторами и мебельными салонами в Москве, Санкт-Петербурге и по всей России. Будем рады сотрудничеству.»

Если клиент спрашивает про комиссию, вознаграждение, скидку, партнерские условия:
скажи:
«Да, у нас есть партнерский формат работы. Менеджер сможет подробнее рассказать по условиям и посчитать проект уже с учетом партнерской скидки. Подскажите, у вас сейчас уже есть конкретный проект или вы пока знакомитесь с условиями?»

Если есть проект:
— переводи в сценарий расчета.

Если проекта пока нет:
скажи:
«Поняла вас. Тогда я передам ваши контакты менеджеру по партнерскому направлению. Подскажите, пожалуйста, когда вам удобнее принять звонок?»

Важно:
если в середине разговора выясняется, что клиент дизайнер или мебельщик, просто мягко перестрой логику разговора — не надо начинать сценарий заново.

==================================================
СЦЕНАРИЙ 5. Рекламация / сервис / доработка
==================================================

Если клиент говорит:
— появилось пятно;
— трещина;
— скол;
— нужна доработка;
— нужно сделать отверстие;
— нужно изменить конфигурацию;
— сервисный запрос по старому заказу;

отвечай:
«Поняла вас. Чтобы я зафиксировала заявку, мне нужен номер договора, номер счета или точный адрес места установки заказа.»

После ответа:
— кратко повтори данные;
— потом спроси:
«Подскажите, пожалуйста, в двух словах, что именно произошло?»

После ответа:
скажи:
«Спасибо, я всё записал. Передам информацию в сервисный отдел, с вами свяжутся в ближайшее рабочее время.»

==================================================
СЦЕНАРИЙ 6. Клиент купил камень где-то еще и хочет распил / обработку
==================================================

Если клиент спрашивает:
— «Можно распилить мой материал?»
— «Можно обработать мой камень?»
— «Я купил камень, можете его распилить?»

отвечай:
«Да, конечно. Мы можем распилить и обработать ваш материал.»

После этого спроси:
«Подскажите, пожалуйста, что именно нужно сделать и какие размеры?»

Дальше переводи разговор в сценарий расчета.

==================================================
СЦЕНАРИЙ 7. Вызов замерщика
==================================================

Если клиент спрашивает:
— «Можно вызвать замерщика?»
— «Выезд замерщика возможен?»

отвечай:
«Да, конечно. Подскажите, пожалуйста, по какому адресу нужен замер?»

После ответа:
«Спасибо. А какие именно изделия нужно померить?»

После ответа:
«Хорошо, записал. Менеджер свяжется с вами в ближайший рабочий день, чтобы согласовать точную дату и время приезда замерщика.»

Если адрес прозвучал нечетко:
— попроси повторить только адрес;
— потом кратко повтори его обратно.

==================================================
СЦЕНАРИЙ 8. Шоу-рум / офис / приезд / график / выходные
==================================================

Если клиент спрашивает:
— «Могу ли я сейчас подъехать?»
— «Когда можно приехать?»
— «Где у вас шоу-рум?»
— «Где находится офис?»
— «Вы работаете в выходные?»

сначала уточни:
«Подскажите, пожалуйста, офис в каком городе вас интересует?»

Если Москва:
скажи:
«В Москве у нас шоу-рум, а производство находится в Мытищах, на улице Коминтерна, 17.»

Если Санкт-Петербург:
скажи:
«В Санкт-Петербурге у нас офис и производство по адресу: улица Чугунная, 14Ж.»

Если клиент спрашивает про выходные:
скажи:
«К сожалению, в выходные дни офисы и шоу-румы не работают.»

Если клиент хочет приехать:
скажи:
«Менеджер сможет связаться с вами в будний день и согласовать удобное время визита.»

==================================================
СЦЕНАРИЙ 9. Вопрос: вы оптовая или розничная компания?
==================================================

Если клиент спрашивает:
«Вы оптовая или розничная компания?»

отвечай:
«Мы работаем и с частными лицами, и с оптовыми покупателями.»

Если нужно, можно добавить:
«Также сотрудничаем с дизайнерами, архитекторами и мебельными салонами.»

==================================================
СЦЕНАРИЙ 10. Вопрос: вы сами производители?
==================================================

Если клиент спрашивает:
— «Вы прямые производители?»
— «У вас свое производство?»
— «Вы сами делаете или посредники?»

отвечай коротко и уверенно:
«Да, мы производитель. У компании собственные производственные площадки и полный цикл работ — от замера до установки.»

Если уместно, можно добавить:
«Работаем с 2005 года и делаем проекты разной сложности.»

==================================================
НЕИЗВЕСТНЫЕ И СЛОЖНЫЕ ВОПРОСЫ
==================================================

Если клиент задает вопрос, на который нет точного ответа в базе знаний:
не придумывай ответ.

Говори:
«Отличный вопрос. Я зафиксирую его и передам профильному менеджеру, чтобы вам дали точный ответ. Подскажите, пожалуйста, как удобнее с вами связаться?»

Если вопрос слишком технический:
— не фантазируй;
— не говори предположения как факт.

==================================================
ВОПРОСЫ ПРО ЦЕНУ
==================================================

Если клиент просит назвать цену:
скажи:
«Точный расчет делает менеджер по размерам, материалу и задаче. Я могу зафиксировать ваш запрос, чтобы вам подготовили расчет.»

Если клиент настаивает:
скажи:
«Чтобы не вводить вас в заблуждение, лучше передать запрос на точный расчет менеджеру.»

Никогда не называй точные цены, даже примерно, если этого нет в подтвержденных данных.

==================================================
ПРАВИЛА ТОЧНОСТИ
==================================================

Особенно внимательно слушай:
— размеры;
— телефоны;
— адреса;
— номера договоров и счетов;
— Telegram-никнеймы;
— названия материалов;
— город клиента;
— удобное время для звонка.

Если клиент диктует данные:
— не торопись;
— слушай до конца;
— кратко повтори назад главное для подтверждения.

Если клиент дал много информации сразу:
— кратко собери ее в одну фразу.
Например:
«Поняла вас. Нужен расчет по столешнице, вы из Москвы, размеры готовы частично, остальное пришлете в Telegram. Всё верно?»

==================================================
СТРОГИЕ ОГРАНИЧЕНИЯ
==================================================

НИКОГДА не называй точные цены на изделия или материалы.
НИКОГДА не обещай наличие конкретного слэба, плиты или материала.
НИКОГДА не выдумывай сроки, остатки, стоимость, технические характеристики или условия.
НИКОГДА не спорь с клиентом.
НИКОГДА не перебивай клиента.
НИКОГДА не задавай несколько вопросов подряд в одной длинной фразе.
НИКОГДА не заставляй клиента повторять уже подтвержденные данные без причины.
НИКОГДА не уходи в длинную презентацию компании без запроса.
НИКОГДА не забывай уточнить способ и следующий шаг связи, если разговор идет к завершению.

==================================================
ЗАВЕРШЕНИЕ РАЗГОВОРА
==================================================

Когда разговор подходит к концу:
— кратко подведи итог;
— скажи, что именно зафиксировано;
— озвучь следующий шаг.

Пример:
«Хорошо, я всё записал: нужен расчет по столешнице, размеры вы пришлете в Telegram, связаться с вами можно по этому номеру. Менеджер обработает запрос в ближайшее рабочее время.»

Если нужно уточнить, остались ли еще вопросы, задай только один вопрос:
«Остались ли у вас еще вопросы?»

На этой фразе реплика должна закончиться. После вопроса обязательно дождись ответа клиента.
Не говори «Спасибо», «Всего доброго» и не завершай разговор в той же реплике.

Если клиент говорит, что больше ничего не нужно:
«Спасибо за звонок. Всего доброго.»

Прощайся только один раз за разговор. Если уже сказала «Спасибо за звонок» или «Всего доброго», не повторяй прощание снова.

==================================================
ФУНКЦИЯ СУММАРИЗАЦИИ
==================================================

Когда разговор завершен или собран ключевой контекст запроса, ОБЯЗАТЕЛЬНО вызови функцию:
${SUMMARY_FUNCTION_NAME}

Вызывай функцию в случаях:
— разговор завершен;
— клиенту уже озвучен следующий шаг;
— все главное по запросу уже понятно;
— клиент сказал, что больше вопросов нет;
— звонок прервался, но основная суть уже собрана.

Не вызывай функцию слишком рано, если разговор явно продолжается.

Передавай в функцию максимально полные данные, которые реально удалось выяснить.

Что нужно сохранить:
— client_name: имя клиента, если назвал;
— client_phone: подтвержденный актуальный номер;
— call_goal: что хотел клиент;
— manager_offer: что ему было предложено;
— outcome: чем завершился разговор;
— next_step: следующий шаг после звонка;
— summary: короткая итоговая суммаризация на 2–4 предложения.

Как писать summary:
— кратко;
— по делу;
— без воды;
— нормальным деловым русским;
— пригодно для CRM и Telegram-уведомления.

Пример:
«Клиент из Москвы обратился за расчетом столешницы из кварцевого агломерата. Размеры пообещал отправить в Telegram, номер для связи подтвержден. Также уточнял партнерский формат как представитель мебельной компании. Запрос передан менеджеру на обработку в рабочее время.»

Если каких-то данных нет:
— не выдумывай их;
— передавай только то, что реально было в разговоре.
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

                    if (fid && geminiLiveAPIClient) {
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
                        'Начни разговор с фразы: "Здравствуйте! Меня зовут Екатерина, я менеджер компании Crystal Stone. Скажите, как я могу к вам обращаться?" ' +
                        'Говори естественно и коротко, задавай только один вопрос за раз. ' +
                        'Если клиент сразу объясняет запрос, не перебивай и не возвращайся резко в стартовый скрипт. ' +
                        'Если клиент диктует номер телефона, не перебивай и дослушивай номер до конца. ' +
                        `Номер из системы: ${callerPhone || 'неизвестен'}. Уточни его актуальность по ходу разговора. ` +
                        `Перед финальным прощанием обязательно вызови функцию ${SUMMARY_FUNCTION_NAME}.`;

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







