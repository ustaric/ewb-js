/**
 * 🪟 단일(single) / 트리플(triple) 슬롯 선택 내장 및 0ms 챕터 전환 컨트롤러 (SlotController)
 * - 🎛️ [모드 선택 내장] slotMode: 'single' | 'triple' 옵션으로 경량 1슬롯과 3챕터 사전 대기 자유 전환
 * - ⚡ [0ms 무중단 전환] 대기 중인 Frame이 READY면 DOM 이동 없이 활성화/비활성화 포인터만 스왑
 * - 🎯 [진입 위치 지정] moveChapter(direction, { initialPosition })로 챕터 점프('start')와 페이지 경계 넘김('end') 구분
 * - 🛡️ [연타 방어] 마운트 진행 중인 슬롯 도달 시 ready() 대기 후 전환해 빈 화면 원천 차단
 * - 🧹 [슬라이딩 GC] 지나간 원거리 슬롯(현재±2 이상)은 유휴 시간에 안전 해제해 메모리 3챕터 이하 유지
 * - 📋 [슬롯/프리로드 추적] setSlotMode, mountChapter, moveChapter, scheduleAdjacentPreload 예약·가동 전 구간 4대 컨텍스트 trace 탑재
 * 파일 경로: web/ewb-js/core/SlotController.js
 * @module ewb-js/core/SlotController
 */

import { ChapterFrame, FrameState } from './ChapterFrame.js';

/**
 * 슬롯 생성·전환·프리로드 생명주기를 관리하는 컨트롤러
 */
export class SlotController {
    /**
     * @param {Object} options
     * @param {HTMLElement} options.container - 뷰어 마운트 컨테이너
     * @param {'single'|'triple'} [options.slotMode='triple'] - 슬롯 동작 방식
     * @param {(spineIndex: number) => (string|Promise<string>)} options.loadChapterHtml - 챕터 HTML 공급자
     * @param {(spineIndex: number) => string} [options.getSectionHref] - 챕터 href 조회기
     * @param {() => number} options.getSpineCount - 전체 챕터 수 조회기
     * @param {() => Object} options.getLayoutOptions - 현재 레이아웃 설정 조회기
     * @param {() => string} options.getUserCss - 현재 사용자 스타일 CSS 조회기
     * @param {Object|null} [options.hookBus=null] - HookBus 중계소
     * @param {Object|null} [options.logger=null] - EngineLogger 또는 child 로거
     */
    constructor(options = {}) {
        this.container = options.container;
        this.slotMode = options.slotMode === 'single' ? 'single' : 'triple';
        this.loadChapterHtml = options.loadChapterHtml;
        this.getSectionHref = options.getSectionHref || (() => '');
        this.getSpineCount = options.getSpineCount || (() => 0);
        this.getLayoutOptions = options.getLayoutOptions || (() => ({}));
        this.getUserCss = options.getUserCss || (() => '');
        this.hookBus = options.hookBus || null;
        this.logger = options.logger || null;

        /** @type {ChapterFrame|null} */
        this.prevFrame = null;
        /** @type {ChapterFrame|null} */
        this.currentFrame = null;
        /** @type {ChapterFrame|null} */
        this.nextFrame = null;

        this._sessionToken = 0;
        this._preloadTimer = null;
        this._isIdleCallback = false;
        this._isTransitioning = false;
        this._isDestroyed = false;
    }

    /**
     * 실행 중 슬롯 모드를 변경합니다. ('single' 전환 시 대기 슬롯 즉시 소독)
     * @param {'single'|'triple'} mode
     */
    setSlotMode(mode) {
        const prevMode = this.slotMode;
        const nextMode = mode === 'single' ? 'single' : 'triple';
        if (prevMode === nextMode) return;
        this.slotMode = nextMode;

        this.logger?.trace?.({
            scope: 'SlotController',
            action: 'setSlotMode',
            caller: 'SlotController:setSlotMode',
            state: this.currentFrame?.state || 'IDLE',
            delta: `${prevMode} -> ${nextMode}`,
            result: nextMode === 'single' ? 'standby frames cleared' : 'adjacent preload check'
        });

        if (nextMode === 'single') {
            this._cancelPreloadSchedule();
            this._destroyFrame(this.prevFrame);
            this._destroyFrame(this.nextFrame);
            this.prevFrame = null;
            this.nextFrame = null;
        } else if (this.currentFrame && this.currentFrame.state === FrameState.READY) {
            this.scheduleAdjacentPreload();
        }
    }

