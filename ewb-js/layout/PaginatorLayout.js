/**
 * 📐 HTML5 표준 다단(CSS Multi-column) & 세로 페이지 스냅 조판 레이아웃 엔진 (PaginatorLayout)
 * - 📖 [가로/세로 통합] paginated(가로 다단) 및 scrolled(세로 페이지/부드러운 스크롤) 단일 코어 지원
 * - 📏 [정수배 Spacer 마감] 세로 끝 여백 실측 보정 및 2단 홀수 컬럼 끝 여백 보정으로 마지막 페이지 혼재 차단
 * - ✂️ [상단 잘림 & 빈 줄 스냅] scrolled 모드 이동/끝점 진입 시 상단 걸침 줄 및 소형 빈 줄을 첫 텍스트 줄에 정렬
 * - 🎯 [Range/앵커 즉시 점프] CFI Range 및 #id 앵커의 실측 좌표를 기반으로 목표 페이지/스크롤 위치 즉시 이동
 * - 🔌 [외부 스타일/훅 친화] 코어 조판 스타일(<style id="ewb-core-layout-style">)과 사용자 오버라이드를 분리 유지
 * 파일 경로: web/ewb-js/layout/PaginatorLayout.js
 * @module ewb-js/layout/PaginatorLayout
 */

import {
    calculateLayoutMetrics,
    calculateScrolledLineSnapDelta,
    collectVisibleTextLines
} from './ViewportSnap.js';

const CORE_STYLE_ID = 'ewb-core-layout-style';
const END_SPACER_ATTR = 'data-ewb-end-spacer';

/**
 * 단일 챕터 Document의 조판·페이지네이션·스크롤을 제어하는 클래스
 */
export class PaginatorLayout {
    /**
     * @param {Document} doc - 대상 iframe 내부 Document
     * @param {Object} [options={}]
     * @param {Object|null} [options.logger=null] - EngineLogger 또는 child 로거
     */
    constructor(doc, options = {}) {
        this.doc = doc;
        this.logger = options.logger || null;
        this.metrics = null;
        this.flow = 'paginated';
        this.transition = 'instant';
        this._skipLeadingBlankLines = true;
        this._scrollEndTimer = null;
    }

    /**
     * 현재 문서에 레이아웃 규격과 기본 조판 CSS를 적용하고 Spacer를 확정합니다.
     * @param {Object} layoutOptions - ViewportSnap.calculateLayoutMetrics 입력 옵션 + transition
     * @returns {{
     *   metrics: Object,
     *   totalPages: number,
     *   stepSize: number
     * }}
     */
    applyLayout(layoutOptions = {}) {
        if (!this.doc || !this.doc.documentElement || !this.doc.body) {
            return { metrics: null, totalPages: 1, stepSize: 0 };
        }

        this.flow = layoutOptions.flow === 'scrolled' ? 'scrolled' : 'paginated';
        this.transition = layoutOptions.transition === 'smooth' ? 'smooth' : 'instant';
        this._skipLeadingBlankLines = layoutOptions.skipLeadingBlankLines !== false;
        this.metrics = calculateLayoutMetrics({
            ...layoutOptions,
            flow: this.flow
        });

        this._injectCoreLayoutCss(this.metrics, layoutOptions);
        this.ensureEndSpacer();

        const m = this.metrics;
        const pagination = this.getPaginationMetrics();
        this.logger?.trace?.({
            action: 'applyLayout',
            caller: 'PaginatorLayout',
            state: this.flow,
            delta: `viewport=${m.usableWidth}x${m.usableHeight}px, margins(T:${m.paddingTop} B:${m.paddingBottom} L:${m.paddingLeft} R:${m.paddingRight}), box=${m.contentWidth}x${m.pageHeight}px (${m.fullLineCount}L×${m.exactLineHeightPx}px), ${m.columnCount}col(w:${m.columnWidth}/gap:${m.columnGap})`,
            result: `pages=${pagination.totalPages}, step=${pagination.stepSize}px`
        });

        return {
            metrics: this.metrics,
            totalPages: pagination.totalPages,
            stepSize: pagination.stepSize
        };
    }

