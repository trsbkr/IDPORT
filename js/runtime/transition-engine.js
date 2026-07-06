// ================================================================
// TRANSITION-ENGINE.JS — Navigation Transition Coordinator
// ================================================================
// File: js/runtime/transition-engine.js
// Responsibilities: Page/section enter/exit, transition queue, locking,
// cancellation, timing, diagnostics.
// Does NOT animate Hero, Portrait, Quote, Buttons, or Liquid Pointer.
// ================================================================

(function(global) {
    'use strict';

    // ---------- Private State ----------
    const _state = {
        isTransitioning: false,
        currentTransition: null,        // { from, to, type, promise, resolve, reject }
        queue: [],                      // Pending transitions
        config: {
            defaultType: 'fade',
            duration: 300,
            reducedMotionDuration: 0,   // Instant when reduced motion
            lockTimeout: 5000,          // Safety timeout
        },
        registeredTransitions: new Map(),
        isInitialized: false,
        lastTransition: null,
        transitionCount: 0,
    };

    // ---------- Private Helpers ----------

    // FIX: getSectionController uses contract-verified path only.
    // Runtime.SectionController confirmed in contract §6.
    function getSectionController() {
        return global.Runtime?.SectionController || global.SectionController || null;
    }

    // FIX: emit() — removed dead EventEngine branch.
    // Contract §7 confirms EventEngine is "unused by anything else — not yet
    // part of any real contract." The EventEngine path never fired.
    // Now uses CustomEvent directly, consistent with section-controller.js
    // and state-engine.js. Restore EventEngine branch when it enters contract.
    function emit(eventName, payload = {}) {
        const event = new CustomEvent(`transition:${eventName}`, {
            detail: payload,
            bubbles: true,
        });
        document.dispatchEvent(event);
        if (global.Runtime?.config?.debug) {
            console.debug(`[TransitionEngine] Event: ${eventName}`, payload);
        }
    }

    // FIX: isReducedMotion() — was always returning false.
    // MotionEngine is NOT in the contract (not in §6, not verified in §7).
    // getMotionEngine() always returned null, so reduced motion was never
    // respected. Now falls back directly to browser matchMedia API when
    // MotionEngine is absent. Restore MotionEngine path when it enters contract.
    function isReducedMotion() {
        const motion = global.Runtime?.MotionEngine || global.MotionEngine || null;
        if (motion && typeof motion.isReducedMotion === 'function') {
            return motion.isReducedMotion();
        }
        // Direct browser fallback — no contract dependency needed
        return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    }

    function getEffectiveDuration(baseDuration) {
        if (isReducedMotion()) {
            return _state.config.reducedMotionDuration;
        }
        return baseDuration || _state.config.duration;
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ---------- Default Transition Implementations ----------

    const defaultTransitions = {
        /**
         * Fade transition: crossfade between sections.
         */
        fade: async (fromEl, toEl, duration) => {
            const effectiveDuration = getEffectiveDuration(duration);
            if (effectiveDuration === 0) {
                if (fromEl) fromEl.style.display = 'none';
                if (toEl) toEl.style.display = '';
                return;
            }
            if (fromEl) {
                fromEl.style.transition = `opacity ${effectiveDuration}ms ease`;
                fromEl.style.opacity = '1';
            }
            if (toEl) {
                toEl.style.transition = `opacity ${effectiveDuration}ms ease`;
                toEl.style.opacity = '0';
                toEl.style.display = '';
            }
            await sleep(16);
            if (fromEl) fromEl.style.opacity = '0';
            if (toEl) toEl.style.opacity = '1';
            await sleep(effectiveDuration);
            if (fromEl) {
                fromEl.style.display = 'none';
                fromEl.style.opacity = '1';
                fromEl.style.transition = '';
            }
            if (toEl) toEl.style.transition = '';
        },

        /**
         * Slide transition: slide in from direction.
         */
        slide: async (fromEl, toEl, duration, direction = 'left') => {
            const effectiveDuration = getEffectiveDuration(duration);
            if (effectiveDuration === 0) {
                if (fromEl) fromEl.style.display = 'none';
                if (toEl) toEl.style.display = '';
                return;
            }
            const directions = {
                left:  { from: 'translateX(0)', to: 'translateX(100%)' },
                right: { from: 'translateX(0)', to: 'translateX(-100%)' },
                up:    { from: 'translateY(0)', to: 'translateY(100%)' },
                down:  { from: 'translateY(0)', to: 'translateY(-100%)' },
            };
            const dir = directions[direction] || directions.left;
            if (toEl) {
                toEl.style.transition = `transform ${effectiveDuration}ms ease`;
                toEl.style.transform = dir.to;
                toEl.style.display = '';
            }
            if (fromEl) {
                fromEl.style.transition = `transform ${effectiveDuration}ms ease`;
                fromEl.style.transform = dir.from;
            }
            await sleep(16);
            if (fromEl) fromEl.style.transform = dir.to;
            if (toEl) toEl.style.transform = dir.from;
            await sleep(effectiveDuration);
            if (fromEl) {
                fromEl.style.display = 'none';
                fromEl.style.transform = '';
                fromEl.style.transition = '';
            }
            if (toEl) {
                toEl.style.transform = '';
                toEl.style.transition = '';
            }
        },

        /**
         * Push transition: old section pushes out, new pushes in.
         */
        push: async (fromEl, toEl, duration, direction = 'left') => {
            const effectiveDuration = getEffectiveDuration(duration);
            if (effectiveDuration === 0) {
                if (fromEl) fromEl.style.display = 'none';
                if (toEl) toEl.style.display = '';
                return;
            }
            const directions = {
                left:  { out: 'translateX(-100%)', in: 'translateX(0)' },
                right: { out: 'translateX(100%)',  in: 'translateX(0)' },
            };
            const dir = directions[direction] || directions.left;
            if (fromEl) {
                fromEl.style.transition = `transform ${effectiveDuration}ms ease`;
                fromEl.style.transform = 'translateX(0)';
            }
            if (toEl) {
                toEl.style.transition = `transform ${effectiveDuration}ms ease`;
                toEl.style.transform = dir.out;
                toEl.style.display = '';
            }
            await sleep(16);
            if (fromEl) fromEl.style.transform = dir.out;
            if (toEl) toEl.style.transform = dir.in;
            await sleep(effectiveDuration);
            if (fromEl) {
                fromEl.style.display = 'none';
                fromEl.style.transform = '';
                fromEl.style.transition = '';
            }
            if (toEl) {
                toEl.style.transform = '';
                toEl.style.transition = '';
            }
        },

        /**
         * No transition: instant switch.
         */
        none: async (fromEl, toEl) => {
            if (fromEl) fromEl.style.display = 'none';
            if (toEl) toEl.style.display = '';
        },
    };

    // ---------- Public API ----------
    const TransitionEngine = {

        /**
         * Initialize the transition engine.
         * Must be called by runtime.js during boot before any transition() call.
         * Until init() runs, registeredTransitions is empty and transition()
         * will throw "Unknown transition type".
         */
        init() {
            if (_state.isInitialized) return;
            for (const [name, fn] of Object.entries(defaultTransitions)) {
                this.registerTransition(name, fn);
            }
            _state.isInitialized = true;
            emit('initialized', { config: { ..._state.config } });
            console.log('[TransitionEngine] Initialized with default transitions.');
            return this;
        },

        /**
         * Register a custom transition.
         * @param {string} name - Transition name.
         * @param {function} fn - Async function: (fromEl, toEl, duration, options?) => Promise.
         * @returns {boolean} Success.
         */
        registerTransition(name, fn) {
            if (typeof name !== 'string' || !name.trim()) {
                console.warn('[TransitionEngine] registerTransition: invalid name');
                return false;
            }
            if (typeof fn !== 'function') {
                console.warn(`[TransitionEngine] registerTransition: "${name}" must be a function`);
                return false;
            }
            if (_state.registeredTransitions.has(name)) {
                console.warn(`[TransitionEngine] Transition "${name}" already registered.`);
                return false;
            }
            _state.registeredTransitions.set(name, fn);
            console.log(`[TransitionEngine] Registered transition: ${name}`);
            return true;
        },

        /**
         * Unregister a custom transition.
         * @param {string} name - Transition name.
         * @returns {boolean} Success.
         */
        unregisterTransition(name) {
            if (name === 'none') {
                console.warn('[TransitionEngine] Cannot unregister "none" transition.');
                return false;
            }
            if (!_state.registeredTransitions.has(name)) return false;
            _state.registeredTransitions.delete(name);
            console.log(`[TransitionEngine] Unregistered transition: ${name}`);
            return true;
        },

        /**
         * Get a registered transition function.
         * @param {string} name
         * @returns {function|null}
         */
        getTransition(name) {
            return _state.registeredTransitions.get(name) || null;
        },

        /**
         * List all registered transitions.
         * @returns {string[]}
         */
        listTransitions() {
            return Array.from(_state.registeredTransitions.keys());
        },

        // --- Core Transition API ---

        /**
         * Perform a transition between sections.
         * Uses contract-verified SectionController.get() (§6) for section lookup.
         * @param {string|Object} from - Section name or element.
         * @param {string|Object} to - Section name or element.
         * @param {Object} [options] - { type, duration, direction, data }
         * @returns {Promise<void>}
         */
        async transition(from, to, options = {}) {
            if (_state.isTransitioning) {
                return new Promise((resolve, reject) => {
                    _state.queue.push({ from, to, options, resolve, reject });
                    console.log(`[TransitionEngine] Queued transition (${_state.queue.length} pending)`);
                });
            }

            const {
                type = _state.config.defaultType,
                duration = _state.config.duration,
                direction = 'left',
                data = {},
            } = options;

            const fromEl = this._resolveSectionElement(from);
            const toEl   = this._resolveSectionElement(to);

            const transitionFn = _state.registeredTransitions.get(type);
            if (!transitionFn) {
                throw new Error(`[TransitionEngine] Unknown transition type: "${type}". Call init() first.`);
            }

            _state.isTransitioning = true;
            _state.currentTransition = { from, to, type, options };
            _state.transitionCount++;

            const startPayload = { from, to, type, duration, direction, data, count: _state.transitionCount };
            emit('start', startPayload);
            console.log(`[TransitionEngine] Transition starting: ${from} → ${to} (${type})`);

            try {
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => {
                        reject(new Error(`[TransitionEngine] Transition timeout: ${type} exceeded ${_state.config.lockTimeout}ms`));
                    }, _state.config.lockTimeout);
                });

                const transitionPromise = transitionFn(fromEl, toEl, duration, direction, data);
                await Promise.race([transitionPromise, timeoutPromise]);

                _state.lastTransition = { from, to, type, duration, timestamp: Date.now() };
                emit('end', { from, to, type, success: true, count: _state.transitionCount });
                console.log(`[TransitionEngine] Transition complete: ${from} → ${to}`);

            } catch (err) {
                emit('error', { from, to, type, error: err.message, count: _state.transitionCount });
                console.error('[TransitionEngine] Transition error:', err);
                throw err;

            } finally {
                // FIX: unlock always happens here (was already correct).
                _state.isTransitioning = false;
                _state.currentTransition = null;
                // FIX: _processQueue() moved into finally block.
                // Previously only called on success path — if transition threw,
                // queue was permanently stuck. Now drains regardless of outcome.
                this._processQueue();
            }
        },

        /**
         * Cancel the current transition.
         * ⚠️ SOFT CANCEL ONLY: marks state and drains queue, but the in-flight
         * async transition function (fade/slide/push) continues running to
         * completion — CSS animations cannot be interrupted without AbortController.
         * The visual animation will finish even after cancel() returns.
         * @returns {boolean} Success.
         */
        cancel() {
            if (!_state.isTransitioning) return false;
            const current = _state.currentTransition;
            emit('cancelled', {
                from: current?.from,
                to: current?.to,
                type: current?.type,
                count: _state.transitionCount,
            });
            _state.isTransitioning = false;
            _state.currentTransition = null;
            console.log('[TransitionEngine] Transition cancelled (soft — visual may still complete).');
            this._processQueue();
            return true;
        },

        /**
         * Cancel all queued transitions.
         * @returns {number} Number of queued transitions cleared.
         */
        clearQueue() {
            const count = _state.queue.length;
            for (const item of _state.queue) {
                try { item.reject(new Error('[TransitionEngine] Queue cleared')); } catch (_) { /* ignore */ }
            }
            _state.queue = [];
            emit('queueCleared', { count });
            console.log(`[TransitionEngine] Cleared ${count} queued transitions.`);
            return count;
        },

        /**
         * Get the current transition state.
         * @returns {Object}
         */
        getState() {
            return {
                isTransitioning: _state.isTransitioning,
                current: _state.currentTransition,
                queueLength: _state.queue.length,
                totalTransitions: _state.transitionCount,
                lastTransition: _state.lastTransition,
            };
        },

        /**
         * Check if a transition is in progress.
         * @returns {boolean}
         */
        isTransitioning() {
            return _state.isTransitioning;
        },

        // --- Configuration ---

        /**
         * Update transition configuration.
         * @param {Object} updates - { defaultType, duration, reducedMotionDuration, lockTimeout }
         */
        configure(updates) {
            if (updates.defaultType && _state.registeredTransitions.has(updates.defaultType)) {
                _state.config.defaultType = updates.defaultType;
            }
            if (typeof updates.duration === 'number' && updates.duration >= 0) {
                _state.config.duration = updates.duration;
            }
            if (typeof updates.reducedMotionDuration === 'number' && updates.reducedMotionDuration >= 0) {
                _state.config.reducedMotionDuration = updates.reducedMotionDuration;
            }
            if (typeof updates.lockTimeout === 'number' && updates.lockTimeout > 0) {
                _state.config.lockTimeout = updates.lockTimeout;
            }
            emit('configured', { config: { ..._state.config } });
            console.log('[TransitionEngine] Configuration updated:', _state.config);
        },

        /**
         * Get current configuration.
         * @returns {Object}
         */
        getConfig() {
            return { ..._state.config };
        },

        // --- Diagnostics ---

        /**
         * Get diagnostic information.
         * @returns {Object}
         */
        diagnostics() {
            return {
                state: {
                    isTransitioning: _state.isTransitioning,
                    current: _state.currentTransition,
                    queueLength: _state.queue.length,
                    totalTransitions: _state.transitionCount,
                    isInitialized: _state.isInitialized,
                    lastTransition: _state.lastTransition,
                },
                config: { ..._state.config },
                availableTransitions: this.listTransitions(),
                reducedMotion: isReducedMotion(),
                timestamp: Date.now(),
            };
        },

        /**
         * Reset the transition engine.
         */
        reset() {
            this.clearQueue();
            if (_state.isTransitioning) this.cancel();
            _state.transitionCount = 0;
            _state.lastTransition = null;
            emit('reset');
            console.log('[TransitionEngine] Reset.');
        },

        // --- Private Helpers ---

        /**
         * Resolve a section name or identifier to a DOM element.
         * DOM convention used (in priority order):
         *   1. id="section-{name}"        e.g. id="section-hero"
         *   2. data-section="{name}"       e.g. data-section="hero"
         *   3. class="section-{name}"      e.g. class="section-hero"
         * ⚠️ Confirm which convention your HTML uses and ensure it matches.
         * If none match, returns null — transitions will silently no-op (safe).
         * @private
         */
        _resolveSectionElement(section) {
            if (!section) return null;
            if (typeof section === 'string') {
                return (
                    document.getElementById(`section-${section}`) ||
                    document.querySelector(`[data-section="${section}"]`) ||
                    document.querySelector(`.section-${section}`) ||
                    null
                );
            }
            if (section instanceof Element) return section;
            if (section && typeof section.getElement === 'function') return section.getElement();
            return null;
        },

        /**
         * Process the transition queue.
         * Called in finally block of transition() — runs after success OR error.
         * @private
         */
        _processQueue() {
            if (_state.queue.length === 0 || _state.isTransitioning) return;
            const next = _state.queue.shift();
            if (next) {
                console.log(`[TransitionEngine] Processing queued transition (${_state.queue.length} remaining)`);
                this.transition(next.from, next.to, next.options)
                    .then(next.resolve)
                    .catch(next.reject);
            }
        },
    };

    // ---------- Expose to Global ----------
    global.TransitionEngine = TransitionEngine;

    // FIX: Added runtime:booted fallback — mirrors section-controller.js pattern.
    // If transition-engine.js loads before runtime.js (correct load order),
    // Runtime does not exist yet. Without this fallback, Runtime.TransitionEngine
    // silently never gets attached.
    if (global.Runtime) {
        global.Runtime.TransitionEngine = TransitionEngine;
    } else {
        document.addEventListener('runtime:booted', () => {
            if (global.Runtime) {
                global.Runtime.TransitionEngine = TransitionEngine;
            }
        }, { once: true });
    }

    console.log('[TransitionEngine] Loaded and ready. Call TransitionEngine.init() to start.');

})(typeof window !== 'undefined' ? window : this);
