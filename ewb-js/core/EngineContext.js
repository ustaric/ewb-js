/**
 * 🏛️ EWB 게임 모드(Mod/Plugin)용 공식 API 집합소 (EngineContext)
 * - 🔌 [단일 창구] 외부 모드가 코어 내부를 직접 건드리지 않고 표준 API와 HookBus에만 의존하도록 격리
 * - 🧩 [API 레지스트리] registerApi / getApi로 추후 기능 확장 시 공식 API를 안전하게 추가·공유
 * - 🎨 [테마 & 컨테이너 개방] setTheme/getTheme 및 getContainer() 제공으로 외부 테마/HUD 모드 구현 지원
 * - 🔬 [순수 관측·비교 API] getLayoutSnapshot() 및 measurePureBaseline() 제공으로 코어 조판 비간섭 비교 계측 지원
 * - 📐 [개방형 좌표/프레임/CFI/잘림 계측] 가시 라인 측정, 잘림 실측, 검색, CFI 코덱, 슬롯 순회 및 추적형 ChapterFrame 팩토리 개방
 * 파일 경로: web/ewb-js/core/EngineContext.js
 * @module ewb-js/core/EngineContext
 */

import { ChapterFrame } from './ChapterFrame.js';

/**
 * 외부 모드(Plugin)에 전달되는 공식 엔진 API 집합소 클래스
 */
export class EngineContext {
    /**
     * @param {Object} engine - EwbEngine 인스턴스
     * @param {Object} hookBus - HookBus 중계소 인스턴스
     * @param {Object} logger - EngineLogger 인스턴스
     */
    constructor(engine, hookBus, logger) {
        this._engine = engine;
        this._hookBus = hookBus;
        this._logger = logger;
        /** @type {Map<string, Object>} */
        this._customApis = new Map();
    }

    // =========================================================================
    // 1. 중계소(HookBus) & 이벤트 · 모드 수명주기 연동
    // =========================================================================

    /**
     * 라이프사이클 훅을 등록합니다.
     * @param {string} hookName
     * @param {Function} handler
     * @param {Object} [options={}] - { priority, once, name }
     * @returns {() => void} 구독 해제 함수
     */
    onHook(hookName, handler, options = {}) {
        return this._hookBus.on(hookName, handler, options);
    }

    /** 등록된 라이프사이클 훅을 해제합니다. */
    offHook(hookName, handler) {
        this._hookBus.off(hookName, handler);
    }

    /** 엔진 표준 이벤트를 구독합니다. ('load', 'relocate', 'chapterChange', 'stateChange') */
    onEvent(eventName, listener) {
        return this._engine.on(eventName, listener);
    }

    /** 엔진 표준 이벤트 구독을 해제합니다. */
    offEvent(eventName, listener) {
        this._engine.off(eventName, listener);
    }

    /**
     * 장착된 특정 Mod를 이름 또는 원본 참조로 해제합니다.
     * @param {Function|Object|string} modOrName
     * @returns {boolean}
     */
    unuse(modOrName) {
        return this._engine?.unuse?.(modOrName) || false;
    }

    // =========================================================================
    // 2. 확장 API 레지스트리 (추후 신규 API 추가/모드 간 공유 창구)
    // =========================================================================

    /**
     * 외부 모드나 코어 확장이 공용 API 네임스페이스를 집합소에 공식 등록합니다.
     * @param {string} namespace - API 식별 이름 (예: 'translation', 'tts', 'diagnostics')
     * @param {Object} apiObject - 공개 메서드 묶음 객체
     */
    registerApi(namespace, apiObject) {
        if (!namespace || !apiObject || typeof apiObject !== 'object') return;
        if (this._customApis.has(namespace)) {
            this._logger?.warn?.(`[EngineContext] API 네임스페이스 '${namespace}'가 덮어쓰기 되었습니다.`);
        }
        this._customApis.set(namespace, apiObject);
    }

    /**
     * 등록된 커스텀 API 네임스페이스를 조회합니다.
     * @param {string} namespace
     * @returns {Object|null}
     */
    getApi(namespace) {
        return this._customApis.get(namespace) || null;
    }

    /**
     * 등록된 모든 커스텀 API 네임스페이스 목록을 반환합니다.
     * @returns {string[]}
     */
    listApis() {
        return Array.from(this._customApis.keys());
    }

    // =========================================================================
    // 3. 도서 메타 · 본문 검색 · 네비게이션 · 레이아웃 · 테마 제어 API
    // =========================================================================

    getState() { return this._engine?.state || 'DESTROYED'; }
    getContainer() { return this._engine?.getContainer?.() || null; }
    getBookMeta() { return this._engine?.getBookMeta?.() || null; }
    getToc() { return this._engine?.getToc?.() || []; }
    getSections() { return this._engine?.getSections?.() || []; }
    getCurrentLocation() { return this._engine?.getCurrentLocation?.() || null; }

    /**
     * 지정한 챕터(spineIndex)의 리소스 해석 완료 HTML 문자열을 로드합니다.
     * @param {number} spineIndex
     * @returns {Promise<string>}
     */
    loadChapterHtml(spineIndex) {
        return this._engine?.loadChapterHtml?.(spineIndex) || Promise.resolve('');
    }

