/**
 * 🔬 EWB-JS 순수 뷰어 조판 스냅샷 & 그룹 추적 리포터 (LayoutTraceReporter)
 * - 🛡️ [제로 역의존성] ewb-js 내부 코어/레이아웃 모듈을 import하지 않고 전달받은 frame·DOM만 읽기 전용(Read-Only) 계측
 * - ⚡ [0ms 비활성 바이패스] ewb 로거가 비활성이면 getComputedStyle / scrollHeight 측정을 일절 수행하지 않고 즉시 반환
 * - 📐 [순수 vs 커스텀 대조] #ewb-core-layout-style(ViewportSnap) 기준과 #ewb-user-style / #ewb-theme-style 실제 computedStyle 비교
 * - 🔄 [단계별 변화량 추적] 1차 조판(폰트·정착 전) ➔ 최종 조판 / relayout 간 높이·본문끝·페이지 수 Delta 산출
 * - 📂 [중요 노출 / 프리로드 접힘] 활성 핵심 요약은 그룹화 제외, 활성 상세는 펼친 group, 프리로드·중간과정은 groupCollapsed 동기 출력
 * 파일 경로: web/ewb-js/utils/LayoutTraceReporter.js
 * @module ewb-js/utils/LayoutTraceReporter
 */

const CORE_STYLE_ID = 'ewb-core-layout-style';
const USER_STYLE_ID = 'ewb-user-style';
const THEME_STYLE_ID = 'ewb-theme-style';
const END_SPACER_ATTR = 'data-ewb-end-spacer';

/**
 * 로거의 debug/trace 출력 활성 여부를 안전하게 확인합니다.
 * @param {Object|null} logger
 * @returns {boolean}
 */
export function isLoggerDebugEnabled(logger) {
    if (!logger) return false;
    if (typeof logger.isDebugEnabled === 'function') {
        try { return Boolean(logger.isDebugEnabled()); } catch (e) { return false; }
    }
    if (typeof logger._shouldLog === 'function') {
        try { return Boolean(logger._shouldLog('debug')); } catch (e) { return false; }
    }
    return logger.enabled !== false && logger.level !== 'silent';
}

/**
 * 마운트·프리로드 중 발생하는 PaginatorLayout 연속 트레이스 로그를 동기 일괄 그룹으로 묶기 위한
 * 경량 로거 프록시를 생성합니다. (warn/error 및 활성 페이지 이동은 즉시 출력)
 * @param {Object|null} baseLogger - 원본 EWB 로거 또는 child 로거
 * @param {Object} frame - 소유 ChapterFrame 인스턴스
 * @param {() => boolean} shouldBufferFn - 현재 호출을 버퍼링할지 판별하는 함수
 * @returns {{ logger: Object|null, drain: () => Array<{ level: string, text: string }> }}
 */
