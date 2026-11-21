/**
 * 🧭 국제 표준 EPUB CFI 인코더/디코더 및 DOM Range 좌표 변환기 (CfiCodec)
 * - 📜 [표준 규격 준수] epubcfi(/6/{spineStep}!/4/...:offset), 3분할 범위 CFI(common,start,end) 및 2분할 범위 CFI 완벽 지원
 * - 🛡️ [안전 복원] [id] 힌트 폴백, 오프셋 범위 클램핑(IndexSizeError 방지), 엔진 주입 요소 무시 탑재
 * - 📐 [무의존성 좌표 비교] compareCfiStart / isSameCfiStart로 Range·Point·[id] 힌트 차이 없이 시작점 정밀 비교 지원
 * - 🔌 [무의존성 순수 모듈] 외부 라이브러리 없이 표준 DOM Node/Range API만으로 동작
 * 파일 경로: web/ewb-js/layout/CfiCodec.js
 * @module ewb-js/layout/CfiCodec
 */

/**
 * 엔진이 조판·스타일을 위해 문서 내부에 주입한 요소인지 판별합니다.
 * @param {Node|null} node
 * @returns {boolean}
 */
function isEngineInjectedNode(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    const id = node.id;
    if (id === 'ewb-core-layout-style' || id === 'ewb-user-style') return true;
    return node.getAttribute?.('data-ewb-end-spacer') === 'true';
}

/**
 * 단일 CFI 로컬 스텝 문자열(`/4/2[id]/1:offset`)을 파싱합니다.
 * @param {string} [pathStr='']
 * @returns {{ steps: Array<{ index: number, id: string|null }>, offset: number|null }}
 */
function parseLocalSteps(pathStr = '') {
    const clean = String(pathStr || '').trim();
    if (!clean) return { steps: [], offset: null };

    const [stepPart, offsetPart] = clean.split(':');
    const offset = offsetPart !== undefined && /^\d+$/.test(offsetPart)
        ? parseInt(offsetPart, 10)
        : null;

    const steps = [];
    const tokens = stepPart.split('/').filter(Boolean);
    for (const token of tokens) {
        const match = /^(\d+)(?:\[([^\]]+)\])?$/.exec(token);
        if (match) {
            steps.push({ index: parseInt(match[1], 10), id: match[2] || null });
        }
    }
    return { steps, offset };
}

/**
 * 공통 부모 스텝과 상대 경로 스텝을 하나로 병합합니다.
 * @param {{ steps: Array, offset: number|null }} common
 * @param {{ steps: Array, offset: number|null }} relative
 * @returns {{ steps: Array, offset: number|null }}
 */
function mergeLocalSteps(common, relative) {
    return {
        steps: [...(common?.steps || []), ...(relative?.steps || [])],
        offset: relative?.offset !== null && relative?.offset !== undefined
            ? relative.offset
            : (common?.offset ?? null)
    };
}

/**
 * DOM 노드와 오프셋을 CFI 로컬 경로 문자열로 인코딩합니다.
 * @param {Node} node
 * @param {number} offset
 * @param {Document} doc
 * @returns {string}
 */
function encodeNodePath(node, offset, doc) {
    if (!node || !doc || !doc.documentElement) return '/4:0';
    const parts = [];
    let current = node;

    while (current && current !== doc.documentElement) {
        const parent = current.parentNode;
        if (!parent) break;

        if (current.nodeType === Node.TEXT_NODE) {
            let elemCount = 0;
            for (let sib = parent.firstChild; sib && sib !== current; sib = sib.nextSibling) {
                if (sib.nodeType === Node.ELEMENT_NODE && !isEngineInjectedNode(sib)) elemCount++;
            }
            parts.unshift(`/${elemCount * 2 + 1}`);
        } else if (current.nodeType === Node.ELEMENT_NODE) {
            let elemPos = 1;
            for (let sib = parent.firstChild; sib && sib !== current; sib = sib.nextSibling) {
                if (sib.nodeType === Node.ELEMENT_NODE && !isEngineInjectedNode(sib)) elemPos++;
            }
            const idHint = current.id ? `[${String(current.id).replace(/[\[\]]/g, '')}]` : '';
            parts.unshift(`/${elemPos * 2}${idHint}`);
        }
        current = parent;
    }

    const path = parts.join('') || '/4';
    return (typeof offset === 'number' && offset >= 0) ? `${path}:${offset}` : path;
}