    /**
     * 코어 조판 전용 스타일시트를 주입합니다. (사용자 테마/폰트 CSS와 충돌하지 않게 id 분리)
     * @param {Object} m - calculateLayoutMetrics 결과 객체
     * @param {Object} [layoutOptions={}] - fontSize/lineHeight 기본값 참조용 레이아웃 옵션
     */
    _injectCoreLayoutCss(m, layoutOptions = {}) {
        const head = this.doc.head || this.doc.documentElement;
        let styleEl = this.doc.getElementById(CORE_STYLE_ID);
        if (!styleEl) {
            styleEl = this.doc.createElement('style');
            styleEl.id = CORE_STYLE_ID;
            head.insertBefore(styleEl, head.firstChild);
        }

        const isPaginated = this.flow === 'paginated';
        const baseFontSize = Math.max(8, Number(layoutOptions.fontSize || 16));
        const baseLineHeight = Math.max(1.0, Number(layoutOptions.lineHeight || 1.4));
        const safeColWidth = Math.max(100, m.columnWidth - 1);

        if (isPaginated) {
            styleEl.textContent = `
                html {
                    box-sizing: border-box !important;
                    width: ${m.contentWidth}px !important;
                    height: ${m.pageHeight}px !important;
                    margin: 0 !important;
                    padding: 0 !important;
                    overflow-x: auto !important;
                    overflow-y: hidden !important;
                    column-count: ${m.columnCount} !important;
                    -webkit-column-count: ${m.columnCount} !important;
                    column-width: ${safeColWidth}px !important;
                    column-gap: ${m.columnGap}px !important;
                    column-fill: auto !important;
                    -webkit-column-width: ${safeColWidth}px !important;
                    -webkit-column-gap: ${m.columnGap}px !important;
                    scrollbar-width: none !important;
                    -ms-overflow-style: none !important;
                }
                html::-webkit-scrollbar, body::-webkit-scrollbar {
                    display: none !important;
                    width: 0 !important;
                    height: 0 !important;
                }
                body {
                    margin: 0 !important;
                    padding: 0 !important;
                    min-height: ${m.pageHeight}px !important;
                    box-sizing: border-box !important;
                    overflow-wrap: break-word !important;
                    font-size: ${baseFontSize}px !important;
                    line-height: ${baseLineHeight} !important;
                }
                body > :first-child,
                body > div:first-child > :first-child,
                body > section:first-child > :first-child,
                body > article:first-child > :first-child {
                    margin-top: 0 !important;
                }
                img, svg, video, canvas {
                    max-width: 100% !important;
                    max-height: ${m.pageHeight}px !important;
                    height: auto !important;
                    object-fit: contain !important;
                    break-inside: avoid !important;
                    -webkit-column-break-inside: avoid !important;
                }
                h1, h2, h3, h4, h5, h6 {
                    break-after: avoid !important;
                    -webkit-column-break-after: avoid !important;
                }
            `;
        } else {
            styleEl.textContent = `
                html {
                    box-sizing: border-box !important;
                    width: ${m.contentWidth}px !important;
                    height: ${m.pageHeight}px !important;
                    margin: 0 !important;
                    padding: 0 !important;
                    overflow-x: hidden !important;
                    overflow-y: auto !important;
                    scrollbar-width: none !important;
                    -ms-overflow-style: none !important;
                }
                html::-webkit-scrollbar, body::-webkit-scrollbar {
                    display: none !important;
                    width: 0 !important;
                    height: 0 !important;
                }
                body {
                    margin: 0 !important;
                    padding: 0 !important;
                    width: 100% !important;
                    min-height: ${m.pageHeight}px !important;
                    box-sizing: border-box !important;
                    overflow-wrap: break-word !important;
                    font-size: ${baseFontSize}px !important;
                    line-height: ${baseLineHeight} !important;
                }
                body > :first-child,
                body > div:first-child > :first-child,
                body > section:first-child > :first-child,
                body > article:first-child > :first-child {
                    margin-top: 0 !important;
                }
                img, svg, video, canvas {
                    max-width: 100% !important;
                    max-height: ${m.pageHeight}px !important;
                    height: auto !important;
                    object-fit: contain !important;
                }
            `;
        }
    }

