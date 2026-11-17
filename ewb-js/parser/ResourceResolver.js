/**
 * 🔗 EWB 엔진 리소스 경로 해석 및 Blob URL 수명주기 관리자 (ResourceResolver)
 * - 🖼️ [멀티 리소스 치환] img, svg image(href/xlink:href), link stylesheet, inline style, media src 대응
 * - 🎨 [CSS 재귀 해석] @import 및 url(...) 내부 상대 경로를 해당 CSS 파일 위치 기준으로 정확히 치환
 * - 🧹 [단일 캐시 & 일괄 GC] 동일 zipPath는 Blob URL 1회 생성 후 공유하며 dispose() 시 전부 revoke
 * 파일 경로: web/ewb-js/parser/ResourceResolver.js
 * @module ewb-js/parser/ResourceResolver
 */

import { resolveRelativeZipPath } from './ZipReader.js';

const EXTERNAL_OR_SPECIAL_SCHEME = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

/**
 * EPUB 내부 리소스 Blob URL 변환 및 해제 관리 클래스
 */
export class ResourceResolver {
    /**
     * @param {Object} options
     * @param {import('./ZipReader.js').ZipReader} options.zipReader - ZIP 리더 인스턴스
     * @param {Object|null} [options.logger=null] - EngineLogger 인스턴스
     */
    constructor({ zipReader, logger = null }) {
        if (!zipReader) {
            throw new Error('ResourceResolver requires a ZipReader instance.');
        }
        this.zip = zipReader;
        this._log = logger?.child ? logger.child('ResourceResolver') : null;

        /** @type {Map<string, string>} 정규화된 zipPath -> Blob URL */
        this._blobCache = new Map();

        /** @type {Map<string, string>} CSS zipPath -> 내부 경로가 이미 치환된 CSS Blob URL */
        this._resolvedCssCache = new Map();

        this._isDisposed = false;
    }

    /**
     * 특정 ZIP 경로에 대한 Blob URL을 반환합니다. (이미 생성된 경우 캐시 재사용)
     * @param {string} baseFilePath - 기준 파일 경로 (예: 'OEBPS/Text/ch1.xhtml')
     * @param {string} rawRef - 참조 경로 (예: '../Images/cover.jpg')
     * @param {string} [explicitMimeType] - 선택적 MIME 타입
     * @returns {string|null} 생성된 Blob URL 또는 외부/무효 경로 시 null
     */
    getBlobUrl(baseFilePath, rawRef, explicitMimeType) {
        if (this._isDisposed || !rawRef || typeof rawRef !== 'string') return null;

        const trimmed = rawRef.trim();
        if (!trimmed || EXTERNAL_OR_SPECIAL_SCHEME.test(trimmed)) return null;

        const zipPath = resolveRelativeZipPath(baseFilePath, trimmed);
        const resolvedKey = this.zip.resolveEntryKey(zipPath);
        if (!resolvedKey) return null;

        if (this._blobCache.has(resolvedKey)) {
            return this._blobCache.get(resolvedKey);
        }

        const blob = this.zip.readBlob(resolvedKey, explicitMimeType);
        if (!blob) return null;

        const blobUrl = URL.createObjectURL(blob);
        this._blobCache.set(resolvedKey, blobUrl);
        return blobUrl;
    }

    /**
     * CSS 파일 내의 @import와 url(...) 상대 경로를 재귀 치환하고 CSS 전용 Blob URL을 반환합니다.
     * @param {string} baseFilePath - CSS를 참조하는 파일 경로
     * @param {string} rawCssHref - CSS 파일 상대 경로
     * @param {Set<string>} [visitedCssSet=new Set()] - 순환 @import 방지 세트
     * @returns {string|null} 치환된 CSS Blob URL
     */
    resolveStylesheetUrl(baseFilePath, rawCssHref, visitedCssSet = new Set()) {
        if (this._isDisposed || !rawCssHref || EXTERNAL_OR_SPECIAL_SCHEME.test(rawCssHref.trim())) {
            return null;
        }

        const zipPath = resolveRelativeZipPath(baseFilePath, rawCssHref.trim());
        const resolvedKey = this.zip.resolveEntryKey(zipPath);
        if (!resolvedKey) return null;

        if (this._resolvedCssCache.has(resolvedKey)) {
            return this._resolvedCssCache.get(resolvedKey);
        }

        if (visitedCssSet.has(resolvedKey)) {
            this._log?.warn?.(`순환 CSS @import 감지 및 차단: '${resolvedKey}'`);
            return null;
        }

        const cssText = this.zip.readText(resolvedKey);
        if (cssText === null) return null;

        visitedCssSet.add(resolvedKey);
        const transformedCss = this.rewriteCssText(cssText, resolvedKey, visitedCssSet);
        visitedCssSet.delete(resolvedKey);

        const cssBlob = new Blob([transformedCss], { type: 'text/css' });
        const cssBlobUrl = URL.createObjectURL(cssBlob);
        this._resolvedCssCache.set(resolvedKey, cssBlobUrl);
        return cssBlobUrl;
    }

