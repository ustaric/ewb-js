# EWB-JS API & Plugin Guide

> **HTML5 표준 EPUB 웹 뷰어 코어 엔진(`ewb-js`) 공식 API 및 플러그인(Mod) 레퍼런스**

---

## 🚨 제1원칙: `ewb-js/` 폴더 수정 금지 및 플러그인 확장 원칙 (Mandatory Policy)

1. **`ewb-js/` 코어 직접 수정 금지**: `ewb-js/` 폴더 내부 파일(`core/`, `layout/`, `parser/`, `bridge/`, `utils/`, `index.js`)은 직접 수정하지 않는다.
2. **플러그인(Mod) 기반 기능 확장**: 기본 뷰어 렌더링·조판·슬롯 전환 외의 모든 기능(터치/키보드/휠/게임패드 입력 제어, 빈 줄 정제, 테마 프리셋, TTS, 인라인 번역, 북마크, 형광펜 하이라이트, 푸터바/HUD UI, 진단 계측 등)은 반드시 외부에서 `engine.use(mod)`를 통해 `HookBus` 훅과 `EngineContext` 공개 API를 조합해 구현한다.
3. **API 집합소 우선 활용**: 코어에 없는 기능이 필요할 때도 코어 내부 상태를 직접 참조하거나 패치하지 말고, `EngineContext.registerApi(namespace, apiObject)` 및 `getApi(namespace)` 레지스트리를 통해 플러그인 간 공용 인터페이스로 확장한다.

---

## 1. 아키텍처 개요

`ewb-js`는 순수 뷰어 렌더링과 조판을 담당하는 코어(`EwbEngine`) 위에, 이벤트·라이프사이클 훅(`HookBus`)과 API 집합소(`EngineContext`)를 통해 외부 기능(테마, 터치/키보드/휠, TTS, 번역, 북마크, 빈 줄 정제 등)을 모듈형 플러그인(`Mod`)으로 조립하는 구조입니다.

    Host App / Custom UI
      ├── EwbEngine (엔진 오케스트레이터 & 공개 API)
      │     ├── SlotController (single / triple 챕터 슬롯 & 0ms 전환)
      │     │     └── ChapterFrame (독립 iframe · PaginatorLayout · ViewportSnap)
      │     ├── HookBus (11대 라이프사이클 훅 중계소)
      │     └── EngineContext (Mod 전용 공식 API 집합소 + registerApi 레지스트리)
      └── engine.use(mod) / engine.unuse(mod) / createEpubEngine({ mods, ... })

---

## 2. 빠른 시작

    import { EwbEngine, createEpubEngine, createLogger } from './ewb-js/index.js';

    const engine = new EwbEngine({
        container: document.getElementById('viewer-host'),
        slotMode: 'triple',
        flow: 'paginated',
        pageSpread: 'auto',
        transition: 'instant',
        fontSize: 16,
        lineHeight: 1.5,
        margins: { top: 24, bottom: 24, left: 28, right: 28 },
        theme: {
            backgroundColor: '#ffffff',
            textColor: '#1f2937',
            linkColor: '#2563eb'
        }
    });

    // 또는 mods 배열을 포함한 원라인 팩토리 사용
    // const engine = createEpubEngine({ container, mods: [MyMod], ...options });

    engine.on('relocate', ({ detail }) => {
        console.log(detail.spineIndex, detail.page + 1, detail.totalPages, detail.cfi);
    });

    await engine.open(epubFile, { initialLocation: 0 });

---

## 3. 생성자 옵션 (`new EwbEngine(options)`)