    /**
     * 현재 화면에 표시 중인 활성 프레임을 반환합니다.
     * @returns {ChapterFrame|null}
     */
    getCurrentFrame() {
        return this.currentFrame;
    }

    /**
     * 현재 활성 프레임을 포함한 모든 유효 슬롯 프레임을 순회합니다.
     * @param {(frame: ChapterFrame, role: 'prev'|'current'|'next') => void} callback
     */
    forEachFrame(callback) {
        if (typeof callback !== 'function') return;
        if (this.prevFrame && !this.prevFrame.isDestroyed) callback(this.prevFrame, 'prev');
        if (this.currentFrame && !this.currentFrame.isDestroyed) callback(this.currentFrame, 'current');
        if (this.nextFrame && !this.nextFrame.isDestroyed) callback(this.nextFrame, 'next');
    }

    /**
     * 지정된 챕터 인덱스로 즉시 이동·마운트합니다. (초기 진입 및 목차/CFI 점프용)
     * @param {number} spineIndex - 목표 챕터 인덱스
     * @param {'start'|'end'} [initialPosition='start'] - 초기 안착 위치
     * @returns {Promise<ChapterFrame|null>}
     */
    async mountChapter(spineIndex, initialPosition = 'start') {
        if (this._isDestroyed) return null;

        const spineCount = this.getSpineCount();
        const targetIdx = Math.min(Math.max(0, Number(spineIndex) || 0), Math.max(0, spineCount - 1));
        const token = ++this._sessionToken;

        this._cancelPreloadSchedule();

        // 이미 대기 중인 슬롯에 목표 챕터가 일치하면 재사용 (0ms 승격)
        if (this.currentFrame && this.currentFrame.spineIndex === targetIdx && !this.currentFrame.isDestroyed) {
            await this.currentFrame.ready();
            if (token !== this._sessionToken || this._isDestroyed) return null;
            this.currentFrame.activate();
            if (initialPosition === 'end') this.currentFrame.goToEnd();
            else this.currentFrame.goToPage(0, 'instant');
            this.logger?.trace?.({
                scope: 'SlotController',
                action: 'mountChapter',
                caller: 'SlotController:mountChapter',
                state: this.currentFrame.state,
                delta: `slotMode=${this.slotMode}, spine=${targetIdx}, pos=${initialPosition}`,
                result: 'hit currentFrame (reused)'
            });
            this.scheduleAdjacentPreload();
            return this.currentFrame;
        }

        if (this.nextFrame && this.nextFrame.spineIndex === targetIdx && !this.nextFrame.isDestroyed) {
            return this._promoteSlot('next', initialPosition, token);
        }

        if (this.prevFrame && this.prevFrame.spineIndex === targetIdx && !this.prevFrame.isDestroyed) {
            return this._promoteSlot('prev', initialPosition, token);
        }

        // 원거리 점프: 기존 슬롯 정리 후 새 currentFrame 마운트
        this._destroyAllFrames();

        const frame = this._createFrame(targetIdx);
        this.currentFrame = frame;

        await frame.mount({
            htmlSource: () => this.loadChapterHtml(targetIdx),
            layoutOptions: this.getLayoutOptions(),
            userCss: this.getUserCss(),
            active: true,
            initialPosition
        });

        if (token !== this._sessionToken || this._isDestroyed) {
            this._destroyFrame(frame);
            return null;
        }

        this.logger?.trace?.({
            scope: 'SlotController',
            action: 'mountChapter',
            caller: 'SlotController:mountChapter',
            state: frame.state,
            delta: `slotMode=${this.slotMode}, spine=${targetIdx}, pos=${initialPosition}`,
            result: 'fresh mount completed -> schedule preload'
        });

        this.scheduleAdjacentPreload();
        return frame;
    }

