// ==UserScript==
// @name         数据库 V（可视化数据编辑精简版）
// @namespace    http://tampermonkey.net/
// @version      3.6.1
// @description  只提供当前聊天的表格数据、模板结构、列定义和世界书注入位置编辑。
// @author       Cline (AI Assisted)
// @match        */*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
(function () {
    'use strict';

    /*
     * 这个文件刻意只保留三件事：现行聊天字段读写、完整 checkpoint 载入、
     * 以及一个点击菜单后才创建的奶油风表格编辑器。
     * 空字符串标签（""）是唯一工作槽位；其它槽位不会被触碰。
    */
    const PREFIX = 'shujuku_v120';
    const MINIMAL_INSTANCE_FLAG = '__ACU_STAR_DB_MINIMAL_VISUALIZER_LOADED__';
    const DATA_FIELD = 'TavernDB_ACU_IsolatedData';
    const GUIDE_FIELD = 'TavernDB_ACU_InternalSheetGuide';
    const SCOPE_FIELD = 'TavernDB_ACU_ScopedConfig';
    const LEGACY_TEMPLATE_FIELD = 'TavernDB_ACU_TableHeaderGuide';
    const SLOT = '';
    const SETTINGS_NAMESPACE = `${PREFIX}__userscript_settings_v1`;
    const CONFIG_IDB_NAME = `${PREFIX}_config_v1`;
    const CONFIG_IDB_STORE = 'kv';
    const MENU_ID = 'acu-minimal-editor-menu';
    const ROOT_ID = 'acu-minimal-editor-root';
    const NOTICE_ID = 'acu-minimal-editor-notices';
    const PAGE_SIZE = 50;
    const STORY_DATE_AI_LOOKBACK = 5;
    const MANAGED_COMMENT_PREFIX = 'TavernDB-ACU-CustomExport-';
    const WORLD_BOOK_TARGET_KEY = `${PREFIX}_worldbook_target_v1`;
    const WORLD_BOOK_ACTIVE_PROJECTION_KEY = `${PREFIX}_worldbook_active_projection_v2`;
    const UI_ACCENT_THEME_KEY = `${PREFIX}_ui_accent_theme_v1`;
    const IDB_OPEN_TIMEOUT_MS = 900;
    const MOBILE_DRAWER_SETTLE_MS = 180;
    // 这些是原版曾经写入聊天消息的已确认字段。卸载式清理只按这份
    // 白名单删除，不会碰 mes、普通 extra 或其它插件的未知字段。
    const LEGACY_MESSAGE_FIELDS = Object.freeze([
        'TavernDB_ACU_Data',
        'TavernDB_ACU_SummaryData',
        'TavernDB_ACU_IndependentData',
        'TavernDB_ACU_Identity',
        DATA_FIELD,
        'TavernDB_ACU_LocalMessageAnchor',
        'TavernDB_ACU_ModifiedKeys',
        'TavernDB_ACU_UpdateGroupKeys',
        '_acu_local_template_base_state_seeded',
        'qrf_plot',
        'qrf_plot_preset',
        'qrf_plot_tasks',
        '_plot_processed',
        '_qrf_plot_pending_hash',
        '_qrf_from_planning',
        '_acu_remote_memory_snapshot_anchor',
    ]);
    const LEGACY_EXTRA_FIELDS = Object.freeze([
        '_acu_original_content',
        '_acu_last_optimized_at',
        '_acu_last_optimized_message_id',
    ]);
    const TEMPLATE_MESSAGE_FIELDS = Object.freeze([GUIDE_FIELD, SCOPE_FIELD, LEGACY_TEMPLATE_FIELD]);
    const BUILTIN_UIDS = new Set([
        'sheet_dCudvUnH', 'sheet_DpKcVGqg', 'sheet_NcBlYRH5',
        'sheet_lEARaBa8', 'sheet_in05z9vz', 'sheet_etak47Ve',
        'sheet_3NoMc1wI', 'sheet_OptionsNew', 'sheet_global_data',
        'sheet_protagonist', 'sheet_important_non_romance', 'sheet_summary',
    ]);

    const clone = (value) => {
        if (value === undefined) return undefined;
        try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
    };
    const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
    const isSheetKey = key => typeof key === 'string' && key.startsWith('sheet_');
    const text = value => value === null || value === undefined ? '' : String(value);
    const parseJson = (value, fallback = null, copyObject = true) => {
        if (isObject(value) || Array.isArray(value)) return copyObject ? clone(value) : value;
        if (typeof value !== 'string' || !value.trim()) return fallback;
        try {
            const first = JSON.parse(value);
            if (typeof first === 'string') {
                try { return JSON.parse(first); } catch (_) { return first; }
            }
            return first;
        } catch (_) { return fallback; }
    };
    const normalizeUiAccentTheme = value => parseJson(value, value) === 'green' ? 'green' : 'blue';
    const esc = value => text(value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const newSheetKey = () => `sheet_${Math.random().toString(36).slice(2, 11)}`;
    const newEntryId = () => `minimal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;

    function getHostWindow() {
        try {
            if (window.parent && window.parent !== window) {
                void window.parent.document;
                return window.parent;
            }
        } catch (_) { /* cross-frame access */ }
        return window;
    }
    const HOST = getHostWindow();
    const LOCAL = window;
    const doc = () => HOST.document || LOCAL.document;
    const rawTavern = () => LOCAL.SillyTavern || HOST.SillyTavern || null;
    function context() {
        const raw = rawTavern();
        try {
            if (raw && (Array.isArray(raw.chat) || raw.eventSource || raw.chatMetadata)) return raw;
            if (raw && typeof raw.getContext === 'function') return raw.getContext() || {};
        } catch (_) { /* host is not ready */ }
        return {};
    }
    const helper = () => LOCAL.TavernHelper || HOST.TavernHelper || null;
    let worldbookOptions = [];
    let boundWorldbookOptions = [];
    let worldbookTarget = 'auto';
    let resolvedWorldbookTarget = '';
    const chat = () => {
        const c = context();
        return Array.isArray(c.chat) ? c.chat : [];
    };
    function currentChatId() {
        const c = context();
        try {
            if (typeof c.getCurrentChatId === 'function') return text(c.getCurrentChatId());
            return text(c.chatId || '');
        } catch (_) { return ''; }
    }
    async function saveChat() {
        const c = context();
        if (typeof c.saveChat === 'function') await c.saveChat();
        else if (typeof HOST.saveChat === 'function') await HOST.saveChat();
    }
    function removeEditorNotices() {
        doc()?.getElementById(NOTICE_ID)?.remove();
    }
    function showEditorNotice(message, kind = 'info') {
        const document = doc();
        // Only replace the host toast while our full-screen editor is open.
        // Outside the editor, SillyTavern's normal notification surface remains
        // the least surprising place for background/worldbook messages.
        if (!document?.body || !document.getElementById(ROOT_ID)) return false;
        const tone = ['success', 'warning', 'error', 'info'].includes(kind) ? kind : 'info';
        let layer = document.getElementById(NOTICE_ID);
        if (!layer) {
            layer = document.createElement('div');
            layer.id = NOTICE_ID;
            layer.className = 'acu-editor-notice-layer';
            document.body.appendChild(layer);
        }
        layer.dataset.accent = uiAccentTheme;
        while (layer.childElementCount >= 4) layer.firstElementChild?.remove();

        const notice = document.createElement('div');
        notice.className = `acu-editor-notice acu-editor-notice--${tone}`;
        notice.setAttribute('role', tone === 'error' ? 'alert' : 'status');
        const mark = document.createElement('span');
        mark.className = 'acu-editor-notice-mark';
        mark.setAttribute('aria-hidden', 'true');
        mark.textContent = tone === 'success' ? '✓' : tone === 'warning' ? '!' : tone === 'error' ? '×' : 'i';
        const body = document.createElement('span');
        body.className = 'acu-editor-notice-text';
        body.textContent = text(message);
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'acu-editor-notice-close';
        close.setAttribute('aria-label', '关闭通知');
        close.textContent = '×';
        notice.append(mark, body, close);
        layer.appendChild(notice);

        let removed = false;
        let timer = null;
        const remove = () => {
            if (removed) return;
            removed = true;
            if (timer) clearTimeout(timer);
            notice.classList.add('leaving');
            setTimeout(() => {
                notice.remove();
                if (!layer.childElementCount) layer.remove();
            }, 170);
        };
        close.addEventListener('click', remove);
        // requestAnimationFrame may pause in a background/mobile webview tab.
        // A zero-delay timer guarantees that the notice never stays transparent.
        setTimeout(() => notice.classList.add('visible'), 0);
        timer = setTimeout(remove, tone === 'error' ? 6200 : tone === 'warning' ? 5200 : 3800);
        return true;
    }
    function notify(message, kind = 'info') {
        if (showEditorNotice(message, kind)) return;
        try {
            const toast = HOST.toastr || LOCAL.toastr;
            if (toast && typeof toast[kind] === 'function') { toast[kind](message); return; }
        } catch (_) { /* console fallback */ }
        if (kind === 'error') console.error(`[数据库] ${message}`);
        else console.log(`[数据库] ${message}`);
    }

    /* 沿用原脚本的设置存储能力，只保存世界书目标和临时投影位置；没有默认表定义。 */
    let settingsNamespace = null;
    let settingsSave = null;
    let idbPromise = null;
    const idbMemory = new Map();
    function openIdb() {
        if (idbPromise) return idbPromise;
        if (!HOST.indexedDB) return Promise.resolve(null);
        idbPromise = new Promise(resolve => {
            let settled = false;
            let timeoutId = null;
            const finish = db => {
                if (settled) {
                    try { db?.close?.(); } catch (_) { /* late Safari success */ }
                    return;
                }
                settled = true;
                if (timeoutId) clearTimeout(timeoutId);
                resolve(db || null);
            };
            try {
                const request = HOST.indexedDB.open(CONFIG_IDB_NAME, 1);
                request.onupgradeneeded = () => {
                    if (!request.result.objectStoreNames.contains(CONFIG_IDB_STORE)) request.result.createObjectStore(CONFIG_IDB_STORE);
                };
                request.onsuccess = () => finish(request.result);
                request.onerror = () => finish(null);
                request.onblocked = () => finish(null);
                // WebKit can leave indexedDB.open() pending forever. Settings
                // are optional, so never let them block opening the editor.
                timeoutId = setTimeout(() => finish(null), IDB_OPEN_TIMEOUT_MS);
            } catch (_) { finish(null); }
        });
        return idbPromise;
    }
    async function idbGet(key) {
        if (idbMemory.has(key)) return idbMemory.get(key);
        const db = await openIdb();
        if (!db) return null;
        return new Promise(resolve => {
            try {
                const req = db.transaction(CONFIG_IDB_STORE, 'readonly').objectStore(CONFIG_IDB_STORE).get(key);
                req.onsuccess = () => { idbMemory.set(key, req.result); resolve(req.result ?? null); };
                req.onerror = () => resolve(null);
            } catch (_) { resolve(null); }
        });
    }
    async function idbSet(key, value) {
        idbMemory.set(key, value);
        const db = await openIdb();
        if (!db) return;
        try { db.transaction(CONFIG_IDB_STORE, 'readwrite').objectStore(CONFIG_IDB_STORE).put(value, key); } catch (_) { }
    }
    async function initSettings() {
        const c = context();
        const raw = rawTavern();
        try {
            const root = c.extensionSettings || raw?.extensionSettings || HOST.extension_settings;
            if (root && typeof root === 'object') {
                root.__userscripts = root.__userscripts || {};
                root.__userscripts[SETTINGS_NAMESPACE] = root.__userscripts[SETTINGS_NAMESPACE] || {};
                settingsNamespace = root.__userscripts[SETTINGS_NAMESPACE];
                settingsSave = c.saveSettingsDebounced || raw?.saveSettingsDebounced || HOST.saveSettingsDebounced || null;
                return;
            }
        } catch (_) { /* fallback */ }
        try {
            settingsNamespace = {
                _fallback: true,
                getItem: key => HOST.localStorage?.getItem(key),
                setItem: (key, value) => HOST.localStorage?.setItem(key, value),
            };
        } catch (_) { settingsNamespace = null; }
    }
    async function settingGet(key) {
        if (settingsNamespace && !settingsNamespace._fallback && Object.prototype.hasOwnProperty.call(settingsNamespace, key)) return settingsNamespace[key];
        const cached = await idbGet(key);
        if (cached !== null && cached !== undefined) return cached;
        try { return settingsNamespace?.getItem?.(key) ?? null; } catch (_) { return null; }
    }
    async function settingSet(key, value) {
        const serialized = typeof value === 'string' ? value : JSON.stringify(value);
        if (settingsNamespace) {
            try {
                if (settingsNamespace._fallback) settingsNamespace.setItem(key, serialized);
                else settingsNamespace[key] = serialized;
                if (typeof settingsSave === 'function') settingsSave();
            } catch (_) { }
        }
        await idbSet(key, serialized);
    }

    function worldbookTargetScopeKey() {
        return currentChatId() || '__unbound_chat__';
    }
    async function readWorldbookTarget(scopeKey = worldbookTargetScopeKey()) {
        const stored = await settingGet(WORLD_BOOK_TARGET_KEY);
        const parsed = parseJson(stored, null);
        if (isObject(parsed)) return text(parsed[scopeKey] || 'auto').trim() || 'auto';
        if (typeof parsed === 'string') return parsed.trim() || 'auto';
        // minimal.6 曾短暂使用单一字符串；继续读它，但下一次选择时会迁移成按聊天保存的映射。
        return text(stored).trim() || 'auto';
    }
    async function writeWorldbookTarget(value, scopeKey = worldbookTargetScopeKey()) {
        const target = text(value).trim() || 'auto';
        const stored = await settingGet(WORLD_BOOK_TARGET_KEY);
        const parsed = parseJson(stored, null);
        const mapping = isObject(parsed) ? parsed : {};
        mapping[scopeKey] = target;
        await settingSet(WORLD_BOOK_TARGET_KEY, JSON.stringify(mapping));
        return target;
    }
    function projectionScopeToken(scopeKey = worldbookTargetScopeKey()) {
        const source = text(scopeKey);
        let hash = 2166136261;
        for (let index = 0; index < source.length; index++) {
            hash ^= source.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(36).padStart(7, '0');
    }
    function managedProjectionPrefix(scopeKey = worldbookTargetScopeKey()) {
        return `${MANAGED_COMMENT_PREFIX}@${projectionScopeToken(scopeKey)}-`;
    }
    async function readActiveWorldbookProjection() {
        const parsed = parseJson(await settingGet(WORLD_BOOK_ACTIVE_PROJECTION_KEY), null);
        if (!isObject(parsed) || !text(parsed.book).trim() || !text(parsed.scopeKey).trim()) return null;
        return { scopeKey: text(parsed.scopeKey), book: text(parsed.book) };
    }
    async function writeActiveWorldbookProjection(record = null) {
        await settingSet(WORLD_BOOK_ACTIVE_PROJECTION_KEY, record && record.book && record.scopeKey
            ? JSON.stringify({ scopeKey: text(record.scopeKey), book: text(record.book) })
            : '');
    }

    /* -------------------- 三个现行聊天字段 -------------------- */
    const firstMessage = () => isObject(chat()[0]) ? chat()[0] : null;
    function metadata() {
        const c = context();
        if (isObject(c.chatMetadata)) return c.chatMetadata;
        if (isObject(HOST.chat_metadata)) return HOST.chat_metadata;
        return null;
    }
    function readField(field) {
        const meta = metadata();
        const owner = text(meta?.[`${field}__chatId`]);
        const active = currentChatId();
        const fromMeta = owner && (!active || owner !== active) ? null : parseJson(meta?.[field], null);
        const fromMessage = parseJson(firstMessage()?.[field], null);
        // 旧聊天可能没有 owner 标记；此时第一条消息是聊天内字段的权威来源，
        // 不能让尚未切换完成的全局 metadata 把上一聊天模板带进来。
        if (!owner && !fromMessage) return null;
        if (fromMessage && !owner) {
            // 仍保留 metadata 中明确属于其它标签槽的同级数据，但绝不把空槽
            // （当前工作槽）从滞后的 metadata 带入当前聊天。
            const merged = clone(fromMessage);
            ['tags', 'template'].forEach(containerKey => {
                if (!isObject(merged[containerKey]) || !isObject(fromMeta?.[containerKey])) return;
                Object.entries(fromMeta[containerKey]).forEach(([slot, value]) => {
                    if (slot !== SLOT && !Object.prototype.hasOwnProperty.call(merged[containerKey], slot)) {
                        merged[containerKey][slot] = clone(value);
                    }
                });
            });
            return merged;
        }
        if (isObject(fromMeta) && isObject(fromMessage)) {
            const merged = clone(fromMeta);
            Object.entries(fromMessage).forEach(([key, value]) => {
                if (!Object.prototype.hasOwnProperty.call(merged, key)) merged[key] = clone(value);
                else if (isObject(merged[key]) && isObject(value)) {
                    Object.entries(value).forEach(([slot, slotValue]) => {
                        if (!Object.prototype.hasOwnProperty.call(merged[key], slot)) merged[key][slot] = clone(slotValue);
                    });
                }
            });
            return merged;
        }
        return fromMeta || fromMessage || null;
    }
    function writeField(field, value) {
        const c = context();
        const first = firstMessage();
        const meta = metadata();
        const hasValue = isObject(value) && Object.keys(value).length > 0;
        const ownerField = `${field}__chatId`;
        const active = currentChatId();
        const existingOwner = text(meta?.[ownerField]);
        // metadata 是全局活动聊天缓存；若它明确属于另一个聊天，切换尚未完成时
        // 只写当前聊天首楼，避免把当前模板覆盖到上一聊天的 metadata。
        const metadataBelongsToActive = existingOwner
            ? (!!active && existingOwner === active)
            // 没有 owner 且宿主也没有稳定聊天 ID 时，只有首楼明确带有该字段
            // 才认为这份 ownerless metadata 属于当前聊天；否则不做破坏性覆盖/删除。
            : (!!active || Object.prototype.hasOwnProperty.call(first || {}, field));
        if (meta && metadataBelongsToActive) {
            if (hasValue) meta[field] = clone(value); else delete meta[field];
            if (hasValue && active) meta[ownerField] = active;
            else delete meta[ownerField];
            try {
                if (typeof c.updateChatMetadata === 'function') {
                    c.updateChatMetadata({ [field]: hasValue ? value : undefined, [ownerField]: hasValue && active ? active : undefined }, false);
                }
            } catch (_) { }
        }
        if (first) {
            if (hasValue) first[field] = clone(value); else delete first[field];
        }
    }
    function snapshotTemplateFields() {
        const fields = [...TEMPLATE_MESSAGE_FIELDS, ...TEMPLATE_MESSAGE_FIELDS.map(field => `${field}__chatId`)];
        const capture = (target, keys) => keys.map(key => ({
            key,
            had: !!target && Object.prototype.hasOwnProperty.call(target, key),
            value: target?.[key],
        }));
        return {
            chat: chat(),
            chatId: currentChatId(),
            first: firstMessage(),
            meta: metadata(),
            firstFields: capture(firstMessage(), TEMPLATE_MESSAGE_FIELDS),
            metaFields: capture(metadata(), fields),
        };
    }
    function restoreTemplateFields(snapshot) {
        const restore = (target, records) => {
            if (!target) return;
            records.forEach(record => {
                if (record.had) target[record.key] = record.value;
                else delete target[record.key];
            });
        };
        restore(snapshot?.first, snapshot?.firstFields || []);
        const sameChat = chat() === snapshot?.chat
            && (!snapshot?.chatId || currentChatId() === snapshot.chatId);
        if (!sameChat || metadata() !== snapshot?.meta) return;
        restore(snapshot.meta, snapshot.metaFields || []);
        const patch = {};
        (snapshot.metaFields || []).forEach(record => { patch[record.key] = record.had ? record.value : undefined; });
        try {
            const update = context().updateChatMetadata?.(patch, false);
            Promise.resolve(update).catch(() => {});
        } catch (_) { }
    }
    function isolatedContainer(message, copyObject = true) {
        const parsed = parseJson(message?.[DATA_FIELD], null, copyObject);
        return isObject(parsed) ? parsed : {};
    }
    function writeIsolatedContainer(message, container, originalValue = message?.[DATA_FIELD]) {
        if (!message) return;
        if (!isObject(container) || Object.keys(container).length === 0) {
            delete message[DATA_FIELD];
            return;
        }
        // Keep the old outer encoding (object / JSON / double-JSON) when deleting a
        // historical frame. This avoids rewriting unrelated chat fields.
        if (typeof originalValue === 'string') {
            try {
                const first = JSON.parse(originalValue);
                message[DATA_FIELD] = typeof first === 'string'
                    ? JSON.stringify(JSON.stringify(container))
                    : JSON.stringify(container);
            } catch (_) {
                message[DATA_FIELD] = JSON.stringify(container);
            }
        } else message[DATA_FIELD] = container;
    }
    function pageRows(rows, page = 0, reverse = false, pageSize = PAGE_SIZE) {
        const source = Array.isArray(rows) ? rows : [];
        const size = Math.max(1, Number(pageSize) || PAGE_SIZE);
        const pageCount = Math.max(1, Math.ceil(source.length / size));
        const safePage = Math.max(0, Math.min(Number(page) || 0, pageCount - 1));
        const start = safePage * size;
        const items = [];
        for (let offset = 0; offset < size && start + offset < source.length; offset++) {
            const displayIndex = start + offset;
            const physicalIndex = reverse ? source.length - 1 - displayIndex : displayIndex;
            items.push({ row: source[physicalIndex], physicalIndex });
        }
        return { page: safePage, pageCount, start, items };
    }
    function recordFieldSize(value, label = '') {
        const source = `${text(label)} ${text(value)}`;
        let weight = 0;
        for (const char of source) {
            if (char === '\n') weight += 12;
            else if (/[^\u0000-\u00ff]/.test(char)) weight += 2;
            else weight += 1;
        }
        return weight > 88 ? 'long' : (weight > 34 ? 'medium' : 'short');
    }
    function isV2Slot(slot) {
        return isObject(slot) && isObject(slot.storageFrame)
            && slot.storageFrame.version === 2 && Array.isArray(slot.storageFrame.logEntries);
    }
    function hasUsableFullCheckpoint(frame) {
        const checkpoint = frame?.checkpoint;
        if (!isObject(checkpoint) || checkpoint.kind !== 'full') return false;
        const data = parseJson(checkpoint.data, null);
        return isObject(data);
    }
    function frameHasReplayDelta(frame) {
        return Array.isArray(frame?.logEntries) && frame.logEntries.length > 0;
    }
    function currentGuide() {
        const container = readField(GUIDE_FIELD);
        const slot = isObject(container?.tags) ? container.tags[SLOT] : null;
        const data = parseJson(slot?.data, null);
        return isObject(data) ? clone(data) : null;
    }
    function currentScopedTemplate() {
        const container = readField(SCOPE_FIELD);
        const slot = isObject(container?.template) ? container.template[SLOT] : null;
        if (typeof slot?.templateStr === 'string') return parseJson(slot.templateStr, null);
        if (isObject(slot?.template)) return clone(slot.template);
        return null;
    }

    /* -------------------- 表格结构 -------------------- */
    const defaultPlacement = () => ({ position: 'at_depth_as_system', depth: 2, order: 10000 });
    const defaultExtraPlacement = () => ({ position: 'at_depth_as_system', depth: 2, order: 10010 });
    function delimitedList(value) {
        const values = Array.isArray(value) ? value : text(value).split(/[,，\n]/);
        return [...new Set(values.map(item => text(item).trim()).filter(Boolean))];
    }
    function normalizePosition(value, fallback = 'at_depth_as_system') {
        const raw = text(value).trim().toLowerCase();
        if (['before_char', 'before_character', 'before_character_definition', '0'].includes(raw)) return 'before_character_definition';
        if (['after_char', 'after_character', 'after_character_definition', '1'].includes(raw)) return 'after_character_definition';
        if (['system', 'at_depth_as_system'].includes(raw)) return 'at_depth_as_system';
        return fallback;
    }
    function normalizePlacement(raw, fallback = defaultPlacement()) {
        const source = isObject(raw) ? raw : {};
        const depth = Number.parseInt(source.depth, 10);
        const order = Number.parseInt(source.order, 10);
        return {
            position: normalizePosition(source.position, fallback.position),
            depth: Number.isFinite(depth) ? depth : fallback.depth,
            order: Number.isFinite(order) ? order : fallback.order,
        };
    }
    function normalizeExport(raw, name = '') {
        const parsed = parseJson(raw, null, false);
        const source = isObject(parsed) ? parsed : {};
        return {
            // 旧备份中的第二个世界书开关只作为读取条件；当前版合并为一个开关。
            enabled: source.enabled === true && source.injectIntoWorldbook !== false,
            splitByRow: source.splitByRow === true,
            entryName: text(source.entryName || name),
            entryType: source.entryType === 'keyword' ? 'keyword' : 'constant',
            keywords: text(source.keywords),
            preventRecursion: source.preventRecursion !== false,
            injectionTemplate: text(source.injectionTemplate),
            entryPlacement: normalizePlacement(source.entryPlacement, defaultPlacement()),
            extraIndexEnabled: source.extraIndexEnabled === true,
            extraIndexEntryName: text(source.extraIndexEntryName || `${name || '表格'}-索引`),
            extraIndexColumns: delimitedList(source.extraIndexColumns),
            extraIndexInjectionTemplate: text(source.extraIndexInjectionTemplate),
            extraIndexPlacement: normalizePlacement(source.extraIndexPlacement, defaultExtraPlacement()),
            relativeTimeEnabled: source.relativeTimeEnabled === true,
            relativeTimeColumn: text(source.relativeTimeColumn),
        };
    }
    function normalizeSheet(raw, key, keepRows = true) {
        const parsedSheet = parseJson(raw, null, false);
        const source = isObject(parsedSheet) ? parsedSheet : {};
        const name = text(source.name || key);
        const oldContent = Array.isArray(source.content) ? source.content : [];
        const header = Array.isArray(oldContent[0]) && oldContent[0].length ? clone(oldContent[0]) : [null, '列1'];
        if (header[0] === undefined) header[0] = null;
        const content = [header];
        if (keepRows) {
            oldContent.slice(1).forEach((rawRow, index) => {
                const row = Array.isArray(rawRow) ? clone(rawRow) : [];
                while (row.length < header.length) row.push('');
                if (row.length > header.length) row.splice(header.length);
                if (!row[0] && row[0] !== 0) row[0] = String(index + 1);
                content.push(row);
            });
        }
        return {
            uid: text(source.uid || key),
            name,
            content,
            exportConfig: normalizeExport(source.exportConfig, name),
            orderNo: Number.isFinite(Number(source.orderNo)) ? Math.trunc(Number(source.orderNo)) : 0,
        };
    }
    function orderedKeys(data) {
        return Object.keys(data || {}).filter(isSheetKey).sort((a, b) => {
            const left = Number(data[a]?.orderNo), right = Number(data[b]?.orderNo);
            if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;
            if (Number.isFinite(left) !== Number.isFinite(right)) return Number.isFinite(left) ? -1 : 1;
            return a.localeCompare(b);
        });
    }
    function normalizeData(raw, keepRows = true) {
        const parsedData = parseJson(raw, null, false);
        const source = isObject(parsedData) ? parsedData : {};
        const data = { mate: { type: 'chatSheets', version: Number(source.mate?.version) || 1 } };
        Object.keys(source).filter(isSheetKey).forEach(key => { data[key] = normalizeSheet(source[key], key, keepRows); });
        orderedKeys(data).forEach((key, index) => { data[key].orderNo = index; });
        return data;
    }
    function removeBuiltinSheets(value, keepRows = true) {
        const output = normalizeData(value, keepRows);
        Object.keys(output).filter(isSheetKey).forEach(key => {
            // 原版默认表都有稳定 UID；只按 UID 删除，避免误删用户自建的同名表。
            if (BUILTIN_UIDS.has(output[key].uid) || BUILTIN_UIDS.has(key)) {
                delete output[key];
            }
        });
        orderedKeys(output).forEach((key, index) => { output[key].orderNo = index; });
        return output;
    }
    function removeBuiltins(template) {
        return removeBuiltinSheets(template, false);
    }
    function minimalDataForWrite(data, keepRows = true) {
        // normalizeData 已经在入口白名单化；这里仅继续阻止原版默认表复活。
        return removeBuiltinSheets(data, keepRows);
    }
    function templateFromData(data) {
        return minimalDataForWrite(data, false);
    }
    function templateOverview(data) {
        const keys = orderedKeys(data);
        if (!keys.length) return '当前模板没有表格。\n点击“新表”创建第一张表。';
        return [`表格数：${keys.length}`, ...keys.map(key => {
            const sheet = data[key];
            const columns = (sheet.content?.[0] || []).slice(1).map(text).join(' / ') || '（无列）';
            return `· ${sheet.name || key}：${columns}`;
        })].join('\n');
    }
    function applyGuide(state, guide) {
        if (!isObject(guide)) return;
        const keys = Object.keys(guide).filter(isSheetKey);
        keys.forEach(key => {
            const source = guide[key];
            if (!isObject(source)) return;
            if (!state[key]) state[key] = normalizeSheet(source, key, false);
            const target = state[key];
            ['uid', 'name', 'exportConfig', 'orderNo'].forEach(field => {
                if (source[field] !== undefined) target[field] = clone(source[field]);
            });
            if (Array.isArray(source.content?.[0])) {
                const header = clone(source.content[0]);
                target.content = Array.isArray(target.content) ? target.content : [header];
                target.content[0] = header;
                for (let index = 1; index < target.content.length; index++) {
                    if (!Array.isArray(target.content[index])) target.content[index] = [];
                    const row = target.content[index];
                    while (row.length < header.length) row.push('');
                    if (row.length > header.length) row.splice(header.length);
                }
            }
        });
        Object.keys(state).filter(isSheetKey).forEach(key => { if (!keys.includes(key)) delete state[key]; });
    }

    /* -------------------- V2 checkpoint 读取与写回 -------------------- */
    function getFrameRefs(messages) {
        const refs = [];
        let aiFloor = 0;
        (Array.isArray(messages) ? messages : []).forEach((message, index) => {
            if (!message || message.is_user) return;
            aiFloor += 1;
            const slot = isolatedContainer(message, false)[SLOT];
            if (isV2Slot(slot)) refs.push({ message, index, aiFloor, frame: slot.storageFrame });
        });
        return refs;
    }
    function restoreLatestCheckpoint(messages, guide, frameRefs = null) {
        const refs = frameRefs || getFrameRefs(messages);
        const base = [...refs].reverse().find(ref => ref.frame?.checkpoint?.kind === 'full');
        if (!base) return null;
        if (!hasUsableFullCheckpoint(base.frame)) {
            throw new Error(`AI 第 ${base.aiFloor} 层的最新 full checkpoint 已损坏，推荐版不会回退旧快照或覆盖保存。`);
        }
        if (refs.some(ref => ref.index >= base.index && frameHasReplayDelta(ref.frame))) {
            throw new Error('当前聊天在最新 full checkpoint 之后还有旧增量日志。请临时使用“旧聊天兼容迁移版”保存一次完整 checkpoint，再切回推荐版。');
        }
        const state = normalizeData(base.frame.checkpoint.data, true);
        applyGuide(state, guide);
        return state;
    }
    function checkpointInfo(messages) {
        const fullCheckpoints = getFrameRefs(messages)
            .filter(ref => hasUsableFullCheckpoint(ref.frame));
        const latest = [...fullCheckpoints].reverse()[0];
        return { latest, fullCheckpoints };
    }
    function aiFloorCount(messages) {
        return (Array.isArray(messages) ? messages : []).reduce((count, message) => count + (message && !message.is_user ? 1 : 0), 0);
    }
    function normalizeAiFloorRange(startFloor, endFloor, messages) {
        const total = aiFloorCount(messages);
        if (!total) throw new Error('当前聊天还没有 AI 楼层，无法删除本地数据。');
        const startText = text(startFloor).trim();
        const endText = text(endFloor).trim();
        const start = startText ? Number.parseInt(startText, 10) : 1;
        const end = endText ? Number.parseInt(endText, 10) : total;
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < 1 || start > end || end > total) {
            throw new Error(`请输入有效的 AI 楼层范围（1 到 ${total}，首尾均包含）。`);
        }
        return { start, end, total };
    }
    function aiFloorIndices(messages) {
        const result = [];
        (Array.isArray(messages) ? messages : []).forEach((message, index) => {
            if (message && !message.is_user) result.push(index);
        });
        return result;
    }
    function rememberDeletedProperty(changes, target, key) {
        if (!target || !Object.prototype.hasOwnProperty.call(target, key)) return false;
        let record = changes.find(item => item.target === target);
        if (!record) {
            record = { target, properties: [] };
            changes.push(record);
        }
        record.properties.push({ key, value: target[key] });
        delete target[key];
        return true;
    }
    function restoreDeletedProperties(changes) {
        [...(Array.isArray(changes) ? changes : [])].reverse().forEach(record => {
            [...record.properties].reverse().forEach(({ key, value }) => { record.target[key] = value; });
        });
    }
    function jsonByteLength(value) {
        try {
            const serialized = JSON.stringify(value) || '';
            if (typeof TextEncoder === 'function') return new TextEncoder().encode(serialized).length;
            return unescape(encodeURIComponent(serialized)).length;
        } catch (_) { return 0; }
    }
    function removeLegacyExtraFields(message, changes) {
        const extra = message?.extra;
        if (!isObject(extra)) return false;
        const keys = LEGACY_EXTRA_FIELDS.filter(key => Object.prototype.hasOwnProperty.call(extra, key));
        if (!keys.length) return false;
        rememberDeletedProperty(changes, message, 'extra');
        const next = { ...extra };
        keys.forEach(key => delete next[key]);
        if (Object.keys(next).length) message.extra = next;
        return true;
    }
    function removeAllKnownPluginData(messages, metadataObject = metadata()) {
        const changes = [];
        const changedMessages = new Set();
        let removedCharacters = 0;
        const first = Array.isArray(messages) ? messages[0] : null;
        // 卸载前先记住首楼证据；字段稍后会从消息中删除，不能再用删除后的
        // 首楼判断 ownerless metadata 是否属于当前聊天。
        const firstFieldEvidence = new Set(
            [...LEGACY_MESSAGE_FIELDS, ...TEMPLATE_MESSAGE_FIELDS]
                .filter(field => Object.prototype.hasOwnProperty.call(first || {}, field)),
        );
        (Array.isArray(messages) ? messages : []).forEach(message => {
            if (!message) return;
            const before = jsonByteLength(message);
            let messageRemoved = false;
            LEGACY_MESSAGE_FIELDS.forEach(key => {
                if (rememberDeletedProperty(changes, message, key)) messageRemoved = true;
            });
            const extraRemoved = removeLegacyExtraFields(message, changes);
            messageRemoved = messageRemoved || extraRemoved;
            TEMPLATE_MESSAGE_FIELDS.forEach(key => {
                if (rememberDeletedProperty(changes, message, key)) messageRemoved = true;
            });
            const after = jsonByteLength(message);
            if (messageRemoved) {
                changedMessages.add(message);
                removedCharacters += Math.max(0, before - after);
            }
        });
        const metadataChanges = [];
        const activeChatId = currentChatId();
        if (metadataObject && isObject(metadataObject)) {
            [...LEGACY_MESSAGE_FIELDS, ...TEMPLATE_MESSAGE_FIELDS]
                .flatMap(key => [key, `${key}__chatId`])
                .forEach(key => {
                    if (!Object.prototype.hasOwnProperty.call(metadataObject, key)) return;
                    const field = key.endsWith('__chatId') ? key.slice(0, -'__chatId'.length) : key;
                    const owner = text(metadataObject[`${field}__chatId`]).trim();
                    // A metadata cache owned by another chat is never touched. An ownerless
                    // cache is only considered safe when the same field is present on chat[0].
                    // 有 owner 但当前上下文没有可靠的聊天 ID 时，不能猜测归属；
                    // 宁可保留缓存，也不能误删另一聊天的模板/配置。
                    if (owner && (!activeChatId || owner !== activeChatId)) return;
                    if (!owner && !firstFieldEvidence.has(field)) return;
                    metadataChanges.push({ key, value: metadataObject[key] });
                    delete metadataObject[key];
                });
        }
        return {
            removed: changedMessages.size,
            removedCharacters,
            changes,
            metadataObject,
            metadataChanges,
            changed: changedMessages.size > 0 || metadataChanges.length > 0,
        };
    }
    function assertFrameDeletionReplayable(messages, selected) {
        const survivors = [];
        (Array.isArray(messages) ? messages : []).forEach((message, index) => {
            if (!message || message.is_user || selected.has(index)) return;
            const slot = isolatedContainer(message, false)[SLOT];
            if (isV2Slot(slot)) survivors.push({ frame: slot.storageFrame, index });
        });
        if (!survivors.length) return;
        let latestFullIndex = -1;
        survivors.forEach((ref, index) => { if (hasUsableFullCheckpoint(ref.frame)) latestFullIndex = index; });
        if (latestFullIndex < 0) {
            throw new Error('清理后会只剩无法独立读取的旧增量记录。请扩大删除范围，或先用旧聊天兼容迁移版保存完整 checkpoint。');
        }
        if (survivors.slice(latestFullIndex).some(ref => frameHasReplayDelta(ref.frame))) {
            throw new Error('清理后最新完整 checkpoint 之后仍有旧增量记录，推荐版将无法安全载入。请扩大删除范围，或先用旧聊天兼容迁移版保存完整 checkpoint。');
        }
    }
    function restoreMetadataChanges(result) {
        if (!result?.metadataObject) return;
        [...(result.metadataChanges || [])].reverse().forEach(({ key, value }) => { result.metadataObject[key] = value; });
    }
    function removeStoredFramesInAiFloorRange(messages, startFloor, endFloor) {
        const range = normalizeAiFloorRange(startFloor, endFloor, messages);
        let aiFloor = 0;
        let removed = 0;
        let removedCharacters = 0;
        const changes = [];
        (Array.isArray(messages) ? messages : []).forEach(message => {
            if (!message || message.is_user) return;
            aiFloor += 1;
            if (aiFloor < range.start || aiFloor > range.end) return;
            const before = jsonByteLength(message);
            const originalValue = message[DATA_FIELD];
            const container = isolatedContainer(message);
            if (!isV2Slot(container[SLOT])) return;
            changes.push({ message, hadField: Object.prototype.hasOwnProperty.call(message, DATA_FIELD), originalValue });
            delete container[SLOT];
            writeIsolatedContainer(message, container, originalValue);
            removed += 1;
            removedCharacters += Math.max(0, before - jsonByteLength(message));
        });
        return { ...range, removed, removedCharacters, changes };
    }
    function assertFloorDeletionReplayable(messages, startFloor, endFloor) {
        const range = normalizeAiFloorRange(startFloor, endFloor, messages);
        const selected = new Set(aiFloorIndices(messages).slice(range.start - 1, range.end));
        assertFrameDeletionReplayable(messages, selected);
        return range;
    }
    async function deleteStoredFramesByAiFloor(startFloor, endFloor, saveSession = null) {
        const messages = saveSession?.chat || chat();
        if (saveSession) assertSaveSession(saveSession);
        assertFloorDeletionReplayable(messages, startFloor, endFloor);
        const result = removeStoredFramesInAiFloorRange(messages, startFloor, endFloor);
        if (!result.removed) return result;
        try {
            if (saveSession) assertSaveSession(saveSession);
            await saveChat();
            if (saveSession) assertSaveSession(saveSession);
            return result;
        } catch (error) {
            result.changes.forEach(change => {
                if (change.hadField) change.message[DATA_FIELD] = change.originalValue;
                else delete change.message[DATA_FIELD];
            });
            throw error;
        }
    }
    async function deleteAllKnownPluginData(saveSession = null) {
        const messages = saveSession?.chat || chat();
        if (saveSession) assertSaveSession(saveSession);
        const expectedChatId = saveSession?.chatId ?? currentChatId();
        const result = removeAllKnownPluginData(messages, metadata());
        if (!result.changed) return result;
        const contextObject = context();
        const metadataPatch = {};
        (result.metadataChanges || []).forEach(({ key }) => { metadataPatch[key] = undefined; });
        try {
            if (Object.keys(metadataPatch).length && typeof contextObject.updateChatMetadata === 'function') {
                await Promise.resolve(contextObject.updateChatMetadata(metadataPatch, false));
            }
            if (saveSession) assertSaveSession(saveSession);
            await saveChat();
            if (saveSession) assertSaveSession(saveSession);
            return result;
        } catch (error) {
            const stillSameChat = chat() === messages && (!expectedChatId || currentChatId() === expectedChatId);
            restoreDeletedProperties(result.changes);
            if (stillSameChat) restoreMetadataChanges(result);
            const restorePatch = {};
            (result.metadataChanges || []).forEach(({ key, value }) => { restorePatch[key] = value; });
            try {
                if (stillSameChat && Object.keys(restorePatch).length && typeof contextObject.updateChatMetadata === 'function') {
                    await Promise.resolve(contextObject.updateChatMetadata(restorePatch, false));
                }
            } catch (_) { }
            throw error;
        }
    }
    function lastAiMessage(messages) {
        for (let index = messages.length - 1; index >= 0; index--) {
            if (messages[index] && !messages[index].is_user) return { message: messages[index], index };
        }
        return null;
    }
    async function writeCheckpoint(data, reason = 'manual_visualizer', saveSession = null) {
        const messages = saveSession?.chat || chat();
        const expectedChatId = saveSession?.chatId ?? currentChatId();
        if (saveSession) assertSaveSession(saveSession);
        const target = lastAiMessage(messages);
        if (!target) throw new Error('当前聊天还没有 AI 楼层，无法按现行格式保存表格。');
        if (chat() !== messages || chat()[target.index] !== target.message || target.message.is_user
            || (expectedChatId && currentChatId() !== expectedChatId)) {
            throw new Error('保存前聊天已切换或目标楼层已变化；本次未写入，请重新打开编辑器。');
        }
        const hadField = Object.prototype.hasOwnProperty.call(target.message, DATA_FIELD);
        const originalValue = target.message[DATA_FIELD];
        const isolated = isolatedContainer(target.message);
        const aiFloor = messages.slice(0, target.index + 1)
            .reduce((count, message) => count + (message && !message.is_user ? 1 : 0), 0);
        const frame = {
            version: 2,
            headRevision: `checkpoint:${newEntryId()}`,
            checkpoint: {
                kind: 'full',
                createdAt: Date.now(),
                reason,
                data: saveSession ? data : minimalDataForWrite(data, true),
            },
            logEntries: [],
        };
        isolated[SLOT] = { storageFrame: frame, _acu_storage_version: 2 };
        target.message[DATA_FIELD] = isolated;
        try {
            if (saveSession) assertSaveSession(saveSession);
            await saveChat();
            if (saveSession) assertSaveSession(saveSession);
            return { index: target.index, aiFloor, frame };
        } catch (error) {
            if (hadField) target.message[DATA_FIELD] = originalValue;
            else delete target.message[DATA_FIELD];
            throw error;
        }
    }
    /* -------------------- 普通表格世界书同步 -------------------- */
    function normalizeWorldbookName(value) {
        if (typeof value === 'string' || typeof value === 'number') return text(value).trim();
        if (!value || typeof value !== 'object') return '';
        return text(value.name || value.bookName || value.lorebook || value.worldbook || value.id || '').trim();
    }
    function pushWorldbookNames(target, value) {
        if (Array.isArray(value)) {
            value.forEach(item => pushWorldbookNames(target, item));
            return;
        }
        const name = normalizeWorldbookName(value);
        if (name && !target.includes(name)) target.push(name);
    }
    async function boundWorldbooks() {
        const h = helper();
        const names = [];
        try {
            if (typeof h?.getCharLorebooks === 'function') {
                const value = await h.getCharLorebooks({ type: 'all' });
                if (isObject(value)) {
                    pushWorldbookNames(names, value.primary);
                    pushWorldbookNames(names, value.secondary);
                    pushWorldbookNames(names, value.additional);
                    pushWorldbookNames(names, value.lorebooks);
                } else pushWorldbookNames(names, value);
            }
        } catch (_) { /* optional API */ }
        try {
            if (typeof h?.getCurrentCharPrimaryLorebook === 'function') {
                const value = await h.getCurrentCharPrimaryLorebook();
                const name = normalizeWorldbookName(value);
                if (name && !names.includes(name)) names.unshift(name);
            }
        } catch (_) { /* optional API */ }
        return names;
    }
    async function allWorldbooks() {
        const h = helper();
        const c = context();
        const raw = rawTavern();
        const names = [];
        const readers = [
            [h, h?.getLorebooks], [h, h?.getWorldBooks], [c, c?.getWorldBooks],
            [raw, raw?.getWorldBooks], [HOST, HOST?.getWorldBooks],
        ];
        for (const [owner, reader] of readers) {
            if (typeof reader !== 'function') continue;
            try {
                const value = await reader.call(owner);
                pushWorldbookNames(names, value);
                if (names.length) break;
            } catch (_) { /* try the next host API */ }
        }
        return names;
    }
    async function loadWorldbookOptions() {
        const scopeKey = worldbookTargetScopeKey();
        const bound = await boundWorldbooks();
        const all = await allWorldbooks();
        const merged = [];
        [...bound, ...all].forEach(name => { if (name && !merged.includes(name)) merged.push(name); });
        boundWorldbookOptions = bound;
        worldbookOptions = merged;
        worldbookTarget = await readWorldbookTarget(scopeKey);
        resolvedWorldbookTarget = worldbookTarget !== 'auto' ? worldbookTarget : (bound[0] || all[0] || '');
        return worldbookOptions;
    }
    async function primaryBook() {
        const names = await boundWorldbooks();
        return names[0] || '';
    }
    async function resolveTargetBook(scopeKey = worldbookTargetScopeKey()) {
        const stored = await readWorldbookTarget(scopeKey);
        const target = stored || worldbookTarget || 'auto';
        worldbookTarget = target;
        if (target && target !== 'auto') {
            resolvedWorldbookTarget = target;
            return target;
        }
        const primary = await primaryBook();
        if (primary) {
            resolvedWorldbookTarget = primary;
            return primary;
        }
        const all = await allWorldbooks();
        resolvedWorldbookTarget = all[0] || '';
        return resolvedWorldbookTarget;
    }
    async function setWorldbookTarget(value) {
        const activeApp = app;
        const snapshot = { chat: chat(), chatId: currentChatId() };
        const scopeKey = worldbookTargetScopeKey();
        worldbookTarget = await writeWorldbookTarget(value, scopeKey);
        if (!sameChatSnapshot(snapshot)) return;
        await resolveTargetBook(scopeKey);
        if (!sameChatSnapshot(snapshot)) return;
        // 目标切换只移动世界书临时投影，不重新载入聊天模型；否则会把
        // 当前编辑页、倒序状态和尚未保存的表格改动重置掉。
        projectionGeneration += 1;
        if (activeApp) {
            await queueWorldbookSync(clone(activeApp.data), {
                isFresh: () => app === activeApp && sameChatSnapshot(snapshot),
            });
        } else {
            triggerProjectionSync();
        }
    }
    async function readBookEntries(book) {
        const h = helper();
        try {
            if (typeof h?.getLorebookEntries !== 'function') return [];
            const entries = await h.getLorebookEntries(book);
            return Array.isArray(entries) ? entries : null;
        } catch (_) { return null; }
    }
    function markdownTable(header, rows) {
        const cell = value => text(value).replace(/\|/g, '\\|').replace(/\n/g, '<br>');
        const columns = header.slice(1).map(cell);
        if (!columns.length) return '';
        const rowLine = row => `| ${columns.map((_, index) => cell(row?.[index + 1])).join(' | ')} |`;
        return [`| ${columns.join(' | ')} |`, `|${columns.map(() => '---').join('|')}|`, ...rows.map(rowLine)].join('\n');
    }
    function calendarDate(yearValue, monthValue, dayValue) {
        const year = Number(yearValue), month = Number(monthValue), day = Number(dayValue);
        if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)
            || year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;
        const stamp = Date.UTC(year, month - 1, day);
        const value = new Date(stamp);
        if (value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) return null;
        return { year, month, day, stamp, label: `${year}年${month}月${day}日` };
    }
    function dateSegment(source, startIndex, maxLength = 180) {
        const rest = text(source).slice(startIndex, startIndex + maxLength);
        const ends = [rest.indexOf('】'), rest.search(/[\r\n]/)].filter(index => index >= 0);
        return ends.length ? rest.slice(0, Math.min(...ends)) : rest;
    }
    function spanEndDate(source, firstDate, tailIndex) {
        const segment = dateSegment(source, tailIndex);
        const range = /(?:至|到|—|–|－|-|~|～)\s*(?:(\d{4})\s*年\s*)?(?:(\d{1,2})\s*月\s*)?(\d{1,2})\s*日/g;
        let best = firstDate;
        for (const match of segment.matchAll(range)) {
            const candidate = calendarDate(match[1] || firstDate.year, match[2] || firstDate.month, match[3]);
            if (candidate && candidate.stamp >= firstDate.stamp && candidate.stamp >= best.stamp) best = candidate;
        }
        return best;
    }
    function bracketStoryDate(source) {
        const value = text(source);
        const prefix = /【\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
        let latest = null;
        for (const match of value.matchAll(prefix)) {
            const first = calendarDate(match[1], match[2], match[3]);
            if (!first) continue;
            latest = spanEndDate(value, first, match.index + match[0].length);
        }
        return latest;
    }
    function storyDateFromMessage(message) {
        const value = text(message?.mes);
        if (!value) return null;
        const contentTags = [...value.matchAll(/<content(?:\s[^>]*)?>/gi)];
        if (contentTags.length) {
            const marker = contentTags[contentTags.length - 1];
            const afterContent = value.slice(marker.index + marker[0].length);
            const preferred = bracketStoryDate(afterContent);
            if (preferred) return preferred;
        }
        // 没有 content 标签或标签后的日期缺失时，只看消息开头，避免把
        // 正文中角色回忆、对白里的旧日期误当成当前剧情日期。
        return bracketStoryDate(value.slice(0, 600));
    }
    function latestStoryDate(messages = chat()) {
        const source = Array.isArray(messages) ? messages : [];
        let inspected = 0;
        let aiFloor = aiFloorCount(source);
        for (let index = source.length - 1; index >= 0 && inspected < STORY_DATE_AI_LOOKBACK; index -= 1) {
            const message = source[index];
            if (!message || message.is_user) continue;
            inspected += 1;
            const found = storyDateFromMessage(message);
            if (found) return { ...found, index, aiFloor, inspected };
            aiFloor -= 1;
        }
        return null;
    }
    function dateFromTableCell(value) {
        const source = text(value);
        const full = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
        let best = null;
        for (const match of source.matchAll(full)) {
            const first = calendarDate(match[1], match[2], match[3]);
            if (!first) continue;
            const candidate = spanEndDate(source, first, match.index + match[0].length);
            if (!best || candidate.stamp > best.stamp) best = candidate;
        }
        return best;
    }
    function relativeStoryTime(rowDate, anchorDate) {
        if (!rowDate || !anchorDate) return '';
        const days = Math.round((anchorDate.stamp - rowDate.stamp) / 86400000);
        if (days < 0) return '晚于当前剧情';
        if (days === 0) return '当天';
        if (days < 7) return `${days}天前`;
        if (days < 14) return '约1周前';
        if (days < 28) return `约${Math.round(days / 7)}周前`;
        if (days < 60) return '约1个月前';
        if (days < 335) return `约${Math.round(days / 30)}个月前`;
        if (days < 548) return '约1年前';
        return `约${Math.round(days / 365)}年前`;
    }
    function relativeProjection(config, header, rows, anchorDate) {
        if (!config.relativeTimeEnabled) return { applied: false, reason: 'disabled', header, rows };
        if (!anchorDate) return { applied: false, reason: 'no-anchor', header, rows };
        const timeColumn = header.findIndex(value => text(value).trim() === text(config.relativeTimeColumn).trim());
        if (timeColumn < 1) return { applied: false, reason: 'no-column', header, rows };
        const values = rows.map(row => relativeStoryTime(dateFromTableCell(row?.[timeColumn]), anchorDate));
        if (!values.some(Boolean)) return { applied: false, reason: 'no-row-date', header, rows };
        const insertAt = timeColumn + 1;
        return {
            applied: true,
            reason: '',
            parsedRows: values.filter(Boolean).length,
            blankRows: values.filter(value => !value).length,
            header: [...header.slice(0, insertAt), '距当前剧情', ...header.slice(insertAt)],
            rows: rows.map((row, index) => [...row.slice(0, insertAt), values[index], ...row.slice(insertAt)]),
        };
    }
    const keywordList = value => delimitedList(value);
    function resolveEntryKeys(config, header, rows) {
        const keys = [];
        keywordList(config.keywords).forEach(token => {
            const column = header.findIndex(value => text(value).trim() === token);
            if (column > 0) {
                rows.forEach(row => keys.push(...keywordList(row?.[column])));
            } else {
                keys.push(token);
            }
        });
        return [...new Set(keys)];
    }
    function placeEntry(entry, rawPlacement) {
        const config = normalizePlacement(rawPlacement);
        const output = { ...entry, position: config.position, order: config.order };
        if (config.position === 'at_depth_as_system') output.depth = config.depth;
        else delete output.depth;
        return output;
    }
    async function syncWorldbook(data, options = {}) {
        const silent = options.silent === true;
        const isFresh = typeof options.isFresh === 'function' ? options.isFresh : () => true;
        const projectionScopeKey = worldbookTargetScopeKey();
        const activeChat = currentChatId();
        const h = helper();
        // 没有稳定聊天 ID 时不能安全区分同一本世界书里的临时条目；只读不写。
        if (!activeChat) {
            const message = '聊天标识尚未就绪，暂不写入世界书临时条目。';
            if (!silent) notify(message, 'warning');
            return { ok: false, message };
        }
        if (!h || typeof h.getLorebookEntries !== 'function') {
            const message = '未检测到世界书编辑接口，已只保存表格数据。';
            if (!silent) notify(message, 'warning');
            return { ok: false, message };
        }
        const scopedPrefix = managedProjectionPrefix(projectionScopeKey);
        const activeProjection = await readActiveWorldbookProjection();
        let previousRemoved = 0;
        const removeProjection = async record => {
            if (!record?.book) return 0;
            const entries = await readBookEntries(record.book);
            if (!Array.isArray(entries)) throw new Error(`读取世界书「${record.book}」失败，已停止清理以避免误删。`);
            const prefix = managedProjectionPrefix(record.scopeKey);
            const ids = entries
                // token 是归属校验；UID ledger 只作记录/诊断，不能因宿主返回
                // 类型不同或 create 不返回 UID 而漏删本聊天自己的临时条目。
                .filter(entry => text(entry?.comment).startsWith(prefix))
                .map(entry => entry.uid).filter(value => value !== undefined);
            if (!ids.length) return 0;
            if (typeof h.deleteLorebookEntries !== 'function') throw new Error('宿主缺少世界书条目删除接口');
            await h.deleteLorebookEntries(record.book, ids);
            return ids.length;
        };
        const book = await resolveTargetBook(projectionScopeKey);
        if (!isFresh()) return { ok: false, stale: true };
        // 世界书是“当前聊天”的临时投影：切换聊天/目标书时，只删除上一条
        // 全局 active projection 的 UID 或带有其聊天 token 的注释，不再通配
        // 同一本书里其它聊天的旧前缀条目。
        if (activeProjection && (activeProjection.scopeKey !== projectionScopeKey || activeProjection.book !== book)) {
            try { previousRemoved = await removeProjection(activeProjection); }
            catch (error) {
                if (!silent) notify(error.message || text(error), 'warning');
                else console.warn('[数据库] 上一聊天世界书投影未清理：', error);
                return { ok: false, message: error.message || text(error) };
            }
            await writeActiveWorldbookProjection(null);
        }
        if (!book) {
            const message = '当前角色没有可用世界书，已清理上一聊天的临时投影。';
            if (!silent) notify(message, 'warning');
            return { ok: false, message };
        }
        const existing = await readBookEntries(book);
        if (!isFresh()) return { ok: false, stale: true };
        if (!Array.isArray(existing)) {
            const message = '读取当前世界书失败，暂不同步临时条目。';
            if (!silent) notify(message, 'warning');
            return { ok: false, message };
        }
        const managed = existing.filter(entry => text(entry?.comment).startsWith(scopedPrefix));
        const candidates = [];
        const storyDate = latestStoryDate(chat());
        const relativeTime = {
            enabledTables: 0,
            appliedTables: 0,
            parsedRows: 0,
            blankRows: 0,
            skipped: [],
            anchor: storyDate,
        };
        const addCandidate = (identity, name, content, keys, placementConfig, type, preventRecursion) => {
            const entryType = type === 'keyword' ? 'keyword' : 'constant';
            const entryKeys = entryType === 'keyword' ? [...new Set(keys || [])] : [];
            if (entryType === 'keyword' && !entryKeys.length) return;
            candidates.push({ identity, name, content, keys: entryKeys, placementConfig, type: entryType, preventRecursion });
        };
        orderedKeys(data).forEach(key => {
            const sheet = data[key];
            const config = normalizeExport(sheet.exportConfig, sheet.name);
            if (!config.enabled) return;
            const header = sheet.content?.[0] || [];
            const rows = (sheet.content || []).slice(1)
                .filter(row => Array.isArray(row) && row.slice(1).some(value => text(value).trim()));
            if (!rows.length) return;
            const name = config.entryName || sheet.name || key;
            const identity = text(sheet.uid || key);
            const projected = relativeProjection(config, header, rows, storyDate);
            if (config.relativeTimeEnabled) {
                relativeTime.enabledTables += 1;
                if (projected.applied) {
                    relativeTime.appliedTables += 1;
                    relativeTime.parsedRows += projected.parsedRows;
                    relativeTime.blankRows += projected.blankRows;
                } else {
                    relativeTime.skipped.push({ key, name: sheet.name || key, reason: projected.reason });
                }
            }
            const projectedRows = new Map(rows.map((row, index) => [row, projected.rows[index]]));
            const render = selectedRows => {
                const outputRows = projected.applied
                    ? selectedRows.map(row => projectedRows.get(row) || row)
                    : selectedRows;
                const table = markdownTable(projected.header, outputRows);
                return config.injectionTemplate
                    ? config.injectionTemplate.replace('$1', table)
                    : `# ${name}\n\n${table}`;
            };
            if (config.splitByRow) {
                rows.forEach((row, index) => addCandidate(
                    `${identity}:row:${text(row?.[0]) || index + 1}:${index}`,
                    `${name}-${index + 1}`,
                    render([row]),
                    resolveEntryKeys(config, header, [row]),
                    config.entryPlacement,
                    config.entryType,
                    config.preventRecursion,
                ));
            } else {
                addCandidate(`${identity}:main`, name, render(rows), resolveEntryKeys(config, header, rows), config.entryPlacement, config.entryType, config.preventRecursion);
            }
            if (config.extraIndexEnabled && config.extraIndexColumns.length) {
                const selected = config.extraIndexColumns
                    .map(column => header.findIndex(value => text(value).trim() === column))
                    .filter((index, position, indexes) => index > 0 && indexes.indexOf(index) === position);
                if (selected.length) {
                    const indexHeader = [header[0], ...selected.map(index => header[index])];
                    const indexRows = rows.map(row => [row[0], ...selected.map(index => row[index])]);
                    const indexTable = markdownTable(indexHeader, indexRows);
                    const indexName = config.extraIndexEntryName || `${name}-索引`;
                    const content = config.extraIndexInjectionTemplate
                        ? config.extraIndexInjectionTemplate.replace('$1', indexTable)
                        : `# ${indexName}\n\n${indexTable}`;
                    addCandidate(`${identity}:extra`, indexName, content, [], config.extraIndexPlacement, 'constant', config.preventRecursion);
                }
            }
        });
        const nameCounts = new Map();
        candidates.forEach(candidate => nameCounts.set(candidate.name, (nameCounts.get(candidate.name) || 0) + 1));
        const desired = candidates.map(candidate => placeEntry({
            // 单个旧式名称保持不变；只有同名候选才追加稳定 token，避免同名表、
            // 拆分行或索引条目互相覆盖。
            comment: `${scopedPrefix}${candidate.name}${nameCounts.get(candidate.name) > 1 ? `-${projectionScopeToken(candidate.identity)}` : ''}`,
            content: candidate.content,
            keys: candidate.keys,
            enabled: true,
            type: candidate.type,
            prevent_recursion: candidate.preventRecursion,
        }, candidate.placementConfig));
        const byComment = new Map();
        managed.forEach(entry => {
            const comment = text(entry.comment);
            if (!byComment.has(comment)) byComment.set(comment, []);
            byComment.get(comment).push(entry);
        });
        const updates = [];
        const creates = [];
        desired.forEach(next => {
            const matches = byComment.get(next.comment);
            const old = matches?.shift();
            if (old?.uid !== undefined) updates.push({ ...next, uid: old.uid });
            else creates.push(next);
        });
        const staleIds = [...byComment.values()].flat()
            .map(entry => entry.uid).filter(value => value !== undefined);
        const rememberCurrentProjection = async () => {
            try {
                await writeActiveWorldbookProjection({ scopeKey: projectionScopeKey, book });
            } catch (error) { console.warn('[数据库] 记录世界书投影位置失败：', error); }
        };
        try {
            if (!isFresh()) return { ok: false, stale: true };
            if (updates.length) {
                if (typeof h.setLorebookEntries !== 'function') throw new Error('宿主缺少世界书条目更新接口');
                await h.setLorebookEntries(book, updates);
                await rememberCurrentProjection();
            }
            if (!isFresh()) return { ok: false, stale: true };
            if (creates.length) {
                if (typeof h.createLorebookEntries !== 'function') throw new Error('宿主缺少世界书条目新增接口');
                await h.createLorebookEntries(book, creates);
                await rememberCurrentProjection();
            }
            if (!isFresh()) return { ok: false, stale: true };
            if (staleIds.length) {
                if (typeof h.deleteLorebookEntries !== 'function') throw new Error('宿主缺少世界书条目删除接口');
                await h.deleteLorebookEntries(book, staleIds);
                await rememberCurrentProjection();
            }
            if (!isFresh()) return { ok: false, stale: true };
            if (desired.length) await rememberCurrentProjection();
            else await writeActiveWorldbookProjection(null);
            if (!silent) {
                let relativeMessage = '';
                let tone = 'success';
                if (relativeTime.enabledTables && !storyDate) {
                    relativeMessage = ` 最新 AI 楼层及前 ${STORY_DATE_AI_LOOKBACK - 1} 层没有识别到“【2025年9月19日”格式，相对时间未生成。`;
                    tone = 'warning';
                } else if (relativeTime.enabledTables) {
                    relativeMessage = ` 剧情日期：${storyDate.label}（AI 第 ${storyDate.aiFloor} 层）；相对时间已用于 ${relativeTime.appliedTables}/${relativeTime.enabledTables} 张表。`;
                    if (relativeTime.appliedTables < relativeTime.enabledTables) tone = 'warning';
                }
                notify(`世界书已同步：更新 ${updates.length} 条，新增 ${creates.length} 条，清理旧条目 ${staleIds.length + previousRemoved} 条。${relativeMessage}`, tone);
            }
            return { ok: true, updated: updates.length, created: creates.length, removed: staleIds.length + previousRemoved, relativeTime };
        } catch (error) {
            if (!silent) notify(`世界书同步失败：${error?.message || error}`, 'error');
            else console.warn('[数据库] 自动同步世界书失败：', error);
            return { ok: false, message: error?.message || text(error) };
        }
    }

    /* -------------------- 编辑器模型与保存 -------------------- */
    let app = null;
    let settingsReady = false;
    let uiAccentThemeReady = false;
    let uiAccentTheme = 'blue';
    let listenerAttached = false;
    let saveInProgress = false;
    let pendingChatReload = false;
    let projectionGeneration = 0;
    let initialProjectionDone = false;
    let projectionRunning = false;
    let projectionRequested = false;
    let worldbookQueue = Promise.resolve();
    let scrollLockSnapshot = null;
    let viewportListenerAttached = false;

    function lockHostScroll() {
        const document = doc();
        if (!document?.body || scrollLockSnapshot) return;
        const html = document.documentElement;
        scrollLockSnapshot = {
            bodyOverflow: document.body.style.overflow,
            htmlOverflow: html?.style.overflow || '',
        };
        document.body.style.overflow = 'hidden';
        if (html) html.style.overflow = 'hidden';
    }
    function unlockHostScroll() {
        const document = doc();
        if (!document?.body || !scrollLockSnapshot) return;
        document.body.style.overflow = scrollLockSnapshot.bodyOverflow;
        if (document.documentElement) document.documentElement.style.overflow = scrollLockSnapshot.htmlOverflow;
        scrollLockSnapshot = null;
    }
    function viewportWidth() {
        const candidates = [
            HOST.visualViewport?.width,
            HOST.innerWidth,
            HOST.document?.documentElement?.clientWidth,
            HOST.screen?.width,
        ].map(Number).filter(value => Number.isFinite(value) && value > 0);
        return candidates.length ? Math.min(...candidates) : 1024;
    }
    function markViewport(root) {
        if (!root) return;
        const width = viewportWidth();
        root.dataset.layout = width <= 720 ? 'mobile' : (width <= 980 ? 'tablet' : 'desktop');
        if (viewportListenerAttached) return;
        viewportListenerAttached = true;
        const refresh = () => {
            const current = doc().getElementById(ROOT_ID);
            if (current) markViewport(current);
        };
        try { HOST.addEventListener?.('resize', refresh, { passive: true }); } catch (_) { /* optional */ }
        try { HOST.visualViewport?.addEventListener?.('resize', refresh, { passive: true }); } catch (_) { /* optional */ }
    }

    function queueWorldbookSync(data, options = {}) {
        const task = worldbookQueue
            .catch(() => {})
            .then(() => syncWorldbook(data, options));
        worldbookQueue = task.catch(() => {});
        return task;
    }
    function createSaveSession() {
        if (!app) throw new Error('编辑器尚未载入。');
        return {
            app,
            chat: chat(),
            chatId: currentChatId(),
            data: minimalDataForWrite(app.data, true),
        };
    }
    function assertSaveSession(session) {
        const sameId = !session.chatId || currentChatId() === session.chatId;
        if (app !== session.app || chat() !== session.chat || !sameId) {
            throw new Error('保存期间聊天已切换；已停止后续写入，请在新聊天中重新打开编辑器。');
        }
    }
    async function runSave(task) {
        if (saveInProgress) throw new Error('正在保存，请稍候。');
        const session = createSaveSession();
        saveInProgress = true;
        const root = doc().getElementById(ROOT_ID);
        if (root) { root.style.pointerEvents = 'none'; root.setAttribute('aria-busy', 'true'); }
        try { return await task(session); }
        finally {
            saveInProgress = false;
            const currentRoot = doc().getElementById(ROOT_ID);
            if (currentRoot) { currentRoot.style.pointerEvents = ''; currentRoot.removeAttribute('aria-busy'); }
            if (pendingChatReload) {
                pendingChatReload = false;
                triggerProjectionSync();
            }
        }
    }
    async function resolveModel() {
        if (!settingsReady) { await initSettings(); settingsReady = true; }
        if (!uiAccentThemeReady) {
            uiAccentTheme = normalizeUiAccentTheme(await settingGet(UI_ACCENT_THEME_KEY));
            uiAccentThemeReady = true;
        }
        const guide = currentGuide();
        const messages = chat();
        const refs = getFrameRefs(messages);
        const restored = restoreLatestCheckpoint(messages, guide, refs);
        if (refs.length && !restored) {
            throw new Error('当前聊天存在 V2 数据，但没有可读取的完整 checkpoint。为避免覆盖旧数据，推荐版已停止载入。');
        }
        const source = restored || currentScopedTemplate() || guide;
        return { data: removeBuiltinSheets(source, !!restored) };
    }
    function createAppModel(resolved) {
        const data = resolved.data;
        return {
            data,
            active: orderedKeys(data)[0] || null,
            mode: 'data',
            dirtyData: false,
            dirtyTemplate: false,
            page: 0,
            reverseRows: false,
        };
    }
    async function loadModel() {
        const snapshot = { chat: chat(), chatId: currentChatId() };
        const resolved = await resolveModel();
        if (!sameChatSnapshot(snapshot)) {
            throw new Error('载入编辑器期间聊天已切换，请重新打开当前聊天的编辑器。');
        }
        app = createAppModel(resolved);
        return app;
    }
    function sameChatSnapshot(snapshot) {
        return chat() === snapshot.chat && (!snapshot.chatId || currentChatId() === snapshot.chatId);
    }
    async function syncCurrentChatProjection() {
        const generation = ++projectionGeneration;
        const snapshot = { chat: chat(), chatId: currentChatId() };
        const isFresh = () => generation === projectionGeneration && sameChatSnapshot(snapshot);
        let resolved;
        try {
            resolved = await resolveModel();
        } catch (error) {
            // 世界书只是当前聊天的临时投影；不能安全还原当前聊天时，也不能继续注入上一聊天的数据。
            if (isFresh() && doc().getElementById(ROOT_ID)) closeApp();
            if (isFresh()) await queueWorldbookSync({}, { silent: true, isFresh });
            throw error;
        }
        if (!isFresh()) return;
        if (doc().getElementById(ROOT_ID)) {
            app = createAppModel(resolved);
            render();
        }
        await queueWorldbookSync(resolved.data, { silent: true, isFresh });
    }
    function triggerProjectionSync() {
        // 世界书 API 是异步的；串行化并合并投影请求，确保旧聊天的 in-flight 写入
        // 完成后，新聊天只再执行一次完整投影，不会出现 A/B 两次同步乱序覆盖或积压。
        projectionRequested = true;
        if (projectionRunning) return;
        projectionRunning = true;
        void (async () => {
            try {
                while (projectionRequested) {
                    projectionRequested = false;
                    try { await syncCurrentChatProjection(); }
                    catch (error) { console.warn('[数据库] 聊天世界书投影失败：', error); }
                }
            } finally {
                projectionRunning = false;
                if (projectionRequested) triggerProjectionSync();
            }
        })();
    }
    function scheduleInitialProjection(attempt = 0) {
        attachChatListener();
        const h = helper();
        if (!initialProjectionDone && typeof h?.getLorebookEntries === 'function') {
            initialProjectionDone = true;
            triggerProjectionSync();
        }
        if ((!listenerAttached || !initialProjectionDone) && attempt < 60) {
            setTimeout(() => scheduleInitialProjection(attempt + 1), 1000);
        }
    }
    function modelStatus() {
        const info = checkpointInfo(chat());
        const rows = orderedKeys(app.data).reduce((total, key) => total + Math.max(0, (app.data[key].content?.length || 1) - 1), 0);
        return { ...info, rows, tables: orderedKeys(app.data).length };
    }
    function writeCurrentTemplateFields(template) {
        const guideData = template;
        const oldGuide = readField(GUIDE_FIELD);
        const guideContainer = { version: 2, tags: {} };
        if (isObject(oldGuide?.tags)) Object.entries(oldGuide.tags).forEach(([slot, value]) => {
            if (slot !== SLOT) guideContainer.tags[slot] = clone(value);
        });
        guideContainer.tags[SLOT] = {
            data: guideData,
            updatedAt: Date.now(),
            reason: 'minimal_editor',
            templateScopeMode: 'chat_override',
        };
        writeField(GUIDE_FIELD, guideContainer);

        const oldScope = readField(SCOPE_FIELD);
        const scopeContainer = { version: 1, template: {} };
        if (isObject(oldScope?.template)) Object.entries(oldScope.template).forEach(([slot, value]) => {
            if (slot !== SLOT) scopeContainer.template[slot] = clone(value);
        });
        scopeContainer.template[SLOT] = {
            mode: 'chat_override',
            isolationKey: SLOT,
            templateStr: JSON.stringify(guideData),
            guideData,
            updatedAt: Date.now(),
            source: 'minimal_editor',
            reason: 'minimal_editor',
        };
        writeField(SCOPE_FIELD, scopeContainer);
        // 现行 Guide + Scope 已写好后，旧 TableHeaderGuide 只会造成重复体积。
        writeField(LEGACY_TEMPLATE_FIELD, {});
    }
    async function saveTemplate(session = null) {
        const targetApp = session?.app || app;
        if (session) assertSaveSession(session);
        const value = templateFromData(session?.data || targetApp.data);
        const snapshot = snapshotTemplateFields();
        try {
            writeCurrentTemplateFields(value);
            await saveChat();
        } catch (error) {
            restoreTemplateFields(snapshot);
            throw error;
        }
        if (session) assertSaveSession(session);
        // 结构/世界书设置在点击保存后立即刷新当前聊天的临时投影。
        const projection = await queueWorldbookSync(session?.data || targetApp.data, {
            silent: true,
            isFresh: session
                ? () => app === session.app && chat() === session.chat
                    && (!session.chatId || currentChatId() === session.chatId)
                : undefined,
        });
        if (session) assertSaveSession(session);
        targetApp.dirtyTemplate = false;
        const relative = projection?.relativeTime;
        const relativeMessage = relative?.enabledTables
            ? relative.anchor
                ? ` 剧情日期：${relative.anchor.label}（AI 第 ${relative.anchor.aiFloor} 层）；相对时间已用于 ${relative.appliedTables}/${relative.enabledTables} 张表。`
                : ` 最新 AI 楼层及前 ${STORY_DATE_AI_LOOKBACK - 1} 层没有识别到“【2025年9月19日”格式，相对时间未生成。`
            : '';
        const projectionFailed = projection?.ok === false && !projection.stale;
        const relativeIncomplete = relative?.enabledTables && relative.appliedTables < relative.enabledTables;
        notify(projectionFailed
            ? `模板已保存，但世界书未同步：${projection.message || '接口不可用'}`
            : `已保存到当前聊天模板并同步世界书。${relativeMessage}`, projectionFailed || relativeIncomplete ? 'warning' : 'success');
    }
    async function saveData(session = null) {
        const activeSession = session || createSaveSession();
        assertSaveSession(activeSession);
        if (!lastAiMessage(activeSession.chat)) throw new Error('当前聊天还没有 AI 楼层，无法保存表格。');
        // 每次手动保存都对白名单重写当前槽：既保留其它标签槽，又顺手物理
        // 移除旧 plot/templateArchives、SQL/自动填表配置与 TableHeaderGuide。
        const value = templateFromData(activeSession.data);
        const snapshot = snapshotTemplateFields();
        let result;
        try {
            writeCurrentTemplateFields(value);
            result = await writeCheckpoint(activeSession.data, 'manual_visualizer', activeSession);
        } catch (error) {
            restoreTemplateFields(snapshot);
            throw error;
        }
        activeSession.app.dirtyData = false;
        activeSession.app.dirtyTemplate = false;
        notify(`表格数据已保存到 AI 第 ${result.aiFloor} 层（消息 #${result.index}）。`, 'success');
    }
    async function saveAll(session) {
        await saveData(session);
        assertSaveSession(session);
        await queueWorldbookSync(session.data, {
            isFresh: () => app === session.app && chat() === session.chat
                && (!session.chatId || currentChatId() === session.chatId),
        });
        assertSaveSession(session);
        render();
    }

    /* -------------------- 单一奶油风界面 -------------------- */
    const CSS = `
#${ROOT_ID}{--canvas:#fbf8f1;--paper:#fffdf8;--paper-warm:#fffaf2;--paper2:#f4ede2;--line:#ddd2c1;--line-soft:#ebe3d6;--ink:#403a32;--muted:#81786b;--accent:#3978a8;--accent-soft:#eaf2f8;--accent-border:#a9c6da;--accent-ink:#2e638b;--accent-ring:rgba(57,120,168,.22);--danger:#b4625c;position:fixed;top:0;right:0;bottom:0;left:0;inset:0;width:100vw;height:100vh;height:100dvh;z-index:2147483000;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--ink);font-size:13px;line-height:1.4;touch-action:manipulation}
#${ROOT_ID}[data-accent="green"]{--accent:#4f8068;--accent-soft:#e8f1e9;--accent-border:#b6c9ba;--accent-ink:#3d6e58;--accent-ring:rgba(79,128,104,.2)}
#${ROOT_ID} *{box-sizing:border-box}#${ROOT_ID} button,#${ROOT_ID} input,#${ROOT_ID} select,#${ROOT_ID} textarea{font:inherit}#${ROOT_ID} .mask{position:absolute;top:0;right:0;bottom:0;left:0;inset:0;background:rgba(57,51,43,.38);backdrop-filter:blur(1.5px);display:flex;align-items:center;justify-content:center;padding:clamp(12px,2.5vw,28px)}#${ROOT_ID} .open-loading{min-width:180px;padding:18px 22px;border:1px solid var(--line);border-radius:5px;background:var(--paper);box-shadow:0 16px 42px rgba(57,46,34,.18);color:var(--muted);font-weight:600;text-align:center}
#${ROOT_ID} .win{width:min(1120px,100%);height:min(760px,calc(100vh - 24px));height:min(760px,calc(100dvh - 24px));min-height:0;background:var(--canvas);border:1px solid var(--line);border-radius:5px;box-shadow:0 18px 52px rgba(57,46,34,.2);display:flex;flex-direction:column;overflow:hidden;overscroll-behavior:contain}
#${ROOT_ID} .head{height:49px;display:flex;align-items:center;gap:9px;padding:0 15px;background:var(--paper);border-bottom:1px solid var(--line);flex:none}.head h1{font-size:17px;margin:0;font-weight:700;letter-spacing:.01em}.head .sub{color:var(--muted);font-size:12px}.head .chat-id{max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.spacer{flex:1}.iconbtn{border:1px solid transparent;background:transparent;color:var(--muted);font-size:22px;line-height:1;cursor:pointer;padding:3px 7px;border-radius:4px;min-width:32px;min-height:32px}.iconbtn:hover{background:var(--paper2);border-color:var(--line);color:var(--ink)}.theme-toggle{display:flex;align-items:center;justify-content:center;color:var(--accent)}.theme-toggle:hover{color:var(--accent)}.theme-toggle svg{display:block;width:22px;height:22px}
#${ROOT_ID} .body{min-height:0;flex:1;display:grid;grid-template-columns:212px minmax(0,1fr)}.side{min-width:0;min-height:0;background:var(--paper2);border-right:1px solid var(--line);padding:11px 9px;display:flex;flex-direction:column;align-items:stretch;gap:7px;overflow:hidden}.side-title{flex:0 0 auto;font-weight:700;font-size:12px;color:var(--muted);padding:3px 4px;white-space:nowrap}#acu-sheet-list{display:flex;flex-direction:column;align-items:stretch;gap:4px;overflow-x:hidden;overflow-y:auto;min-height:0;flex:1;scrollbar-width:thin;-webkit-overflow-scrolling:touch}.sheet{display:flex;align-items:center;gap:5px;width:100%;padding:7px 8px;border:1px solid transparent;border-radius:4px;cursor:pointer;min-height:34px;background:transparent}.sheet:hover{background:rgba(255,253,248,.75);border-color:var(--line)}.sheet.active{background:var(--accent-soft);border-color:var(--accent-border);color:var(--accent-ink);font-weight:700}.sheet-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;flex:1}.sheet-order{display:flex;gap:2px;opacity:.12}.sheet:hover .sheet-order,.sheet:focus-within .sheet-order{opacity:.9}.sheet-order .minibtn{padding:2px 5px;min-height:24px}.minibtn{border:1px solid var(--line);background:var(--paper);color:var(--ink);border-radius:4px;padding:6px 9px;min-height:32px;cursor:pointer;transition:border-color .12s,color .12s,background .12s}.minibtn:hover{border-color:var(--accent);color:var(--accent);background:var(--accent-soft)}.minibtn:disabled{opacity:.45;cursor:not-allowed}.minibtn.danger:hover{border-color:var(--danger);color:var(--danger);background:#fff7f5}.side-actions{display:grid;grid-template-columns:1fr 1fr;flex:0 0 auto;gap:5px;margin-top:auto}.side-actions button{font-size:12px;white-space:nowrap;padding-left:5px;padding-right:5px}
#${ROOT_ID} .main{min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden}.tabs{display:flex;gap:0;padding:0 13px;background:var(--paper);border-bottom:1px solid var(--line);flex:none;overflow-x:auto;white-space:nowrap;scrollbar-width:thin;-webkit-overflow-scrolling:touch}.tab{border:0;border-bottom:3px solid transparent;background:transparent;color:var(--muted);padding:0 21px;height:45px;cursor:pointer;font-size:13px;flex:0 0 auto}.tab:hover{color:var(--accent);background:var(--accent-soft)}.tab.active{color:var(--accent);font-weight:700;border-bottom-color:var(--accent)}.content{padding:13px 15px;overflow:auto;flex:1;min-height:0;background:var(--canvas);-webkit-overflow-scrolling:touch}.content.data-content{display:flex;flex-direction:column;overflow:hidden}.data-content .toolbar{flex:none}.toolbar{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:9px}.toolbar .grow,.foot .grow{flex:1}.toolbar strong{font-size:15px}.btn{border:1px solid var(--accent);background:var(--accent);color:#fff;border-radius:4px;padding:7px 11px;min-height:34px;cursor:pointer;font-size:13px;transition:filter .12s,background .12s,border-color .12s}.btn:hover{filter:brightness(.96)}.btn.secondary{border-color:var(--line);background:var(--paper);color:var(--ink)}.btn.secondary:hover{border-color:var(--accent);color:var(--accent);background:var(--accent-soft)}.btn.warn{border-color:var(--danger);background:transparent;color:var(--danger)}
#${ROOT_ID} .card{background:var(--paper);border:1px solid var(--line);border-radius:5px;padding:13px;margin-bottom:9px}.card h2{margin:0 0 9px;font-size:14px}.card h3{margin:0 0 3px;font-size:13px}.hint{font-size:12px;color:var(--muted);line-height:1.5}.grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.form-grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:10px 12px;align-items:start}.form-grid .col-4{grid-column:span 4}.form-grid .col-6{grid-column:span 6}.form-grid .col-8{grid-column:span 8}.form-grid .wide{grid-column:1/-1}.field{display:flex;flex-direction:column;gap:4px;min-width:0}.field label,.field>span{font-size:12px;color:var(--muted)}.field-note{font-size:11px!important;line-height:1.45}.field input,.field select,.field textarea,.column-row input{width:100%;border:1px solid var(--line);background:var(--paper-warm);color:var(--ink);border-radius:4px;padding:7px 9px;min-height:34px}.field input:focus,.field select:focus,.field textarea:focus,.column-row input:focus{outline:2px solid var(--accent-ring);outline-offset:0;border-color:var(--accent)}.field input:disabled,.field select:disabled,.field textarea:disabled{background:#f2eee7;color:#aaa196;cursor:not-allowed}.field textarea{min-height:82px;resize:vertical}.check{display:flex;align-items:center;gap:6px;min-height:32px}.check input{width:auto;accent-color:var(--accent)}.strong-check{font-weight:700;color:var(--accent);white-space:nowrap}.section-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:10px}.section-head>.check{flex:0 0 auto;white-space:nowrap}.section-head h2{margin-bottom:3px}.section-head.compact{margin-bottom:10px}.option-strip{display:flex;align-items:center;gap:18px;flex-wrap:wrap;margin-bottom:12px;padding:7px 10px;border:1px solid var(--line-soft);border-radius:4px;background:var(--paper2)}.subpanel{margin-top:14px;padding-top:13px;border-top:1px solid var(--line)}.target-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:8px;margin-bottom:7px}.placement-grid{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(88px,.75fr) minmax(88px,.75fr);gap:8px}.columns{display:flex;flex-direction:column;gap:6px}.column-row{display:flex;gap:7px;align-items:center}.column-row input{flex:1;min-width:0}.column-row .index{width:24px;color:var(--muted);text-align:center;font-size:12px}
#${ROOT_ID} .empty{padding:32px;text-align:center;color:var(--muted)}
#${ROOT_ID} .record-list{display:flex;flex-direction:column;gap:9px;overflow:auto;min-height:0;flex:1;padding-right:2px;scrollbar-width:thin;-webkit-overflow-scrolling:touch}.record-card{overflow:hidden;flex:none;border:1px solid var(--line);border-radius:5px;background:var(--paper-warm)}.record-head{display:flex;align-items:center;gap:10px;min-height:38px;padding:6px 10px;border-bottom:1px solid var(--line-soft);background:var(--paper2)}.record-number{color:var(--accent-ink);font-family:ui-monospace,Consolas,monospace;font-size:12px;font-weight:700;white-space:nowrap}.record-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:700}.record-head .record-delete{margin-left:auto;padding:4px 8px;min-height:28px;font-size:11px}.record-fields{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0 10px;padding:3px 10px 10px}.record-field{min-width:0;padding:9px 8px;border-top:1px solid var(--line-soft)}.record-field.short{grid-column:span 1}.record-field.medium{grid-column:span 2}.record-field.long{grid-column:1/-1}.record-label{display:block;margin-bottom:4px;color:var(--muted);font-size:11px;font-weight:600}.record-value{min-height:22px;outline:none;font-size:13px;line-height:1.55;overflow-wrap:anywhere;white-space:pre-wrap}.record-value:focus{background:var(--accent-soft);box-shadow:0 0 0 1px var(--accent);border-radius:3px}.add-row-compact{padding:4px 7px;min-height:28px;font-size:11px}
#${ROOT_ID} .record-name{outline:none}.record-name:empty::before{content:attr(data-placeholder);color:var(--muted);font-weight:400}.record-name:focus{background:var(--accent-soft);box-shadow:0 0 0 1px var(--accent);border-radius:3px}
#${ROOT_ID} .status-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.stat{padding:10px;border:1px solid var(--line-soft);border-radius:4px;background:var(--paper2)}.stat b{display:block;font-size:12px;color:var(--muted);font-weight:600;margin-bottom:3px}.full-checkpoint-stat{grid-column:1/-1}.full-checkpoint-stat span{display:block;max-height:132px;line-height:1.55;overflow:auto;overflow-wrap:anywhere}.code{font-family:ui-monospace,Consolas,monospace;font-size:12px;white-space:pre-wrap;word-break:break-word;background:var(--paper2);padding:10px;border:1px solid var(--line-soft);border-radius:4px;max-height:260px;overflow:auto}
#${ROOT_ID} .foot{display:flex;align-items:center;gap:7px;padding:8px 13px calc(8px + env(safe-area-inset-bottom,0px));background:var(--paper);border-top:1px solid var(--line);flex:none}.dirty{color:#987044;font-size:12px}.file{display:none}#${ROOT_ID} button,#${ROOT_ID} select,#${ROOT_ID} input,#${ROOT_ID} textarea{touch-action:manipulation}
#${ROOT_ID} #acu-sheet-list,#${ROOT_ID} .content,#${ROOT_ID} .record-list{min-width:0}
@media(max-width:900px) and (min-width:721px){#${ROOT_ID} .body{grid-template-columns:184px minmax(0,1fr)}#${ROOT_ID} .side{padding:9px 7px}#${ROOT_ID} .side-actions{grid-template-columns:1fr}#${ROOT_ID} .tab{padding-left:15px;padding-right:15px}#${ROOT_ID} .content{padding:12px}}
@media(max-width:720px){#${ROOT_ID} .mask{padding:0;align-items:stretch}#${ROOT_ID} .win{width:100%;max-width:none;height:100vh;height:100dvh;max-height:none;border-radius:0;border-left:0;border-right:0}#${ROOT_ID} .head{height:46px;padding:0 10px;gap:7px}#${ROOT_ID} .head h1{font-size:15px}#${ROOT_ID} .head .sub{font-size:11px}#${ROOT_ID} .head .chat-id{max-width:150px}#${ROOT_ID} .iconbtn{min-width:36px;min-height:36px}#${ROOT_ID} .body{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr)}#${ROOT_ID} .side{width:100%;height:auto;min-height:46px;max-height:94px;padding:5px 8px;gap:6px;display:flex;flex-direction:row;align-items:center;border-right:0;border-bottom:1px solid var(--line);overflow:hidden}#${ROOT_ID} #acu-sheet-list{flex-direction:row;align-items:center;overflow-x:auto;overflow-y:hidden}#${ROOT_ID} .sheet{width:auto;flex:0 0 auto;min-height:36px;padding:7px 9px}#${ROOT_ID} .sheet-name{max-width:180px}#${ROOT_ID} .sheet-order{opacity:.55}#${ROOT_ID} .sheet-order .minibtn{min-height:28px;padding:3px 6px}#${ROOT_ID} .side-title{font-size:11px;padding:3px 1px;max-width:88px;overflow:hidden;text-overflow:ellipsis}#${ROOT_ID} .side-actions{display:flex;gap:3px;margin:0}#${ROOT_ID} .side-actions button{font-size:11px;min-height:34px;padding:6px 7px}#${ROOT_ID} .tabs{padding:0 6px}#${ROOT_ID} .tab{height:42px;padding:0 14px;font-size:12px}#${ROOT_ID} .content{padding:10px;overflow:auto}#${ROOT_ID} .content.data-content{overflow:hidden}#${ROOT_ID} .toolbar{gap:6px;margin-bottom:8px}#${ROOT_ID} .toolbar strong{font-size:14px}#${ROOT_ID} .btn,#${ROOT_ID} .minibtn{min-height:36px}#${ROOT_ID} .add-row-compact{min-height:28px;padding:4px 7px;font-size:11px}#${ROOT_ID} .card{padding:11px;margin-bottom:8px}#${ROOT_ID} .grid2,#${ROOT_ID} .status-list{grid-template-columns:1fr}#${ROOT_ID} .form-grid .col-4,#${ROOT_ID} .form-grid .col-6,#${ROOT_ID} .form-grid .col-8{grid-column:1/-1}#${ROOT_ID} .field input,#${ROOT_ID} .field select,#${ROOT_ID} .field textarea,#${ROOT_ID} .column-row input{min-height:36px;padding:8px 9px}#${ROOT_ID} .record-fields{grid-template-columns:repeat(2,minmax(0,1fr));gap:0 7px;padding:3px 7px 8px}#${ROOT_ID} .record-field.short{grid-column:span 1}#${ROOT_ID} .record-field.medium,#${ROOT_ID} .record-field.long{grid-column:1/-1}#${ROOT_ID} .record-head{gap:8px;padding:6px 8px}#${ROOT_ID} .record-name{font-size:12px}#${ROOT_ID} .foot{padding:7px 10px calc(7px + env(safe-area-inset-bottom,0px));flex-wrap:wrap}#${ROOT_ID} .foot .grow{display:none}#${ROOT_ID} .foot .dirty{order:2;width:100%}#${ROOT_ID} .foot .btn{order:1;width:100%}}
#${ROOT_ID}[data-layout="mobile"] .mask{padding:0;align-items:stretch}#${ROOT_ID}[data-layout="mobile"] .win{width:100%;max-width:none;height:100vh;height:100dvh;max-height:none;border-radius:0;border-left:0;border-right:0}#${ROOT_ID}[data-layout="mobile"] .body{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr)}#${ROOT_ID}[data-layout="mobile"] .side{width:100%;height:auto;min-height:46px;max-height:94px;padding:5px 8px;display:flex;flex-direction:row;border-right:0;border-bottom:1px solid var(--line)}#${ROOT_ID}[data-layout="mobile"] #acu-sheet-list{flex-direction:row;overflow-x:auto;overflow-y:hidden}#${ROOT_ID}[data-layout="mobile"] .sheet{width:auto;flex:0 0 auto}#${ROOT_ID}[data-layout="mobile"] .side-actions{display:flex;margin:0}#${ROOT_ID}[data-layout="mobile"] .tabs{overflow-x:auto;white-space:nowrap;padding-left:6px;padding-right:6px}#${ROOT_ID}[data-layout="mobile"] .content{padding:10px}#${ROOT_ID}[data-layout="mobile"] .foot{padding-bottom:calc(7px + env(safe-area-inset-bottom,0px))}
#${ROOT_ID}[data-layout="mobile"] .form-grid .col-4,#${ROOT_ID}[data-layout="mobile"] .form-grid .col-6,#${ROOT_ID}[data-layout="mobile"] .form-grid .col-8{grid-column:1/-1}#${ROOT_ID}[data-layout="mobile"] .placement-grid{grid-template-columns:1fr 1fr}#${ROOT_ID}[data-layout="mobile"] .placement-position{grid-column:1/-1}#${ROOT_ID}[data-layout="mobile"] .target-row{grid-template-columns:1fr}#${ROOT_ID}[data-layout="mobile"] .target-row .minibtn{justify-self:start}
@media(max-width:520px){#${ROOT_ID} .placement-grid{grid-template-columns:1fr 1fr}#${ROOT_ID} .placement-position{grid-column:1/-1}#${ROOT_ID} .target-row{grid-template-columns:1fr}#${ROOT_ID} .target-row .minibtn{justify-self:start}#${ROOT_ID} .section-head{gap:10px}#${ROOT_ID} .option-strip{gap:10px}}
@media(max-width:420px){#${ROOT_ID} .head .sub:not(.chat-id){display:none}#${ROOT_ID} .head .chat-id{max-width:125px}#${ROOT_ID} .side-title{max-width:68px}#${ROOT_ID} .side-actions button{font-size:10.5px;padding-left:6px;padding-right:6px}#${ROOT_ID} .tab{padding-left:12px;padding-right:12px}#${ROOT_ID} .content{padding:8px}#${ROOT_ID} .card{padding:10px}#${ROOT_ID} .empty{padding:24px 12px}}
@media(max-height:560px) and (max-width:720px){#${ROOT_ID} .head{height:40px}#${ROOT_ID} .iconbtn{min-height:32px}#${ROOT_ID} .side{min-height:40px;max-height:70px}#${ROOT_ID} .sheet{min-height:30px;padding:5px 8px}#${ROOT_ID} .tabs .tab{height:37px}#${ROOT_ID} .content{padding:7px}#${ROOT_ID} .foot{padding-top:5px;padding-bottom:5px}}
`;
    // This layer is a sibling of the editor root, so it is intentionally not
    // passed through scopeCss(). Its z-index is above the full-screen mask,
    // while the unique id keeps the rules isolated from SillyTavern/toastr.
    const NOTICE_CSS = `
#${NOTICE_ID}{--notice-info:#3978a8;position:fixed;z-index:2147483647;top:calc(12px + env(safe-area-inset-top,0px));right:12px;width:min(380px,calc(100vw - 24px));max-height:calc(100dvh - 24px);display:flex;flex-direction:column;gap:8px;overflow:auto;pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
#${NOTICE_ID}[data-accent="green"]{--notice-info:#4f8068}
#${NOTICE_ID} .acu-editor-notice{--notice-accent:var(--notice-info);display:grid;grid-template-columns:24px minmax(0,1fr) 28px;align-items:start;gap:8px;padding:10px 8px 10px 10px;background:rgba(255,253,248,.98);color:#403a32;border:1px solid #ddd2c1;border-left:3px solid var(--notice-accent);border-radius:5px;box-shadow:0 8px 26px rgba(74,59,41,.22);pointer-events:auto;opacity:0;transform:translateY(-7px);transition:opacity .16s ease,transform .16s ease}
#${NOTICE_ID} .acu-editor-notice.visible{opacity:1;transform:translateY(0)}#${NOTICE_ID} .acu-editor-notice.leaving{opacity:0;transform:translateY(-5px)}
#${NOTICE_ID} .acu-editor-notice--success{--notice-accent:#43835c}#${NOTICE_ID} .acu-editor-notice--warning{--notice-accent:#b07836}#${NOTICE_ID} .acu-editor-notice--error{--notice-accent:#b65d57}
#${NOTICE_ID} .acu-editor-notice-mark{display:flex;align-items:center;justify-content:center;width:22px;height:22px;margin-top:1px;border-radius:4px;background:var(--notice-accent);color:#fff;font-size:13px;font-weight:700;line-height:1}
#${NOTICE_ID} .acu-editor-notice-text{min-width:0;max-height:32vh;padding-top:2px;white-space:pre-wrap;overflow:auto;overflow-wrap:anywhere;font-size:12px;line-height:1.5}
#${NOTICE_ID} .acu-editor-notice-close{width:28px;height:28px;padding:0;border:0;border-radius:4px;background:transparent;color:#887f73;cursor:pointer;font:20px/1 sans-serif;touch-action:manipulation}#${NOTICE_ID} .acu-editor-notice-close:hover{background:#f4ede2;color:#403a32}
@media(max-width:720px){#${NOTICE_ID}{top:calc(8px + env(safe-area-inset-top,0px));left:8px;right:8px;width:auto}#${NOTICE_ID} .acu-editor-notice{padding:9px 7px 9px 9px}}
@media(prefers-reduced-motion:reduce){#${NOTICE_ID} .acu-editor-notice{transition:none}}
`;
    function scopeCss(css) {
        const rootSelector = `#${ROOT_ID}`;
        return css.replace(/(^|})(\s*)([^{}]+)\{/g, (whole, close, whitespace, selector) => {
            const trimmed = selector.trim();
            if (!trimmed || trimmed.startsWith('@') || trimmed.includes(rootSelector)) return whole;
            const scoped = trimmed.split(',').map(item => {
                const part = item.trim();
                return part ? `${rootSelector} ${part}` : part;
            }).join(', ');
            return `${close}${whitespace}${scoped}{`;
        });
    }
    function ensureStyle() {
        const document = doc();
        if (!document || document.getElementById(`${ROOT_ID}-style`)) return;
        const style = document.createElement('style');
        style.id = `${ROOT_ID}-style`;
        style.textContent = `${scopeCss(CSS)}\n${NOTICE_CSS}`;
        (document.head || document.documentElement).appendChild(style);
    }
    function applyUiAccentTheme(root) {
        if (!root) return;
        root.dataset.accent = uiAccentTheme;
        const button = root.querySelector('[data-act="toggle-theme"]');
        if (!button) return;
        const label = uiAccentTheme === 'blue' ? '切换为绿色' : '切换为蓝色';
        button.setAttribute('aria-label', label);
        button.title = label;
        button.setAttribute('aria-pressed', uiAccentTheme === 'green' ? 'true' : 'false');
        const noticeLayer = doc().getElementById(NOTICE_ID);
        if (noticeLayer) noticeLayer.dataset.accent = uiAccentTheme;
    }
    async function toggleUiAccentTheme(root) {
        uiAccentTheme = uiAccentTheme === 'blue' ? 'green' : 'blue';
        uiAccentThemeReady = true;
        applyUiAccentTheme(root);
        await settingSet(UI_ACCENT_THEME_KEY, uiAccentTheme);
    }
    function render() {
        if (!app) return;
        const root = doc().getElementById(ROOT_ID);
        if (!root) return;
        markViewport(root);
        applyUiAccentTheme(root);
        const keys = orderedKeys(app.data);
        if (!app.active || !app.data[app.active]) app.active = keys[0] || null;
        root.innerHTML = `<div class="mask"><section class="win" role="dialog" aria-modal="true" aria-label="数据库编辑器">
          <header class="head"><h1>数据库</h1><span class="spacer"></span><span class="sub chat-id">${esc(currentChatId() || '未连接聊天')}</span><button class="iconbtn theme-toggle" data-act="toggle-theme" aria-pressed="${uiAccentTheme === 'green' ? 'true' : 'false'}" aria-label="${uiAccentTheme === 'blue' ? '切换为绿色' : '切换为蓝色'}" title="${uiAccentTheme === 'blue' ? '切换为绿色' : '切换为蓝色'}"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2.5c-5.24 0-9.5 3.83-9.5 8.55 0 3.86 3.14 7 7 7h1.12c.62 0 1-.67.69-1.21-.62-1.08.16-2.43 1.4-2.43h3.42c2.97 0 5.37-2.4 5.37-5.37C21.5 5.43 17.24 2.5 12 2.5Z"/><circle cx="7" cy="10.4" r="1.15" fill="var(--paper)"/><circle cx="9.3" cy="6.8" r="1.15" fill="var(--paper)"/><circle cx="13.5" cy="6.3" r="1.15" fill="var(--paper)"/><circle cx="17.1" cy="8.6" r="1.15" fill="var(--paper)"/></svg></button><button class="iconbtn" data-act="close" aria-label="关闭">×</button></header>
          <div class="body"><aside class="side" aria-label="表格选择"><div class="side-title">当前表格 · ${keys.length}</div><div id="acu-sheet-list"></div><div class="side-actions"><button class="minibtn" data-act="add-sheet">＋ 新表</button><button class="minibtn" data-act="delete-sheet">删除表</button></div></aside>
          <div class="main"><nav class="tabs" aria-label="编辑器页面"><button class="tab ${app.mode === 'data' ? 'active' : ''}" data-mode="data">数据</button><button class="tab ${app.mode === 'config' ? 'active' : ''}" data-mode="config">结构与注入</button><button class="tab ${app.mode === 'template' ? 'active' : ''}" data-mode="template">模板</button><button class="tab ${app.mode === 'status' ? 'active' : ''}" data-mode="status">状态</button><button class="tab ${app.mode === 'backup' ? 'active' : ''}" data-mode="backup">数据管理</button></nav><main class="content" id="acu-content"></main></div></div>
          <footer class="foot"><span class="dirty">${app.dirtyData || app.dirtyTemplate ? '有未保存修改' : '已保存'}</span><span class="grow"></span><button class="btn" data-act="save-all">保存并同步世界书</button></footer>
        </section></div>`;
        const list = root.querySelector('#acu-sheet-list');
        keys.forEach(key => {
            const item = doc().createElement('div');
            item.className = `sheet ${app.active === key ? 'active' : ''}`;
            item.dataset.key = key;
            item.innerHTML = `<span class="sheet-name" title="${esc(app.data[key].name)}">${esc(app.data[key].name)}</span><span class="sheet-order"><button class="minibtn" data-act="up" data-key="${esc(key)}">↑</button><button class="minibtn" data-act="down" data-key="${esc(key)}">↓</button></span>`;
            list.appendChild(item);
        });
        const content = root.querySelector('#acu-content');
        if (app.mode === 'data' && app.active) renderData(content, app.data[app.active]);
        else if (app.mode === 'config' && app.active) renderConfig(content, app.data[app.active]);
        else if (app.mode === 'template') renderTemplate(content);
        else if (app.mode === 'status') renderStatus(content);
        else if (app.mode === 'backup') renderBackup(content);
        else content.innerHTML = '<div class="empty">点击“新表”开始。</div>';
        bindEvents(root);
    }

    function renderData(element, sheet) {
        element.classList.add('data-content');
        const header = sheet.content?.[0] || [null];
        const rows = sheet.content?.slice(1) || [];
        const layout = pageRows(rows, app.page, app.reverseRows, PAGE_SIZE);
        app.page = layout.page;
        const orderLabel = app.reverseRows ? '倒序' : '正序';
        const labels = header.slice(2);
        const records = layout.items.map(item => {
            const rowNumber = text(item.row?.[0]).replace(/^#\s*/, '');
            const recordName = text(item.row?.[1]).trim();
            const fields = labels.map((label, columnIndex) => {
                const value = item.row?.[columnIndex + 2];
                return `<div class="record-field ${recordFieldSize(value, label)}"><span class="record-label">${esc(label)}</span><div class="record-value" contenteditable="true" data-cell-row="${item.physicalIndex + 1}" data-cell-col="${columnIndex + 2}">${esc(value)}</div></div>`;
            }).join('');
            return `<article class="record-card"><header class="record-head"><span class="record-number">#${esc(rowNumber)}</span><span class="record-name" contenteditable="true" data-placeholder="未填写" data-cell-row="${item.physicalIndex + 1}" data-cell-col="1">${esc(recordName)}</span><button class="minibtn danger record-delete" data-act="delete-row" data-row="${item.physicalIndex + 1}">删除</button></header><div class="record-fields">${fields}</div></article>`;
        }).join('');
        element.innerHTML = `<div class="toolbar"><strong>${esc(sheet.name)}</strong><span class="hint">${rows.length} 行 · 第 ${app.page + 1}/${layout.pageCount} 页 · 当前 ${orderLabel}</span><button class="minibtn" data-act="prev-page" ${app.page <= 0 ? 'disabled' : ''}>上一页</button><button class="minibtn" data-act="next-page" ${app.page >= layout.pageCount - 1 ? 'disabled' : ''}>下一页</button><button class="minibtn" data-act="toggle-row-order">${app.reverseRows ? '切换正序' : '切换倒序'}</button><span class="grow"></span><button class="minibtn add-row-compact" data-act="add-row">＋ 添加行</button></div><div class="record-list">${records}${rows.length ? '' : '<div class="empty">还没有数据行，点击“添加行”。</div>'}</div>`;
    }
    function placementHtml(prefix, raw, disabled = false) {
        const value = normalizePlacement(raw);
        const off = disabled ? ' disabled' : '';
        return `<div class="placement-grid"><div class="field placement-position"><label>位置</label><select data-place="${prefix}-position" aria-label="条目位置"${off}><option value="at_depth_as_system" ${value.position === 'at_depth_as_system' ? 'selected' : ''}>系统深度</option><option value="before_character_definition" ${value.position === 'before_character_definition' ? 'selected' : ''}>角色定义前</option><option value="after_character_definition" ${value.position === 'after_character_definition' ? 'selected' : ''}>角色定义后</option></select></div><div class="field"><label>Depth</label><input type="number" data-place="${prefix}-depth" value="${value.depth}" aria-label="Depth"${off}></div><div class="field"><label>Order</label><input type="number" data-place="${prefix}-order" value="${value.order}" aria-label="Order"${off}></div></div>`;
    }
    function worldbookTargetOptionsHtml() {
        const selected = worldbookTarget || 'auto';
        const names = [...worldbookOptions];
        if (selected !== 'auto' && !names.includes(selected)) names.unshift(selected);
        return `<option value="auto" ${selected === 'auto' ? 'selected' : ''}>自动：角色卡主世界书</option>${names.map(name => `<option value="${esc(name)}" ${name === selected ? 'selected' : ''}>${esc(name)}${boundWorldbookOptions.includes(name) ? '（角色卡绑定）' : ''}</option>`).join('')}`;
    }
    function renderConfig(element, sheet) {
        const config = normalizeExport(sheet.exportConfig, sheet.name);
        const header = sheet.content?.[0] || [null];
        const keywordDisabled = config.entryType === 'keyword' ? '' : ' disabled';
        const extraDisabled = config.extraIndexEnabled ? '' : ' disabled';
        const relativeDisabled = config.relativeTimeEnabled ? '' : ' disabled';
        const detectedStoryDate = latestStoryDate(chat());
        const relativeColumnOptions = header.slice(1).map(value => {
            const name = text(value).trim();
            return `<option value="${esc(name)}" ${name === config.relativeTimeColumn ? 'selected' : ''}>${esc(name || '未命名列')}</option>`;
        }).join('');
        element.innerHTML = `<div class="toolbar"><strong>结构与世界书注入</strong><span class="grow"></span><button class="btn secondary" data-act="save-template-chat">保存结构并同步世界书</button></div>
          <section class="card"><h2>基本信息</h2><div class="form-grid"><div class="field col-8"><label>表格名称</label><input data-config="name" value="${esc(sheet.name)}"></div><div class="field col-4"><label>顺序编号</label><input type="number" data-config="orderNo" value="${Number(sheet.orderNo) || 0}"></div></div></section>
          <section class="card"><h2>列定义（第一列为内部行号）</h2><div class="columns">${header.slice(1).map((value, index) => `<div class="column-row"><span class="index">${index + 1}</span><input data-col="${index + 1}" value="${esc(value)}"><button class="minibtn danger" data-act="delete-col" data-col="${index + 1}">删除</button></div>`).join('')}</div><button class="minibtn" data-act="add-col" style="margin-top:8px">＋ 添加列</button></section>
          <section class="card"><h2>注入目标世界书</h2><div class="target-row"><div class="field"><label>按聊天记忆，当前聊天的所有表共用</label><select id="acu-worldbook-target">${worldbookTargetOptionsHtml()}</select></div><button class="minibtn" data-act="refresh-worldbooks">刷新列表</button></div><p class="hint">当前目标：${esc(resolvedWorldbookTarget || '未找到可用世界书')}。切换后会移动当前聊天的临时投影，并只清理本插件带当前聊天标记的条目。</p></section>
          <section class="card injection-card"><div class="section-head"><div><h2>世界书注入</h2><p class="hint">主条目可整表写入，也可按数据行拆分；关键词既可以写固定词，也可以填写列名。</p></div><label class="check strong-check"><input type="checkbox" data-export="enabled" ${config.enabled ? 'checked' : ''}>启用此表注入</label></div>
            <div class="option-strip"><label class="check"><input type="checkbox" data-export="splitByRow" ${config.splitByRow ? 'checked' : ''}>每行单独条目</label><label class="check"><input type="checkbox" data-export="preventRecursion" ${config.preventRecursion ? 'checked' : ''}>防止递归</label></div>
            <div class="form-grid"><div class="field col-8"><label>条目名称</label><input data-export="entryName" value="${esc(config.entryName)}"></div><div class="field col-4"><label>条目类型</label><select data-export="entryType"><option value="constant" ${config.entryType === 'constant' ? 'selected' : ''}>常量</option><option value="keyword" ${config.entryType === 'keyword' ? 'selected' : ''}>关键词</option></select></div><div class="field wide"><label>关键词</label><input data-export="keywords" value="${esc(config.keywords)}" placeholder="逗号、中文逗号或换行分隔；填列名可读取该列"${keywordDisabled}><span class="field-note">关键词模式下，匹配列名时会从每行该列生成 keys；否则按固定关键词处理。</span></div><div class="field wide"><label>注入模板</label><textarea data-export="injectionTemplate" placeholder="$1 代表生成的 Markdown 表格">${esc(config.injectionTemplate)}</textarea></div><div class="field wide"><label>主条目位置</label>${placementHtml('entry', config.entryPlacement)}</div></div>
            <div class="subpanel"><div class="section-head compact"><div><h3>相对剧情时间</h3><p class="hint">只改变同步到世界书的临时表格，不修改聊天 checkpoint 和原表数据。</p></div><label class="check"><input type="checkbox" data-export="relativeTimeEnabled" ${config.relativeTimeEnabled ? 'checked' : ''}>启用时间差</label></div><div class="form-grid"><div class="field col-6"><label>表格中的时间列</label><select data-export="relativeTimeColumn"${relativeDisabled}><option value="" ${config.relativeTimeColumn ? '' : 'selected'}>请选择列</option>${relativeColumnOptions}</select></div><div class="field col-6"><label>当前识别结果</label><input value="${esc(detectedStoryDate ? `${detectedStoryDate.label} · AI 第 ${detectedStoryDate.aiFloor} 层` : `最新及前 ${STORY_DATE_AI_LOOKBACK - 1} 个 AI 楼层未识别`)}" readonly></div></div><p class="hint" style="margin-top:8px">同步时先读最新 AI 楼层，找到日期就立即停止；只有没找到才逐层往前，最多再看 ${STORY_DATE_AI_LOOKBACK - 1} 层。同一楼层取 &lt;content&gt; 后出现的最后一个。日期跨度取结束日期。</p></div>
            <div class="subpanel"><div class="section-head compact"><div><h3>额外索引条目</h3><p class="hint">从指定列生成一份更短的常量索引，可使用独立模板和注入位置。</p></div><label class="check"><input type="checkbox" data-export="extraIndexEnabled" ${config.extraIndexEnabled ? 'checked' : ''}>启用索引</label></div><div class="form-grid"><div class="field col-6"><label>索引条目名称</label><input data-export="extraIndexEntryName" value="${esc(config.extraIndexEntryName)}"${extraDisabled}></div><div class="field col-6"><label>索引列</label><input data-export="extraIndexColumns" value="${esc(config.extraIndexColumns.join('，'))}" placeholder="用逗号分隔现有列名"${extraDisabled}></div><div class="field wide"><label>索引注入模板</label><textarea data-export="extraIndexInjectionTemplate" placeholder="$1 代表索引表格"${extraDisabled}>${esc(config.extraIndexInjectionTemplate)}</textarea></div><div class="field wide"><label>索引条目位置</label>${placementHtml('extra', config.extraIndexPlacement, !config.extraIndexEnabled)}</div></div></div>
          </section>`;
    }
    function renderTemplate(element) {
        const value = templateFromData(app.data);
        element.innerHTML = `<section class="card"><h2>当前聊天模板</h2><p class="hint">只保存本聊天的表格结构、列定义和世界书设置，不保存数据行，也不再维护全局模板。</p><div class="toolbar"><button class="btn" data-act="save-template-chat">保存模板并同步世界书</button><button class="btn secondary" data-act="download-template">导出模板 JSON</button><label class="btn secondary" for="acu-template-file">导入模板 JSON</label><input class="file" id="acu-template-file" type="file" accept="application/json"></div><div class="code">${esc(templateOverview(value))}</div></section>`;
    }
    function renderStatus(element) {
        const status = modelStatus();
        const latest = status.latest;
        const checkpoint = latest?.frame?.checkpoint;
        const latestLabel = latest ? `AI 第 ${latest.aiFloor} 层（聊天消息索引 #${latest.index}）` : '尚未保存';
        const fullCheckpointLabel = status.fullCheckpoints.length
            ? status.fullCheckpoints.map(ref => `AI 第 ${ref.aiFloor} 层（消息 #${ref.index}）`).join('、')
            : '暂无';
        element.innerHTML = `<section class="card"><h2>当前聊天状态</h2><div class="status-list">
          <div class="stat"><b>聊天标识</b><span>${esc(currentChatId() || '未连接')}</span></div><div class="stat"><b>表格 / 数据行</b><span>${status.tables} / ${status.rows}</span></div>
          <div class="stat"><b>当前聊天 AI 楼层</b><span>${aiFloorCount(chat())}</span></div><div class="stat"><b>最近一次保存</b><span>${esc(latestLabel)}</span></div>
          <div class="stat"><b>保存时间</b><span>${checkpoint?.createdAt ? new Date(checkpoint.createdAt).toLocaleString() : '尚未保存'}</span></div><div class="stat"><b>写入方式</b><span>每次保存都是完整 checkpoint</span></div>
          <div class="stat full-checkpoint-stat"><b>已保存 full checkpoint 的 AI 楼层</b><span>${esc(fullCheckpointLabel)}</span></div>
          </div></section>`;
    }
    function renderBackup(element) {
        const summary = { tables: orderedKeys(app.data).length, rows: modelStatus().rows, messageCount: chat().length, note: '备份只包含当前模板和表格数据。' };
        element.innerHTML = `<section class="card"><h2>数据管理</h2><p class="hint">备份只包含当前编辑器可见的模板和数据，不复制整段聊天。导入后仍需点击底部“保存并同步世界书”才会写回聊天；要物理减小聊天文件，请删除旧 checkpoint。</p><div class="toolbar"><button class="btn secondary" data-act="download-backup">导出数据备份</button><label class="btn secondary" for="acu-backup-file">导入数据备份</label><input class="file" id="acu-backup-file" type="file" accept="application/json"></div><div class="code">${esc(JSON.stringify(summary, null, 2))}</div></section>`;
        const totalAiFloors = aiFloorCount(chat());
        element.innerHTML += `<section class="card"><h2>删除旧 checkpoint（按 AI 楼层）</h2><p class="hint">首尾均包含，留空表示从第一层到最后一层。这里只删除本精简版空标签槽中的完整 checkpoint，不碰聊天正文、普通 extra、模板或其它标签槽；删除后剩余记录必须仍能由一份完整 checkpoint 独立载入，否则操作会被拒绝。</p><div class="grid2"><div class="field"><label>起始 AI 楼层</label><input id="acu-delete-start" type="number" min="1" max="${totalAiFloors || 1}" placeholder="1"></div><div class="field"><label>结束 AI 楼层</label><input id="acu-delete-end" type="number" min="1" max="${totalAiFloors || 1}" placeholder="${totalAiFloors || 1}"></div></div><div class="toolbar"><span class="hint">当前聊天共 ${totalAiFloors} 个 AI 楼层</span><span class="grow"></span><button class="btn warn" data-act="delete-ai-range" ${totalAiFloors ? '' : 'disabled'}>删除范围内 checkpoint</button></div></section>`;
        element.innerHTML += `<section class="card"><h2>卸载式清理当前聊天</h2><p class="hint">删除整个聊天中的所有已知旧/新数据库字段，并一并移除首楼模板、ScopedConfig、旧表头和 metadata owner。聊天正文不动，但下次打开不会再有本聊天的表结构；建议先导出备份。</p><div class="toolbar"><span class="grow"></span><button class="btn warn" data-act="purge-chat-data" ${chat().length ? '' : 'disabled'}>彻底移除本聊天数据库痕迹</button></div></section>`;
    }
    function buildBackup() {
        return {
            format: 'acu-v2-minimal-backup',
            version: 1,
            exportedAt: new Date().toISOString(),
            chatId: currentChatId(),
            messageCount: chat().length,
            template: templateFromData(app.data),
            // 备份也只导出当前精简版白名单，避免把旧 SQL/自动填表字段、
            // 外部索引状态或原版内置表再次带回聊天。
            data: minimalDataForWrite(app.data, true),
        };
    }
    function download(filename, value) {
        const blob = new Blob([value], { type: 'application/json;charset=utf-8' });
        const anchor = doc().createElement('a');
        anchor.href = URL.createObjectURL(blob);
        anchor.download = filename;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
    }

    function applyTemplateToCurrentData(template) {
        const output = normalizeData(template, false);
        Object.keys(output).filter(isSheetKey).forEach(key => {
            if (app.data[key] && Array.isArray(app.data[key].content)) {
                output[key].content = [clone(output[key].content[0]), ...app.data[key].content.slice(1).map(clone)];
            }
        });
        app.data = output;
        app.active = orderedKeys(app.data)[0] || null;
        app.dirtyData = true;
        app.dirtyTemplate = true;
    }
    function addSheet() {
        const name = LOCAL.prompt ? LOCAL.prompt('请输入新表格名称', '新建表格') : '';
        if (!name?.trim()) return;
        const key = newSheetKey();
        app.data[key] = normalizeSheet({
            uid: key,
            name: name.trim(),
            content: [[null, '列1']],
            exportConfig: normalizeExport({}, name.trim()),
            orderNo: orderedKeys(app.data).length,
        }, key, true);
        app.active = key;
        app.mode = 'data';
        app.page = 0;
        app.dirtyData = true;
        app.dirtyTemplate = true;
        render();
    }
    function deleteActiveSheet() {
        if (!app.active || !app.data[app.active]) return;
        const key = app.active;
        if (!confirm(`确定删除“${app.data[key].name}”吗？保存后该表会从当前聊天数据中移除。`)) return;
        delete app.data[key];
        app.active = orderedKeys(app.data)[0] || null;
        app.dirtyData = true;
        app.dirtyTemplate = true;
        render();
    }
    function moveSheet(key, delta) {
        const keys = orderedKeys(app.data);
        const from = keys.indexOf(key);
        const to = from + delta;
        if (from < 0 || to < 0 || to >= keys.length) return;
        [keys[from], keys[to]] = [keys[to], keys[from]];
        keys.forEach((item, index) => { app.data[item].orderNo = index; });
        app.dirtyData = true;
        app.dirtyTemplate = true;
        render();
    }
    function addRow() {
        const sheet = app.data[app.active];
        if (!sheet) return;
        const used = new Set(sheet.content.slice(1).map(row => text(row?.[0])));
        let rowId = String(sheet.content.length);
        while (used.has(rowId)) rowId = String(Number(rowId) + 1);
        sheet.content.push([rowId, ...new Array(Math.max(0, sheet.content[0].length - 1)).fill('')]);
        app.page = app.reverseRows ? 0 : Math.max(0, Math.ceil((sheet.content.length - 1) / PAGE_SIZE) - 1);
        app.dirtyData = true;
        render();
    }
    function deleteRow(index) {
        const sheet = app.data[app.active];
        if (!sheet || index < 1 || index >= sheet.content.length) return;
        if (!confirm('确定删除此行吗？')) return;
        sheet.content.splice(index, 1);
        app.dirtyData = true;
        render();
    }
    function addColumn() {
        const sheet = app.data[app.active];
        if (!sheet) return;
        const name = LOCAL.prompt ? LOCAL.prompt('请输入列名', `列${sheet.content[0].length}`) : '';
        if (!name) return;
        sheet.content[0].push(name);
        sheet.content.slice(1).forEach(row => row.push(''));
        app.dirtyData = true;
        app.dirtyTemplate = true;
        render();
    }
    function deleteColumn(index) {
        const sheet = app.data[app.active];
        if (!sheet || index < 1 || index >= sheet.content[0].length) return;
        if (!confirm('删除列会同时删除该列的数据，确定吗？')) return;
        sheet.content.forEach(row => row.splice(index, 1));
        app.dirtyData = true;
        app.dirtyTemplate = true;
        render();
    }
    function updateExportField(sheet, field, element) {
        const config = sheet.exportConfig = normalizeExport(sheet.exportConfig, sheet.name);
        config[field] = element.type === 'checkbox'
            ? element.checked
            : field === 'extraIndexColumns' ? delimitedList(element.value) : element.value;
        app.dirtyData = true;
        app.dirtyTemplate = true;
    }
    function updatePlacementField(sheet, token, element) {
        sheet.exportConfig = normalizeExport(sheet.exportConfig, sheet.name);
        const target = token.startsWith('entry-')
            ? sheet.exportConfig.entryPlacement
            : token.startsWith('extra-') ? sheet.exportConfig.extraIndexPlacement : null;
        if (!target) return;
        const field = token.endsWith('-position') ? 'position' : token.endsWith('-depth') ? 'depth' : 'order';
        target[field] = field === 'position' ? element.value : (Number(element.value) || 0);
        app.dirtyData = true;
        app.dirtyTemplate = true;
    }
    async function readJsonFile(file, isBackup) {
        try {
            const parsed = parseJson(await file.text(), null);
            if (!parsed) throw new Error('JSON 格式不正确');
            if (isBackup && isObject(parsed.data)) {
                app.data = removeBuiltinSheets(parsed.data, true);
                app.active = orderedKeys(app.data)[0] || null;
            } else {
                const template = parsed.template || (parsed.mate ? parsed : null);
                if (!template) throw new Error('文件中没有模板');
                applyTemplateToCurrentData(removeBuiltins(template));
            }
            app.dirtyData = true;
            app.dirtyTemplate = true;
            render();
            notify('文件已读入；点击保存后才会写入当前聊天。', 'success');
        } catch (error) {
            notify(`读取失败：${error.message}`, 'error');
        }
    }
    function bindEvents(root) {
        const refreshDirty = () => {
            if (!app) return;
            const indicator = root.querySelector('.dirty');
            if (indicator && (app.dirtyData || app.dirtyTemplate)) indicator.textContent = '有未保存修改';
        };
        root.onclick = async event => {
            const target = event.target.closest('[data-act],[data-mode],[data-key]');
            if (!target) return;
            const action = target.dataset.act;
            if (target.dataset.mode) { app.mode = target.dataset.mode; render(); return; }
            if (target.dataset.key && !action) { app.active = target.dataset.key; app.mode = 'data'; app.page = 0; render(); return; }
            if (action === 'close') { closeApp(); return; }
            if (action === 'toggle-theme') { await toggleUiAccentTheme(root); return; }
            if (action === 'add-sheet') { addSheet(); return; }
            if (action === 'delete-sheet') { deleteActiveSheet(); return; }
            if (action === 'up' || action === 'down') { moveSheet(target.dataset.key, action === 'up' ? -1 : 1); return; }
            if (action === 'add-row') { addRow(); return; }
            if (action === 'prev-page') { app.page = Math.max(0, app.page - 1); render(); return; }
            if (action === 'next-page') { app.page += 1; render(); return; }
            if (action === 'toggle-row-order') { app.reverseRows = !app.reverseRows; app.page = 0; render(); return; }
            if (action === 'delete-row') { deleteRow(Number(target.dataset.row)); return; }
            if (action === 'add-col') { addColumn(); return; }
            if (action === 'delete-col') { deleteColumn(Number(target.dataset.col)); return; }
            if (action === 'refresh-worldbooks') {
                try {
                    await loadWorldbookOptions();
                    render();
                    notify(worldbookOptions.length ? `已找到 ${worldbookOptions.length} 本世界书。` : '没有通过当前接口找到世界书。', worldbookOptions.length ? 'success' : 'warning');
                } catch (error) { notify(`读取世界书列表失败：${error?.message || error}`, 'error'); }
                return;
            }
            if (action === 'delete-ai-range') {
                const start = root.querySelector('#acu-delete-start')?.value || '';
                const end = root.querySelector('#acu-delete-end')?.value || '';
                let range;
                try { range = normalizeAiFloorRange(start, end, chat()); }
                catch (error) { notify(error.message || text(error), 'error'); return; }
                const dirtyWarning = app.dirtyData || app.dirtyTemplate
                    ? '\n\n当前编辑器还有未保存修改；删除后这些修改会丢失。'
                    : '';
                if (!confirm(`确定删除 AI 第 ${range.start} 到第 ${range.end} 层（首尾包含）的精简版 checkpoint 吗？\n\n聊天正文、模板、普通 extra 和其它标签槽不会删除；这些历史 checkpoint 删除后不能恢复。若删除后剩余记录无法由完整 checkpoint 独立载入，插件会拒绝操作。${dirtyWarning}`)) return;
                try {
                    const result = await runSave(session => deleteStoredFramesByAiFloor(range.start, range.end, session));
                    app = null;
                    await loadModel();
                    render();
                    if (!getFrameRefs(chat()).length) {
                        await queueWorldbookSync({ mate: { type: 'chatSheets', version: 1 } }, { silent: true });
                    } else {
                        triggerProjectionSync();
                    }
                    notify(result.removed ? `已删除 ${result.removed} 个旧 checkpoint，聊天 JSON 预计减少约 ${result.removedCharacters || 0} 字节。` : '指定范围内没有可安全删除的 checkpoint。', 'success');
                } catch (error) { notify(`删除失败：${error?.message || error}`, 'error'); }
                return;
            }
            if (action === 'purge-chat-data') {
                const dirtyWarning = app.dirtyData || app.dirtyTemplate
                    ? '\n\n当前编辑器还有未保存修改；清理后这些修改会丢失。'
                    : '';
                if (!confirm(`这是卸载式操作：会删除整个聊天中所有已知数据库字段、旧剧情/向量/优化残留，并删除聊天模板、旧表头和 metadata owner。\n\n聊天正文不会删除，但本聊天的表结构需要以后重新导入。建议先导出数据备份。${dirtyWarning}\n\n确定继续吗？`)) return;
                try {
                    const result = await runSave(deleteAllKnownPluginData);
                    app = null;
                    await loadModel();
                    render();
                    await queueWorldbookSync({ mate: { type: 'chatSheets', version: 1 } }, { silent: true });
                    notify(result.removed || result.metadataChanges?.length ? `已卸载本聊天数据库痕迹，预计减少约 ${result.removedCharacters || 0} 字节。` : '当前聊天没有发现已知数据库痕迹。', 'success');
                } catch (error) { notify(`卸载式清理失败：${error?.message || error}`, 'error'); }
                return;
            }
            try {
                if (action === 'save-all') { await runSave(saveAll); return; }
                if (action === 'save-template-chat') { await runSave(saveTemplate); render(); return; }
                if (action === 'download-template') { download('数据库-模板.json', JSON.stringify(templateFromData(app.data), null, 2)); return; }
                if (action === 'download-backup') {
                    download('数据库-数据备份.json', JSON.stringify(buildBackup(), null, 2));
                    return;
                }
            } catch (error) { notify(error.message || text(error), 'error'); }
        };
        root.oninput = event => {
            const element = event.target;
            if (element.dataset.cellRow) {
                const sheet = app.data[app.active];
                const row = Number(element.dataset.cellRow);
                const column = Number(element.dataset.cellCol);
                if (sheet?.content?.[row]) {
                    const value = typeof element.innerText === 'string' ? element.innerText : element.textContent;
                    sheet.content[row][column] = text(value).replace(/\r\n/g, '\n');
                    const field = element.closest('.record-field');
                    if (field) {
                        const label = field.querySelector('.record-label')?.textContent || '';
                        field.classList.remove('short', 'medium', 'long');
                        field.classList.add(recordFieldSize(value, label));
                    }
                    if (column === 1) {
                        const name = element.closest('.record-card')?.querySelector('.record-name');
                        if (name && name !== element) name.textContent = text(value).trim();
                    }
                    app.dirtyData = true;
                }
                refreshDirty();
                return;
            }
            const sheet = app.data[app.active];
            if (element.dataset.config && sheet) {
                const field = element.dataset.config;
                sheet[field] = field === 'orderNo' ? (Number(element.value) || 0) : element.value;
                app.dirtyData = true;
                app.dirtyTemplate = true;
            } else if (element.dataset.col && sheet) {
                sheet.content[0][Number(element.dataset.col)] = element.value;
                app.dirtyData = true;
                app.dirtyTemplate = true;
            } else if (element.dataset.export && sheet) updateExportField(sheet, element.dataset.export, element);
            else if (element.dataset.place) updatePlacementField(sheet, element.dataset.place, element);
            refreshDirty();
        };
        root.onchange = event => {
            const element = event.target;
            if (element.id === 'acu-template-file' && element.files?.[0]) { void readJsonFile(element.files[0], false); return; }
            if (element.id === 'acu-backup-file' && element.files?.[0]) { void readJsonFile(element.files[0], true); return; }
            if (element.id === 'acu-worldbook-target') {
                void setWorldbookTarget(element.value)
                    .then(() => { if (app) render(); })
                    .catch(error => notify(`设置世界书失败：${error?.message || error}`, 'error'));
                return;
            }
            const sheet = app.data[app.active];
            if (element.dataset.export && sheet) {
                updateExportField(sheet, element.dataset.export, element);
                if (element.dataset.export === 'relativeTimeEnabled') {
                    const timeColumn = root.querySelector('[data-export="relativeTimeColumn"]');
                    if (timeColumn) timeColumn.disabled = !element.checked;
                    refreshDirty();
                    return;
                }
                if (['entryType', 'extraIndexEnabled'].includes(element.dataset.export)) { render(); return; }
            }
            if (element.dataset.place) updatePlacementField(sheet, element.dataset.place, element);
            refreshDirty();
        };
    }

    function closeApp() {
        removeEditorNotices();
        doc().getElementById(ROOT_ID)?.remove();
        doc().getElementById(`${ROOT_ID}-style`)?.remove();
        unlockHostScroll();
        app = null;
    }
    async function openApp() {
        attachChatListener();
        ensureStyle();
        const document = doc();
        let root = document.getElementById(ROOT_ID);
        if (!root) {
            root = document.createElement('div');
            root.id = ROOT_ID;
            root.dataset.accent = uiAccentTheme;
            root.innerHTML = '<div class="mask"><div class="open-loading" role="status" aria-live="polite">正在打开数据库…</div></div>';
            document.body.appendChild(root);
        }
        lockHostScroll();
        try {
            if (!app) await loadModel();
        } catch (error) {
            root.remove();
            doc().getElementById(`${ROOT_ID}-style`)?.remove();
            unlockHostScroll();
            app = null;
            throw error;
        }
        // 世界书列表只是编辑器中的可选下拉项。某些移动端宿主会在抽屉
        // 尚未初始化时让其 API 等待很久；先把编辑器显示出来，避免“点了
        // 菜单却没有任何反应”，列表完成后再刷新同一聊天的界面。
        render();
        const snapshot = { chat: chat(), chatId: currentChatId() };
        const worldbookLoad = Promise.resolve().then(() => loadWorldbookOptions());
        const refreshIfFresh = () => {
            if (app && sameChatSnapshot(snapshot) && document.getElementById(ROOT_ID)) render();
        };
        worldbookLoad.then(refreshIfFresh).catch(() => { /* 世界书列表是可选能力 */ });
        let timeoutId;
        try {
            await Promise.race([
                worldbookLoad,
                new Promise(resolve => { timeoutId = setTimeout(resolve, 2500); }),
            ]);
        } catch (_) { /* optional worldbook APIs may reject */ }
        finally { if (timeoutId) clearTimeout(timeoutId); }
    }
    function menuClick(event) {
        event.preventDefault();
        event.stopPropagation();
        // SillyTavern keeps the extensions drawer open after a child click on
        // some mobile layouts. Close it first so the editor owns the viewport
        // and the drawer cannot intercept the first touch/scroll gesture.
        let drawerClosed = false;
        try {
            const document = doc();
            const menu = document?.querySelector('#extensionsMenu');
            const button = document?.querySelector('#extensionsMenuButton');
            if (menu && button) {
                const style = HOST.getComputedStyle?.(menu);
                const visible = style
                    ? style.display !== 'none' && style.visibility !== 'hidden'
                    : menu.offsetParent !== null;
                if (visible) {
                    button.click();
                    drawerClosed = true;
                }
            }
        } catch (_) { /* the host menu is optional */ }
        const open = () => void openApp().catch(error => notify(error.message || text(error), 'error'));
        // 手机上的扩展抽屉会在当前 click 结束时完成关闭；等到下一任务再
        // 创建编辑器，避免宿主的收尾逻辑把刚插入的全屏根节点一起覆盖。
        if (drawerClosed) setTimeout(open, MOBILE_DRAWER_SETTLE_MS);
        else open();
    }
    let menuObserver = null;
    let menuRetryTimer = null;
    let menuInstalled = false;
    let menuDelegationAttached = false;
    let lastMenuActivationAt = 0;
    let menuTouchStart = null;
    function menuTargetFromEvent(event) {
        const target = event?.target;
        const element = target?.nodeType === 1 ? target : target?.parentElement;
        const item = element?.closest?.(`#${MENU_ID}`);
        return item && doc()?.documentElement?.contains(item) ? item : null;
    }
    function activateMenuFromEvent(event) {
        if (!menuTargetFromEvent(event)) return;
        if (event.type === 'pointerup' && !['touch', 'pen'].includes(event.pointerType)) return;
        const now = Date.now();
        if (now - lastMenuActivationAt < 500) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        lastMenuActivationAt = now;
        menuClick(event);
    }
    function rememberMenuTouch(event) {
        if (!menuTargetFromEvent(event)) { menuTouchStart = null; return; }
        const touch = event.touches?.[0] || event.changedTouches?.[0];
        menuTouchStart = touch ? { id: touch.identifier, x: touch.clientX, y: touch.clientY } : null;
    }
    function activateMenuFromTouch(event) {
        if (!menuTouchStart || !menuTargetFromEvent(event)) { menuTouchStart = null; return; }
        const touches = Array.from(event.changedTouches || []);
        const touch = touches.find(item => item.identifier === menuTouchStart.id) || touches[0];
        const start = menuTouchStart;
        menuTouchStart = null;
        if (!touch || Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 14) return;
        activateMenuFromEvent(event);
    }
    function resetMenuTouch() {
        menuTouchStart = null;
    }
    function activateMenuFromKeyboard(event) {
        if (!['Enter', ' '].includes(event.key) || !menuTargetFromEvent(event)) return;
        activateMenuFromEvent(event);
    }
    function attachMenuDelegation() {
        if (menuDelegationAttached) return;
        const document = doc();
        if (!document) return;
        // 手机端会重建扩展菜单 DOM；监听 document 而不是菜单节点本身，
        // 即使可见菜单项被 clone/innerHTML 替换，点击仍能到达编辑器。
        document.addEventListener('click', activateMenuFromEvent, true);
        document.addEventListener('pointerup', activateMenuFromEvent, true);
        document.addEventListener('touchstart', rememberMenuTouch, { capture: true, passive: true });
        document.addEventListener('touchend', activateMenuFromTouch, { capture: true, passive: false });
        document.addEventListener('touchcancel', resetMenuTouch, { capture: true, passive: true });
        document.addEventListener('keydown', activateMenuFromKeyboard, true);
        menuDelegationAttached = true;
    }
    function bindMenuItem(item) {
        if (!item) return;
        item.removeEventListener('click', activateMenuFromEvent);
        item.removeEventListener('pointerup', activateMenuFromEvent);
        item.removeEventListener('touchstart', rememberMenuTouch);
        item.removeEventListener('touchend', activateMenuFromTouch);
        item.removeEventListener('touchcancel', resetMenuTouch);
        item.removeEventListener('keydown', activateMenuFromKeyboard);
        item.addEventListener('click', activateMenuFromEvent);
        item.addEventListener('pointerup', activateMenuFromEvent);
        item.addEventListener('touchstart', rememberMenuTouch, { passive: true });
        item.addEventListener('touchend', activateMenuFromTouch, { passive: false });
        item.addEventListener('touchcancel', resetMenuTouch, { passive: true });
        item.addEventListener('keydown', activateMenuFromKeyboard);
    }
    function stopMenuWatch() {
        if (menuRetryTimer) {
            clearTimeout(menuRetryTimer);
            menuRetryTimer = null;
        }
        if (menuObserver) {
            try { menuObserver.disconnect(); } catch (_) { /* no-op */ }
            menuObserver = null;
        }
    }
    function installMenuItem() {
        const document = doc();
        if (!document) return false;
        const existing = document.getElementById(MENU_ID);
        if (existing) {
            bindMenuItem(existing);
            menuInstalled = true;
            stopMenuWatch();
            return true;
        }
        const menu = document.querySelector('#extensionsMenu');
        if (!menu) return false;

        // The wrapper is the shape used by SillyTavern's own extension items;
        // it is important on the mobile drawer, which applies focus/close
        // behavior to `.extension_container` rather than arbitrary children.
        const container = document.createElement('div');
        container.id = `${MENU_ID}-container`;
        container.className = 'extension_container interactable';
        container.tabIndex = 0;
        const item = document.createElement('div');
        item.id = MENU_ID;
        item.className = 'list-group-item flex-container flexGap5 interactable';
        item.tabIndex = 0;
        item.title = '打开数据库';
        item.innerHTML = '<div class="fa-fw fa-solid fa-table"></div><span>数据库</span>';
        bindMenuItem(item);
        container.appendChild(item);
        menu.appendChild(container);
        menuInstalled = true;
        stopMenuWatch();
        return true;
    }
    function insertMenu(attempt = 0) {
        if (menuInstalled || installMenuItem()) return;
        // Keep the cheap polling fallback for the normal startup path. The
        // observer below takes over after one minute for mobile/lazy drawers.
        if (attempt < 60) {
            menuRetryTimer = setTimeout(() => {
                menuRetryTimer = null;
                insertMenu(attempt + 1);
            }, 1000);
            return;
        }
        const document = doc();
        const Observer = HOST.MutationObserver || LOCAL.MutationObserver;
        if (!menuObserver && document?.documentElement && typeof Observer === 'function') {
            menuObserver = new Observer(() => {
                if (installMenuItem()) stopMenuWatch();
            });
            // The menu itself is inserted as a top-level host node. Observing
            // only direct child additions avoids watching every streamed chat
            // message after the one-minute lazy-start fallback is armed.
            menuObserver.observe(document.body || document.documentElement, { childList: true });
        }
    }
    function attachChatListener() {
        if (listenerAttached) return;
        const c = context();
        const source = c.eventSource;
        const type = c.eventTypes?.CHAT_CHANGED;
        if (!source || !type || typeof source.on !== 'function') return;
        try {
            source.on(type, () => {
                if (saveInProgress) { pendingChatReload = true; return; }
                triggerProjectionSync();
            });
            listenerAttached = true;
        } catch (_) { return; }
        // 若聊天事件接口比世界书接口更晚就绪，补做一次同步，避免漏掉等待期间发生的聊天切换。
        if (initialProjectionDone) triggerProjectionSync();
    }
    function boot() {
        // 同一 userscript 可能被宿主的多个同源 frame 重复执行；只做本版
        // 自身去重，不读取任何旧版或其它数据库脚本留下的全局标记。
        if (HOST[MINIMAL_INSTANCE_FLAG]) return;
        HOST[MINIMAL_INSTANCE_FLAG] = true;
        attachMenuDelegation();
        insertMenu();
        attachChatListener();
        scheduleInitialProjection();
    }
    if (doc()?.readyState === 'loading') doc().addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
})();