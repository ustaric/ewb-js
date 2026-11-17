/**
 * 📖 EWB 엔진 표준 EPUB 2.0 / 3.0 패키지 파서 (EpubParser)
 * - 🔍 [전체 규격 지원] container.xml ➔ OPF(Metadata/Manifest/Spine/Guide) ➔ EPUB3 Nav & EPUB2 NCX 파싱
 * - 🛡️ [비표준 내구성] localName 기반 XML 탐색, <parsererror> 시 text/html 자동 폴백, Font Obfuscation 구별
 * - ⚡ [공유 도서 모델] 여러 ChapterFrame/슬롯이 동일 파싱 결과(EpubBook)를 중복 압축 해제 없이 공유 가능
 * 파일 경로: web/ewb-js/parser/EpubParser.js
 * @module ewb-js/parser/EpubParser
 */

import { ZipReader, normalizeZipPath, resolveRelativeZipPath } from './ZipReader.js';
import { ResourceResolver } from './ResourceResolver.js';

const FONT_OBFUSCATION_URIS = [
    'http://www.idpf.org/2008/embedding',
    'http://ns.adobe.com/pdf/enc#RC'
];

/**
 * localName 기준으로 요소 내 모든 자손 엘리먼트를 안전하게 찾습니다. (XML 접두사 무관)
 * @param {Document|Element} root
 * @param {string} targetLocalName
 * @returns {Element[]}
 */
function findByLocalName(root, targetLocalName) {
    if (!root) return [];
    const target = targetLocalName.toLowerCase();
    const all = root.getElementsByTagName('*');
    const matched = [];
    for (let i = 0; i < all.length; i++) {
        const el = all[i];
        const name = (el.localName || el.tagName || '').split(':').pop().toLowerCase();
        if (name === target) matched.push(el);
    }
    return matched;
}

/**
 * 직계 자식 중 localName이 일치하는 요소들을 반환합니다.
 * @param {Element} parent
 * @param {string} targetLocalName
 * @returns {Element[]}
 */
function findDirectChildrenByLocalName(parent, targetLocalName) {
    if (!parent || !parent.children) return [];
    const target = targetLocalName.toLowerCase();
    const result = [];
    for (let i = 0; i < parent.children.length; i++) {
        const child = parent.children[i];
        const name = (child.localName || child.tagName || '').split(':').pop().toLowerCase();
        if (name === target) result.push(child);
    }
    return result;
}

/**
 * XML/XHTML 문자열을 안전하게 Document로 파싱합니다.
 * @param {string} text
 * @param {'application/xml'|'application/xhtml+xml'|'text/html'} [preferredType='application/xml']
 * @returns {Document}
 */
function parseXmlOrHtml(text, preferredType = 'application/xml') {
    const parser = new DOMParser();
    const doc = parser.parseFromString(text || '', preferredType);
    const hasParseError = doc.getElementsByTagName('parsererror').length > 0;
    if (hasParseError) {
        return parser.parseFromString(text || '', 'text/html');
    }
    return doc;
}

/**
 * EPUB 패키지 파서 클래스
 */
export class EpubParser {
    /**
     * @param {Object} [options={}]
     * @param {Object|null} [options.logger=null] - EngineLogger 인스턴스
     * @param {import('../core/HookBus.js').HookBus|null} [options.hookBus=null] - transformHtml 등 훅 실행용
     * @param {Function|null} [options.customUnzip=null] - ZipReader 커스텀 압축 해제 함수
     */
    constructor(options = {}) {
        this.logger = options.logger || null;
        this._log = options.logger?.child ? options.logger.child('EpubParser') : null;
        this.hookBus = options.hookBus || null;
        this.customUnzip = options.customUnzip || null;
    }