    /**
     * 챕터 경계 도달 또는 챕터 단위 이동 시 다음 또는 이전 챕터로 전환합니다.
     * @param {'next'|'prev'} direction
     * @param {Object} [options={}]
     * @param {'start'|'end'} [options.initialPosition] - 진입 위치 강제 지정 (생략 시 next='start', prev='end')
     * @returns {Promise<ChapterFrame|null>}
     */
    async moveChapter(direction, options = {}) {
        if (this._isDestroyed || this._isTransitioning || !this.currentFrame) return null;

        const currentIdx = this.currentFrame.spineIndex;
        const spineCount = this.getSpineCount();
        const targetIdx = direction === 'next' ? currentIdx + 1 : currentIdx - 1;

        if (targetIdx < 0 || targetIdx >= spineCount) {
            return null;
        }

        // 외부 모드(HookBus)가 경계 전환을 가로채고 싶은 경우 양보
        if (this.hookBus && typeof this.hookBus.emitAsync === 'function') {
            const hookResult = await this.hookBus.emitAsync('onBoundaryReached', {
                direction,
                currentIndex: currentIdx,
                targetIndex: targetIdx,
                currentFrame: this.currentFrame
            });
            if (hookResult && hookResult.handled) {
                return this.currentFrame;
            }
        }

        this._isTransitioning = true;
        const token = ++this._sessionToken;
        this._cancelPreloadSchedule();

        try {
            const candidate = direction === 'next' ? this.nextFrame : this.prevFrame;
            const defaultPos = direction === 'next' ? 'start' : 'end';
            const targetPos = (options.initialPosition === 'start' || options.initialPosition === 'end')
                ? options.initialPosition
                : defaultPos;

            if (candidate && candidate.spineIndex === targetIdx && !candidate.isDestroyed) {
                this.logger?.trace?.({
                    scope: 'SlotController',
                    action: 'moveChapter',
                    caller: `SlotController:${direction}`,
                    state: candidate.state,
                    delta: `slotMode=${this.slotMode}, ${currentIdx} -> ${targetIdx}, pos=${targetPos}`,
                    result: 'candidate slot hit -> promote'
                });
                const promoted = await this._promoteSlot(direction, targetPos, token);
                return promoted;
            }

            this.logger?.trace?.({
                scope: 'SlotController',
                action: 'moveChapter',
                caller: `SlotController:${direction}`,
                state: 'MOUNTING',
                delta: `slotMode=${this.slotMode}, ${currentIdx} -> ${targetIdx}, pos=${targetPos}`,
                result: 'no standby candidate -> mountChapter'
            });

            // single 모드 또는 아직 준비되지 않은 챕터 진입
            return await this.mountChapter(targetIdx, targetPos);
        } finally {
            this._isTransitioning = false;
        }
    }

    /**
     * 대기 중이던 prev/next 슬롯을 current로 승격시키고 나머지 슬롯을 재정렬합니다.
     * @private
     */
    async _promoteSlot(role, initialPosition, token) {
        const candidate = role === 'next' ? this.nextFrame : this.prevFrame;
        if (!candidate || candidate.isDestroyed) return null;

        // 아직 마운트/렌더링 중이면 ready() 완료까지 대기 (빈 화면 방지)
        if (candidate.state !== FrameState.READY) {
            await candidate.ready();
        }
        if (token !== this._sessionToken || this._isDestroyed || candidate.isDestroyed) {
            return null;
        }

        const oldCurrent = this.currentFrame;
        let slotToDispose = null;

        if (role === 'next') {
            slotToDispose = this.prevFrame;
            this.prevFrame = oldCurrent;
            this.currentFrame = candidate;
            this.nextFrame = null;
        } else {
            slotToDispose = this.nextFrame;
            this.nextFrame = oldCurrent;
            this.currentFrame = candidate;
            this.prevFrame = null;
        }

        if (initialPosition === 'end') {
            candidate.goToEnd();
        } else {
            candidate.goToPage(0, 'instant');
        }

        candidate.activate();
        if (oldCurrent && !oldCurrent.isDestroyed) {
            oldCurrent.deactivate();
            // 이전 슬롯으로 밀려난 옛 챕터는 다음에 역방향 진입 시 마지막 페이지에 바로 서도록 정렬
            if (role === 'next') {
                oldCurrent.goToEnd();
            } else {
                oldCurrent.goToPage(0, 'instant');
            }
        }

        if (slotToDispose) {
            this._destroyFrame(slotToDispose);
        }

        this.logger?.trace?.({
            scope: 'SlotController',
            action: 'promoteSlot',
            caller: `SlotController:${role}`,
            state: 'ACTIVE',
            delta: `slotMode=${this.slotMode}, spine=${candidate.spineIndex}, pos=${initialPosition}`,
            result: '0ms promoted'
        });

        this.scheduleAdjacentPreload();
        return candidate;
    }