    /**
     * 챕터 마지막 페이지가 화면 정수배로 딱 떨어지도록 끝 여백(Spacer)을 확정합니다.
     * - scrolled 모드: 삽입 후 scrollHeight를 재측정해 문단 하단 마진 붕괴 해제분까지 보정
     * - paginated 2단 모드: 홀수 컬럼 마감 시 빈 오른쪽 컬럼 1칸을 보충해 마지막 페이지 겹침 차단
     */
    ensureEndSpacer() {
        const body = this.doc?.body;
        const root = this.doc?.documentElement;
        if (!body || !root || !this.metrics) return;

        const oldSpacers = body.querySelectorAll(`[${END_SPACER_ATTR}="true"]`);
        oldSpacers.forEach((el) => el.remove());

        if (this.flow === 'scrolled') {
            const scroller = this.getScrollElement();
            const pageH = this.metrics.pageHeight;
            const rawContentH = Math.max(body.scrollHeight, root.scrollHeight);
            const remainder = rawContentH % pageH;
            const neededSpacer = remainder > 1 ? Math.max(0, pageH - remainder) : 0;

            const spacer = this.doc.createElement('div');
            spacer.setAttribute(END_SPACER_ATTR, 'true');
            spacer.setAttribute('aria-hidden', 'true');
            const initialH = neededSpacer > 0 ? neededSpacer : 1;
            spacer.style.cssText = `height: ${initialH}px !important; width: 100% !important; margin: 0 !important; padding: 0 !important; pointer-events: none !important;`;
            body.appendChild(spacer);

            if (scroller) {
                const actualH = Math.max(pageH, scroller.scrollHeight);
                const excess = actualH % pageH;
                if (neededSpacer === 0 && excess <= 1) {
                    spacer.remove();
                } else if (excess > 1 && excess < pageH - 1) {
                    if (initialH > excess) {
                        const corrected = Math.max(1, Math.round(initialH - excess));
                        spacer.style.setProperty('height', `${corrected}px`, 'important');
                    } else {
                        const added = Math.ceil(pageH - excess);
                        spacer.style.setProperty('height', `${initialH + added}px`, 'important');
                    }
                }
            }
            return;
        }

        if (this.metrics.columnCount === 2) {
            const scroller = this.getScrollElement();
            if (scroller) {
                const gap = this.metrics.columnGap || 0;
                const stepSize = Math.max(100, this.metrics.contentWidth + gap);
                const rawScrollW = Math.max(this.metrics.contentWidth, scroller.scrollWidth);
                const rawTotalPages = Math.max(1, Math.ceil((rawScrollW + gap - 4) / stepSize));
                const expectedFullW = rawTotalPages * stepSize - gap;
                const deficit = expectedFullW - rawScrollW;

                if (deficit > this.metrics.columnWidth * 0.4) {
                    const colSpacer = this.doc.createElement('div');
                    colSpacer.setAttribute(END_SPACER_ATTR, 'true');
                    colSpacer.setAttribute('aria-hidden', 'true');
                    colSpacer.style.cssText = 'break-before: column !important; -webkit-column-break-before: always !important; height: 1px !important; width: 1px !important; margin: 0 !important; padding: 0 !important; pointer-events: none !important;';
                    body.appendChild(colSpacer);

                    const afterScrollW = Math.max(this.metrics.contentWidth, scroller.scrollWidth);
                    const afterTotalPages = Math.max(1, Math.ceil((afterScrollW + gap - 4) / stepSize));
                    if (afterTotalPages > rawTotalPages) {
                        colSpacer.remove();
                    } else {
                        return;
                    }
                }
            }
        }

        const spacer = this.doc.createElement('div');
        spacer.setAttribute(END_SPACER_ATTR, 'true');
        spacer.setAttribute('aria-hidden', 'true');
        spacer.style.cssText = 'height: 0px !important; margin: 0 !important; padding: 0 !important; clear: both !important;';
        body.appendChild(spacer);
    }

