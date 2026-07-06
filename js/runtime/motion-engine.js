// ================================================================
// MOTION-ENGINE.JS — Global Motion Policy Manager
// ================================================================
// File: js/runtime/motion-engine.js
// Responsibilities: Reduced motion, global pause/resume, performance tier,
// animation registry, visibility control.
// Does NOT animate anything directly.
//
// FIX LOG:
//   FIX 1  — document.visibilityState removed from parse-time _state init
//   FIX 2  — _pauseSource tracker added; auto-resume is now conditional
//   FIX 3  — reset() snapshots keys before iterating to prevent Map mutation bug
//   FIX 4  — destroy() added; motionMedia + visibilitychange handlers stored & removed
//   FIX 5  — all console.log/warn guarded by Runtime?.config?.debug
//   FIX 6  — registerAnimation() auto-unregisters stale entry on duplicate ID
//   FIX 7  — dead empty if (_state.reducedMotion) block removed from resumeAll()
//   FIX 8  — Runtime attachment made passive; Runtime owns attach on boot
//   FIX 9  — emit() prefixes all event names with 'motion:' for namespace consistency
//   FIX 10 — init() early-exit guard returns this instead of undefined
//   FIX R1 — updatePreferences allowAnimations:true only resumes if _pauseSource==='preference'
//   FIX R2 — redundant _pauseSource pre-assignment removed from visibilityHandler
//   FIX R3 — emit() DOM fallback guarded with typeof document !== 'undefined'
//   FIX R4 — reset() document.visibilityState access guarded for non-browser contexts
//   FIX R5 — setPerformanceTier() override added for brittle heuristic correction
//   FIX R6 — canAnimate() single decision helper added; prevents section policy drift
//   FIX R7 — resumeAll() contract documented; controllers own reduced-motion behaviour
//   FIX R8 — duplicate registration warning is always-on (not debug-gated) for visibility
//   FIX R9 — autoSuspended/autoResumed consolidated into suspended/resumed + auto:true flag
//   FIX S1 — init() guarded for non-browser/SSR contexts at entry point
//   FIX S2 — double-emit resolved: suspend()/resume() accept options.auto, visibility
//             handler removed its own emit() calls — single emission per transition
//   FIX S3 — canAnimate() lenient: reducedMotion removed; controllers own variant choice
//   FIX S4 — allowAnimations:false while already paused precedence documented explicitly
// ================================================================

