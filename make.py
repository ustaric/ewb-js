import logging
import re
from pathlib import Path

# ==========================================
# 0. 표준 로깅 설정
# ==========================================
logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s: %(message)s",
    datefmt="%H:%M:%S"
)
logger = logging.getLogger(__name__)

# ==========================================
# 1. 프로젝트 상수 및 제외 대상 정의
# ==========================================
EXCLUDE_DIRS = {
    ".git", ".github", "node_modules", "dist", ".vscode", "__pycache__",
    "vendor", "tests", "rollup"
}
EXCLUDE_FILES = {
    "package-lock.json", "make.py", "파일안내.md", ".DS_Store", "eslint.config.js"
}

CATEGORY_ORDER = [
    "EntryPoint (공개 진입점)",
    "Core Engine (코어 오케스트레이터 · 슬롯 · 훅)",
    "Layout & CFI (조판 · 라인 스냅 · CFI 코덱)",
    "Parser & Resources (ZIP · EPUB 파서 · 리소스)",
    "Bridge Adapters (호환 브릿지)",
    "Utilities & Logging (로거 · 유틸리티)",
    "Docs & Config (문서 및 설정)"
]

API_TARGET_CATEGORIES = {
    "EntryPoint (공개 진입점)",
    "Core Engine (코어 오케스트레이터 · 슬롯 · 훅)",
    "Layout & CFI (조판 · 라인 스냅 · CFI 코덱)",
    "Parser & Resources (ZIP · EPUB 파서 · 리소스)",
    "Bridge Adapters (호환 브릿지)",
    "Utilities & Logging (로거 · 유틸리티)"
}

# ==========================================
# 2. 파일 분석 및 정밀 파싱 헬퍼
# ==========================================

def format_file_size(size_bytes):
    """바이트 크기를 읽기 쉬운 B, KB, MB 단위로 변환합니다."""
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    else:
        return f"{size_bytes / (1024 * 1024):.2f} MB"


def get_file_category(rel_path_str):
    """상대 경로를 기반으로 EWB-JS 모듈 카테고리를 분류합니다."""
    path_norm = rel_path_str.replace("\\", "/").lstrip("./")
    wrapped = f"/{path_norm}"

    if path_norm in {"index.js", "ewb-js/index.js"}:
        return "EntryPoint (공개 진입점)"
    elif "/core/" in wrapped:
        return "Core Engine (코어 오케스트레이터 · 슬롯 · 훅)"
    elif "/layout/" in wrapped:
        return "Layout & CFI (조판 · 라인 스냅 · CFI 코덱)"
    elif "/parser/" in wrapped:
        return "Parser & Resources (ZIP · EPUB 파서 · 리소스)"
    elif "/bridge/" in wrapped:
        return "Bridge Adapters (호환 브릿지)"
    elif "/utils/" in wrapped:
        return "Utilities & Logging (로거 · 유틸리티)"
    else:
        return "Docs & Config (문서 및 설정)"


def parse_doc_summary(content, rel_path_str):
    """JSDoc 최상단 주석 또는 Markdown 제목에서 핵심 역할 요약을 추출합니다."""
    if rel_path_str.endswith(".md"):
        for line in content.splitlines():
            stripped = line.strip()
            if stripped.startswith("#"):
                return stripped.lstrip("#").strip()
        return "프로젝트 기술 문서"

    if rel_path_str.endswith(".json"):
        return "패키지 및 프로젝트 설정"

    jsdoc_match = re.search(r'/\*\*([\s\S]*?)\*/', content)
    if not jsdoc_match:
        return "EWB-JS 보조 모듈"

    lines = jsdoc_match.group(1).splitlines()
    for line in lines:
        cleaned = re.sub(r'^\s*\*\s*(@module|@file|@author|@version|@param|@returns)?\s*', '', line).strip()
        if cleaned and not cleaned.startswith('-') and not cleaned.startswith('파일 경로:'):
            return cleaned

    return "EWB-JS 보조 모듈"