    /**
     * 현재 뷰포트 기준 특정 수직 구간([viewTop, viewBottom])에 미디어 요소가 존재하는지 확인합니다.
     * @param {number} viewTop
     * @param {number} viewBottom
     * @returns {boolean}
     * @private
     */
    _hasMediaInVerticalBand(viewTop, viewBottom) {
        if (!this.doc?.body) return false;
        const mediaNodes = this.doc.body.querySelectorAll('img, svg, video, canvas');
        for (const el of mediaNodes) {
            const r = el.getBoundingClientRect();
            if (r.height <= 0 || r.width <= 0) continue;
            if (r.bottom > viewTop + 1 && r.top < viewBottom - 1) {
                return true;
            }
        }
        return false;
    }

    /**
     * scrolled 모드 nextPage/prevPage 이동 시 목표 뷰포트 상단 첫 텍스트 줄을 y=0 첫 줄에 맞춥니다.
     * - DOM을 삭제하지 않고 scrollTo 목표 좌표만 1회 보정합니다.
     * - prevPage 시 챕터 맨 처음(scrollTop<=1)에는 개입하지 않아 이전 챕터 경계 진입을 보장합니다.
     * @param {'next'|'prev'} direction
     * @param {number} baseTargetTop
     * @param {number} currentScrollPos
     * @param {number} maxScrollPos
     * @returns {number}
     * @private
     */
    _alignScrolledTargetTop(direction, baseTargetTop, currentScrollPos, maxScrollPos) {
        if (this.flow !== 'scrolled' || !this._skipLeadingBlankLines || !this.doc || !this.metrics) {
            return baseTargetTop;
        }
        if (direction === 'prev' && baseTargetTop <= 1) {
            return 0;
        }

        const pageH = this.metrics.pageHeight;
        const lineH = this.metrics.exactLineHeightPx || 24;
        const maxSkipPx = Math.round(lineH * 2.5);
        const shift = baseTargetTop - currentScrollPos;

        const lines = collectVisibleTextLines(this.doc, {
            viewportTop: shift,
            viewportBottom: shift + pageH,
            resolveLineText: false
        });
        if (lines.length === 0) return baseTargetTop;

        const firstLine = lines[0];
        const relTop = firstLine.top - shift;

        // prevPage 시 새 상단 경계에 글자 줄이 반쯤 잘려 걸친 경우 위로 살짝 당겨 온전히 노출
        if (direction === 'prev' && relTop < -0.5) {
            const pullUp = Math.ceil(Math.abs(relTop));
            const candidate = Math.max(0, baseTargetTop - pullUp);
            if (candidate < currentScrollPos - 1) {
                this.logger?.trace?.({
                    action: 'alignTopLine',
                    caller: 'PaginatorLayout:prev',
                    state: this.flow,
                    delta: `baseTop=${baseTargetTop.toFixed(1)} -> alignedTop=${candidate.toFixed(1)} (${(candidate - baseTargetTop).toFixed(1)}px)`,
                    result: 'pull_up_clipped_top_line'
                });
                return candidate;
            }
            return baseTargetTop;
        }

        // 상단 1~2.5줄 이내의 소형 빈 여백만 있고 미디어가 없으면 첫 실제 텍스트 줄을 y=0에 정렬
        if (relTop > 0.5 && relTop <= maxSkipPx) {
            if (this._hasMediaInVerticalBand(shift, shift + relTop)) {
                return baseTargetTop;
            }
            const candidate = Math.min(maxScrollPos, baseTargetTop + Math.floor(relTop));
            if (direction === 'next' && candidate > currentScrollPos + 1) {
                this.logger?.trace?.({
                    action: 'alignTopLine',
                    caller: 'PaginatorLayout:next',
                    state: this.flow,
                    delta: `baseTop=${baseTargetTop.toFixed(1)} -> alignedTop=${candidate.toFixed(1)} (+${(candidate - baseTargetTop).toFixed(1)}px)`,
                    result: 'skip_leading_blank_line'
                });
                return candidate;
            }
            if (direction === 'prev' && candidate < currentScrollPos - 1) {
                this.logger?.trace?.({
                    action: 'alignTopLine',
                    caller: 'PaginatorLayout:prev',
                    state: this.flow,
                    delta: `baseTop=${baseTargetTop.toFixed(1)} -> alignedTop=${candidate.toFixed(1)} (+${(candidate - baseTargetTop).toFixed(1)}px)`,
                    result: 'skip_leading_blank_line'
                });
                return candidate;
            }
        }

        return baseTargetTop;
    }