    /**
     * EPUB 파일을 파싱하여 공유 가능한 도서 객체(EpubBook)를 반환합니다.
     * @param {File|Blob|ArrayBuffer|Uint8Array} source
     * @returns {Promise<Object>} 파싱된 EpubBook 인스턴스
     */
    async parse(source) {
        const t0 = performance.now();
        const zip = new ZipReader({ logger: this.logger, customUnzip: this.customUnzip });
        await zip.load(source);

        try {
            this._checkDrmProtection(zip);

            const opfPath = this._resolveOpfPath(zip);
            const opfXmlText = zip.readText(opfPath);
            if (!opfXmlText) {
                throw new Error(`OPF package file not found or unreadable: ${opfPath}`);
            }

            const opfDoc = parseXmlOrHtml(opfXmlText, 'application/xml');
            const resolver = new ResourceResolver({ zipReader: zip, logger: this.logger });

            const metadata = this._parseMetadata(opfDoc);
            const manifest = this._parseManifest(opfDoc, opfPath);
            const { spineItems, pageDirection } = this._parseSpine(opfDoc, manifest);
            if (pageDirection && !metadata.direction) {
                metadata.direction = pageDirection;
            }

            const { toc, landmarks } = this._parseNavigation(zip, opfDoc, manifest, opfPath, spineItems);
            const coverHref = this._resolveCoverHref(opfDoc, manifest, landmarks, opfPath);

            const sections = spineItems.map((item, idx) => this._createSectionEntry({
                index: idx,
                item,
                zip,
                resolver
            }));

            const book = {
                isEwbBook: true,
                opfPath,
                metadata,
                manifest,
                sections,
                toc,
                landmarks,
                coverHref,
                zip,
                resolver,

                /**
                 * 표지 이미지를 Blob으로 반환합니다.
                 * @returns {Promise<Blob|null>}
                 */
                getCover: async () => {
                    if (!coverHref) return null;
                    return zip.readBlob(coverHref);
                },

                /**
                 * EPUB 내부 경로(href#anchor)를 섹션 인덱스와 앵커 ID로 해석합니다.
                 * @param {string} rawHref
                 * @returns {{ index: number, anchor: string|null, href: string }|null}
                 */
                resolveHref: (rawHref) => this._resolveBookHref(rawHref, sections, opfPath),

                /**
                 * 책과 관련된 모든 ZIP 버퍼 및 Blob URL 자원을 일괄 해제합니다.
                 */
                destroy: () => {
                    resolver.dispose();
                    zip.dispose();
                }
            };

            const elapsed = (performance.now() - t0).toFixed(1);
            this._log?.trace?.({
                action: `EPUB 파싱 완료 ('${metadata.title}')`,
                caller: 'EpubParser.parse',
                state: `sections=${sections.length}, toc=${toc.length}`,
                delta: `${elapsed}ms`,
                result: 'parsed'
            });

            return book;
        } catch (err) {
            zip.dispose();
            throw err;
        }
    }

    /**
     * DRM 보호 파일 여부를 검사합니다. (폰트 난독화는 허용)
     * @param {ZipReader} zip
     */
    _checkDrmProtection(zip) {
        if (zip.has('META-INF/rights.xml')) {
            const err = new Error('DRM protected EPUB (META-INF/rights.xml detected).');
            err.code = 'DRM_PROTECTED';
            throw err;
        }

        const encText = zip.readText('META-INF/encryption.xml');
        if (!encText) return;

        const encDoc = parseXmlOrHtml(encText, 'application/xml');
        const methods = findByLocalName(encDoc, 'EncryptionMethod');
        const hasRealDrm = methods.some((m) => {
            const alg = (m.getAttribute('Algorithm') || '').trim();
            return alg && !FONT_OBFUSCATION_URIS.includes(alg);
        });

        if (hasRealDrm || methods.length === 0) {
            const err = new Error('DRM protected EPUB (META-INF/encryption.xml detected).');
            err.code = 'DRM_PROTECTED';
            throw err;
        }
    }

    /**
     * META-INF/container.xml에서 OPF 패키지 경로를 찾고, 실패 시 전체 ZIP에서 .opf 파일을 탐색합니다.
     * @param {ZipReader} zip
     * @returns {string}
     */
    _resolveOpfPath(zip) {
        const containerText = zip.readText('META-INF/container.xml');
        if (containerText) {
            const containerDoc = parseXmlOrHtml(containerText, 'application/xml');
            const rootfiles = findByLocalName(containerDoc, 'rootfile');
            for (const rf of rootfiles) {
                const fullPath = rf.getAttribute('full-path');
                if (fullPath && zip.has(fullPath)) {
                    return zip.resolveEntryKey(fullPath) || normalizeZipPath(fullPath);
                }
            }
        }

        const fallbackOpf = zip.listFiles().find((f) => f.toLowerCase().endsWith('.opf'));
        if (fallbackOpf) {
            this._log?.warn?.(`container.xml 누락/불일치 ➔ 폴백 OPF 선택: '${fallbackOpf}'`);
            return fallbackOpf;
        }

        throw new Error('Invalid EPUB: OPF package file not found.');
    }

