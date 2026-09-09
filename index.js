/**
 * st-api-auto-retry — SillyTavern 扩展：仅对话生成失败时自动重试（可确认）
 * Author: molot23
 * Version: 1.3.0
 */
(function () {
    'use strict';

    const MODULE_NAME = 'st-api-auto-retry';
    const LOG_PREFIX = '[API自动重试]';
    const VERSION = '1.3.0';
    const STATUS_MARKER = '[API自动重试]';
    const PLACEHOLDER_EXTRA_TYPE = 'st_api_auto_retry_placeholder';
    const PLACEHOLDER_DOM_CLASS = 'st-aar-placeholder';
    const HANDLED_ABORT_FLAG = '__stAarHandledAbort';

    const defaultSettings = Object.freeze({
        enabled: true,
        confirmBeforeRetry: true,
        maxRetries: 3,
        baseDelayMs: 2000,
        exponentialBackoff: true,
        retryStatusCodes: [408, 429, 500, 502, 503, 504, 524],
    });

    /**
     * Exact SillyTavern server paths used for **main chat reply** generation.
     * Hard-deny everything else (extensions update, translate, assets, settings,
     * characters, chats save, files, version, csrf, themes, worldinfo, status, …).
     * Quiet / secondary prompts hit the same URL but carry body.type === "quiet"
     * and are skipped separately.
     */
    const CHAT_GENERATE_ALLOWLIST = Object.freeze([
        '/api/backends/chat-completions/generate',
        '/api/backends/text-completions/generate',
        '/api/backends/kobold/generate',
        '/api/backends/koboldhorde/generate',
        '/api/novelai/generate',
    ]);

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
        // generation-only is always on; drop legacy toggle if present
        if (Object.hasOwn(store[MODULE_NAME], 'generationOnly')) {
            delete store[MODULE_NAME].generationOnly;
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

    /**
     * True only for allowlisted ST chat-generation endpoints (pathname match).
     * Query strings are ignored; no fuzzy vendor / openai / custom substring matching.
     */
    function isChatGenerateUrl(url) {
        let pathname = '';
        try {
            const u = new URL(url, window.location.origin);
            pathname = u.pathname;
        } catch (e) {
            pathname = String(url || '').split('?')[0].split('#')[0];
        }
        // Normalize trailing slash
        pathname = pathname.replace(/\/+$/, '') || '/';
        const lower = pathname.toLowerCase();
        return CHAT_GENERATE_ALLOWLIST.some((p) => lower === p || lower.endsWith(p));
    }

    /**
     * Quiet / secondary generate calls share the same ST generate URL.
     * ST puts type: "quiet" (also impersonate etc. for non-main) in the JSON body.
     * We only skip quiet — main chat reply types: normal, continue, regenerate, swipe, …
     */
    function isQuietGenerateBody(body) {
        if (body == null) return false;
        let text = null;
        if (typeof body === 'string') {
            text = body;
        } else if (body instanceof ArrayBuffer) {
            try { text = new TextDecoder().decode(body); } catch (_) { return false; }
        } else if (ArrayBuffer.isView && ArrayBuffer.isView(body)) {
            try { text = new TextDecoder().decode(body); } catch (_) { return false; }
        } else {
            // ReadableStream / FormData / Blob — cannot inspect cheaply; allow (URL already gated)
            return false;
        }
        const trimmed = text.trim();
        if (!trimmed || trimmed[0] !== '{') return false;
        try {
            const obj = JSON.parse(trimmed);
            const t = obj && obj.type;
            if (typeof t === 'string' && t.toLowerCase() === 'quiet') return true;
        } catch (_) {
            // Fallback regex if JSON parse fails on partial/custom body
            if (/["']type["']\s*:\s*["']quiet["']/i.test(trimmed)) return true;
        }
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

    function formatDelayHint(delayMs) {
        const ms = Math.max(0, Number(delayMs) || 0);
        if (ms <= 0) return '立即';
        if (ms < 1000) return `约 ${ms} 毫秒后`;
        const sec = Math.round(ms / 1000);
        try {
            const when = new Date(Date.now() + ms);
            const hh = String(when.getHours()).padStart(2, '0');
            const mm = String(when.getMinutes()).padStart(2, '0');
            const ss = String(when.getSeconds()).padStart(2, '0');
            return `约 ${sec} 秒后（${hh}:${mm}:${ss}）`;
        } catch (_) {
            return `约 ${sec} 秒后`;
        }
    }

    function formatReasonLabel(labels, status) {
        if (labels && labels.length) return labels.join(' / ');
        if (status) return `HTTP ${status}`;
        return '可重试错误';
    }

    /**
     * Build Chinese placeholder bubble text.
     * @param {'pending'|'confirm'|'retrying'|'cancelled'|'exhausted'} phase
     */
    function formatPlaceholderMes({ phase, labels, status, nextAttempt, maxRetries, delayMs, attemptsDone }) {
        const reason = formatReasonLabel(labels, status);
        const lines = [STATUS_MARKER, `原因：${reason}`];

        if (phase === 'confirm') {
            lines.push(`进度：等待确认是否重试 ${nextAttempt}/${maxRetries}`);
            if (delayMs > 0) lines.push(`确认后延迟：${formatDelayHint(delayMs)}`);
            else lines.push('确认后将立即重试');
        } else if (phase === 'retrying' || phase === 'pending') {
            lines.push(`进度：将重试 ${nextAttempt}/${maxRetries}`);
            lines.push(`下次重试：${formatDelayHint(delayMs)}`);
        } else if (phase === 'cancelled') {
            lines.push('状态：已取消重试');
            if (attemptsDone != null) lines.push(`已失败：${attemptsDone} 次`);
        } else if (phase === 'exhausted') {
            const done = attemptsDone != null ? attemptsDone : maxRetries;
            lines.push(`状态：已重试 ${done}/${maxRetries} 次后仍失败`);
            lines.push('已保留此错误气泡（不再自动重试）');
        }
        return lines.join('\n');
    }

    function saveChatOptional() {
        try {
            const ctx = getContextSafe();
            if (!ctx) return;
            if (typeof ctx.saveChat === 'function') {
                // getContext exposes saveChatConditional as saveChat
                const ret = ctx.saveChat();
                if (ret && typeof ret.then === 'function') {
                    ret.catch(() => { /* ignore */ });
                }
                return;
            }
        } catch (_) { /* ignore */ }
        try {
            if (typeof saveChatDebounced === 'function') saveChatDebounced();
            else if (typeof saveChatConditional === 'function') saveChatConditional();
        } catch (_) { /* ignore */ }
    }

    function findPlaceholderIndex(chat) {
        if (!Array.isArray(chat)) return -1;
        for (let i = chat.length - 1; i >= 0; i--) {
            const msg = chat[i];
            if (!msg) continue;
            if (msg.extra && msg.extra.type === PLACEHOLDER_EXTRA_TYPE) return i;
            if (typeof msg.mes === 'string'
                && msg.mes.startsWith(STATUS_MARKER)
                && msg.extra && msg.extra.stAarPlaceholder) {
                return i;
            }
        }
        return -1;
    }

    function markPlaceholderDom(mesId) {
        try {
            const $ = window.jQuery || window.$;
            if ($) {
                const $el = $(`#chat .mes[mesid="${mesId}"]`);
                if ($el.length) {
                    $el.addClass(PLACEHOLDER_DOM_CLASS);
                    $el.attr('data-st-aar', '1');
                }
                return;
            }
            const el = document.querySelector(`#chat .mes[mesid="${mesId}"]`);
            if (el) {
                el.classList.add(PLACEHOLDER_DOM_CLASS);
                el.setAttribute('data-st-aar', '1');
            }
        } catch (_) { /* ignore */ }
    }

    function buildPlaceholderMessage(mesText) {
        const ctx = getContextSafe();
        const extra = {
            type: PLACEHOLDER_EXTRA_TYPE,
            stAarPlaceholder: true,
            swipeable: false,
            isSmallSys: true,
        };
        // Exclude from prompt assembly when ST supports IGNORE_SYMBOL
        try {
            const ignoreSym = ctx?.symbols?.ignore;
            if (ignoreSym) extra[ignoreSym] = true;
        } catch (_) { /* ignore */ }

        const name = (ctx && ctx.name2) ? ctx.name2 : 'API自动重试';
        return {
            name,
            is_user: false,
            is_system: true,
            send_date: Date.now(),
            mes: mesText,
            extra,
        };
    }

    /**
     * Insert or update the single retry status bubble in the current chat.
     * Returns mes index or -1.
     */
    function upsertPlaceholderBubble(mesText) {
        try {
            const ctx = getContextSafe();
            if (!ctx || !Array.isArray(ctx.chat)) {
                console.warn(`${LOG_PREFIX} 无法插入状态气泡：getContext().chat 不可用`);
                return -1;
            }
            const chat = ctx.chat;
            let idx = findPlaceholderIndex(chat);

            if (idx >= 0) {
                const msg = chat[idx];
                msg.mes = mesText;
                if (!msg.extra || typeof msg.extra !== 'object') msg.extra = {};
                msg.extra.type = PLACEHOLDER_EXTRA_TYPE;
                msg.extra.stAarPlaceholder = true;
                msg.extra.swipeable = false;
                msg.is_system = true;

                try {
                    if (typeof ctx.updateMessageBlock === 'function') {
                        ctx.updateMessageBlock(idx, msg, { rerenderMessage: true });
                    } else {
                        const $ = window.jQuery || window.$;
                        if ($) {
                            const $text = $(`#chat .mes[mesid="${idx}"] .mes_text`);
                            if ($text.length) {
                                const formatted = typeof ctx.messageFormatting === 'function'
                                    ? ctx.messageFormatting(mesText, msg.name, true, false, idx)
                                    : mesText.replace(/\n/g, '<br>');
                                $text.html(formatted);
                            }
                        }
                    }
                } catch (e) {
                    console.warn(`${LOG_PREFIX} 更新状态气泡失败`, e);
                }
                markPlaceholderDom(idx);
                saveChatOptional();
                return idx;
            }

            const message = buildPlaceholderMessage(mesText);
            chat.push(message);
            idx = chat.length - 1;

            try {
                if (typeof ctx.addOneMessage === 'function') {
                    ctx.addOneMessage(message);
                } else {
                    // Minimal DOM fallback
                    const $ = window.jQuery || window.$;
                    if ($ && $('#chat').length) {
                        const html = `<div class="mes ${PLACEHOLDER_DOM_CLASS}" mesid="${idx}" data-st-aar="1"><div class="mes_text">${mesText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</div></div>`;
                        $('#chat').append(html);
                    }
                }
            } catch (e) {
                console.warn(`${LOG_PREFIX} 渲染状态气泡失败`, e);
            }
            markPlaceholderDom(idx);
            saveChatOptional();
            return idx;
        } catch (e) {
            console.warn(`${LOG_PREFIX} upsertPlaceholderBubble failed`, e);
            return -1;
        }
    }

    /**
     * Remove the placeholder bubble from chat array + DOM so ST can render the real reply.
     * Must be awaited on the success path before returning Response (swipe/saveReply last-message safety).
     */
    async function removePlaceholderBubble() {
        try {
            const ctx = getContextSafe();
            if (!ctx || !Array.isArray(ctx.chat)) return false;
            const chat = ctx.chat;
            const idx = findPlaceholderIndex(chat);
            if (idx < 0) return false;

            // Prefer deleteLastMessage when we are still the tail (common case; safest for swipe)
            if (idx === chat.length - 1 && typeof ctx.deleteLastMessage === 'function') {
                try {
                    const ret = ctx.deleteLastMessage();
                    if (ret && typeof ret.then === 'function') await ret;
                    cleanupPlaceholderDom();
                    saveChatOptional();
                    return true;
                } catch (e) {
                    console.warn(`${LOG_PREFIX} deleteLastMessage failed, trying deleteMessage`, e);
                }
            }

            // Prefer official deleteMessage (rewrites mesids)
            if (typeof ctx.deleteMessage === 'function') {
                try {
                    const ret = ctx.deleteMessage(idx, undefined, false);
                    if (ret && typeof ret.then === 'function') {
                        await ret;
                    }
                    // deleteMessage already saves; also strip any leftover DOM class nodes
                    cleanupPlaceholderDom();
                    return true;
                } catch (e) {
                    console.warn(`${LOG_PREFIX} deleteMessage failed, falling back`, e);
                }
            }

            // Fallback: splice + DOM remove + reindex
            chat.splice(idx, 1);
            try {
                const $ = window.jQuery || window.$;
                if ($) {
                    $(`#chat .mes[mesid="${idx}"]`).remove();
                    $('#chat .mes').each(function (i) {
                        $(this).attr('mesid', i);
                    });
                    $('#chat .mes').removeClass('last_mes').last().addClass('last_mes');
                } else {
                    const el = document.querySelector(`#chat .mes[mesid="${idx}"]`);
                    if (el) el.remove();
                }
            } catch (_) { /* ignore */ }
            cleanupPlaceholderDom();
            saveChatOptional();
            return true;
        } catch (e) {
            console.warn(`${LOG_PREFIX} removePlaceholderBubble failed`, e);
            return false;
        }
    }

    function cleanupPlaceholderDom() {
        try {
            const $ = window.jQuery || window.$;
            if ($) {
                $(`#chat .mes.${PLACEHOLDER_DOM_CLASS}, #chat .mes[data-st-aar="1"]`).each(function () {
                    const mesid = $(this).attr('mesid');
                    // Only remove if chat entry is gone / still marked
                    const ctx = getContextSafe();
                    const id = Number(mesid);
                    const still = ctx?.chat?.[id]?.extra?.type === PLACEHOLDER_EXTRA_TYPE;
                    if (!still) {
                        // class cleanup only when message reused; if orphaned node, remove
                        if (!ctx?.chat?.[id]) $(this).remove();
                        else $(this).removeClass(PLACEHOLDER_DOM_CLASS).removeAttr('data-st-aar');
                    }
                });
            }
        } catch (_) { /* ignore */ }
    }

    /**
     * After ST may have stacked a second [API 错误] bubble, remove/merge duplicates
     * near the end of chat, keeping our placeholder if present.
     */
    function dedupeTrailingApiErrors() {
        try {
            const ctx = getContextSafe();
            if (!ctx || !Array.isArray(ctx.chat) || ctx.chat.length === 0) return;
            const chat = ctx.chat;
            const phIdx = findPlaceholderIndex(chat);

            const isStApiError = (msg) => {
                if (!msg || typeof msg.mes !== 'string') return false;
                if (msg.extra?.type === PLACEHOLDER_EXTRA_TYPE) return false;
                return /\[API\s*错误\]/i.test(msg.mes)
                    || /Custom OpenAI endpoint failed/i.test(msg.mes)
                    || /Failed to generate chat completion/i.test(msg.mes)
                    || (/openai_error/i.test(msg.mes) && /status\s*524|\b524\b/i.test(msg.mes));
            };

            // Scan last few messages; delete ST error bubbles that appeared after our placeholder
            const start = Math.max(0, chat.length - 6);
            const toDelete = [];
            for (let i = chat.length - 1; i >= start; i--) {
                if (i === phIdx) continue;
                if (isStApiError(chat[i])) toDelete.push(i);
            }
            // Delete high indices first
            for (const i of toDelete) {
                if (typeof ctx.deleteMessage === 'function') {
                    try {
                        const ret = ctx.deleteMessage(i, undefined, false);
                        if (ret && typeof ret.then === 'function') ret.catch(() => {});
                        continue;
                    } catch (_) { /* fall through */ }
                }
                chat.splice(i, 1);
                try {
                    const $ = window.jQuery || window.$;
                    if ($) {
                        $(`#chat .mes[mesid="${i}"]`).remove();
                        $('#chat .mes').each(function (j) { $(this).attr('mesid', j); });
                    }
                } catch (_) { /* ignore */ }
            }
            if (toDelete.length) saveChatOptional();
        } catch (e) {
            console.warn(`${LOG_PREFIX} dedupeTrailingApiErrors failed`, e);
        }
    }

    function scheduleDedupeApiErrors() {
        setTimeout(() => dedupeTrailingApiErrors(), 200);
        setTimeout(() => dedupeTrailingApiErrors(), 800);
        setTimeout(() => dedupeTrailingApiErrors(), 1800);
    }

    function makeHandledAbort(reason) {
        const err = new DOMException(String(reason || 'st-api-auto-retry abort'), 'AbortError');
        try { err[HANDLED_ABORT_FLAG] = true; } catch (_) { /* ignore */ }
        try { err.message = String(reason || err.message); } catch (_) { /* ignore */ }
        return err;
    }

    function isHandledAbort(err) {
        return !!(err && (err[HANDLED_ABORT_FLAG] || (isAbortError(err) && /st-api-auto-retry/i.test(String(err.message || '')))));
    }

    /**
     * Build a new Response so ST surfaces our status line in chat / toast.
     * Kept as fallback when abort is unavailable.
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
     * Legacy fallback; preferred path is placeholder bubble + abort/dedupe.
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
                if (msg.extra?.type === PLACEHOLDER_EXTRA_TYPE) continue;
                if (mes.includes(STATUS_MARKER) && mes.startsWith(STATUS_MARKER)) return true;
                if (
                    /\[API\s*错误\]/i.test(mes)
                    || /Custom OpenAI endpoint failed/i.test(mes)
                    || /Failed to generate chat completion/i.test(mes)
                    || /openai_error/i.test(mes)
                    || /status\s*524/i.test(mes)
                ) {
                    msg.mes = mes + statusSuffix;
                    try {
                        if (typeof ctx.updateMessageBlock === 'function') {
                            ctx.updateMessageBlock(i, msg);
                        } else {
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
                        }
                    } catch (e) {
                        console.warn(`${LOG_PREFIX} chat re-render failed`, e);
                    }
                    saveChatOptional();
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

        // Always generation-only: exact ST chat generate endpoints
        if (!settings.enabled || !isChatGenerateUrl(url)) {
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

        // Do not retry quiet prompts / secondary generateQuietPrompt traffic
        if (isQuietGenerateBody(reusable.init?.body)) {
            console.log(`${LOG_PREFIX} 跳过 quiet 生成请求（非主对话回复）`);
            return originalFetch(reusable.url, makeAttemptInit(reusable.init));
        }

        let attempt = 0; // 0 = first try; retries are 1..maxRetries
        let lastClassification = null;
        let lastResponse = null;
        let lastError = null;
        let cancelled = false;
        let placeholderActive = false;

        const showRetryBubble = ({ phase, classification, nextAttempt, delayMs, attemptsDone }) => {
            const mes = formatPlaceholderMes({
                phase,
                labels: classification?.labels,
                status: classification?.status,
                nextAttempt,
                maxRetries,
                delayMs: delayMs || 0,
                attemptsDone,
            });
            const idx = upsertPlaceholderBubble(mes);
            placeholderActive = idx >= 0 || placeholderActive;
            return idx;
        };

        const finishSuccess = async (response) => {
            // Remove placeholder BEFORE returning so ST saveReply/swipe sees correct last message
            if (placeholderActive) {
                await removePlaceholderBubble();
                placeholderActive = false;
            }
            return response;
        };

        const finishCancelled = (classification) => {
            cancelled = true;
            showRetryBubble({
                phase: 'cancelled',
                classification,
                nextAttempt: Math.min(attempt + 1, maxRetries),
                delayMs: 0,
                attemptsDone: Math.max(1, attempt + 1),
            });
            toast('info', '已取消重试');
            scheduleDedupeApiErrors();
            throw makeHandledAbort('st-api-auto-retry: cancelled');
        };

        const finishExhausted = (classification, response, networkErr) => {
            showRetryBubble({
                phase: 'exhausted',
                classification,
                nextAttempt: maxRetries,
                delayMs: 0,
                // At least one failure occurred even when maxRetries === 0
                attemptsDone: Math.max(attempt, 1),
            });
            const labelHint = classification?.labels?.join(' / ')
                || (networkErr ? (networkErr.message || '网络错误') : `HTTP ${classification?.status || '?'}`);
            toast('error', `已达最大重试次数（${attempt}/${maxRetries}）`, labelHint);
            scheduleDedupeApiErrors();
            // Prefer abort so ST does not stack a second [API 错误] bubble
            throw makeHandledAbort('st-api-auto-retry: exhausted');
        };

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
                        // Non-retriable: if we never entered retry UX, pass through;
                        // if we somehow had a bubble, remove on true success only.
                        if (response.ok) {
                            return await finishSuccess(response);
                        }
                        // Hard failure without retry — leave any bubble alone / don't create one
                        return response;
                    }

                    // Retriable failure
                    if (attempt >= maxRetries) {
                        finishExhausted(classification, response, null);
                    }

                    const nextAttempt = attempt + 1;
                    const delay = computeDelay(nextAttempt, settings);
                    const labelHint = classification.labels?.join(' / ') || `HTTP ${response.status}`;
                    const summary = await summarizeForConfirm(classification, null);

                    if (settings.confirmBeforeRetry) {
                        showRetryBubble({
                            phase: 'confirm',
                            classification,
                            nextAttempt,
                            delayMs: delay,
                        });
                        toast('warning', 'API 失败，等待确认重试…', labelHint);
                        const ok = await askUserConfirm(
                            `${summary}\n\n将进行第 ${nextAttempt}/${maxRetries} 次重试` +
                            (delay > 0 ? `（延迟 ${delay} ms）` : '') +
                            `\n\nURL: ${url.length > 120 ? url.slice(0, 120) + '…' : url}`
                        );
                        if (!ok) {
                            finishCancelled(classification);
                        }
                    }

                    showRetryBubble({
                        phase: 'retrying',
                        classification,
                        nextAttempt,
                        delayMs: delay,
                    });
                    toast('info', `正在重试 ${nextAttempt}/${maxRetries}`, labelHint);
                    if (delay > 0) {
                        await sleep(delay, signal);
                    }

                    attempt = nextAttempt;
                    continue;
                } catch (err) {
                    if (isHandledAbort(err)) {
                        throw err;
                    }
                    if (isAbortError(err)) {
                        // User clicked stop / external abort — drop placeholder
                        if (placeholderActive) {
                            try { await removePlaceholderBubble(); } catch (_) { /* ignore */ }
                            placeholderActive = false;
                        }
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
                        if (placeholderActive) {
                            try { await removePlaceholderBubble(); } catch (_) { /* ignore */ }
                            placeholderActive = false;
                        }
                        throw err;
                    }

                    if (attempt >= maxRetries) {
                        finishExhausted(lastClassification, null, err);
                    }

                    const nextAttempt = attempt + 1;
                    const summary = await summarizeForConfirm(lastClassification, err);
                    const delay = computeDelay(nextAttempt, settings);

                    if (settings.confirmBeforeRetry) {
                        showRetryBubble({
                            phase: 'confirm',
                            classification: lastClassification,
                            nextAttempt,
                            delayMs: delay,
                        });
                        toast('warning', 'API 失败，等待确认重试…', err.name || '网络错误');
                        const ok = await askUserConfirm(
                            `${summary}\n\n将进行第 ${nextAttempt}/${maxRetries} 次重试` +
                            (delay > 0 ? `（延迟 ${delay} ms）` : '') +
                            `\n\nURL: ${url.length > 120 ? url.slice(0, 120) + '…' : url}`
                        );
                        if (!ok) {
                            finishCancelled(lastClassification);
                        }
                    }

                    showRetryBubble({
                        phase: 'retrying',
                        classification: lastClassification,
                        nextAttempt,
                        delayMs: delay,
                    });
                    toast('info', `正在重试 ${nextAttempt}/${maxRetries}`, err.message || '网络错误');
                    if (delay > 0) {
                        await sleep(delay, signal);
                    }

                    attempt = nextAttempt;
                }
            }
        } finally {
            void cancelled;
            void lastError;
            void lastResponse;
            void lastClassification;
        }
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
        <b>仅对话生成</b>：只拦截 SillyTavern 主对话回复的 generate 接口失败并重试，
        不检测扩展更新、翻译、资源、设置等其它网络请求。
        <b>v1.3.0</b> 在重试过程中向当前对话插入<b>一条</b>错误状态气泡（原因 / 进度 / 下次重试时间），
        成功后移除并由 ST 渲染正常回复；全部失败或取消则保留该气泡。quiet 旁路生成不会重试。
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

      <p class="st-api-auto-retry-hint">
        作用范围固定为对话生成接口：
        <code>/api/backends/chat-completions/generate</code>、
        <code>/api/backends/text-completions/generate</code>、
        <code>/api/backends/kobold/generate</code>、
        <code>/api/backends/koboldhorde/generate</code>、
        <code>/api/novelai/generate</code>。
        正文匹配 524/openai_error 时即使状态码不在列表也会重试。
      </p>

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
        toast('info', `扩展已加载 v${VERSION}（仅对话生成）`, 'API 自动重试');
        console.log(`${LOG_PREFIX} v${VERSION} 初始化完成（仅对话 generate 白名单）`);
    }

    if (typeof jQuery !== 'undefined') {
        jQuery(init);
    } else if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