    /**
     * 스크롤 대상 루트 엘리먼트를 반환합니다.
     * @returns {HTMLElement}
     */
    getScrollElement() {
        return this.doc?.scrollingElement || this.doc?.documentElement || this.doc?.body;
    }

    /**
     * 현재 챕터의 총 페이지, 현재 페이지(0-based), 경계 여부를 반환합니다.
     * @returns {{
     *   currentPage: number,
     *   totalPages: number,
     *   stepSize: number,
     *   scrollPos: number,
     *   maxScrollPos: number,
     *   atStart: boolean,
     *   atEnd: boolean
     * }}
     */
    getPaginationMetrics() {
        const scroller = this.getScrollElement();
        if (!scroller || !this.metrics) {
            return {
                currentPage: 0,
                totalPages: 1,
                stepSize: 0,
                scrollPos: 0,
                maxScrollPos: 0,
                atStart: true,
                atEnd: true
            };
        }

        if (this.flow === 'paginated') {
            const gap = this.metrics.columnGap || 0;
            const stepSize = Math.max(100, this.metrics.contentWidth + gap);
            const scrollW = Math.max(this.metrics.contentWidth, scroller.scrollWidth);
            const totalPages = Math.max(1, Math.ceil((scrollW + gap - 4) / stepSize));
            const scrollPos = Math.max(0, scroller.scrollLeft || 0);
            const currentPage = Math.min(totalPages - 1, Math.max(0, Math.round(scrollPos / stepSize)));
            const maxScrollPos = Math.max(0, (totalPages - 1) * stepSize);

            return {
                currentPage,
                totalPages,
                stepSize,
                scrollPos,
                maxScrollPos,
                atStart: currentPage <= 0 || scrollPos <= 1,
                atEnd: currentPage >= totalPages - 1 || scrollPos >= maxScrollPos - 2
            };
        }

        const stepSize = Math.max(100, this.metrics.pageHeight);
        const scrollH = Math.max(stepSize, scroller.scrollHeight);
        const totalPages = Math.max(1, Math.ceil((scrollH - 2) / stepSize));
        const scrollPos = Math.max(0, scroller.scrollTop || 0);
        const maxScrollPos = Math.max(0, scrollH - stepSize);
        const currentPage = Math.min(totalPages - 1, Math.max(0, Math.round(scrollPos / stepSize)));

        return {
            currentPage,
            totalPages,
            stepSize,
            scrollPos,
            maxScrollPos,
            atStart: scrollPos <= 1,
            atEnd: scrollPos >= maxScrollPos - 2
        };
    }

