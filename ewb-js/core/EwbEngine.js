/**
 * 🚀 EWB 차세대 확장형 EPUB 뷰어 코어 엔진 오케스트레이터 (EwbEngine)
 * - 🧩 [Mod/Plugin 아키텍처] HookBus(중계소) + EngineContext(API 집합소) + engine.use(mod)/unuse(mod) 지원
 * - 🎨 [테마 API 분리] setTheme / getTheme로 userCss(폰트/문단)를 유지한 채 배경색·글자색·링크색 0ms 즉시 전환
 * - 🪟 [슬롯 통합] SlotController를 통해 single / triple 슬롯 모드 및 0ms 챕터 전환 기본 제공
 * - 📐 [한 줄 스냅 & 부드러운 스크롤] ViewportSnap + PaginatorLayout 기반으로 가로/세로/애니메이션 제어
 * - 🔬 [정밀 뷰포트 추적 로그] 이동 시 첫째/마지막 줄, 줄·문단 수, 상하좌우 여백, 상·하단 잘림 실측치 통합 출력
 * - 🎯 [전체 API 개방] 이동, 좌표/라인 측정, 재조판, 검색, CFI 코덱, 프레임 순회까지 외부 커스텀 API 100% 개방
 * 파일 경로: web/ewb-js/core/EwbEngine.js
 * @module ewb-js/core/EwbEngine
 */

import { createLogger } from '../utils/Logger.js';
import { HookBus } from './HookBus.js';
import { EngineContext } from './EngineContext.js';
import { SlotController } from './SlotController.js';
import { EpubParser } from '../parser/EpubParser.js';
import { CfiCodec } from '../layout/CfiCodec.js';

export const EngineState = {
    IDLE: 'IDLE',
    OPENING: 'OPENING',
    READY: 'READY',
    ACTIVE: 'ACTIVE',
    DESTROYED: 'DESTROYED'
};

/**
 * HTML5 표준 EPUB 뷰어 코어 엔진 클래스
 */
export class EwbEngine {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.container - 뷰어를 마운트할 DOM 컨테이너
     * @param {'single'|'triple'} [options.slotMode='triple'] - 슬롯 동작 모드
     * @param {'paginated'|'scrolled'} [options.flow='paginated'] - 보기 방식
     * @param {'auto'|'single'|'double'} [options.pageSpread='auto'] - 가로 다단 설정
     * @param {'instant'|'smooth'} [options.transition='instant'] - 페이지 전환 방식
     * @param {boolean} [options.skipLeadingBlankLines=true] - scrolled 모드 페이지 이동 시 상단 소형 빈 줄 스킵 여부
     * @param {number} [options.fontSize=16] - 기본 글자 크기 (px)
     * @param {number} [options.lineHeight=1.4] - 기본 줄간격 배수
     * @param {Object} [options.margins] - { top, bottom, left, right }
     * @param {Object|null} [options.theme=null] - 초기 테마 { backgroundColor, textColor, linkColor, selectionColor }
     * @param {string} [options.userCss=''] - 사용자 테마/폰트 CSS
     * @param {Object|null} [options.logger=null] - EngineLogger 인스턴스 또는 logger 옵션
     * @param {Object|null} [options.parser=null] - 커스텀 EPUB 파서 주입 (선택)
     * @param {Object|null} [options.cfiCodec=null] - 커스텀 CFI 코덱 주입 (선택)
     */
    constructor(options = {}) {
        if (!options.container) {
            throw new Error('[EwbEngine] options.container DOM element is required.');
        }

        this.container = options.container;
        this.logger = (options.logger && typeof options.logger.child === 'function')
            ? options.logger
            : createLogger(options.logger || {});
        this._log = this.logger.child('EwbEngine');

        this.state = EngineState.IDLE;
        this._isDestroyed = false;
        this._openToken = 0;

        this._baseBackgroundColor = options.backgroundColor || 'transparent';
        this._theme = null;

        this.layoutOptions = {
            flow: options.flow === 'scrolled' ? 'scrolled' : 'paginated',
            pageSpread: options.pageSpread || 'auto',
            transition: options.transition === 'smooth' ? 'smooth' : 'instant',
            skipLeadingBlankLines: options.skipLeadingBlankLines !== false,
            fontSize: Number(options.fontSize || 16),
            lineHeight: Number(options.lineHeight || 1.4),
            marginTop: Number(options.margins?.top ?? options.marginTop ?? 40),
            marginBottom: Number(options.margins?.bottom ?? options.marginBottom ?? 40),
            marginLeft: Number(options.margins?.left ?? options.marginLeft ?? 48),
            marginRight: Number(options.margins?.right ?? options.marginRight ?? 48),
            columnGap: Number(options.columnGap ?? 40),
            backgroundColor: this._baseBackgroundColor,
            usableWidth: this._measureContainerSize().width,
            usableHeight: this._measureContainerSize().height
        };
        this._userCss = options.userCss || '';

        if (options.theme && typeof options.theme === 'object') {
            this._applyThemeState(options.theme);
        }

        // 1. 중계소(HookBus) & API 집합소(EngineContext) 초기화
        this.hookBus = new HookBus({ logger: this.logger });
        this.context = new EngineContext(this, this.hookBus, this.logger);

        // 2. 파서 · CFI 코덱 초기화 (주입 또는 기본 모듈)
        this.parser = options.parser || new EpubParser({ logger: this.logger });
        this.cfiCodec = options.cfiCodec || new CfiCodec();

        /** @type {Object|null} 파싱된 Book 객체 */
        this.book = null;
        this._ownsBookResources = false;
        /** @type {Array<{ name: string, modRef: Function|Object, teardown: Function|null }>} */
        this._installedMods = [];
        /** @type {Set<Object>} 외부 모드가 생성한 독립 ChapterFrame 추적 목록 */
        this._externalFrames = new Set();
        /** @type {Map<string, Set<Function>>} */
        this._eventListeners = new Map();

        // 3. 컨테이너 기본 스타일, 기본 내부 링크·테마·GC 폴백, SlotController 구성
        this._prepareContainer();
        this._registerDefaultCoreHooks();

        this.slots = new SlotController({
            container: this.container,
            slotMode: options.slotMode === 'single' ? 'single' : 'triple',
            loadChapterHtml: (idx) => this._loadResolvedChapterHtml(idx),
            getSectionHref: (idx) => this.book?.sections?.[idx]?.href || '',
            getSpineCount: () => this.book?.sections?.length || 0,
            getLayoutOptions: () => this._getEffectiveLayoutOptions(),
            getUserCss: () => this._userCss,
            hookBus: this.hookBus,
            logger: this.logger
        });

        // 4. ResizeObserver 자동 대응
        this._lastObservedSize = this._measureContainerSize();
        this._resizeTimer = null;
        this._resizeObserver = this._initResizeObserver();

        this._log.trace({
            action: 'init',
            caller: 'new EwbEngine',
            state: this.state,
            delta: `${this._lastObservedSize.width}x${this._lastObservedSize.height}px, margins(T:${this.layoutOptions.marginTop} B:${this.layoutOptions.marginBottom} L:${this.layoutOptions.marginLeft} R:${this.layoutOptions.marginRight})`,
            result: `slotMode=${this.slots.slotMode}, flow=${this.layoutOptions.flow}`
        });
    }