def parse_dependencies(content):
    """import 문을 분석하여 로컬 및 외부(fflate 등) 참조 목록을 추출합니다."""
    deps = set()
    import_matches = re.findall(r'''(?:import\s+.*?from\s+['"]|import\s+['"])(.*?)(?:['"])''', content)
    for imp in import_matches:
        if imp.startswith('.') or imp.startswith('/'):
            file_name = Path(imp).name
            if file_name and file_name.endswith('.js'):
                deps.add(file_name)
        else:
            deps.add(imp)
    return sorted(list(deps))


def parse_pure_export_functions(content):
    """해당 파일이 직접 export하는 클래스, 함수, 상태 상수를 추출합니다."""
    signatures = []

    # 1. export class
    for cls in re.findall(r'export\s+class\s+([a-zA-Z0-9_$]+)', content):
        signatures.append(f"class {cls}")

    # 2. export function / export async function
    for m in re.findall(r'export\s+(async\s+function\s+([a-zA-Z0-9_$]+)|function\s+([a-zA-Z0-9_$]+))', content):
        fn_name = m[1] or m[2]
        signatures.append(f"{fn_name}()")

    # 3. export const (상태 Enum 및 주요 상수)
    for c_name in re.findall(r'export\s+const\s+([a-zA-Z0-9_$]+)', content):
        signatures.append(c_name)

    # 4. index.js 등 재수출 중심 모듈 보완
    if not signatures:
        for block in re.findall(r'export\s*\{([^}]+)\}', content):
            for raw_item in block.split(','):
                name = raw_item.strip().split()[-1]
                if name:
                    signatures.append(name)

    seen = set()
    unique_sigs = []
    for s in signatures:
        if s not in seen:
            seen.add(s)
            unique_sigs.append(s)

    if len(unique_sigs) > 12:
        extra_count = len(unique_sigs) - 12
        return unique_sigs[:12] + [f"외 {extra_count}개"]

    return unique_sigs


# ==========================================
# 3. 마크다운 템플릿 생성 루틴
# ==========================================

def generate_header(root_dir_name):
    mermaid_block = "\n".join([
        "```mermaid",
        "graph TD",
        "    A[Host App / External UI] -->|createEpubEngine / new EwbEngine| B[index.js <br> 공개 진입점]",
        "    A -->|engine.use Mod| C[HookBus.js & EngineContext.js <br> 11대 훅 · API 집합소]",
        "    B --> D[EwbEngine.js <br> 코어 오케스트레이터]",
        "    D -->|EPUB 파싱| E[EpubParser.js <br> ZipReader · ResourceResolver]",
        "    D -->|single / triple 슬롯| F[SlotController.js <br> 0ms 챕터 전환]",
        "    F -->|독립 iframe 수명주기| G[ChapterFrame.js]",
        "    G -->|다단 · 세로 스냅| H[PaginatorLayout.js & ViewportSnap.js]",
        "    D <-->|좌표 인코딩/복원| I[CfiCodec.js]",
        "    J[FoliateCompatView.js <br> 선택적 호환 브릿지] -.->|어댑터 래핑| D",
        "```"
    ])

    return (
        "# 📄 EWB-JS (Modern HTML5 EPUB Web Engine) - 기술 사양 및 파일 안내서\n"
        f"> **기준 경로**: `{root_dir_name}` | **구조**: Modular Core + Plugin(Mod) Specs\n\n"
        "> **[🤖 AI Context Instructions]**\n"
        "> - **Architecture**: `Host App` -> `index.js` -> `EwbEngine.js` -> `SlotController.js` / `ChapterFrame.js` -> `PaginatorLayout.js` / `ViewportSnap.js` / `CfiCodec.js`\n"
        "> - **Core Immutability**: 코어(`core/`, `layout/`, `parser/`, `bridge/`, `utils/`, `index.js`)를 직접 개조하지 않고 `engine.use(mod)` + `HookBus` + `EngineContext.registerApi()`로 기능을 확장합니다.\n"
        "> - **Style Priority**: `#ewb-core-layout-style` -> `#ewb-user-style` -> `#ewb-theme-style` 순서를 유지합니다.\n\n"
        "---\n"
        "## 🛠 1. EWB-JS 아키텍처 흐름\n"
        f"{mermaid_block}\n\n"
        "---\n"
        "## 📁 2. 파일 카탈로그 요약\n"
    )