    /**
     * 지정된 0-based 페이지 번호로 이동합니다.
     * @param {number} pageIndex - 목표 페이지 (0 ~ totalPages - 1)
     * @param {'instant'|'smooth'} [behavior] - 애니메이션 모드 (생략 시 기본 설정)
     * @returns {{ moved: boolean, currentPage: number, totalPages: number }}
     */
    goToPage(pageIndex, behavior = this.transition) {
        const scroller = this.getScrollElement();
        const stats = this.getPaginationMetrics();
        if (!scroller) return { moved: false, currentPage: 0, totalPages: 1 };

        const clampedPage = Math.min(stats.totalPages - 1, Math.max(0, Math.floor(Number(pageIndex) || 0)));
        const targetPos = clampedPage * stats.stepSize;
        const scrollBehavior = behavior === 'smooth' ? 'smooth' : 'instant';

        if (this.flow === 'paginated') {
            scroller.scrollTo({ left: targetPos, behavior: scrollBehavior });
        } else {
            scroller.scrollTo({ top: targetPos, behavior: scrollBehavior });
        }

        return {
            moved: true,
            currentPage: clampedPage,
            totalPages: stats.totalPages
        };
    }

    /**
     * 챕터의 마지막 페이지로 즉시 이동합니다. (이전 챕터 경계 진입 및 사전 대기 시 사용)
     * - scrolled 모드에서는 마지막 페이지 이동 직후 상단 경계 줄 잘림 여부를 검사해 줄 경계로 스냅합니다.
     * @returns {{ moved: boolean, currentPage: number, totalPages: number }}
     */
    goToEnd() {
        const stats = this.getPaginationMetrics();
        const res = this.goToPage(stats.totalPages - 1, 'instant');

        if (this.flow === 'scrolled' && this.doc && this.metrics) {
            const scroller = this.getScrollElement();
            const pageH = this.metrics.pageHeight;
            const lines = collectVisibleTextLines(this.doc, {
                viewportTop: 0,
                viewportBottom: pageH,
                resolveLineText: false
            });

            const clippedTop = lines.find((l) => l.top < -0.5 && l.bottom > 0);
            if (clippedTop && scroller) {
                const lastLine = lines[lines.length - 1];
                const pullUpPx = Math.ceil(Math.abs(clippedTop.top));
                const canPullUpSafely = !lastLine || (lastLine.bottom + pullUpPx <= pageH + 0.5);

                const beforeTop = scroller.scrollTop || 0;
                let targetTop = beforeTop;
                let snapReason = 'none';

                if (canPullUpSafely && beforeTop >= pullUpPx) {
                    targetTop = Math.max(0, beforeTop - pullUpPx);
                    snapReason = 'pull_up_top_clipped_line';
                } else {
                    const pushDownPx = Math.ceil(clippedTop.bottom);
                    const maxScroll = this.getPaginationMetrics().maxScrollPos;
                    if (beforeTop + pushDownPx <= maxScroll) {
                        targetTop = beforeTop + pushDownPx;
                        snapReason = 'push_down_next_full_line';
                    }
                }

                if (targetTop !== beforeTop) {
                    scroller.scrollTo({ top: targetTop, behavior: 'instant' });
                    const updated = this.getPaginationMetrics();
                    this.logger?.trace?.({
                        action: 'goToEndSnap',
                        caller: 'PaginatorLayout:goToEnd',
                        state: this.flow,
                        delta: `beforeTop=${beforeTop.toFixed(1)} -> afterTop=${targetTop.toFixed(1)}, topCut=${clippedTop.topCutPx}px`,
                        result: `${snapReason} (page=${updated.currentPage + 1}/${updated.totalPages})`
                    });
                    return {
                        moved: true,
                        currentPage: updated.currentPage,
                        totalPages: updated.totalPages
                    };
                }
            }
        }

        return res;
    }

