// ================================================================
// ASSET-MANAGER.JS — Central Asset Pipeline
// ================================================================
// File: js/runtime/asset-manager.js
// Responsibilities: Cache assets, prevent duplicates, preload,
// lazy-load, track status, handle failures, retry, expose lookup.
// Does NOT perform section-specific logic — only asset management.
//
// SURGICAL FIX PASS — combined list from two reviews. Summary:
//  [FIX 1]  Unified cache-key generation. load() now computes the key ONCE
//           and passes it explicitly into fetchAsset(), which no longer
//           recomputes a different (narrower) key or does its own separate
//           bare-url loading-dedup check. This was causing cross-variant
//           contamination (e.g. quality-tagged requests silently missing
//           cache) and could hand a concurrent caller the wrong variant.
//  [FIX 2]  `force: true` now actually forces a re-fetch — threaded through
//           to fetchAsset, which previously ignored it and always hit its
//           own internal cache check regardless.
//  [FIX 3]  Blob URL leak fixed — a single object URL is now created per
//           loaded image and used for BOTH img.src and the stored
//           _blobUrl, so release()/clearCache() actually revoke the URL
//           that's really in use.
//  [FIX 4]  getEstimatedSize() is now the single source of truth for size
//           calculation (extended to cover plain JSON-able objects too),
//           instead of being defined and never called.
//  [FIX 5]  Cache entries now track lastAccessedAt/accessCount (updated on
//           get()), and eviction is based on that instead of load time —
//           real LRU instead of "oldest loaded."
//  [FIX 6]  Preload queue is now priority-aware: separate high/normal/low
//           buckets, drained high-first, so high-priority assets aren't
//           stuck behind a FIFO of unrelated normal/low requests.
//  [FIX 7]  Preload scheduling now goes through the Scheduler engine when
//           available (matches the rest of the runtime's timing model),
//           falling back to setTimeout only if Scheduler is absent.
//  [FIX 8]  Removed dead state field `_state._initialized` (only
//           `_state.isInitialized` was ever actually used).
//  [FIX 9]  Removed unreachable `svg` branch in getAssetType() — already
//           covered by the image-extensions array.
//  [FIX 10] Simplified the always-true guard inside evictLeastRecentlyUsed()
//           — its only caller already guarantees a limit is violated.
//  [FIX 11] Timeout timer is now cleared on every exit path (success,
//           error, or retry), not just the success path.
//  [FIX 12] SSR/non-browser guards added around document, fetch,
//           AbortController, IntersectionObserver, URL, Image, performance.
//  [FIX 13] Logging gated behind Runtime?.config?.debug.
//  [FIX 14] Corrected a stale/misleading comment on the image-fetch branch.
//  [FIX 15] Basic input validation added to configure().
//
// Not implemented in this pass (documented as backlog, not blockers):
// true O(1) LRU via hash+linked-list, compression, cache categories,
// persistence, performance-tier adaptive tuning, smarter per-status-code
// retry policy, progressive loading, dependency groups, memory-pressure
// events, predictive preload, asset versioning, richer diagnostics,
// periodic background cleanup. See contract discussion for the full list.
// ================================================================