# ==========================================
# 4. 메인 실행 진입점 (Main Routine)
# ==========================================

def main():
    current_work_dir = Path.cwd().resolve()
    logger.info(f"🚀 [make.py] EWB-JS 파일 안내서 생성 시작: {current_work_dir}")

    file_entries = []

    for path in current_work_dir.rglob("*"):
        if not path.is_file():
            continue

        if any(ex in path.parts for ex in EXCLUDE_DIRS):
            continue
        if path.name in EXCLUDE_FILES:
            continue

        if path.suffix not in {".js", ".md", ".json", ".html", ".css", ".ts", ".tsx"}:
            continue

        rel_path = path.relative_to(current_work_dir)
        rel_path_str = rel_path.as_posix()

        try:
            content = path.read_text(encoding="utf-8", errors="ignore")
            lines_count = len(content.splitlines())
            file_size_str = format_file_size(path.stat().st_size)
        except Exception as e:
            logger.warning(f"파일 읽기 오류 ({rel_path_str}): {e}")
            continue

        summary = parse_doc_summary(content, rel_path_str)
        category = get_file_category(rel_path_str)
        deps = parse_dependencies(content) if rel_path_str.endswith(".js") else []
        signatures = parse_pure_export_functions(content) if rel_path_str.endswith(".js") else []

        file_entries.append({
            "name": path.name,
            "path": rel_path_str,
            "lines": lines_count,
            "size": file_size_str,
            "category": category,
            "summary": summary,
            "deps": deps,
            "signatures": signatures
        })

    logger.info(f"분석 완료: 총 {len(file_entries)}개 파일. 문서 생성 중...")

    md_lines = [generate_header(current_work_dir.name)]

    categorized = {cat: [] for cat in CATEGORY_ORDER}
    for entry in file_entries:
        cat = entry["category"]
        if cat not in categorized:
            categorized[cat] = []
        categorized[cat].append(entry)

    # 섹션 2: 파일 카탈로그 요약 표
    for cat_name in CATEGORY_ORDER:
        entries = categorized.get(cat_name, [])
        if not entries:
            continue

        md_lines.append(f"### 🖥️ {cat_name}")
        md_lines.append("| 파일명 | 파일 경로 | 라인 | 용량 | 역할 요약 |")
        md_lines.append("| :--- | :--- | :---: | :---: | :--- |")

        for item in sorted(entries, key=lambda x: x["name"].lower()):
            md_lines.append(
                f"| **`{item['name']}`** | `{item['path']}` | {item['lines']} | {item['size']} | {item['summary']} |"
            )

        md_lines.append("\n")

    # 섹션 3: 핵심 모듈 공개 인터페이스 (Public APIs)
    md_lines.append("---\n## 🧩 3. 핵심 모듈 공개 인터페이스 (Public APIs)\n")
    md_lines.append("> *EWB-JS 모듈별 의존성 및 Export 인터페이스 명세입니다.*\n")

    target_api_entries = [
        e for e in file_entries
        if e["category"] in API_TARGET_CATEGORIES and e["path"].endswith(".js")
    ]

    for item in sorted(target_api_entries, key=lambda x: x["path"].lower()):
        if not item["deps"] and not item["signatures"]:
            continue

        md_lines.append(f"#### 📄 `{item['path']}`")
        if item["deps"]:
            deps_str = ", ".join([f"`{d}`" for d in item["deps"]])
            md_lines.append(f"- **참조 (Dependencies)**: {deps_str}")
        if item["signatures"]:
            sigs_str = ", ".join([f"`{s}`" for s in item["signatures"]])
            md_lines.append(f"- **핵심 API (Exports)**: {sigs_str}")
        md_lines.append("")

    output_path = current_work_dir / "파일안내.md"
    output_path.write_text("\n".join(md_lines), encoding="utf-8")

    final_output_size = format_file_size(output_path.stat().st_size)
    logger.info(f"🎉 [성공] EWB-JS 파일 안내서 생성 완료: {output_path} (크기: {final_output_size})")


if __name__ == "__main__":
    main()