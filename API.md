# EWB-JS API & Mod Development Guide

> **HTML5 표준 EPUB 웹 뷰어 코어 엔진(`ewb-js`) 공식 공개 API · 기능 조합 레시피 · 플러그인(Mod) 개발 레퍼런스**

---

## 🚨 제1원칙: `ewb-js/` 코어 무수정 및 플러그인(`Mod`) 확장 원칙

1. **`ewb-js/` 코어 직접 수정 금지**: `ewb-js/` 폴더 내부 파일(`core/`, `layout/`, `parser/`, `bridge/`, `utils/`, `index.js`)은 별도 합의된 코어 계약 확장이 아닌 한 직접 수정하지 않습니다.
2. **플러그인(`Mod`) 기반 확장**: 기본 조판·슬롯 전환·렌더링 외의 모든 부가 기능(입력 제어, 빈 줄 정제, 테마 프리셋, TTS, 번역, 북마크, 하이라이트, HUD, 계측 등)은 외부에서 `engine.use(mod)`를 통해 `HookBus` 훅과 `EngineContext` 공개 API를 조합해 구현합니다.
3. **API 집합소(`EngineContext`) 활용**: 플러그인 간 공유 기능은 코어 내부를 패치하지 말고 `ctx.registerApi(namespace, apiObject)`와 `ctx.getApi(namespace)` 레지스트리로 연결합니다.

---

## 1. 아키텍처 개요 & 진입점

`ewb-js`는 독립 `iframe` 기반의 순수 뷰어 엔진(`EwbEngine`) 위에 라이프사이클 중계소(`HookBus`)와 공식 API 집합소(`EngineContext`)를 두어 외부 모드를 조립하는 구조입니다.

    Host App / UI
      ├── createEpubEngine({ container, mods, ... }) / new EwbEngine(options)
      │     ├── SlotController (single / triple 챕터 슬롯 및 0ms 전환)
      │     │     └── ChapterFrame (독립 iframe · PaginatorLayout · ViewportSnap)
      │     ├── HookBus (12대 라이프사이클 훅 중계소)
      │     └── EngineContext (Mod 전용 공식 API 집합소 + registerApi 레지스트리)
      ├── Standalone Exports (ZipReader, EpubParser, ResourceResolver, CfiCodec, PaginatorLayout, ViewportSnap, LayoutTraceReporter)
      └── Bridge (<ewb-compat-view> Web Component 호환 어댑터)

### 1.1 빠른 시작 (`EwbEngine` / `createEpubEngine`)

    import { createEpubEngine, createLogger } from './ewb-js/index.js';

    const engine = createEpubEngine({
        container: document.getElementById('viewer-host'),
        slotMode: 'triple',
        flow: 'paginated',
        pageSpread: 'auto',
        transition: 'instant',
        autoResize: true,
        fontSize: 16,
        lineHeight: 1.5,
        margins: { top: 24, bottom: 24, left: 28, right: 28 },
        theme: {
            backgroundColor: '#ffffff',
            textColor: '#1f2937',
            linkColor: '#2563eb'
        },
        logger: createLogger({ level: 'warn' }),
        mods: [/* 선택: 초기 장착할 Mod 배열 */]
    });

    engine.on('relocate', ({ detail }) => {
        console.log(
            detail.spineIndex,
            detail.page + 1,
            detail.totalPages,
            detail.cfi,
            detail.trigger,
            detail.source
        );
    });

    await engine.open(epubFile, { initialLocation: 0 });

### 1.2 공개 Export 목록 (`ewb-js/index.js` 및 하위 모듈)

| 구분 | Export 심볼 | 제공 경로 / 역할 |
| :--- | :--- | :--- |
| **팩토리 & 코어** | `createEpubEngine`, `EwbEngine`, `EngineState` | `ewb-js/index.js` — 원라인 엔진 생성 및 상태 상수 (`IDLE`, `OPENING`, `READY`, `ACTIVE`, `DESTROYED`) |
| **프레임 & 슬롯** | `ChapterFrame`, `FrameState`, `SlotController` | `ewb-js/index.js` — 독립 챕터 프레임(`IDLE`, `MOUNTING`, `RENDERING`, `READY`, `FAILED`, `DESTROYED`) 및 슬롯 제어 |
| **플러그인 기반** | `HookBus`, `EngineContext` | `ewb-js/index.js` — 라이프사이클 중계소 및 Mod API 집합소 |
| **파서 & 리소스** | `ZipReader`, `EpubParser`, `ResourceResolver` | `ewb-js/index.js` — ZIP 압축 해제, EPUB 2/3 OPF/Nav/NCX 파싱, Blob URL 리소스 치환 |
| **조판 & CFI** | `CfiCodec`, `PaginatorLayout` | `ewb-js/index.js` — EPUB CFI 인코딩/디코딩 및 다단/스크롤 조판기 |
| **라인 계산 유틸** | `calculateExactLineHeight`, `calculateLayoutMetrics`, `collectVisibleTextLines`, `getFirstVisibleLine`, `getLastVisibleLine`, `calculateScrolledLineSnapDelta` | `ewb-js/index.js` — 짝수 줄높이·여백 연산 및 DOM Range 기반 가시 텍스트 라인 실측 |
| **로거** | `EngineLogger`, `createLogger` | `ewb-js/index.js` — 외부 어댑터 주입형 4대 컨텍스트 추적 로거 |
| **하위 유틸 (직접 Import)** | `compareCfiStart`, `isSameCfiStart` / `normalizeZipPath`, `resolveRelativeZipPath`, `guessMimeType` / `isLoggerDebugEnabled`, `createBufferedLayoutLogger`, `captureLayoutSnapshot`, `emitPureLayoutReport` | `./ewb-js/layout/CfiCodec.js`, `./ewb-js/parser/ZipReader.js`, `./ewb-js/utils/LayoutTraceReporter.js` — 무상태 CFI 비교, ZIP 경로/MIME 유틸, 순수 조판 스냅샷/리포터 |
| **호환 브릿지** | `FoliateCompatView`, `registerCompatElement` | `./ewb-js/bridge/FoliateCompatView.js` — `<ewb-compat-view>` 커스텀 엘리먼트 |

---

## 2. API로 구현할 수 있는 기능별 조합 가이드 (Mod Cookbook)

엔진 내부(`_...` 프로퍼티, `iframe` 박스 스타일, 코어 스타일 태그)에 접근하지 않고 공개 API와 훅 조합만으로 구현 가능한 대표 기능 패턴입니다.