| 옵션 | 타입 | 기본값 | 설명 |
| :--- | :--- | :--- | :--- |
| `container` | `HTMLElement` | **(필수)** | 뷰어 iframe들이 마운트될 컨테이너 엘리먼트 |
| `slotMode` | `'triple' \| 'single'` | `'triple'` | 3챕터 사전 대기(`triple`) 또는 단일 슬롯(`single`) |
| `flow` | `'paginated' \| 'scrolled'` | `'paginated'` | 가로 다단(`paginated`) / 세로 스크롤(`scrolled`) |
| `pageSpread` | `'auto' \| 'single' \| 'double'` | `'auto'` | 가로 다단 열 수 (`auto`는 600px 이상 가로화면 2단) |
| `transition` | `'instant' \| 'smooth'` | `'instant'` | 페이지 이동 스크롤 애니메이션 모드 |
| `skipLeadingBlankLines` | `boolean` | `true` | `scrolled` 페이지 이동 시 상단 소형 빈 줄(2.5줄 이하) 스킵 여부 |
| `fontSize` | `number` | `16` | 본문 기본 글자 크기 (`px`) |
| `lineHeight` | `number` | `1.4` | 본문 기본 줄간격 배수 |
| `margins` | `{ top, bottom, left, right }` | `{ 40, 40, 48, 48 }` | 4방향 외부 여백 (`px`, `marginTop` 등 플랫 키도 지원) |
| `columnGap` | `number` | `40` | 다단 간격 (`px`) |
| `backgroundColor` | `string` | `'transparent'` | 기본 외곽/프레임 배경색 |
| `theme` | `ThemeObject \| null` | `null` | 초기 색상 테마 (`backgroundColor`, `textColor`, `linkColor`, `selectionColor`) |
| `userCss` | `string` | `''` | 사용자 폰트·문단 간격 등 커스텀 CSS |
| `logger` | `Object \| null` | `null` | `createLogger(...)` 인스턴스 또는 옵션 객체 (`{ adapter, defaultChannel, level, enabled, namespace, channelMode, historyLimit }` 지원) |
| `parser` | `Object \| null` | `EpubParser` | 커스텀 파서 주입 (선택) |
| `cfiCodec` | `Object \| null` | `CfiCodec` | 커스텀 CFI 코덱 주입 (선택) |

---

## 4. 스타일·테마·여백 우선순위 규약 (중요)

`ChapterFrame`의 `<head>`에는 아래 3개 `<style>` 계층이 순서대로 주입됩니다.

1. `#ewb-core-layout-style` (`PaginatorLayout`): `html`/`body` 조판 규격 및 `layoutOptions.fontSize` / `layoutOptions.lineHeight` (`!important`)
2. `#ewb-user-style` (`setUserCss`): 폰트 패밀리(`font-family`), 문단 여백(`p { margin }`), 들여쓰기 등
3. `#ewb-theme-style` (`setTheme`): 배경색(`backgroundColor`), 글자색(`textColor`), 링크색(`linkColor`), 선택색(`selectionColor`)

### 권장 사용 패턴
* **글자 크기·줄간격**: `setLayoutOptions({ fontSize: 18, lineHeight: 1.6 })`로 제어하세요. `userCss` 안에 `body { font-size: ... !important; line-height: ... !important; }`를 넣으면 `#ewb-user-style`이 뒤쪽에 있어 `setLayoutOptions` 변경을 덮어씁니다.
* **테마(다크/세피아/AMOLED 등)**: `setUserCss()` 대신 **`setTheme(...)`를 사용**하세요. `userCss`의 폰트·문단 설정은 보존한 채 4방향 여백(`container`)과 본문 색상만 0ms로 즉시 전환됩니다.

---

## 5. `EwbEngine` 공개 메서드

### 5.1 라이프사이클 & 플러그인
* `createEpubEngine({ container, mods = [], ...engineOptions })`: 엔진 생성과 동시에 초기 `mods` 배열을 일괄 장착하는 팩토리 함수 (`ewb-js/index.js` 공개 export).
* `await engine.open(source, { initialLocation = 0, autoMount = true })`: EPUB `File`/`Blob`/`ArrayBuffer` 또는 파싱된 `Book` 객체를 엽니다.
* `engine.use(mod)`: 함수형 `(ctx) => teardown?` 또는 객체형 `{ name, setup(ctx), teardown? }` 플러그인을 장착합니다. (`async setup` 및 중복 설치 방지 지원)
* `engine.unuse(modOrName)`: 특정 플러그인을 이름 또는 참조로 즉시 해제합니다.
* `engine.destroy()`: 모든 슬롯, Mod, 외부 생성 프레임, Blob URL, `ResizeObserver`를 정리합니다.
* `engine.on(eventName, listener)` / `engine.off(eventName, listener)`: 표준 이벤트 구독·해제 (`on`은 구독 해제 함수 반환).

