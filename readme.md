# EWB-JS (Modern HTML5 EPUB Web Engine)

표준 HTML5 DOM, CSS Multi-column, Shadow-free 독립 iframe 격리 및 3-슬롯(Triple Slot) 0ms 챕터 전환을 제공하는 모듈형 웹 EPUB 뷰어 코어 엔진입니다.

코어 엔진(`EwbEngine`)은 순수 파싱·조판·페이지/챕터 전환만 담당하며, 테마·단축키·번역·TTS·자동 스크롤·진단 같은 모든 애플리케이션 기능은 `HookBus`와 `EngineContext`를 통해 외부 플러그인(`Mod`)으로 조립해 사용합니다.

---

## 주요 특징

- **독립 iframe 격리 렌더링 (`ChapterFrame`)**: 각 챕터(Spine)를 독립 iframe으로 마운트해 챕터 간 CSS 오염을 막고 표준 EPUB CFI 무결성을 유지합니다.
- **단일 / 트리플 슬롯 전환 (`SlotController`)**: `slotMode: 'triple'`(현재 ± 1 챕터 유휴 사전 조판으로 0ms 전환)과 경량 `'single'` 모드를 생성자나 런타임에서 자유롭게 전환할 수 있습니다.
- **짝수 베이스라인 조판 & 한 줄 스냅 (`ViewportSnap`, `PaginatorLayout`)**:
  - `paginated` 모드: 1단/2단(`auto`, `single`, `double`) CSS Multi-column 조판 및 2단 마지막 페이지 홀수 컬럼 여백 보정
  - `scrolled` 모드: 가용 높이 기반 정수 줄 높이 스냅, 상단 소형 빈 줄 스킵(`skipLeadingBlankLines`), 하단 걸침 줄 `clip-path` 마스킹 및 정수배 End Spacer 마감
- **스타일·테마 3계층 분리**: 코어 레이아웃(`#ewb-core-layout-style`), 사용자 타이포그래피(`#ewb-user-style`), 색상 테마(`#ewb-theme-style`)가 분리되어 `setTheme()` 호출 시 재조판 없이 0ms 색상 전환이 가능합니다.
- **Mod/Plugin 확장 아키텍처 (`HookBus`, `EngineContext`)**: 11개 라이프사이클 훅(`priority` 정렬 및 인터셉트 지원)과 `registerApi()` / `getApi()` 공용 API 레지스트리를 제공합니다.
- **EPUB 2.0 / 3.0 표준 파싱 & 자동 GC (`ZipReader`, `EpubParser`, `ResourceResolver`)**: `fflate` 기반 ZIP 해제, `container.xml` → `OPF` → `Nav`/`NCX` 파싱, CSS `@import`/`url()` 재귀 Blob 치환 및 `destroy()` 시 일괄 `URL.revokeObjectURL()` 정리를 수행합니다.
- **표준 EPUB CFI 코덱 (`CfiCodec`)**: 단일 점 CFI, 2분할/3분할 범위 CFI 인코딩·디코딩 및 `[id]` 힌트 기반 DOM Range 복원을 지원합니다.
- **Foliate 호환 브릿지 (`FoliateCompatView`)**: 기존 `foliate-view` 호출 코드에서 점진적으로 전환할 수 있도록 `<ewb-compat-view>` Web Component 어댑터를 기본 내장합니다.

---

## 요구 사항 및 의존성

- **브라우저 환경**: ES Modules, `DOMParser`, `Blob`, `ResizeObserver`, CSS Multi-column을 지원하는 모던 브라우저
- **필수 외부 패키지**: `fflate` (ZIP 압축 해제용 — `ZipReader.js`에서 `unzip`, `unzipSync` 사용)

    npm install fflate

---

## 디렉터리 구조

    ewb-js/
    ├── index.js                  # 공식 공개 진입점 (createEpubEngine 포함)
    ├── API.md                    # 상세 API 및 플러그인 레퍼런스
    ├── README.md                 # 사용설명서
    ├── core/
    │   ├── EwbEngine.js          # 엔진 오케스트레이터 & 공개 API
    │   ├── SlotController.js     # single / triple 슬롯 및 0ms 챕터 전환
    │   ├── ChapterFrame.js       # 단일 챕터 iframe 수명주기 & 조판
    │   ├── HookBus.js            # 11대 라이프사이클 훅 중계소
    │   └── EngineContext.js      # Mod용 공식 API 집합소 & registerApi 레지스트리
    ├── layout/
    │   ├── PaginatorLayout.js    # 다단(paginated) & 세로(scrolled) 조판 엔진
    │   ├── ViewportSnap.js       # 짝수 줄높이 연산 및 가시 라인 스냅
    │   └── CfiCodec.js           # EPUB CFI 인코더 / 디코더 / Range 복원기
    ├── parser/
    │   ├── EpubParser.js         # EPUB 2.0 / 3.0 패키지 & 목차 파서
    │   ├── ResourceResolver.js   # Blob URL 해석 및 CSS @import/url() 치환
    │   └── ZipReader.js          # fflate 기반 ZIP 리더 (커스텀 unzip 주입 지원)
    ├── bridge/
    │   └── FoliateCompatView.js  # <ewb-compat-view> 호환 Web Component 어댑터
    └── utils/
        └── Logger.js             # 4대 컨텍스트 추적 로거 (EngineLogger)

