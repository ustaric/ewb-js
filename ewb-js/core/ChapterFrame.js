/**
 * 🖼️ 단일 챕터 독립 iframe 생명주기 및 사전 조판 완결 단위 (ChapterFrame)
 * - 🏛️ [상태 머신] IDLE ➔ MOUNTING ➔ RENDERING ➔ READY ➔ DESTROYED
 * - ⚡ [사전 완결 대기] HTML 주입, 훅, 스타일, 웹폰트, 이미지, Spacer까지 100% 끝난 readyPromise 제공
 * - 🎨 [테마 계층 분리] 코어 조판(#ewb-core-layout-style) / 사용자 스타일(#ewb-user-style) / 테마(#ewb-theme-style) 독립 주입
 * - 📱 [네이티브 스크롤 중계] scrolled 모드 시 iframe 네이티브 스크롤 허용 및 정착(140ms) 후 1회 onNativeScrollEnd 발행
 * - 🔬 [순수 조판 추적] 1차(폰트·정착 전) ➔ 최종 조판·relayout 스냅샷 비교 및 활성/프리로드 그룹 분리 출력
 * - 📐 [스냅샷 관측 API] getLayoutSnapshot()으로 ewb 로거 OFF 상태에서도 현재 조판 스냅샷 읽기 전용 제공
 * - 🔬 [잘림·문단 계측 & 하단 마스킹] getClippingMetrics() 및 scrolled 모드 하단 걸침 줄 clip-path 보정 제공
 * - 🔗 [내부 앵커 중계] 문서 내 <a href> 클릭 시 onLinkClick 훅 발행으로 커스텀/기본 내비게이션 연동
 * - 🛡️ [CFI 무결성 보존] 각 챕터가 독립 iframe Document를 유지해 DOM 트리가 합쳐지지 않음
 * - 🧹 [100% 자원 회수] destroy() 시 onFrameDestroy 알림 후 Blob URL, AbortController, PaginatorLayout, iframe 일괄 정리
 * 파일 경로: web/ewb-js/core/ChapterFrame.js
 * @module ewb-js/core/ChapterFrame
 */

import { PaginatorLayout } from '../layout/PaginatorLayout.js';
import {
    calculateLayoutMetrics,
    collectVisibleTextLines,
    getFirstVisibleLine,
    getLastVisibleLine
} from '../layout/ViewportSnap.js';
import {
    captureLayoutSnapshot,
    createBufferedLayoutLogger,
    emitPureLayoutReport
} from '../utils/LayoutTraceReporter.js';

export const FrameState = {
    IDLE: 'IDLE',
    MOUNTING: 'MOUNTING',
    RENDERING: 'RENDERING',
    READY: 'READY',
    FAILED: 'FAILED',
    DESTROYED: 'DESTROYED'
};

const USER_STYLE_ID = 'ewb-user-style';
const THEME_STYLE_ID = 'ewb-theme-style';
const NATIVE_SCROLL_SETTLE_MS = 140;

/**
 * 지정된 시간(ms) 후 무조건 resolve되는 안전 타임아웃 프로미스
 * @param {number} ms
 * @returns {Promise<'timeout'>}
 */
function waitTimeout(ms) {
    return new Promise((resolve) => setTimeout(() => resolve('timeout'), ms));
}

/**
 * 2회 requestAnimationFrame 페인트 안정화 대기
 * @param {Window} [win=window]
 * @returns {Promise<void>}
 */
function waitTwoFrames(win = window) {
    const raf = (win && typeof win.requestAnimationFrame === 'function')
        ? win.requestAnimationFrame.bind(win)
        : window.requestAnimationFrame.bind(window);
    return new Promise((resolve) => raf(() => raf(() => resolve())));
}

/**
 * 조판 스냅샷 객체를 읽기 전용 반환용으로 안전 복사합니다.
 * @param {Object|null} snapshot
 * @returns {Object|null}
 */
function cloneLayoutSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return null;
    return {
        ...snapshot,
        metrics: snapshot.metrics ? { ...snapshot.metrics } : null,
        pagination: snapshot.pagination ? { ...snapshot.pagination } : null,
        styles: snapshot.styles ? { ...snapshot.styles } : null,
        dom: snapshot.dom ? { ...snapshot.dom } : null,
        clipping: snapshot.clipping ? { ...snapshot.clipping } : null
    };
}

/**
 * 단일 챕터(spineIndex)의 iframe 렌더링과 조판을 소유하는 독립 클래스
 */