### 5.2 페이지·챕터·스크롤 이동
* `await engine.goTo(target, { behavior = 'instant' })`: `spineIndex`(숫자), `epubcfi(...)`(단일/2분할/3분할), `href#id`, `{ spineIndex, anchor }`로 이동.
* `await engine.nextPage(options)` / `await engine.prevPage(options)`: 페이지 이동 (경계 도달 시 다음 챕터 `'start'` / 이전 챕터 `'end'`로 자동 전환).
* `await engine.nextChapter({ position = 'start' })` / `await engine.prevChapter({ position = 'start' })`: 챕터 단위 이동 (기본값 첫 페이지 `'start'`).
* `engine.goToPage(pageIndex, behavior)`: 현재 챕터 내 0-based 페이지 이동 + `relocate` 발행.
* `engine.goToEnd()`: 현재 챕터 마지막 페이지 이동(`scrolled` 시 상단 잘림 스냅 포함) + `relocate` 발행.
* `engine.scrollToTarget(rangeOrEl, behavior)`: DOM `Range`/`Element` 위치로 이동 + `relocate` 발행.
* `engine.scrollByPixels(deltaPx, behavior)`: 연속 픽셀 스크롤(마우스 휠/자동 스크롤용, `scrolled` 하단 마스킹 일시 해제).
* `engine.scrollByLines(lineCount, behavior)`: 현재 `exactLineHeightPx` 기준 줄 단위 스크롤.

### 5.3 레이아웃·여백·테마·스타일
* `engine.setLayoutOptions(partialOptions)`: `slotMode`, `flow`, `pageSpread`, `transition`, `skipLeadingBlankLines`, `fontSize`, `lineHeight`, `margins` (`{ top, bottom, left, right }`), `columnGap`, `backgroundColor` 갱신 및 위치 보존 재조판.
* `engine.getLayoutOptions()`: 현재 유효 레이아웃 옵션 스냅샷 반환.
* `engine.getMargins()`: `{ top, bottom, left, right }` 반환.
* `engine.setTheme(theme | null)`: `{ backgroundColor, textColor, linkColor, selectionColor }` 적용 (`null` 또는 `{}` 시 해제).
* `engine.getTheme()` / `engine.getThemeCss()`: 현재 테마 객체 / 생성된 테마 CSS 반환.
* `engine.setUserCss(cssText)` / `engine.getUserCss()`: 사용자 CSS 갱신(+활성 시 재조판) / 조회.
* `engine.relayout()`: 현재 첫 줄 위치를 앵커로 보존하며 활성·대기 슬롯 재조판.

### 5.4 조회·검색·CFI·계측
* `engine.getContainer()`: 마운트 컨테이너 `HTMLElement` 반환.
* `engine.getBookMeta()` / `engine.getToc()` / `engine.getSections()`
* `await engine.loadChapterHtml(spineIndex)`: 리소스 해석 완료 HTML 문자열 반환.
* `engine.getCurrentLocation()`: 현재 위치 스냅샷 반환.
* `engine.getViewportMetrics()`: 조판 메트릭스(`usableWidth`, `usableHeight`, `pageHeight`, `contentWidth`, `columnCount`, `columnWidth`, `columnGap`, `paddingTop/Bottom/Left/Right`, `exactLineHeightPx`, `fullLineCount`) 반환.
* `engine.getClippingMetrics()`: 현재 화면 잘림 및 라인·문단 실측치 반환 (`topCutPx`, `rawBottomCutPx`, `maskedBottomPx`, `visibleBottomCutPx`, `topClippedCount`, `bottomClippedCount`, `visibleLineCount`, `fullLineCount`, `paragraphCount`, `topClippedText`, `bottomClippedText`, `pageHeight`).
* `engine.getCurrentFrame()` / `engine.getFrames()` / `engine.forEachFrame(cb)` / `engine.getActiveDocument()`
* `engine.encodeCfi(spineIndex, range, doc)` / `engine.decodeCfi(cfiString)` / `engine.resolveCfi(cfiString, doc, { collapseToStart = true })`
* `for await (const hit of engine.search(query))`: 전체 책 본문 비동기 검색 제너레이터 (`{ spineIndex, cfi, excerpt }`).

