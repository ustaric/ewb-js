/**
 * 📐 뷰포트 짝수 조판 계산 및 DOM Range 기반 텍스트 라인 스냅 엔진 (ViewportSnap)
 * - 📏 [짝수 베이스라인 연산] 가용 높이 ÷ 짝수 줄높이 = 반쪽 잘림 없는 정밀 컬럼 높이 확정
 * - 🔬 [실제 렌더링 라인 수집] TreeWalker + Range.getClientRects()로 화면 내 모든 줄 및 경계 걸침 계측
 * - 📰 [2단 컬럼 우선 정렬] 다단(2col) 모드에서 왼쪽 컬럼 전체 후 오른쪽 컬럼 순서로 정렬해 firstLine 역전 차단
 * - 🎯 [노드/오프셋 동시 반환] 첫 줄·마지막 줄의 (node, startOffset, endOffset)을 함께 반환해 CFI/TTS 1회 패스 연동
 * - 🛡️ [1단 안전 Gap 유지] 1단 모드에서도 columnGap 완충 구간을 두어 인접 페이지 0.5px 잔상 침범 차단
 * - 🌐 [독립 순수 모듈] 외부 앱 상태나 라이브러리 의존성 없이 순수 DOM/Math 표준으로만 동작
 * 파일 경로: web/ewb-js/layout/ViewportSnap.js
 * @module ewb-js/layout/ViewportSnap
 */

/**
 * 폰트 크기(px)와 줄간격 배수로 짝수 정수화된 정확한 1줄 높이(px)를 산출합니다.
 * @param {number|string} fontSize - 본문 글자 크기 (px)
 * @param {number|string} lineHeight - 본문 줄간격 배수 (예: 1.4)
 * @returns {number} 짝수 정수화된 1줄 높이 (최소 12px)
 */
export function calculateExactLineHeight(fontSize = 16, lineHeight = 1.4) {
    const safeFont = Math.max(8, Number(fontSize) || 16);
    const safeRatio = Math.max(1.0, Number(lineHeight) || 1.4);
    const raw = Math.round(safeFont * safeRatio);
    const even = Math.floor(raw / 2) * 2;
    return Math.max(12, even);
}

/**
 * 뷰포트 가용 영역과 사용자 설정을 기반으로 다단 조판 규격 및 여백 메트릭스를 산출합니다.
 * @param {Object} params
 * @param {number} params.usableWidth - 가용 뷰포트 너비 (px)
 * @param {number} params.usableHeight - 가용 뷰포트 높이 (px)
 * @param {number|string} [params.fontSize=16] - 글자 크기 (px)
 * @param {number|string} [params.lineHeight=1.4] - 줄간격 배수
 * @param {number|string} [params.marginTop=40] - 상단 여백 (px)
 * @param {number|string} [params.marginBottom=40] - 하단 여백 (px)
 * @param {number|string} [params.marginLeft=48] - 좌측 여백 (px)
 * @param {number|string} [params.marginRight=48] - 우측 여백 (px)
 * @param {'paginated'|'scrolled'} [params.flow='paginated'] - 보기 모드
 * @param {'auto'|'single'|'double'} [params.pageSpread='auto'] - 가로 다단 열 설정
 * @param {number} [params.columnGap=40] - 컬럼 간 안전 여백 (px)
 * @returns {{
 *   usableWidth: number,
 *   usableHeight: number,
 *   exactLineHeightPx: number,
 *   paddingTop: number,
 *   paddingBottom: number,
 *   paddingLeft: number,
 *   paddingRight: number,
 *   safetyBuffer: number,
 *   contentAvailableHeight: number,
 *   fullLineCount: number,
 *   pageHeight: number,
 *   contentWidth: number,
 *   columnCount: 1|2,
 *   columnGap: number,
 *   columnWidth: number,
 *   isPortrait: boolean,
 *   isNarrowMobile: boolean
 * }}
 */
