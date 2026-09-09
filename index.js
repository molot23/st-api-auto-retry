/**
 * st-api-auto-retry — SillyTavern 扩展：上游 API 错误自动重试（可确认）
 * Author: molot23
 * Version: 1.1.0
 */
(function () {
    'use strict';

    const MODULE_NAME = 'st-api-auto-retry';
    const LOG_PREFIX = '[API自动重试]';
    const VERSION = '1.1.0';
    const STATUS_MARKER = '[API自动重试]';

    const defaultSettings = Object.freeze({
        enabled: true,
        confirmBeforeRetry: true,
        maxRetries: 3,
        baseDelayMs: 2000,
        exponentialBackoff: true,
        retryStatusCodes: [408, 429, 500, 502, 503, 504, 524],
        generationOnly: true,
    });

    /** Path fragments that look like ST / proxy generation requests */
    const GENERATION_PATH_HINTS = [
        'chat/completions',
        'completions',
        'generate',
        'openai',
        'backends/chat-completions',
        'backends/text-completions',
        'text-completions',
        'chat-completions',
        'api/openai',
        'api/backends',
        'api/generate',
        'v1/chat',
        'v1/completions',
        'novelai',
        'claude',
        'gemini',
        'makersuite',
        'openrouter',
        'aihorde',
        'kobold',
        'ooba',
        'tabby',
        'togetherai',
        'mistral',
        'cohere',
        'perplexity',
        'deepseek',
        'groq',
        'fireworks',
        'custom',
    ];

    /** Paths we never retry (updates, translations, assets, etc.) */
    const EXCLUDE_PATH_HINTS = [
        'extensions/update',
        'extensions/install',
        'extensions/delete',
        'translate',
        'assets',
        'csrf-token',
        'version',
        'settings',
        'characters/all',
        'chats/',
        'files/',
        'sprites',
        'backgrounds',
        'themes',
        'worldinfo',
        'stats',
        'user',
    ];

    /**
     * Body / message patterns that indicate a retriable upstream failure,
     * even when the browser-facing HTTP status is 200 or a non-listed code
     * (ST server often wraps Custom OpenAI 524 as HTTP 500 with the real
     * status only inside the error message).
     */
    /** Strong signals — enough alone to treat as retriable */
    const RETRIABLE_BODY_STRONG = [
        /status\s*524/i,
        /openai_error/i,
        /Gateway Time-?out/i,
        /ECONNRESET|ETIMEDOUT|socket hang up/i,
        /Custom OpenAI endpoint failed/i,
        /Failed to generate chat completion/i,
        /\[API\s*错误\]/i,
        /cloudflare.*(?:524|timeout|timed.?out)/i,
        /upstream.*(timeout|timed?\s*out|unavailable)/i,
        /timeout.*(upstream|gateway|proxy)/i,
    ];

    /** Weaker signals — require API-error context nearby */
    const RETRIABLE_BODY_WEAK = [
        /Internal error/i,
        /\b524\b/,
        /\b502\b/,
        /\b503\b/,
        /\b429\b/,
        /\b504\b/,
        /\b500\b/,
    ];

    const API_ERROR_CONTEXT = /error|failed|failure|endpoint|openai|completion|backend|upstream|gateway|proxy|超时|错误|失败/i;

    const originalFetch = window.fetch.bind(window);

    /** Prevents eventSource backup from looping with fetch-path retries */
    let aar_inflight = false;
    /** Last recognized failure labels for status suffix */
    let lastRecognizedLabels = [];

    function getContextSafe() {
        try {
            if (typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function') {
                return SillyTavern.getContext();
            }
        } catch (e) {
            /* ignore */
        }
        return null;
    }

    function getSettings() {
        const ctx = getContextSafe();
        const store = ctx?.extensionSettings
            || (typeof extension_settings !== 'undefined' ? extension_settings : null)
            || window.extension_settings;

        if (!store) {
            return { ...defaultSettings };
        }

        if (!store[MODULE_NAME]) {
            store[MODULE_NAME] = structuredClone(defaultSettings);
        }

        for (const key of Object.keys(defaultSettings)) {
            if (!Object.hasOwn(store[MODULE_NAME], key)) {
                store[MODULE_NAME][key] = defaultSettings[key];
            }
        }

        return store[MODULE_NAME];
    }

    function saveSettings() {
        const ctx = getContextSafe();
        if (ctx?.saveSettingsDebounced) {
            ctx.saveSettingsDebounced();
            return;
        }
        if (typeof saveSettingsDebounced === 'function') {
            saveSettingsDebounced();
        }
    }

    function toast(type, message, title) {
        try {
            if (typeof toastr !== 'undefined' && toastr[type]) {
                toastr[type](message, title || 'API 自动重试');
                return;
            }
        } catch (e) {
            /* ignore */
        }
        console.log(`${LOG_PREFIX} [${type}] ${title || ''} ${message}`);
    }

    function parseStatusCodes(raw) {
        if (Array.isArray(raw)) {
            return raw.map(Number).filter((n) => !Number.isNaN(n));
        }
        if (typeof raw === 'string') {
            return raw
                .split(/[,，\s]+/)
                .map((s) => parseInt(s.trim(), 10))
                .filter((n) => !Number.isNaN(n));
        }
        return [...defaultSettings.retryStatusCodes];
    }

    function getUrlString(input) {
        if (typeof input === 'string') return input;
        if (input instanceof Request) return input.url;
        if (input && typeof input.url === 'string') return input.url;
        try {
            return String(input);
        } catch (e) {
            return '';
        }
    }

    function isGenerationRequest(url) {
        const settings = getSettings();
        if (!settings.generationOnly) return true;

        let path = url;
        try {
            const u = new URL(url, window.location.origin);
            path = (u.pathname + u.search).toLowerCase();
        } catch (e) {
            path = String(url).toLowerCase();
        }

        for (const ex of EXCLUDE_PATH_HINTS) {
            if (path.includes(ex.toLowerCase())) return false;
        }

        for (const hint of GENERATION_PATH_HINTS) {
            if (path.includes(hint.toLowerCase())) return true;
        }

        if (/\/api\/(backends|openai|generate)/i.test(path)) return true;

        return false;
    }

    function isAbortError(err) {
        if (!err) return false;
        if (err.name === 'AbortError') return true;
        if (err.code === 20) return true;
        const msg = String(err.message || err).toLowerCase();
        return msg.includes('aborted') || msg.includes('abort');
    }

    function isRetriableStatus(status, settings) {
        const codes = parseStatusCodes(settings.retryStatusCodes);
        return codes.includes(Number(status));
    }

    /**
     * Extract human-readable labels from error text for the status suffix.
     */
    function extractRecognizedLabels(text) {
        const labels = [];
        const t = String(text || '');
        if (/status\s*524|\b524\b|openai_error/i.test(t)) {
            labels.push('524 / openai_error');
        } else {
            if (/\b524\b|status\s*524/i.test(t)) labels.push('524');
            if (/openai_error/i.test(t)) labels.push('openai_error');
        }
        if (/Gateway Time-?out|\b504\b/i.test(t)) labels.push('504/Gateway Timeout');
        if (/\b502\b/i.test(t)) labels.push('502');
        if (/\b503\b/i.test(t)) labels.push('503');
        if (/\b429\b/i.test(t)) labels.push('429');
        if (/ECONNRESET|ETIMEDOUT|socket hang up/i.test(t)) labels.push('网络中断');
        if (/Custom OpenAI endpoint failed/i.test(t) && !labels.length) {
            labels.push('Custom OpenAI endpoint failed');
        }
        if (/Failed to generate chat completion|Internal error/i.test(t) && !labels.length) {
            labels.push('Internal error');
        }
        // de-dupe
        return [...new Set(labels)];
    }

    /**
     * Does the error body/message match retriable patterns?
     */
    function bodyLooksRetriable(text) {
        if (!text) return false;
        const s = String(text);
        for (const re of RETRIABLE_BODY_STRONG) {
            if (re.test(s)) return true;
        }
        // Bare status codes / "Internal error" only when clearly an API error context
        if (API_ERROR_CONTEXT.test(s)) {
            for (const re of RETRIABLE_BODY_WEAK) {
                if (re.test(s)) return true;
            }
        }
        return false;
    }

    /**
     * Read response body text safely (clone first). Returns { text, labels }.
     */
    async function readBodyText(response) {
        if (!response) return { text: '', labels: [] };
        try {
            const clone = response.clone();
            const text = await clone.text();
            return { text: text || '', labels: extractRecognizedLabels(text) };
        } catch (_) {
            return { text: '', labels: [] };
        }
    }

    /**
     * Decide whether a completed fetch response should be retried.
     * Checks HTTP status AND body content (for wrapped 524s).
     */
    async function classifyResponse(response, settings) {
        const statusRetriable = isRetriableStatus(response.status, settings);
        const { text, labels } = await readBodyText(response);
        const bodyRetriable = bodyLooksRetriable(text);

        // Prefer JSON error.message when present for labels
        let detailLabels = labels;
        let detailText = text;
        try {
            const json = JSON.parse(text);
            const errMsg = json?.error?.message || json?.error || json?.message || json?.detail;
            if (errMsg) {
                const msgStr = typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg);
                detailText = msgStr;
                detailLabels = extractRecognizedLabels(msgStr + '\n' + text);
                if (bodyLooksRetriable(msgStr)) {
                    return {
                        retriable: true,
                        reason: 'body',
                        text: detailText,
                        fullText: text,
                        labels: detailLabels.length ? detailLabels : labels,
                        status: response.status,
                    };
                }
            }
        } catch (_) {
            /* not JSON */
        }

        if (statusRetriable || bodyRetriable) {
            return {
                retriable: true,
                reason: statusRetriable && bodyRetriable ? 'status+body'
                    : (statusRetriable ? 'status' : 'body'),
                text: detailText || text,
                fullText: text,
                labels: detailLabels.length ? detailLabels : (
                    statusRetriable ? [`HTTP ${response.status}`] : labels
                ),
                status: response.status,
            };
        }

        // response.ok but body still contains retriable error (e.g. ST returns 200 with error field)
        if (response.ok && bodyRetriable) {
            return {
                retriable: true,
                reason: 'body-ok-status',
                text: detailText || text,
                fullText: text,
                labels: detailLabels,
                status: response.status,
            };
        }

        return {
            retriable: false,
            reason: null,
            text: detailText || text,
            fullText: text,
            labels: detailLabels,
            status: response.status,
        };
    }

    function classifyNetworkError(err) {
        const msg = String(err?.message || err || '');
        const labels = extractRecognizedLabels(msg);
        if (!labels.length) labels.push('网络错误');
        const retriable = !isAbortError(err) && (
            bodyLooksRetriable(msg)
            || /failed to fetch|networkerror|load failed|network request failed/i.test(msg)
            || err?.name === 'TypeError'
        );
        return { retriable, text: msg, labels };
    }

    function computeDelay(attempt, settings) {
        const base = Math.max(0, Number(settings.baseDelayMs) || 0);
        if (settings.exponentialBackoff) {
            return base * Math.pow(2, Math.max(0, attempt - 1));
        }
        return base;
    }

    function sleep(ms, signal) {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) {
                reject(new DOMException('Aborted', 'AbortError'));
                return;
            }
            const timer = setTimeout(resolve, ms);
            if (signal) {
                const onAbort = () => {
                    clearTimeout(timer);
                    reject(new DOMException('Aborted', 'AbortError'));
                };
                signal.addEventListener('abort', onAbort, { once: true });
            }
        });
    }

    async function askUserConfirm(summary) {
        const title = 'API 失败 — 是否重试？';
        const body = summary || '上游 API 返回可重试错误。';

        const ctx = getContextSafe();

        try {
            if (ctx?.Popup?.show?.confirm) {
                const result = await ctx.Popup.show.confirm(title, body);
                if (result === true) return true;
                if (ctx.POPUP_RESULT && result === ctx.POPUP_RESULT.AFFIRMATIVE) return true;
                if (result === 1) return true;
                return false;
            }
        } catch (e) {
            console.warn(`${LOG_PREFIX} Popup.show.confirm failed`, e);
        }

        try {
            if (ctx?.Popup && ctx?.POPUP_TYPE?.CONFIRM) {
                const popup = new ctx.Popup(body, ctx.POPUP_TYPE.CONFIRM, title);
                const result = await popup.show();
                if (ctx.POPUP_RESULT && result === ctx.POPUP_RESULT.AFFIRMATIVE) return true;
                if (result === 1 || result === true) return true;
                return false;
            }
        } catch (e) {
            console.warn(`${LOG_PREFIX} Popup CONFIRM failed`, e);
        }

        try {
            if (typeof callGenericPopup === 'function') {
                const POPUP_TYPE = window.POPUP_TYPE || { CONFIRM: 1 };
                const result = await callGenericPopup(body, POPUP_TYPE.CONFIRM, title);
                if (result === 1 || result === true) return true;
                return false;
            }
        } catch (e) {
            console.warn(`${LOG_PREFIX} callGenericPopup failed`, e);
        }

        return window.confirm(`${title}\n\n${body}`);
    }

    function formatStatusSuffix({ attemptsDone, maxRetries, cancelled, labels }) {
        const labelStr = (labels && labels.length)
            ? labels.join(' / ')
            : '可重试错误';
        if (cancelled) {
            return `\n\n${STATUS_MARKER} 状态：用户取消重试（已失败 ${attemptsDone} 次）`;
        }
        return `\n\n${STATUS_MARKER} 状态：已重试 ${attemptsDone}/${maxRetries} 次后仍失败（识别到 ${labelStr}）`;
    }

    /**
     * Build a new Response so ST surfaces our status line in chat / toast.
     */
    function buildAnnotatedErrorResponse(originalResponse, bodyText, statusSuffix, classification) {
        const status = originalResponse?.status && !originalResponse.ok
            ? originalResponse.status
            : 500;
        const statusText = originalResponse?.statusText || 'Error';

        let newBody = bodyText || '';
        // Prefer rewriting JSON error.message so ST's error extractor picks it up
        try {
            const json = JSON.parse(bodyText || '');
            if (json && typeof json === 'object') {
                if (json.error && typeof json.error === 'object') {
                    const prev = json.error.message || '';
                    json.error.message = String(prev) + statusSuffix;
                } else if (typeof json.error === 'string') {
                    json.error = json.error + statusSuffix;
                } else if (json.message) {
                    json.message = String(json.message) + statusSuffix;
                } else {
                    json.message = (classification?.text || 'API error') + statusSuffix;
                }
                newBody = JSON.stringify(json);
            } else {
                newBody = String(bodyText || '') + statusSuffix;
            }
        } catch (_) {
            // Plain text / non-JSON — append suffix
            if (newBody.includes('Failed to generate') || newBody.includes('Custom OpenAI')
                || newBody.includes('[API') || newBody.includes('openai_error')
                || newBody.includes('Internal error')) {
                newBody = newBody + statusSuffix;
            } else if (classification?.text) {
                newBody = classification.text + statusSuffix;
            } else {
                newBody = (newBody || `HTTP ${status}`) + statusSuffix;
            }
        }

        const headers = new Headers(originalResponse?.headers || {});
        // Ensure content-type so ST parses consistently
        if (!headers.has('content-type')) {
            headers.set('content-type', 'application/json; charset=utf-8');
        }

        return new Response(newBody, {
            status,
            statusText,
            headers,
        });
    }

    /**
     * Append status line to the last chat message if ST already wrote [API 错误].
     */
    function appendStatusToLastChatMessage(statusSuffix) {
        try {
            const ctx = getContextSafe();
            if (!ctx) return false;

            const chat = ctx.chat;
            if (!Array.isArray(chat) || chat.length === 0) return false;

            // Walk from end for an error-looking assistant / system message
            for (let i = chat.length - 1; i >= Math.max(0, chat.length - 5); i--) {
                const msg = chat[i];
                if (!msg || typeof msg.mes !== 'string') continue;
                const mes = msg.mes;
                if (mes.includes(STATUS_MARKER)) return true; // already annotated
                if (
                    /\[API\s*错误\]/i.test(mes)
                    || /Custom OpenAI endpoint failed/i.test(mes)
                    || /Failed to generate chat completion/i.test(mes)
                    || /openai_error/i.test(mes)
                    || /status\s*524/i.test(mes)
                ) {
                    msg.mes = mes + statusSuffix;
                    // Try to re-render
                    try {
                        if (typeof ctx.reloadCurrentChat === 'function') {
                            // Avoid full reload if we can update DOM / format in place
                        }
                        if (typeof ctx.updateChatMessage === 'function') {
                            ctx.updateChatMessage(i);
                        } else if (typeof ctx.messageFormatting === 'function') {
                            // Fall through to DOM patch
                        }
                        // DOM: update last .mes with error text
                        const $ = window.jQuery || window.$;
                        if ($) {
                            const $blocks = $('#chat .mes').filter(function () {
                                const t = $(this).find('.mes_text').text() || '';
                                return /\[API\s*错误\]|openai_error|status\s*524|Custom OpenAI/i.test(t);
                            });
                            if ($blocks.length) {
                                const $last = $blocks.last();
                                const $text = $last.find('.mes_text');
                                if ($text.length && !$text.text().includes(STATUS_MARKER)) {
                                    $text.append(document.createTextNode(statusSuffix));
                                }
                            }
                        }
                    } catch (e) {
                        console.warn(`${LOG_PREFIX} chat re-render failed`, e);
                    }
                    // Persist if possible
                    try {
                        if (typeof ctx.saveChatDebounced === 'function') ctx.saveChatDebounced();
                        else if (typeof ctx.saveChat === 'function') ctx.saveChat();
                    } catch (_) { /* ignore */ }
                    return true;
                }
            }
        } catch (e) {
            console.warn(`${LOG_PREFIX} appendStatusToLastChatMessage failed`, e);
        }
        return false;
    }

    /**
     * Clone fetch init so body can be resent across retries.
     * ReadableStream bodies cannot be reused — materialize to text/ArrayBuffer.
     */
    async function prepareReusableRequest(input, init) {
        const url = getUrlString(input);
        const baseInit = Object.assign({}, init || {});

        // Merge Request object fields when input is a Request
        let method = baseInit.method;
        let headers = baseInit.headers;
        let signal = baseInit.signal;
        let body = baseInit.body;

        if (input instanceof Request) {
            method = method || input.method;
            headers = headers || input.headers;
            signal = signal || input.signal;
            if (body === undefined) {
                try {
                    // Prefer text for JSON APIs; fallback arrayBuffer
                    const ct = input.headers?.get?.('content-type') || '';
                    if (/json|text|urlencoded|xml/i.test(ct) || !ct) {
                        body = await input.clone().text();
                    } else {
                        body = await input.clone().arrayBuffer();
                    }
                } catch (e) {
                    console.warn(`${LOG_PREFIX} could not clone Request body`, e);
                    body = undefined;
                }
            }
        }

        // If init.body is a ReadableStream, consume it once into reusable form
        if (body && typeof body === 'object' && typeof body.getReader === 'function') {
            try {
                const resp = new Response(body);
                body = await resp.arrayBuffer();
            } catch (e) {
                console.warn(`${LOG_PREFIX} could not materialize stream body`, e);
            }
        }

        // Headers: normalize to plain object / Headers we can reuse
        let headersInit = headers;
        if (headers instanceof Headers) {
            headersInit = headers;
        }

        const reusableInit = {
            method: method || 'GET',
            headers: headersInit,
            body,
            signal,
            credentials: baseInit.credentials,
            cache: baseInit.cache,
            redirect: baseInit.redirect,
            referrer: baseInit.referrer,
            referrerPolicy: baseInit.referrerPolicy,
            mode: baseInit.mode,
            keepalive: baseInit.keepalive,
            integrity: baseInit.integrity,
        };

        // GET/HEAD must not have body
        const m = String(reusableInit.method || 'GET').toUpperCase();
        if (m === 'GET' || m === 'HEAD') {
            delete reusableInit.body;
        }

        // Drop undefined keys
        for (const k of Object.keys(reusableInit)) {
            if (reusableInit[k] === undefined) delete reusableInit[k];
        }

        return { url, init: reusableInit };
    }

    function makeAttemptInit(reusableInit) {
        // Shallow clone each attempt; body string/ArrayBuffer is fine to reuse
        const next = Object.assign({}, reusableInit);
        if (reusableInit.headers instanceof Headers) {
            next.headers = new Headers(reusableInit.headers);
        } else if (reusableInit.headers && typeof reusableInit.headers === 'object') {
            next.headers = reusableInit.headers;
        }
        return next;
    }

    async function summarizeForConfirm(classification, networkError) {
        if (networkError) {
            return `网络错误：${networkError.name || 'Error'} — ${networkError.message || String(networkError)}`;
        }
        if (!classification) return '未知错误';
        const statusLine = `HTTP ${classification.status}`;
        const detail = classification.text
            ? (classification.text.length > 400
                ? classification.text.slice(0, 400) + '…'
                : classification.text)
            : '';
        const labels = classification.labels?.length
            ? `\n识别：${classification.labels.join(' / ')}`
            : '';
        return detail ? `${statusLine}\n${detail}${labels}` : `${statusLine}${labels}`;
    }

    async function patchedFetch(input, init) {
        const settings = getSettings();
        const url = getUrlString(input);

        if (!settings.enabled || !isGenerationRequest(url)) {
            return originalFetch(input, init);
        }

        const maxRetries = Math.max(0, Number(settings.maxRetries) || 0);
        const signal = init?.signal || (input instanceof Request ? input.signal : undefined);

        let reusable;
        try {
            reusable = await prepareReusableRequest(input, init);
        } catch (e) {
            console.warn(`${LOG_PREFIX} prepareReusableRequest failed, falling back`, e);
            reusable = { url, init: init || {} };
        }

        let attempt = 0; // 0 = first try; retries are 1..maxRetries
        let lastClassification = null;
        let lastResponse = null;
        let lastError = null;
        let cancelled = false;

        aar_inflight = true;
        try {
            while (true) {
                try {
                    const response = await originalFetch(reusable.url, makeAttemptInit(reusable.init));
                    const classification = await classifyResponse(response, settings);
                    lastClassification = classification;
                    lastResponse = response;
                    lastError = null;
                    lastRecognizedLabels = classification.labels || [];

                    if (!classification.retriable) {
                        return response;
                    }

                    // Retriable failure
                    if (attempt >= maxRetries) {
                        const suffix = formatStatusSuffix({
                            attemptsDone: attempt,
                            maxRetries,
                            cancelled: false,
                            labels: classification.labels,
                        });
                        toast('error', `已达最大重试次数（${attempt}/${maxRetries}）`,
                            classification.labels?.join(' / ') || `HTTP ${response.status}`);
                        const annotated = buildAnnotatedErrorResponse(
                            response,
                            classification.fullText || classification.text,
                            suffix,
                            classification,
                        );
                        // Also try to patch chat message shortly after ST writes it
                        setTimeout(() => appendStatusToLastChatMessage(suffix), 300);
                        setTimeout(() => appendStatusToLastChatMessage(suffix), 1200);
                        return annotated;
                    }

                    const nextAttempt = attempt + 1;
                    const summary = await summarizeForConfirm(classification, null);
                    const delay = computeDelay(nextAttempt, settings);
                    const labelHint = classification.labels?.join(' / ') || `HTTP ${response.status}`;

                    if (settings.confirmBeforeRetry) {
                        toast('warning', 'API 失败，等待确认重试…', labelHint);
                        const ok = await askUserConfirm(
                            `${summary}\n\n将进行第 ${nextAttempt}/${maxRetries} 次重试` +
                            (delay > 0 ? `（延迟 ${delay} ms）` : '') +
                            `\n\nURL: ${url.length > 120 ? url.slice(0, 120) + '…' : url}`
                        );
                        if (!ok) {
                            cancelled = true;
                            const suffix = formatStatusSuffix({
                                attemptsDone: Math.max(1, attempt + 1),
                                maxRetries,
                                cancelled: true,
                                labels: classification.labels,
                            });
                            toast('info', '已取消重试');
                            const annotated = buildAnnotatedErrorResponse(
                                response,
                                classification.fullText || classification.text,
                                suffix,
                                classification,
                            );
                            setTimeout(() => appendStatusToLastChatMessage(suffix), 300);
                            setTimeout(() => appendStatusToLastChatMessage(suffix), 1200);
                            return annotated;
                        }
                    }

                    toast('info', `正在重试 ${nextAttempt}/${maxRetries}`, labelHint);
                    if (delay > 0) {
                        await sleep(delay, signal);
                    }

                    attempt = nextAttempt;
                    continue;
                } catch (err) {
                    if (isAbortError(err)) {
                        throw err;
                    }

                    const netClass = classifyNetworkError(err);
                    lastError = err;
                    lastResponse = null;
                    lastClassification = {
                        retriable: netClass.retriable,
                        text: netClass.text,
                        fullText: netClass.text,
                        labels: netClass.labels,
                        status: 0,
                    };
                    lastRecognizedLabels = netClass.labels;

                    if (!netClass.retriable) {
                        throw err;
                    }

                    if (attempt >= maxRetries) {
                        const suffix = formatStatusSuffix({
                            attemptsDone: attempt,
                            maxRetries,
                            cancelled: false,
                            labels: netClass.labels,
                        });
                        toast('error', `已达最大重试次数（${attempt}/${maxRetries}）`,
                            err.message || '网络错误');
                        // Annotate chat; rethrow so ST still sees failure
                        setTimeout(() => appendStatusToLastChatMessage(suffix), 300);
                        setTimeout(() => appendStatusToLastChatMessage(suffix), 1200);
                        // Attach suffix onto error message for any catcher that reads it
                        try {
                            err.message = (err.message || String(err)) + suffix;
                        } catch (_) { /* ignore */ }
                        throw err;
                    }

                    const nextAttempt = attempt + 1;
                    const summary = await summarizeForConfirm(lastClassification, err);
                    const delay = computeDelay(nextAttempt, settings);

                    if (settings.confirmBeforeRetry) {
                        toast('warning', 'API 失败，等待确认重试…', err.name || '网络错误');
                        const ok = await askUserConfirm(
                            `${summary}\n\n将进行第 ${nextAttempt}/${maxRetries} 次重试` +
                            (delay > 0 ? `（延迟 ${delay} ms）` : '') +
                            `\n\nURL: ${url.length > 120 ? url.slice(0, 120) + '…' : url}`
                        );
                        if (!ok) {
                            cancelled = true;
                            const suffix = formatStatusSuffix({
                                attemptsDone: Math.max(1, attempt + 1),
                                maxRetries,
                                cancelled: true,
                                labels: netClass.labels,
                            });
                            toast('info', '已取消重试');
                            setTimeout(() => appendStatusToLastChatMessage(suffix), 300);
                            setTimeout(() => appendStatusToLastChatMessage(suffix), 1200);
                            try {
                                err.message = (err.message || String(err)) + suffix;
                            } catch (_) { /* ignore */ }
                            throw err;
                        }
                    }

                    toast('info', `正在重试 ${nextAttempt}/${maxRetries}`, err.message || '网络错误');
                    if (delay > 0) {
                        await sleep(delay, signal);
                    }

                    attempt = nextAttempt;
                }
            }
        } finally {
            aar_inflight = false;
            // silence unused warnings in some linters
            void cancelled;
            void lastError;
            void lastResponse;
        }
    }

    // ---------- EventSource backup path ----------

    function textLooksLikeRetriableFailure(text) {
        return bodyLooksRetriable(text);
    }

    async function backupConfirmAndRegenerate(errorText) {
        if (aar_inflight) return;
        const settings = getSettings();
        if (!settings.enabled) return;

        const labels = extractRecognizedLabels(errorText);
        if (!textLooksLikeRetriableFailure(errorText)) return;

        aar_inflight = true;
        try {
            const maxRetries = Math.max(0, Number(settings.maxRetries) || 0);
            toast('warning', '检测到生成失败（事件备份路径）', labels.join(' / ') || '可重试错误');

            let shouldRetry = true;
            if (settings.confirmBeforeRetry) {
                shouldRetry = await askUserConfirm(
                    `检测到可重试错误（fetch 路径可能未拦截）：\n${String(errorText).slice(0, 400)}\n\n` +
                    `识别：${labels.join(' / ') || '未知'}\n\n是否触发重新生成？`
                );
            }
            if (!shouldRetry) {
                const suffix = formatStatusSuffix({
                    attemptsDone: 1,
                    maxRetries,
                    cancelled: true,
                    labels,
                });
                toast('info', '已取消重试');
                appendStatusToLastChatMessage(suffix);
                return;
            }

            toast('info', '正在通过重新生成重试…', labels.join(' / ') || '');
            const delay = computeDelay(1, settings);
            if (delay > 0) await sleep(delay);

            const ctx = getContextSafe();
            // Prefer Generate / regenerate APIs without infinite loops (aar_inflight guards)
            if (typeof window.Generate === 'function') {
                await window.Generate('normal');
            } else if (typeof ctx?.generate === 'function') {
                await ctx.generate();
            } else if (typeof window.regenerateLastMessage === 'function') {
                await window.regenerateLastMessage();
            } else {
                // Fallback: click swipe regenerate if present
                const $ = window.jQuery || window.$;
                const $btn = $?.('#option_regenerate, .mes_edit_regenerate, #regenerate').first();
                if ($btn?.length) $btn.trigger('click');
                else toast('warning', '无法触发重新生成：未找到 Generate API');
            }
        } catch (e) {
            console.warn(`${LOG_PREFIX} backup regenerate failed`, e);
            toast('error', '备份重试失败', e.message || String(e));
        } finally {
            // Small delay before clearing so nested fetch path can set its own flag
            setTimeout(() => { aar_inflight = false; }, 500);
        }
    }

    function installEventSourceBackup() {
        const tryBind = () => {
            try {
                const ctx = getContextSafe();
                const es = ctx?.eventSource;
                const types = ctx?.event_types || window.event_types;
                if (!es || !types) return false;

                if (window.__stApiAutoRetryEventBound) return true;
                window.__stApiAutoRetryEventBound = true;

                const onFail = (data) => {
                    if (aar_inflight) return;
                    const settings = getSettings();
                    if (!settings.enabled) return;

                    let text = '';
                    if (typeof data === 'string') text = data;
                    else if (data && typeof data === 'object') {
                        text = data.error || data.message || data.reason
                            || data.err?.message || JSON.stringify(data);
                    }
                    // Also peek last chat message
                    try {
                        const chat = ctx.chat;
                        if (Array.isArray(chat) && chat.length) {
                            const last = chat[chat.length - 1];
                            if (last?.mes) text = `${text}\n${last.mes}`;
                        }
                    } catch (_) { /* ignore */ }

                    if (textLooksLikeRetriableFailure(text)) {
                        console.log(`${LOG_PREFIX} eventSource 备份路径命中`, text.slice(0, 200));
                        // Defer so ST can finish writing [API 错误] into chat
                        setTimeout(() => backupConfirmAndRegenerate(text), 400);
                    }
                };

                const failEvents = [
                    types.GENERATION_ENDED,
                    types.GENERATION_STOPPED,
                    types.CHAT_COMPLETION_SETTINGS_READY, // unlikely fail
                ].filter(Boolean);

                // Common ST failure event names (vary by version)
                const extraNames = [
                    'generation_error',
                    'GENERATION_ERROR',
                    'generation_ended',
                    'js_error',
                ];

                for (const ev of failEvents) {
                    try { es.on(ev, onFail); } catch (_) { /* ignore */ }
                }
                for (const name of extraNames) {
                    try { es.on(name, onFail); } catch (_) { /* ignore */ }
                }

                // Also watch toastr/error path via MutationObserver on toasts — light touch
                try {
                    const observer = new MutationObserver((mutations) => {
                        if (aar_inflight) return;
                        for (const m of mutations) {
                            for (const node of m.addedNodes || []) {
                                if (!(node instanceof HTMLElement)) continue;
                                const t = node.textContent || '';
                                if (/后端错误|Failed to generate chat completion|status 524|openai_error/i.test(t)) {
                                    console.log(`${LOG_PREFIX} toast 观察命中`);
                                    setTimeout(() => backupConfirmAndRegenerate(t), 400);
                                    return;
                                }
                            }
                        }
                    });
                    const toastRoot = document.getElementById('toast-container')
                        || document.querySelector('.toast-top-center, #toasts, .toastr');
                    if (toastRoot) {
                        observer.observe(toastRoot, { childList: true, subtree: true });
                    } else {
                        // Observe body for late toast container
                        observer.observe(document.body, { childList: true, subtree: false });
                    }
                    window.__stApiAutoRetryToastObserver = observer;
                } catch (e) {
                    console.warn(`${LOG_PREFIX} toast observer failed`, e);
                }

                console.log(`${LOG_PREFIX} eventSource 备份路径已绑定`);
                return true;
            } catch (e) {
                console.warn(`${LOG_PREFIX} installEventSourceBackup failed`, e);
                return false;
            }
        };

        if (tryBind()) return;
        let tries = 0;
        const timer = setInterval(() => {
            tries += 1;
            if (tryBind() || tries > 40) clearInterval(timer);
        }, 500);
    }

    // ---------- Settings UI ----------

    function buildSettingsHtml() {
        return `
<div id="st_api_auto_retry_settings" class="st-api-auto-retry-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>API 自动重试</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <p class="st-api-auto-retry-desc">
        在上游 API 返回可重试错误（如 524 / 502 / 503 / 429 / 超时）时自动或确认后重试。
        <b>v1.1.0</b> 会从响应正文识别被 ST 包装的 524 / openai_error（不仅看 HTTP 状态码），
        并在最终失败时把重试状态写入返回文本 / 聊天消息。
        调试完成后可将「重试前手动确认」关闭。
      </p>

      <label class="checkbox_label" for="st_aar_enabled">
        <input id="st_aar_enabled" type="checkbox" />
        <span>启用扩展</span>
      </label>

      <label class="checkbox_label" for="st_aar_confirm">
        <input id="st_aar_confirm" type="checkbox" />
        <span>重试前手动确认</span>
      </label>
      <small class="st-api-auto-retry-hint">默认开启：每次重试前弹出确认框，便于调试；关闭后自动重试。</small>

      <label for="st_aar_max_retries">
        <span>最大重试次数</span>
      </label>
      <input id="st_aar_max_retries" class="text_pole" type="number" min="0" max="20" step="1" />

      <label for="st_aar_base_delay">
        <span>基础延迟毫秒</span>
      </label>
      <input id="st_aar_base_delay" class="text_pole" type="number" min="0" max="120000" step="100" />

      <label class="checkbox_label" for="st_aar_backoff">
        <input id="st_aar_backoff" type="checkbox" />
        <span>指数退避</span>
      </label>
      <small class="st-api-auto-retry-hint">开启后延迟 = 基础延迟 × 2^(次数-1)</small>

      <label for="st_aar_status_codes">
        <span>可重试 HTTP 状态码</span>
      </label>
      <input id="st_aar_status_codes" class="text_pole wide100p" type="text" placeholder="408,429,500,502,503,504,524" />

      <label class="checkbox_label" for="st_aar_gen_only">
        <input id="st_aar_gen_only" type="checkbox" />
        <span>仅拦截生成相关请求</span>
      </label>
      <small class="st-api-auto-retry-hint">尽量只对 chat/completions、openai、generate 等路径重试，避免误伤扩展更新/翻译等。正文匹配 524/openai_error 时即使状态码不在列表也会重试。</small>

      <div class="st-api-auto-retry-footer">
        <small>版本 ${VERSION} · molot23</small>
      </div>
    </div>
  </div>
</div>`;
    }

    function syncUiFromSettings() {
        const s = getSettings();
        const $ = window.jQuery || window.$;
        if (!$) return;

        $('#st_aar_enabled').prop('checked', !!s.enabled);
        $('#st_aar_confirm').prop('checked', !!s.confirmBeforeRetry);
        $('#st_aar_max_retries').val(Number(s.maxRetries));
        $('#st_aar_base_delay').val(Number(s.baseDelayMs));
        $('#st_aar_backoff').prop('checked', !!s.exponentialBackoff);
        const codes = Array.isArray(s.retryStatusCodes)
            ? s.retryStatusCodes.join(',')
            : String(s.retryStatusCodes || '');
        $('#st_aar_status_codes').val(codes);
        $('#st_aar_gen_only').prop('checked', !!s.generationOnly);
    }

    function bindSettingsEvents() {
        const $ = window.jQuery || window.$;
        if (!$) return;

        $('#st_aar_enabled').off('input.stAar change.stAar').on('input.stAar change.stAar', function () {
            getSettings().enabled = Boolean($(this).prop('checked'));
            saveSettings();
        });

        $('#st_aar_confirm').off('input.stAar change.stAar').on('input.stAar change.stAar', function () {
            getSettings().confirmBeforeRetry = Boolean($(this).prop('checked'));
            saveSettings();
        });

        $('#st_aar_max_retries').off('input.stAar change.stAar').on('input.stAar change.stAar', function () {
            const n = parseInt($(this).val(), 10);
            getSettings().maxRetries = Number.isNaN(n) ? defaultSettings.maxRetries : Math.max(0, n);
            saveSettings();
        });

        $('#st_aar_base_delay').off('input.stAar change.stAar').on('input.stAar change.stAar', function () {
            const n = parseInt($(this).val(), 10);
            getSettings().baseDelayMs = Number.isNaN(n) ? defaultSettings.baseDelayMs : Math.max(0, n);
            saveSettings();
        });

        $('#st_aar_backoff').off('input.stAar change.stAar').on('input.stAar change.stAar', function () {
            getSettings().exponentialBackoff = Boolean($(this).prop('checked'));
            saveSettings();
        });

        $('#st_aar_status_codes').off('input.stAar change.stAar').on('input.stAar change.stAar', function () {
            getSettings().retryStatusCodes = parseStatusCodes($(this).val());
            saveSettings();
        });

        $('#st_aar_gen_only').off('input.stAar change.stAar').on('input.stAar change.stAar', function () {
            getSettings().generationOnly = Boolean($(this).prop('checked'));
            saveSettings();
        });
    }

    function injectSettingsPanel() {
        const $ = window.jQuery || window.$;
        if (!$) return false;

        if ($('#st_api_auto_retry_settings').length) {
            syncUiFromSettings();
            bindSettingsEvents();
            return true;
        }

        const $target = $('#extensions_settings2').length
            ? $('#extensions_settings2')
            : ($('#extensions_settings').length ? $('#extensions_settings') : null);

        if (!$target) return false;

        $target.append(buildSettingsHtml());
        syncUiFromSettings();
        bindSettingsEvents();
        console.log(`${LOG_PREFIX} 设置面板已注入`);
        return true;
    }

    function waitAndInjectSettings() {
        if (injectSettingsPanel()) return;

        let tries = 0;
        const timer = setInterval(() => {
            tries += 1;
            if (injectSettingsPanel() || tries > 60) {
                clearInterval(timer);
            }
        }, 500);

        try {
            const ctx = getContextSafe();
            if (ctx?.eventSource && ctx?.event_types) {
                const types = ctx.event_types;
                const handler = () => injectSettingsPanel();
                if (types.APP_READY) ctx.eventSource.on(types.APP_READY, handler);
                if (types.APP_INITIALIZED) ctx.eventSource.on(types.APP_INITIALIZED, handler);
            }
        } catch (e) {
            /* ignore */
        }
    }

    // ---------- Install patch ----------

    function installFetchPatch() {
        if (window.__stApiAutoRetryPatched) {
            console.log(`${LOG_PREFIX} fetch 已打补丁，跳过`);
            return;
        }
        window.fetch = patchedFetch;
        window.__stApiAutoRetryPatched = true;
        window.__stApiAutoRetryOriginalFetch = originalFetch;
        console.log(`${LOG_PREFIX} 已劫持 window.fetch (v${VERSION})`);
    }

    function init() {
        getSettings();
        installFetchPatch();
        waitAndInjectSettings();
        installEventSourceBackup();
        toast('info', `扩展已加载 v${VERSION}`, 'API 自动重试');
        console.log(`${LOG_PREFIX} v${VERSION} 初始化完成`);
    }

    if (typeof jQuery !== 'undefined') {
        jQuery(init);
    } else if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