---

## 빠른 시작

### 1. HTML 컨테이너 준비

마운트할 컨테이너 엘리먼트에 명시적인 너비와 높이를 지정합니다.

    <div id="viewer-host" style="width: 100vw; height: 100vh;"></div>

### 2. 기본 엔진 초기화 및 EPUB 열기

    import { EwbEngine } from './ewb-js/index.js';

    const engine = new EwbEngine({
        container: document.getElementById('viewer-host'),
        slotMode: 'triple',
        flow: 'paginated',
        pageSpread: 'auto',
        transition: 'instant',
        fontSize: 16,
        lineHeight: 1.5,
        margins: { top: 32, bottom: 32, left: 40, right: 40 },
        theme: {
            backgroundColor: '#ffffff',
            textColor: '#1a1a1a',
            linkColor: '#0066cc',
            selectionColor: '#b4d5fe'
        }
    });

    engine.on('relocate', ({ detail }) => {
        console.log(
            `챕터 ${detail.spineIndex + 1} | ${detail.page + 1}/${detail.totalPages}p | ${(detail.fraction * 100).toFixed(1)}%`
        );
    });

    // File, Blob, ArrayBuffer 또는 사전 파싱된 Book 객체 지원
    await engine.open(epubFile, { initialLocation: 0 });

### 3. 간편 팩토리(`createEpubEngine`)로 Mod 일괄 장착

    import { createEpubEngine } from './ewb-js/index.js';

    const engine = createEpubEngine({
        container: document.getElementById('viewer-host'),
        flow: 'scrolled',
        mods: [myNormalizerMod, myInputMod]
    });

    await engine.open(epubFile);

---

## 주요 생성자 옵션

- `container` (`HTMLElement`, 필수): 뷰어 iframe이 마운트될 DOM 컨테이너
- `slotMode` (`'triple' | 'single'`, 기본값 `'triple'`): 앞/뒤 챕터 사전 대기(`triple`) 또는 단일 슬롯(`single`)
- `flow` (`'paginated' | 'scrolled'`, 기본값 `'paginated'`): 가로 다단 또는 세로 스크롤
- `pageSpread` (`'auto' | 'single' | 'double'`, 기본값 `'auto'`): 가로 화면 다단 열 수 (`auto`는 600px 이상 가로화면에서 2단)
- `transition` (`'instant' | 'smooth'`, 기본값 `'instant'`): 페이지 이동 스크롤 방식
- `skipLeadingBlankLines` (`boolean`, 기본값 `true`): `scrolled` 모드 이동 시 상단 소형 빈 줄(2.5줄 이하) 자동 스킵
- `fontSize` (`number`, 기본값 `16`): 기본 글자 크기 (`px`)
- `lineHeight` (`number`, 기본값 `1.4`): 기본 줄간격 배수
- `margins` (`{ top, bottom, left, right }`, 기본값 `{ 40, 40, 48, 48 }`): 4방향 여백 (`px`)
- `columnGap` (`number`, 기본값 `40`): 다단 간격 (`px`)
- `backgroundColor` (`string`, 기본값 `'transparent'`): 기본 프레임·외곽 배경색
- `theme` (`Object | null`, 기본값 `null`): `{ backgroundColor, textColor, linkColor, selectionColor }`
- `userCss` (`string`, 기본값 `''`): 폰트 패밀리, 자간, 문단 간격 등 사용자 CSS
- `logger` (`EngineLogger | Object | null`, 기본값 `null`): `createLogger(...)` 인스턴스 또는 로거 설정
- `parser` / `cfiCodec`: 커스텀 EPUB 파서 또는 CFI 코덱 주입 (선택)

---

## 스타일 · 테마 · 여백 우선순위 규칙

`ChapterFrame`의 `<head>`에는 아래 3개 `<style>` 태그가 순서대로 주입됩니다.

