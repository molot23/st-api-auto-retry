/**
 * st-api-auto-retry — SillyTavern 扩展：上游 API 错误自动重试（可确认）
 * Author: molot23
 */
(function () {
    'use strict';

    const MODULE_NAME = 'st-api-auto-retry';
    const EXTENSION_FOLDER = `scripts/extensions/third-party/${MODULE_NAME}`;
    const LOG_PREFIX = '[API自动重试]';

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

    const originalFetch = window.fetch.bind(window);

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

        // Common ST relative endpoints used for generation
        if (/\/api\/(backends|openai|generate)/i.test(path)) return true;

        return false;
    }

    function isAbortError(err) {
        if (!err) return false;
        if (err.name === 'AbortError') return true;
        if (err.code === 20) return true; // DOMException ABORT_ERR
        const msg = String(err.message || err).toLowerCase();
        return msg.includes('aborted') || msg.includes('abort');
    }

    function isRetriableStatus(status, settings) {
        const codes = parseStatusCodes(settings.retryStatusCodes);
        return codes.includes(Number(status));
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

        // Newer API: Popup.show.confirm
        try {
            if (ctx?.Popup?.show?.confirm) {
                const result = await ctx.Popup.show.confirm(title, body);
                // AFFIRMATIVE is typically 1; also accept true
                if (result === true) return true;
                if (ctx.POPUP_RESULT && result === ctx.POPUP_RESULT.AFFIRMATIVE) return true;
                if (result === 1) return true;
                return false;
            }
        } catch (e) {
            console.warn(`${LOG_PREFIX} Popup.show.confirm failed`, e);
        }

        // Popup constructor + POPUP_TYPE.CONFIRM
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

        // Legacy callGenericPopup
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

    async function summarizeError(response, networkError) {
        if (networkError) {
            return `网络错误：${networkError.name || 'Error'} — ${networkError.message || String(networkError)}`;
        }
        if (!response) {
            return '未知错误（无响应）';
        }

        let detail = '';
        try {
            const clone = response.clone();
            const text = await clone.text();
            if (text) {
                detail = text.length > 400 ? text.slice(0, 400) + '…' : text;
                try {
                    const json = JSON.parse(text);
                    if (json.error) {
                        const err = json.error;
                        detail = typeof err === 'string'
                            ? err
                            : (err.message || err.type || JSON.stringify(err));
                    } else if (json.message) {
                        detail = String(json.message);
                    }
                } catch (_) {
                    /* keep raw text */
                }
            }
        } catch (_) {
            /* ignore body read errors */
        }

        const statusLine = `HTTP ${response.status} ${response.statusText || ''}`.trim();
        return detail ? `${statusLine}\n${detail}` : statusLine;
    }

    async function patchedFetch(input, init) {
        const settings = getSettings();
        const url = getUrlString(input);

        // Pass-through when disabled or not a generation URL
        if (!settings.enabled || !isGenerationRequest(url)) {
            return originalFetch(input, init);
        }

        const maxRetries = Math.max(0, Number(settings.maxRetries) || 0);
        const signal = init?.signal || (input instanceof Request ? input.signal : undefined);

        let attempt = 0; // 0 = first try; retries are 1..maxRetries
        let lastError = null;
        let lastResponse = null;

        while (true) {
            try {
                const response = await originalFetch(input, init);

                if (response.ok || !isRetriableStatus(response.status, settings)) {
                    return response;
                }

                lastResponse = response;
                lastError = null;

                if (attempt >= maxRetries) {
                    toast('error', '已达最大重试次数', `HTTP ${response.status}`);
                    return response;
                }

                // Prepare for retry
                const nextAttempt = attempt + 1;
                const summary = await summarizeError(response, null);
                const delay = computeDelay(nextAttempt, settings);

                if (settings.confirmBeforeRetry) {
                    toast('warning', 'API 失败，等待确认重试…', `HTTP ${response.status}`);
                    const ok = await askUserConfirm(
                        `${summary}\n\n将进行第 ${nextAttempt}/${maxRetries} 次重试` +
                        (delay > 0 ? `（延迟 ${delay} ms）` : '') +
                        `\n\nURL: ${url.length > 120 ? url.slice(0, 120) + '…' : url}`
                    );
                    if (!ok) {
                        toast('info', '已取消重试');
                        return response;
                    }
                }

                toast('info', `正在重试 ${nextAttempt}/${maxRetries}`, `HTTP ${response.status}`);
                if (delay > 0) {
                    await sleep(delay, signal);
                }

                attempt = nextAttempt;
                continue;
            } catch (err) {
                if (isAbortError(err)) {
                    throw err;
                }

                // Network / TypeError — potentially retriable
                lastError = err;
                lastResponse = null;

                if (attempt >= maxRetries) {
                    toast('error', '已达最大重试次数', err.message || '网络错误');
                    throw err;
                }

                const nextAttempt = attempt + 1;
                const summary = await summarizeError(null, err);
                const delay = computeDelay(nextAttempt, settings);

                if (settings.confirmBeforeRetry) {
                    toast('warning', 'API 失败，等待确认重试…', err.name || '网络错误');
                    const ok = await askUserConfirm(
                        `${summary}\n\n将进行第 ${nextAttempt}/${maxRetries} 次重试` +
                        (delay > 0 ? `（延迟 ${delay} ms）` : '') +
                        `\n\nURL: ${url.length > 120 ? url.slice(0, 120) + '…' : url}`
                    );
                    if (!ok) {
                        toast('info', '已取消重试');
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
      <small class="st-api-auto-retry-hint">尽量只对 chat/completions、openai、generate 等路径重试，避免误伤扩展更新/翻译等。</small>

      <div class="st-api-auto-retry-footer">
        <small>版本 1.0.0 · molot23</small>
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
        console.log(`${LOG_PREFIX} 已劫持 window.fetch`);
    }

    function init() {
        // Ensure settings exist
        getSettings();
        installFetchPatch();
        waitAndInjectSettings();
        toast('info', '扩展已加载', 'API 自动重试');
        console.log(`${LOG_PREFIX} v1.0.0 初始化完成`);
    }

    // Boot
    if (typeof jQuery !== 'undefined') {
        jQuery(init);
    } else if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