export function calculateLayoutMetrics({
    usableWidth,
    usableHeight,
    fontSize = 16,
    lineHeight = 1.4,
    marginTop = 40,
    marginBottom = 40,
    marginLeft = 48,
    marginRight = 48,
    flow = 'paginated',
    pageSpread = 'auto',
    columnGap = 40
} = {}) {
    const safeW = Math.max(200, Math.floor((Number(usableWidth) || 360) / 2) * 2);
    const safeH = Math.max(200, Math.floor((Number(usableHeight) || 640) / 2) * 2);

    const exactLineHeightPx = calculateExactLineHeight(fontSize, lineHeight);

    const paddingTop = Math.max(0, Math.floor((Number(marginTop ?? 40)) / 2) * 2);
    const reqBottom = Math.max(0, Math.floor((Number(marginBottom ?? 40)) / 2) * 2);
    const paddingLeft = Math.max(0, Math.floor((Number(marginLeft ?? 48)) / 2) * 2);
    const paddingRight = Math.max(0, Math.floor((Number(marginRight ?? 48)) / 2) * 2);

    const isPortrait = safeH > safeW;
    const isNarrowMobile = safeW < 600;
    const isPaginated = flow === 'paginated';

    // 요청된 하단 여백이 충분(>=12px)할 때는 중복 버퍼를 빼지 않아 상하 여백 대칭을 유지합니다.
    const safetyBuffer = isPaginated
        ? (reqBottom >= 12 ? 0 : 4)
        : (reqBottom >= 12 ? 0 : (isNarrowMobile ? 8 : 12));

    const contentAvailableHeight = Math.max(
        exactLineHeightPx * 2,
        safeH - (paddingTop + reqBottom) - safetyBuffer
    );

    const fullLineCount = Math.max(2, Math.floor(contentAvailableHeight / exactLineHeightPx));
    const pageHeight = fullLineCount * exactLineHeightPx;
    const paddingBottom = Math.max(0, safeH - paddingTop - pageHeight);

    const contentWidth = Math.max(
        180,
        Math.floor((safeW - paddingLeft - paddingRight) / 2) * 2
    );

    let columnCount = 1;
    if (isPaginated && !isPortrait) {
        if (pageSpread === 'single') {
            columnCount = 1;
        } else if (pageSpread === 'double') {
            columnCount = safeW >= 320 ? 2 : 1;
        } else {
            columnCount = !isNarrowMobile ? 2 : 1;
        }
    }

    const effectiveGap = isPaginated
        ? Math.max(20, Math.floor(Number(columnGap || 40) / 2) * 2)
        : 0;

    const columnWidth = columnCount === 2
        ? Math.max(120, Math.floor((contentWidth - effectiveGap) / 2))
        : contentWidth;

    return {
        usableWidth: safeW,
        usableHeight: safeH,
        exactLineHeightPx,
        paddingTop,
        paddingBottom,
        paddingLeft,
        paddingRight,
        safetyBuffer,
        contentAvailableHeight,
        fullLineCount,
        pageHeight,
        contentWidth,
        columnCount,
        columnGap: effectiveGap,
        columnWidth,
        isPortrait,
        isNarrowMobile
    };
}

/**
 * 줄바꿈된 단일 TextNode에서 특정 시각적 줄(rect 인덱스)에 해당하는 문자 오프셋 범위를 이진 탐색으로 찾습니다.
 * @param {Document} doc - iframe 내부 Document
 * @param {Text} textNode - 대상 텍스트 노드
 * @param {number} targetRectIndex - 비영(non-zero) clientRect 목록 기준 0-based 인덱스
 * @param {number} totalRects - 비영(non-zero) clientRect 전체 개수
 * @returns {{ startOffset: number, endOffset: number, text: string }}
 */
function resolveLineSliceOffsets(doc, textNode, targetRectIndex, totalRects) {
    const raw = textNode?.nodeValue || '';
    const len = raw.length;
    if (!raw || totalRects <= 1) {
        return { startOffset: 0, endOffset: len, text: raw.trim().slice(0, 80) };
    }

    const probeRange = doc.createRange();
    try {
        const countNonZeroRectsUpTo = (endOffset) => {
            probeRange.setStart(textNode, 0);
            probeRange.setEnd(textNode, endOffset);
            let count = 0;
            for (const r of probeRange.getClientRects()) {
                if (r.width > 0 && r.height > 0) count++;
            }
            return count;
        };

        let startOffset = 0;
        if (targetRectIndex > 0) {
            let lo = 0;
            let hi = len;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (countNonZeroRectsUpTo(mid) >= targetRectIndex + 1) hi = mid;
                else lo = mid + 1;
            }
            startOffset = Math.max(0, lo - 1);
        }

        let endOffset = len;
        if (targetRectIndex + 1 < totalRects) {
            let lo = startOffset;
            let hi = len;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (countNonZeroRectsUpTo(mid) >= targetRectIndex + 2) hi = mid;
                else lo = mid + 1;
            }
            endOffset = Math.max(startOffset, lo - 1);
        }

        const text = raw.slice(startOffset, endOffset).trim() || raw.trim();
        return { startOffset, endOffset, text: text.slice(0, 80) };
    } catch (e) {
        return { startOffset: 0, endOffset: len, text: raw.trim().slice(0, 80) };
    } finally {
        probeRange.detach();
    }
}