export class ChapterFrame {
    /**
     * @param {Object} options
     * @param {number} options.spineIndex - 챕터 인덱스 (0-based)
     * @param {string} [options.href=''] - 챕터 원본 href 경로
     * @param {HTMLElement} options.container - 마운트할 부모 DOM 컨테이너
     * @param {Object|null} [options.hookBus=null] - HookBus 중계소 인스턴스
     * @param {Object|null} [options.logger=null] - EngineLogger 또는 child 로거
     * @param {boolean} [options.isBaseline=false] - 순수 엔진 Baseline 계측용 임시 프레임 여부
     */
    constructor({ spineIndex, href = '', container, hookBus = null, logger = null, isBaseline = false } = {}) {
        this.spineIndex = Number(spineIndex ?? 0);
        this.href = href;
        this.container = container;
        this.hookBus = hookBus;
        this.logger = logger;
        this.isBaseline = Boolean(isBaseline);

        this.state = FrameState.IDLE;
        this.isActive = false;
        this.isDestroyed = false;

        /** @type {HTMLIFrameElement|null} */
        this.iframe = null;
        /** @type {Document|null} */
        this.doc = null;
        /** @type {PaginatorLayout|null} */
        this.paginator = null;

        this._blobUrl = null;
        this._mountToken = 0;
        this._abortController = new AbortController();
        this._readyPromise = null;
        this._userCss = '';
        this._themeCss = '';
        this._lastLayoutOptions = {};
        this._maskedBottomPx = 0;

        this._suppressNativeScrollUntil = 0;
        this._nativeScrollSettleTimer = null;

        this._isMountingPipeline = false;
        this._layoutLogChannel = null;
        this._initialLayoutSnapshot = null;
        this._lastLayoutSnapshot = null;
    }

    /**
     * 챕터 HTML 소스를 iframe에 로드하고, 스타일·폰트·이미지·Spacer까지 100% 렌더링 완료합니다.
     * @param {Object} params
     * @param {string|(() => Promise<string>)} params.htmlSource - 정제 전 XHTML/HTML 문자열 또는 로더 함수
     * @param {Object} [params.layoutOptions={}] - ViewportSnap 규격 옵션 + flow + transition
     * @param {string} [params.userCss=''] - 사용자 테마/폰트 오버라이드 CSS
     * @param {boolean} [params.active=false] - 즉시 전면 활성화 여부
     * @param {'start'|'end'} [params.initialPosition='start'] - 준비 완료 후 초기 안착 위치
     * @returns {Promise<ChapterFrame>}
     */
    mount({
        htmlSource,
        layoutOptions = {},
        userCss = '',
        active = false,
        initialPosition = 'start'
    } = {}) {
        if (this.isDestroyed) {
            return Promise.reject(new Error(`ChapterFrame(${this.spineIndex}) is already destroyed`));
        }
        if (this._readyPromise) {
            return this._readyPromise;
        }

        const token = ++this._mountToken;
        this._userCss = userCss || '';
        this._lastLayoutOptions = { ...layoutOptions };
        this.isActive = Boolean(active);

        this._readyPromise = this._executeMountPipeline(token, htmlSource, layoutOptions, initialPosition);
        return this._readyPromise;
    }