    /**
     * triple 모드일 때 현재 챕터의 앞/뒤 챕터를 유휴 시간에 미리 렌더링 대기시킵니다.
     */
    scheduleAdjacentPreload() {
        if (this._isDestroyed || !this.currentFrame) return;

        if (this.slotMode !== 'triple') {
            this.logger?.trace?.({
                scope: 'SlotController',
                action: 'preloadSkip',
                caller: 'SlotController:scheduleAdjacentPreload',
                state: this.currentFrame.state,
                delta: `slotMode=${this.slotMode}, current=${this.currentFrame.spineIndex}`,
                result: 'skipped (single slot mode)'
            });
            return;
        }

        this._cancelPreloadSchedule();
        const token = this._sessionToken;
        const currentIdx = this.currentFrame.spineIndex;
        const spineCount = this.getSpineCount();

        const runPreload = async () => {
            this._preloadTimer = null;
            if (this._isDestroyed || token !== this._sessionToken) {
                this.logger?.trace?.({
                    scope: 'SlotController',
                    action: 'preloadAbort',
                    caller: 'SlotController:runPreload',
                    state: 'CANCELLED',
                    delta: `slotMode=${this.slotMode}, current=${currentIdx}`,
                    result: 'stale token or destroyed'
                });
                return;
            }

            this.logger?.trace?.({
                scope: 'SlotController',
                action: 'preloadRun',
                caller: 'SlotController:runPreload',
                state: 'RUNNING',
                delta: `slotMode=${this.slotMode}, current=${currentIdx}`,
                result: 'adjacent slot pipeline started'
            });

            // 1순위: 다음 챕터 첫 페이지 대기
            const nextIdx = currentIdx + 1;
            if (nextIdx < spineCount && (!this.nextFrame || this.nextFrame.spineIndex !== nextIdx || this.nextFrame.isDestroyed)) {
                this._destroyFrame(this.nextFrame);
                const nextF = this._createFrame(nextIdx);
                this.nextFrame = nextF;
                try {
                    await nextF.mount({
                        htmlSource: () => this.loadChapterHtml(nextIdx),
                        layoutOptions: this.getLayoutOptions(),
                        userCss: this.getUserCss(),
                        active: false,
                        initialPosition: 'start'
                    });
                    this.logger?.trace?.({
                        scope: 'SlotController',
                        action: 'preloadNextReady',
                        caller: 'SlotController:runPreload',
                        state: nextF.state,
                        delta: `slotMode=${this.slotMode}, next=${nextIdx}`,
                        result: 'next slot preloaded'
                    });
                } catch (e) {
                    if (this.nextFrame === nextF) this.nextFrame = null;
                    this.logger?.trace?.({
                        scope: 'SlotController',
                        action: 'preloadNextFail',
                        caller: 'SlotController:runPreload',
                        state: 'FAILED',
                        delta: `slotMode=${this.slotMode}, next=${nextIdx}`,
                        result: e?.message || 'mount failed'
                    });
                }
            }

            if (this._isDestroyed || token !== this._sessionToken) return;

            // 2순위: 이전 챕터 마지막 페이지 대기
            const prevIdx = currentIdx - 1;
            if (prevIdx >= 0 && (!this.prevFrame || this.prevFrame.spineIndex !== prevIdx || this.prevFrame.isDestroyed)) {
                this._destroyFrame(this.prevFrame);
                const prevF = this._createFrame(prevIdx);
                this.prevFrame = prevF;
                try {
                    await prevF.mount({
                        htmlSource: () => this.loadChapterHtml(prevIdx),
                        layoutOptions: this.getLayoutOptions(),
                        userCss: this.getUserCss(),
                        active: false,
                        initialPosition: 'end'
                    });
                    this.logger?.trace?.({
                        scope: 'SlotController',
                        action: 'preloadPrevReady',
                        caller: 'SlotController:runPreload',
                        state: prevF.state,
                        delta: `slotMode=${this.slotMode}, prev=${prevIdx}`,
                        result: 'prev slot preloaded'
                    });
                } catch (e) {
                    if (this.prevFrame === prevF) this.prevFrame = null;
                    this.logger?.trace?.({
                        scope: 'SlotController',
                        action: 'preloadPrevFail',
                        caller: 'SlotController:runPreload',
                        state: 'FAILED',
                        delta: `slotMode=${this.slotMode}, prev=${prevIdx}`,
                        result: e?.message || 'mount failed'
                    });
                }
            }
        };

        const hasIdleCallback = typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function';
        this.logger?.trace?.({
            scope: 'SlotController',
            action: 'preloadSchedule',
            caller: 'SlotController:scheduleAdjacentPreload',
            state: 'SCHEDULED',
            delta: `slotMode=${this.slotMode}, current=${currentIdx}/${Math.max(0, spineCount - 1)}, via=${hasIdleCallback ? 'requestIdleCallback(1200ms)' : 'setTimeout(120ms)'}`,
            result: `queued next=${currentIdx + 1 < spineCount ? currentIdx + 1 : 'none'}, prev=${currentIdx - 1 >= 0 ? currentIdx - 1 : 'none'}`
        });

        if (hasIdleCallback) {
            this._isIdleCallback = true;
            this._preloadTimer = window.requestIdleCallback(runPreload, { timeout: 1200 });
        } else {
            this._isIdleCallback = false;
            this._preloadTimer = setTimeout(runPreload, 120);
        }
    }