    /**
     * 코어 기본 내부 앵커 링크 처리, 신규 프레임 테마 주입 및 외부 프레임 소독 훅을 등록합니다.
     * @private
     */
    _registerDefaultCoreHooks() {
        this.hookBus.on('onFrameMount', (payload) => {
            if (payload?.frame && typeof payload.frame.setThemeStyle === 'function') {
                payload.frame.setThemeStyle(this.getThemeCss());
            }
        }, { priority: 999, name: 'ewb-default-theme-injector' });

        this.hookBus.on('onLinkClick', (payload) => {
            if (!payload || payload.isExternal || !payload.href) return;
            const resolvedHref = this._resolveRelativeHref(payload.href, payload.chapterHref || '');
            this.goTo(resolvedHref, { behavior: 'instant' });
            return { handled: true };
        }, { priority: 999, name: 'ewb-default-link-handler' });

        this.hookBus.on('onFrameDestroy', (payload) => {
            if (payload?.frame && this._externalFrames.has(payload.frame)) {
                this._externalFrames.delete(payload.frame);
            }
        }, { priority: 999, name: 'ewb-external-frame-gc' });
    }

    /**
     * 테마 객체를 내부 상태에 정규화 반영합니다.
     * @param {Object|null} theme
     * @private
     */
    _applyThemeState(theme) {
        if (!theme || typeof theme !== 'object' || Object.keys(theme).length === 0) {
            this._theme = null;
            this.layoutOptions.backgroundColor = this._baseBackgroundColor;
            return;
        }

        const normalized = {
            backgroundColor: String(theme.backgroundColor ?? theme.bg ?? '').trim(),
            textColor: String(theme.textColor ?? theme.color ?? theme.fg ?? '').trim(),
            linkColor: String(theme.linkColor ?? theme.link ?? '').trim(),
            selectionColor: String(theme.selectionColor ?? theme.selection ?? '').trim()
        };
        const hasAny = Boolean(
            normalized.backgroundColor
            || normalized.textColor
            || normalized.linkColor
            || normalized.selectionColor
        );

        this._theme = hasAny ? normalized : null;
        this.layoutOptions.backgroundColor = normalized.backgroundColor || this._baseBackgroundColor;
    }

    /**
     * 현재 설정된 테마 객체를 바탕으로 iframe 주입용 CSS 문자열을 생성합니다.
     * @returns {string}
     */
    getThemeCss() {
        const theme = this._theme;
        if (!theme) return '';

        const rules = [];
        if (theme.backgroundColor || theme.textColor) {
            rules.push(`
                html, body {
                    ${theme.backgroundColor ? `background-color: ${theme.backgroundColor} !important;` : ''}
                    ${theme.textColor ? `color: ${theme.textColor} !important;` : ''}
                }
            `);
        }
        if (theme.textColor) {
            rules.push(`
                body p, body div, body span, body li, body dt, body dd,
                body blockquote, body pre, body h1, body h2, body h3, body h4, body h5, body h6,
                body em, body strong, body b, body i {
                    color: inherit !important;
                }
            `);
        }
        if (theme.linkColor) {
            rules.push(`
                a, a * {
                    color: ${theme.linkColor} !important;
                }
            `);
        }
        if (theme.selectionColor) {
            rules.push(`
                ::selection {
                    background: ${theme.selectionColor} !important;
                }
            `);
        }
        return rules.join('\n').trim();
    }

    /**
     * 외부 모드가 생성한 독립 ChapterFrame을 엔진 수명주기에 등록합니다.
     * @param {Object} frame
     * @private
     */
    _trackExternalFrame(frame) {
        if (!frame || this._isDestroyed) return;
        this._externalFrames.add(frame);
    }

    /**
     * 챕터 기준 상대 href(`../Text/ch2.xhtml#sec`)를 정규 경로로 해석합니다.
     * @param {string} rawHref
     * @param {string} [baseHref='']
     * @returns {string}
     * @private
     */
    _resolveRelativeHref(rawHref, baseHref = '') {
        const trimmed = String(rawHref || '').trim();
        if (!trimmed || trimmed.startsWith('#')) return trimmed;
        try {
            const cleanBase = String(baseHref || '').replace(/^\/+/, '');
            const url = new URL(trimmed, `https://ewb.local/${cleanBase}`);
            return `${url.pathname.replace(/^\/+/, '')}${url.hash || ''}`;
        } catch (e) {
            return trimmed;
        }
    }