    /**
     * 실제 비동기 마운트·조판·대기 파이프라인 실행기
     * @private
     */
    async _executeMountPipeline(token, htmlSource, layoutOptions, initialPosition) {
        try {
            this.state = FrameState.MOUNTING;

            // 1. HTML 확보 및 onTransformHtml 훅 실행
            let rawHtml = typeof htmlSource === 'function' ? await htmlSource() : String(htmlSource || '');
            if (!this._isValidMount(token)) return this;

            if (this.hookBus && typeof this.hookBus.runTransform === 'function') {
                rawHtml = await this.hookBus.runTransform('onTransformHtml', rawHtml, {
                    spineIndex: this.spineIndex,
                    href: this.href,
                    frame: this
                });
                if (!this._isValidMount(token)) return this;
            }

            // 2. 실측 크기 기반 iframe 생성 (display: none 금지)
            const initialMetrics = calculateLayoutMetrics(this._lastLayoutOptions);
            this._createIframeElement(initialMetrics, this._lastLayoutOptions);

            // 3. Blob URL로 XHTML/HTML 문서 로드 (CSP self/blob 준수)
            const isXhtml = /^\s*(<\?xml|<!DOCTYPE\s+html[^>]*XHTML)/i.test(rawHtml)
                || rawHtml.includes('http://www.w3.org/1999/xhtml');
            const mimeType = isXhtml ? 'application/xhtml+xml;charset=utf-8' : 'text/html;charset=utf-8';
            const blob = new Blob([rawHtml], { type: mimeType });
            this._blobUrl = URL.createObjectURL(blob);

            await this._loadIframeUrl(this._blobUrl, token);
            if (!this._isValidMount(token)) return this;

            this.doc = this.iframe.contentDocument || this.iframe.contentWindow?.document || null;
            if (!this.doc || !this.doc.body) {
                throw new Error(`ChapterFrame(${this.spineIndex}) failed to acquire iframe document`);
            }

            // 4. 사용자 스타일, 테마 스타일, 내부 링크 클릭 중계, 네이티브 스크롤 감지 및 onFrameMount 훅 주입
            this.state = FrameState.RENDERING;
            this.setUserStyle(this._userCss);
            this.setThemeStyle(this._themeCss);
            this._bindLinkClickListener();
            this._bindNativeScrollListener();

            if (this.hookBus && typeof this.hookBus.emitAsync === 'function') {
                await this.hookBus.emitAsync('onFrameMount', {
                    spineIndex: this.spineIndex,
                    href: this.href,
                    doc: this.doc,
                    frame: this
                }, { stopOnHandled: false });
                if (!this._isValidMount(token)) return this;
            }

            // 5. 1차 레이아웃 조판 (웹폰트·이미지 정착 전 기준 스냅샷 캡처)
            this._isMountingPipeline = true;
            this._layoutLogChannel = createBufferedLayoutLogger(
                this.logger,
                this,
                () => this._isMountingPipeline || !this.isActive
            );
            this.paginator = new PaginatorLayout(this.doc, {
                logger: this._layoutLogChannel.logger || this.logger
            });
            this._markProgrammaticScroll(120);
            this.paginator.applyLayout(this._lastLayoutOptions);
            this._initialLayoutSnapshot = captureLayoutSnapshot(this, 'initial_pre_font', this.logger);

            // 6. 웹폰트 및 이미지 디코딩 완료 대기 (안전 타임아웃 포함)
            await this._waitForFontsAndImages(token);
            if (!this._isValidMount(token)) return this;

            // 7. 페인트 안정화 후 최신 레이아웃 옵션으로 박스·Spacer·페이지 수 최종 재확정
            await waitTwoFrames(this.iframe.contentWindow || window);
            if (!this._isValidMount(token)) return this;

            const finalOptions = this._lastLayoutOptions;
            const finalMetrics = calculateLayoutMetrics(finalOptions);
            this._applyIframeBoxStyles(this.iframe, finalMetrics, finalOptions);
            this._syncScrollingAttribute(finalOptions.flow);
            this._markProgrammaticScroll(120);
            const finalLayout = this.paginator.applyLayout(finalOptions);

            if (initialPosition === 'end') {
                this.paginator.goToEnd();
            } else {
                this.paginator.goToPage(0, 'instant');
            }
            this.syncViewportClipMask({ enabled: true });

            this.state = FrameState.READY;
            this._isMountingPipeline = false;

            const finalSnapshot = captureLayoutSnapshot(this, 'final_settled', this.logger);
            const bufferedLogs = this._layoutLogChannel?.drain?.() || [];
            this._lastLayoutSnapshot = finalSnapshot;

            if (this.isActive) {
                this.logger?.trace?.({
                    scope: 'ChapterFrame',
                    action: 'frameReady',
                    caller: 'ChapterFrame:mount',
                    state: this.state,
                    delta: `spine=${this.spineIndex}, pages=${finalLayout.totalPages}`,
                    result: `active=${this.isActive}, initPos=${initialPosition}`
                });
            }

            emitPureLayoutReport({
                logger: this.logger,
                snapshot: finalSnapshot,
                prevSnapshot: this._initialLayoutSnapshot,
                bufferedLogs,
                trigger: 'mount'
            });

            if (this.hookBus && typeof this.hookBus.emitAsync === 'function') {
                await this.hookBus.emitAsync('onFrameReady', {
                    spineIndex: this.spineIndex,
                    href: this.href,
                    doc: this.doc,
                    frame: this,
                    pagination: this.getMetrics()
                }, { stopOnHandled: false });
            }

            return this;
        } catch (err) {
            this._isMountingPipeline = false;
            if (!this.isDestroyed) {
                this.state = FrameState.FAILED;
                this.logger?.error?.(`❌ [ChapterFrame:${this.spineIndex}] 마운트 실패:`, err);
            }
            throw err;
        }
    }

    /**
     * 문서 내 <a href> 클릭을 감지해 HookBus('onLinkClick')로 중계합니다.
     * @private
     */
    _bindLinkClickListener() {
        if (!this.doc || !this.hookBus || typeof this.hookBus.emitSync !== 'function') return;
        this.doc.addEventListener('click', (event) => {
            const targetEl = event.target?.nodeType === 3 ? event.target.parentElement : event.target;
            const anchor = targetEl?.closest?.('a[href]');
            if (!anchor) return;

            const rawHref = anchor.getAttribute('href') || '';
            if (!rawHref) return;

            const isExternal = /^(https?:|mailto:|tel:)/i.test(rawHref);
            const res = this.hookBus.emitSync('onLinkClick', {
                spineIndex: this.spineIndex,
                chapterHref: this.href,
                href: rawHref,
                anchor,
                isExternal,
                event,
                doc: this.doc,
                frame: this
            }, { stopOnHandled: true });

            if (res?.handled && !event.defaultPrevented) {
                event.preventDefault();
            }
        }, { signal: this._abortController.signal });
    }

    /**
     * scrolled 모드에서 사용자 네이티브 스크롤을 감지해 스크롤 중 마스킹을 즉시 해제하고 정착 후 1회만 onNativeScrollEnd를 발행합니다.
     * @returns {void}
     * @private
     */
    _bindNativeScrollListener() {
        if (!this.doc) return;
        this.doc.addEventListener('scroll', () => {
            if (this.isDestroyed || this.isBaseline || !this.isActive) return;
            if (this.paginator?.flow !== 'scrolled' && this._lastLayoutOptions?.flow !== 'scrolled') return;
            if (Date.now() < this._suppressNativeScrollUntil) return;

            this._clearClipMaskFast();

            if (this._nativeScrollSettleTimer) {
                clearTimeout(this._nativeScrollSettleTimer);
            }
            this._nativeScrollSettleTimer = setTimeout(() => {
                this._nativeScrollSettleTimer = null;
                if (this.isDestroyed || this.isBaseline || !this.isActive) return;
                if (this.paginator?.flow !== 'scrolled') return;
                if (Date.now() < this._suppressNativeScrollUntil) return;

                const stats = this.getMetrics();
                this.logger?.trace?.({
                    scope: 'ChapterFrame',
                    action: 'nativeScrollEnd',
                    caller: 'ChapterFrame:_bindNativeScrollListener',
                    state: this.paginator.flow,
                    delta: `spine=${this.spineIndex}, scrollPos=${stats.scrollPos.toFixed(1)}px, page=${stats.currentPage + 1}/${stats.totalPages}`,
                    result: 'emit onNativeScrollEnd'
                });

                if (this.hookBus && typeof this.hookBus.emitSync === 'function') {
                    this.hookBus.emitSync('onNativeScrollEnd', {
                        spineIndex: this.spineIndex,
                        frame: this
                    }, { stopOnHandled: false });
                }
            }, NATIVE_SCROLL_SETTLE_MS);
        }, { capture: true, passive: true, signal: this._abortController.signal });
    }