    /**
     * 다음 페이지로 이동합니다. 경계에 도달한 경우 moved=false, atBoundary='end'를 반환합니다.
     * @param {Object} [options={}]
     * @param {number|null} [options.distance=null] - 세로 모드 명시적 이동 거리(px)
     * @param {boolean} [options.lineSnap=true] - 세로 모드 줄 경계 자동 스냅 사용 여부
     * @param {'instant'|'smooth'} [options.behavior] - 전환 방식
     * @returns {{ moved: boolean, atBoundary: 'end'|null, currentPage: number, totalPages: number }}
     */
    nextPage(options = {}) {
        const stats = this.getPaginationMetrics();
        if (stats.atEnd) {
            return {
                moved: false,
                atBoundary: 'end',
                currentPage: stats.currentPage,
                totalPages: stats.totalPages
            };
        }

        const behavior = options.behavior || this.transition;

        if (this.flow === 'paginated') {
            const res = this.goToPage(stats.currentPage + 1, behavior);
            return { ...res, atBoundary: null };
        }

        let delta = Number(options.distance || 0);
        if (delta <= 0) {
            if (options.lineSnap !== false && this.metrics) {
                const snap = calculateScrolledLineSnapDelta(
                    this.doc,
                    'next',
                    this.metrics.pageHeight,
                    this.metrics.exactLineHeightPx
                );
                delta = snap.distance;
            } else {
                delta = stats.stepSize;
            }
        }

        const scroller = this.getScrollElement();
        const baseNextTop = Math.min(stats.maxScrollPos, stats.scrollPos + delta);
        const nextTop = (options.lineSnap !== false && !options.distance)
            ? this._alignScrolledTargetTop('next', baseNextTop, stats.scrollPos, stats.maxScrollPos)
            : baseNextTop;

        scroller.scrollTo({ top: nextTop, behavior: behavior === 'smooth' ? 'smooth' : 'instant' });

        const updated = this.getPaginationMetrics();
        return {
            moved: true,
            atBoundary: null,
            currentPage: updated.currentPage,
            totalPages: updated.totalPages
        };
    }

    /**
     * 이전 페이지로 이동합니다. 경계에 도달한 경우 moved=false, atBoundary='start'를 반환합니다.
     * @param {Object} [options={}]
     * @param {number|null} [options.distance=null] - 세로 모드 명시적 이동 거리(px)
     * @param {boolean} [options.lineSnap=true] - 세로 모드 줄 경계 자동 스냅 사용 여부
     * @param {'instant'|'smooth'} [options.behavior] - 전환 방식
     * @returns {{ moved: boolean, atBoundary: 'start'|null, currentPage: number, totalPages: number }}
     */
    prevPage(options = {}) {
        const stats = this.getPaginationMetrics();
        if (stats.atStart) {
            return {
                moved: false,
                atBoundary: 'start',
                currentPage: stats.currentPage,
                totalPages: stats.totalPages
            };
        }

        const behavior = options.behavior || this.transition;

        if (this.flow === 'paginated') {
            const res = this.goToPage(stats.currentPage - 1, behavior);
            return { ...res, atBoundary: null };
        }

        let delta = Number(options.distance || 0);
        if (delta <= 0) {
            if (options.lineSnap !== false && this.metrics) {
                const snap = calculateScrolledLineSnapDelta(
                    this.doc,
                    'prev',
                    this.metrics.pageHeight,
                    this.metrics.exactLineHeightPx
                );
                delta = snap.distance;
            } else {
                delta = stats.stepSize;
            }
        }

        const scroller = this.getScrollElement();
        const basePrevTop = Math.max(0, stats.scrollPos - delta);
        const prevTop = (options.lineSnap !== false && !options.distance)
            ? this._alignScrolledTargetTop('prev', basePrevTop, stats.scrollPos, stats.maxScrollPos)
            : basePrevTop;

        scroller.scrollTo({ top: prevTop, behavior: behavior === 'smooth' ? 'smooth' : 'instant' });

        const updated = this.getPaginationMetrics();
        return {
            moved: true,
            atBoundary: null,
            currentPage: updated.currentPage,
            totalPages: updated.totalPages
        };
    }