    /**
     * 컨테이너 위치·클리핑·여백 영역 배경색을 초기화합니다.
     * @private
     */
    _prepareContainer() {
        const computed = window.getComputedStyle(this.container);
        if (computed.position === 'static') {
            this.container.style.position = 'relative';
        }
        this.container.style.overflow = 'hidden';
        this._syncContainerBackground();
    }

    /**
     * 외곽 여백 영역과 본문 배경색이 일치하도록 컨테이너 배경색을 동기화합니다.
     * @private
     */
    _syncContainerBackground() {
        if (!this.container) return;
        const bg = this.layoutOptions?.backgroundColor;
        if (bg && bg !== 'transparent') {
            this.container.style.backgroundColor = bg;
        } else {
            this.container.style.removeProperty('background-color');
        }
    }

    /**
     * 중첩 margins 객체({ top, bottom, left, right })를 포함한 부분 레이아웃 옵션을 정규화합니다.
     * @param {Object} [partial={}]
     * @returns {Object}
     * @private
     */
    _normalizeLayoutOptions(partial = {}) {
        const { slotMode, margins, ...rest } = partial;
        const normalized = { ...rest };
        if (margins && typeof margins === 'object') {
            if (margins.top !== undefined) normalized.marginTop = Number(margins.top);
            if (margins.bottom !== undefined) normalized.marginBottom = Number(margins.bottom);
            if (margins.left !== undefined) normalized.marginLeft = Number(margins.left);
            if (margins.right !== undefined) normalized.marginRight = Number(margins.right);
        }
        if (normalized.flow !== undefined) {
            normalized.flow = normalized.flow === 'scrolled' ? 'scrolled' : 'paginated';
        }
        if (normalized.transition !== undefined) {
            normalized.transition = normalized.transition === 'smooth' ? 'smooth' : 'instant';
        }
        if (normalized.skipLeadingBlankLines !== undefined) {
            normalized.skipLeadingBlankLines = Boolean(normalized.skipLeadingBlankLines);
        }
        return normalized;
    }

    /** @private */
    _measureContainerSize() {
        const rect = this.container?.getBoundingClientRect?.();
        const width = Math.max(300, Math.floor(rect?.width || this.container?.clientWidth || window.innerWidth));
        const height = Math.max(240, Math.floor(rect?.height || this.container?.clientHeight || window.innerHeight));
        return { width, height };
    }

    /** @private */
    _getEffectiveLayoutOptions() {
        const size = this._measureContainerSize();
        return {
            ...this.layoutOptions,
            usableWidth: size.width,
            usableHeight: size.height
        };
    }

    /** @private */
    _initResizeObserver() {
        if (typeof ResizeObserver !== 'function') return null;
        const observer = new ResizeObserver(() => {
            if (this._isDestroyed || this.state !== EngineState.ACTIVE) return;
            const curr = this._measureContainerSize();
            if (curr.width === this._lastObservedSize.width && curr.height === this._lastObservedSize.height) {
                return;
            }
            if (this._resizeTimer) clearTimeout(this._resizeTimer);
            this._resizeTimer = setTimeout(() => {
                this._resizeTimer = null;
                if (this._isDestroyed || this.state !== EngineState.ACTIVE) return;
                this._lastObservedSize = this._measureContainerSize();
                this.relayout();
            }, 150);
        });
        observer.observe(this.container);
        return observer;
    }

    /**
     * 🧩 게임 모드(Mod / Plugin)를 엔진에 장착합니다. (동기/비동기 setup 및 중복 방지 지원)
     * @param {Function|Object} mod - (ctx) => teardown? 함수 또는 { name, setup(ctx), teardown? } 객체
     * @returns {EwbEngine} 체이닝용 엔진 자신
     */
    use(mod) {
        if (this._isDestroyed || !mod) return this;

        const modName = typeof mod === 'function'
            ? (mod.name || 'anonymous-mod')
            : (mod.name || 'named-mod');

        const isDuplicate = this._installedMods.some(
            (m) => m.modRef === mod || (typeof mod === 'object' && mod.name && m.name === mod.name)
        );
        if (isDuplicate) {
            this._log.warn(`⚠️ 이미 장착된 Mod('${modName}') 중복 설치 무시`);
            return this;
        }

        const entry = {
            name: modName,
            modRef: mod,
            teardown: (typeof mod === 'object' && typeof mod.teardown === 'function')
                ? mod.teardown.bind(mod)
                : null
        };

        try {
            let setupResult = null;
            if (typeof mod === 'function') {
                setupResult = mod(this.context);
            } else if (typeof mod === 'object' && typeof mod.setup === 'function') {
                setupResult = mod.setup(this.context);
            } else {
                this._log.warn(`⚠️ 유효하지 않은 Mod 형식('${modName}')`);
                return this;
            }

            this._installedMods.push(entry);

            if (typeof setupResult === 'function') {
                entry.teardown = typeof mod === 'object' ? setupResult.bind(mod) : setupResult;
            } else if (setupResult && typeof setupResult.then === 'function') {
                setupResult.then((resolvedTeardown) => {
                    if (typeof resolvedTeardown === 'function') {
                        const boundTeardown = typeof mod === 'object' ? resolvedTeardown.bind(mod) : resolvedTeardown;
                        if (this._isDestroyed || !this._installedMods.includes(entry)) {
                            try { boundTeardown(); } catch (e) {}
                            return;
                        }
                        entry.teardown = boundTeardown;
                    }
                }).catch((err) => {
                    this._log.error(`❌ 비동기 Mod('${modName}') setup 예외:`, err);
                });
            }

            this._log.info(`🧩 Mod 장착 완료 (${modName})`);
        } catch (err) {
            this._log.error(`❌ Mod('${modName}') 장착 중 예외:`, err);
        }
        return this;
    }