---

## 6. 표준 이벤트 (`engine.on`)

| 이벤트명 | `detail` Payload |
| :--- | :--- |
| `'load'` | `{ spineIndex, doc, frame }` |
| `'relocate'` | `{ spineIndex, href, tocItem, page, totalPages, atStart, atEnd, fraction, cfi, firstLine, lastLine, trigger }` |
| `'chapterChange'` | `{ spineIndex, direction, frame }` |
| `'stateChange'` | `{ prev, next }` (`IDLE` \| `OPENING` \| `READY` \| `ACTIVE` \| `DESTROYED`) |

---

## 7. 플러그인(`Mod`) 개발 & `EngineContext` · 11대 훅

### 7.1 Mod 예시 (테마 프리셋 플러그인)

    export const DarkThemeMod = {
        name: 'dark-theme-mod',
        setup(ctx) {
            ctx.setTheme({
                backgroundColor: '#121212',
                textColor: '#e5e7eb',
                linkColor: '#93c5fd',
                selectionColor: '#1d4ed8'
            });
            ctx.registerApi('themePreset', {
                applyDark: () => ctx.setTheme({ backgroundColor: '#121212', textColor: '#e5e7eb' }),
                clear: () => ctx.setTheme(null)
            });
            return () => ctx.setTheme(null);
        }
    };

    engine.use(DarkThemeMod);

### 7.2 `EngineContext` 추가 제공 API
`EwbEngine`의 네비게이션·레이아웃·테마·CFI·검색·프레임·계측 API 외에 Mod 전용 메서드가 추가 제공됩니다:
* `ctx.onHook(hookName, handler, { priority = 100, once = false, name })` / `ctx.offHook(hookName, handler)`
* `ctx.onEvent(eventName, listener)` / `ctx.offEvent(eventName, listener)` / `ctx.unuse(modOrName)`
* `ctx.registerApi(namespace, apiObject)` / `ctx.getApi(namespace)` / `ctx.listApis()`
* `ctx.getState()`
* `ctx.getVisibleLines(options)` / `ctx.getFirstVisibleLine(options)` / `ctx.getLastVisibleLine(options)`
* `ctx.getLayoutSnapshot(frame = ctx.getCurrentFrame(), { forceCapture = false })`: 지정 프레임의 순수 조판·스타일·물리 치수 스냅샷 `{ initial, last }` 읽기 전용 복사본 반환 (`ewb` 로거 비활성 상태에서도 즉시 실측 가능)
* `await ctx.measurePureBaseline(spineIndex, pureLayoutOptions = {})`: `HookBus`(플러그인)·`userCss`·`themeCss`를 전혀 개입시키지 않은 순수 코어 기준 프레임(`isBaseline: true`)을 백그라운드에서 1회 실측 후 즉시 파기해 `{ spineIndex, snapshot, metrics, clipping, viewportMetrics, layoutOptions }` 반환
* `ctx.createChapterFrame(spineIndex)`: 독립 프레임 생성 (엔진이 추적해 `engine.destroy()` 시 자동 정리)
* `ctx.createLogger(scopeName)`