    /**
     * 설정/뷰포트 변경 시 활성 및 대기 슬롯 전체에 스타일과 레이아웃을 재반영합니다.
     * @param {Object} layoutOptions
     * @param {string} userCss
     * @param {Range|Element|null} [currentAnchorTarget=null]
     */
    relayoutAll(layoutOptions, userCss, currentAnchorTarget = null) {
        if (this._isDestroyed) return;

        if (this.currentFrame && !this.currentFrame.isDestroyed) {
            this.currentFrame.setUserStyle(userCss);
            this.currentFrame.relayout(layoutOptions, currentAnchorTarget);
        }
        if (this.nextFrame && !this.nextFrame.isDestroyed && this.nextFrame.state === FrameState.READY) {
            this.nextFrame.setUserStyle(userCss);
            this.nextFrame.relayout(layoutOptions, null);
            this.nextFrame.goToPage(0, 'instant');
        }
        if (this.prevFrame && !this.prevFrame.isDestroyed && this.prevFrame.state === FrameState.READY) {
            this.prevFrame.setUserStyle(userCss);
            this.prevFrame.relayout(layoutOptions, null);
            this.prevFrame.goToEnd();
        }
    }

    /**
     * 새 ChapterFrame 인스턴스를 생성합니다.
     * @private
     */
    _createFrame(spineIndex) {
        return new ChapterFrame({
            spineIndex,
            href: this.getSectionHref(spineIndex),
            container: this.container,
            hookBus: this.hookBus,
            logger: this.logger
        });
    }

    /**
     * 예약된 프리로드 타이머를 취소합니다.
     * @private
     */
    _cancelPreloadSchedule() {
        if (!this._preloadTimer) return;
        if (this._isIdleCallback && typeof window !== 'undefined' && typeof window.cancelIdleCallback === 'function') {
            window.cancelIdleCallback(this._preloadTimer);
        } else {
            clearTimeout(this._preloadTimer);
        }
        this._preloadTimer = null;
        this._isIdleCallback = false;
    }

    /**
     * 단일 프레임을 안전 해제합니다.
     * @private
     */
    _destroyFrame(frame) {
        if (!frame) return;
        try { frame.destroy(); } catch (e) {}
    }

    /**
     * 3개 슬롯 전체를 안전 해제합니다.
     * @private
     */
    _destroyAllFrames() {
        this._destroyFrame(this.prevFrame);
        this._destroyFrame(this.currentFrame);
        this._destroyFrame(this.nextFrame);
        this.prevFrame = null;
        this.currentFrame = null;
        this.nextFrame = null;
    }

    /**
     * 🧹 컨트롤러와 모든 슬롯 자원을 완전 해제합니다.
     */
    destroy() {
        if (this._isDestroyed) return;
        this._isDestroyed = true;
        this._sessionToken++;
        this.logger?.trace?.({
            scope: 'SlotController',
            action: 'destroy',
            caller: 'SlotController:destroy',
            state: 'DESTROYED',
            delta: `slotMode=${this.slotMode}`,
            result: 'all slots disposed'
        });
        this._cancelPreloadSchedule();
        this._destroyAllFrames();
    }
}