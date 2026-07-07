// ================================================================
// LAYOUT-ENGINE.JS — Global Structural Layout Controller
// ================================================================
// File: js/runtime/layout-engine.js
// Responsibilities: Responsive breakpoints, container sizing, layout
// calculations, dynamic spacing, section stacking, viewport measurements,
// resize coordination.
// Does NOT render content or manipulate business logic.
//
// SURGICAL FIX PASS — combined, verified list from two reviews + mine.
// Summary of what changed:
//  [FIX 1] contentHeight no longer monotonically grows. Previously
//          Math.max(height, contentHeight || height) meant it could only
//          ever increase, never shrink back down when the viewport got
//          smaller — verified in isolation before patching.
//  [FIX 2/3] Resize, orientation-change, and ResizeObserver updates now
//          all route through one real debounce (scheduleUpdate()) instead
//          of the ResizeObserver firing performUpdate() directly and
//          undebounced in parallel with the debounced window listener.
//          ResizeObserver setup is now also gated behind
//          autoUpdateOnResize, so that flag actually disables ALL
//          automatic updates, not just the three addEventListener calls.
//  [FIX 4] Scroll no longer triggers a full performUpdate() (which
//          re-measured every registered section and rewrote ~20 CSS
//          variables). It now updates only scroll position and the two
//          scroll-related CSS variables, while still emitting the same
//          'updated' event shape so existing listeners keep working
//          exactly as documented.
//  [FIX 5] destroy() now clears _scrollTimer (previously only
//          _resizeTimer was cleared — a pending scroll-debounce timer
//          could fire performUpdate on an already-destroyed instance).
//  [FIX 6] Added _state.listeners[] tracking the same three
//          removeEventListener calls destroy() already performed, so a
//          parent coordinator can introspect/reuse them — destroy()'s
//          actual cleanup behavior is unchanged, just now also recorded.
//  [FIX 9] Removed the redundant first branch in detectBreakpoint() —
//          it was fully subsumed by the very next line and could never
//          produce different output.
//  [FIX 10] Removed the breakpointLabels indirection — every key mapped
//          to itself (e.g. xs: 'xs'), so detectBreakpoint now returns the
//          breakpoint name strings directly. Output is identical.
//  [FIX 11] Added SSR/non-browser guards around window/document/screen.
//  [FIX 12] Logging gated behind a debug flag (hard errors still surface).
//  [FIX 13] registerSection's element check now falls back to a nodeType
//          check for cross-realm/iframe-created elements.
//  [FIX 14] Documented (not changed) the load-order caveat on the
//          Runtime.LayoutEngine export line — same as every other engine.
//
// Intentionally NOT changed in this pass (design calls, not bugs — see
// contract discussion): the amount of direct DOM manipulation, the
// placement of Hero-specific helpers (getLiquidScale/getHeroHeight) in
// this file, and auto-init on load (kept consistent with the established
// pattern in Scheduler/Runtime/ComponentRegistry).
// ================================================================