    /**
     * 전체 책 본문 비동기 검색 제너레이터를 반환합니다.
     * @param {string} query
     * @returns {AsyncGenerator<{ spineIndex: number, cfi: string, excerpt: string }>}
     */
    search(query) {
        if (!this._engine || this._engine._isDestroyed) {
            return (async function* () {})();
        }
        return this._engine.search(query);
    }

    goTo(target, options) { return this._engine?.goTo?.(target, options); }
    goToPage(pageIndex, behavior, extraOptions) { return this._engine?.goToPage?.(pageIndex, behavior, extraOptions) || null; }
    goToEnd(options) { return this._engine?.goToEnd?.(options) || null; }
    scrollToTarget(target, behavior, extraOptions) { return this._engine?.scrollToTarget?.(target, behavior, extraOptions) || null; }
    nextPage(options) { return this._engine?.nextPage?.(options); }
    prevPage(options) { return this._engine?.prevPage?.(options); }
    nextChapter(options) { return this._engine?.nextChapter?.(options); }
    prevChapter(options) { return this._engine?.prevChapter?.(options); }
    scrollByPixels(deltaPx, behavior, extraOptions) { return this._engine?.scrollByPixels?.(deltaPx, behavior, extraOptions); }
    scrollByLines(lineCount, behavior, extraOptions) { return this._engine?.scrollByLines?.(lineCount, behavior, extraOptions); }
    relayout(options) { return this._engine?.relayout?.(options); }
    setLayoutOptions(partial) { return this._engine?.setLayoutOptions?.(partial); }
    getLayoutOptions() { return this._engine?.getLayoutOptions?.() || null; }
    getMargins() { return this._engine?.getMargins?.() || null; }
    setUserCss(cssText) { return this._engine?.setUserCss?.(cssText); }
    getUserCss() { return this._engine?.getUserCss?.() || ''; }

    /**
     * 본문 배경색·글자색·링크색·선택색 테마를 userCss와 독립적으로 즉시 적용합니다.
     * @param {{ backgroundColor?: string, textColor?: string, linkColor?: string, selectionColor?: string }|null} [theme=null]
     */
    setTheme(theme = null) { this._engine?.setTheme?.(theme); }

    /**
     * 현재 적용 중인 테마 색상 객체를 반환합니다.
     * @returns {{ backgroundColor: string, textColor: string, linkColor: string, selectionColor: string }|null}
     */
    getTheme() { return this._engine?.getTheme?.() || null; }

    /**
     * 현재 생성된 테마 CSS 문자열을 반환합니다.
     * @returns {string}
     */
    getThemeCss() { return this._engine?.getThemeCss?.() || ''; }

    // =========================================================================
    // 4. CFI 인코딩·디코딩 & DOM · 라인 좌표 · 잘림 계측 · 독립 프레임 확장 API
    // =========================================================================

    /**
     * DOM Range로부터 표준 EPUB CFI 문자열을 생성합니다.
     * @param {number} spineIndex
     * @param {Range} range
     * @param {Document} [doc]
     * @returns {string}
     */
    encodeCfi(spineIndex, range, doc) {
        return this._engine?.encodeCfi?.(spineIndex, range, doc) || '';
    }

    /**
     * EPUB CFI 문자열을 구조 객체로 파싱합니다.
     * @param {string} cfiString
     * @returns {Object|null}
     */
    decodeCfi(cfiString) {
        return this._engine?.decodeCfi?.(cfiString) || null;
    }

    /**
     * EPUB CFI 문자열을 대상 Document의 DOM Range로 복원합니다.
     * @param {string} cfiString
     * @param {Document} [doc]
     * @param {Object} [options={}]
     * @returns {Range|null}
     */
    resolveCfi(cfiString, doc, options = {}) {
        return this._engine?.resolveCfi?.(cfiString, doc, options) || null;
    }

    getCurrentFrame() { return this._engine?.getCurrentFrame?.() || null; }
    getFrames() { return this._engine?.getFrames?.() || { prev: null, current: null, next: null }; }
    forEachFrame(callback) { this._engine?.forEachFrame?.(callback); }
    getActiveDocument() { return this._engine?.getActiveDocument?.() || null; }
    getViewportMetrics() { return this._engine?.getViewportMetrics?.() || null; }

    /**
     * 현재 활성 프레임의 상·하단 경계 텍스트 잘림 실측치, 가시 줄 수, 문단 수 및 마스킹 적용량을 반환합니다.
     * @returns {Object|null}
     */
    getClippingMetrics() {
        return this._engine?.getClippingMetrics?.() || null;
    }

    /**
     * 지정 프레임(기본: 현재 활성 프레임)의 조판·스타일·물리 치수 스냅샷 복사본을 조회합니다.
     * @param {ChapterFrame|null} [frame=this.getCurrentFrame()]
     * @param {Object} [options={}]
     * @param {boolean} [options.forceCapture=false] - true면 캐시를 무시하고 즉시 새로 계측
     * @returns {{ initial: Object|null, last: Object|null }|null}
     */
    getLayoutSnapshot(frame = this.getCurrentFrame(), options = {}) {
        if (!frame || frame.isDestroyed || typeof frame.getLayoutSnapshot !== 'function') {
            return null;
        }
        return frame.getLayoutSnapshot(options);
    }

