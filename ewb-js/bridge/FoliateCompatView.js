/**
 * 🔌 Foliate-View 호환 브릿지 Web Component 어댑터 (FoliateCompatView)
 * - ⚖️ [비교 테스트 지원] 기존 foliate-view와 동일한 메서드·속성·이벤트(load/relocate) 계약 제공
 * - 🛡️ [무충돌 등록] 기본 <ewb-compat-view> 태그로 동작해 기존 foliate-js와 동일 페이지 병행 비교 가능
 * - 🎯 [Phase 0 계약 준수] view.open(file|book), init, goTo, next(dist), prev(dist), search, renderer.* 지원
 * 파일 경로: web/ewb-js/bridge/FoliateCompatView.js
 * @module ewb-js/bridge/FoliateCompatView
 */

import { EwbEngine, EngineState } from '../core/EwbEngine.js';

/**
 * EwbEngine을 <foliate-view> 표면 규격으로 감싸는 호환 Web Component
 */
export class FoliateCompatView extends HTMLElement {
    static get observedAttributes() {
        return ['flow', 'max-column-count', 'max-inline-size', 'margin'];
    }

    constructor() {
        super();
        this._shadow = this.attachShadow({ mode: 'open' });
        this._hostEl = document.createElement('div');
        this._hostEl.id = 'ewb-compat-host';
        Object.assign(this._hostEl.style, {
            position: 'relative',
            width: '100%',
            height: '100%',
            overflow: 'hidden'
        });
        this._shadow.appendChild(this._hostEl);

        /** @type {EwbEngine|null} */
        this._engine = null;
        this._engineOptions = {};
        this._pendingCss = '';
        this.lastLocation = null;
        this.toc = [];
        this._bookProxy = null;

        this._rendererProxy = this._createRendererProxy();
    }

    /**
     * 외부 로거(예: debugManager) 및 EwbEngine 초기 옵션을 사전 설정합니다.
     * @param {Object} options
     */
    configure(options = {}) {
        this._engineOptions = { ...(options || {}) };
    }

    /** 현재 flow 속성 반환 */
    get flow() {
        return this.getAttribute('flow') || this._engineOptions.flow || 'paginated';
    }

    /** flow 속성 반영 */
    set flow(val) {
        const nextFlow = val === 'scrolled' ? 'scrolled' : 'paginated';
        if (this.getAttribute('flow') !== nextFlow) {
            this.setAttribute('flow', nextFlow);
        }
    }

    /** Foliate 호환 book 객체 반환 */
    get book() {
        return this._bookProxy;
    }

    /** Foliate 호환 renderer 프록시 반환 */
    get renderer() {
        return this._rendererProxy;
    }

    attributeChangedCallback(name, oldValue, newValue) {
        if (oldValue === newValue || !this._engine || this._engine.state !== EngineState.ACTIVE) {
            return;
        }
        this._syncAttributesToEngine();
    }

    /** @private */
    _syncAttributesToEngine() {
        if (!this._engine) return;
        const flow = this.getAttribute('flow') === 'scrolled' ? 'scrolled' : 'paginated';
        const maxCols = parseInt(this.getAttribute('max-column-count') || '0', 10);
        const pageSpread = maxCols === 1 ? 'single' : (maxCols === 2 ? 'double' : 'auto');
        this._engine.setLayoutOptions({ flow, pageSpread });
    }

    /** @private */
    _ensureEngine() {
        if (this._engine && !this._engine._isDestroyed) {
            return this._engine;
        }

        const flow = this.getAttribute('flow') === 'scrolled' ? 'scrolled' : 'paginated';
        const maxCols = parseInt(this.getAttribute('max-column-count') || '0', 10);
        const pageSpread = maxCols === 1 ? 'single' : (maxCols === 2 ? 'double' : 'auto');

        this._engine = new EwbEngine({
            ...this._engineOptions,
            container: this._hostEl,
            flow,
            pageSpread,
            userCss: this._pendingCss
        });

        this._engine.on('load', ({ detail }) => {
            this.dispatchEvent(new CustomEvent('load', {
                detail: { doc: detail.doc, index: detail.spineIndex },
                bubbles: true,
                composed: true
            }));
        });

        this._engine.on('relocate', ({ detail }) => {
            const mapped = this._mapLocationSnapshot(detail);
            this.lastLocation = mapped;
            this.dispatchEvent(new CustomEvent('relocate', {
                detail: mapped,
                bubbles: true,
                composed: true
            }));
        });

        return this._engine;
    }