/**
 * 🔬 현재 보이는 iframe 뷰포트 범위 내의 텍스트 라인과 노드/오프셋 좌표를 정밀 수집합니다.
 * @param {Document} doc - iframe 내부 Document
 * @param {Object} [options={}]
 * @param {number} [options.viewportTop=0] - iframe 내부 기준 가시 영역 상단 Y (px)
 * @param {number} [options.viewportBottom] - iframe 내부 기준 가시 영역 하단 Y (px, 기본: innerHeight)
 * @param {number} [options.viewportLeft=-2] - iframe 내부 기준 가시 영역 좌측 X (px)
 * @param {number} [options.viewportRight] - iframe 내부 기준 가시 영역 우측 X (px, 기본: clientWidth)
 * @param {number} [options.columnCount=1] - 현재 조판 컬럼 수 (2단 시 컬럼 우선 정렬에 사용)
 * @param {number} [options.columnWidth=0] - 단일 컬럼 너비 (px)
 * @param {number} [options.columnGap=0] - 컬럼 간격 (px)
 * @param {boolean} [options.resolveLineText=true] - 줄바꿈 문단에서 정확한 줄 문자열/오프셋 분리 여부
 * @returns {Array<{
 *   node: Text,
 *   startOffset: number,
 *   endOffset: number,
 *   text: string,
 *   tagName: string,
 *   top: number,
 *   bottom: number,
 *   left: number,
 *   right: number,
 *   height: number,
 *   topCutPx: number,
 *   bottomCutPx: number,
 *   isFullyVisible: boolean
 * }>}
 */
export function collectVisibleTextLines(doc, options = {}) {
    if (!doc || !doc.body) return [];

    const win = doc.defaultView;
    const viewTop = Number(options.viewportTop ?? 0);
    const viewBottom = Number(options.viewportBottom ?? (win?.innerHeight || doc.documentElement?.clientHeight || 800));
    const viewLeft = Number(options.viewportLeft ?? -2);
    const viewRight = Number(options.viewportRight ?? (win?.innerWidth || doc.documentElement?.clientWidth || 360));
    const resolveLineText = options.resolveLineText !== false;

    const columnCount = Number(options.columnCount || 1);
    const columnWidth = Number(options.columnWidth || 0);
    const columnGap = Number(options.columnGap || 0);
    const useColumnOrder = columnCount >= 2 && columnWidth > 0;
    const colStride = Math.max(1, columnWidth + columnGap);

    const getColumnIndex = (line) => {
        if (!useColumnOrder) return 0;
        const shiftedLeft = Math.max(0, line.left + (columnGap * 0.5));
        return Math.min(columnCount - 1, Math.floor(shiftedLeft / colStride));
    };

    const nodeFilter = win?.NodeFilter || NodeFilter;
    const walker = doc.createTreeWalker(doc.body, nodeFilter.SHOW_TEXT, {
        acceptNode: (n) => {
            const parent = n.parentElement;
            if (!parent) return nodeFilter.FILTER_REJECT;
            const tag = parent.tagName.toLowerCase();
            if (tag === 'script' || tag === 'style' || tag === 'noscript') {
                return nodeFilter.FILTER_REJECT;
            }
            return n.nodeValue && n.nodeValue.trim().length > 0
                ? nodeFilter.FILTER_ACCEPT
                : nodeFilter.FILTER_SKIP;
        }
    });

    const lines = [];
    let textNode;

    while ((textNode = walker.nextNode())) {
        const parentEl = textNode.parentElement;
        if (parentEl) {
            const pRect = parentEl.getBoundingClientRect();
            if (pRect.bottom < viewTop - 60 || pRect.top > viewBottom + 60) {
                continue;
            }
            if (pRect.right < viewLeft - 60 || pRect.left > viewRight + 60) {
                continue;
            }
        }

        const range = doc.createRange();
        try {
            range.selectNodeContents(textNode);
            const nonZeroRects = [];
            for (const r of range.getClientRects()) {
                if (r.width > 0 && r.height > 0) {
                    nonZeroRects.push(r);
                }
            }

            const totalRects = nonZeroRects.length;
            for (let idx = 0; idx < totalRects; idx++) {
                const r = nonZeroRects[idx];
                if (r.left < viewLeft || r.left >= viewRight) continue;
                if (r.bottom <= viewTop || r.top >= viewBottom) continue;

                const topCutPx = Math.max(0, Number((viewTop - r.top).toFixed(3)));
                const bottomCutPx = Math.max(0, Number((r.bottom - viewBottom).toFixed(3)));

                const slice = (resolveLineText && totalRects > 1)
                    ? resolveLineSliceOffsets(doc, textNode, idx, totalRects)
                    : {
                        startOffset: 0,
                        endOffset: textNode.nodeValue.length,
                        text: textNode.nodeValue.trim().slice(0, 80)
                    };

                lines.push({
                    node: textNode,
                    startOffset: slice.startOffset,
                    endOffset: slice.endOffset,
                    text: slice.text,
                    tagName: parentEl?.tagName || 'TEXT',
                    top: Number(r.top.toFixed(3)),
                    bottom: Number(r.bottom.toFixed(3)),
                    left: Number(r.left.toFixed(3)),
                    right: Number(r.right.toFixed(3)),
                    height: Number(r.height.toFixed(3)),
                    topCutPx,
                    bottomCutPx,
                    isFullyVisible: topCutPx <= 0.5 && bottomCutPx <= 0.5
                });
            }
        } finally {
            range.detach();
        }
    }

    lines.sort((a, b) => {
        if (useColumnOrder) {
            const colDiff = getColumnIndex(a) - getColumnIndex(b);
            if (colDiff !== 0) return colDiff;
        }
        return (a.top - b.top) || (a.left - b.left);
    });
    return lines;
}