> **참고 (`ChapterFrame` 읽기 전용 계측 메서드)**: `ctx.getCurrentFrame()` 또는 `onFrameReady`의 `frame` 객체에서는 `frame.isActive`, `frame.isDestroyed`, `frame.isBaseline`, `frame.getMetrics()`, `frame.getClippingMetrics()`, `frame.getLayoutSnapshot({ forceCapture })`, `frame.getVisibleLines(options)`, `frame.getFirstVisibleLine(options)`, `frame.getLastVisibleLine(options)`를 직접 조회할 수 있습니다.

### 7.3 라이프사이클 훅 (`HookBus`)

| 훅 이름 | 실행 방식 | 전달 Payload | 비고 |
| :--- | :--- | :--- | :--- |
| `onAfterParse` | 비동기 브로드캐스트 | `{ book, engine }` | 파싱 직후 1회 |
| `onTransformHtml` | 비동기 순차 변환 | `(html, { spineIndex, href, frame }) => string` | 조판 전 HTML 정제/빈 줄 압축 Mod 연결점 |
| `onFrameMount` | 비동기 브로드캐스트 | `{ spineIndex, href, doc, frame }` | DOM 획득 직후, 1차 조판 전 |
| `onFrameReady` | 비동기 브로드캐스트 | `{ spineIndex, href, doc, frame, pagination }` | 폰트·이미지·Spacer 완료 후 |
| `onBoundaryReached` | 비동기 인터셉트 | `{ direction, currentIndex, targetIndex, currentFrame }` | `{ handled: true }` 반환 시 기본 챕터 전환 중단 |
| `onLinkClick` | 동기 인터셉트 | `{ spineIndex, chapterHref, href, anchor, isExternal, event, doc, frame }` | 코어 기본 핸들러는 `priority: 999` (`priority < 999`로 가로채기 가능) |
| `onRelocate` | 동기 브로드캐스트 | `{ ...location, trigger }` | 위치 이동/재조판마다 실행 |
| `onRelayout` | 동기 브로드캐스트 | `{ spineIndex, metrics, layoutOptions }` | `relayout()` 직후 실행 |
| `onThemeChange` | 동기 브로드캐스트 | `{ theme, themeCss }` | `setTheme()` 호출 시 실행 |
| `onFrameDestroy` | 동기 브로드캐스트 | `{ spineIndex, href, doc, frame }` | 슬롯 프레임 해제 직전 실행 |
| `onDestroy` | 동기 브로드캐스트 | `{ engine }` | `engine.destroy()` 시 실행 |

### 7.4 플러그인(Mod) 작성 필수 수칙 (안정성·수명주기·정리 규약)
1. **오류 격리 보장**: `HookBus`(`emitSync`, `emitAsync`, `runTransform`)와 `EwbEngine`(`use`, `unuse`, `_emit`, `destroy`)는 개별 핸들러·리스너 예외를 내부에서 포착해 타 Mod 및 코어 실행을 중단시키지 않습니다. 단, 플러그인 내부에서 직접 등록한 `setTimeout` / `setInterval` / `RAF` 콜백은 자체 가드로 방어해야 합니다.
2. **2계층 리소스 정리**:
   * **엔진 수명주기 자원**(`onHook`, `onEvent`, 전역 타이머/상태): `setup(ctx)`가 반환하는 `teardown()` 함수 및 `onDestroy` 훅에서 해제합니다.
   * **프레임 수명주기 자원**(`doc` 이벤트 리스너, `Observer`, 프레임별 타이머): `triple` 슬롯 교체 시 원거리 프레임이 수시로 파기되므로 반드시 `onFrameDestroy`에서 `frame`/`doc` 단위로 즉시 정리합니다(`WeakMap<Document, AbortController>` 등 권장).
3. **비동기 유효성 및 활성 슬롯 검증**:
   * `await`나 디바운스 타이머 후 DOM 또는 엔진을 조작하기 전 `frame.isDestroyed`, `doc.body?.isConnected`, `ctx.getState() !== 'DESTROYED'`를 확인합니다.
   * `onFrameReady`는 백그라운드 프리로드 슬롯(`active=false`)에서도 발행되므로, 현재 화면에 보이는 활성 챕터만 대상으로 동작해야 하는 Mod(예: 진단 리포트)는 반드시 `frame?.isActive`를 검사해야 합니다.