    /**
     * 프로그래매틱 scrollTo 호출 직후 발생하는 브라우저 비동기 scroll 이벤트를 억제해 중복 relocate를 방지합니다.
     * @param {number} [durationMs=120] - 억제 유지 시간(ms)
     * @returns {void}
     * @private
     */
    _markProgrammaticScroll(durationMs = 120) {
        const until = Date.now() + Math.max(0, Number(durationMs) || 0);
        if (until > this._suppressNativeScrollUntil) {
            this._suppressNativeScrollUntil = until;
        }
        if (this._nativeScrollSettleTimer) {
            clearTimeout(this._nativeScrollSettleTimer);
            this._nativeScrollSettleTimer = null;
        }
    }

    /**
     * 네이티브 스크롤 중 DOM 라인 실측 없이 하단 clipPath 마스킹만 O(1) 비용으로 즉시 해제합니다.
     * @returns {void}
     * @private
     */
    _clearClipMaskFast() {
        if (this._maskedBottomPx > 0 && this.iframe && !this.isDestroyed) {
            this._maskedBottomPx = 0;
            this.iframe.style.clipPath = 'none';
        }
    }

    /**
     * 대기 중인 네이티브 스크롤 정착 타이머를 취소합니다.
     * @returns {void}
     * @private
     */
    _clearNativeScrollSettleTimer() {
        if (this._nativeScrollSettleTimer) {
            clearTimeout(this._nativeScrollSettleTimer);
            this._nativeScrollSettleTimer = null;
        }
    }

    /**
     * 현재 flow 모드에 맞춰 iframe의 scrolling 속성을 동기화합니다.
     * @param {'paginated'|'scrolled'} [flow] - 현재 조판 흐름 모드
     * @returns {void}
     * @private
     */
    _syncScrollingAttribute(flow) {
        if (!this.iframe || this.isDestroyed) return;
        const nextScrolling = flow === 'scrolled' ? 'auto' : 'no';
        if (this.iframe.getAttribute('scrolling') !== nextScrolling) {
            this.iframe.setAttribute('scrolling', nextScrolling);
        }
    }

    /**
     * 비동기 작업 유효성 검증 (파괴 여부 및 토큰 일치)
     * @private
     */
    _isValidMount(token) {
        return !this.isDestroyed && this._mountToken === token;
    }

    /**
     * 조판 치수에 맞는 iframe 엘리먼트를 생성하고 컨테이너에 부착합니다.
     * @private
     */
    _createIframeElement(metrics, layoutOptions) {
        if (this.iframe) {
            try { this.iframe.remove(); } catch (e) {}
        }

        const iframe = document.createElement('iframe');
        iframe.className = 'ewb-chapter-frame';
        iframe.dataset.spineIndex = String(this.spineIndex);
        if (this.isBaseline) {
            iframe.dataset.ewbBaseline = 'true';
        }
        iframe.setAttribute('scrolling', layoutOptions?.flow === 'scrolled' ? 'auto' : 'no');

        this._applyIframeBoxStyles(iframe, metrics, layoutOptions);
        this._syncVisibilityStyles(iframe, this.isActive);

        this.iframe = iframe;
        this.container.appendChild(iframe);
    }

    /**
     * iframe 외곽 박스 크기 및 여백 스타일을 반영합니다. (챕터 스왑 시 즉각 전환을 위해 transition 비활성)
     * @param {HTMLIFrameElement} iframe - 대상 iframe 엘리먼트
     * @param {Object} metrics - 계산된 레이아웃 메트릭
     * @param {Object} [layoutOptions={}] - 레이아웃 옵션 객체
     * @returns {void}
     * @private
     */
    _applyIframeBoxStyles(iframe, metrics, layoutOptions = {}) {
        const bgColor = layoutOptions.backgroundColor || 'transparent';
        Object.assign(iframe.style, {
            position: 'absolute',
            top: `${metrics.paddingTop}px`,
            left: `${metrics.paddingLeft}px`,
            width: `${metrics.contentWidth}px`,
            height: `${metrics.pageHeight}px`,
            border: 'none',
            margin: '0',
            padding: '0',
            background: bgColor,
            boxSizing: 'border-box',
            transition: 'none'
        });
    }