(function(global) {
    'use strict';

    // ---------- Private State ----------
    const _state = {
        reducedMotion: false,
        prefersReducedMotion: false,
        paused: false,
        performanceTier: 'medium',
        animations: new Map(),
        preferences: {
            allowAnimations: true,
            reducedMotion: 'auto',      // 'auto' | 'enabled' | 'disabled'
            speed: 1,                   // multiplier (0.5, 1, 1.5)
        },
        // FIX 1 — visibilityState must NOT access document at parse time.
        // Initialised to null; set correctly inside init().
        visibilityState: null,
        lastVisibilityChange: Date.now(),
        isInitialized: false,
        // FIX 2 — track the source of the current pause so visibility
        // auto-resume cannot override a manual suspend().
        _pauseSource: null,             // null | 'visibility' | 'preference' | 'manual'
    };

    // FIX 4 — Store handler references at module scope so destroy() can remove them.
    let _motionMedia       = null;
    let _motionHandler     = null;
    let _visibilityHandler = null;

    // ---------- Private Helpers ----------
    function getEventEngine() {
        return global.Runtime?.EventEngine || global.EventEngine || null;
    }

    // FIX 9 — All event names are prefixed 'motion:' here so consumers
    // (e.g. Hero) listening for 'motion:suspended' receive correctly
    // regardless of whether EventEngine or the DOM fallback fires them.
    // FIX R3 — DOM fallback now guarded: only dispatches if document exists.
    // Prevents throws in SSR / non-browser contexts when EventEngine is unavailable.
    function emit(eventName, payload = {}) {
        const fullName = `motion:${eventName}`;
        const ee = getEventEngine();
        if (ee && typeof ee.emit === 'function') {
            ee.emit(fullName, payload);
        } else if (typeof document !== 'undefined') {
            const event = new CustomEvent(fullName, { detail: payload, bubbles: true });
            document.dispatchEvent(event);
        }
        // If neither EventEngine nor document is available, emit is a silent no-op.
    }

    function detectPerformanceTier() {
        const cores    = navigator.hardwareConcurrency || 4;
        const memory   = navigator.deviceMemory || 4;
        const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

        if (isMobile || cores <= 4 || memory <= 2) return 'low';
        if (cores <= 8 || memory <= 4)              return 'medium';
        return 'high';
    }

    function getReducedMotionFromMedia() {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    // ---------- Public API ----------
    const MotionEngine = {

        /**
         * Initialize the motion engine.
         * Sets up media query listeners, visibility listener, and performance detection.
         */
        init() {
            // FIX 10 — return this (not undefined) so callers can chain on repeat calls.
            if (_state.isInitialized) return this;

            // FIX S1 — guard for non-browser / SSR / test-runner contexts.
            // The module can be loaded anywhere safely; init() is the browser-only boundary.
            if (typeof window === 'undefined' || typeof document === 'undefined') return this;

            // 1. Detect initial reduced motion preference
            _state.prefersReducedMotion = getReducedMotionFromMedia();
            _state.reducedMotion        = _state.prefersReducedMotion;

            // 2. Detect performance tier
            _state.performanceTier = detectPerformanceTier();

            // FIX 1 — visibilityState safely set here, inside init(), not at parse time.
            _state.visibilityState = document.visibilityState;

            // 3. Listen to prefers-reduced-motion changes
            // FIX 4 — store references on module-scope vars for destroy() cleanup.
            _motionMedia   = window.matchMedia('(prefers-reduced-motion: reduce)');
            _motionHandler = (e) => {
                const newValue = e.matches;
                _state.prefersReducedMotion = newValue;
                if (_state.preferences.reducedMotion === 'auto') {
                    const old = _state.reducedMotion;
                    _state.reducedMotion = newValue;
                    if (old !== newValue) {
                        emit(newValue ? 'reduced' : 'restored', { enabled: newValue });
                        if (global.Runtime?.config?.debug) {
                            // FIX 5 — guarded log
                            console.log(`[MotionEngine] Reduced motion ${newValue ? 'enabled' : 'restored'} (media query)`);
                        }
                    }
                }
            };
            _motionMedia.addEventListener('change', _motionHandler);

            // 4. Listen to page visibility
            // FIX 2 — _pauseSource tracked so auto-resume only fires when
            // MotionEngine itself caused the pause via visibility change.
            _visibilityHandler = () => {
                const newState = document.visibilityState;
                _state.visibilityState       = newState;
                _state.lastVisibilityChange  = Date.now();

                if (newState === 'hidden' && !_state.paused) {
                    // FIX R2 — _pauseSource set inside suspend() via options.reason.
                    // FIX S2 — auto:true passed through options; suspend() emits once
                    // with auto:true in payload. Second emit() call removed — was double-firing.
                    this.suspend({ reason: 'visibility', auto: true });
                } else if (newState === 'visible' && _state.paused && _state._pauseSource === 'visibility') {
                    // Only auto-resume if visibility caused the pause — never override manual suspend.
                    // FIX S2 — same pattern: single emission via resume() with auto:true.
                    this.resume({ reason: 'visibility', auto: true });
                }
            };
            document.addEventListener('visibilitychange', _visibilityHandler);

            // 5. Mark initialized
            _state.isInitialized = true;

            // 6. Emit initialization event
            emit('initialized', {
                reducedMotion:   _state.reducedMotion,
                performanceTier: _state.performanceTier,
                paused:          _state.paused,
            });

            // FIX 5 — guarded log
            if (global.Runtime?.config?.debug) {
                console.log(`[MotionEngine] Initialized (tier: ${_state.performanceTier}, reduced: ${_state.reducedMotion})`);
            }

            return this;
        },

        // --- Motion Preference Queries ---

        /** @returns {boolean} */
        isReducedMotion() { return _state.reducedMotion; },

        /** @returns {boolean} */
        isPaused() { return _state.paused; },

        /**
         * Single authoritative decision helper — lenient policy.
         * Returns false only when animations are explicitly disabled or globally paused.
         * reducedMotion is intentionally excluded: it means "use a gentler variant",
         * not "no animation at all." Controllers call isReducedMotion() separately
         * to choose between full and reduced variants.
         *
         * Correct controller pattern:
         *   if (!MotionEngine.canAnimate()) return;            // full stop
         *   if (MotionEngine.isReducedMotion()) applyFade();   // gentle variant
         *   else applySlide();                                 // full variant
         *
         * @returns {boolean} true if any animation is permitted right now.
         */
        canAnimate() {
            // FIX R6 — single policy check for all controllers.
            // FIX S3 — reducedMotion removed; lenient policy confirmed by Hero integration
            //          contract (crossfade IS the reduced-motion variant, not an absence).
            return _state.preferences.allowAnimations && !_state.paused;
        },

        /** @returns {string} 'low' | 'medium' | 'high' */
        getPerformanceTier() { return _state.performanceTier; },

        /**
         * Override the auto-detected performance tier.
         * Use when heuristic (hardwareConcurrency / deviceMemory / UA) gives wrong result.
         * @param {'low'|'medium'|'high'} tier
         * @returns {boolean} Success.
         */
        setPerformanceTier(tier) {
            // FIX R5 — exposes manual override for brittle heuristic detection.
            if (!['low', 'medium', 'high'].includes(tier)) {
                if (global.Runtime?.config?.debug) {
                    console.warn(`[MotionEngine] setPerformanceTier: invalid tier "${tier}". Use 'low', 'medium', or 'high'.`);
                }
                return false;
            }
            _state.performanceTier = tier;
            emit('tierChanged', { tier });
            if (global.Runtime?.config?.debug) {
                console.log(`[MotionEngine] Performance tier overridden to: ${tier}`);
            }
            return true;
        },

        /** @returns {Object} */
        getPreferences() { return { ..._state.preferences }; },

        /**
         * Update motion preferences.
         * @param {Object} updates
         * @param {string}  [updates.reducedMotion] — 'auto' | 'enabled' | 'disabled'
         * @param {number}  [updates.speed]          — multiplier (0.5–2.0)
         * @param {boolean} [updates.allowAnimations] — master switch
         */
        updatePreferences(updates) {
            let changed    = false;
            const oldReduced = _state.reducedMotion;

            if (updates.reducedMotion !== undefined) {
                if (['auto', 'enabled', 'disabled'].includes(updates.reducedMotion)) {
                    _state.preferences.reducedMotion = updates.reducedMotion;
                    if (updates.reducedMotion === 'auto') {
                        _state.reducedMotion = _state.prefersReducedMotion;
                    } else if (updates.reducedMotion === 'enabled') {
                        _state.reducedMotion = true;
                    } else {
                        _state.reducedMotion = false;
                    }
                    changed = true;
                }
            }

            if (updates.speed !== undefined) {
                const speed = Math.min(2, Math.max(0.5, updates.speed));
                if (_state.preferences.speed !== speed) {
                    _state.preferences.speed = speed;
                    changed = true;
                }
            }

            if (updates.allowAnimations !== undefined) {
                if (typeof updates.allowAnimations === 'boolean') {
                    _state.preferences.allowAnimations = updates.allowAnimations;
                    changed = true;
                    if (!updates.allowAnimations) {
                        // FIX S4 — Precedence contract (explicit):
                        // If already paused for any reason (manual/visibility), suspend() early-
                        // returns and _pauseSource remains unchanged. The preference is still
                        // stored correctly — canAnimate() will return false regardless because
                        // allowAnimations is now false. No source override occurs. This is
                        // intentional: manual pause always takes precedence over preference state.
                        this.suspend({ reason: 'preference' });
                    } else if (_state._pauseSource === 'preference') {
                        // FIX R1 — only resume if *this engine* caused the pause via preference.
                        // Never override a manual suspend() or visibility-triggered pause.
                        this.resume({ reason: 'preference' });
                    }
                }
            }

            if (changed) {
                emit('preferencesChanged', { preferences: { ..._state.preferences } });
                if (oldReduced !== _state.reducedMotion) {
                    emit(_state.reducedMotion ? 'reduced' : 'restored', {
                        enabled: _state.reducedMotion,
                        source:  'preference',
                    });
                }
                // FIX 5 — guarded log
                if (global.Runtime?.config?.debug) {
                    console.log('[MotionEngine] Preferences updated:', _state.preferences);
                }
            }
        },

        // --- Global Pause / Resume ---

        /**
         * Pause all animations globally.
         * @param {Object} [options]
         * @param {string}  [options.reason] — 'manual' | 'visibility' | 'preference'
         * @param {boolean} [options.auto]   — true when triggered automatically (e.g. visibility)
         *                                     FIX S2 — carries auto flag into single emission;
         *                                     eliminates the need for a second emit() at call site.
         */
        suspend(options = {}) {
            if (_state.paused) return;
            _state.paused       = true;
            _state._pauseSource = options.reason || 'manual';  // FIX 2 — record source
            this.pauseAll();
            // FIX S2 — single emission includes auto flag when provided.
            // Visibility handler no longer needs a second emit() call.
            emit('suspended', {
                reason: _state._pauseSource,
                ...(options.auto ? { auto: true } : {}),
            });
            // FIX 5 — guarded log
            if (global.Runtime?.config?.debug) {
                console.log(`[MotionEngine] Suspended (reason: ${_state._pauseSource}${options.auto ? ', auto' : ''})`);
            }
        },

        /**
         * Resume all animations globally.
         * @param {Object} [options]
         * @param {string}  [options.reason] — 'manual' | 'visibility' | 'preference'
         * @param {boolean} [options.auto]   — true when triggered automatically (e.g. visibility)
         *                                     FIX S2 — carries auto flag into single emission.
         */
        resume(options = {}) {
            if (!_state.paused) return;
            _state.paused       = false;
            _state._pauseSource = null;                        // FIX 2 — clear source on resume
            this.resumeAll();
            // FIX S2 — single emission includes auto flag when provided.
            emit('resumed', {
                reason: options.reason || 'manual',
                ...(options.auto ? { auto: true } : {}),
            });
            // FIX 5 — guarded log
            if (global.Runtime?.config?.debug) {
                console.log(`[MotionEngine] Resumed (reason: ${options.reason || 'manual'}${options.auto ? ', auto' : ''})`);
            }
        },

        /**
         * Toggle global pause state.
         * @param {Object} [options] — { reason: string }
         * @returns {boolean} New paused state.
         */
        togglePause(options = {}) {
            if (_state.paused) {
                this.resume(options);
            } else {
                this.suspend(options);
            }
            return _state.paused;
        },

        // --- Animation Registry ---

        /**
         * Register an animation controller with the motion engine.
         * Controller must expose pause() and resume() methods.
         * @param {string} id         — Unique identifier.
         * @param {Object} controller — { pause, resume, destroy? }
         * @param {Object} [metadata] — Additional info (section, type, etc.)
         * @returns {boolean} Success.
         */
        registerAnimation(id, controller, metadata = {}) {
            if (!id || typeof id !== 'string') {
                if (global.Runtime?.config?.debug) {
                    // FIX 5 — guarded warn
                    console.warn('[MotionEngine] registerAnimation: invalid id');
                }
                return false;
            }
            if (!controller || typeof controller.pause !== 'function' || typeof controller.resume !== 'function') {
                if (global.Runtime?.config?.debug) {
                    // FIX 5 — guarded warn
                    console.warn(`[MotionEngine] registerAnimation: controller for "${id}" missing pause/resume`);
                }
                return false;
            }

            // FIX 6 — On duplicate ID, auto-unregister the stale entry instead of
            // silently returning false. Prevents registration failures on refresh cycles.
            // FIX R8 — Warn loudly (always, not just in debug) if replacing an entry
            // that may have been legitimately active. destroy() will be called on it.
            if (_state.animations.has(id)) {
                console.warn(`[MotionEngine] registerAnimation: "${id}" already registered — destroying stale entry and replacing. If unintentional, check for duplicate registerAnimation() calls.`);
                this.unregisterAnimation(id);
            }

            _state.animations.set(id, {
                controller,
                metadata,
                registered: Date.now(),
            });

            if (_state.paused) {
                try {
                    controller.pause();
                } catch (err) {
                    if (global.Runtime?.config?.debug) {
                        // FIX 5 — guarded warn
                        console.warn(`[MotionEngine] Error pausing new animation "${id}":`, err);
                    }
                }
            }

            emit('animationRegistered', { id, metadata });
            // FIX 5 — guarded log
            if (global.Runtime?.config?.debug) {
                console.log(`[MotionEngine] Animation registered: ${id}`);
            }
            return true;
        },

        /**
         * Unregister an animation controller.
         * @param {string} id
         * @returns {boolean}
         */
        unregisterAnimation(id) {
            const entry = _state.animations.get(id);
            if (!entry) return false;

            if (typeof entry.controller.destroy === 'function') {
                try {
                    entry.controller.destroy();
                } catch (err) {
                    if (global.Runtime?.config?.debug) {
                        // FIX 5 — guarded warn
                        console.warn(`[MotionEngine] Error destroying animation "${id}":`, err);
                    }
                }
            }
            _state.animations.delete(id);
            emit('animationUnregistered', { id });
            // FIX 5 — guarded log
            if (global.Runtime?.config?.debug) {
                console.log(`[MotionEngine] Animation unregistered: ${id}`);
            }
            return true;
        },

        /**
         * Get information about a registered animation.
         * @param {string} id
         * @returns {Object|null}
         */
        getAnimationInfo(id) {
            const entry = _state.animations.get(id);
            if (!entry) return null;
            return {
                id,
                metadata:   entry.metadata,
                registered: entry.registered,
                paused:     _state.paused,
            };
        },

        /**
         * List all registered animation IDs.
         * @returns {string[]}
         */
        listAnimations() {
            return Array.from(_state.animations.keys());
        },

        // --- Internal Control Methods ---

        /** @private */
        pauseAll() {
            for (const [id, entry] of _state.animations) {
                try {
                    entry.controller.pause();
                } catch (err) {
                    if (global.Runtime?.config?.debug) {
                        // FIX 5 — guarded warn
                        console.warn(`[MotionEngine] Error pausing animation "${id}":`, err);
                    }
                }
            }
        },

        /** @private */
        resumeAll() {
            // FIX 7 — Dead empty if (_state.reducedMotion) block removed.
            // FIX R7 — Contract: MotionEngine calls resume() on all controllers
            // unconditionally. Controllers are responsible for checking
            // MotionEngine.canAnimate() or .isReducedMotion() to decide
            // whether to actually animate. This keeps policy in one place.
            for (const [id, entry] of _state.animations) {
                try {
                    entry.controller.resume();
                } catch (err) {
                    if (global.Runtime?.config?.debug) {
                        // FIX 5 — guarded warn
                        console.warn(`[MotionEngine] Error resuming animation "${id}":`, err);
                    }
                }
            }
        },

        // --- Diagnostics ---

        /** @returns {Object} */
        diagnostics() {
            const animations = {};
            for (const [id, entry] of _state.animations) {
                animations[id] = {
                    metadata:  entry.metadata,
                    registered: entry.registered,
                    hasPause:  typeof entry.controller.pause  === 'function',
                    hasResume: typeof entry.controller.resume === 'function',
                };
            }

            return {
                state: {
                    reducedMotion:        _state.reducedMotion,
                    prefersReducedMotion: _state.prefersReducedMotion,
                    paused:               _state.paused,
                    pauseSource:          _state._pauseSource,
                    performanceTier:      _state.performanceTier,
                    visibilityState:      _state.visibilityState,
                    isInitialized:        _state.isInitialized,
                },
                preferences:    { ..._state.preferences },
                animationCount: _state.animations.size,
                animations,
                timestamp:      Date.now(),
            };
        },

        /**
         * Reset the motion engine — clears animation registry, restores defaults.
         */
        reset() {
            // FIX 3 — Snapshot keys before iterating to prevent Map-mutation-during-
            // iteration undefined behaviour. unregisterAnimation() calls .delete()
            // internally; iterating the live Map while deleting from it is unsafe.
            for (const id of Array.from(_state.animations.keys())) {
                this.unregisterAnimation(id);
            }

            _state.paused       = false;
            _state._pauseSource = null;
            _state.reducedMotion = _state.prefersReducedMotion;
            _state.preferences  = {
                allowAnimations: true,
                reducedMotion:   'auto',
                speed:           1,
            };
            // FIX R4 — guard document access, consistent with FIX 1's intent.
            _state.visibilityState      = typeof document !== 'undefined' ? document.visibilityState : null;
            _state.lastVisibilityChange = Date.now();

            emit('reset');
            // FIX 5 — guarded log
            if (global.Runtime?.config?.debug) {
                console.log('[MotionEngine] Reset.');
            }
        },

        // FIX 4 — destroy() added. Removes both stored listener references
        // (motionMedia change handler + visibilitychange handler) to prevent
        // zombie listeners accumulating across init/destroy cycles.
        /**
         * Destroy the motion engine — removes all event listeners, clears registry.
         */
        destroy() {
            // Clear animation registry first
            for (const id of Array.from(_state.animations.keys())) {
                this.unregisterAnimation(id);
            }

            // Remove stored listener references
            if (_motionMedia && _motionHandler) {
                _motionMedia.removeEventListener('change', _motionHandler);
                _motionMedia   = null;
                _motionHandler = null;
            }
            if (_visibilityHandler) {
                document.removeEventListener('visibilitychange', _visibilityHandler);
                _visibilityHandler = null;
            }

            _state.isInitialized = false;
            _state.paused        = false;
            _state._pauseSource  = null;

            emit('destroyed');
            // FIX 5 — guarded log
            if (global.Runtime?.config?.debug) {
                console.log('[MotionEngine] Destroyed.');
            }
        },
    };

    // ---------- Expose ----------
    global.MotionEngine = MotionEngine;

    // FIX 8 — Runtime attachment is passive. MotionEngine exposes itself on
    // the global scope only. Runtime attaches it during its own boot sequence.
    // No fallback logic here — one-way dependency: Runtime → MotionEngine.

    // FIX 5 — guarded load confirmation log
    if (global.Runtime?.config?.debug) {
        console.log('[MotionEngine] Loaded and ready. Call MotionEngine.init() to start.');
    }

})(typeof window !== 'undefined' ? window : this);