    /** @private */
    _mapLocationSnapshot(detail) {
        if (!detail) return null;
        const total = Number(detail.totalPages || 1);
        const current = Number(detail.page || 0) + 1;

        let range = null;
        const doc = this._engine?.getActiveDocument?.();
        if (doc && detail.firstLine?.node) {
            try {
                range = doc.createRange();
                range.setStart(detail.firstLine.node, detail.firstLine.startOffset || 0);
                if (detail.lastLine?.node) {
                    range.setEnd(detail.lastLine.node, detail.lastLine.endOffset ?? detail.lastLine.startOffset ?? 0);
                } else {
                    range.collapse(true);
                }
            } catch (e) {}
        }

        return {
            index: detail.spineIndex,
            fraction: detail.fraction,
            cfi: detail.cfi || '',
            href: detail.href || '',
            tocItem: detail.tocItem || null,
            range,
            location: {
                current,
                total,
                page: detail.page,
                pages: total
            }
        };
    }

    /**
     * File/Blob 또는 이미 파싱된 Book 객체를 엽니다.
     * @param {File|Blob|Object} source
     */
    async open(source) {
        const engine = this._ensureEngine();
        const rawBook = await engine.open(source, { autoMount: false });
        this.toc = rawBook?.toc || [];
        this._bookProxy = this._wrapBookProxy(rawBook);
        return this._bookProxy;
    }

    /**
     * 초기 위치로 마운트합니다.
     * @param {Object} [params={}]
     */
    async init({ lastLocation = 0 } = {}) {
        if (!this._engine) return;
        await this._engine.goTo(lastLocation ?? 0, { behavior: 'instant' });
        this._engine._setState?.(EngineState.ACTIVE);
    }

    /**
     * 목표 위치(섹션 인덱스, CFI, href, { index, anchor })로 이동합니다.
     * @param {number|string|Object} target
     */
    async goTo(target) {
        if (!this._engine) return null;
        if (target && typeof target === 'object' && typeof target.anchor === 'function') {
            const loc = await this._engine.goTo(target.index ?? 0);
            const doc = this._engine.getActiveDocument();
            if (doc) {
                const el = target.anchor(doc);
                const frame = this._engine.getCurrentFrame();
                if (el && frame) frame.scrollToTarget(el, 'instant');
            }
            return loc;
        }
        return this._engine.goTo(target);
    }

    /** 다음 페이지 (또는 세로 모드 픽셀 거리 이동) */
    async next(distance) {
        if (!this._engine) return null;
        if (typeof distance === 'number' && distance > 0) {
            const res = this._engine.scrollByPixels(distance, 'instant');
            if (res.atBoundary === 'end') return this._engine.nextChapter();
            return res;
        }
        return this._engine.nextPage();
    }

    /** 이전 페이지 (또는 세로 모드 픽셀 거리 이동) */
    async prev(distance) {
        if (!this._engine) return null;
        if (typeof distance === 'number' && distance > 0) {
            const res = this._engine.scrollByPixels(-distance, 'instant');
            if (res.atBoundary === 'start') return this._engine.prevChapter();
            return res;
        }
        return this._engine.prevPage();
    }

    goRight() { return this.next(); }
    goLeft() { return this.prev(); }

    setStyles(cssText = '') {
        this._pendingCss = cssText || '';
        if (this._engine) {
            this._engine.setUserCss(this._pendingCss);
        }
    }

    getLocation() {
        return this.lastLocation;
    }

    /**
     * Foliate 규격 비동기 검색 제너레이터
     * @param {{ query: string }} params
     */
    async *search({ query } = {}) {
        if (!this._engine) return;
        for await (const hit of this._engine.search(query)) {
            yield {
                cfi: hit.cfi,
                excerpt: hit.excerpt,
                subitems: [{ cfi: hit.cfi, excerpt: hit.excerpt }]
            };
        }
        yield 'done';
    }

    /** 자원 정리 및 인스턴스 해제 */
    close() {
        if (this._engine) {
            this._engine.destroy();
            this._engine = null;
        }
        this._bookProxy = null;
        this.lastLocation = null;
        this.toc = [];
    }

    /** @private */
    _wrapBookProxy(rawBook) {
        if (!rawBook) return null;
        if (rawBook.__isEwbBookProxy) return rawBook;

        const sections = (rawBook.sections || []).map((sec) => ({
            ...sec,
            createURI: () => sec.href || '',
            createDocument: async () => {
                if (typeof sec.createDocument === 'function') return sec.createDocument();
                const html = typeof sec.loadResolvedHtml === 'function'
                    ? await sec.loadResolvedHtml()
                    : await sec.loadHtml();
                return new DOMParser().parseFromString(html, 'text/html');
            },
            load: async () => {
                if (typeof sec.load === 'function') return sec.load();
                const html = typeof sec.loadResolvedHtml === 'function'
                    ? await sec.loadResolvedHtml()
                    : await sec.loadHtml();
                return new DOMParser().parseFromString(html, 'text/html');
            }
        }));

        return {
            ...rawBook,
            __isEwbBookProxy: true,
            sections
        };
    }