    /**
     * 🧩 장착된 특정 Mod를 이름 또는 원본 참조로 즉시 해제합니다.
     * @param {Function|Object|string} modOrName
     * @returns {boolean} 해제 성공 여부
     */
    unuse(modOrName) {
        if (!modOrName) return false;
        const idx = this._installedMods.findIndex(
            (m) => m.modRef === modOrName || m.name === modOrName
        );
        if (idx === -1) return false;

        const [entry] = this._installedMods.splice(idx, 1);
        if (typeof entry.teardown === 'function') {
            try { entry.teardown(); } catch (err) {
                this._log.warn(`⚠️ Mod('${entry.name}') teardown 예외:`, err);
            }
        }
        this._log.info(`🧩 Mod 해제 완료 (${entry.name})`);
        return true;
    }

    /**
     * 표준 이벤트 리스너 등록 ('load' | 'relocate' | 'chapterChange' | 'stateChange' | 'error')
     * @param {string} eventName
     * @param {Function} listener
     * @returns {() => void} 구독 해제 함수
     */
    on(eventName, listener) {
        if (typeof listener !== 'function') return () => {};
        if (!this._eventListeners.has(eventName)) {
            this._eventListeners.set(eventName, new Set());
        }
        this._eventListeners.get(eventName).add(listener);
        return () => this.off(eventName, listener);
    }

    /** 이벤트 리스너 해제 */
    off(eventName, listener) {
        this._eventListeners.get(eventName)?.delete(listener);
    }

    /** @private */
    _emit(eventName, detail) {
        const set = this._eventListeners.get(eventName);
        if (!set) return;
        set.forEach((fn) => {
            try { fn({ type: eventName, detail }); } catch (err) {
                this._log.warn(`⚠️ 이벤트('${eventName}') 리스너 예외:`, err);
            }
        });
    }

    /** @private */
    _setState(nextState) {
        const prev = this.state;
        if (prev === nextState) return;
        this.state = nextState;
        this._emit('stateChange', { prev, next: nextState });
    }

    /**
     * 📖 EPUB File/Blob 또는 이미 파싱된 Book 객체를 열어 초기 챕터를 준비합니다.
     * @param {File|Blob|ArrayBuffer|Object} source
     * @param {Object} [options={}]
     * @param {number|string|Object} [options.initialLocation=0] - 초기 복원 위치 (index, CFI, href)
     * @returns {Promise<Object>} 파싱된 Book 메타/구조 객체
     */
    async open(source, options = {}) {
        if (this._isDestroyed) throw new Error('[EwbEngine] Cannot open on destroyed engine');

        const token = ++this._openToken;
        this._setState(EngineState.OPENING);

        // 이전 책 자원 정리 (외부 공유 Book이 아닌 자체 소유분만)
        this.slots._destroyAllFrames?.();
        if (this._ownsBookResources && typeof this.book?.dispose === 'function') {
            this.book.dispose();
        }

        const isPreParsedBook = Boolean(source && typeof source === 'object' && Array.isArray(source.sections) && !(source instanceof Blob));
        if (isPreParsedBook) {
            this.book = source;
            this._ownsBookResources = false;
        } else {
            this.book = await this.parser.parse(source);
            this._ownsBookResources = true;
        }

        if (this._isDestroyed || token !== this._openToken) return this.book;

        await this.hookBus.emitAsync('onAfterParse', { book: this.book, engine: this }, { stopOnHandled: false });
        this._setState(EngineState.READY);

        if (options.autoMount !== false) {
            await this.goTo(options.initialLocation ?? 0, { behavior: 'instant' });
            this._setState(EngineState.ACTIVE);
        }

        return this.book;
    }

    /**
     * 특정 챕터(spineIndex)의 리소스 해석 완료 HTML 문자열을 로드합니다.
     * @param {number} spineIndex
     * @returns {Promise<string>}
     */
    async loadChapterHtml(spineIndex) {
        return this._loadResolvedChapterHtml(spineIndex);
    }

    /** @private */
    async _loadResolvedChapterHtml(spineIndex) {
        if (!this.book || !this.book.sections?.[spineIndex]) {
            throw new Error(`Invalid spineIndex: ${spineIndex}`);
        }
        const section = this.book.sections[spineIndex];
        if (typeof section.loadResolvedHtml === 'function') {
            return section.loadResolvedHtml();
        }
        if (typeof section.loadHtml === 'function') {
            return section.loadHtml();
        }
        throw new Error(`Section(${spineIndex}) has no HTML loader`);
    }