    /**
     * 활성화(전면 표시) vs 백그라운드 대기 스타일을 동기화합니다. (display: none 미사용)
     * @private
     */
    _syncVisibilityStyles(iframe, active) {
        if (!iframe) return;
        if (active) {
            iframe.style.zIndex = '2';
            iframe.style.opacity = '1';
            iframe.style.visibility = 'visible';
            iframe.style.pointerEvents = 'auto';
            iframe.removeAttribute('aria-hidden');
        } else {
            iframe.style.zIndex = '1';
            iframe.style.opacity = '0';
            iframe.style.visibility = 'hidden';
            iframe.style.pointerEvents = 'none';
            iframe.setAttribute('aria-hidden', 'true');
        }
    }

    /**
     * Blob URL을 iframe에 로드하고 완료까지 대기합니다.
     * @private
     */
    _loadIframeUrl(url, token) {
        return new Promise((resolve, reject) => {
            if (!this.iframe || !this._isValidMount(token)) {
                reject(new Error('Invalid mount state'));
                return;
            }

            const onLoad = () => {
                cleanup();
                resolve();
            };
            const onError = () => {
                cleanup();
                reject(new Error(`Failed to load iframe blob for spine ${this.spineIndex}`));
            };
            const cleanup = () => {
                this.iframe?.removeEventListener('load', onLoad);
                this.iframe?.removeEventListener('error', onError);
            };

            this.iframe.addEventListener('load', onLoad, { once: true, signal: this._abortController.signal });
            this.iframe.addEventListener('error', onError, { once: true, signal: this._abortController.signal });
            this.iframe.src = url;
        });
    }

    /**
     * 문서 내 웹폰트 및 이미지 디코딩 완료를 유한 시간 내에 대기합니다.
     * @private
     */
    async _waitForFontsAndImages(token) {
        if (!this.doc || !this._isValidMount(token)) return;

        if (this.doc.fonts && this.doc.fonts.ready) {
            await Promise.race([
                this.doc.fonts.ready.catch(() => {}),
                waitTimeout(400)
            ]);
            if (!this._isValidMount(token)) return;
        }

        const imgs = Array.from(this.doc.querySelectorAll('img'));
        if (imgs.length > 0) {
            const imgPromises = imgs.slice(0, 12).map((img) => {
                if (img.complete) {
                    return typeof img.decode === 'function' ? img.decode().catch(() => {}) : Promise.resolve();
                }
                return new Promise((res) => {
                    img.addEventListener('load', res, { once: true, signal: this._abortController.signal });
                    img.addEventListener('error', res, { once: true, signal: this._abortController.signal });
                });
            });
            await Promise.race([Promise.all(imgPromises), waitTimeout(500)]);
        }
    }

    /**
     * 사용자 폰트/문단 CSS를 주입하거나 갱신합니다.
     * @param {string} cssText
     */
    setUserStyle(cssText = '') {
        this._userCss = cssText || '';
        if (!this.doc || this.isDestroyed) return;

        const head = this.doc.head || this.doc.documentElement;
        let styleEl = this.doc.getElementById(USER_STYLE_ID);
        if (!styleEl) {
            styleEl = this.doc.createElement('style');
            styleEl.id = USER_STYLE_ID;
            const themeEl = this.doc.getElementById(THEME_STYLE_ID);
            if (themeEl) {
                head.insertBefore(styleEl, themeEl);
            } else {
                head.appendChild(styleEl);
            }
        }
        styleEl.textContent = this._userCss;
    }

    /**
     * 테마 전용 색상 오버라이드 CSS를 주입하거나 갱신합니다. (#ewb-user-style 뒤에 위치해 색상만 독립 제어)
     * @param {string} [cssText='']
     */
    setThemeStyle(cssText = '') {
        this._themeCss = cssText || '';
        if (!this.doc || this.isDestroyed) return;

        const head = this.doc.head || this.doc.documentElement;
        let styleEl = this.doc.getElementById(THEME_STYLE_ID);
        if (!styleEl) {
            styleEl = this.doc.createElement('style');
            styleEl.id = THEME_STYLE_ID;
            head.appendChild(styleEl);
        }
        styleEl.textContent = this._themeCss;
    }

    /**
     * iframe 외곽 배경색만 재조판 없이 즉시 갱신합니다.
     * @param {string} [bgColor='transparent']
     */
    setBackgroundColor(bgColor = 'transparent') {
        const nextBg = bgColor || 'transparent';
        this._lastLayoutOptions.backgroundColor = nextBg;
        if (this.iframe && !this.isDestroyed) {
            this.iframe.style.background = nextBg;
        }
    }