### 2.1 테마 · 타이포그래피 · 여백 제어
* **목적**: 폰트·문단 간격은 유지한 채 다크/세피아/AMOLED 색상 테마만 0ms로 즉시 전환하거나 글자 크기·줄간격·4방향 여백을 조절합니다.
* **조합 API**: `setTheme()`, `getTheme()`, `getThemeCss()`, `setUserCss()`, `setLayoutOptions()`, `onThemeChange`
* **핵심 규칙**: `ChapterFrame`의 `<head>`에는 `#ewb-core-layout-style` → `#ewb-user-style` → `#ewb-theme-style` 순으로 주입됩니다.
  * **글자 크기·줄간격**은 `setLayoutOptions({ fontSize, lineHeight })`로 제어하세요. `userCss`에 `body { font-size: ... !important; line-height: ... !important; }`를 넣으면 `#ewb-user-style`이 코어 스타일을 덮어씁니다.
  * **색상 테마**는 `setTheme()`에 맡기고 `userCss`에는 폰트 패밀리·문단 여백·들여쓰기만 두면 재조판 없이 테마만 교체할 수 있습니다.

    export const ThemePresetMod = {
        name: 'theme-preset-mod',
        setup(ctx) {
            const unsub = ctx.onHook('onThemeChange', ({ theme }) => {
                console.log('테마 변경됨:', theme);
            });

            ctx.registerApi('themePreset', {
                applyDark: () => ctx.setTheme({
                    backgroundColor: '#121212',
                    textColor: '#e5e7eb',
                    linkColor: '#93c5fd',
                    selectionColor: '#1d4ed8'
                }),
                clear: () => ctx.setTheme(null)
            });

            return () => {
                unsub();
                ctx.setTheme(null);
            };
        }
    };

### 2.2 터치 · 키보드 · 휠 · 내부 링크 인터셉트 & 입력 출처(`source`) 추적
* **목적**: 각 챕터 `iframe` 내부의 포인터/키/휠 입력을 감지해 페이지를 넘기거나, EPUB 내부 `<a href>` 및 이미지 클릭 동작을 커스텀하고, 이동 원인(`source`: `'keyboard'`, `'mouseWheel'`, `'touchScroll'`, `'gamepad'`, `'autoScroll'` 등)을 엔진 로그와 `relocate` 이벤트로 추적합니다.
* **조합 API & Hook**: `onFrameMount`, `onFrameDestroy`, `onLinkClick` (`priority < 999`), `onNativeScrollEnd`, `nextPage({ source })`, `prevPage({ source })`, `scrollByPixels(deltaPx, 'instant', { source })`, `goTo(target, { source })`
* **주의점**: `triple` 슬롯 모드에서는 `iframe`이 수시로 생성·파괴되므로 `onFrameMount`에서 `WeakMap<Document, AbortController>`로 리스너를 묶고 `onFrameDestroy`에서 `abort()`로 해제해야 누수가 없습니다.

    export const LinkGuardMod = {
        name: 'link-guard-mod',
        setup(ctx) {
            const controllers = new WeakMap();

            const unsubMount = ctx.onHook('onFrameMount', ({ doc }) => {
                const ac = new AbortController();
                controllers.set(doc, ac);
                doc.addEventListener('keydown', (e) => {
                    if (e.key === 'ArrowRight') ctx.nextPage({ source: 'keyboard' });
                    if (e.key === 'ArrowLeft') ctx.prevPage({ source: 'keyboard' });
                }, { signal: ac.signal });
            });

            const unsubDestroy = ctx.onHook('onFrameDestroy', ({ doc }) => {
                controllers.get(doc)?.abort();
                controllers.delete(doc);
            });

            // 코어 기본 내부 링크 핸들러(priority: 999)보다 먼저 실행해 외부 링크 처리 가로채기
            const unsubLink = ctx.onHook('onLinkClick', ({ isExternal, href }) => {
                if (isExternal) {
                    window.open(href, '_blank', 'noopener,noreferrer');
                    return { handled: true };
                }
                // return 없음 ➔ 코어 기본 핸들러(999)가 내부 챕터/앵커로 goTo() 처리
            }, { priority: 100 });

            return () => {
                unsubMount();
                unsubDestroy();
                unsubLink();
            };
        }
    };

### 2.3 TTS(음성 낭독) · 자동 스크롤 · 실시간 줄 하이라이트
* **목적**: 현재 화면에 실제로 보이는 문장/줄부터 읽어주거나, 부드럽게 자동 스크롤하고 페이지·챕터 경계에 도달하면 다음으로 이어갑니다.
* **조합 API & Hook**: `getVisibleLines()`, `getFirstVisibleLine()`, `getLastVisibleLine()`, `scrollByLines()`, `scrollByPixels()`, `scrollToTarget()`, `nextPage()`, `onRelocate`, `onBoundaryReached`
* **원리**: `getVisibleLines()`가 각 줄의 `(node, startOffset, endOffset, text, top, bottom, isFullyVisible)`를 컬럼 우선(2단 시 좌측 컬럼 전체 → 우측 컬럼) 순서로 반환하므로, 현재 화면 첫 온전한 줄에 `Range`를 만들어 낭독 시작점과 하이라이트를 정확히 잡을 수 있습니다.

    export const AutoScrollSampleMod = {
        name: 'auto-scroll-sample',
        setup(ctx) {
            let timerId = null;

            const stop = () => {
                if (timerId) {
                    clearInterval(timerId);
                    timerId = null;
                }
            };

            const start = (pxPerTick = 2) => {
                stop();
                timerId = setInterval(async () => {
                    if (ctx.getState() !== 'ACTIVE') return;
                    const res = ctx.scrollByPixels(pxPerTick, 'instant', { source: 'autoScroll' });
                    if (res?.atBoundary === 'end') {
                        await ctx.nextChapter({ position: 'start', source: 'autoScroll' });
                    }
                }, 32);
            };

            ctx.registerApi('simpleAutoScroll', { start, stop });
            return () => stop();
        }
    };

### 2.4 본문 전처리 · 빈 줄 정제 · 인라인 번역
* **목적**: 조판 전 HTML 문자열을 정리하거나, 렌더링된 본문 문단을 다국어로 번역하고 필요 시 원문으로 복구합니다.
* **조합 API & Hook**: `onTransformHtml` (문자열 단계), `onFrameMount` / `onFrameReady` (DOM 단계), `loadChapterHtml(spineIndex)`, `relayout()`
* **단계 선택 기준**:
  * **문자열 정제**(불필요한 빈 `<p>`, 태그 정규화): `onTransformHtml`에서 문자열을 변환 반환하면 조판·이미지 대기 전에 한 번만 반영됩니다.
  * **DOM 조작/실시간 번역 토글**: `onFrameMount` 또는 `onFrameReady`에서 `doc` 내 텍스트 노드를 다루고, 텍스트 길이 변화로 페이지 수가 바뀌면 `ctx.relayout()`을 호출합니다.

