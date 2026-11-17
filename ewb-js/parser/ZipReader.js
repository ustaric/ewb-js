/**
 * 📦 EWB 엔진 전용 ZIP 아카이브 리더 어댑터 (ZipReader)
 * - ⚡ [fflate 기본 탑재] 초경량 표준 ZIP 해제(비동기 unzip 우선 + 동기 unzipSync 폴백)
 * - 🔌 [어댑터 교체 가능] 외부 unzipFn 주입 시 다른 ZIP 라이브러리로 즉시 교체 가능
 * - 🛡️ [실전 EPUB 내구성] URL 인코딩(%20), 역슬래시(\), 대소문자 불일치 3단계 경로 해석 지원
 * 파일 경로: web/ewb-js/parser/ZipReader.js
 * @module ewb-js/parser/ZipReader
 */

import { unzip, unzipSync } from 'fflate';

const MIME_MAP = Object.freeze({
    '.xhtml': 'application/xhtml+xml',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.xml': 'application/xml',
    '.opf': 'application/oebps-package+xml',
    '.ncx': 'application/x-dtbncx+xml',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.smil': 'application/smil+xml'
});

/**
 * ZIP 내부 상대 경로를 표준 POSIX 형태로 정규화합니다. (`..`, `.` 세그먼트 해석 포함)
 * @param {string} rawPath
 * @returns {string}
 */
export function normalizeZipPath(rawPath = '') {
    if (!rawPath || typeof rawPath !== 'string') return '';
    const cleaned = rawPath
        .split('#')[0]
        .split('?')[0]
        .replace(/\\/g, '/')
        .replace(/^\/+/, '');

    const parts = [];
    for (const seg of cleaned.split('/')) {
        if (!seg || seg === '.') continue;
        if (seg === '..') {
            if (parts.length > 0) parts.pop();
        } else {
            parts.push(seg);
        }
    }
    return parts.join('/');
}

/**
 * 기준 파일 경로를 기준으로 상대 경로를 해석합니다.
 * @param {string} baseFilePath - 예: 'OEBPS/content.opf'
 * @param {string} relativePath - 예: '../Images/cover.jpg'
 * @returns {string} 예: 'Images/cover.jpg'
 */
export function resolveRelativeZipPath(baseFilePath = '', relativePath = '') {
    if (!relativePath) return '';
    if (/^[a-z]+:/i.test(relativePath)) return relativePath;
    if (relativePath.startsWith('/')) return normalizeZipPath(relativePath);

    const baseNorm = normalizeZipPath(baseFilePath);
    const lastSlash = baseNorm.lastIndexOf('/');
    const baseDir = lastSlash >= 0 ? baseNorm.slice(0, lastSlash + 1) : '';
    return normalizeZipPath(baseDir + relativePath);
}

/**
 * 파일 확장자 기반 표준 MIME 타입을 반환합니다.
 * @param {string} filePath
 * @returns {string}
 */
export function guessMimeType(filePath = '') {
    const clean = filePath.split('#')[0].split('?')[0].toLowerCase();
    const dotIdx = clean.lastIndexOf('.');
    if (dotIdx < 0) return 'application/octet-stream';
    const ext = clean.slice(dotIdx);
    return MIME_MAP[ext] || 'application/octet-stream';
}

/**
 * EPUB ZIP 아카이브 리더 클래스
 */
export class ZipReader {
    /**
     * @param {Object} [options={}]
     * @param {Object|null} [options.logger=null] - EngineLogger 인스턴스
     * @param {Function|null} [options.customUnzip=null] - 커스텀 비동기 unzip 함수: (uint8Array) => Promise<Record<string, Uint8Array>>
     */
    constructor(options = {}) {
        this._log = options.logger?.child ? options.logger.child('ZipReader') : null;
        this._customUnzip = typeof options.customUnzip === 'function' ? options.customUnzip : null;

        /** @type {Map<string, Uint8Array>} */
        this._entries = new Map();

        /** @type {Map<string, string>} 소문자 경로 -> 실제 키 매핑 */
        this._lowerKeyIndex = new Map();

        this._isDisposed = false;
    }

    /**
     * File, Blob, ArrayBuffer 또는 Uint8Array 소스를 압축 해제하여 메모리에 적재합니다.
     * @param {File|Blob|ArrayBuffer|Uint8Array} source
     * @returns {Promise<number>} 적재된 파일 엔트리 개수
     */
    async load(source) {
        if (this._isDisposed) {
            throw new Error('ZipReader has already been disposed.');
        }

        const t0 = performance.now();
        const uint8 = await this._toUint8Array(source);
        const rawMap = await this._decompress(uint8);

        this._entries.clear();
        this._lowerKeyIndex.clear();

        for (const [rawKey, data] of Object.entries(rawMap)) {
            if (!data || rawKey.endsWith('/')) continue;
            const normKey = normalizeZipPath(rawKey);
            if (!normKey) continue;
            this._entries.set(normKey, data);
            this._lowerKeyIndex.set(normKey.toLowerCase(), normKey);
        }

        const elapsed = (performance.now() - t0).toFixed(1);
        this._log?.trace?.({
            action: 'ZIP 압축 해제 완료',
            caller: 'ZipReader.load',
            state: 'LOADED',
            delta: `entries=${this._entries.size}, ${elapsed}ms`,
            result: 'ready'
        });

        return this._entries.size;
    }