    /**
     * OPF 메타데이터를 추출합니다.
     * @param {Document} opfDoc
     * @returns {Object}
     */
    _parseMetadata(opfDoc) {
        const getFirstText = (name) => {
            const els = findByLocalName(opfDoc, name);
            return els[0]?.textContent?.trim() || '';
        };

        const title = getFirstText('title') || '제목 없음';
        const author = getFirstText('creator') || '';
        const language = getFirstText('language') || '';
        const publisher = getFirstText('publisher') || '';
        const description = getFirstText('description') || '';
        const identifier = getFirstText('identifier') || '';

        return {
            title,
            author,
            language,
            publisher,
            description,
            identifier,
            direction: ''
        };
    }

    /**
     * OPF manifest 항목들을 ZIP 기준 정규 경로와 함께 매핑합니다.
     * @param {Document} opfDoc
     * @param {string} opfPath
     * @returns {Map<string, Object>}
     */
    _parseManifest(opfDoc, opfPath) {
        const manifest = new Map();
        const items = findByLocalName(opfDoc, 'item');

        for (const item of items) {
            const id = item.getAttribute('id');
            const rawHref = item.getAttribute('href');
            if (!id || !rawHref) continue;

            const mediaType = item.getAttribute('media-type') || '';
            const properties = (item.getAttribute('properties') || '').split(/\s+/).filter(Boolean);
            const href = resolveRelativeZipPath(opfPath, rawHref);

            manifest.set(id, {
                id,
                href,
                rawHref,
                mediaType,
                properties
            });
        }

        return manifest;
    }

    /**
     * OPF spine 순서를 해석합니다.
     * @param {Document} opfDoc
     * @param {Map<string, Object>} manifest
     * @returns {{ spineItems: Array<Object>, pageDirection: string, ncxId: string }}
     */
    _parseSpine(opfDoc, manifest) {
        const spineEl = findByLocalName(opfDoc, 'spine')[0];
        const pageDirection = spineEl?.getAttribute('page-progression-direction') || '';
        const ncxId = spineEl?.getAttribute('toc') || '';
        const itemrefs = findByLocalName(opfDoc, 'itemref');

        const spineItems = [];
        for (const ref of itemrefs) {
            const idref = ref.getAttribute('idref');
            if (!idref) continue;
            const manifestItem = manifest.get(idref);
            if (!manifestItem) continue;

            spineItems.push({
                id: manifestItem.id,
                idref,
                href: manifestItem.href,
                rawHref: manifestItem.rawHref,
                mediaType: manifestItem.mediaType,
                linear: ref.getAttribute('linear') !== 'no'
            });
        }

        return { spineItems, pageDirection, ncxId };
    }

    /**
     * EPUB 3 Nav, EPUB 2 NCX, Guide, Spine 순으로 목차와 랜드마크를 파싱합니다.
     * @param {ZipReader} zip
     * @param {Document} opfDoc
     * @param {Map<string, Object>} manifest
     * @param {string} opfPath
     * @param {Array<Object>} spineItems
     * @returns {{ toc: Array<Object>, landmarks: Array<Object> }}
     */
    _parseNavigation(zip, opfDoc, manifest, opfPath, spineItems) {
        let toc = [];
        let landmarks = [];

        // 1. EPUB 3 Nav (properties="nav")
        const navItem = Array.from(manifest.values()).find((it) => it.properties.includes('nav'));
        if (navItem) {
            const navText = zip.readText(navItem.href);
            if (navText) {
                const navDoc = parseXmlOrHtml(navText, 'application/xhtml+xml');
                const navEls = findByLocalName(navDoc, 'nav');
                for (const navEl of navEls) {
                    const epubType = (navEl.getAttribute('epub:type') || navEl.getAttribute('type') || '').toLowerCase();
                    if (epubType.includes('toc') || (!epubType && toc.length === 0)) {
                        const ol = findDirectChildrenByLocalName(navEl, 'ol')[0];
                        if (ol) toc = this._parseNavList(ol, navItem.href);
                    } else if (epubType.includes('landmarks')) {
                        const ol = findDirectChildrenByLocalName(navEl, 'ol')[0];
                        if (ol) landmarks = this._parseNavList(ol, navItem.href);
                    }
                }
            }
        }

        // 2. EPUB 2 NCX 폴백
        if (toc.length === 0) {
            const spineEl = findByLocalName(opfDoc, 'spine')[0];
            const tocId = spineEl?.getAttribute('toc');
            const ncxItem = (tocId && manifest.get(tocId))
                || Array.from(manifest.values()).find((it) => it.mediaType === 'application/x-dtbncx+xml' || it.href.toLowerCase().endsWith('.ncx'));

            if (ncxItem) {
                const ncxText = zip.readText(ncxItem.href);
                if (ncxText) {
                    const ncxDoc = parseXmlOrHtml(ncxText, 'application/xml');
                    const navMap = findByLocalName(ncxDoc, 'navMap')[0];
                    if (navMap) {
                        toc = this._parseNcxNavPoints(navMap, ncxItem.href);
                    }
                }
            }
        }

        // 3. OPF <guide> 폴백 (랜드마크 보충)
        if (landmarks.length === 0) {
            const refs = findByLocalName(opfDoc, 'reference');
            for (const ref of refs) {
                const rawHref = ref.getAttribute('href');
                if (!rawHref) continue;
                landmarks.push({
                    type: ref.getAttribute('type') || '',
                    label: ref.getAttribute('title') || '',
                    href: this._resolveHrefKeepingHash(opfPath, rawHref)
                });
            }
        }

        // 4. 목차가 완전히 비어있다면 Spine 기반 기본 목차 생성
        if (toc.length === 0 && spineItems.length > 0) {
            toc = spineItems.map((item, idx) => ({
                label: `챕터 ${idx + 1}`,
                href: item.href,
                subitems: []
            }));
        }

        return { toc, landmarks };
    }