### 2.5 북마크 · 형광펜 하이라이트 · 독서 위치 저장 · 본문 검색
* **목적**: 현재 페이지 위치를 표준 EPUB CFI로 저장/복원하고, 사용자 선택 영역을 하이라이트로 기록하며 책 전체를 검색합니다.
* **조합 API & Hook**: `onRelocate`, `getCurrentLocation()`, `encodeCfi()`, `decodeCfi()`, `resolveCfi()`, `search()`, `goTo()`
* **포인트**: `resolveCfi(cfiString, doc, { collapseToStart: false })`를 사용하면 범위 CFI(시작~끝)를 `Range`로 복원해 하이라이트 오버레이나 텍스트 스니펫 추출에 활용할 수 있습니다.

    export const BookmarkSampleMod = {
        name: 'bookmark-sample',
        setup(ctx) {
            ctx.registerApi('bookmarkHelper', {
                captureCurrent: () => {
                    const loc = ctx.getCurrentLocation();
                    if (!loc) return null;
                    return {
                        cfi: loc.cfi,
                        spineIndex: loc.spineIndex,
                        fraction: loc.fraction,
                        preview: loc.firstLine?.text || ''
                    };
                },
                jumpTo: (cfi) => ctx.goTo(cfi, { behavior: 'instant', source: 'bookmark' }),
                findInBook: async (keyword) => {
                    const hits = [];
                    for await (const hit of ctx.search(keyword)) {
                        hits.push(hit);
                    }
                    return hits;
                }
            });
        }
    };

### 2.6 리더 HUD · 푸터바 · 목차 · 컨테이너 레이아웃 연동
* **목적**: 책 제목, 목차 위치, 현재 페이지, 전체 진행률(`fraction`)을 보여주는 상·하단 바를 구성합니다.
* **조합 API & Event**: `getBookMeta()`, `getToc()`, `getSections()`, `getCurrentLocation()`, `getContainer()`, `onEvent('load' | 'relocate' | 'chapterChange' | 'stateChange')`
* **배치 방식 2가지**:
  1. **컨테이너 외부 Flex/Grid 형제 배치 (권장)**: 바를 켜거나 높이가 바뀔 때 `container` 크기가 변하므로 엔진 내부 `ResizeObserver`(`autoResize: true` 기본)가 150ms 디바운스 후 자동으로 `relayout({ source: 'resizeObserver' })`를 수행합니다. (호스트 앱이 별도 `viewportManager` 등으로 디바운스/짝수 보정을 직접 관장할 때는 `autoResize: false`로 중복 리레이아웃을 끌 수 있습니다.)
  2. **컨테이너 내부 플로팅 오버레이 배치**: `container` 크기가 그대로이므로 바의 높이만큼 `ctx.setLayoutOptions({ margins: { bottom: baseBottom + barHeight } })`로 여백을 보정하세요.

### 2.7 조판 정밀 계측 · 엔진 순수 기준(Baseline) 비교
* **목적**: 사용자 CSS/테마/플러그인이 적용된 현재 화면의 잘림·여백 수치와, 아무 플러그인도 개입하지 않은 순수 엔진 기준(Baseline) 조판 결과를 비교 진단합니다.
* **조합 API**: `getViewportMetrics()`, `getClippingMetrics()`, `getLayoutSnapshot()`, `measurePureBaseline(spineIndex, pureLayoutOptions)`, `createLogger()`
* **장점**: `ewb` 로거가 비활성화(OFF)된 운영 환경에서도 `getLayoutSnapshot({ forceCapture: true })`와 `measurePureBaseline()`은 호출 시점에 즉시 계측 결과를 반환합니다.

### 2.8 독립 부품(`Standalone`) 및 호환 Web Component 활용
* **`EpubParser` / `ZipReader` 단독 사용**: 뷰어를 띄우지 않고 서재 목록에서 EPUB 메타데이터·표지(`book.getCover()`)·목차만 추출하거나, 이미 파싱된 `book` 객체를 `engine.open(book)`에 넘겨 중복 압축 해제를 막을 수 있습니다. (단, 공유 `book`을 넘긴 경우 `engine.destroy()`는 `book`을 해제하지 않으므로 소유자가 `book.dispose()`를 호출해야 합니다.)
* **`FoliateCompatView` (`<ewb-compat-view>`)**: 기존 `foliate-view` 호환 인터페이스가 필요한 환경에서 `view.configure()`, `view.open()`, `view.init()`, `view.goTo()`, `view.next()`, `view.prev()`, `view.search()`, `view.renderer.*`를 제공합니다.

---

## 3. 공개 API 상세 레퍼런스

### 3.1 `new EwbEngine(options)` / `createEpubEngine(options)`

| 옵션 | 타입 | 기본값 | 설명 |
| :--- | :--- | :--- | :--- |
| `container` | `HTMLElement` | **(필수)** | 뷰어 iframe들이 마운트될 DOM 컨테이너 |
| `slotMode` | `'triple' \| 'single'` | `'triple'` | 앞/뒤 챕터 사전 대기(`triple`) 또는 단일 슬롯(`single`) |
| `flow` | `'paginated' \| 'scrolled'` | `'paginated'` | 가로 다단 넘김(`paginated`) / 세로 스크롤(`scrolled`) |
| `pageSpread` | `'auto' \| 'single' \| 'double'` | `'auto'` | 가로 다단 열 수 (`auto`는 가로 폭 600px 이상일 때 2단) |
| `transition` | `'instant' \| 'smooth'` | `'instant'` | 페이지 이동 스크롤 애니메이션 방식 |
| `skipLeadingBlankLines` | `boolean` | `false` | `scrolled` 페이지 이동 시 상단 소형 빈 줄(2.5줄 이하) 스킵 여부 |
| `autoResize` | `boolean` | `true` | 컨테이너 `ResizeObserver`의 150ms 디바운스 자동 `relayout()` 활성 여부 (외부 뷰포트 관리자 사용 시 `false`) |
| `fontSize` | `number` | `16` | 본문 기본 글자 크기 (`px`) |
| `lineHeight` | `number` | `1.4` | 본문 기본 줄간격 배수 |
| `margins` | `{ top, bottom, left, right }` | `{ 40, 40, 48, 48 }` | 4방향 외부 여백 (`px`, `marginTop` 등 플랫 키도 지원) |
| `columnGap` | `number` | `40` | 다단 간격 (`px`) |
| `backgroundColor` | `string` | `'transparent'` | 기본 외곽/프레임 배경색 |
| `theme` | `ThemeObject \| null` | `null` | `{ backgroundColor, textColor, linkColor, selectionColor }` (`bg`, `color`/`fg`, `link`, `selection` 별칭 지원) |
| `userCss` | `string` | `''` | 사용자 폰트·문단 등 커스텀 CSS |
| `logger` | `EngineLogger \| Object \| null` | `null` | `createLogger(...)` 인스턴스 또는 옵션 (`{ adapter, defaultChannel, level, enabled, channelMode, historyLimit }`) |
| `parser` | `Object \| null` | `EpubParser` | 커스텀 파서 주입 |
| `cfiCodec` | `Object \| null` | `CfiCodec` | 커스텀 CFI 코덱 주입 |
| `mods` | `Array<Function \| Object>` | `[]` | `createEpubEngine()` 전용: 생성 직후 `engine.use()`로 일괄 장착할 Mod 배열 |