    /**
     * scrolled 모드 페이지 정지 시 하단 경계에 반쯤 걸친 줄을 시각적으로 가립니다.
     * - paginated 모드, 걸침 줄 없음, 자유 픽셀 스크롤 또는 smooth 애니메이션 중에는 즉시 해제됩니다.
     * @param {Object} [options={}]
     * @param {boolean} [options.enabled=true] - 마스킹 활성 여부
     * @returns {number} 적용된 하단 마스킹 높이(px)
     */
    syncViewportClipMask({ enabled = true } = {}) {
        if (!this.iframe || this.isDestroyed) {
            this._maskedBottomPx = 0;
            return 0;
        }

        if (!enabled || this.paginator?.flow !== 'scrolled' || !this.doc || !this.paginator?.metrics) {
            this._maskedBottomPx = 0;
            this.iframe.style.clipPath = 'none';
            return 0;
        }

        const pageH = this.paginator.metrics.pageHeight;
        const lines = this.getVisibleLines({ resolveLineText: false });
        const bottomClipped = lines.filter((l) => l.bottomCutPx > 0.5 && l.top > 0);
        const fullyVisible = lines.filter((l) => l.isFullyVisible);

        if (bottomClipped.length === 0 || fullyVisible.length === 0) {
            this._maskedBottomPx = 0;
            this.iframe.style.clipPath = 'none';
            return 0;
        }

        const lastFullLine = fullyVisible[fullyVisible.length - 1];
        const firstBottomClipped = bottomClipped[0];
        const safeCutY = Math.max(0, Math.min(firstBottomClipped.top - 0.5, lastFullLine.bottom + 1));
        const clipBottomPx = Math.max(0, Math.min(pageH - 12, Math.ceil(pageH - safeCutY)));

        this._maskedBottomPx = clipBottomPx;
        this.iframe.style.clipPath = clipBottomPx > 0
            ? `inset(0px 0px ${clipBottomPx}px 0px)`
            : 'none';
        return clipBottomPx;
    }

    /**
     * 현재 프레임의 상·하단 경계 텍스트 잘림 실측치, 가시 줄 수, 문단 수 및 마스킹 적용 상태를 반환합니다.
     * @returns {{
     *   topCutPx: number,
     *   rawBottomCutPx: number,
     *   maskedBottomPx: number,
     *   visibleBottomCutPx: number,
     *   topClippedCount: number,
     *   bottomClippedCount: number,
     *   visibleLineCount: number,
     *   fullLineCount: number,
     *   paragraphCount: number,
     *   topClippedText: string,
     *   bottomClippedText: string,
     *   pageHeight: number
     * }}
     */
    getClippingMetrics() {
        if (this.isDestroyed || !this.doc || !this.paginator?.metrics) {
            return {
                topCutPx: 0,
                rawBottomCutPx: 0,
                maskedBottomPx: 0,
                visibleBottomCutPx: 0,
                topClippedCount: 0,
                bottomClippedCount: 0,
                visibleLineCount: 0,
                fullLineCount: 0,
                paragraphCount: 0,
                topClippedText: '',
                bottomClippedText: '',
                pageHeight: 0
            };
        }

        const m = this.paginator.metrics;
        const lines = this.getVisibleLines({ resolveLineText: false });
        const fullyVisible = lines.filter((l) => l.isFullyVisible);
        const topClipped = lines.filter((l) => l.topCutPx > 0.5);
        const bottomClipped = lines.filter((l) => l.bottomCutPx > 0.5);

        const blockSet = new Set();
        for (const l of lines) {
            const parent = l.node?.parentElement;
            if (!parent) continue;
            const blockEl = parent.closest?.('p, div, h1, h2, h3, h4, h5, h6, li, dt, dd, blockquote, pre, section, article') || parent;
            blockSet.add(blockEl);
        }

        const topCutPx = topClipped.length > 0
            ? Number(Math.max(...topClipped.map((l) => l.topCutPx)).toFixed(3))
            : 0;
        const rawBottomCutPx = bottomClipped.length > 0
            ? Number(Math.max(...bottomClipped.map((l) => l.bottomCutPx)).toFixed(3))
            : 0;

        const maskedBottomPx = this._maskedBottomPx || 0;
        const effectiveBottom = m.pageHeight - maskedBottomPx;
        const visibleBottomCutPx = bottomClipped.reduce((maxCut, l) => {
            if (l.top < effectiveBottom - 0.1 && l.bottom > effectiveBottom + 0.5) {
                return Math.max(maxCut, Number((l.bottom - effectiveBottom).toFixed(3)));
            }
            return maxCut;
        }, 0);

        return {
            topCutPx,
            rawBottomCutPx,
            maskedBottomPx,
            visibleBottomCutPx: Number(visibleBottomCutPx.toFixed(3)),
            topClippedCount: topClipped.length,
            bottomClippedCount: bottomClipped.length,
            visibleLineCount: lines.length,
            fullLineCount: fullyVisible.length,
            paragraphCount: blockSet.size,
            topClippedText: topClipped[0]?.text?.slice(0, 24) || '',
            bottomClippedText: bottomClipped[bottomClipped.length - 1]?.text?.slice(0, 24) || '',
            pageHeight: m.pageHeight
        };
    }

    /**
     * 현재 프레임의 순수 조판·스타일·물리 치수 스냅샷 복사본을 읽기 전용으로 반환합니다.
     * - ewb 로거가 비활성화되어 내부 캐시(_lastLayoutSnapshot)가 null인 경우에도 즉시 실측해 반환합니다.
     * @param {Object} [options={}]
     * @param {boolean} [options.forceCapture=false] - true면 캐시를 무시하고 현재 DOM 기준으로 새로 계측
     * @returns {{ initial: Object|null, last: Object|null }|null}
     */
    getLayoutSnapshot({ forceCapture = false } = {}) {
        if (this.isDestroyed || !this.doc?.body?.isConnected) return null;

        const current = (!forceCapture && this._lastLayoutSnapshot)
            ? this._lastLayoutSnapshot
            : (captureLayoutSnapshot(this, 'api_query', null) || this._lastLayoutSnapshot);

        return {
            initial: cloneLayoutSnapshot(this._initialLayoutSnapshot),
            last: cloneLayoutSnapshot(current)
        };
    }