    /**
     * EPUB 3 <ol> 목차 트리를 재귀 파싱합니다.
     * @param {Element} olEl
     * @param {string} baseHref
     * @returns {Array<Object>}
     */
    _parseNavList(olEl, baseHref) {
        const items = [];
        const liList = findDirectChildrenByLocalName(olEl, 'li');

        for (const li of liList) {
            const aEl = findDirectChildrenByLocalName(li, 'a')[0] || findDirectChildrenByLocalName(li, 'span')[0];
            const label = aEl?.textContent?.replace(/\s+/g, ' ').trim() || '';
            const rawHref = aEl?.getAttribute?.('href') || '';
            const href = rawHref ? this._resolveHrefKeepingHash(baseHref, rawHref) : '';

            const subOl = findDirectChildrenByLocalName(li, 'ol')[0];
            const subitems = subOl ? this._parseNavList(subOl, baseHref) : [];

            if (label || href) {
                items.push({
                    label: label || href,
                    href,
                    type: li.getAttribute('epub:type') || aEl?.getAttribute?.('epub:type') || '',
                    subitems
                });
            }
        }
        return items;
    }

    /**
     * EPUB 2 NCX <navPoint> 트리를 재귀 파싱합니다.
     * @param {Element} parentEl
     * @param {string} ncxHref
     * @returns {Array<Object>}
     */
    _parseNcxNavPoints(parentEl, ncxHref) {
        const items = [];
        const points = findDirectChildrenByLocalName(parentEl, 'navPoint');

        for (const pt of points) {
            const labelEl = findByLocalName(pt, 'text')[0];
            const contentEl = findDirectChildrenByLocalName(pt, 'content')[0] || findByLocalName(pt, 'content')[0];
            const label = labelEl?.textContent?.replace(/\s+/g, ' ').trim() || '';
            const rawSrc = contentEl?.getAttribute('src') || '';
            const href = rawSrc ? this._resolveHrefKeepingHash(ncxHref, rawSrc) : '';
            const subitems = this._parseNcxNavPoints(pt, ncxHref);

            if (label || href) {
                items.push({
                    label: label || href,
                    href,
                    subitems
                });
            }
        }
        return items;
    }

    /**
     * 해시(#anchor)를 유지한 채 기준 파일 대비 ZIP 경로를 정규화합니다.
     * @param {string} baseFilePath
     * @param {string} rawHref
     * @returns {string}
     */
    _resolveHrefKeepingHash(baseFilePath, rawHref) {
        if (!rawHref) return '';
        const hashIdx = rawHref.indexOf('#');
        const pathPart = hashIdx >= 0 ? rawHref.slice(0, hashIdx) : rawHref;
        const hashPart = hashIdx >= 0 ? rawHref.slice(hashIdx) : '';
        const resolved = pathPart ? resolveRelativeZipPath(baseFilePath, pathPart) : normalizeZipPath(baseFilePath);
        return resolved + hashPart;
    }