### 3.2 `EwbEngine` 공개 메서드

#### 라이프사이클 & 플러그인
* `engine.use(mod)` → `EwbEngine`: 함수형 `(ctx) => teardown?` 또는 객체형 `{ name, setup(ctx), teardown? }` 플러그인 장착 (비동기 `setup` 및 중복 설치 방지 지원)
* `engine.unuse(modOrName)` → `boolean`: 장착된 플러그인 해제 및 `teardown` 실행
* `engine.open(source, options)` → `Promise<Book>`: EPUB `File`/`Blob`/`ArrayBuffer`/`Uint8Array` 또는 파싱된 `Book` 열기 (`options`: `{ initialLocation = 0, autoMount = true }`)
* `engine.on(eventName, listener)` → `() => void`: 표준 이벤트 구독 (구독 해제 함수 반환)
* `engine.off(eventName, listener)` → `void`: 표준 이벤트 구독 해제
* `engine.destroy()` → `void`: 모든 슬롯, Mod, 외부 생성 프레임, Blob URL, `ResizeObserver` 해제 및 상태 `DESTROYED` 전환

#### 이동 & 스크롤 (공통 `source` 출처 계약 지원)
모든 이동·스크롤 메서드는 선택적으로 `source` 문자열(예: `'keyboard'`, `'mouseWheel'`, `'mouseClick'`, `'touchTap'`, `'touchScroll'`, `'touchSwipe'`, `'gamepad'`, `'autoScroll'`, `'tts'`)을 받아 엔진 내부 추적 로그(`EwbEngine:${trigger}(${source})`), `onRelocate` 훅, `relocate` 이벤트 payload에 그대로 전달합니다.

* `engine.goTo(target, options)` → `Promise<Location | null>`: `spineIndex`(숫자), `epubcfi(...)`, `href#id`, `{ spineIndex | index, anchor }`로 이동 (`options`: `{ behavior = 'instant', source = 'api' }`)
* `engine.nextPage(options)` / `engine.prevPage(options)` → `Promise<Location | null>`: 페이지 이동 (경계 시 `next`는 다음 챕터 `'start'`, `prev`는 이전 챕터 `'end'`로 자동 전환. `options`: `{ distance, lineSnap, behavior, source = 'api' }`)
* `engine.nextChapter(options)` / `engine.prevChapter(options)` → `Promise<Location | null>`: 챕터 단위 이동 (`options`: `{ position = 'start' | 'end', source = 'api' }`, 두 메서드 모두 기본값 `'start'`)
* `engine.goToPage(pageIndex, behaviorOrOptions, extraOptions)` → `{ moved, currentPage, totalPages } | null`: 현재 챕터 내 0-based 페이지 이동 + `relocate` 발행 (`behaviorOrOptions`는 `'instant'|'smooth'` 문자열 또는 `{ behavior, source }`, `extraOptions`: `{ source = 'api' }`)
* `engine.goToEnd(options)` → `{ moved, currentPage, totalPages } | null`: 현재 챕터 마지막 페이지 이동(`scrolled` 모드 상단 줄 스냅 포함) + `relocate` 발행 (`options`: `{ source = 'api' }`)
* `engine.scrollToTarget(target, behaviorOrOptions = 'instant', extraOptions = {})` → `{ success, currentPage, totalPages } | null`: DOM `Range`/`Element` 위치로 이동 + `relocate` 발행 (`behaviorOrOptions`는 문자열 또는 `{ behavior, source }`, `extraOptions`: `{ source = 'api' }`)
* `engine.scrollByPixels(deltaPx, behaviorOrOptions = 'instant', extraOptions = {})` → `{ moved, atBoundary: 'start'|'end'|null }`: 픽셀 단위 연속 스크롤 (`scrolled` 하단 마스킹 일시 해제. `behaviorOrOptions`는 문자열 또는 `{ behavior, source }`, `extraOptions`: `{ source = 'api' }`)
* `engine.scrollByLines(lineCount = 1, behaviorOrOptions = 'instant', extraOptions = {})` → `{ moved, atBoundary }`: 현재 `exactLineHeightPx` 기준 줄 단위 스크롤 (`behaviorOrOptions`·`extraOptions` 동일 지원)

#### 조판 · 스타일 · 테마
* `engine.setLayoutOptions(partialOptions)` → `void`: `slotMode`, `flow`, `pageSpread`, `transition`, `skipLeadingBlankLines`, `fontSize`, `lineHeight`, `margins`, `columnGap`, `backgroundColor`, `source` 반영 후 활성 상태면 위치 보존 재조판 (`relayout({ source: partialOptions.source || 'setLayoutOptions' })`)
* `engine.getLayoutOptions()` → `Object`: 현재 유효 레이아웃 옵션 + `slotMode` 스냅샷 반환
* `engine.getMargins()` → `{ top, bottom, left, right }`: 현재 4방향 여백 반환
* `engine.setTheme(theme | null)` → `void`: 색상 테마 적용 (`null` 또는 `{}` 시 해제) 및 `onThemeChange` 발행
* `engine.getTheme()` → `{ backgroundColor, textColor, linkColor, selectionColor } | null`
* `engine.getThemeCss()` → `string`: 현재 생성된 테마 CSS 문자열 반환
* `engine.setUserCss(cssText = '')` → `void`: 사용자 CSS 갱신 (활성 상태면 `relayout({ source: 'setUserCss' })` 실행)
* `engine.getUserCss()` → `string`
* `engine.relayout(options = {})` → `void`: 현재 첫 줄 위치를 앵커로 보존하며 활성/대기 슬롯 재조판 및 `onRelayout` 훅·`relocate` 발행 (`options`: `{ source = 'relayout' }`)

