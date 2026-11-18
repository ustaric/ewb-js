/**
 * 🛠️ EWB 엔진 전용 주입형 4대 컨텍스트 추적 로거 (Logger)
 * - 🔌 [제로 외부 의존성] 특정 앱의 debugManager를 직접 import하지 않고 adapter 옵션으로 주입받아 동작
 * - 📋 [4대 컨텍스트 표준] Caller/Trigger, Lifecycle/State, Delta/Metrics, Result/Handoff 포맷 헬퍼(trace) 제공
 * - 🛡️ [다형성 안전 가드] trace(scope, ctx)와 trace(ctx) 호출 모두 정상 처리해 [object Object] 오출력 방지
 * - 📂 [그룹/접힘 지원] group(중요 상세 펼침) / groupCollapsed(프리로드 등 연속 로그 접힘) 분리 지원
 * 파일 경로: web/ewb-js/utils/Logger.js
 * @module ewb-js/utils/Logger
 */

const LEVEL_PRIORITY = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
    silent: 99
};

/**
 * 주입 가능한 독립 엔진 로거 클래스
 */
export class EngineLogger {
    /**
     * @param {Object} [options={}]
     * @param {string} [options.namespace='EWB']
     * @param {string} [options.defaultChannel='ewb']
     * @param {'debug'|'info'|'warn'|'error'|'silent'} [options.level='debug']
     * @param {boolean} [options.enabled=true]
     * @param {Object|null} [options.adapter=null]
     * @param {'auto'|'channel-first'|'plain'} [options.channelMode='auto']
     * @param {number} [options.historyLimit=0]
     */
    constructor(options = {}) {
        this.namespace = options.namespace || 'EWB';
        this.defaultChannel = options.defaultChannel || 'ewb';
        this.level = LEVEL_PRIORITY[options.level] ? options.level : 'debug';
        this.enabled = options.enabled !== false;
        this.adapter = options.adapter || null;
        this.channelMode = options.channelMode || 'auto';
        this.historyLimit = Math.max(0, Number(options.historyLimit || 0));
        this._history = [];
    }

    setEnabled(enabled) { this.enabled = Boolean(enabled); }
    setLevel(level) { if (LEVEL_PRIORITY[level]) this.level = level; }

    setAdapter(adapter, channel) {
        this.adapter = adapter || null;
        if (channel) this.defaultChannel = channel;
    }

    getHistory() { return [...this._history]; }
    clearHistory() { this._history.length = 0; }

    /**
     * 현재 디버그(trace/group) 로그 출력이 활성화되어 있는지 확인합니다.
     * @returns {boolean}
     */
    isDebugEnabled() {
        return this._shouldLog('debug');
    }

    /**
     * 모듈별 스코프 태그가 고정된 하위 로거를 생성합니다.
     * @param {string} scope
     */
    child(scope) {
        const safeScope = typeof scope === 'string' ? scope : 'Module';
        return {
            debug: (msg, ...meta) => this._emit('debug', safeScope, msg, meta),
            info: (msg, ...meta) => this._emit('info', safeScope, msg, meta),
            warn: (msg, ...meta) => this._emit('warn', safeScope, msg, meta),
            error: (msg, ...meta) => this._emit('error', safeScope, msg, meta),
            trace: (ctxOrAction, maybeCtx) => {
                if (typeof ctxOrAction === 'string' && maybeCtx && typeof maybeCtx === 'object') {
                    this.trace(safeScope, { action: ctxOrAction, ...maybeCtx });
                } else {
                    this.trace(safeScope, ctxOrAction || {});
                }
            },
            isDebugEnabled: () => this._shouldLog('debug'),
            group: (title) => this.group(`[${this.namespace}:${safeScope}] ${title}`),
            groupCollapsed: (title) => this.groupCollapsed(`[${this.namespace}:${safeScope}] ${title}`),
            groupEnd: () => this.groupEnd()
        };
    }