1. `#ewb-core-layout-style`: `PaginatorLayout`의 `html`/`body` 조판 크기, 다단, `fontSize`/`lineHeight`
2. `#ewb-user-style`: `setUserCss(css)`로 주입하는 글꼴(`font-family`), 문단 간격, 자간, 들여쓰기
3. `#ewb-theme-style`: `setTheme(theme)`로 주입하는 `backgroundColor`, `textColor`, `linkColor`, `selectionColor`

### 권장 사용 패턴

- **글자 크기 및 줄간격 변경**: `engine.setLayoutOptions({ fontSize: 18, lineHeight: 1.6 })`를 사용하세요. `userCss` 안에 `body { font-size: ... !important; line-height: ... !important; }`를 넣으면 `#ewb-user-style`이 뒤쪽에 있어 `setLayoutOptions()` 변경을 덮어씁니다.
- **테마 변경**: `setUserCss()`를 다시 호출하지 말고 `engine.setTheme(...)`를 사용하세요. 폰트·문단 설정은 유지한 채 본문과 여백 배경색만 0ms로 즉시 전환됩니다.

---

## 주요 제어 API

### 페이지 · 챕터 · 위치 이동

    // 다음 / 이전 페이지 (챕터 경계 도달 시 다음/이전 챕터로 자동 전환)
    await engine.nextPage();
    await engine.prevPage();

    // 챕터 단위 이동 (기본값: 'start', 마지막 페이지 진입 시 'end')
    await engine.nextChapter({ position: 'start' });
    await engine.prevChapter({ position: 'end' });

    // 특정 위치 이동 (스파인 인덱스, EPUB CFI, href#id, { spineIndex, anchor })
    await engine.goTo(3);
    await engine.goTo('epubcfi(/6/8!/4/2/1:12)');
    await engine.goTo('Text/chapter2.xhtml#sec-1');

    // 현재 챕터 내 페이지 / 끝점 / 픽셀 / 줄 이동
    engine.goToPage(0, 'instant');
    engine.goToEnd();
    engine.scrollByPixels(120, 'instant');
    engine.scrollByLines(3, 'smooth');

### 레이아웃 · 여백 · 스타일 동적 변경

    engine.setLayoutOptions({
        flow: 'paginated',
        pageSpread: 'double',
        fontSize: 18,
        lineHeight: 1.6,
        margins: { top: 40, bottom: 40, left: 48, right: 48 }
    });

    engine.setTheme({
        backgroundColor: '#121212',
        textColor: '#e0e0e0',
        linkColor: '#60a5fa',
        selectionColor: '#1e3a8a'
    });

    engine.setUserCss('p { text-indent: 1em; margin-bottom: 12px; }');

### 본문 검색 · 위치 조회 · 자원 정리

    // 전체 도서 비동기 검색
    for await (const hit of engine.search('검색어')) {
        console.log(hit.spineIndex, hit.cfi, hit.excerpt);
    }

    // 현재 위치, 뷰포트 메트릭스, 잘림 실측치 조회
    const loc = engine.getCurrentLocation();
    const metrics = engine.getViewportMetrics();
    const clip = engine.getClippingMetrics();

    // 뷰어 종료 시 모든 슬롯·Mod·Blob URL·Observer 일괄 정리
    engine.destroy();

---

## 플러그인(Mod) 개발 가이드

코어 파일을 직접 수정하지 않고 `engine.use(mod)`를 통해 기능을 확장할 수 있습니다. 함수형 `(ctx) => teardown?` 또는 `{ name, setup(ctx), teardown? }` 형태를 지원합니다.

    const SampleMod = {
        name: 'sample-normalizer-mod',
        setup(ctx) {
            const offTransform = ctx.onHook('onTransformHtml', (html, meta) => {
                return html;
            }, { priority: 50 });

            const offReady = ctx.onHook('onFrameReady', ({ spineIndex, doc }) => {
                const firstLine = ctx.getFirstVisibleLine();
                console.log('준비 완료:', spineIndex, firstLine?.text);
            });

            ctx.registerApi('sample', {
                getStatus: () => ctx.getState()
            });

            return () => {
                offTransform();
                offReady();
            };
        }
    };

    engine.use(SampleMod);

### 제공되는 11대 라이프사이클 훅 (`HookBus`)