export function createBufferedLayoutLogger(baseLogger, frame, shouldBufferFn) {
    if (!baseLogger) {
        return { logger: null, drain: () => [] };
    }

    const childLogger = typeof baseLogger.child === 'function'
        ? baseLogger.child('PaginatorLayout')
        : baseLogger;
    const buffer = [];

    const pushBuffered = (level, text) => {
        if (!isLoggerDebugEnabled(childLogger)) return;
        buffer.push({ level, text });
    };

    const formatTrace = (ctxOrAction, maybeCtx) => {
        if (typeof ctxOrAction === 'string' && maybeCtx && typeof maybeCtx === 'object') {
            const { action = ctxOrAction, caller = 'internal', state = 'ACTIVE', delta = 'none', result = 'ok' } = maybeCtx;
            return `${action} | 호출자: [${caller}] | 상태: [${state}] | 변화: [${delta}] | 결과: [${result}]`;
        }
        const ctx = (ctxOrAction && typeof ctxOrAction === 'object') ? ctxOrAction : {};
        const { action = 'event', caller = 'internal', state = 'ACTIVE', delta = 'none', result = 'ok' } = ctx;
        return `${action} | 호출자: [${caller}] | 상태: [${state}] | 변화: [${delta}] | 결과: [${result}]`;
    };

    const proxy = {
        debug: (msg, ...meta) => {
            if (shouldBufferFn?.() && !frame?.isDestroyed) {
                pushBuffered('debug', String(msg));
                return;
            }
            childLogger.debug?.(msg, ...meta);
        },
        info: (msg, ...meta) => {
            if (shouldBufferFn?.() && !frame?.isDestroyed) {
                pushBuffered('info', String(msg));
                return;
            }
            childLogger.info?.(msg, ...meta);
        },
        warn: (msg, ...meta) => childLogger.warn?.(msg, ...meta),
        error: (msg, ...meta) => childLogger.error?.(msg, ...meta),
        trace: (ctxOrAction, maybeCtx) => {
            if (shouldBufferFn?.() && !frame?.isDestroyed) {
                pushBuffered('debug', formatTrace(ctxOrAction, maybeCtx));
                return;
            }
            childLogger.trace?.(ctxOrAction, maybeCtx);
        },
        isDebugEnabled: () => isLoggerDebugEnabled(childLogger),
        group: (title) => childLogger.group?.(title),
        groupCollapsed: (title) => childLogger.groupCollapsed?.(title),
        groupEnd: () => childLogger.groupEnd?.()
    };

    return {
        logger: proxy,
        drain: () => buffer.splice(0, buffer.length)
    };
}

/**
 * 프레임의 현재 순수 조판·스타일·물리 치수 스냅샷을 읽기 전용으로 수집합니다.
 * @param {Object} frame - ChapterFrame 인스턴스
 * @param {string} [pass='unknown'] - 조판 단계 식별자 ('initial_pre_font' | 'final_settled' | 'relayout')
 * @param {Object|null} [logger=null] - 활성 여부 검사용 로거
 * @returns {Object|null} 조판 스냅샷 객체 (로거 비활성 또는 유효하지 않은 프레임 시 null)
 */