    /**
     * 🎯 숫자 인덱스, EPUB CFI 문자열, href#id, 또는 { spineIndex, anchor }로 이동합니다.
     * @param {number|string|Object} target
     * @param {Object} [options={}]
     * @returns {Promise<Object|null>} 이동 후 현재 위치 스냅샷
     */
    async goTo(target, options = {}) {
        if (this._isDestroyed || !this.book) return null;

        const behavior = options.behavior || 'instant';
        let targetSpine = 0;
        let resolvedRangeOrEl = null;

        // 1. 숫자 섹션 인덱스
        if (typeof target === 'number') {
            targetSpine = target;
        }
        // 2. 객체 { spineIndex | index, anchor }
        else if (target && typeof target === 'object') {
            targetSpine = Number(target.spineIndex ?? target.index ?? 0);
            resolvedRangeOrEl = target.anchor || null;
        }
        // 3. 문자열: EPUB CFI vs href#anchor
        else if (typeof target === 'string') {
            const trimmed = target.trim();
            if (trimmed.startsWith('epubcfi(')) {
                const decoded = this.cfiCodec.parse(trimmed, this.book);
                targetSpine = Number(decoded?.spineIndex ?? 0);
                resolvedRangeOrEl = (doc) => this.cfiCodec.resolveRangeInDocument(decoded, doc);
            } else {
                const matched = this._resolveHrefTarget(trimmed);
                targetSpine = matched.spineIndex;
                if (matched.anchorId) {
                    const id = matched.anchorId;
                    resolvedRangeOrEl = (doc) => doc.getElementById(id) || doc.querySelector(`[name="${id}"]`);
                }
            }
        }

        const frame = await this.slots.mountChapter(targetSpine, 'start');
        if (!frame || this._isDestroyed) return null;

        let resolvedDomTarget = null;
        if (resolvedRangeOrEl && frame.doc) {
            resolvedDomTarget = typeof resolvedRangeOrEl === 'function'
                ? resolvedRangeOrEl(frame.doc)
                : resolvedRangeOrEl;
            if (resolvedDomTarget) {
                frame.scrollToTarget(resolvedDomTarget, behavior);
            }
        }

        // 마운트 대기 중 컨테이너 크기가 변했다면 최신 크기로 보정 후 ACTIVE 전환
        const currSize = this._measureContainerSize();
        if (currSize.width !== this._lastObservedSize.width || currSize.height !== this._lastObservedSize.height) {
            this._lastObservedSize = currSize;
            this.slots.relayoutAll(this._getEffectiveLayoutOptions(), this._userCss, resolvedDomTarget);
        }

        frame.syncViewportClipMask({ enabled: behavior !== 'smooth' });
        this._setState(EngineState.ACTIVE);
        this._emit('load', { spineIndex: frame.spineIndex, doc: frame.doc, frame });
        return this._emitRelocate('goTo');
    }