    /**
     * 설정이나 뷰포트 크기가 바뀔 때 프레임을 재조판합니다.
     * @param {Object} [layoutOptions={}]
     * @param {Range|Element|null} [anchorTarget=null] - 재조판 후 복원할 DOM Range/Element
     * @returns {{ totalPages: number, currentPage: number }}
     */
    relayout(layoutOptions = {}, anchorTarget = null) {
        if (this.isDestroyed) {
            return { totalPages: 1, currentPage: 0 };
        }

        this._lastLayoutOptions = { ...this._lastLayoutOptions, ...layoutOptions };
        if (!this.paginator || !this.iframe) {
            return { totalPages: 1, currentPage: 0 };
        }

        const prevSnapshot = this._lastLayoutSnapshot || this._initialLayoutSnapshot;
        let res = { totalPages: 1 };
        let jumped = null;

        this._isMountingPipeline = true;
        this._markProgrammaticScroll(150);
        try {
            const metrics = calculateLayoutMetrics(this._lastLayoutOptions);
            this._applyIframeBoxStyles(this.iframe, metrics, this._lastLayoutOptions);
            this._syncScrollingAttribute(this._lastLayoutOptions.flow);
            res = this.paginator.applyLayout(this._lastLayoutOptions);

            if (anchorTarget) {
                jumped = this.paginator.scrollToTarget(anchorTarget, 'instant');
            }
            this.syncViewportClipMask({ enabled: true });
        } finally {
            this._isMountingPipeline = false;
        }

        const relayoutSnapshot = captureLayoutSnapshot(this, 'relayout', this.logger);
        const bufferedLogs = this._layoutLogChannel?.drain?.() || [];
        if (relayoutSnapshot) {
            this._lastLayoutSnapshot = relayoutSnapshot;
            emitPureLayoutReport({
                logger: this.logger,
                snapshot: relayoutSnapshot,
                prevSnapshot,
                bufferedLogs,
                trigger: 'relayout'
            });
        }

        if (jumped) {
            return { totalPages: jumped.totalPages, currentPage: jumped.currentPage };
        }
        const stats = this.paginator.getPaginationMetrics();
        return { totalPages: res.totalPages, currentPage: stats.currentPage };
    }

    /**
     * 프레임을 화면 전면으로 활성화합니다.
     */
    activate() {
        if (this.isDestroyed) return;
        this.isActive = true;
        this._syncScrollingAttribute(this._lastLayoutOptions?.flow);
        this._syncVisibilityStyles(this.iframe, true);
        this.syncViewportClipMask({ enabled: true });
    }

    /**
     * 프레임을 백그라운드 대기 상태로 전환합니다.
     */
    deactivate() {
        if (this.isDestroyed) return;
        this.isActive = false;
        this._clearNativeScrollSettleTimer();
        this._syncVisibilityStyles(this.iframe, false);
    }

    /**
     * 마운트 및 렌더링 완료 프로미스를 반환합니다.
     * @returns {Promise<ChapterFrame>}
     */
    ready() {
        return this._readyPromise || Promise.resolve(this);
    }

    /** @returns {{ currentPage: number, totalPages: number, stepSize: number, scrollPos: number, maxScrollPos: number, atStart: boolean, atEnd: boolean }} */
    getMetrics() {
        return this.paginator ? this.paginator.getPaginationMetrics() : {
            currentPage: 0, totalPages: 1, stepSize: 0, scrollPos: 0, maxScrollPos: 0, atStart: true, atEnd: true
        };
    }

    /**
     * 현재 화면에 보이는 텍스트 라인 목록을 컬럼 우선 순서로 반환합니다.
     * @param {Object} [options={}]
     * @returns {Array<Object>}
     */
    getVisibleLines(options = {}) {
        if (!this.doc || !this.paginator?.metrics) return [];
        const m = this.paginator.metrics;
        return collectVisibleTextLines(this.doc, {
            viewportTop: 0,
            viewportBottom: m.pageHeight,
            viewportLeft: -2,
            viewportRight: m.contentWidth,
            columnCount: m.columnCount,
            columnWidth: m.columnWidth,
            columnGap: m.columnGap,
            ...options
        });
    }

    /**
     * 현재 화면 첫 번째 가시 라인을 반환합니다. (2단 시 왼쪽 컬럼 최상단 우선)
     * @param {Object} [options={}]
     * @returns {Object|null}
     */
    getFirstVisibleLine(options = {}) {
        if (!this.doc || !this.paginator?.metrics) return null;
        const m = this.paginator.metrics;
        return getFirstVisibleLine(this.doc, {
            viewportTop: 0,
            viewportBottom: m.pageHeight,
            viewportLeft: -2,
            viewportRight: m.contentWidth,
            columnCount: m.columnCount,
            columnWidth: m.columnWidth,
            columnGap: m.columnGap,
            ...options
        });
    }