    /**
     * 표지 이미지 ZIP 경로를 3단계 우선순위로 탐색합니다.
     * @param {Document} opfDoc
     * @param {Map<string, Object>} manifest
     * @param {Array<Object>} landmarks
     * @param {string} opfPath
     * @returns {string|null}
     */
    _resolveCoverHref(opfDoc, manifest, landmarks, opfPath) {
        // 1순위: EPUB 3 properties="cover-image"
        const propCover = Array.from(manifest.values()).find((it) => it.properties.includes('cover-image'));
        if (propCover) return propCover.href;

        // 2순위: EPUB 2 <meta name="cover" content="cover-id">
        const metas = findByLocalName(opfDoc, 'meta');
        for (const meta of metas) {
            if ((meta.getAttribute('name') || '').toLowerCase() === 'cover') {
                const coverId = meta.getAttribute('content');
                if (coverId && manifest.has(coverId)) {
                    const item = manifest.get(coverId);
                    if (item.mediaType.startsWith('image/')) return item.href;
                }
            }
        }

        // 3순위: id 또는 href에 'cover'가 포함된 이미지 엔트리
        const heuristic = Array.from(manifest.values()).find((it) =>
            it.mediaType.startsWith('image/') &&
            (it.id.toLowerCase().includes('cover') || it.href.toLowerCase().includes('cover'))
        );
        if (heuristic) return heuristic.href;

        // 4순위: guide/landmarks의 cover 참조 (이미지 직접 지정인 경우)
        const coverLandmark = landmarks.find((l) => (l.type || '').toLowerCase() === 'cover');
        if (coverLandmark?.href) {
            const clean = coverLandmark.href.split('#')[0];
            if (/\.(png|jpe?g|webp|gif|svg)$/i.test(clean)) {
                return resolveRelativeZipPath(opfPath, clean);
            }
        }

        return null;
    }

    /**
     * 개별 Spine 섹션 실행 객체(Section)를 생성합니다.
     * @param {Object} params
     * @returns {Object}
     */
    _createSectionEntry({ index, item, zip, resolver }) {
        const cfiBase = `/6/${(index + 1) * 2}`;

        const loadHtml = async () => {
            const rawHtml = zip.readText(item.href);
            if (rawHtml === null) {
                throw new Error(`Chapter resource not found in EPUB: ${item.href}`);
            }
            if (this.hookBus) {
                return await this.hookBus.pipe('transformHtml', rawHtml, {
                    index,
                    href: item.href,
                    id: item.id
                });
            }
            return rawHtml;
        };

        const createDocument = async () => {
            const html = await loadHtml();
            const doc = parseXmlOrHtml(html, 'application/xhtml+xml');
            resolver.resolveDocumentResources(doc, item.href);
            return doc;
        };

        return {
            index,
            id: item.id,
            idref: item.idref,
            href: item.href,
            mediaType: item.mediaType,
            linear: item.linear,
            cfiBase,
            loadHtml,
            load: loadHtml,
            createDocument,
            createURI: () => item.href
        };
    }

    /**
     * href 문자열을 해당 섹션 인덱스와 앵커 ID로 해석합니다.
     * @param {string} rawHref
     * @param {Array<Object>} sections
     * @param {string} opfPath
     * @returns {{ index: number, anchor: string|null, href: string }|null}
     */
    _resolveBookHref(rawHref, sections, opfPath) {
        if (!rawHref || typeof rawHref !== 'string') return null;

        const hashIdx = rawHref.indexOf('#');
        const pathPart = (hashIdx >= 0 ? rawHref.slice(0, hashIdx) : rawHref).trim();
        const anchor = hashIdx >= 0 ? rawHref.slice(hashIdx + 1).trim() : null;

        const normTarget = normalizeZipPath(pathPart);
        const opfRelativeTarget = resolveRelativeZipPath(opfPath, pathPart);
        const filenameTarget = normTarget.split('/').pop().toLowerCase();

        let matchedIndex = sections.findIndex((s) => s.href === normTarget || s.href === opfRelativeTarget);
        if (matchedIndex < 0 && filenameTarget) {
            matchedIndex = sections.findIndex((s) => s.href.split('/').pop().toLowerCase() === filenameTarget);
        }

        if (matchedIndex < 0) return null;

        return {
            index: matchedIndex,
            anchor: anchor || null,
            href: sections[matchedIndex].href
        };
    }
}