    /** @private */
    _createRendererProxy() {
        const self = this;
        const containerProxy = {
            get scrollTop() {
                return self._engine?.getCurrentFrame()?.getMetrics()?.scrollPos || 0;
            },
            set scrollTop(val) {
                const scroller = self._engine?.getCurrentFrame()?.paginator?.getScrollElement?.();
                if (scroller) scroller.scrollTop = val;
            },
            get scrollHeight() {
                const scroller = self._engine?.getCurrentFrame()?.paginator?.getScrollElement?.();
                return scroller?.scrollHeight || 0;
            },
            get clientHeight() {
                return self._hostEl?.clientHeight || 0;
            },
            get clientWidth() {
                return self._hostEl?.clientWidth || 0;
            },
            scrollBy(optsOrX, y) {
                const delta = typeof optsOrX === 'object' ? (optsOrX.top || optsOrX.left || 0) : (y || optsOrX || 0);
                const behavior = typeof optsOrX === 'object' && optsOrX.behavior === 'smooth' ? 'smooth' : 'instant';
                self._engine?.scrollByPixels(delta, behavior);
            },
            scrollTo(optsOrX, y) {
                const scroller = self._engine?.getCurrentFrame()?.paginator?.getScrollElement?.();
                if (scroller) scroller.scrollTo(optsOrX, y);
            },
            style: this._hostEl.style
        };

        return {
            get index() { return self._engine?.getCurrentFrame()?.spineIndex ?? 0; },
            get page() { return self._engine?.getCurrentFrame()?.getMetrics()?.currentPage ?? 0; },
            get pages() { return self._engine?.getCurrentFrame()?.getMetrics()?.totalPages ?? 1; },
            get atStart() { return self._engine?.getCurrentFrame()?.getMetrics()?.atStart ?? true; },
            get atEnd() { return self._engine?.getCurrentFrame()?.getMetrics()?.atEnd ?? true; },
            get size() {
                const m = self._engine?.getViewportMetrics?.();
                return self.flow === 'scrolled' ? (m?.pageHeight || 0) : (m?.contentWidth || 0);
            },
            get start() { return self._engine?.getCurrentFrame()?.getMetrics()?.scrollPos ?? 0; },
            get viewSize() {
                const m = self._engine?.getCurrentFrame()?.getMetrics?.();
                return (m?.maxScrollPos || 0) + (this.size || 0);
            },
            get spread() { return (self._engine?.getViewportMetrics?.()?.columnCount || 1) === 2; },
            get columnCount() { return self._engine?.getViewportMetrics?.()?.columnCount || 1; },
            get scrollTop() { return containerProxy.scrollTop; },
            get shadowRoot() {
                return { getElementById: (id) => (id === 'container' ? containerProxy : null) };
            },
            getContents() {
                const frame = self._engine?.getCurrentFrame?.();
                return (frame && frame.doc) ? [{ index: frame.spineIndex, doc: frame.doc }] : [];
            },
            getAttribute: (k) => self.getAttribute(k),
            setAttribute: (k, v) => self.setAttribute(k, v),
            hasAttribute: (k) => self.hasAttribute(k),
            removeAttribute: (k) => self.removeAttribute(k),
            relayout: () => self._engine?.relayout(),
            render: () => self._engine?.relayout(),
            scrollBy: (dx, dy) => self._engine?.scrollByPixels(dy || dx || 0),
            scrollToAnchor: async (anchor) => {
                const frame = self._engine?.getCurrentFrame?.();
                if (!frame) return;
                if (anchor === 1) frame.goToEnd();
                else frame.goToPage(0, 'instant');
            },
            next: (dist) => self.next(dist),
            prev: (dist) => self.prev(dist)
        };
    }
}

/**
 * 호환 웹 컴포넌트를 브라우저에 등록합니다.
 * @param {string} [tagName='ewb-compat-view']
 */
export function registerCompatElement(tagName = 'ewb-compat-view') {
    if (typeof customElements !== 'undefined' && !customElements.get(tagName)) {
        customElements.define(tagName, FoliateCompatView);
    }
}

registerCompatElement('ewb-compat-view');