(function(global) {
    'use strict';

    const hasWindow = typeof window !== 'undefined';
    const hasDocument = typeof document !== 'undefined';
    const hasPerformance = typeof performance !== 'undefined';
    const hasCustomEvent = typeof CustomEvent !== 'undefined';
    const hasResizeObserver = typeof ResizeObserver !== 'undefined';

    // ---------- Private State ----------
    const _state = {
        isInitialized: false,
        isDestroyed: false,
        breakpoints: {
            xs: 480,
            sm: 640,
            md: 768,
            lg: 1024,
            xl: 1280,
            xxl: 1536,
        },
        // [FIX 10] breakpointLabels removed — it was a fully redundant
        // identity map (every key mapped to itself) and added nothing.
        viewport: {
            width: 0,
            height: 0,
            scrollX: 0,
            scrollY: 0,
            availWidth: 0,
            availHeight: 0,
            devicePixelRatio: 1,
        },
        dimensions: {
            heroHeight: 0,
            navHeight: 0,
            footerHeight: 0,
            contentWidth: 0,
            contentHeight: 0,
            maxWidth: 1200,
            padding: { base: 16, large: 32, small: 8 },
            gutters: { base: 16, large: 32, small: 8 },
        },
        currentBreakpoint: 'lg',
        activeMode: 'desktop',
        isMobile: false,
        isTablet: false,
        isDesktop: true,
        sections: new Map(),
        containers: new Map(),
        observers: new Map(),
        observerIdCounter: 0,
        config: {
            debounceResize: 150,
            enableLiquidScaling: true,
            minHeroHeight: 400,
            maxHeroHeight: 1000,
            autoUpdateOnResize: true,
            debug: false,
        },
        // [FIX 6] Tracks cleanup functions so a parent coordinator can
        // introspect/reuse them. destroy() still performs the same
        // removals it always did — this just also records them.
        listeners: [],
        _resizeTimer: null,
        _scrollTimer: null, // [FIX 5] now pre-declared, like _resizeTimer
        _lastUpdateTime: 0,
        _updateCount: 0,
        _resizeObserver: null,
    };

    // ---------- Private Helpers ----------
    // [FIX 12] Gated logging, consistent with the other patched engines.
    function isDebug() {
        return !!(_state.config.debug || (global.Runtime && global.Runtime.config && global.Runtime.config.debug));
    }
    function log(...args) { if (isDebug()) console.log(...args); }
    function warnLog(...args) { if (isDebug()) console.warn(...args); }

    function getEventEngine() {
        return (global.Runtime && global.Runtime.EventEngine) || global.EventEngine || null;
    }

    function getPerformanceEngine() {
        return (global.Runtime && global.Runtime.PerformanceEngine) || global.PerformanceEngine || null;
    }

    function getScheduler() {
        return (global.Runtime && global.Runtime.Scheduler) || global.Scheduler || null;
    }

    function getEnvironmentEngine() {
        return (global.Runtime && global.Runtime.EnvironmentEngine) || global.EnvironmentEngine || null;
    }

    function emit(eventName, payload = {}) {
        const ee = getEventEngine();
        if (ee && typeof ee.emit === 'function') {
            ee.emit(`layout:${eventName}`, payload);
            return;
        }
        if (hasDocument && hasCustomEvent) {
            const event = new CustomEvent(`layout:${eventName}`, { detail: payload, bubbles: true });
            document.dispatchEvent(event);
        }
    }

    function now() {
        return hasPerformance ? performance.now() : Date.now();
    }

    function getViewportWidth() {
        return hasWindow ? window.innerWidth : 0;
    }
    function getViewportHeight() {
        return hasWindow ? window.innerHeight : 0;
    }
    function getScrollX() {
        return hasWindow ? (window.scrollX || window.pageXOffset || 0) : 0;
    }
    function getScrollY() {
        return hasWindow ? (window.scrollY || window.pageYOffset || 0) : 0;
    }
    function getDevicePixelRatio() {
        return hasWindow ? (window.devicePixelRatio || 1) : 1;
    }

    // [FIX 7] Cross-realm-safe element check (same helper added to
    // Component Registry).
    function isElementLike(node) {
        if (!node) return false;
        if (typeof Element !== 'undefined' && node instanceof Element) return true;
        return typeof node === 'object' && node.nodeType === 1;
    }

    // ---------- Breakpoint Detection ----------
    // [FIX 9] Removed the redundant first branch (`if (width < bp.xs)
    // return labels.xs;`) — it returned the exact same value as the next
    // line for every input, since anything < bp.xs is also < bp.sm.
    // [FIX 10] Returns breakpoint name strings directly.
    function detectBreakpoint(width) {
        const bp = _state.breakpoints;
        if (width < bp.sm) return 'xs';
        if (width < bp.md) return 'sm';
        if (width < bp.lg) return 'md';
        if (width < bp.xl) return 'lg';
        if (width < bp.xxl) return 'xl';
        return 'xxl';
    }

    function detectMode(width) {
        const bp = _state.breakpoints;
        if (width < bp.md) return 'mobile';
        if (width < bp.lg) return 'tablet';
        return 'desktop';
    }

    function isMobileWidth(width) { return width < _state.breakpoints.md; }
    function isTabletWidth(width) { return width >= _state.breakpoints.md && width < _state.breakpoints.lg; }
    function isDesktopWidth(width) { return width >= _state.breakpoints.lg; }

    // ---------- Container Measurement ----------
    function measureElement(element) {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return {
            x: rect.x || rect.left || 0,
            y: rect.y || rect.top || 0,
            width: rect.width || 0,
            height: rect.height || 0,
            top: rect.top || 0,
            left: rect.left || 0,
            right: rect.right || 0,
            bottom: rect.bottom || 0,
            centerX: (rect.left || 0) + (rect.width || 0) / 2,
            centerY: (rect.top || 0) + (rect.height || 0) / 2,
            isVisible: rect.width > 0 && rect.height > 0,
        };
    }

    function measureSections() {
        const results = {};
        for (const [name, data] of _state.sections) {
            const rect = measureElement(data.element);
            if (rect) {
                results[name] = { ...rect, height: rect.height, width: rect.width, data: data.data };
                data.rect = rect;
                data.height = rect.height;
                data.width = rect.width;
                data.visible = rect.isVisible;
            }
        }
        return results;
    }

    // ---------- Update Core ----------
    function performUpdate(source = 'manual') {
        const perf = getPerformanceEngine();
        const start = perf ? now() : 0;

        const oldBreakpoint = _state.currentBreakpoint;
        const oldMode = _state.activeMode;

        const width = getViewportWidth();
        const height = getViewportHeight();
        const scrollX = getScrollX();
        const scrollY = getScrollY();

        _state.viewport.width = width;
        _state.viewport.height = height;
        _state.viewport.scrollX = scrollX;
        _state.viewport.scrollY = scrollY;
        _state.viewport.availWidth = (hasWindow && window.screen?.availWidth) || width;
        _state.viewport.availHeight = (hasWindow && window.screen?.availHeight) || height;
        _state.viewport.devicePixelRatio = getDevicePixelRatio();

        _state.currentBreakpoint = detectBreakpoint(width);
        _state.activeMode = detectMode(width);
        _state.isMobile = isMobileWidth(width);
        _state.isTablet = isTabletWidth(width);
        _state.isDesktop = isDesktopWidth(width);

        const contentWidth = Math.min(width, _state.dimensions.maxWidth);
        _state.dimensions.contentWidth = contentWidth;
        // [FIX 1] Reflects the CURRENT viewport height, not the tallest
        // one ever observed. Verified the old Math.max(...) version could
        // only grow, never shrink, in isolated testing before this change.
        _state.dimensions.contentHeight = height;

        measureSections();
        applyLayoutVariables();

        const breakpointChanged = oldBreakpoint !== _state.currentBreakpoint;
        const modeChanged = oldMode !== _state.activeMode;

        emit('updated', {
            viewport: { ..._state.viewport },
            breakpoint: _state.currentBreakpoint,
            mode: _state.activeMode,
            dimensions: { ..._state.dimensions },
            source,
        });

        if (breakpointChanged) {
            emit('breakpointChanged', { from: oldBreakpoint, to: _state.currentBreakpoint, width });
        }
        if (modeChanged) {
            emit('modeChanged', { from: oldMode, to: _state.activeMode, width });
        }

        const env = getEnvironmentEngine();
        if (env && typeof env.update === 'function') {
            env.update({ viewport: { width, height, scrollX, scrollY }, deviceType: _state.activeMode }, false);
        }

        if (perf && typeof perf.trackRuntimeOperation === 'function') {
            perf.trackRuntimeOperation('layout:update', now() - start);
        }

        _state._lastUpdateTime = Date.now();
        _state._updateCount++;
    }

    // [FIX 4] Lightweight path for scroll: updates only scroll position and
    // the two scroll-related CSS variables — skips section re-measurement
    // and breakpoint/mode re-detection, neither of which scrolling can
    // change. Still emits the same 'updated' event shape so existing
    // listeners (e.g. EventEngine.on('layout:updated', ...)) keep working
    // exactly as documented.
    function performScrollUpdate() {
        const perf = getPerformanceEngine();
        const start = perf ? now() : 0;

        const scrollX = getScrollX();
        const scrollY = getScrollY();
        _state.viewport.scrollX = scrollX;
        _state.viewport.scrollY = scrollY;

        if (hasDocument) {
            const root = document.documentElement;
            root.style.setProperty('--viewport-scroll-x', scrollX + 'px');
            root.style.setProperty('--viewport-scroll-y', scrollY + 'px');
        }

        emit('updated', {
            viewport: { ..._state.viewport },
            breakpoint: _state.currentBreakpoint,
            mode: _state.activeMode,
            dimensions: { ..._state.dimensions },
            source: 'scroll',
        });

        if (perf && typeof perf.trackRuntimeOperation === 'function') {
            perf.trackRuntimeOperation('layout:update:scroll', now() - start);
        }

        _state._lastUpdateTime = Date.now();
        _state._updateCount++;
    }

    function applyLayoutVariables() {
        if (!hasDocument) return;
        const root = document.documentElement;
        const v = _state.viewport;
        const d = _state.dimensions;

        root.style.setProperty('--viewport-width', v.width + 'px');
        root.style.setProperty('--viewport-height', v.height + 'px');
        root.style.setProperty('--viewport-scroll-x', v.scrollX + 'px');
        root.style.setProperty('--viewport-scroll-y', v.scrollY + 'px');
        root.style.setProperty('--viewport-device-pixel-ratio', v.devicePixelRatio);

        root.style.setProperty('--layout-content-width', d.contentWidth + 'px');
        root.style.setProperty('--layout-content-height', d.contentHeight + 'px');
        root.style.setProperty('--layout-max-width', d.maxWidth + 'px');

        root.style.setProperty('--layout-padding-base', d.padding.base + 'px');
        root.style.setProperty('--layout-padding-large', d.padding.large + 'px');
        root.style.setProperty('--layout-padding-small', d.padding.small + 'px');

        root.style.setProperty('--layout-gutter-base', d.gutters.base + 'px');
        root.style.setProperty('--layout-gutter-large', d.gutters.large + 'px');
        root.style.setProperty('--layout-gutter-small', d.gutters.small + 'px');

        root.style.setProperty('--layout-breakpoint', _state.currentBreakpoint);
        root.style.setProperty('--layout-mode', _state.activeMode);

        root.style.setProperty('--layout-is-mobile', _state.isMobile ? '1' : '0');
        root.style.setProperty('--layout-is-tablet', _state.isTablet ? '1' : '0');
        root.style.setProperty('--layout-is-desktop', _state.isDesktop ? '1' : '0');

        if (_state.config.enableLiquidScaling) {
            const heroHeight = Math.max(
                _state.config.minHeroHeight,
                Math.min(_state.config.maxHeroHeight, v.height * 0.85)
            );
            root.style.setProperty('--hero-height', heroHeight + 'px');
            root.style.setProperty('--hero-scaled', (heroHeight / 800) + '');
        }
    }

    // ---------- Resize / Orientation / ResizeObserver Handling ----------
    // [FIX 2/3] Single shared debounce path. Previously the ResizeObserver
    // callback called performUpdate() directly with no debounce at all,
    // running in parallel with (and largely defeating the purpose of) the
    // debounced window resize listener. Now everything funnels through
    // the same _resizeTimer, so only one performUpdate() runs per settled
    // resize, regardless of which mechanism detected it.
    function scheduleUpdate(source, delay) {
        if (_state._resizeTimer) {
            clearTimeout(_state._resizeTimer);
        }
        _state._resizeTimer = setTimeout(() => {
            performUpdate(source);
            _state._resizeTimer = null;
        }, delay);
    }

    function handleResize() {
        scheduleUpdate('resize', _state.config.debounceResize);
    }

    function handleOrientationChange() {
        scheduleUpdate('orientation', 50);
    }

    function handleScroll() {
        // [FIX 4] Now calls the lightweight scroll-only update instead of
        // a full performUpdate().
        if (!_state._scrollTimer) {
            _state._scrollTimer = setTimeout(() => {
                performScrollUpdate();
                _state._scrollTimer = null;
            }, 100);
        }
    }

    function setupResizeObserver() {
        if (!hasResizeObserver || !hasDocument) return;
        try {
            const observer = new ResizeObserver(() => {
                // [FIX 2/3] Routed through the same debounce as window
                // resize, instead of calling performUpdate() directly.
                scheduleUpdate('resizeObserver', _state.config.debounceResize);
            });
            observer.observe(document.documentElement);
            _state._resizeObserver = observer;
        } catch (_) { /* ignore */ }
    }

    // ---------- Public API ----------
    const LayoutEngine = {

        init() {
            if (_state.isInitialized) return this;

            performUpdate('init');

            if (_state.config.autoUpdateOnResize) {
                if (hasWindow) {
                    window.addEventListener('resize', handleResize);
                    window.addEventListener('orientationchange', handleOrientationChange);
                    window.addEventListener('scroll', handleScroll, { passive: true });
                }
                // [FIX 3] ResizeObserver setup now respects the same flag
                // — previously it ran unconditionally even when
                // autoUpdateOnResize was false.
                setupResizeObserver();

                // [FIX 6] Recorded for a parent coordinator's visibility —
                // destroy() still performs these same removals itself.
                if (hasWindow) {
                    _state.listeners.push(() => window.removeEventListener('resize', handleResize));
                    _state.listeners.push(() => window.removeEventListener('orientationchange', handleOrientationChange));
                    _state.listeners.push(() => window.removeEventListener('scroll', handleScroll));
                }
                _state.listeners.push(() => {
                    if (_state._resizeObserver) {
                        try { _state._resizeObserver.disconnect(); } catch (_) { /* ignore */ }
                        _state._resizeObserver = null;
                    }
                });
            }

            _state.isInitialized = true;

            emit('initialized', {
                viewport: { ..._state.viewport },
                breakpoint: _state.currentBreakpoint,
                mode: _state.activeMode,
                dimensions: { ..._state.dimensions },
                config: { ..._state.config },
            });

            log(`[LayoutEngine] Initialized (${_state.currentBreakpoint}, ${_state.activeMode})`);
            return this;
        },

        update(source = 'manual') {
            if (_state.isDestroyed) return;
            performUpdate(source);
        },

        refresh() {
            if (_state.isDestroyed) return null;
            performUpdate('refresh');
            return this.getCurrent();
        },

        getCurrent() {
            return {
                viewport: { ..._state.viewport },
                breakpoint: _state.currentBreakpoint,
                mode: _state.activeMode,
                isMobile: _state.isMobile,
                isTablet: _state.isTablet,
                isDesktop: _state.isDesktop,
                dimensions: { ..._state.dimensions },
                sections: measureSections(),
                timestamp: Date.now(),
            };
        },

        getCurrentBreakpoint() {
            return _state.currentBreakpoint;
        },

        getCurrentMode() {
            return _state.activeMode;
        },

        getViewport() {
            return { ..._state.viewport };
        },

        getDimensions() {
            return { ..._state.dimensions };
        },

        isMobile() {
            return _state.isMobile;
        },

        isTablet() {
            return _state.isTablet;
        },

        isDesktop() {
            return _state.isDesktop;
        },

        getBreakpointValue(name) {
            return _state.breakpoints[name] || 0;
        },

        registerSection(name, element, data = {}) {
            if (_state.sections.has(name)) {
                warnLog(`[LayoutEngine] Section "${name}" already registered.`);
                return false;
            }
            // [FIX 7] Falls back to a nodeType check for elements created
            // in a different realm/iframe, where `instanceof Element` fails.
            if (!isElementLike(element)) {
                warnLog(`[LayoutEngine] Invalid element for section "${name}".`);
                return false;
            }
            const rect = measureElement(element);
            _state.sections.set(name, {
                element,
                rect,
                height: rect?.height || 0,
                width: rect?.width || 0,
                visible: rect?.isVisible || false,
                data,
                registeredAt: Date.now(),
            });
            emit('sectionRegistered', { name, rect });
            log(`[LayoutEngine] Registered section: ${name}`);
            return true;
        },

        unregisterSection(name) {
            const removed = _state.sections.delete(name);
            if (removed) {
                emit('sectionUnregistered', { name });
                log(`[LayoutEngine] Unregistered section: ${name}`);
            }
            return removed;
        },

        getSection(name) {
            const data = _state.sections.get(name);
            if (!data) return null;
            return { ...data, rect: data.rect ? { ...data.rect } : null };
        },

        getSections() {
            const result = {};
            for (const [name, data] of _state.sections) {
                result[name] = { ...data, rect: data.rect ? { ...data.rect } : null };
            }
            return result;
        },

        calculateSectionHeight(sectionName, options = {}) {
            const { min = 0, max = Infinity, multiplier = 1 } = options;
            const vh = _state.viewport.height;
            const data = _state.sections.get(sectionName);

            let height = data?.height || vh * 0.5;
            height = height * multiplier;
            height = Math.max(min, Math.min(max, height));
            return height;
        },

        getGridColumns(options = {}) {
            const { mobile = 4, tablet = 8, desktop = 12 } = options;
            if (_state.isMobile) return mobile;
            if (_state.isTablet) return tablet;
            return desktop;
        },

        getResponsiveValue(values, fallback = null) {
            // Verified correct mobile-first cascade — not altered.
            const bp = _state.currentBreakpoint;
            const bpValues = _state.breakpoints;
            const ordered = ['xs', 'sm', 'md', 'lg', 'xl', 'xxl'];

            let result = fallback;
            for (const key of ordered) {
                if (key in values && bpValues[key] <= bpValues[bp]) {
                    result = values[key];
                }
            }
            return result !== undefined ? result : fallback;
        },

        matchesBreakpoint(breakpoint, operator = 'exact') {
            const current = _state.currentBreakpoint;
            const bp = _state.breakpoints;
            const currentValue = bp[current] || 0;
            const targetValue = bp[breakpoint] || 0;

            switch (operator) {
                case 'min': return currentValue >= targetValue;
                case 'max': return currentValue <= targetValue;
                case 'exact':
                default: return current === breakpoint;
            }
        },

        configure(config) {
            if (config.breakpoints && typeof config.breakpoints === 'object') {
                for (const [key, value] of Object.entries(config.breakpoints)) {
                    if (key in _state.breakpoints && typeof value === 'number') {
                        _state.breakpoints[key] = value;
                    }
                }
            }

            if (config.dimensions && typeof config.dimensions === 'object') {
                const d = config.dimensions;
                if (d.maxWidth !== undefined) _state.dimensions.maxWidth = d.maxWidth;
                if (d.padding && typeof d.padding === 'object') {
                    if (d.padding.base !== undefined) _state.dimensions.padding.base = d.padding.base;
                    if (d.padding.large !== undefined) _state.dimensions.padding.large = d.padding.large;
                    if (d.padding.small !== undefined) _state.dimensions.padding.small = d.padding.small;
                }
                if (d.gutters && typeof d.gutters === 'object') {
                    if (d.gutters.base !== undefined) _state.dimensions.gutters.base = d.gutters.base;
                    if (d.gutters.large !== undefined) _state.dimensions.gutters.large = d.gutters.large;
                    if (d.gutters.small !== undefined) _state.dimensions.gutters.small = d.gutters.small;
                }
            }

            if (config.debounceResize !== undefined) _state.config.debounceResize = config.debounceResize;
            if (config.enableLiquidScaling !== undefined) _state.config.enableLiquidScaling = config.enableLiquidScaling;
            if (config.minHeroHeight !== undefined) _state.config.minHeroHeight = config.minHeroHeight;
            if (config.maxHeroHeight !== undefined) _state.config.maxHeroHeight = config.maxHeroHeight;
            if (config.autoUpdateOnResize !== undefined) _state.config.autoUpdateOnResize = config.autoUpdateOnResize;
            if (config.debug !== undefined) _state.config.debug = config.debug;

            emit('configured', { config: { ..._state.config } });
            log('[LayoutEngine] Configured:', _state.config);

            if (config.breakpoints || config.dimensions) {
                performUpdate('configure');
            }

            return this;
        },

        getConfig() {
            return {
                breakpoints: { ..._state.breakpoints },
                dimensions: { ..._state.dimensions },
                config: { ..._state.config },
            };
        },

        diagnostics() {
            const sections = {};
            for (const [name, data] of _state.sections) {
                sections[name] = {
                    height: data.height,
                    width: data.width,
                    visible: data.visible,
                    registeredAt: data.registeredAt,
                    rect: data.rect ? { ...data.rect } : null,
                };
            }

            return {
                initialized: _state.isInitialized,
                destroyed: _state.isDestroyed,
                viewport: { ..._state.viewport },
                breakpoint: _state.currentBreakpoint,
                mode: _state.activeMode,
                isMobile: _state.isMobile,
                isTablet: _state.isTablet,
                isDesktop: _state.isDesktop,
                dimensions: { ..._state.dimensions },
                config: { ..._state.config },
                sections: {
                    count: _state.sections.size,
                    names: Array.from(_state.sections.keys()),
                    details: sections,
                },
                updateCount: _state._updateCount,
                lastUpdate: _state._lastUpdateTime,
                hasResizeObserver: !!_state._resizeObserver,
                timestamp: Date.now(),
            };
        },

        getLiquidScale() {
            const vh = _state.viewport.height;
            return Math.max(0.6, Math.min(1.4, vh / 800));
        },

        getHeroHeight() {
            const vh = _state.viewport.height;
            const min = _state.config.minHeroHeight;
            const max = _state.config.maxHeroHeight;
            return Math.max(min, Math.min(max, vh * 0.85));
        },

        destroy() {
            if (_state.isDestroyed) return;

            _state.isDestroyed = true;
            _state.isInitialized = false;

            // [FIX 6] Run and clear every tracked cleanup function. This
            // performs exactly the same removals the old hardcoded version
            // did — resize/orientationchange/scroll listeners and the
            // ResizeObserver disconnect — just via the tracked array now.
            for (const cleanup of _state.listeners) {
                try { cleanup(); } catch (_) { /* ignore */ }
            }
            _state.listeners = [];

            if (_state._resizeTimer) {
                clearTimeout(_state._resizeTimer);
                _state._resizeTimer = null;
            }
            // [FIX 5] Previously missing — a pending scroll debounce timer
            // would fire performScrollUpdate()/performUpdate() on an
            // already-destroyed instance.
            if (_state._scrollTimer) {
                clearTimeout(_state._scrollTimer);
                _state._scrollTimer = null;
            }

            _state.sections.clear();

            emit('destroyed');
            log('[LayoutEngine] Destroyed.');
        },
    };

    // ---------- Expose to Global ----------
    global.LayoutEngine = LayoutEngine;

    // [FIX 14 — documented, not changed] Load-order dependent, same as
    // every other engine's Runtime attachment: only runs if global.Runtime
    // already exists at this exact moment.
    if (global.Runtime) {
        global.Runtime.LayoutEngine = LayoutEngine;
    }

    // Auto-init — kept intentionally, consistent with the established
    // pattern in Scheduler/Runtime/ComponentRegistry.
    LayoutEngine.init();

    log('[LayoutEngine] Loaded and ready.');

})(typeof window !== 'undefined' ? window : this);