function findFirstTextNode(root) {
    if (!root) return null;
    if (root.nodeType === Node.TEXT_NODE) return root;
    for (let c = root.firstChild; c; c = c.nextSibling) {
        if (isEngineInjectedNode(c)) continue;
        const found = findFirstTextNode(c);
        if (found) return found;
    }
    return null;
}

function walkDownSteps(startNode, steps) {
    let current = startNode;
    for (const step of steps) {
        if (!current) return null;
        if (step.index % 2 === 0) {
            const targetElemOrdinal = Math.max(1, step.index / 2);
            let count = 0;
            let matched = null;
            for (let c = current.firstChild; c; c = c.nextSibling) {
                if (c.nodeType === Node.ELEMENT_NODE && !isEngineInjectedNode(c)) {
                    count++;
                    if (count === targetElemOrdinal) { matched = c; break; }
                }
            }
            if (!matched) return current;
            current = matched;
        } else {
            const precedingElemsNeeded = Math.floor(step.index / 2);
            let elemCount = 0;
            let textCandidate = null;
            for (let c = current.firstChild; c; c = c.nextSibling) {
                if (c.nodeType === Node.ELEMENT_NODE && !isEngineInjectedNode(c)) {
                    elemCount++;
                } else if (c.nodeType === Node.TEXT_NODE && elemCount === precedingElemsNeeded) {
                    if (c.nodeValue && c.nodeValue.length > 0) { textCandidate = c; break; }
                }
            }
            current = textCandidate || findFirstTextNode(current) || current;
        }
    }
    return current;
}

function resolveNodeBySteps(doc, steps) {
    if (!doc || !doc.documentElement || !Array.isArray(steps) || steps.length === 0) {
        return doc?.body || null;
    }
    for (let i = steps.length - 1; i >= 0; i--) {
        if (steps[i].id) {
            const byId = doc.getElementById(steps[i].id);
            if (byId) {
                if (i === steps.length - 1) return byId;
                return walkDownSteps(byId, steps.slice(i + 1)) || byId;
            }
        }
    }
    return walkDownSteps(doc.documentElement, steps) || doc.body;
}

/**
 * 유효한 epubcfi(...) 형식 문자열인지 검증합니다.
 * @param {string} cfiString
 * @returns {boolean}
 */
function isValidEpubCfiString(cfiString) {
    if (typeof cfiString !== 'string') return false;
    const raw = cfiString.trim();
    return raw.startsWith('epubcfi(') && raw.endsWith(')');
}

/**
 * 파싱된 두 CFI의 시작점(spineIndex, steps, offset) 선후 관계를 비교합니다.
 * - [id] 힌트 유무와 Range 끝점 차이는 무시하고 시작 위치 숫자 좌표만 비교합니다.
 * @param {Object} parsedA
 * @param {Object} parsedB
 * @returns {-1|0|1}
 */
function compareParsedStartPoints(parsedA, parsedB) {
    if (parsedA.spineIndex !== parsedB.spineIndex) {
        return parsedA.spineIndex < parsedB.spineIndex ? -1 : 1;
    }

    const stepsA = parsedA.start?.steps || [];
    const stepsB = parsedB.start?.steps || [];
    const minLen = Math.min(stepsA.length, stepsB.length);

    for (let i = 0; i < minLen; i++) {
        const idxA = stepsA[i].index;
        const idxB = stepsB[i].index;
        if (idxA !== idxB) {
            return idxA < idxB ? -1 : 1;
        }
    }

    if (stepsA.length !== stepsB.length) {
        return stepsA.length < stepsB.length ? -1 : 1;
    }

    const offsetA = Number(parsedA.start?.offset ?? 0);
    const offsetB = Number(parsedB.start?.offset ?? 0);
    if (offsetA !== offsetB) {
        return offsetA < offsetB ? -1 : 1;
    }

    return 0;
}

const sharedCfiCodec = new (class SharedCfiCodecProxy {})();