    /**
     * 픽셀 단위로 부드럽게 또는 즉시 스크롤합니다. (마우스 휠 / 자동 스크롤용)
     * @param {number} deltaPx - 이동할 픽셀 변화량
     * @param {'instant'|'smooth'} [behavior='instant']
     * @returns {{ moved: boolean, atBoundary: 'start'|'end'|null }}
     */
    scrollByPixels(deltaPx, behavior = 'instant') {
        const scroller = this.getScrollElement();
        const stats = this.getPaginationMetrics();
        if (!scroller || !deltaPx) return { moved: false, atBoundary: null };

        if (deltaPx > 0 && stats.atEnd) {
            return { moved: false, atBoundary: 'end' };
        }
        if (deltaPx < 0 && stats.atStart) {
            return { moved: false, atBoundary: 'start' };
        }

        const scrollBehavior = behavior === 'smooth' ? 'smooth' : 'instant';
        if (this.flow === 'paginated') {
            const nextLeft = Math.min(stats.maxScrollPos, Math.max(0, stats.scrollPos + deltaPx));
            scroller.scrollTo({ left: nextLeft, behavior: scrollBehavior });
        } else {
            const nextTop = Math.min(stats.maxScrollPos, Math.max(0, stats.scrollPos + deltaPx));
            scroller.scrollTo({ top: nextTop, behavior: scrollBehavior });
        }
        return { moved: true, atBoundary: null };
    }

    /**
     * 특정 DOM Range 또는 Element가 위치한 페이지/스크롤 좌표로 즉시 이동합니다. (CFI 및 #id 앵커 복원용)
     * @param {Range|Element} target - 이동할 DOM Range 또는 Element
     * @param {'instant'|'smooth'} [behavior='instant']
     * @returns {{ success: boolean, currentPage: number, totalPages: number }}
     */
    scrollToTarget(target, behavior = 'instant') {
        const scroller = this.getScrollElement();
        if (!target || !scroller || !this.metrics) {
            return { success: false, currentPage: 0, totalPages: 1 };
        }

        let rect = null;
        if (typeof target.getBoundingClientRect === 'function') {
            rect = target.getBoundingClientRect();
        } else if (typeof target.getClientRects === 'function') {
            const rects = target.getClientRects();
            rect = rects.length > 0 ? rects[0] : target.getBoundingClientRect();
        }

        if (!rect) return { success: false, currentPage: 0, totalPages: 1 };

        const stats = this.getPaginationMetrics();
        if (this.flow === 'paginated') {
            const absoluteLeft = rect.left + (scroller.scrollLeft || 0);
            const targetPage = Math.min(stats.totalPages - 1, Math.max(0, Math.floor(absoluteLeft / stats.stepSize)));
            const res = this.goToPage(targetPage, behavior);
            return { success: true, currentPage: res.currentPage, totalPages: res.totalPages };
        }

        const absoluteTop = Math.max(0, rect.top + (scroller.scrollTop || 0));
        const clampedTop = Math.min(stats.maxScrollPos, absoluteTop);
        scroller.scrollTo({ top: clampedTop, behavior: behavior === 'smooth' ? 'smooth' : 'instant' });
        const updated = this.getPaginationMetrics();
        return { success: true, currentPage: updated.currentPage, totalPages: updated.totalPages };
    }

    /**
     * 내부 타이머 및 참조를 정리합니다.
     */
    destroy() {
        if (this._scrollEndTimer) {
            clearTimeout(this._scrollEndTimer);
            this._scrollEndTimer = null;
        }
        this.doc = null;
        this.metrics = null;
    }
}