4. **타 Mod API 지연 조회**: 다른 플러그인이 `registerApi()`로 등록한 공용 인터페이스는 장착 순서 의존성을 피하기 위해 `setup(ctx)` 시점이 아니라 훅/실행 시점에 `ctx.getApi(namespace)?.method?.()` 형태로 조회합니다.
5. **코어 소유권 경계 준수**: 코어 내부 `_` 접두사 필드·메서드를 직접 참조하지 않으며, `#ewb-core-layout-style`·`#ewb-theme-style` 및 `iframe` 외곽 박스 스타일(`top/left/width/height/clipPath`)을 직접 변조하지 않습니다.

---

## 8. 푸터바 / 헤더바 레이아웃 연동 가이드

1. **Flex / Grid 형제 배치 (권장 — 자동 영역 조절)**
   * 뷰어 컨테이너 바깥에 Flex/Grid 형제 요소로 헤더바/푸터바를 배치하면, 바를 켜거나 높이를 변경할 때 `container` 크기가 달라지고 `EwbEngine`의 `ResizeObserver`가 150ms 디바운스 후 자동으로 `relayout()`을 수행합니다.
2. **플로팅 오버레이 배치 (`position: absolute` / `fixed`)**
   * `ctx.getContainer()` 위에 겹쳐 띄우는 플로팅 바는 `container` 크기를 바꾸지 않으므로, 바의 높이만큼 `setLayoutOptions({ margins: { bottom: 기본여백 + footerHeight } })`로 여백을 조절하세요.

---

## 9. 변경 이력 (Changelog)

* **2026-11 (순수 조판 스냅샷·Baseline 비교 API & 추적 리포터 & `scrolled` 경계 정밀화)**
  * **`EngineContext` 순수 관측 & Baseline 비교 API 신설**: `ctx.getLayoutSnapshot(frame, { forceCapture })`로 로거 비활성 상태에서도 조판 스냅샷(`initial` / `last`)을 조회할 수 있으며, `ctx.measurePureBaseline(spineIndex, pureLayoutOptions)`로 훅·`userCss`·`themeCss` 개입 없는 순수 기준 프레임(`isBaseline: true`)을 백그라운드 실측·파기해 비교 기준 데이터를 제공.
  * **조판 스냅샷 리포터(`LayoutTraceReporter`) 및 로거 그룹 제어**: 마운트·재조판 중 `PaginatorLayout` 로그를 버퍼링해 활성 프레임은 요약 + 펼친 `group` + 접힌 중간 로그로, 프리로드 프레임(`active=false`)은 단일 `groupCollapsed`로 동기 출력. `EngineLogger`에 `isDebugEnabled()`, `groupCollapsed()`, `trace()` 다형성 가드 추가.
  * **`PaginatorLayout` 본문 끝 실측 & 상단 스냅 보강**: `_measureActualContentBottom()` 실측으로 `scrolled` 꼬리 공백 유령 빈 페이지 차단(`ghost_page_blocked`), `goToEnd()` 상단 걸침 줄 스냅(`goToEndSnap`), `nextPage()` 0px 정체 방지(`zero_move_guard`) 및 `_emitRelocate()`의 `pageView` 정밀 추적 로그 통합.
  * **호스트 로거 채널 연동 & `SlotController` 추적**: `new EwbEngine({ logger: { adapter: debugManager, defaultChannel: 'ewb' } })` 채널 연동 및 `SlotController` 유휴 프리로드/슬롯 승격 `trace` 로그 탑재.
  * **문서 보강**: `createEpubEngine` 팩토리, `getClippingMetrics()` 전체 필드, `EngineContext` 신규 API, `7.4 플러그인(Mod) 작성 필수 수칙` 반영.