    /**
     * CSS 텍스트 내의 @import 및 url(...) 참조를 Blob URL로 치환합니다.
     * @param {string} cssText - 원본 CSS 문자열
     * @param {string} cssFilePath - 해당 CSS(또는 인라인 스타일 문서)의 ZIP 기준 경로
     * @param {Set<string>} [visitedCssSet=new Set()] - 순환 참조 방지 세트
     * @returns {string} 치환된 CSS 문자열
     */
    rewriteCssText(cssText, cssFilePath, visitedCssSet = new Set()) {
        if (!cssText || typeof cssText !== 'string' || this._isDisposed) return cssText || '';

        // 1. @import url("...") 또는 @import "..." 처리
        let output = cssText.replace(
            /@import\s+(?:url\(\s*(['"]?)([^)'"]+)\1\s*\)|(['"])([^'"]+)\3)([^;]*);/gi,
            (fullMatch, _q1, urlHref, _q2, strHref, mediaRest) => {
                const targetHref = (urlHref || strHref || '').trim();
                if (!targetHref || EXTERNAL_OR_SPECIAL_SCHEME.test(targetHref)) {
                    return fullMatch;
                }
                const resolvedUrl = this.resolveStylesheetUrl(cssFilePath, targetHref, visitedCssSet);
                if (!resolvedUrl) return fullMatch;
                return `@import url("${resolvedUrl}")${mediaRest || ''};`;
            }
        );

        // 2. 일반 url(...) (폰트, 배경 이미지 등) 처리
        output = output.replace(
            /url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi,
            (fullMatch, _quote, rawUrl) => {
                const trimmed = (rawUrl || '').trim();
                if (!trimmed || EXTERNAL_OR_SPECIAL_SCHEME.test(trimmed)) {
                    return fullMatch;
                }
                const blobUrl = this.getBlobUrl(cssFilePath, trimmed);
                return blobUrl ? `url("${blobUrl}")` : fullMatch;
            }
        );

        return output;
    }

    /**
     * 파싱된 챕터 Document(또는 Element) 내부의 모든 상대 경로 리소스를 Blob URL로 치환합니다.
     * @param {Document} doc - 챕터 Document 객체
     * @param {string} chapterZipPath - 해당 챕터 XHTML의 ZIP 내부 경로
     * @returns {{ rewrittenCount: number }} 치환된 항목 수 통계
     */
    resolveDocumentResources(doc, chapterZipPath) {
        if (!doc || this._isDisposed) {
            return { rewrittenCount: 0 };
        }

        let rewrittenCount = 0;

        // 1. <link rel="stylesheet" href="..."> & icon 등
        const links = doc.querySelectorAll('link[href]');
        for (const linkEl of links) {
            const rel = (linkEl.getAttribute('rel') || '').toLowerCase();
            const rawHref = linkEl.getAttribute('href');
            if (!rawHref || EXTERNAL_OR_SPECIAL_SCHEME.test(rawHref.trim())) continue;

            const blobUrl = rel.includes('stylesheet')
                ? this.resolveStylesheetUrl(chapterZipPath, rawHref)
                : this.getBlobUrl(chapterZipPath, rawHref);

            if (blobUrl) {
                linkEl.setAttribute('data-ewb-raw-href', rawHref);
                linkEl.setAttribute('href', blobUrl);
                rewrittenCount++;
            }
        }

        // 2. <style> 태그 내부 CSS url(...) 및 @import 치환
        const styleTags = doc.querySelectorAll('style');
        for (const styleTag of styleTags) {
            const rawCss = styleTag.textContent || '';
            if (rawCss.includes('url(') || rawCss.includes('@import')) {
                const rewrittenCss = this.rewriteCssText(rawCss, chapterZipPath);
                if (rewrittenCss !== rawCss) {
                    styleTag.textContent = rewrittenCss;
                    rewrittenCount++;
                }
            }
        }

        // 3. 인라인 style="..." 속성 내 url(...) 치환
        const inlineStyledEls = doc.querySelectorAll('[style*="url("]');
        for (const el of inlineStyledEls) {
            const rawStyle = el.getAttribute('style') || '';
            const rewrittenStyle = this.rewriteCssText(rawStyle, chapterZipPath);
            if (rewrittenStyle !== rawStyle) {
                el.setAttribute('style', rewrittenStyle);
                rewrittenCount++;
            }
        }

        // 4. [src] 속성 (img, audio, video, source, track, embed)
        const srcElements = doc.querySelectorAll('img[src], audio[src], video[src], source[src], track[src], embed[src]');
        for (const el of srcElements) {
            const rawSrc = el.getAttribute('src');
            if (!rawSrc || EXTERNAL_OR_SPECIAL_SCHEME.test(rawSrc.trim())) continue;
            const blobUrl = this.getBlobUrl(chapterZipPath, rawSrc);
            if (blobUrl) {
                el.setAttribute('data-ewb-raw-src', rawSrc);
                el.setAttribute('src', blobUrl);
                rewrittenCount++;
            }
        }

        // 5. <video poster="..."> & <object data="...">
        const posterEls = doc.querySelectorAll('video[poster]');
        for (const el of posterEls) {
            const rawPoster = el.getAttribute('poster');
            const blobUrl = this.getBlobUrl(chapterZipPath, rawPoster);
            if (blobUrl) {
                el.setAttribute('poster', blobUrl);
                rewrittenCount++;
            }
        }

        const objectEls = doc.querySelectorAll('object[data]');
        for (const el of objectEls) {
            const rawData = el.getAttribute('data');
            const blobUrl = this.getBlobUrl(chapterZipPath, rawData);
            if (blobUrl) {
                el.setAttribute('data', blobUrl);
                rewrittenCount++;
            }
        }

        // 6. SVG <image href="..."> / <image xlink:href="..."> (전자책 표지 SVG 페이지 대응)
        const svgImages = doc.querySelectorAll('image');
        for (const imgEl of svgImages) {
            const hrefAttr = imgEl.getAttribute('href') ? 'href' : (imgEl.getAttribute('xlink:href') ? 'xlink:href' : null);
            if (!hrefAttr) continue;
            const rawHref = imgEl.getAttribute(hrefAttr);
            const blobUrl = this.getBlobUrl(chapterZipPath, rawHref);
            if (blobUrl) {
                imgEl.setAttribute('href', blobUrl);
                if (hrefAttr === 'xlink:href') {
                    imgEl.setAttribute('xlink:href', blobUrl);
                }
                rewrittenCount++;
            }
        }

        // 7. 내부 앵커 <a href="...">는 Blob URL로 바꾸지 않고 해석된 ZIP 경로만 보존
        const anchorEls = doc.querySelectorAll('a[href]');
        for (const aEl of anchorEls) {
            const rawHref = aEl.getAttribute('href');
            if (!rawHref || EXTERNAL_OR_SPECIAL_SCHEME.test(rawHref.trim())) continue;
            const hashIdx = rawHref.indexOf('#');
            const filePart = hashIdx >= 0 ? rawHref.slice(0, hashIdx) : rawHref;
            const hashPart = hashIdx >= 0 ? rawHref.slice(hashIdx) : '';
            const resolvedTarget = resolveRelativeZipPath(chapterZipPath, filePart) + hashPart;
            aEl.setAttribute('data-ewb-href', resolvedTarget);
        }

        return { rewrittenCount };
    }

    /**
     * 생성된 모든 Blob URL을 즉시 revoke하고 캐시를 초기화합니다.
     */
    dispose() {
        if (this._isDisposed) return;
        this._isDisposed = true;

        let revokedCount = 0;
        for (const url of this._blobCache.values()) {
            try {
                URL.revokeObjectURL(url);
                revokedCount++;
            } catch (e) {}
        }
        for (const url of this._resolvedCssCache.values()) {
            try {
                URL.revokeObjectURL(url);
                revokedCount++;
            } catch (e) {}
        }

        this._blobCache.clear();
        this._resolvedCssCache.clear();

        this._log?.trace?.({
            action: '리소스 Blob URL 일괄 회수',
            caller: 'ResourceResolver.dispose',
            state: 'DISPOSED',
            delta: `revoked=${revokedCount}`,
            result: 'gc_complete'
        });
    }
}