(function(global) {
    'use strict';

    const hasWindow = typeof window !== 'undefined';
    const hasDocument = typeof document !== 'undefined';
    const hasFetch = typeof fetch === 'function';
    const hasAbortController = typeof AbortController !== 'undefined';
    const hasIntersectionObserver = typeof IntersectionObserver !== 'undefined';
    const hasURL = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
    const hasImage = typeof Image !== 'undefined';
    const hasPerformance = typeof performance !== 'undefined';
    const hasCustomEvent = typeof CustomEvent !== 'undefined';

    // ---------- Private State ----------
    const _state = {
        isInitialized: false,
        isDestroyed: false,
        cache: new Map(),              // cacheKey -> { data, type, status, loadedAt, lastAccessedAt, accessCount, expires, size, metadata }
        loading: new Map(),            // cacheKey -> Promise
        // [FIX 6] Real priority buckets instead of one FIFO set.
        preloadQueues: {
            high: new Set(),
            normal: new Set(),
            low: new Set(),
        },
        config: {
            maxCacheSize: 100,
            maxCacheBytes: 50 * 1024 * 1024, // 50MB
            defaultTimeout: 30000,
            retryAttempts: 3,
            retryDelay: 1000,
            preloadConcurrency: 5,
            lazyLoadThreshold: 200,
            enableCompression: false,   // not yet implemented — see backlog
            fallbackImage: null,
        },
        totalBytes: 0,
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        currentPreloads: 0,
        _preloadTaskId: null,
        _lazyObserver: null,
    };

    // ---------- Private Helpers ----------
    function isDebug() {
        return !!(global.Runtime && global.Runtime.config && global.Runtime.config.debug);
    }

    function log(...args) {
        if (isDebug()) console.log(...args);
    }

    function warnLog(...args) {
        if (isDebug()) console.warn(...args);
    }

    function getEventEngine() {
        // Informal dependency — event-engine.js is not yet a formal contract
        // entry per the IDPORT reference doc (same caveat as Scheduler and
        // PerformanceEngine). Degrades to a DOM CustomEvent fallback.
        return (global.Runtime && global.Runtime.EventEngine) || global.EventEngine || null;
    }

    function getPerformanceEngine() {
        return (global.Runtime && global.Runtime.PerformanceEngine) || global.PerformanceEngine || null;
    }

    function getScheduler() {
        return (global.Runtime && global.Runtime.Scheduler) || global.Scheduler || null;
    }

    function emit(eventName, payload = {}) {
        const ee = getEventEngine();
        if (ee && typeof ee.emit === 'function') {
            ee.emit(`asset:${eventName}`, payload);
            return;
        }
        if (hasDocument && hasCustomEvent) {
            const event = new CustomEvent(`asset:${eventName}`, { detail: payload, bubbles: true });
            document.dispatchEvent(event);
        }
    }

    function now() {
        return hasPerformance ? performance.now() : Date.now();
    }

    function getAssetType(url) {
        const ext = url.split('.').pop()?.toLowerCase() || '';
        if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico'].includes(ext)) return 'image';
        if (['mp4', 'webm', 'ogg', 'mov', 'avi'].includes(ext)) return 'video';
        if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(ext)) return 'audio';
        if (['woff', 'woff2', 'ttf', 'otf', 'eot'].includes(ext)) return 'font';
        if (['json'].includes(ext)) return 'json';
        if (['js', 'mjs', 'cjs'].includes(ext)) return 'script';
        if (['css'].includes(ext)) return 'style';
        // [FIX 9] Removed unreachable `if (ext === 'svg') return 'image';`
        // — svg is already matched by the image-extensions array above.
        return 'unknown';
    }

    // [FIX 1] Single canonical key generator, used everywhere — load(),
    // get(), has(), isLoading(), getStatus(), release(), AND fetchAsset()
    // now all derive the key exactly the same way, from the same inputs.
    function generateCacheKey(url, options = {}) {
        const { type, quality } = options;
        let key = url;
        if (type && type !== 'auto') key += `|type=${type}`;
        if (quality) key += `|q=${quality}`;
        return key;
    }

    function isAssetExpired(entry) {
        if (!entry.expires) return false;
        return Date.now() > entry.expires;
    }

    // [FIX 4] getEstimatedSize is now the single place size is computed,
    // including a branch for plain JSON-serializable objects (previously
    // handled by ad-hoc duplicate logic inline in fetchAsset).
    function getEstimatedSize(data) {
        if (typeof Blob !== 'undefined' && data instanceof Blob) return data.size;
        if (typeof File !== 'undefined' && data instanceof File) return data.size;
        if (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) return data.byteLength;
        if (typeof data === 'string') return data.length * 2; // approx UTF-16 bytes
        if (hasImage && (data instanceof Image || (typeof HTMLImageElement !== 'undefined' && data instanceof HTMLImageElement))) {
            return (data.naturalWidth || data.width || 0) * (data.naturalHeight || data.height || 0) * 4;
        }
        if (data && typeof data === 'object') {
            try {
                const json = JSON.stringify(data);
                return typeof Blob !== 'undefined' ? new Blob([json]).size : json.length * 2;
            } catch (_) {
                return 0;
            }
        }
        return 0;
    }

    function getAssetSize(entry) {
        return entry.size || 0;
    }

    // ---------- Cache Eviction ----------
    // [FIX 5] Now evicts by lastAccessedAt (falls back to loadedAt for
    // entries never explicitly accessed via get()) — real LRU instead of
    // "oldest loaded."
    // [FIX 10] Removed the redundant internal size-check guard — the only
    // caller (enforceCacheLimits) already guarantees a limit is violated
    // before this runs.
    function evictLeastRecentlyUsed() {
        let oldestKey = null;
        let oldestTime = Infinity;
        for (const [key, entry] of _state.cache) {
            const t = entry.lastAccessedAt || entry.loadedAt;
            if (t < oldestTime) {
                oldestTime = t;
                oldestKey = key;
            }
        }
        if (oldestKey) {
            const entry = _state.cache.get(oldestKey);
            if (entry) {
                _state.totalBytes -= getAssetSize(entry);
            }
            _state.cache.delete(oldestKey);
            emit('evicted', { url: oldestKey });
        }
    }

    function enforceCacheLimits() {
        while (_state.cache.size > _state.config.maxCacheSize ||
               _state.totalBytes > _state.config.maxCacheBytes) {
            if (_state.cache.size === 0) break; // safety valve
            evictLeastRecentlyUsed();
        }
    }

    // ---------- Fetch Implementation ----------
    // [FIX 1] Now takes the already-computed cacheKey explicitly rather
    // than recomputing its own (different) key from a partial options
    // object. [FIX 2] Now respects `force`. No longer does its own separate
    // loading-dedup bookkeeping — load() already owns that via cacheKey.
    async function fetchAsset(url, cacheKey, options = {}) {
        const {
            timeout = _state.config.defaultTimeout,
            retryAttempts = _state.config.retryAttempts,
            retryDelay = _state.config.retryDelay,
            type = 'auto',
            credentials = 'same-origin',
            headers = {},
            force = false,
        } = options;

        if (!hasFetch) {
            throw new Error('fetch() is unavailable in this environment');
        }

        const assetType = type === 'auto' ? getAssetType(url) : type;

        // [FIX 2] Cache check now correctly respects force.
        if (!force) {
            const cached = _state.cache.get(cacheKey);
            if (cached && !isAssetExpired(cached)) {
                return cached.data;
            }
        }

        let attempt = 0;

        const fetchWithRetry = async () => {
            // [FIX 11] timeoutId is hoisted so it can be cleared on every
            // exit path — success, hard failure, or before a retry — not
            // just the success path.
            let timeoutId = null;
            let controller = null;
            try {
                controller = hasAbortController ? new AbortController() : null;
                if (controller) {
                    timeoutId = setTimeout(() => controller.abort(), timeout);
                }

                const fetchOptions = { credentials, headers };
                if (controller) fetchOptions.signal = controller.signal;

                const response = await fetch(url, fetchOptions);
                if (timeoutId !== null) clearTimeout(timeoutId);

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                let data;
                let size = 0;

                if (assetType === 'image') {
                    // [FIX 14] Corrected comment: we fetch the raw bytes as a
                    // Blob and decode via a same-page Image element so we
                    // get proper decode/error events and can size the blob
                    // directly, rather than relying on the browser's own
                    // opaque network cache behavior.
                    const blob = await response.blob();
                    size = blob.size;
                    // [FIX 3] Exactly ONE object URL is created and reused
                    // for both display and later revocation.
                    const objectUrl = hasURL ? URL.createObjectURL(blob) : null;
                    data = await new Promise((resolveImg, rejectImg) => {
                        if (!hasImage || !objectUrl) {
                            rejectImg(new Error('Image loading unavailable in this environment'));
                            return;
                        }
                        const img = new Image();
                        img.onload = () => resolveImg(img);
                        img.onerror = () => rejectImg(new Error('Image decode failed'));
                        img.src = objectUrl;
                    });
                    data._blobUrl = objectUrl;
                    data._blob = blob;
                } else if (assetType === 'json') {
                    data = await response.json();
                    size = getEstimatedSize(data);
                } else if (assetType === 'script' || assetType === 'style') {
                    data = await response.text();
                    size = getEstimatedSize(data);
                } else if (assetType === 'video' || assetType === 'audio') {
                    data = await response.blob();
                    size = getEstimatedSize(data);
                } else {
                    const contentType = response.headers.get('content-type') || '';
                    if (contentType.includes('application/json')) {
                        data = await response.json();
                    } else if (contentType.includes('text/')) {
                        data = await response.text();
                    } else {
                        data = await response.blob();
                    }
                    size = getEstimatedSize(data);
                }

                _state.totalRequests++;
                _state.successfulRequests++;

                const entry = {
                    data,
                    type: assetType,
                    status: 'loaded',
                    loadedAt: Date.now(),
                    lastAccessedAt: Date.now(), // [FIX 5]
                    accessCount: 0,
                    expires: options.cacheTTL ? Date.now() + options.cacheTTL : null,
                    size,
                    metadata: { url, ...options.metadata },
                };
                _state.cache.set(cacheKey, entry);
                _state.totalBytes += size;

                enforceCacheLimits();

                emit('loaded', { url, type: assetType, size });
                return data;

            } catch (err) {
                if (timeoutId !== null) clearTimeout(timeoutId); // [FIX 11]
                attempt++;

                if (attempt < retryAttempts) {
                    const delay = retryDelay * Math.pow(2, attempt - 1);
                    emit('retry', { url, attempt, delay });
                    await new Promise((r) => setTimeout(r, delay));
                    return fetchWithRetry();
                }

                _state.totalRequests++;
                _state.failedRequests++;
                emit('failed', { url, error: err.message, attempts: attempt });
                throw err;
            }
        };

        return fetchWithRetry();
    }

    // ---------- Lazy Loading (Intersection Observer) ----------
    function setupLazyLoading() {
        if (_state._lazyObserver) return;
        if (!hasIntersectionObserver || !hasDocument) {
            warnLog('[AssetManager] IntersectionObserver unavailable — lazy loading disabled.');
            return;
        }

        const observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting) {
                    const target = entry.target;
                    const url = target.dataset.lazySrc || target.dataset.src;
                    if (url) {
                        AssetManager.load(url).then(() => {
                            if (target.tagName === 'IMG') {
                                target.src = url;
                            } else if (target.style && target.dataset.lazyBg) {
                                target.style.backgroundImage = `url(${url})`;
                            }
                            target.dataset.lazyLoaded = 'true';
                            target.removeAttribute('data-lazy-src');
                            emit('lazyLoaded', { url, element: target });
                        }).catch(() => {
                            if (target.dataset.lazyFallback && target.tagName === 'IMG') {
                                target.src = target.dataset.lazyFallback;
                            }
                        });
                    }
                    observer.unobserve(target);
                }
            }
        }, { rootMargin: `${_state.config.lazyLoadThreshold}px` });

        _state._lazyObserver = observer;
    }

    // ---------- Preload Queue Processing ----------
    // [FIX 6] Drains high -> normal -> low, so high-priority assets aren't
    // stuck behind unrelated lower-priority requests in a single FIFO.
    function processPreloadQueue() {
        const order = ['high', 'normal', 'low'];

        while (_state.currentPreloads < _state.config.preloadConcurrency) {
            let url = null;
            for (const level of order) {
                const bucket = _state.preloadQueues[level];
                if (bucket.size > 0) {
                    url = bucket.values().next().value;
                    bucket.delete(url);
                    break;
                }
            }
            if (url === null) break; // all buckets empty

            _state.currentPreloads++;
            AssetManager.load(url, { priority: 'high' })
                .catch(() => { /* failure already emitted by fetchAsset */ })
                .finally(() => {
                    _state.currentPreloads--;
                    processPreloadQueue();
                });
        }
    }

    // ---------- Public API ----------
    const AssetManager = {

        init() {
            if (_state.isInitialized) return this;

            _state.isInitialized = true;
            _state.isDestroyed = false;
            _state.cache.clear();
            _state.loading.clear();
            _state.preloadQueues.high.clear();
            _state.preloadQueues.normal.clear();
            _state.preloadQueues.low.clear();
            _state.totalBytes = 0;
            _state.totalRequests = 0;
            _state.successfulRequests = 0;
            _state.failedRequests = 0;

            setupLazyLoading();

            emit('initialized', { config: { ..._state.config } });
            log('[AssetManager] Initialized.');
            return this;
        },

        load(url, options = {}) {
            if (_state.isDestroyed) {
                return Promise.reject(new Error('AssetManager is destroyed'));
            }
            if (!url || typeof url !== 'string') {
                return Promise.reject(new Error('Invalid URL'));
            }

            const {
                type = 'auto',
                timeout = _state.config.defaultTimeout,
                retryAttempts = _state.config.retryAttempts,
                cacheTTL = null,
                force = false,
                credentials = 'same-origin',
                headers = {},
                metadata = {},
            } = options;

            // [FIX 1] Computed ONCE here, passed straight through to
            // fetchAsset — no separate/divergent key computation downstream.
            const cacheKey = generateCacheKey(url, { type, ...options });

            if (!force) {
                const cached = _state.cache.get(cacheKey);
                if (cached && !isAssetExpired(cached)) {
                    return Promise.resolve(cached.data);
                }
            }

            if (_state.loading.has(cacheKey)) {
                return _state.loading.get(cacheKey);
            }

            const perf = getPerformanceEngine();
            const start = perf ? now() : 0;

            const promise = fetchAsset(url, cacheKey, {
                timeout,
                retryAttempts,
                retryDelay: _state.config.retryDelay,
                type,
                credentials,
                headers,
                metadata,
                cacheTTL,
                force, // [FIX 2]
            }).then((data) => {
                if (perf && typeof perf.trackRuntimeOperation === 'function') {
                    perf.trackRuntimeOperation(`asset:load:${getAssetType(url)}`, now() - start);
                }
                return data;
            });

            _state.loading.set(cacheKey, promise);
            return promise.finally(() => {
                _state.loading.delete(cacheKey);
            });
        },

        // [FIX 6] priority now actually determines which bucket the URL
        // enters, and processPreloadQueue() drains high first.
        preload(assets, options = {}) {
            if (_state.isDestroyed) return;

            const urls = Array.isArray(assets) ? assets : [assets];
            const { priority = 'normal', type = 'auto' } = options;
            const level = ['high', 'normal', 'low'].includes(priority) ? priority : 'normal';

            for (const url of urls) {
                if (!url || typeof url !== 'string') continue;

                const cacheKey = generateCacheKey(url, { type, ...options });
                if (_state.cache.has(cacheKey)) continue;
                if (_state.loading.has(cacheKey)) continue;

                _state.preloadQueues[level].add(url);
                emit('preloadQueued', { url, priority: level });
            }

            if (level === 'high') {
                processPreloadQueue();
                return;
            }

            // [FIX 7] Route the debounce through the Scheduler when
            // available, matching the rest of the runtime's timing model.
            const scheduler = getScheduler();
            if (_state._preloadTaskId !== null) {
                if (scheduler && typeof scheduler.cancel === 'function' && typeof _state._preloadTaskId === 'number') {
                    scheduler.cancel(_state._preloadTaskId);
                } else {
                    clearTimeout(_state._preloadTaskId);
                }
                _state._preloadTaskId = null;
            }

            const runProcessing = () => {
                processPreloadQueue();
                _state._preloadTaskId = null;
            };

            if (scheduler && typeof scheduler.after === 'function') {
                _state._preloadTaskId = scheduler.after(runProcessing, 50);
            } else {
                _state._preloadTaskId = setTimeout(runProcessing, 50);
            }
        },

        // [FIX 5] get() now updates lastAccessedAt/accessCount, which
        // eviction relies on for real LRU behavior.
        get(url, options = {}) {
            if (_state.isDestroyed) return null;
            const { type = 'auto' } = options;
            const cacheKey = generateCacheKey(url, { type, ...options });
            const entry = _state.cache.get(cacheKey);
            if (entry && !isAssetExpired(entry)) {
                entry.lastAccessedAt = Date.now();
                entry.accessCount = (entry.accessCount || 0) + 1;
                return entry.data;
            }
            return null;
        },

        has(url, options = {}) {
            return this.get(url, options) !== null;
        },

        isLoading(url, options = {}) {
            const { type = 'auto' } = options;
            const cacheKey = generateCacheKey(url, { type, ...options });
            return _state.loading.has(cacheKey);
        },

        getStatus(url, options = {}) {
            const { type = 'auto' } = options;
            const cacheKey = generateCacheKey(url, { type, ...options });
            if (_state.cache.has(cacheKey)) {
                const entry = _state.cache.get(cacheKey);
                if (isAssetExpired(entry)) return 'failed';
                return 'loaded';
            }
            if (_state.loading.has(cacheKey)) return 'loading';
            return 'unknown';
        },

        release(url, options = {}) {
            const { type = 'auto' } = options;
            const cacheKey = generateCacheKey(url, { type, ...options });
            const entry = _state.cache.get(cacheKey);
            if (entry) {
                if (hasURL && entry.data && typeof entry.data === 'object' && entry.data._blobUrl) {
                    try {
                        URL.revokeObjectURL(entry.data._blobUrl);
                    } catch (_) { /* ignore */ }
                }
                _state.totalBytes -= getAssetSize(entry);
                _state.cache.delete(cacheKey);
                emit('released', { url });
                return true;
            }
            return false;
        },

        clearCache() {
            const count = _state.cache.size;
            for (const [, entry] of _state.cache) {
                if (hasURL && entry.data && typeof entry.data === 'object' && entry.data._blobUrl) {
                    try {
                        URL.revokeObjectURL(entry.data._blobUrl);
                    } catch (_) { /* ignore */ }
                }
            }
            _state.cache.clear();
            _state.totalBytes = 0;
            emit('cacheCleared', { count });
            log(`[AssetManager] Cache cleared (${count} entries).`);
        },

        destroy() {
            if (_state.isDestroyed) return;
            _state.isDestroyed = true;
            _state.isInitialized = false;

            this.clearCache();
            _state.loading.clear();
            _state.preloadQueues.high.clear();
            _state.preloadQueues.normal.clear();
            _state.preloadQueues.low.clear();

            if (_state._preloadTaskId !== null) {
                const scheduler = getScheduler();
                if (scheduler && typeof scheduler.cancel === 'function' && typeof _state._preloadTaskId === 'number') {
                    scheduler.cancel(_state._preloadTaskId);
                } else {
                    clearTimeout(_state._preloadTaskId);
                }
                _state._preloadTaskId = null;
            }

            if (_state._lazyObserver) {
                _state._lazyObserver.disconnect();
                _state._lazyObserver = null;
            }

            emit('destroyed');
            log('[AssetManager] Destroyed.');
        },

        observeLazy(elements) {
            if (!_state._lazyObserver || !hasDocument) return;
            const els = typeof elements === 'string'
                ? document.querySelectorAll(elements)
                : (elements instanceof NodeList ? elements : [elements]);
            for (const el of els) {
                if (el && el.tagName) _state._lazyObserver.observe(el);
            }
        },

        unobserveLazy(elements) {
            if (!_state._lazyObserver || !hasDocument) return;
            const els = typeof elements === 'string'
                ? document.querySelectorAll(elements)
                : (elements instanceof NodeList ? elements : [elements]);
            for (const el of els) {
                if (el && el.tagName) _state._lazyObserver.unobserve(el);
            }
        },

        // [FIX 15] Basic validation — rejects non-numeric/non-positive
        // values instead of silently accepting anything.
        configure(config = {}) {
            const numeric = [
                'maxCacheSize', 'maxCacheBytes', 'defaultTimeout',
                'retryAttempts', 'retryDelay', 'preloadConcurrency', 'lazyLoadThreshold',
            ];
            for (const key of numeric) {
                if (config[key] !== undefined) {
                    if (typeof config[key] !== 'number' || !isFinite(config[key]) || config[key] < 0) {
                        warnLog(`[AssetManager] configure: ignoring invalid value for "${key}":`, config[key]);
                        continue;
                    }
                    _state.config[key] = config[key];
                }
            }
            if (config.fallbackImage !== undefined) {
                _state.config.fallbackImage = config.fallbackImage;
            }
            if (config.enableCompression !== undefined) {
                _state.config.enableCompression = !!config.enableCompression; // not yet implemented — see backlog
            }
            emit('configured', { config: { ..._state.config } });
            log('[AssetManager] Configured:', _state.config);
            return this;
        },

        getConfig() {
            return { ..._state.config };
        },

        diagnostics() {
            const cacheInfo = [];
            for (const [key, entry] of _state.cache) {
                cacheInfo.push({
                    key,
                    type: entry.type,
                    status: entry.status,
                    size: entry.size,
                    loadedAt: entry.loadedAt,
                    lastAccessedAt: entry.lastAccessedAt,
                    accessCount: entry.accessCount,
                    expires: entry.expires,
                });
            }

            return {
                initialized: _state.isInitialized,
                destroyed: _state.isDestroyed,
                config: { ..._state.config },
                cache: {
                    size: _state.cache.size,
                    totalBytes: _state.totalBytes,
                    maxSize: _state.config.maxCacheSize,
                    maxBytes: _state.config.maxCacheBytes,
                    entries: cacheInfo.slice(0, 20),
                },
                loading: {
                    count: _state.loading.size,
                    keys: Array.from(_state.loading.keys()).slice(0, 10),
                },
                preload: {
                    high: _state.preloadQueues.high.size,
                    normal: _state.preloadQueues.normal.size,
                    low: _state.preloadQueues.low.size,
                    currentPreloads: _state.currentPreloads,
                },
                requests: {
                    total: _state.totalRequests,
                    successful: _state.successfulRequests,
                    failed: _state.failedRequests,
                    successRate: _state.totalRequests > 0
                        ? ((_state.successfulRequests / _state.totalRequests) * 100).toFixed(1) + '%'
                        : 'N/A',
                },
                lazyObserver: !!_state._lazyObserver,
                timestamp: Date.now(),
            };
        },
    };

    // ---------- Expose to Global ----------
    global.AssetManager = AssetManager;

    // Load-order dependency (same caveat as Scheduler/PerformanceEngine):
    // only attaches if global.Runtime already exists at this moment.
    if (global.Runtime) {
        global.Runtime.AssetManager = AssetManager;
    }

    log('[AssetManager] Loaded and ready. Call AssetManager.init() to start.');

})(typeof window !== 'undefined' ? window : this);