- `onAfterParse` (비동기 브로드캐스트): `{ book, engine }` — 파싱 완료 직후 1회
- `onTransformHtml` (비동기 순차 변환): `(html, { index, href, id }) => string` — HTML DOM 파싱 전 정제 파이프라인
- `onFrameMount` (비동기 브로드캐스트): `{ spineIndex, href, doc, frame }` — iframe DOM 획득 직후, 1차 조판 전
- `onFrameReady` (비동기 브로드캐스트): `{ spineIndex, href, doc, frame, pagination }` — 웹폰트·이미지·Spacer 완료 후
- `onBoundaryReached` (비동기 인터셉트): `{ direction, currentIndex, targetIndex, currentFrame }` — `{ handled: true }` 반환 시 기본 챕터 전환 중단
- `onLinkClick` (동기 인터셉트): `{ spineIndex, chapterHref, href, anchor, isExternal, event, doc, frame }` — 코어 기본 핸들러는 `priority: 999`
- `onRelocate` (동기 브로드캐스트): `{ ...location, trigger }` — 이동/재조판마다 실행
- `onRelayout` (동기 브로드캐스트): `{ spineIndex, metrics, layoutOptions }` — `relayout()` 직후 실행
- `onThemeChange` (동기 브로드캐스트): `{ theme, themeCss }` — `setTheme()` 호출 시 실행
- `onFrameDestroy` (동기 브로드캐스트): `{ spineIndex, href, doc, frame }` — 프레임 해제 직전 실행
- `onDestroy` (동기 브로드캐스트): `{ engine }` — `engine.destroy()` 호출 시 실행

---

## 로거(`EngineLogger`) 연동

외부 앱의 로깅 시스템(`debugManager` 등)을 코어 수정 없이 주입할 수 있습니다.

    import { EwbEngine, createLogger } from './ewb-js/index.js';

    const logger = createLogger({
        namespace: 'EWB',
        defaultChannel: 'ewb',
        adapter: myAppDebugManager,
        level: 'debug'
    });

    const engine = new EwbEngine({
        container: document.getElementById('viewer-host'),
        logger
    });

---

## Foliate 호환 브릿지 (`FoliateCompatView`)

기존 `foliate-view` 기반 앱에서 `open()`, `init()`, `goTo()`, `next()`, `prev()`, `search()`, `renderer.*` 인터페이스를 유지한 채 `EwbEngine`으로 전환하려면 `FoliateCompatView`를 사용합니다.

    import './ewb-js/bridge/FoliateCompatView.js';

    const view = document.createElement('ewb-compat-view');
    view.setAttribute('flow', 'paginated');
    document.getElementById('viewer-host').appendChild(view);

    view.addEventListener('relocate', (e) => {
        console.log(e.detail.cfi, e.detail.location);
    });

    await view.open(epubFile);
    await view.init({ lastLocation: 0 });

---

## 외부 리소스 및 라이선스 참고

- 본 엔진의 ZIP 아카이브 해제는 [`fflate`](https://github.com/101arrowz/fflate) (MIT License)에 의존합니다.
- 더 자세한 메서드 시그니처와 반환 스키마는 함께 포함된 `API.md`를 참고하세요.


---

## Acknowledgements

EWB-JS는 [Foliate.js](https://github.com/johnfactotum/foliate-js)를 기반으로 EPUB 뷰어를 개발하고 활용하는 과정에서 얻은 경험과 아이디어를 참고하여 구상되었습니다.

기존 Foliate.js 기반 뷰어를 개발하면서 확인한 렌더링 동작 방식과 확장 과정에서의 요구사항은 새로운 엔진을 설계하는 데 참고가 되었습니다.

EWB-JS의 핵심 아키텍처와 내부 구현은 별도로 설계하고 작성했으며, 기존 Foliate.js 기반 애플리케이션과의 점진적인 전환을 지원하기 위해 `FoliateCompatView` 호환 어댑터를 제공합니다.

Foliate.js 프로젝트와 기여자들에게 감사드립니다.

Foliate.js는 MIT License로 배포되는 별도의 오픈소스 프로젝트입니다.


---

---

## AI Development Disclosure

EWB-JS는 개발자의 아이디어와 요구사항을 바탕으로 AI 에이전트와 협업하여 개발한 프로젝트입니다.

AI는 사전에 정의된 개발 규칙과 프로젝트 운영 지침에 따라 아키텍처 설계, 코드 작성, 코드 분석, 오류 진단, 해결 방안 제시, 잠재적 위험 분석 및 테스트 등 개발 전반의 실질적인 작업을 담당했습니다.

개발자는 프로젝트의 목표와 개발 원칙을 정의하고, AI의 분석 결과와 수정 제안을 검토하여 주요 기술적 의사결정 및 변경 사항을 승인했습니다. 특히 사전 협의와 승인 없이는 기존 코드나 합의되지 않은 동작을 임의로 변경하지 않도록 승인 기반 개발 절차를 적용했습니다.

AI의 분석 및 구현 역량과 개발자의 기획·감독·의사결정을 결합한 AI 협업 개발 프로젝트입니다.