export class CfiCodec {
    /**
     * 챕터 스파인 인덱스에 대한 기본 섹션 CFI를 생성합니다.
     * @param {number} spineIndex
     * @param {Object|null} [book=null]
     * @returns {string}
     */
    buildSectionCfi(spineIndex, book = null) {
        const idx = Math.max(0, Number(spineIndex) || 0);
        const spineStep = (idx + 1) * 2;
        const secId = book?.sections?.[idx]?.id;
        const idHint = secId ? `[${String(secId).replace(/[\[\]]/g, '')}]` : '';
        return `epubcfi(/6/${spineStep}${idHint}!)`;
    }

    /**
     * DOM Range로부터 표준 EPUB CFI 문자열을 생성합니다.
     * @param {number} spineIndex
     * @param {Range} range
     * @param {Document} doc
     * @param {Object|null} [book=null]
     * @returns {string}
     */
    fromRange(spineIndex, range, doc, book = null) {
        const base = this.buildSectionCfi(spineIndex, book);
        if (!range || !doc) return base;
        const baseInner = base.slice('epubcfi('.length, -1);
        const startPath = encodeNodePath(range.startContainer, range.startOffset, doc);
        if (range.collapsed) {
            return `epubcfi(${baseInner}${startPath})`;
        }
        const endPath = encodeNodePath(range.endContainer, range.endOffset, doc);
        return `epubcfi(${baseInner},${startPath},${endPath})`;
    }

    /**
     * EPUB CFI 문자열(단일 점, 2분할 범위, 3분할 표준 범위 CFI)을 파싱합니다.
     * @param {string} cfiString
     * @param {Object|null} [book=null]
     * @returns {{ raw: string, spineIndex: number, isRange: boolean, start: Object, end: Object|null }}
     */
    parse(cfiString, book = null) {
        const raw = String(cfiString || '').trim();
        if (!raw.startsWith('epubcfi(') || !raw.endsWith(')')) {
            return { raw, spineIndex: 0, isRange: false, start: { steps: [], offset: null }, end: null };
        }
        const inner = raw.slice('epubcfi('.length, -1);
        const bangPos = inner.indexOf('!');
        const packagePart = bangPos >= 0 ? inner.slice(0, bangPos) : inner;
        const localPart = bangPos >= 0 ? inner.slice(bangPos + 1) : '';

        let spineIndex = 0;
        const pkgTokens = packagePart.split('/').filter(Boolean);
        const itemRefToken = pkgTokens[1] || pkgTokens[0] || '';
        const refMatch = /^(\d+)(?:\[([^\]]+)\])?$/.exec(itemRefToken);

        if (refMatch) {
            const stepNum = parseInt(refMatch[1], 10);
            const idHint = refMatch[2];
            spineIndex = Math.max(0, Math.floor(stepNum / 2) - 1);
            if (idHint && book?.sections?.length) {
                const byIdIdx = book.sections.findIndex((s) => s.id === idHint);
                if (byIdIdx >= 0) spineIndex = byIdIdx;
            }
        }

        if (localPart.includes(',')) {
            const rawCommaParts = localPart.split(',');
            if (rawCommaParts.length >= 3) {
                const common = parseLocalSteps(rawCommaParts[0] || '');
                const startRel = parseLocalSteps(rawCommaParts[1] || '');
                const endRel = parseLocalSteps(rawCommaParts[2] || '');
                return {
                    raw,
                    spineIndex,
                    isRange: true,
                    start: mergeLocalSteps(common, startRel),
                    end: (rawCommaParts[2] || '').trim() ? mergeLocalSteps(common, endRel) : null
                };
            }
            return {
                raw,
                spineIndex,
                isRange: true,
                start: parseLocalSteps(rawCommaParts[0] || rawCommaParts[1] || ''),
                end: rawCommaParts[1] ? parseLocalSteps(rawCommaParts[1]) : null
            };
        }

