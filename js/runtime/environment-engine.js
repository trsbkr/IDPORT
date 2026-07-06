// ================================================================
// ENVIRONMENT-ENGINE.JS — Browser/Device Environment Data
// ================================================================
// File: js/runtime/environment-engine.js
// Responsibilities: Collect and broadcast normalized environment data.
// Does NOT update Hero lighting, animate, change themes, or render UI.
// ================================================================
//
// PATCH NOTES (surgical fix pass — see chat for full rationale):
//   1. destroy() now actually removes every listener it adds (was a no-op leak).
//   2. High-frequency events (mouse/touch/scroll) broadcast a lightweight
//      partial payload instead of rebuilding the full environment state.
//   3. update() and override() now share one persistence rule instead of
//      silently conflicting (update() defaults to non-persisted/transient;
//      pass { persist: true } to make it survive like override()).
//   4. Ambient light isSupported only flips true on a real sensor reading,
//      not just because the API exists on window.
//   5. Runtime.EnvironmentEngine attachment retries briefly instead of
//      permanently failing if this script loads before runtime.js.
//
// No existing state field names, public method signatures (besides the
// additive `options` param on update()), or emitted event names were
// changed. This is additive/corrective only.
// ================================================================

(function(global) {
    'use strict';

    // ---------- Private State ----------
    const _state = {
        // Mouse / Pointer
        mouse: {
            x: 0,
            y: 0,
            clientX: 0,
            clientY: 0,
            movementX: 0,
            movementY: 0,
            pointerType: 'mouse',      // 'mouse' | 'touch' | 'pen'
            isPointerDown: false,
        },

        // Touch
        touch: {
            isTouch: false,
            maxTouchPoints: 0,
            touches: [],
            touchCount: 0,
        },

        // Screen / Viewport
        screen: {
            width: window.screen.width,
            height: window.screen.height,
            availWidth: window.screen.availWidth,
            availHeight: window.screen.availHeight,
            pixelRatio: window.devicePixelRatio || 1,
        },
        viewport: {
            width: window.innerWidth,
            height: window.innerHeight,
            scrollX: window.scrollX,
            scrollY: window.scrollY,
            maxScrollX: 0,
            maxScrollY: 0,
            scrollProgressX: 0,
            scrollProgressY: 0,
        },

        // Orientation
        orientation: {
            type: window.innerHeight > window.innerWidth ? 'portrait' : 'landscape',
            angle: 0,
        },

        // Page Visibility
        visibility: {
            state: document.visibilityState,
            hidden: document.hidden,
        },

        // Network
        network: {
            online: navigator.onLine,
            connection: null, // NetworkInformation API if available
            downlink: null,
            effectiveType: null,
            rtt: null,
        },

        // Battery
        battery: {
            level: 1,
            charging: false,
            chargingTime: 0,
            dischargingTime: Infinity,
            isSupported: false,
        },

        // Color Scheme
        colorScheme: {
            prefersDark: false,
            prefersLight: true,
            active: 'light', // 'light' | 'dark'
        },

        // Accessibility
        accessibility: {
            prefersReducedMotion: false,
            prefersReducedTransparency: false,
            prefersContrast: 'no-preference', // 'no-preference' | 'more' | 'less'
            prefersColorScheme: 'light',
        },

        // Device
        device: {
            userAgent: navigator.userAgent,
            platform: navigator.platform,
            memory: navigator.deviceMemory || null,
            cores: navigator.hardwareConcurrency || null,
            isMobile: /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent),
            isTablet: /iPad|Android(?!.*Mobile)/i.test(navigator.userAgent),
            isDesktop: !/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent),
            os: 'unknown',
            browser: 'unknown',
        },

        // Ambient Light (if available)
        light: {
            intensity: 0.5,           // 0-1 normalized
            isSupported: false,
            rawLux: null,
        },

        // Manual overrides (for testing)
        overrides: {},

        // Update tracking
        lastUpdate: Date.now(),
        updateCount: 0,
        isInitialized: false,
        listeners: new Set(),

        // --- Added for fix #1 (destroy() cleanup) and #4 (sensor teardown) ---
        // Kept separate from the pre-existing `listeners` Set above (left in
        // place untouched since other code may already reference it) so no
        // existing field's meaning or shape changes.
        _teardown: [],
        _sensor: null,
    };

    // ---------- Private Helpers ----------
    function getEventEngine() {
        return global.Runtime?.EventEngine || global.EventEngine || null;
    }

    function getStateEngine() {
        return global.Runtime?.StateEngine || global.StateEngine || null;
    }

    function getMotionEngine() {
        return global.Runtime?.MotionEngine || global.MotionEngine || null;
    }

    function emit(eventName, payload = {}) {
        const ee = getEventEngine();
        if (ee && typeof ee.emit === 'function') {
            ee.emit(`environment:${eventName}`, payload);
        } else {
            const event = new CustomEvent(`environment:${eventName}`, {
                detail: payload,
                bubbles: true,
            });
            document.dispatchEvent(event);
        }
    }

    // --- Added for fix #1: tracked listener registration so destroy() can
    // actually remove what init() adds. Wraps addEventListener 1:1; does not
    // change any existing handler's logic.
    function on(target, eventName, handler, opts) {
        target.addEventListener(eventName, handler, opts);
        _state._teardown.push({ target, eventName, handler, opts });
        return handler;
    }

    // ---------- Data Collection Methods ----------

    function collectViewportData() {
        return {
            width: window.innerWidth,
            height: window.innerHeight,
            scrollX: window.scrollX,
            scrollY: window.scrollY,
            maxScrollX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
            maxScrollY: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
            scrollProgressX: window.innerWidth > 0
                ? Math.min(1, window.scrollX / Math.max(1, document.documentElement.scrollWidth - window.innerWidth))
                : 0,
            scrollProgressY: window.innerHeight > 0
                ? Math.min(1, window.scrollY / Math.max(1, document.documentElement.scrollHeight - window.innerHeight))
                : 0,
        };
    }

    function collectOrientationData() {
        const isPortrait = window.innerHeight > window.innerWidth;
        return {
            type: isPortrait ? 'portrait' : 'landscape',
            angle: typeof window.orientation !== 'undefined' ? window.orientation : (isPortrait ? 0 : 90),
        };
    }

    function collectDeviceData() {
        const ua = navigator.userAgent;
        const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(ua);
        const isTablet = /iPad|Android(?!.*Mobile)/i.test(ua);
        let os = 'unknown';
        let browser = 'unknown';

        // OS detection
        if (ua.includes('Windows')) os = 'windows';
        else if (ua.includes('Mac OS X') || ua.includes('Macintosh')) os = 'macos';
        else if (ua.includes('Linux')) os = 'linux';
        else if (ua.includes('Android')) os = 'android';
        else if (/iPhone|iPad|iPod/.test(ua)) os = 'ios';

        // Browser detection
        if (ua.includes('Chrome') && !ua.includes('Edg')) browser = 'chrome';
        else if (ua.includes('Firefox')) browser = 'firefox';
        else if (ua.includes('Safari') && !ua.includes('Chrome')) browser = 'safari';
        else if (ua.includes('Edg')) browser = 'edge';
        else if (ua.includes('Opera') || ua.includes('OPR')) browser = 'opera';

        return {
            userAgent: ua,
            platform: navigator.platform,
            memory: navigator.deviceMemory || null,
            cores: navigator.hardwareConcurrency || null,
            isMobile,
            isTablet,
            isDesktop: !isMobile && !isTablet,
            os,
            browser,
        };
    }

    function collectColorSchemeData() {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
        return {
            prefersDark,
            prefersLight,
            active: prefersDark ? 'dark' : 'light',
        };
    }

    function collectAccessibilityData() {
        return {
            prefersReducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
            prefersReducedTransparency: window.matchMedia('(prefers-reduced-transparency: reduce)').matches,
            prefersContrast: window.matchMedia('(prefers-contrast: more)').matches ? 'more' :
                window.matchMedia('(prefers-contrast: less)').matches ? 'less' : 'no-preference',
            prefersColorScheme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
        };
    }

    function collectNetworkData() {
        const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
        return {
            online: navigator.onLine,
            connection: conn,
            downlink: conn?.downlink || null,
            effectiveType: conn?.effectiveType || null,
            rtt: conn?.rtt || null,
        };
    }

    async function collectBatteryData() {
        try {
            if ('getBattery' in navigator) {
                const battery = await navigator.getBattery();
                return {
                    level: battery.level,
                    charging: battery.charging,
                    chargingTime: battery.chargingTime,
                    dischargingTime: battery.dischargingTime,
                    isSupported: true,
                };
            }
        } catch (_) { /* ignore */ }
        return {
            level: 1,
            charging: false,
            chargingTime: 0,
            dischargingTime: Infinity,
            isSupported: false,
        };
    }

    function collectLightData() {
        // --- Fix #4: no longer claims isSupported just because the API name
        // exists on window. isSupported now only flips true in init() once a
        // real 'reading' event has actually fired (or a real error confirms
        // it can't). Shape of the returned object is unchanged.
        return { intensity: 0.5, isSupported: false, rawLux: null };
    }

    // ---------- Build Full Environment State ----------
    function buildEnvironmentState(overrides = {}) {
        const viewport = collectViewportData();
        const orientation = collectOrientationData();
        const device = collectDeviceData();
        const colorScheme = collectColorSchemeData();
        const accessibility = collectAccessibilityData();
        const network = collectNetworkData();

        return {
            mouse: { ..._state.mouse },
            touch: {
                isTouch: 'ontouchstart' in window || navigator.maxTouchPoints > 0,
                maxTouchPoints: navigator.maxTouchPoints || 0,
                touches: _state.touch.touches || [],
                touchCount: _state.touch.touchCount || 0,
            },
            screen: { ..._state.screen },
            viewport,
            orientation,
            visibility: {
                state: document.visibilityState,
                hidden: document.hidden,
            },
            network,
            battery: { ..._state.battery },
            colorScheme,
            accessibility,
            device,
            light: { ..._state.light },
            timestamp: Date.now(),
            ...overrides,
        };
    }

    // ---------- Broadcast Update (full recompute) ----------
    function broadcastUpdate(overrides = {}) {
        const data = buildEnvironmentState(overrides);
        _state.lastUpdate = Date.now();
        _state.updateCount++;

        emit('update', data);

        // Also sync to StateEngine
        const se = getStateEngine();
        if (se && typeof se.set === 'function') {
            se.set('screenWidth', data.viewport.width, true);
            se.set('screenHeight', data.viewport.height, true);
            se.set('online', data.network.online, true);
            se.set('deviceType', data.device.isMobile ? 'mobile' :
                data.device.isTablet ? 'tablet' : 'desktop', true);
            se.set('touch', data.touch.isTouch, true);
            se.set('orientation', data.orientation.type, true);
            se.set('prefersReducedMotion', data.accessibility.prefersReducedMotion, true);
        }

        return data;
    }

    // --- Fix #2: lightweight broadcast for high-frequency events (mouse,
    // touch, scroll-driven pointer state). Skips the expensive device /
    // colorScheme / accessibility recomputation entirely. Same 'update'
    // event name as broadcastUpdate() so existing listeners keep working;
    // payload carries `partial: true` so a consumer can tell the two apart
    // if it cares, but nothing existing is required to check for it.
    function broadcastPartial(patch) {
        _state.lastUpdate = Date.now();
        _state.updateCount++;
        emit('update', { ...patch, timestamp: Date.now(), partial: true });
    }

    // ---------- Public API ----------
    const EnvironmentEngine = {

        /**
         * Initialize the environment engine.
         * Sets up all listeners and sensor APIs.
         */
        async init() {
            if (_state.isInitialized) return this;

            // 1. Initial data collection
            const device = collectDeviceData();
            const colorScheme = collectColorSchemeData();
            const accessibility = collectAccessibilityData();
            const network = collectNetworkData();
            const battery = await collectBatteryData();
            const light = collectLightData();

            Object.assign(_state.device, device);
            Object.assign(_state.colorScheme, colorScheme);
            Object.assign(_state.accessibility, accessibility);
            Object.assign(_state.network, network);
            Object.assign(_state.battery, battery);
            Object.assign(_state.light, light);

            // 2. Set up listeners
            // (Every addEventListener below is now routed through on(...) so
            // destroy() can remove it later — fix #1. Handler logic itself
            // is unchanged.)

            // Resize
            let resizeTimeout;
            on(window, 'resize', () => {
                clearTimeout(resizeTimeout);
                resizeTimeout = setTimeout(() => {
                    const viewport = collectViewportData();
                    Object.assign(_state.viewport, viewport);
                    broadcastUpdate({ viewport });
                }, 100);
            });

            // Scroll (throttled) — fix #2: partial broadcast, viewport only
            let scrollTimeout;
            on(window, 'scroll', () => {
                if (scrollTimeout) return;
                scrollTimeout = setTimeout(() => {
                    const viewport = collectViewportData();
                    Object.assign(_state.viewport, viewport);
                    broadcastPartial({ viewport: { ..._state.viewport } });
                    scrollTimeout = null;
                }, 50);
            });

            // Orientation change
            on(window, 'orientationchange', () => {
                const orientation = collectOrientationData();
                Object.assign(_state.orientation, orientation);
                broadcastUpdate({ orientation });
            });

            // Visibility change
            on(document, 'visibilitychange', () => {
                _state.visibility.state = document.visibilityState;
                _state.visibility.hidden = document.hidden;
                broadcastUpdate({ visibility: { ..._state.visibility } });
            });

            // Online/Offline
            on(window, 'online', () => {
                _state.network.online = true;
                broadcastUpdate({ network: { online: true } });
            });
            on(window, 'offline', () => {
                _state.network.online = false;
                broadcastUpdate({ network: { online: false } });
            });

            // Color scheme change
            const darkMedia = window.matchMedia('(prefers-color-scheme: dark)');
            const darkHandler = (e) => {
                _state.colorScheme.prefersDark = e.matches;
                _state.colorScheme.active = e.matches ? 'dark' : 'light';
                broadcastUpdate({ colorScheme: { ..._state.colorScheme } });
            };
            on(darkMedia, 'change', darkHandler);

            // Reduced motion change
            const motionMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
            const motionHandler = (e) => {
                _state.accessibility.prefersReducedMotion = e.matches;
                broadcastUpdate({ accessibility: { ..._state.accessibility } });
            };
            on(motionMedia, 'change', motionHandler);

            // Reduced transparency change
            const transMedia = window.matchMedia('(prefers-reduced-transparency: reduce)');
            const transHandler = (e) => {
                _state.accessibility.prefersReducedTransparency = e.matches;
                broadcastUpdate({ accessibility: { ..._state.accessibility } });
            };
            on(transMedia, 'change', transHandler);

            // Contrast preference change
            const contrastMedia = window.matchMedia('(prefers-contrast: more)');
            const contrastHandler = (e) => {
                _state.accessibility.prefersContrast = e.matches ? 'more' : 'no-preference';
                broadcastUpdate({ accessibility: { ..._state.accessibility } });
            };
            on(contrastMedia, 'change', contrastHandler);

            // Network connection change
            if (navigator.connection) {
                on(navigator.connection, 'change', () => {
                    const network = collectNetworkData();
                    Object.assign(_state.network, network);
                    broadcastUpdate({ network });
                });
            }

            // Battery status change
            if ('getBattery' in navigator) {
                try {
                    const battery = await navigator.getBattery();
                    on(battery, 'levelchange', () => {
                        _state.battery.level = battery.level;
                        broadcastUpdate({ battery: { level: battery.level } });
                    });
                    on(battery, 'chargingchange', () => {
                        _state.battery.charging = battery.charging;
                        broadcastUpdate({ battery: { charging: battery.charging } });
                    });
                } catch (_) { /* ignore */ }
            }

            // Ambient Light Sensor — fix #4: isSupported only set true on a
            // real reading; error path explicitly sets it false.
            if ('AmbientLightSensor' in window) {
                try {
                    const sensor = new window.AmbientLightSensor();
                    sensor.addEventListener('reading', () => {
                        const lux = sensor.illuminance;
                        _state.light.rawLux = lux;
                        _state.light.isSupported = true;
                        // Normalize: assume typical indoor ~200 lux, outdoor ~10000+
                        _state.light.intensity = Math.min(1, Math.max(0, (lux / 1000) * 0.5 + 0.3));
                        broadcastUpdate({ light: { ..._state.light } });
                    });
                    sensor.addEventListener('error', () => {
                        _state.light.isSupported = false;
                    });
                    sensor.start();
                    _state._sensor = sensor; // tracked for destroy() — fix #1/#4
                } catch (_) {
                    _state.light.isSupported = false;
                }
            }

            // 3. Mouse tracking — fix #2: partial broadcast, mouse slice only
            on(document, 'mousemove', (e) => {
                _state.mouse.x = e.pageX;
                _state.mouse.y = e.pageY;
                _state.mouse.clientX = e.clientX;
                _state.mouse.clientY = e.clientY;
                _state.mouse.movementX = e.movementX || 0;
                _state.mouse.movementY = e.movementY || 0;
                _state.mouse.pointerType = 'mouse';
                // Throttle mouse updates to avoid spam
                if (!_state._mouseTimeout) {
                    _state._mouseTimeout = setTimeout(() => {
                        broadcastPartial({ mouse: { ..._state.mouse } });
                        _state._mouseTimeout = null;
                    }, 16);
                }
            });

            // Pointer events for touch/pen — fix #2: partial broadcast
            on(document, 'pointerdown', (e) => {
                _state.mouse.isPointerDown = true;
                _state.mouse.pointerType = e.pointerType || 'mouse';
                if (e.pointerType === 'touch') {
                    _state.touch.touchCount = 1;
                }
                broadcastPartial({
                    mouse: { ..._state.mouse },
                    touch: { ..._state.touch },
                });
            });
            on(document, 'pointerup', () => {
                _state.mouse.isPointerDown = false;
                _state.touch.touchCount = 0;
                broadcastPartial({
                    mouse: { ..._state.mouse },
                    touch: { ..._state.touch },
                });
            });

            // Touch events — fix #2: partial broadcast
            on(document, 'touchstart', (e) => {
                _state.touch.isTouch = true;
                _state.touch.touchCount = e.touches.length;
                _state.touch.touches = Array.from(e.touches).map(t => ({
                    clientX: t.clientX,
                    clientY: t.clientY,
                    pageX: t.pageX,
                    pageY: t.pageY,
                }));
                broadcastPartial({ touch: { ..._state.touch } });
            });
            on(document, 'touchmove', (e) => {
                _state.touch.touchCount = e.touches.length;
                _state.touch.touches = Array.from(e.touches).map(t => ({
                    clientX: t.clientX,
                    clientY: t.clientY,
                    pageX: t.pageX,
                    pageY: t.pageY,
                }));
                // Throttle
                if (!_state._touchTimeout) {
                    _state._touchTimeout = setTimeout(() => {
                        broadcastPartial({ touch: { ..._state.touch } });
                        _state._touchTimeout = null;
                    }, 50);
                }
            });

            // 4. Mark initialized
            _state.isInitialized = true;

            // 5. Initial broadcast
            const data = broadcastUpdate();

            emit('initialized', data);
            console.log('[EnvironmentEngine] Initialized.');

            return this;
        },

        // --- Data Access ---

        /**
         * Get the current complete environment data.
         * @param {boolean} [withOverrides=true] - Include manual overrides.
         * @returns {Object} Environment data.
         */
        getCurrent(withOverrides = true) {
            const data = buildEnvironmentState();
            if (withOverrides && Object.keys(_state.overrides).length > 0) {
                return { ...data, ..._state.overrides };
            }
            return data;
        },

        /**
         * Get a specific environment value.
         * @param {string} path - Dot-separated path (e.g., 'viewport.width').
         * @returns {*} Value or undefined.
         */
        get(path) {
            const parts = path.split('.');
            let current = { ..._state, overrides: undefined };
            for (const part of parts) {
                if (current && typeof current === 'object' && part in current) {
                    current = current[part];
                } else {
                    return undefined;
                }
            }
            return current;
        },

        /**
         * Check if a specific environment condition is true.
         * @param {string} condition - e.g., 'isMobile', 'isDarkMode', 'isReducedMotion'.
         * @returns {boolean}
         */
        is(condition) {
            const map = {
                isMobile: _state.device.isMobile,
                isTablet: _state.device.isTablet,
                isDesktop: _state.device.isDesktop,
                isTouch: _state.touch.isTouch,
                isDarkMode: _state.colorScheme.prefersDark,
                isLightMode: _state.colorScheme.prefersLight,
                isReducedMotion: _state.accessibility.prefersReducedMotion,
                isOnline: _state.network.online,
                isOffline: !_state.network.online,
                isPortrait: _state.orientation.type === 'portrait',
                isLandscape: _state.orientation.type === 'landscape',
                isBatteryCharging: _state.battery.charging,
                isHidden: _state.visibility.hidden,
                isVisible: !_state.visibility.hidden,
            };
            return map[condition] || false;
        },

        // --- Manual Overrides ---

        /**
         * Apply manual overrides to environment data (for testing).
         * Persists across recomputation (survives resize/scroll/etc).
         * @param {Object} overrides - Key-value pairs to override.
         * @param {boolean} [broadcast=true] - Whether to broadcast the update.
         */
        override(overrides, broadcast = true) {
            Object.assign(_state.overrides, overrides);
            if (broadcast) {
                const data = this.getCurrent();
                emit('overridden', data);
                emit('update', data);
            }
            console.log('[EnvironmentEngine] Overrides applied:', overrides);
            return this;
        },

        /**
         * Remove all manual overrides.
         * @param {boolean} [broadcast=true] - Whether to broadcast the update.
         */
        clearOverrides(broadcast = true) {
            _state.overrides = {};
            if (broadcast) {
                const data = this.getCurrent();
                emit('overriddenCleared', data);
                emit('update', data);
            }
            console.log('[EnvironmentEngine] Overrides cleared.');
            return this;
        },

        /**
         * Update environment data manually (e.g., from Runtime).
         *
         * --- Fix #3 ---
         * Previously this wrote straight into live `_state`, which made it
         * get silently clobbered by the very next real resize/scroll/etc
         * event — while override() (writing into `_state.overrides`)
         * survived. Both methods now share one persistence rule instead of
         * two different implicit behaviors:
         *   - By default (`persist: false`, unchanged call signature still
         *     works) this is transient, same as before, but now documented.
         *   - Pass `{ persist: true }` to route the patch into
         *     `_state.overrides` instead, giving it override()'s survival
         *     guarantee through the same storage.
         * Existing calls like `update(data)` or `update(data, false)` keep
         * working: the second positional arg is still read as `broadcast`
         * for backward compatibility.
         *
         * @param {Object} data - Environment data to merge.
         * @param {boolean|Object} [broadcastOrOptions=true] - Either a plain
         *   boolean (legacy `broadcast` flag) or `{ persist, broadcast }`.
         */
        update(data, broadcastOrOptions = true) {
            const opts = typeof broadcastOrOptions === 'object' && broadcastOrOptions !== null
                ? broadcastOrOptions
                : { broadcast: broadcastOrOptions };
            const persist = opts.persist === true;
            const broadcast = opts.broadcast !== false;

            const target = persist ? _state.overrides : _state;
            const updatedKeys = [];
            for (const [key, value] of Object.entries(data)) {
                if (persist) {
                    // overrides store is a flat bag — no "must already exist
                    // on _state" gate, matching override()'s existing behavior.
                    target[key] = (typeof value === 'object' && value !== null && typeof target[key] === 'object')
                        ? { ...target[key], ...value }
                        : value;
                    updatedKeys.push(key);
                } else if (key in _state && typeof value === 'object' && value !== null) {
                    Object.assign(_state[key], value);
                    updatedKeys.push(key);
                } else if (key in _state) {
                    _state[key] = value;
                    updatedKeys.push(key);
                }
            }
            if (broadcast && updatedKeys.length > 0) {
                const fullData = this.getCurrent();
                emit('update', fullData);
            }
            return this;
        },

        // --- Diagnostics ---

        /**
         * Get diagnostic information.
         * @returns {Object}
         */
        diagnostics() {
            return {
                state: {
                    isInitialized: _state.isInitialized,
                    lastUpdate: _state.lastUpdate,
                    updateCount: _state.updateCount,
                    hasOverrides: Object.keys(_state.overrides).length > 0,
                    listeners: _state.listeners.size,
                },
                environment: {
                    device: { ..._state.device },
                    viewport: { ..._state.viewport },
                    orientation: { ..._state.orientation },
                    colorScheme: { ..._state.colorScheme },
                    accessibility: { ..._state.accessibility },
                    network: { online: _state.network.online, effectiveType: _state.network.effectiveType },
                    battery: { level: _state.battery.level, charging: _state.battery.charging },
                    touch: { isTouch: _state.touch.isTouch, maxTouchPoints: _state.touch.maxTouchPoints },
                    light: { intensity: _state.light.intensity, isSupported: _state.light.isSupported },
                    mouse: { x: _state.mouse.x, y: _state.mouse.y },
                },
                overrides: { ..._state.overrides },
                timestamp: Date.now(),
            };
        },

        /**
         * Reset the environment engine.
         * Clears overrides and re-initializes.
         */
        reset() {
            this.clearOverrides(false);
            _state.updateCount = 0;
            _state.lastUpdate = Date.now();
            emit('reset');
            console.log('[EnvironmentEngine] Reset.');
            return this;
        },

        /**
         * Destroy the environment engine (cleanup).
         *
         * --- Fix #1 ---
         * Previously this only cleared the unused `listeners` Set and never
         * removed any of the ~16 DOM/matchMedia/battery listeners added in
         * init(), and never stopped the ambient light sensor — meaning a
         * refresh() (destroy + init) would double every listener, and every
         * subsequent refresh would compound that. This now actually tears
         * down everything init() registered via on(...), plus the sensor
         * and pending debounce timers, so init() can safely run again clean.
         */
        destroy() {
            _state._teardown.forEach(({ target, eventName, handler, opts }) => {
                target.removeEventListener(eventName, handler, opts);
            });
            _state._teardown = [];

            if (_state._sensor) {
                try { _state._sensor.stop(); } catch (_) { /* ignore */ }
                _state._sensor = null;
            }

            clearTimeout(_state._mouseTimeout);
            clearTimeout(_state._touchTimeout);
            _state._mouseTimeout = null;
            _state._touchTimeout = null;

            _state.listeners.clear();
            _state.isInitialized = false;
            emit('destroyed');
            console.log('[EnvironmentEngine] Destroyed.');
            return this;
        },
    };

    // ---------- Expose to Global ----------
    global.EnvironmentEngine = EnvironmentEngine;

    // --- Fix #5 ---
    // Previously this assignment ran once at parse time: if this script
    // loaded before window.Runtime existed, the attachment was silently
    // skipped forever regardless of load order elsewhere. Now it retries
    // briefly (10ms interval, 2s ceiling) so script tag order between this
    // file and runtime.js no longer silently breaks Runtime.EnvironmentEngine.
    // This is a stopgap for load-order safety, not a substitute for fixing
    // the actual <script> ordering in index.html.
    (function attachToRuntimeWithRetry() {
        if (global.Runtime) {
            global.Runtime.EnvironmentEngine = EnvironmentEngine;
            return;
        }
        const retry = setInterval(() => {
            if (global.Runtime) {
                global.Runtime.EnvironmentEngine = EnvironmentEngine;
                clearInterval(retry);
            }
        }, 10);
        setTimeout(() => clearInterval(retry), 2000);
    })();

    console.log('[EnvironmentEngine] Loaded and ready. Call EnvironmentEngine.init() to start.');

})(typeof window !== 'undefined' ? window : this);