/**
 * 현재 뷰포트 내 첫 번째 가시 라인(온전한 줄 우선)을 반환합니다.
 * @param {Document} doc
 * @param {Object} [options={}]
 * @returns {Object|null}
 */
export function getFirstVisibleLine(doc, options = {}) {
    const lines = collectVisibleTextLines(doc, options);
    if (lines.length === 0) return null;
    return lines.find((l) => l.isFullyVisible) || lines[0];
}

/**
 * 현재 뷰포트 내 마지막 가시 라인(온전한 줄 우선)을 반환합니다.
 * @param {Document} doc
 * @param {Object} [options={}]
 * @returns {Object|null}
 */
export function getLastVisibleLine(doc, options = {}) {
    const lines = collectVisibleTextLines(doc, options);
    if (lines.length === 0) return null;
    const fully = lines.filter((l) => l.isFullyVisible);
    return fully.length > 0 ? fully[fully.length - 1] : lines[lines.length - 1];
}

/**
 * 세로(scrolled) 페이지 단위 이동 시 경계 걸침 줄을 기준으로 정확한 다음/이전 이동 거리(px)를 계산합니다.
 * @param {Document} doc - iframe 내부 Document
 * @param {'next'|'prev'} direction - 이동 방향
 * @param {number} pageHeight - 1페이지 기준 조판 높이 (px)
 * @param {number} exactLineHeightPx - 1줄 높이 (px)
 * @returns {{ distance: number, reason: string }}
 */
export function calculateScrolledLineSnapDelta(doc, direction, pageHeight, exactLineHeightPx) {
    const safePageH = Math.max(100, Number(pageHeight) || 800);
    const safeLineH = Math.max(12, Number(exactLineHeightPx) || 24);

    if (!doc || !doc.body) {
        return { distance: safePageH, reason: 'fallback_no_doc' };
    }

    const lines = collectVisibleTextLines(doc, {
        viewportTop: 0,
        viewportBottom: safePageH,
        resolveLineText: false
    });

    if (lines.length === 0) {
        return { distance: safePageH, reason: 'fallback_no_lines' };
    }

    if (direction === 'next') {
        const fully = lines.filter((l) => l.isFullyVisible);
        if (fully.length > 0) {
            const lastFull = fully[fully.length - 1];
            const lastFullIdx = lines.indexOf(lastFull);
            const partialNext = lines[lastFullIdx + 1];
            if (partialNext && partialNext.top > 0) {
                const snapped = Math.max(safeLineH, Math.min(safePageH + safeLineH, partialNext.top));
                return { distance: Number(snapped.toFixed(2)), reason: 'snap_next_partial_line' };
            }
        } else {
            // 온전한 줄이 0개이고 하단 경계에 걸친 줄만 존재하는 경우에도 해당 줄 시작점으로 스냅
            const partialBottom = lines.find((l) => l.bottomCutPx > 0.5 && l.top > 0);
            if (partialBottom) {
                const snapped = Math.max(safeLineH, Math.min(safePageH + safeLineH, partialBottom.top));
                return { distance: Number(snapped.toFixed(2)), reason: 'snap_next_partial_no_full' };
            }
        }
        return { distance: safePageH, reason: 'exact_page_height' };
    }

    const first = lines[0];
    const topOffset = first ? Math.max(0, first.top) : 0;
    const prevDist = Math.max(safeLineH, Math.min(safePageH, safePageH - topOffset));
    return { distance: Number(prevDist.toFixed(2)), reason: 'snap_prev_top_offset' };
}