export function captureLayoutSnapshot(frame, pass = 'unknown', logger = null) {
    if (logger && !isLoggerDebugEnabled(logger)) return null;
    if (!frame || frame.isDestroyed || !frame.doc?.body?.isConnected || !frame.doc.defaultView) {
        return null;
    }

    try {
        const doc = frame.doc;
        const win = doc.defaultView;
        const body = doc.body;
        const root = doc.documentElement;
        const paginator = frame.paginator;
        const metrics = paginator?.metrics || null;
        const pagination = paginator?.getPaginationMetrics?.() || null;
        const scroller = paginator?.getScrollElement?.() || doc.scrollingElement || root;
        const iframeRect = frame.iframe?.getBoundingClientRect?.() || null;
        const layoutOpts = frame._lastLayoutOptions || {};

        const coreCss = doc.getElementById(CORE_STYLE_ID)?.textContent || '';
        const userCss = doc.getElementById(USER_STYLE_ID)?.textContent || '';
        const themeCss = doc.getElementById(THEME_STYLE_ID)?.textContent || '';

        const bodyComputed = win.getComputedStyle(body);
        const htmlComputed = win.getComputedStyle(root);
        const firstP = body.querySelector('p');
        const pComputed = firstP ? win.getComputedStyle(firstP) : null;

        const spacerEl = body.querySelector(`[${END_SPACER_ATTR}="true"]`);
        const spacerHeight = spacerEl ? Number(spacerEl.getBoundingClientRect().height.toFixed(1)) : 0;
        const totalScrollH = Math.max(
            Number(scroller?.scrollHeight || 0),
            Number(body.scrollHeight || 0),
            Number(root.scrollHeight || 0)
        );
        const rawContentH = Math.max(0, Math.round(totalScrollH - spacerHeight));

        const includeClipAndLines = pass !== 'initial_pre_font';
        const clipping = (includeClipAndLines && typeof frame.getClippingMetrics === 'function')
            ? frame.getClippingMetrics()
            : null;
        const firstLine = (includeClipAndLines && typeof frame.getFirstVisibleLine === 'function')
            ? frame.getFirstVisibleLine({ resolveLineText: true })
            : null;
        const lastLine = (includeClipAndLines && typeof frame.getLastVisibleLine === 'function')
            ? frame.getLastVisibleLine({ resolveLineText: true })
            : null;

        return {
            pass,
            spineIndex: frame.spineIndex,
            active: Boolean(frame.isActive),
            flow: paginator?.flow || layoutOpts.flow || 'paginated',
            pageSpread: layoutOpts.pageSpread || 'auto',
            fontsStatus: doc.fonts?.status || 'unknown',
            imageCount: body.querySelectorAll('img').length,
            coreFontSize: Number(layoutOpts.fontSize || 16),
            coreLineHeight: Number(layoutOpts.lineHeight || 1.4),
            metrics: metrics ? { ...metrics } : null,
            pagination: pagination ? { ...pagination } : null,
            styles: {
                coreBytes: coreCss.length,
                userBytes: userCss.length,
                themeBytes: themeCss.length,
                bodyFontSize: bodyComputed.fontSize,
                bodyLineHeight: bodyComputed.lineHeight,
                bodyFontFamily: (bodyComputed.fontFamily || '').split(',')[0]?.trim() || 'inherit',
                pFontSize: pComputed?.fontSize || 'N/A',
                pLineHeight: pComputed?.lineHeight || 'N/A',
                pMarginBottom: pComputed?.marginBottom || 'N/A',
                htmlOverflowY: htmlComputed.overflowY,
                htmlColumnCount: htmlComputed.columnCount
            },
            dom: {
                iframeWidth: iframeRect ? Number(iframeRect.width.toFixed(1)) : 0,
                iframeHeight: iframeRect ? Number(iframeRect.height.toFixed(1)) : 0,
                iframeTop: iframeRect ? Number(iframeRect.top.toFixed(1)) : 0,
                iframeLeft: iframeRect ? Number(iframeRect.left.toFixed(1)) : 0,
                bodyClientW: Number(body.clientWidth || 0),
                bodyScrollW: Number(body.scrollWidth || 0),
                rawContentH,
                actualContentBottom: Number(paginator?._actualContentBottom || 0),
                spacerHeight,
                totalScrollH
            },
            clipping,
            firstText: (firstLine?.text || '').replace(/\s+/g, ' ').trim().slice(0, 32),
            lastText: (lastLine?.text || '').replace(/\s+/g, ' ').trim().slice(0, 32)
        };
    } catch (e) {
        return null;
    }
}

/**
 * 두 조판 스냅샷 간의 수치 Delta 요약 문자열을 생성합니다.
 * @param {Object|null} prevSnap
 * @param {Object} currSnap
 * @returns {string}
 */
function formatSnapshotDelta(prevSnap, currSnap) {
    if (!prevSnap) return '초기 기준 스냅샷';
    const rawDelta = currSnap.dom.rawContentH - prevSnap.dom.rawContentH;
    const textDelta = Number((currSnap.dom.actualContentBottom - prevSnap.dom.actualContentBottom).toFixed(1));
    const pageDelta = (currSnap.pagination?.totalPages || 0) - (prevSnap.pagination?.totalPages || 0);
    const boxHDelta = (currSnap.metrics?.pageHeight || 0) - (prevSnap.metrics?.pageHeight || 0);
    const sign = (v) => (v > 0 ? `+${v}` : `${v}`);
    return `[${prevSnap.pass} ➔ ${currSnap.pass}] rawH:${sign(rawDelta)}px | textBottom:${sign(textDelta)}px | boxH:${sign(boxHDelta)}px | pages:${sign(pageDelta)}p`;
}