#### 조회 · 검색 · CFI · 계측
* `engine.getContainer()` → `HTMLElement`
* `engine.getBookMeta()` → `BookMetadata | null`
* `engine.getToc()` → `Array<TocItem>`
* `engine.getSections()` → `Array<Section>`
* `engine.loadChapterHtml(spineIndex)` → `Promise<string>`: 리소스(이미지/CSS)가 Blob URL로 치환된 HTML 문자열 반환
* `engine.getCurrentLocation()` → `Location | null`
* `engine.getViewportMetrics()` → `ViewportMetrics`
* `engine.getClippingMetrics()` → `ClippingMetrics | null`
* `engine.getCurrentFrame()` → `ChapterFrame | null`
* `engine.getFrames()` → `{ prev: ChapterFrame | null, current: ChapterFrame | null, next: ChapterFrame | null }`
* `engine.forEachFrame(callback)` → `void`: 유효한 슬롯마다 `(frame, role)` 실행 (`role`: `'prev' | 'current' | 'next'`)
* `engine.getActiveDocument()` → `Document | null`
* `engine.encodeCfi(spineIndex, range, doc)` → `string`
* `engine.decodeCfi(cfiString)` → `{ raw, spineIndex, isRange, start, end }`
* `engine.resolveCfi(cfiString, doc, options)` → `Range | null` (`options`: `{ collapseToStart = true }`)
* `engine.search(query)` → `AsyncGenerator<{ spineIndex, cfi, excerpt }>`

### 3.3 `EngineContext` 전용 추가 메서드 (Mod `setup(ctx)` 전용)

`EwbEngine`의 네비게이션(`goToPage`, `goToEnd`, `scrollToTarget`, `scrollByPixels`, `scrollByLines`, `relayout` 등의 `source`/`extraOptions` 포함)·조판·테마·조회·CFI·검색 API를 모두 위임 제공하는 것에 더해, 아래 Mod 전용 메서드가 추가됩니다.

| 메서드 | 시그니처 요약 | 설명 |
| :--- | :--- | :--- |
| **훅 등록/해제** | `ctx.onHook(hookName, handler, { priority, once, name })` / `ctx.offHook(hookName, handler)` | `HookBus` 구독 등록(해제 함수 반환) 및 제거 |
| **이벤트/모드 제어** | `ctx.onEvent(name, fn)` / `ctx.offEvent(name, fn)` / `ctx.unuse(modOrName)` | 엔진 이벤트 구독 및 특정 Mod 해제 |
| **API 레지스트리** | `ctx.registerApi(ns, obj)` / `ctx.getApi(ns)` / `ctx.listApis()` | 플러그인 간 공용 인터페이스 등록 및 조회 |
| **상태 조회** | `ctx.getState()` | 현재 `EngineState` 문자열 반환 (`IDLE`, `OPENING`, `READY`, `ACTIVE`, `DESTROYED`) |
| **가시 라인 계측** | `ctx.getVisibleLines(opts)` / `ctx.getFirstVisibleLine(opts)` / `ctx.getLastVisibleLine(opts)` | 현재 활성 프레임의 텍스트 라인 수집 및 첫/끝 줄 반환 |
| **스냅샷 조회** | `ctx.getLayoutSnapshot(frame, { forceCapture = false })` | 지정 프레임(기본: 현재 프레임)의 `{ initial, last }` 조판 스냅샷 복사본 반환 |
| **순수 Baseline 측정** | `await ctx.measurePureBaseline(spineIndex, pureLayoutOptions)` | 훅/사용자CSS/테마 없이 순수 엔진 기준 프레임을 1회 백그라운드 실측 후 즉시 파기해 결과 반환 |
| **독립 프레임 팩토리** | `ctx.createChapterFrame(spineIndex)` | 엔진이 수명주기를 추적하는 독립 `ChapterFrame` 생성 (`engine.destroy()` 시 자동 정리) |
| **로거 발급** | `ctx.createLogger(scopeName)` | 스코프 태그가 고정된 하위 로거 반환 |

### 3.4 주요 반환 객체 스키마

#### `Location` (`getCurrentLocation` / `onRelocate` / `relocate` 이벤트)
* `spineIndex`: 현재 챕터 인덱스 (`0-based`)
* `href`: 현재 챕터 ZIP 내부 경로
* `tocItem`: 매칭된 목차 항목 객체 또는 `null`
* `page`: 현재 챕터 내 페이지 (`0-based`)
* `totalPages`: 현재 챕터 총 페이지 수 (`>= 1`)
* `atStart` / `atEnd`: 챕터 시작/끝 경계 도달 여부 (`boolean`)
* `fraction`: 전체 도서 진행률 (`0` ~ `1`)
* `cfi`: 현재 화면 첫 줄~끝 줄 범위의 표준 EPUB CFI 문자열
* `firstLine` / `lastLine`: 현재 화면 첫 번째/마지막 가시 라인 객체 또는 `null`
* *(이벤트·훅 전용 추가 필드)* `trigger`: 엔진 내부 실행 액션 식별자 (`'nextPage'`, `'scrollByPixels'`, `'nativeScroll'`, `'relayout'` 등)
* *(이벤트·훅 전용 추가 필드)* `source`: 호출자/입력 출처 식별자 (`'keyboard'`, `'mouseWheel'`, `'mouseClick'`, `'touchTap'`, `'touchScroll'`, `'nativeTouch'`, `'touchSwipe'`, `'gamepad'`, `'autoScroll'`, `'tts'`, `'api'` 등)

#### `VisibleLine` (`getVisibleLines` / `getFirstVisibleLine` / `getLastVisibleLine`)
* `node`: 대상 `Text` 노드
* `startOffset` / `endOffset`: `node.nodeValue` 내 해당 시각 줄의 문자 오프셋
* `text`: 해당 줄 텍스트 조각 (최대 80자 트림)
* `tagName`: 부모 엘리먼트 태그명
* `top` / `bottom` / `left` / `right` / `height`: 뷰포트 기준 좌표 (`px`)
* `topCutPx` / `bottomCutPx`: 상·하단 경계 잘림량 (`px`)
* `isFullyVisible`: `topCutPx <= 0.5 && bottomCutPx <= 0.5` 여부