    /** @private */
    _resolveHrefTarget(rawHref) {
        const [pathPart, rawAnchorId] = rawHref.split('#');
        let decodedPath = pathPart || '';
        let anchorId = rawAnchorId || '';
        try { decodedPath = decodeURIComponent(decodedPath); } catch (e) {}
        try { anchorId = decodeURIComponent(anchorId); } catch (e) {}

        const cleanTarget = decodedPath.replace(/^(OEBPS|EPUB|OPS)\//i, '').toLowerCase();
        const filename = cleanTarget.split('/').pop();

        const sections = this.book?.sections || [];
        let idx = sections.findIndex((s) => {
            const secPath = (s.href || '').replace(/^(OEBPS|EPUB|OPS)\//i, '').toLowerCase();
            return secPath === cleanTarget || (filename && secPath.split('/').pop() === filename);
        });

        if (idx < 0 && this.slots.getCurrentFrame()) {
            idx = this.slots.getCurrentFrame().spineIndex;
        }
        return { spineIndex: Math.max(0, idx), anchorId };
    }

    /** 다음 페이지 이동 (챕터 끝 경계 시 다음 챕터 첫 페이지로 0ms 전환) */
    async nextPage(options = {}) {
        const frame = this.slots.getCurrentFrame();
        if (!frame || this._isDestroyed) return null;

        const behavior = options.behavior || this.layoutOptions.transition;
        const res = frame.nextPage(options);
        if (!res.moved && res.atBoundary === 'end') {
            const nextFrame = await this.slots.moveChapter('next', { initialPosition: 'start' });
            if (nextFrame) {
                nextFrame.syncViewportClipMask({ enabled: true });
                this._emit('chapterChange', { spineIndex: nextFrame.spineIndex, direction: 'next', frame: nextFrame });
                this._emit('load', { spineIndex: nextFrame.spineIndex, doc: nextFrame.doc, frame: nextFrame });
            }
        } else {
            frame.syncViewportClipMask({ enabled: behavior !== 'smooth' });
        }
        return this._emitRelocate('nextPage');
    }

    /** 이전 페이지 이동 (챕터 시작 경계 시 이전 챕터 마지막 페이지로 0ms 전환) */
    async prevPage(options = {}) {
        const frame = this.slots.getCurrentFrame();
        if (!frame || this._isDestroyed) return null;

        const behavior = options.behavior || this.layoutOptions.transition;
        const res = frame.prevPage(options);
        if (!res.moved && res.atBoundary === 'start') {
            const prevFrame = await this.slots.moveChapter('prev', { initialPosition: 'end' });
            if (prevFrame) {
                prevFrame.syncViewportClipMask({ enabled: true });
                this._emit('chapterChange', { spineIndex: prevFrame.spineIndex, direction: 'prev', frame: prevFrame });
                this._emit('load', { spineIndex: prevFrame.spineIndex, doc: prevFrame.doc, frame: prevFrame });
            }
        } else {
            frame.syncViewportClipMask({ enabled: behavior !== 'smooth' });
        }
        return this._emitRelocate('prevPage');
    }

    /**
     * 다음 챕터로 이동합니다. (기본: 첫 페이지 'start')
     * @param {Object} [options={}]
     * @param {'start'|'end'} [options.position='start']
     * @returns {Promise<Object|null>}
     */
    async nextChapter(options = {}) {
        const initialPosition = options.position === 'end' ? 'end' : 'start';
        const nextFrame = await this.slots.moveChapter('next', { initialPosition });
        if (nextFrame) {
            nextFrame.syncViewportClipMask({ enabled: true });
            this._emit('chapterChange', { spineIndex: nextFrame.spineIndex, direction: 'next', frame: nextFrame });
            this._emit('load', { spineIndex: nextFrame.spineIndex, doc: nextFrame.doc, frame: nextFrame });
        }
        return this._emitRelocate('nextChapter');
    }

    /**
     * 이전 챕터로 이동합니다. (기본: 첫 페이지 'start', 필요 시 { position: 'end' } 지정 가능)
     * @param {Object} [options={}]
     * @param {'start'|'end'} [options.position='start']
     * @returns {Promise<Object|null>}
     */
    async prevChapter(options = {}) {
        const initialPosition = options.position === 'end' ? 'end' : 'start';
        const prevFrame = await this.slots.moveChapter('prev', { initialPosition });
        if (prevFrame) {
            prevFrame.syncViewportClipMask({ enabled: true });
            this._emit('chapterChange', { spineIndex: prevFrame.spineIndex, direction: 'prev', frame: prevFrame });
            this._emit('load', { spineIndex: prevFrame.spineIndex, doc: prevFrame.doc, frame: prevFrame });
        }
        return this._emitRelocate('prevChapter');
    }

    /**
     * 현재 챕터 내 특정 0-based 페이지로 직접 이동하고 relocate 이벤트를 발행합니다.
     * @param {number} pageIndex
     * @param {'instant'|'smooth'} [behavior]
     * @returns {{ moved: boolean, currentPage: number, totalPages: number }|null}
     */
    goToPage(pageIndex, behavior) {
        const frame = this.slots.getCurrentFrame();
        if (!frame || this._isDestroyed) return null;
        const effectiveBehavior = behavior || this.layoutOptions.transition;
        const res = frame.goToPage(pageIndex, effectiveBehavior);
        frame.syncViewportClipMask({ enabled: effectiveBehavior !== 'smooth' });
        if (res?.moved) this._emitRelocate('goToPage');
        return res;
    }

    /**
     * 현재 챕터의 마지막 페이지로 이동하고 relocate 이벤트를 발행합니다.
     * @returns {{ moved: boolean, currentPage: number, totalPages: number }|null}
     */
    goToEnd() {
        const frame = this.slots.getCurrentFrame();
        if (!frame || this._isDestroyed) return null;
        const res = frame.goToEnd();
        frame.syncViewportClipMask({ enabled: true });
        if (res?.moved) this._emitRelocate('goToEnd');
        return res;
    }

    /**
     * 현재 챕터 내 특정 DOM Range 또는 Element 위치로 이동하고 relocate 이벤트를 발행합니다.
     * @param {Range|Element} target
     * @param {'instant'|'smooth'} [behavior='instant']
     * @returns {{ success: boolean, currentPage: number, totalPages: number }|null}
     */
    scrollToTarget(target, behavior = 'instant') {
        const frame = this.slots.getCurrentFrame();
        if (!frame || this._isDestroyed) return null;
        const res = frame.scrollToTarget(target, behavior);
        frame.syncViewportClipMask({ enabled: behavior !== 'smooth' });
        if (res?.success) this._emitRelocate('scrollToTarget');
        return res;
    }

    /** 픽셀 단위 스크롤 (마우스 휠 / 자동 스크롤 커스텀용 — 연속 스크롤 보장을 위해 하단 마스킹 해제) */
    scrollByPixels(deltaPx, behavior = 'instant') {
        const frame = this.slots.getCurrentFrame();
        if (!frame) return { moved: false, atBoundary: null };
        const res = frame.scrollByPixels(deltaPx, behavior);
        frame.syncViewportClipMask({ enabled: false });
        if (res.moved) this._emitRelocate('scrollByPixels');
        return res;
    }

    /** 글자 줄 수 단위 스크롤 */
    scrollByLines(lineCount = 1, behavior = 'instant') {
        const frame = this.slots.getCurrentFrame();
        const lineH = frame?.paginator?.metrics?.exactLineHeightPx || 24;
        return this.scrollByPixels(Number(lineCount) * lineH, behavior);
    }

    /**
     * 레이아웃/타이포그래피/여백 옵션을 갱신하고 읽던 줄 위치를 유지한 채 재조판합니다.
     * @param {Object} [partialOptions={}] - margins 객체 또는 개별 옵션 지원
     */
    setLayoutOptions(partialOptions = {}) {
        if (this._isDestroyed) return;
        if (partialOptions.slotMode) {
            this.slots.setSlotMode(partialOptions.slotMode);
        }
        const normalized = this._normalizeLayoutOptions(partialOptions);
        if (normalized.backgroundColor !== undefined) {
            this._baseBackgroundColor = normalized.backgroundColor || 'transparent';
        }
        Object.assign(this.layoutOptions, normalized);
        this._syncContainerBackground();
        if (this.state === EngineState.ACTIVE) {
            this.relayout();
        }
    }

    /**
     * 🎨 외부 테마 플러그인 전용: 본문 배경색·글자색·링크색·선택색을 userCss(폰트/문단)를 건드리지 않고 0ms 즉시 적용합니다.
     * - null 또는 빈 객체({}) 전달 시 테마를 해제하고 기본 배경색으로 복원합니다.
     * @param {{ backgroundColor?: string, textColor?: string, linkColor?: string, selectionColor?: string }|null} [theme=null]
     */
    setTheme(theme = null) {
        if (this._isDestroyed) return;
        this._applyThemeState(theme);
        this._syncContainerBackground();

        const themeCss = this.getThemeCss();
        const bg = this.layoutOptions.backgroundColor;

        this.slots.forEachFrame((frame) => {
            frame.setThemeStyle?.(themeCss);
            frame.setBackgroundColor?.(bg);
        });
        for (const extFrame of this._externalFrames) {
            if (extFrame && !extFrame.isDestroyed) {
                extFrame.setThemeStyle?.(themeCss);
                extFrame.setBackgroundColor?.(bg);
            }
        }

        this.hookBus.emitSync('onThemeChange', {
            theme: this.getTheme(),
            themeCss
        }, { stopOnHandled: false });
    }

    /**
     * 현재 적용 중인 테마 색상 스냅샷을 반환합니다. (미설정 시 null)
     * @returns {{ backgroundColor: string, textColor: string, linkColor: string, selectionColor: string }|null}
     */
    getTheme() {
        return this._theme ? { ...this._theme } : null;
    }

    /**
     * 사용자 폰트/문단 CSS를 갱신하고 활성 상태라면 페이지 수·스페이서를 즉시 재조판합니다.
     * @param {string} [cssText='']
     */
    setUserCss(cssText = '') {
        if (this._isDestroyed) return;
        this._userCss = cssText || '';
        this.slots.forEachFrame((frame) => frame.setUserStyle(this._userCss));
        if (this.state === EngineState.ACTIVE) {
            this.relayout();
        }
    }

    /**
     * 현재 보고 있는 첫 줄 위치를 보존하며 활성·대기 슬롯을 재조판하고 onRelayout 훅을 발행합니다.
     */
    relayout() {
        const frame = this.slots.getCurrentFrame();
        let anchorRange = null;

        if (frame?.doc) {
            const firstLine = frame.getFirstVisibleLine({ resolveLineText: true });
            if (firstLine?.node) {
                try {
                    const range = frame.doc.createRange();
                    range.setStart(firstLine.node, firstLine.startOffset || 0);
                    range.collapse(true);
                    anchorRange = range;
                } catch (e) {}
            }
        }

        const effectiveOptions = this._getEffectiveLayoutOptions();
        this._lastObservedSize = { width: effectiveOptions.usableWidth, height: effectiveOptions.usableHeight };
        this.slots.relayoutAll(effectiveOptions, this._userCss, anchorRange);
        if (anchorRange) {
            try { anchorRange.detach(); } catch (e) {}
        }

        this.hookBus.emitSync('onRelayout', {
            spineIndex: this.slots.getCurrentFrame()?.spineIndex ?? 0,
            metrics: this.getViewportMetrics(),
            layoutOptions: this.getLayoutOptions()
        }, { stopOnHandled: false });

        this._emitRelocate('relayout');
    }

    /**
     * 현재 독서 위치 스냅샷, 첫/끝 줄·문단/줄 수·여백·잘림 추적 로그 및 CFI를 산출하고 relocate 이벤트를 발행합니다.
     * @private
     */
    _emitRelocate(trigger = 'internal') {
        const loc = this.getCurrentLocation();
        if (!loc) return null;

        const clip = this.getClippingMetrics();
        const frame = this.slots.getCurrentFrame();
        const m = frame?.paginator?.metrics || this._getEffectiveLayoutOptions();
        const padT = m.paddingTop ?? this.layoutOptions.marginTop;
        const padB = m.paddingBottom ?? this.layoutOptions.marginBottom;
        const padL = m.paddingLeft ?? this.layoutOptions.marginLeft;
        const padR = m.paddingRight ?? this.layoutOptions.marginRight;
        const firstText = (loc.firstLine?.text || '').replace(/\s+/g, ' ').trim().slice(0, 22);
        const lastText = (loc.lastLine?.text || '').replace(/\s+/g, ' ').trim().slice(0, 22);

        if (clip) {
            this._log.trace({
                action: 'pageView',
                caller: `EwbEngine:${trigger}`,
                state: `${this.layoutOptions.flow} ch=${loc.spineIndex} p=${loc.page + 1}/${loc.totalPages}`,
                delta: `first="${firstText}" | last="${lastText}" | lines=${clip.visibleLineCount}(full=${clip.fullLineCount}), paragraphs=${clip.paragraphCount} | margins(T:${padT} B:${padB} L:${padL} R:${padR})`,
                result: `topCut=${clip.topCutPx}px, rawBottomCut=${clip.rawBottomCutPx}px, masked=${clip.maskedBottomPx}px, visibleBottomCut=${clip.visibleBottomCutPx}px`
            });
        }

        this.hookBus.emitSync('onRelocate', { ...loc, trigger }, { stopOnHandled: false });
        this._emit('relocate', { ...loc, trigger });
        return loc;
    }

    /** 현재 위치 상세 정보(챕터, 페이지, 진행률, CFI, 첫/끝 줄)를 반환합니다. */
    getCurrentLocation() {
        const frame = this.slots.getCurrentFrame();
        if (!frame) return null;

        const metrics = frame.getMetrics();
        const spineCount = Math.max(1, this.book?.sections?.length || 1);
        const chapterFraction = metrics.totalPages > 0
            ? (metrics.currentPage / metrics.totalPages)
            : 0;
        const fraction = Math.min(1, Math.max(0, (frame.spineIndex + chapterFraction) / spineCount));

        const firstLine = frame.getFirstVisibleLine({ resolveLineText: true });
        const lastLine = frame.getLastVisibleLine({ resolveLineText: true });

        let cfi = '';
        if (frame.doc && firstLine?.node) {
            try {
                const range = frame.doc.createRange();
                range.setStart(firstLine.node, firstLine.startOffset || 0);
                if (lastLine?.node) {
                    range.setEnd(lastLine.node, lastLine.endOffset ?? lastLine.startOffset ?? 0);
                } else {
                    range.collapse(true);
                }
                cfi = this.cfiCodec.fromRange(frame.spineIndex, range, frame.doc, this.book);
                range.detach();
            } catch (e) {}
        }

        const tocItem = this._findTocItemForSpine(frame.spineIndex);

        return {
            spineIndex: frame.spineIndex,
            href: frame.href,
            tocItem,
            page: metrics.currentPage,
            totalPages: metrics.totalPages,
            atStart: metrics.atStart,
            atEnd: metrics.atEnd,
            fraction,
            cfi,
            firstLine,
            lastLine
        };
    }

    /** @private */
    _findTocItemForSpine(spineIndex) {
        const toc = this.book?.toc || [];
        const targetHref = (this.book?.sections?.[spineIndex]?.href || '').split('#')[0].split('/').pop().toLowerCase();
        if (targetHref) {
            const stack = [...toc];
            while (stack.length > 0) {
                const item = stack.shift();
                const itemFile = (item.href || '').split('#')[0].split('/').pop().toLowerCase();
                if (itemFile === targetHref) return item;
                if (Array.isArray(item.subitems)) stack.unshift(...item.subitems);
            }
        }
        return toc[spineIndex] || null;
    }

    /**
     * 🔍 전체 책 본문 비동기 검색 제너레이터
     * @param {string} query - 검색어
     * @yields {{ spineIndex: number, cfi: string, excerpt: string }}
     */
    async *search(query) {
        const q = String(query || '').trim();
        if (!q || !this.book?.sections) return;
        const lowerQ = q.toLowerCase();

        for (let i = 0; i < this.book.sections.length; i++) {
            if (this._isDestroyed) return;
            const html = await this._loadResolvedChapterHtml(i).catch(() => '');
            if (!html) continue;

            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            const text = doc.body?.textContent || '';
            const idx = text.toLowerCase().indexOf(lowerQ);
            if (idx !== -1) {
                const start = Math.max(0, idx - 25);
                const end = Math.min(text.length, idx + q.length + 35);
                yield {
                    spineIndex: i,
                    cfi: this.cfiCodec.buildSectionCfi(i, this.book),
                    excerpt: text.slice(start, end).replace(/\s+/g, ' ').trim()
                };
            }
        }
    }

    // === 외부 커스텀용 개방 조회 & CFI 유틸 API ===
    getContainer() { return this.container; }
    getBookMeta() { return this.book?.metadata || null; }
    getToc() { return this.book?.toc || []; }
    getSections() { return this.book?.sections || []; }
    getCurrentFrame() { return this.slots.getCurrentFrame(); }
    getActiveDocument() { return this.slots.getCurrentFrame()?.doc || null; }
    getViewportMetrics() { return this.slots.getCurrentFrame()?.paginator?.metrics || this._getEffectiveLayoutOptions(); }

    /**
     * 현재 화면의 상·하단 경계 텍스트 잘림 실측치, 가시 줄 수, 문단 수 및 마스킹 상태를 반환합니다.
     * @returns {Object|null}
     */
    getClippingMetrics() {
        return this.slots.getCurrentFrame()?.getClippingMetrics?.() || null;
    }

    /**
     * 현재 적용 중인 레이아웃 옵션 스냅샷을 반환합니다.
     * @returns {Object}
     */
    getLayoutOptions() {
        return {
            ...this._getEffectiveLayoutOptions(),
            slotMode: this.slots.slotMode
        };
    }

    /**
     * 현재 설정된 4방향 여백을 반환합니다.
     * @returns {{ top: number, bottom: number, left: number, right: number }}
     */
    getMargins() {
        return {
            top: this.layoutOptions.marginTop,
            bottom: this.layoutOptions.marginBottom,
            left: this.layoutOptions.marginLeft,
            right: this.layoutOptions.marginRight
        };
    }

    /**
     * 현재 설정된 사용자 CSS 문자열을 반환합니다.
     * @returns {string}
     */
    getUserCss() {
        return this._userCss;
    }

    /**
     * 활성·대기 슬롯의 모든 유효 ChapterFrame을 순회합니다.
     * @param {(frame: Object, role: 'prev'|'current'|'next') => void} callback
     */
    forEachFrame(callback) {
        this.slots.forEachFrame(callback);
    }

    /**
     * 현재 슬롯(prev/current/next) 프레임 참조 스냅샷을 반환합니다.
     * @returns {{ prev: Object|null, current: Object|null, next: Object|null }}
     */
    getFrames() {
        return {
            prev: this.slots.prevFrame || null,
            current: this.slots.currentFrame || null,
            next: this.slots.nextFrame || null
        };
    }

    /**
     * DOM Range로부터 표준 EPUB CFI 문자열을 생성합니다.
     * @param {number} spineIndex
     * @param {Range} range
     * @param {Document} [doc=this.getActiveDocument()]
     * @returns {string}
     */
    encodeCfi(spineIndex, range, doc = this.getActiveDocument()) {
        return this.cfiCodec.fromRange(spineIndex, range, doc, this.book);
    }

    /**
     * EPUB CFI 문자열을 파싱합니다.
     * @param {string} cfiString
     * @returns {Object}
     */
    decodeCfi(cfiString) {
        return this.cfiCodec.parse(cfiString, this.book);
    }

    /**
     * EPUB CFI 문자열을 대상 Document의 DOM Range로 복원합니다.
     * @param {string} cfiString
     * @param {Document} [doc=this.getActiveDocument()]
     * @param {Object} [options={}]
     * @returns {Range|null}
     */
    resolveCfi(cfiString, doc = this.getActiveDocument(), options = {}) {
        const parsed = this.cfiCodec.parse(cfiString, this.book);
        return this.cfiCodec.resolveRangeInDocument(parsed, doc, options);
    }

    /**
     * 🧹 모든 슬롯, Mod, 외부 생성 프레임, Book Blob URL, Observer를 100% 정리합니다.
     */
    destroy() {
        if (this._isDestroyed) return;
        this._isDestroyed = true;
        this._openToken++;

        if (this._resizeTimer) {
            clearTimeout(this._resizeTimer);
            this._resizeTimer = null;
        }
        if (this._resizeObserver) {
            try { this._resizeObserver.disconnect(); } catch (e) {}
            this._resizeObserver = null;
        }

        const modsSnapshot = [...this._installedMods];
        this._installedMods = [];
        for (let i = modsSnapshot.length - 1; i >= 0; i--) {
            const mod = modsSnapshot[i];
            if (typeof mod.teardown === 'function') {
                try { mod.teardown(); } catch (e) {}
            }
        }

        this.hookBus.emitSync('onDestroy', { engine: this }, { stopOnHandled: false });

        for (const extFrame of Array.from(this._externalFrames)) {
            try {
                if (extFrame && !extFrame.isDestroyed) extFrame.destroy();
            } catch (e) {}
        }
        this._externalFrames.clear();

        this.slots.destroy();

        if (this._ownsBookResources && typeof this.book?.dispose === 'function') {
            try { this.book.dispose(); } catch (e) {}
        }
        this.book = null;
        this._eventListeners.clear();
        this.hookBus.clear();
        this._setState(EngineState.DESTROYED);
    }
}