/**
 * 수집된 순수 조판 스냅샷과 버퍼링된 중간 로그를 중요도에 따라 콘솔에 출력합니다.
 * - 활성 프레임(active=true): 핵심 요약 1줄 평문 노출 + 5단계 상세 리포트 펼친 group + 중간 과정 접힘
 * - 프리로드 프레임(active=false): 전체 내용을 단일 groupCollapsed(접힘)으로 동기 일괄 출력
 * @param {Object} params
 * @param {Object|null} params.logger - EWB 로거
 * @param {Object|null} params.snapshot - 현재 확정 스냅샷
 * @param {Object|null} [params.prevSnapshot=null] - 이전 단계(1차 또는 직전) 스냅샷
 * @param {Array<{ level: string, text: string }>} [params.bufferedLogs=[]] - 마운트/프리로드 중 버퍼링된 로그
 * @param {string} [params.trigger='mount'] - 호출 트리거 ('mount' | 'relayout' | 'activate')
 */
export function emitPureLayoutReport({
    logger,
    snapshot,
    prevSnapshot = null,
    bufferedLogs = [],
    trigger = 'mount'
} = {}) {
    if (!snapshot || !isLoggerDebugEnabled(logger)) return;

    const log = typeof logger.child === 'function' ? logger.child('LayoutReport') : logger;
    const m = snapshot.metrics || {};
    const p = snapshot.pagination || {};
    const d = snapshot.dom;
    const s = snapshot.styles;
    const c = snapshot.clipping;
    const deltaSummary = formatSnapshotDelta(prevSnapshot, snapshot);

    // 1. 백그라운드 프리로드 프레임 (active=false): 단일 접힌 그룹으로 콘솔 1줄 정리
    if (!snapshot.active) {
        const title = `🐢 프리로드 조판 완료 [${trigger}] | ch=${snapshot.spineIndex} | ${p.currentPage + 1}/${p.totalPages}p | box=${m.contentWidth || 0}×${m.pageHeight || 0}px | raw=${d.rawContentH}px -> post=${d.totalScrollH}px (spacer=${d.spacerHeight}px) | 로그 ${bufferedLogs.length}건`;
        log.groupCollapsed?.(title);
        try {
            log.info?.(`[1. 순수 규격] flow=${snapshot.flow} | usable=${m.usableWidth}×${m.usableHeight}px | ${m.fullLineCount}L×${m.exactLineHeightPx}px=${m.pageHeight}px | col=${m.columnCount}(w:${m.columnWidth}/gap:${m.columnGap}) | margins(T:${m.paddingTop} B:${m.paddingBottom} L:${m.paddingLeft} R:${m.paddingRight})`);
            log.info?.(`[2. 스타일/폰트] core=${s.coreBytes}B, user=${s.userBytes}B, theme=${s.themeBytes}B | body=(${s.bodyFontSize}/${s.bodyLineHeight}, ${s.bodyFontFamily}) | fonts=${snapshot.fontsStatus}, imgs=${snapshot.imageCount}`);
            log.info?.(`[3. 단계 변화] ${deltaSummary} | textBottom=${d.actualContentBottom}px | maxScroll=${p.maxScrollPos}px`);
            if (bufferedLogs.length > 0) {
                for (const item of bufferedLogs) {
                    const fn = log[item.level] || log.debug;
                    fn?.(`  ↳ ${item.text}`);
                }
            }
        } finally {
            log.groupEnd?.();
        }
        return;
    }

    // 2. 활성 프레임 핵심 요약 (중요 부분은 그룹화 제외하여 즉시 시인성 확보)
    const hasClipAnomaly = Boolean(c && (c.topCutPx > 0.5 || c.visibleBottomCutPx > 0.5));
    const coreSummary = `📐 [EWB 순수 조판 확정:${trigger}] ch=${snapshot.spineIndex} (${p.currentPage + 1}/${p.totalPages}p) | flow=${snapshot.flow} | box=${m.contentWidth || 0}×${m.pageHeight || 0}px (${m.fullLineCount || 0}L×${m.exactLineHeightPx || 0}px) | body=${d.totalScrollH}px (textBottom=${d.actualContentBottom}px, spacer=${d.spacerHeight}px) | cut(T:${c?.topCutPx ?? 0}px, B:${c?.visibleBottomCutPx ?? 0}px, mask:${c?.maskedBottomPx ?? 0}px)`;
    if (hasClipAnomaly) {
        log.warn?.(`🚨 ${coreSummary}`);
    } else {
        log.info?.(coreSummary);
    }

    // 3. 활성 프레임 순수 조판 5단계 상세 리포트 (중요 활성 리포트는 펼친 group으로 제공)
    const groupTitle = `📐 EWB 순수 뷰어 조판 리포트 [${trigger}] | ch=${snapshot.spineIndex} | ${p.currentPage + 1}/${p.totalPages}p | ${m.pageHeight || 0}px (${m.fullLineCount || 0}L×${m.exactLineHeightPx || 0}px)`;
    log.group?.(groupTitle);
    try {
        log.info?.(`[1. EWB 코어 순수 규격 (ViewportSnap)] usable=${m.usableWidth}×${m.usableHeight}px | flow=${snapshot.flow} | spread=${snapshot.pageSpread} -> ${m.columnCount}단(colW:${m.columnWidth}px, gap:${m.columnGap}px) | buffer=${m.safetyBuffer}px | box=${m.contentWidth}×${m.pageHeight}px (${m.fullLineCount}L×${m.exactLineHeightPx}px) | margins(T:${m.paddingTop} B:${m.paddingBottom} L:${m.paddingLeft} R:${m.paddingRight})`);
        log.info?.(`[2. 스타일 계층 & Computed 비교] coreStyle=${s.coreBytes}B (base:${snapshot.coreFontSize}px/${snapshot.coreLineHeight}) | userStyle=${s.userBytes}B | themeStyle=${s.themeBytes}B | computedBody=(${s.bodyFontSize}/${s.bodyLineHeight}, ${s.bodyFontFamily}) | computedP=(${s.pFontSize}/${s.pLineHeight}, mb:${s.pMarginBottom}) | fonts=${snapshot.fontsStatus}, imgs=${snapshot.imageCount}`);
        log.info?.(`[3. 단계별 조판 변화 (커스텀·폰트 정착 전후)] ${deltaSummary} | rawH=${d.rawContentH}px | textBottom=${d.actualContentBottom}px | spacer=${d.spacerHeight}px | postScrollH=${d.totalScrollH}px`);
        log.info?.(`[4. 물리 프레임 & Scroller 실측] iframe=(top:${d.iframeTop}px, left:${d.iframeLeft}px, ${d.iframeWidth}×${d.iframeHeight}px) | bodyClientW=${d.bodyClientW}px, bodyScrollW=${d.bodyScrollW}px | scrollPos=${p.scrollPos?.toFixed?.(1) ?? 0}/${p.maxScrollPos?.toFixed?.(1) ?? 0}px | atStart=${p.atStart}, atEnd=${p.atEnd}`);
        if (c) {
            log.info?.(`[5. 가시 라인 & 경계 잘림 실측] lines=${c.visibleLineCount}(full=${c.fullLineCount}), paragraphs=${c.paragraphCount} | first="${snapshot.firstText}" | last="${snapshot.lastText}" | topCut=${c.topCutPx}px, rawBottomCut=${c.rawBottomCutPx}px, masked=${c.maskedBottomPx}px, visibleBottomCut=${c.visibleBottomCutPx}px`);
        }

        // 마운트 중 발생한 중간 과정 로그들은 펼친 리포트 안에서만 접힌 서브 그룹으로 보관
        if (bufferedLogs.length > 0) {
            log.groupCollapsed?.(`📜 마운트/조판 중간 추적 로그 (${bufferedLogs.length}건)`);
            try {
                for (const item of bufferedLogs) {
                    const fn = log[item.level] || log.debug;
                    fn?.(item.text);
                }
            } finally {
                log.groupEnd?.();
            }
        }
    } finally {
        log.groupEnd?.();
    }
}