    /**
     * HookBus(플러그인), userCss, themeCss를 전혀 개입시키지 않은 순수 엔진 기준(Baseline)으로
     * 지정 챕터를 백그라운드에서 1회 실측한 뒤 프레임을 즉시 파괴하여 비교 기준 데이터를 반환합니다.
     * @param {number} spineIndex - 실측할 챕터 인덱스
     * @param {Object} [pureLayoutOptions={}] - 보정 전 원시 margins({ top, bottom, left, right }) 등 순수 레이아웃 옵션
     * @returns {Promise<{
     *   spineIndex: number,
     *   snapshot: { initial: Object|null, last: Object|null }|null,
     *   metrics: Object|null,
     *   clipping: Object|null,
     *   viewportMetrics: Object|null,
     *   layoutOptions: Object
     * }|null>}
     */
    async measurePureBaseline(spineIndex, pureLayoutOptions = {}) {
        if (!this._engine || this._engine._isDestroyed) return null;

        const sections = this.getSections();
        if (!Array.isArray(sections) || sections.length === 0) return null;

        const targetSpine = Math.min(Math.max(0, Number(spineIndex) || 0), sections.length - 1);
        const href = sections[targetSpine]?.href || '';

        const baseOptions = this.getLayoutOptions() || {};
        const { margins, slotMode, ...restPure } = pureLayoutOptions || {};
        const mergedOptions = {
            ...baseOptions,
            ...restPure,
            backgroundColor: 'transparent'
        };
        delete mergedOptions.slotMode;

        if (margins && typeof margins === 'object') {
            if (margins.top !== undefined) mergedOptions.marginTop = Number(margins.top);
            if (margins.bottom !== undefined) mergedOptions.marginBottom = Number(margins.bottom);
            if (margins.left !== undefined) mergedOptions.marginLeft = Number(margins.left);
            if (margins.right !== undefined) mergedOptions.marginRight = Number(margins.right);
        }

        const baselineFrame = new ChapterFrame({
            spineIndex: targetSpine,
            href,
            container: this._engine.container,
            hookBus: null,
            logger: null,
            isBaseline: true
        });
        this._engine._trackExternalFrame?.(baselineFrame);

        try {
            await baselineFrame.mount({
                htmlSource: () => this.loadChapterHtml(targetSpine),
                layoutOptions: mergedOptions,
                userCss: '',
                active: false,
                initialPosition: 'start'
            });

            if (baselineFrame.isDestroyed || this._engine._isDestroyed) {
                return null;
            }

            const snapshot = baselineFrame.getLayoutSnapshot({ forceCapture: true });
            const metrics = baselineFrame.getMetrics();
            const clipping = baselineFrame.getClippingMetrics();
            const viewportMetrics = baselineFrame.paginator?.metrics
                ? { ...baselineFrame.paginator.metrics }
                : null;

            return {
                spineIndex: targetSpine,
                snapshot,
                metrics,
                clipping,
                viewportMetrics,
                layoutOptions: mergedOptions
            };
        } catch (err) {
            this._logger?.warn?.(`[EngineContext:measurePureBaseline] 순수 기준 측정 예외 (spine:${targetSpine}):`, err);
            return null;
        } finally {
            try {
                if (!baselineFrame.isDestroyed) baselineFrame.destroy();
            } catch (e) {}
            try {
                this._engine?._externalFrames?.delete?.(baselineFrame);
            } catch (e) {}
        }
    }

    getVisibleLines(options = {}) {
        return this._engine?.getCurrentFrame?.()?.getVisibleLines?.(options) || [];
    }

    getFirstVisibleLine(options = {}) {
        return this._engine?.getCurrentFrame?.()?.getFirstVisibleLine?.(options) || null;
    }

    getLastVisibleLine(options = {}) {
        return this._engine?.getCurrentFrame?.()?.getLastVisibleLine?.(options) || null;
    }

    /**
     * 커스텀 슬롯/미리보기 모드가 독립 ChapterFrame을 직접 생성할 수 있는 공식 팩토리
     * (엔진이 수명주기를 추적해 engine.destroy() 시 자동 회수)
     * @param {number} spineIndex
     * @returns {ChapterFrame|null}
     */
    createChapterFrame(spineIndex) {
        if (!this._engine || this._engine._isDestroyed) return null;
        const sections = this.getSections();
        const frame = new ChapterFrame({
            spineIndex,
            href: sections?.[spineIndex]?.href || '',
            container: this._engine.container,
            hookBus: this._hookBus,
            logger: this._logger
        });
        this._engine._trackExternalFrame?.(frame);
        return frame;
    }

    /**
     * 모드 전용 스코프 로거를 발급합니다.
     * @param {string} scopeName
     * @returns {Object}
     */
    createLogger(scopeName) {
        return this._logger?.child?.(scopeName) || console;
    }
}