        return { raw, spineIndex, isRange: false, start: parseLocalSteps(localPart), end: null };
    }

    /**
     * 두 EPUB CFI의 시작점(start) 위치를 비교합니다.
     * - 유효한 epubcfi(...) 형식이 아닌 경우 null을 반환합니다.
     * @param {string} cfiA
     * @param {string} cfiB
     * @param {Object|null} [book=null]
     * @returns {-1|0|1|null}
     */
    compareStart(cfiA, cfiB, book = null) {
        if (!isValidEpubCfiString(cfiA) || !isValidEpubCfiString(cfiB)) return null;
        const parsedA = this.parse(cfiA, book);
        const parsedB = this.parse(cfiB, book);
        return compareParsedStartPoints(parsedA, parsedB);
    }

    /**
     * 두 EPUB CFI의 시작점(start)이 동일한지 판별합니다. (끝점/힌트 ID 차이 무시)
     * @param {string} cfiA
     * @param {string} cfiB
     * @param {Object|null} [book=null]
     * @returns {boolean}
     */
    isSameStart(cfiA, cfiB, book = null) {
        return this.compareStart(cfiA, cfiB, book) === 0;
    }

    /**
     * 파싱된 CFI 객체를 대상 Document의 DOM Range로 복원합니다.
     * @param {Object} parsedCfi - parse() 반환 객체
     * @param {Document} doc - 대상 챕터 iframe Document
     * @param {Object} [options={}]
     * @param {boolean} [options.collapseToStart=true] - true면 시작점으로 접은 Range 반환, false면 범위 끝점까지 복원
     * @returns {Range|null}
     */
    resolveRangeInDocument(parsedCfi, doc, options = {}) {
        if (!parsedCfi || !doc || !doc.body) return null;
        const collapseToStart = options.collapseToStart !== false;

        try {
            const startNode = resolveNodeBySteps(doc, parsedCfi.start?.steps || []);
            if (!startNode) return null;

            const range = doc.createRange();
            if (startNode.nodeType === Node.TEXT_NODE) {
                const maxLen = startNode.nodeValue ? startNode.nodeValue.length : 0;
                const safeOffset = Math.min(maxLen, Math.max(0, Number(parsedCfi.start?.offset || 0)));
                range.setStart(startNode, safeOffset);
            } else {
                range.setStart(startNode, 0);
            }

            if (!collapseToStart && parsedCfi.isRange && parsedCfi.end) {
                const endNode = resolveNodeBySteps(doc, parsedCfi.end.steps || []);
                if (endNode) {
                    const safeEndOffset = endNode.nodeType === Node.TEXT_NODE
                        ? Math.min(endNode.nodeValue ? endNode.nodeValue.length : 0, Math.max(0, Number(parsedCfi.end.offset || 0)))
                        : 0;
                    const endProbe = doc.createRange();
                    try {
                        endProbe.setStart(endNode, safeEndOffset);
                        endProbe.collapse(true);
                        if (range.compareBoundaryPoints(Range.START_TO_START, endProbe) <= 0) {
                            range.setEnd(endNode, safeEndOffset);
                            return range;
                        }
                    } finally {
                        endProbe.detach();
                    }
                }
            }

            range.collapse(true);
            return range;
        } catch (err) {
            return null;
        }
    }
}

sharedCfiCodec.parse = CfiCodec.prototype.parse;

/**
 * 인스턴스 생성 없이 두 EPUB CFI의 시작점(start)을 비교하는 순수 헬퍼 함수
 * @param {string} cfiA
 * @param {string} cfiB
 * @param {Object|null} [book=null]
 * @returns {-1|0|1|null}
 */
export function compareCfiStart(cfiA, cfiB, book = null) {
    if (!isValidEpubCfiString(cfiA) || !isValidEpubCfiString(cfiB)) return null;
    const parsedA = sharedCfiCodec.parse(cfiA, book);
    const parsedB = sharedCfiCodec.parse(cfiB, book);
    return compareParsedStartPoints(parsedA, parsedB);
}

/**
 * 인스턴스 생성 없이 두 EPUB CFI의 시작점(start)이 동일한지 확인하는 순수 헬퍼 함수
 * @param {string} cfiA
 * @param {string} cfiB
 * @param {Object|null} [book=null]
 * @returns {boolean}
 */
export function isSameCfiStart(cfiA, cfiB, book = null) {
    return compareCfiStart(cfiA, cfiB, book) === 0;
}