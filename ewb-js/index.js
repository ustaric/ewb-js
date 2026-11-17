/**
 * 📚 EWB-JS (Modern HTML5 EPUB Web Engine) 공식 공개 진입점
 * - 🧩 [코어 + 모드(Mod) 아키텍처] EwbEngine, HookBus(중계소), EngineContext(API 집합소) 통합 공개
 * - 🔧 [부품별 독립 사용] ZipReader, EpubParser, ResourceResolver, CfiCodec, ViewportSnap, PaginatorLayout 개별 Export
 * - ⚡ [원라인 부트스트랩] createEpubEngine({ container, mods, ... }) 팩토리 제공
 * 파일 경로: web/ewb-js/index.js
 * @module ewb-js
 */

// Core Engine
export { EwbEngine, EngineState } from './core/EwbEngine.js';
export { ChapterFrame, FrameState } from './core/ChapterFrame.js';
export { SlotController } from './core/SlotController.js';
export { HookBus } from './core/HookBus.js';
export { EngineContext } from './core/EngineContext.js';

// Parser & Resources
export { ZipReader } from './parser/ZipReader.js';
export { ResourceResolver } from './parser/ResourceResolver.js';
export { EpubParser } from './parser/EpubParser.js';

// Layout & CFI
export { CfiCodec } from './layout/CfiCodec.js';
export { PaginatorLayout } from './layout/PaginatorLayout.js';
export {
    calculateExactLineHeight,
    calculateLayoutMetrics,
    collectVisibleTextLines,
    getFirstVisibleLine,
    getLastVisibleLine,
    calculateScrolledLineSnapDelta
} from './layout/ViewportSnap.js';

// Logger
export { EngineLogger, createLogger } from './utils/Logger.js';

import { EwbEngine } from './core/EwbEngine.js';

/**
 * EwbEngine 인스턴스를 생성하고 초기 Mod 배열을 일괄 장착하는 간편 팩토리 함수
 * @param {Object} options - EwbEngine 생성 옵션 + mods?: Array<Function|Object>
 * @returns {EwbEngine}
 */
export function createEpubEngine(options = {}) {
    const { mods = [], ...engineOptions } = options || {};
    const engine = new EwbEngine(engineOptions);

    if (Array.isArray(mods)) {
        mods.forEach((mod) => {
            if (mod) engine.use(mod);
        });
    }

    return engine;
}