#### `ViewportMetrics` (`getViewportMetrics` / `calculateLayoutMetrics`)
* `usableWidth` / `usableHeight`: 짝수 보정된 가용 뷰포트 크기 (`px`)
* `exactLineHeightPx`: 짝수 정수화된 1줄 높이 (`px`, 최소 12px)
* `paddingTop` / `paddingBottom` / `paddingLeft` / `paddingRight`: 실제 배치 여백 (`px`)
* `safetyBuffer`: 하단 안전 버퍼 (`px`, `marginBottom >= 12`이면 `0`, 미만이면 `paginated: 4` / `scrolled: 8|12`)
* `contentAvailableHeight`: 여백·버퍼 제외 가용 높이 (`px`)
* `fullLineCount` / `pageHeight`: 페이지당 온전한 줄 수 및 정수배 조판 높이 (`fullLineCount * exactLineHeightPx`)
* `contentWidth`: 콘텐츠 영역 너비 (`px`)
* `columnCount`: `1 | 2`
* `columnGap` / `columnWidth`: 컬럼 간격 및 단일 컬럼 너비 (`px`)
* `isPortrait` / `isNarrowMobile`: 세로 화면 여부 / `usableWidth < 600` 여부

#### `ClippingMetrics` (`getClippingMetrics`)
* `topCutPx` / `rawBottomCutPx`: DOM 실측 기준 상단/하단 최대 잘림량 (`px`)
* `maskedBottomPx`: `scrolled` 모드 정지 시 `clip-path`로 가린 하단 높이 (`px`)
* `visibleBottomCutPx`: 마스킹 반영 후 실제 육안 노출 하단 잘림량 (`px`)
* `topClippedCount` / `bottomClippedCount`: 경계 걸침 줄 수
* `visibleLineCount` / `fullLineCount` / `paragraphCount`: 가시 줄 수, 온전한 줄 수, 가시 문단 수
* `topClippedText` / `bottomClippedText` / `pageHeight`: 걸침 줄 앞부분 텍스트 및 페이지 높이

#### `LayoutSnapshot` (`getLayoutSnapshot` / `measurePureBaseline`)
* `getLayoutSnapshot()` 반환: `{ initial, last }` (각 항목은 `pass`, `spineIndex`, `active`, `flow`, `pageSpread`, `fontsStatus`, `imageCount`, `coreFontSize`, `coreLineHeight`, `metrics`, `pagination`, `styles`, `dom`, `clipping`, `firstText`, `lastText` 포함)
* `measurePureBaseline()` 반환: `{ spineIndex, snapshot, metrics, clipping, viewportMetrics, layoutOptions }` (`null` 가능)

#### `Book` (`EpubParser.parse()` / `engine.open()`)
* `isEwbBook`: `true`
* `opfPath`: OPF 패키지 ZIP 내부 경로
* `metadata`: `{ title, author, language, publisher, description, identifier, direction }`
* `manifest`: `Map<string, { id, href, rawHref, mediaType, properties }>`
* `sections`: `[{ index, id, idref, href, mediaType, linear, cfiBase, loadHtml, loadResolvedHtml, load, createDocument, createURI }]`
* `toc` / `landmarks`: `[{ label, href, type?, subitems }]`
* `coverHref`: 표지 이미지 ZIP 경로 또는 `null`
* `zip` / `resolver`: `ZipReader` / `ResourceResolver` 인스턴스
* `getCover()`: `Promise<Blob | null>`
* `resolveHref(rawHref)`: `{ index, anchor, href } | null`
* `dispose()` (별칭: `destroy()`): ZIP 버퍼 및 Blob URL 일괄 회수

### 3.5 표준 이벤트 & 12대 라이프사이클 훅

#### 표준 이벤트 (`engine.on` / `ctx.onEvent`)
| 이벤트명 | `detail` Payload |
| :--- | :--- |
| `'load'` | `{ spineIndex, doc, frame }` |
| `'relocate'` | `{ ...Location, trigger, source }` |
| `'chapterChange'` | `{ spineIndex, direction, frame }` |
| `'stateChange'` | `{ prev, next }` |

#### `HookBus` 12대 라이프사이클 훅
| 훅 이름 | 실행 모델 | 전달 Payload / 시그니처 | 제어 / 비고 |
| :--- | :--- | :--- | :--- |
| `onAfterParse` | 비동기 브로드캐스트 | `{ book, engine }` | 파싱 직후 1회 (`stopOnHandled: false`) |
| `onTransformHtml` | 비동기 순차 파이프 | `(html, { spineIndex, href, frame }) => string` | 문자열 반환 시 다음 훅으로 전달 |
| `onFrameMount` | 비동기 브로드캐스트 | `{ spineIndex, href, doc, frame }` | DOM 획득·스타일 주입 직후, 1차 조판 전 (코어 테마 주입기 `priority: 999`) |
| `onFrameReady` | 비동기 브로드캐스트 | `{ spineIndex, href, doc, frame, pagination }` | 폰트·이미지·Spacer 완료 후 |
| `onBoundaryReached` | 비동기 인터셉트 | `{ direction, currentIndex, targetIndex, currentFrame }` | `{ handled: true }` 반환 시 기본 챕터 전환 중단 |
| `onLinkClick` | 동기 인터셉트 | `{ spineIndex, chapterHref, href, anchor, isExternal, event, doc, frame }` | 코어 기본 핸들러는 `priority: 999` (`< 999`로 가로채기 가능) |
| `onNativeScrollEnd` | 동기 브로드캐스트 | `{ spineIndex, frame }` | `scrolled` 모드 네이티브 스크롤 정착(140ms) 후 1회 발행 (코어 기본 핸들러 `priority: 999`가 `trigger: 'nativeScroll'`, `source: 'nativeTouch'`로 `relocate` 발행) |
| `onRelocate` | 동기 브로드캐스트 | `{ ...Location, trigger, source }` | 이동·스크롤 정착·재조판마다 실행 |
| `onRelayout` | 동기 브로드캐스트 | `{ spineIndex, metrics, layoutOptions }` | `relayout()` 직후 실행 |
| `onThemeChange` | 동기 브로드캐스트 | `{ theme, themeCss }` | `setTheme()` 호출 시 실행 |
| `onFrameDestroy` | 동기 브로드캐스트 | `{ spineIndex, href, doc, frame }` | `ChapterFrame.destroy()` 직전 실행 |
| `onDestroy` | 동기 브로드캐스트 | `{ engine }` | `engine.destroy()` 시 실행 |

### 3.6 독립 부품(`Standalone`) · 로거 · 호환 브릿지 상세 레퍼런스

