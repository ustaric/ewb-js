/**
 * 🔌 EWB 엔진 라이프사이클 중계소 & 미들웨어 훅 버스 (HookBus)
 * - 📡 [공식 관문] onAfterParse, onTransformHtml, onFrameMount, onFrameReady, onBoundaryReached, onRelocate, onRelayout, onFrameDestroy, onLinkClick, onDestroy
 * - 🛡️ [장애 격리] 개별 모드 핸들러의 예외가 코어 또는 타 모드 실행을 중단시키지 않도록 보호
 * - ⚖️ [우선순위 정렬] priority(낮을수록 먼저 실행) 기반 실행 순서 제어 및 1회성(once) 훅 지원
 * - 🔀 [전파 제어] stopOnHandled 옵션으로 인터셉트 훅과 브로드캐스트 훅 분리
 * 파일 경로: web/ewb-js/core/HookBus.js
 * @module ewb-js/core/HookBus
 */

/**
 * 게임 모드(Mod)와 코어 엔진 사이의 라이프사이클 훅을 중계하는 버스 클래스
 */
export class HookBus {
    /**
     * @param {Object} [options={}]
     * @param {Object|null} [options.logger=null] - EngineLogger 또는 child 로거
     */
    constructor(options = {}) {
        this.logger = options.logger || null;
        /** @type {Map<string, Array<{ handler: Function, priority: number, once: boolean, name: string }>>} */
        this._hooks = new Map();
    }

    /**
     * 특정 라이프사이클 훅에 핸들러를 등록합니다.
     * @param {string} hookName - 훅 이름 (예: 'onFrameReady', 'onTransformHtml')
     * @param {Function} handler - 콜백 함수
     * @param {Object} [options={}]
     * @param {number} [options.priority=100] - 실행 우선순위 (작은 숫자가 먼저 실행)
     * @param {boolean} [options.once=false] - 1회 실행 후 자동 해제 여부
     * @param {string} [options.name='anonymous'] - 디버깅용 모드/핸들러 이름
     * @returns {() => void} 구독 해제 함수
     */
    on(hookName, handler, options = {}) {
        if (!hookName || typeof handler !== 'function') {
            return () => {};
        }

        const entry = {
            handler,
            priority: Number.isFinite(Number(options.priority)) ? Number(options.priority) : 100,
            once: Boolean(options.once),
            name: options.name || handler.name || 'anonymous'
        };

        if (!this._hooks.has(hookName)) {
            this._hooks.set(hookName, []);
        }

        const list = this._hooks.get(hookName);
        list.push(entry);
        list.sort((a, b) => a.priority - b.priority);

        return () => this.off(hookName, handler);
    }

    /**
     * 등록된 특정 핸들러를 제거합니다.
     * @param {string} hookName
     * @param {Function} handler
     */
    off(hookName, handler) {
        const list = this._hooks.get(hookName);
        if (!list) return;
        const next = list.filter((entry) => entry.handler !== handler);
        if (next.length > 0) {
            this._hooks.set(hookName, next);
        } else {
            this._hooks.delete(hookName);
        }
    }

    /**
     * 지정된 훅 또는 전체 훅을 초기화합니다.
     * @param {string} [hookName]
     */
    clear(hookName) {
        if (hookName) {
            this._hooks.delete(hookName);
        } else {
            this._hooks.clear();
        }
    }

    /**
     * 특정 훅에 등록된 핸들러 존재 여부를 확인합니다.
     * @param {string} hookName
     * @returns {boolean}
     */
    has(hookName) {
        const list = this._hooks.get(hookName);
        return Boolean(list && list.length > 0);
    }

    /**
     * 동기 훅을 순서대로 발행합니다. ('onRelocate', 'onRelayout', 'onFrameDestroy', 'onLinkClick', 'onDestroy' 등)
     * @param {string} hookName
     * @param {Object} [payload={}]
     * @param {Object} [options={}]
     * @param {boolean} [options.stopOnHandled=true] - true면 { handled: true } 반환 시 후속 핸들러 중단
     * @returns {{ handled: boolean }}
     */
    emitSync(hookName, payload = {}, options = {}) {
        const list = this._hooks.get(hookName);
        if (!list || list.length === 0) return { handled: false };

        const stopOnHandled = options.stopOnHandled !== false;
        const snapshot = [...list];
        let handled = false;

        for (const entry of snapshot) {
            if (entry.once) {
                this.off(hookName, entry.handler);
            }
            try {
                const res = entry.handler(payload);
                if (res && typeof res === 'object' && res.handled === true) {
                    handled = true;
                    if (stopOnHandled) break;
                }
            } catch (err) {
                this.logger?.warn?.(`⚠️ [HookBus:${hookName}] '${entry.name}' 동기 훅 예외 격리:`, err);
            }
        }

        return { handled };
    }

    /**
     * 비동기 훅을 순서대로 await 발행합니다.
     * @param {string} hookName
     * @param {Object} [payload={}]
     * @param {Object} [options={}]
     * @param {boolean} [options.stopOnHandled=true] - true면 { handled: true } 반환 시 후속 핸들러 중단
     * @returns {Promise<{ handled: boolean, [key: string]: any }>}
     */
    async emitAsync(hookName, payload = {}, options = {}) {
        const list = this._hooks.get(hookName);
        if (!list || list.length === 0) return { handled: false };

        const stopOnHandled = options.stopOnHandled !== false;
        const snapshot = [...list];
        let resultState = { handled: false };

        for (const entry of snapshot) {
            if (entry.once) {
                this.off(hookName, entry.handler);
            }
            try {
                const res = await entry.handler(payload);
                if (res && typeof res === 'object' && res.handled === true) {
                    resultState = { ...res, handled: true };
                    if (stopOnHandled) break;
                }
            } catch (err) {
                this.logger?.warn?.(`⚠️ [HookBus:${hookName}] '${entry.name}' 비동기 훅 예외 격리:`, err);
            }
        }

        return resultState;
    }

    /** 하위 호환용 emit 별칭 */
    emit(hookName, payload = {}, options = {}) {
        return this.emitSync(hookName, payload, options);
    }

    /**
     * 데이터 변환 파이프라인 훅을 순차 실행합니다. ('onTransformHtml' 등)
     * @template T
     * @param {string} hookName
     * @param {T} initialValue
     * @param {Object} [context={}]
     * @returns {Promise<T>}
     */
    async runTransform(hookName, initialValue, context = {}) {
        const list = this._hooks.get(hookName);
        if (!list || list.length === 0) return initialValue;

        const snapshot = [...list];
        let current = initialValue;

        for (const entry of snapshot) {
            if (entry.once) {
                this.off(hookName, entry.handler);
            }
            try {
                const nextValue = await entry.handler(current, context);
                if (nextValue !== undefined && nextValue !== null) {
                    if (typeof initialValue !== 'string' || typeof nextValue === 'string') {
                        current = nextValue;
                    }
                }
            } catch (err) {
                this.logger?.warn?.(`⚠️ [HookBus:${hookName}] '${entry.name}' 변환 훅 예외 격리 (이전 값 유지):`, err);
            }
        }

        return current;
    }
}