    /**
     * 4대 컨텍스트 표준 로그를 기록합니다.
     * @param {string|Object} scopeOrCtx
     * @param {Object} [maybeCtx]
     */
    trace(scopeOrCtx, maybeCtx) {
        let scope = 'Core';
        let ctx = {};

        if (typeof scopeOrCtx === 'string') {
            scope = scopeOrCtx;
            ctx = (maybeCtx && typeof maybeCtx === 'object') ? maybeCtx : { action: String(maybeCtx || 'event') };
        } else if (scopeOrCtx && typeof scopeOrCtx === 'object') {
            scope = typeof scopeOrCtx.scope === 'string' ? scopeOrCtx.scope : 'Core';
            ctx = scopeOrCtx;
        }

        const {
            action = 'event',
            caller = 'internal',
            state = 'ACTIVE',
            delta = 'none',
            result = 'ok',
            level = 'debug',
            data
        } = ctx;

        const formatted = `${action} | 호출자: [${caller}] | 상태: [${state}] | 변화: [${delta}] | 결과: [${result}]`;
        if (data !== undefined) {
            this._emit(level, scope, formatted, [data]);
        } else {
            this._emit(level, scope, formatted, []);
        }
    }

    group(title) {
        if (!this._shouldLog('debug')) return;
        try {
            if (this.adapter && typeof this.adapter.group === 'function') {
                if (this._usesChannelFirst()) this.adapter.group(this.defaultChannel, title);
                else this.adapter.group(title);
                return;
            }
            if (typeof console.group === 'function') console.group(title);
        } catch (e) {}
    }

    /**
     * 접힌(Collapsed) 콘솔 그룹을 시작합니다.
     * @param {string} title
     */
    groupCollapsed(title) {
        if (!this._shouldLog('debug')) return;
        try {
            if (this.adapter && typeof this.adapter.groupCollapsed === 'function') {
                if (this._usesChannelFirst()) this.adapter.groupCollapsed(this.defaultChannel, title);
                else this.adapter.groupCollapsed(title);
                return;
            }
            if (typeof console.groupCollapsed === 'function') {
                console.groupCollapsed(title);
                return;
            }
            if (this.adapter && typeof this.adapter.group === 'function') {
                if (this._usesChannelFirst()) this.adapter.group(this.defaultChannel, title);
                else this.adapter.group(title);
            }
        } catch (e) {}
    }

    groupEnd() {
        if (!this._shouldLog('debug')) return;
        try {
            if (this.adapter && typeof this.adapter.groupEnd === 'function') {
                if (this._usesChannelFirst()) this.adapter.groupEnd(this.defaultChannel);
                else this.adapter.groupEnd();
                return;
            }
            if (typeof console.groupEnd === 'function') console.groupEnd();
        } catch (e) {}
    }

    _shouldLog(level) {
        if (!this.enabled || this.level === 'silent') return false;
        const targetPriority = LEVEL_PRIORITY[level] ?? LEVEL_PRIORITY.debug;
        const currentPriority = LEVEL_PRIORITY[this.level] ?? LEVEL_PRIORITY.debug;
        if (targetPriority < currentPriority) return false;
        if (this.adapter && typeof this.adapter.isEnabled === 'function') {
            try {
                if (level !== 'error' && !this.adapter.isEnabled(this.defaultChannel)) return false;
            } catch (e) {}
        }
        return true;
    }

    _usesChannelFirst() {
        if (this.channelMode === 'channel-first') return true;
        if (this.channelMode === 'plain') return false;
        return Boolean(this.adapter && typeof this.adapter.isEnabled === 'function');
    }

    _emit(level, scope, message, meta = []) {
        const line = `[${this.namespace}:${scope}] ${message}`;
        if (this.historyLimit > 0) {
            this._history.push({ time: new Date().toISOString(), level, scope, message: line });
            if (this._history.length > this.historyLimit) this._history.shift();
        }
        if (!this._shouldLog(level)) return;

        try {
            const method = level === 'error' ? 'error' : (level === 'warn' ? 'warn' : 'log');
            if (this.adapter && typeof this.adapter[method] === 'function') {
                if (this._usesChannelFirst()) this.adapter[method](this.defaultChannel, line, ...meta);
                else this.adapter[method](line, ...meta);
                return;
            }
            const consoleFn = console[method] || console.log;
            consoleFn.call(console, line, ...meta);
        } catch (e) {}
    }
}

export function createLogger(options = {}) {
    return new EngineLogger(options);
}