    /**
     * 현재 화면 마지막 가시 라인을 반환합니다. (2단 시 오른쪽 컬럼 최하단 우선)
     * @param {Object} [options={}]
     * @returns {Object|null}
     */
    getLastVisibleLine(options = {}) {
        if (!this.doc || !this.paginator?.metrics) return null;
        const m = this.paginator.metrics;
        return getLastVisibleLine(this.doc, {
            viewportTop: 0,
            viewportBottom: m.pageHeight,
            viewportLeft: -2,
            viewportRight: m.contentWidth,
            columnCount: m.columnCount,
            columnWidth: m.columnWidth,
            columnGap: m.columnGap,
            ...options
        });
    }

    /**
     * 다음 페이지로 이동합니다.
     * @param {Object} [options={}]
     * @returns {{ moved: boolean, atBoundary: 'end'|null, currentPage: number, totalPages: number }}
     */
    nextPage(options = {}) {
        if (!this.paginator) return { moved: false, atBoundary: 'end', currentPage: 0, totalPages: 1 };
        const behavior = options.behavior || this._lastLayoutOptions?.transition;
        this._markProgrammaticScroll(behavior === 'smooth' ? 450 : 120);
        return this.paginator.nextPage(options);
    }

    /**
     * 이전 페이지로 이동합니다.
     * @param {Object} [options={}]
     * @returns {{ moved: boolean, atBoundary: 'start'|null, currentPage: number, totalPages: number }}
     */
    prevPage(options = {}) {
        if (!this.paginator) return { moved: false, atBoundary: 'start', currentPage: 0, totalPages: 1 };
        const behavior = options.behavior || this._lastLayoutOptions?.transition;
        this._markProgrammaticScroll(behavior === 'smooth' ? 450 : 120);
        return this.paginator.prevPage(options);
    }

    /**
     * 지정된 0-based 페이지 번호로 이동합니다.
     * @param {number} pageIndex
     * @param {'instant'|'smooth'} [behavior]
     * @returns {{ moved: boolean, currentPage: number, totalPages: number }}
     */
    goToPage(pageIndex, behavior) {
        if (!this.paginator) return { moved: false, currentPage: 0, totalPages: 1 };
        const effectiveBehavior = behavior || this._lastLayoutOptions?.transition;
        this._markProgrammaticScroll(effectiveBehavior === 'smooth' ? 450 : 120);
        return this.paginator.goToPage(pageIndex, behavior);
    }

    /**
     * 챕터의 마지막 페이지로 즉시 이동합니다.
     * @returns {{ moved: boolean, currentPage: number, totalPages: number }}
     */
    goToEnd() {
        if (!this.paginator) return { moved: false, currentPage: 0, totalPages: 1 };
        this._markProgrammaticScroll(120);
        return this.paginator.goToEnd();
    }

    /**
     * 픽셀 단위로 스크롤합니다.
     * @param {number} deltaPx
     * @param {'instant'|'smooth'} [behavior]
     * @returns {{ moved: boolean, atBoundary: 'start'|'end'|null }}
     */
    scrollByPixels(deltaPx, behavior) {
        if (!this.paginator) return { moved: false, atBoundary: null };
        this._markProgrammaticScroll(behavior === 'smooth' ? 450 : 120);
        return this.paginator.scrollByPixels(deltaPx, behavior);
    }

    /**
     * 특정 DOM Range 또는 Element 위치로 이동합니다.
     * @param {Range|Element} target
     * @param {'instant'|'smooth'} [behavior]
     * @returns {{ success: boolean, currentPage: number, totalPages: number }}
     */
    scrollToTarget(target, behavior) {
        if (!this.paginator) return { success: false, currentPage: 0, totalPages: 1 };
        this._markProgrammaticScroll(behavior === 'smooth' ? 450 : 120);
        return this.paginator.scrollToTarget(target, behavior);
    }

    /**
     * 🧹 프레임이 소유한 모든 리소스(Blob URL, AbortController, Paginator, iframe)를 100% 해제합니다.
     */
    destroy() {
        if (this.isDestroyed) return;
        this.isDestroyed = true;
        this.isActive = false;
        this.state = FrameState.DESTROYED;
        this._mountToken++;
        this._maskedBottomPx = 0;
        this._isMountingPipeline = false;
        this._clearNativeScrollSettleTimer();

        if (this.hookBus && typeof this.hookBus.emitSync === 'function') {
            this.hookBus.emitSync('onFrameDestroy', {
                spineIndex: this.spineIndex,
                href: this.href,
                doc: this.doc,
                frame: this
            }, { stopOnHandled: false });
        }

        try { this._abortController.abort(); } catch (e) {}

        if (this.paginator) {
            this.paginator.destroy();
            this.paginator = null;
        }

        if (this._blobUrl) {
            try { URL.revokeObjectURL(this._blobUrl); } catch (e) {}
            this._blobUrl = null;
        }

        if (this.iframe) {
            try { this.iframe.src = 'about:blank'; } catch (e) {}
            try { this.iframe.remove(); } catch (e) {}
            this.iframe = null;
        }

        this.doc = null;
        this._readyPromise = null;
        this._layoutLogChannel = null;
        this._initialLayoutSnapshot = null;
        this._lastLayoutSnapshot = null;
    }
}