#### `CfiCodec` & 무상태 비교 헬퍼 (`./ewb-js/layout/CfiCodec.js`)
* `new CfiCodec()`:
  * `buildSectionCfi(spineIndex, book)` → `string`
  * `fromRange(spineIndex, range, doc, book)` → `string`
  * `parse(cfiString, book)` → `{ raw, spineIndex, isRange, start, end }`
  * `compareStart(cfiA, cfiB, book)` → `-1 | 0 | 1 | null` (`[id]` 힌트 및 Range 끝점 무시, 시작점 좌표만 비교)
  * `isSameStart(cfiA, cfiB, book)` → `boolean`
  * `resolveRangeInDocument(parsedCfi, doc, { collapseToStart = true })` → `Range | null`
* 순수 헬퍼 함수:
  * `compareCfiStart(cfiA, cfiB, book)` → `-1 | 0 | 1 | null`
  * `isSameCfiStart(cfiA, cfiB, book)` → `boolean`

#### `ZipReader` · `ResourceResolver` · `EpubParser` (`./ewb-js/parser/*`)
* `ZipReader`:
  * 유틸 함수: `normalizeZipPath(rawPath)`, `resolveRelativeZipPath(baseFilePath, relativePath)`, `guessMimeType(filePath)`
  * `new ZipReader({ logger, customUnzip })`: `load(source)`, `resolveEntryKey(path)`, `has(path)`, `listFiles()`, `readBytes(path)`, `readText(path)`, `readBlob(path, mimeType)`, `dispose()`
* `ResourceResolver`:
  * `new ResourceResolver({ zipReader, logger })`: `getBlobUrl(baseFilePath, rawRef, explicitMimeType)`, `resolveStylesheetUrl(baseFilePath, rawCssHref, visitedCssSet)`, `rewriteCssText(cssText, cssFilePath, visitedCssSet)`, `resolveDocumentResources(doc, chapterZipPath)`, `dispose()`
* `EpubParser`:
  * `new EpubParser({ logger, hookBus, customUnzip })`: `parse(source)` → `Promise<Book>` (DRM 검사, 폰트 난독화 허용, `container.xml` 폴백 탐색, EPUB3 Nav / EPUB2 NCX / Guide / Spine 목차 해석)

#### `ChapterFrame` · `SlotController` · `PaginatorLayout` · `ViewportSnap`
* `ChapterFrame`:
  * `mount({ htmlSource, layoutOptions, userCss, active, initialPosition })`, `ready()`, `activate()`, `deactivate()`, `relayout(layoutOptions, anchorTarget)`, `setUserStyle(cssText)`, `setThemeStyle(cssText)`, `setBackgroundColor(bgColor)`, `syncViewportClipMask({ enabled })`, `getClippingMetrics()`, `getLayoutSnapshot({ forceCapture })`, `getMetrics()`, `getVisibleLines(options)`, `getFirstVisibleLine(options)`, `getLastVisibleLine(options)`, `nextPage(options)`, `prevPage(options)`, `goToPage(pageIndex, behavior)`, `goToEnd()`, `scrollByPixels(deltaPx, behavior)`, `scrollToTarget(target, behavior)`, `destroy()`
  * iframe 박스 스타일은 `_applyIframeBoxStyles()`에서 `transition: 'none'`으로 적용되며, `activate()`/`deactivate()`는 `zIndex`·`opacity`·`visibility`·`pointerEvents`·`aria-hidden`으로 전환합니다(`display: none` 미사용).
  * `scrolled` 모드에서는 `_bindNativeScrollListener()`가 네이티브 스크롤 중 하단 `clipPath` 마스킹을 O(1) 비용으로 해제하고 140ms 정착 후 `onNativeScrollEnd` 훅을 1회 발행합니다(프로그래매틱 스크롤 직후 120ms~450ms 동안은 중복 억제로 유령 `relocate` 방지).
* `SlotController`:
  * `setSlotMode('single' | 'triple')`, `getCurrentFrame()`, `forEachFrame(callback)`, `mountChapter(spineIndex, initialPosition)`, `moveChapter('next' | 'prev', { initialPosition })`, `scheduleAdjacentPreload()`, `relayoutAll(layoutOptions, userCss, currentAnchorTarget)`, `destroy()`
* `PaginatorLayout`:
  * `applyLayout(layoutOptions)`, `ensureEndSpacer()`, `getScrollElement()`, `getPaginationMetrics()`, `goToPage(pageIndex, behavior)`, `goToEnd()`, `nextPage(options)`, `prevPage(options)`, `scrollByPixels(deltaPx, behavior)`, `scrollToTarget(target, behavior)`, `destroy()`
* `ViewportSnap`:
  * `calculateExactLineHeight(fontSize, lineHeight)`, `calculateLayoutMetrics(params)`, `collectVisibleTextLines(doc, options)`, `getFirstVisibleLine(doc, options)`, `getLastVisibleLine(doc, options)`, `calculateScrolledLineSnapDelta(doc, direction, pageHeight, exactLineHeightPx)`

#### `EngineLogger` · `LayoutTraceReporter` (`./ewb-js/utils/*`)
* `createLogger(options)` / `new EngineLogger({ namespace, defaultChannel, level, enabled, adapter, channelMode, historyLimit })`:
  * `setEnabled(enabled)`, `setLevel(level)`, `setAdapter(adapter, channel)`, `getHistory()`, `clearHistory()`, `isDebugEnabled()`, `child(scope)`, `trace(scopeOrCtx, maybeCtx)`, `group(title)`, `groupCollapsed(title)`, `groupEnd()`
* `LayoutTraceReporter` (`./ewb-js/utils/LayoutTraceReporter.js`):
  * `isLoggerDebugEnabled(logger)`, `createBufferedLayoutLogger(baseLogger, frame, shouldBufferFn)`, `captureLayoutSnapshot(frame, pass, logger)`, `emitPureLayoutReport({ logger, snapshot, prevSnapshot, bufferedLogs, trigger })`

#### `FoliateCompatView` (`./ewb-js/bridge/FoliateCompatView.js`)
* 커스텀 엘리먼트 `<ewb-compat-view>` 자동 등록 (`registerCompatElement(tagName = 'ewb-compat-view')`)
* 감시 속성: `flow`, `max-column-count`, `max-inline-size`, `margin`
* 공개 메서드·프로퍼티: `configure(options)`, `open(source)`, `init({ lastLocation })`, `goTo(target)`, `next(distance)`, `prev(distance)`, `goRight()`, `goLeft()`, `setStyles(cssText)`, `getLocation()`, `search({ query })`, `close()`, `flow`, `book`, `renderer` (`index`, `page`, `pages`, `atStart`, `atEnd`, `size`, `start`, `viewSize`, `spread`, `columnCount`, `scrollTop`, `shadowRoot.getElementById('container')`, `getContents()`, `relayout()`, `render()`, `scrollBy()`, `scrollToAnchor()`, `next()`, `prev()`)