    /**
     * 입력 소스를 Uint8Array로 변환합니다.
     * @param {File|Blob|ArrayBuffer|Uint8Array} source
     * @returns {Promise<Uint8Array>}
     */
    async _toUint8Array(source) {
        if (source instanceof Uint8Array) return source;
        if (source instanceof ArrayBuffer) return new Uint8Array(source);
        if (source && typeof source.arrayBuffer === 'function') {
            const buf = await source.arrayBuffer();
            return new Uint8Array(buf);
        }
        throw new Error('Unsupported EPUB source type. Expected File, Blob, ArrayBuffer, or Uint8Array.');
    }

    /**
     * fflate 또는 주입된 커스텀 엔진으로 압축을 해제합니다.
     * @param {Uint8Array} uint8
     * @returns {Promise<Record<string, Uint8Array>>}
     */
    async _decompress(uint8) {
        if (this._customUnzip) {
            return await this._customUnzip(uint8);
        }

        return await new Promise((resolve, reject) => {
            unzip(uint8, (err, data) => {
                if (!err && data) {
                    resolve(data);
                    return;
                }
                try {
                    const syncData = unzipSync(uint8);
                    resolve(syncData);
                } catch (syncErr) {
                    reject(err || syncErr);
                }
            });
        });
    }

    /**
     * 3단계 폴백(정확 일치 -> URL 디코딩 -> 대소문자 무시)으로 실제 저장 키를 찾습니다.
     * @param {string} path
     * @returns {string|null}
     */
    resolveEntryKey(path) {
        if (!path || this._isDisposed) return null;

        const norm = normalizeZipPath(path);
        if (this._entries.has(norm)) return norm;

        try {
            const decoded = normalizeZipPath(decodeURIComponent(norm));
            if (this._entries.has(decoded)) return decoded;

            const lowerDecoded = this._lowerKeyIndex.get(decoded.toLowerCase());
            if (lowerDecoded) return lowerDecoded;
        } catch (e) {}

        const lowerNorm = this._lowerKeyIndex.get(norm.toLowerCase());
        return lowerNorm || null;
    }

    /**
     * 해당 경로의 엔트리가 존재하는지 확인합니다.
     * @param {string} path
     * @returns {boolean}
     */
    has(path) {
        return this.resolveEntryKey(path) !== null;
    }

    /**
     * ZIP 내부 모든 파일 경로 목록을 반환합니다.
     * @returns {string[]}
     */
    listFiles() {
        return Array.from(this._entries.keys());
    }

    /**
     * 지정 경로 파일의 원시 바이트(Uint8Array)를 반환합니다.
     * @param {string} path
     * @returns {Uint8Array|null}
     */
    readBytes(path) {
        const key = this.resolveEntryKey(path);
        if (!key) return null;
        return this._entries.get(key) || null;
    }

    /**
     * 지정 경로 파일을 텍스트 문자열로 디코딩해 반환합니다. (UTF-8 / UTF-16 BOM 대응)
     * @param {string} path
     * @returns {string|null}
     */
    readText(path) {
        const bytes = this.readBytes(path);
        if (!bytes) return null;

        let encoding = 'utf-8';
        if (bytes.length >= 2) {
            if (bytes[0] === 0xFF && bytes[1] === 0xFE) encoding = 'utf-16le';
            else if (bytes[0] === 0xFE && bytes[1] === 0xFF) encoding = 'utf-16be';
        }

        return new TextDecoder(encoding).decode(bytes);
    }

    /**
     * 지정 경로 파일을 MIME 타입이 지정된 Blob으로 반환합니다.
     * @param {string} path
     * @param {string} [mimeType]
     * @returns {Blob|null}
     */
    readBlob(path, mimeType) {
        const key = this.resolveEntryKey(path);
        if (!key) return null;
        const bytes = this._entries.get(key);
        if (!bytes) return null;
        return new Blob([bytes], { type: mimeType || guessMimeType(key) });
    }

    /**
     * 메모리에 적재된 ZIP 바이너리 참조를 모두 해제합니다.
     */
    dispose() {
        this._isDisposed = true;
        this._entries.clear();
        this._lowerKeyIndex.clear();
        this._log?.trace?.({
            action: 'ZIP 버퍼 메모리 해제',
            caller: 'ZipReader.dispose',
            state: 'DISPOSED',
            delta: 'entries=0',
            result: 'gc_ready'
        });
    }
}