---

## 4. Mod 개발 및 수명주기 수칙

1. **코어 내부 비접근 & 스타일 경계 준수**
   * `_` 접두사 내부 필드/메서드에 의존하지 마세요.
   * `#ewb-core-layout-style`, `#ewb-theme-style` 및 `iframe` 외곽 박스 스타일(`top/left/width/height/clipPath`)을 직접 변조하지 마세요.
2. **2계층 리소스 정리 (엔진 vs 프레임)**
   * **엔진 수명주기 자원**(`onHook`, `onEvent`, 전역 타이머/상태): `setup(ctx)` 반환 `teardown()` 또는 `onDestroy`에서 해제합니다.
   * **프레임 수명주기 자원**(`doc` 리스너, `MutationObserver`, 프레임별 타이머): `triple` 슬롯 교체 시 원거리 프레임이 수시로 파기되므로 `onFrameDestroy`에서 `frame`/`doc` 단위로 즉시 정리합니다.
3. **비동기 유효성 및 프리로드(`isActive`) 가드**
   * `await`나 디바운스 타이머 콜백 실행 전 `frame.isDestroyed`, `doc.body?.isConnected`, `ctx.getState() !== 'DESTROYED'`를 확인하세요.
   * `onFrameMount`와 `onFrameReady`는 백그라운드 프리로드 슬롯(`frame.isActive === false`)에서도 실행됩니다. 화면에 보이는 활성 챕터만 다루는 모드는 반드시 `if (!frame?.isActive) return;` 가드를 두세요.
4. **타 Mod API 지연 조회**
   * `ctx.registerApi()`로 등록된 타 모드의 API는 장착 순서에 의존하지 않도록 `setup(ctx)` 시점이 아니라 실제 훅/실행 시점에 `ctx.getApi('namespace')?.method?.()`로 조회하세요.
5. **오류 격리 범위 이해**
   * `HookBus`와 `EwbEngine`은 등록된 훅·이벤트·`setup`/`teardown` 예외를 포착해 타 모듈에 전파하지 않습니다. 단, 모드 내부에서 직접 등록한 `setTimeout` / `setInterval` / `requestAnimationFrame` 콜백은 자체 `try/catch`와 파괴 가드로 방어해야 합니다.
6. **독립 `EpubParser` 직접 생성 시 참고**
   * `onTransformHtml` 파이프라인은 `EwbEngine`의 `ChapterFrame` 마운트 흐름에서 `HookBus.runTransform`을 통해 동작합니다. `EpubParser`를 단독으로 사용할 때는 `HookBus`를 직접 주입하지 말고 파싱된 `section.loadHtml()` 결과를 직접 변환하세요.

---

## 5. API 호환성 및 전환 안내

별도 버전 번호 없이 공개 계약 기준의 유지·추가·전환 지침만 정리합니다.

| 구분 | 항목 | 내용 및 권장 전환 방법 |
| :--- | :--- | :--- |
| **기존 API 유지** | `EwbEngine` 기본 메서드 · 이벤트 · `HookBus` 기존 훅 | `open`, `goTo`, `nextPage`, `prevPage`, `setLayoutOptions`, `setUserCss`, `search`, `load`/`relocate` 이벤트 및 `behavior` 문자열 인자 계약 그대로 유지 |
| **신규 API 추가** | 입력 출처(`source`) 전파 계약 · `onNativeScrollEnd` 훅 | 이동·스크롤·재조판 메서드에 `{ source }` 전달 시 `EwbEngine` 로그와 `relocate` / `onRelocate` payload에 `trigger`와 함께 `source` 제공 (`goToPage`/`scrollToTarget`/`scrollByPixels`/`scrollByLines`는 기존 `behavior` 문자열 2번째 인자와 `{ behavior, source }` 객체 및 3번째 인자 `extraOptions` 모두 수용), `scrolled` 네이티브 스크롤 정착 시 `onNativeScrollEnd` 발행 (`HookBus` 총 12대 훅) |
| **신규 API 추가** | 부트스트랩 & 테마 & 계측 & CFI 유틸 API | `createEpubEngine({ mods })`, `autoResize` 옵션, `setTheme`/`getTheme`/`getThemeCss`, `getClippingMetrics`, `ctx.getLayoutSnapshot`, `ctx.measurePureBaseline`, `ctx.loadChapterHtml`, `ctx.getContainer`, `ctx.getState`, `ctx.unuse`, `ctx.listApis`, `compareCfiStart`/`isSameCfiStart` |
| **동작/권장 전환** | `setUserCss()` 내 색상 지정 ➔ `setTheme()` 분리 | 기존에는 `userCss`에 배경/글자색을 함께 넣었으나, `setTheme()`로 색상을 분리하면 폰트·문단 설정을 유지한 채 재조판 없이 0ms 테마 전환 가능 |
| **동작/권장 전환** | `ChapterFrame` 전환 트랜지션 제거 (`transition: 'none'`) | 기존 `opacity 140ms ease-out` 트랜지션을 제거하여 챕터 스왑 시에도 일반 페이지 넘김과 동일한 즉각(`0ms`) 전환으로 동작 |
| **동작/권장 전환** | `skipLeadingBlankLines` 기본값 | 생성자 기본값은 `false`이며, `scrolled` 페이지 이동 시 상단 2.5줄 이하 빈 여백 스킵이 필요하면 명시적으로 `skipLeadingBlankLines: true` 전달 |
| **동작/권장 전환** | `autoResize` 기본값 및 외부 뷰포트 연동 | 생성자 기본값은 `true`이며, 호스트 앱의 별도 뷰포트 안정화 매니저가 `setLayoutOptions()`를 호출하는 경우 `autoResize: false`로 설정해 중복 재조판 방지 |
| **호환/별칭** | `book.destroy()` vs `book.dispose()` | `EpubParser.parse()` 결과 객체의 공식 해제 메서드는 `book.dispose()`이며, `book.destroy()`는 하위 호환 별칭으로 유지 중 (`dispose()` 사용 권장) |
| **호환 브릿지** | `<ewb-compat-view>` (`FoliateCompatView`) | 기존 `foliate-view` 호출 코드 이관 시 임시 브릿지로 유지되며, 신규 기능 및 Mod 개발은 `EwbEngine` + `EngineContext` 직접 사용 권장 |