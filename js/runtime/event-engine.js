// ================================================================
// EVENT-ENGINE.JS — Central Event Bus
// ================================================================
// File: js/runtime/event-engine.js
// Pure event bus. No DOM manipulation, no state ownership.
// Single source of truth for all cross-module communication.
//
// MERGE LOG — Surgical extraction from Dev One + Dev Two:
//
// FROM DEV ONE (architecture wins):
//   ✅ detachAbort() extracted as reusable utility
//   ✅ removeListenerFromSet() removes ALL matching callbacks
//   ✅ detachAbort() called inside emit() on once-entry fire
//   ✅ safeCall() defensive guard on err.message / err.stack
//   ✅ off() returns removed count (not boolean)
//
// FROM DEV TWO (correctness wins):
//   ✅ isWildcardPattern() uses endsWith('*') — correct
//   ✅ matchesWildcard() correct prefix extraction
//   ✅ safeCall() valid template literal syntax
//   ✅ Overall clean, parse-safe structure
//
// NEW IN MERGE (gaps neither version addressed):
//   ✅ Post-destroy guard — emit/on/off warn and no-op after destroy()
//   ✅ console.log/warn guarded by Runtime?.config?.debug
//   ✅ destroy() sets _destroyed flag, clears all listener maps
//   ✅ has() utility — check if any listeners exist for an event
//   ✅ Runtime attachment is passive — Runtime owns the attach on boot
// ================================================================

(function (global) {
    'use strict';

    // ---------- Private Storage ----------
    const _listeners = new Map();   // exact event  -> Set<ListenerEntry>
    const _wildcards = new Map();   // pattern       -> Set<ListenerEntry>
    let _listenerId = 0;
    let _destroyed  = false;

    // ---------- Entry Factory ----------
    function createListener(callback, once = false, signal = null) {
        return {
            id: ++_listenerId,
            callback,
            once,
            signal,
            _abortHandler: null,
        };
    }

    // ---------- Wildcard Utilities ----------
    // FROM DEV TWO — endsWith('*') is the correct implementation.
    // Dev One's endsWith('') matched every string — fatal routing failure.
    function isWildcardPattern(pattern) {
        return typeof pattern === 'string' && pattern.endsWith('*');
    }

    function matchesWildcard(pattern, eventName) {
        if (!isWildcardPattern(pattern)) return false;
        const prefix = pattern.slice(0, -1); // strip trailing '*'
        return eventName.startsWith(prefix);
    }

    // ---------- Set Utilities ----------
    function getListenerSet(map, key) {
        if (!map.has(key)) map.set(key, new Set());
        return map.get(key);
    }

    // FROM DEV ONE — Extracted utility, called consistently across
    // off(), emit(), and clearAll(). Prevents abort handler leaks
    // in all code paths, not just explicit removal.
    function detachAbort(entry) {
        if (entry && entry.signal && entry._abortHandler) {
            try {
                entry.signal.removeEventListener('abort', entry._abortHandler);
            } catch (_) {}
            entry._abortHandler = null;
        }
    }

    // FROM DEV ONE — Removes ALL registrations of a callback for an event.
    // Dev Two's first-match-only approach silently leaked duplicate registrations
    // in component lifecycle mismanagement scenarios.
    // Returns count of removed entries for caller awareness.
    function removeListenerFromSet(set, callback) {
        let removed = 0;
        for (const entry of Array.from(set)) {
            if (entry.callback === callback) {
                detachAbort(entry);     // ← Dev One win: abort cleanup on every removal
                set.delete(entry);
                removed++;
                // intentionally no early return — purge all duplicates
            }
        }
        return removed;
    }

    function removeAllFromSet(set) {
        for (const entry of set) detachAbort(entry);
        set.clear();
    }

    // ---------- Safe Invocation ----------
    // FROM DEV TWO — valid template literal syntax (Dev One had encoding corruption).
    // FROM DEV ONE — defensive err.message / err.stack existence checks
    // (Dev Two assumed an Error object; non-Error throws would crash safeCall itself).
    function safeCall(callback, eventName, payload) {
        try {
            callback(payload, eventName);
        } catch (err) {
            console.error(`[EventEngine] Error in listener for "${eventName}":`, err);

            // Prevent infinite recursion on the error channel itself
            if (eventName !== 'runtime:event:error') {
                try {
                    EventEngine.emit('runtime:event:error', {
                        event:  eventName,
                        error:  err && err.message ? err.message : String(err),
                        stack:  err && err.stack   ? err.stack   : undefined,
                    });
                } catch (_) {}
            }
        }
    }

    // ---------- Destroyed Guard ----------
    // NEW — Neither version prevented post-destroy calls from silently succeeding.
    // A destroyed engine should be inert, not quietly functional.
    function guardDestroyed(methodName) {
        if (_destroyed) {
            if (global.Runtime?.config?.debug) {
                console.warn(`[EventEngine] ${methodName}() called after destroy — no-op.`);
            }
            return true;
        }
        return false;
    }

    // ---------- Public API ----------
    const EventEngine = {

        /**
         * Register a listener for an exact event name or wildcard pattern.
         * Wildcard pattern: ends with '*' — e.g. 'hero:*' matches 'hero:initialized'.
         * @param {string}   event
         * @param {function} callback  — (payload, eventName) => void
         * @param {object}   [options]
         * @param {boolean}  [options.once=false]   — auto-removes after first call
         * @param {AbortSignal} [options.signal=null] — remove on abort
         * @returns {function} Unsubscribe function
         */
        on(event, callback, options = {}) {
            if (guardDestroyed('on')) return () => {};
            if (typeof event !== 'string' || !event.trim() || typeof callback !== 'function') {
                console.warn('[EventEngine] on: invalid arguments');
                return () => {};
            }

            const { once = false, signal = null } = options;
            const entry      = createListener(callback, once, signal);
            const isWildcard = isWildcardPattern(event);
            const targetMap  = isWildcard ? _wildcards : _listeners;
            const set        = getListenerSet(targetMap, event);
            set.add(entry);

            if (signal) {
                const abortHandler = () => {
                    const currentSet = targetMap.get(event);
                    if (currentSet) {
                        detachAbort(entry);
                        currentSet.delete(entry);
                        if (currentSet.size === 0) targetMap.delete(event);
                    }
                };
                entry._abortHandler = abortHandler;
                try {
                    signal.addEventListener('abort', abortHandler, { once: true });
                } catch (_) {}
            }

            return () => this.off(event, callback);
        },

        /**
         * Register a one-time listener. Auto-removes after first invocation.
         */
        once(event, callback, options = {}) {
            return this.on(event, callback, { ...options, once: true });
        },

        /**
         * Remove ALL registrations of a callback for the given event/pattern.
         * FROM DEV ONE — returns removed count so callers can detect partial state.
         * @returns {number} Count of removed registrations
         */
        off(event, callback) {
            if (guardDestroyed('off')) return 0;
            if (typeof event !== 'string' || !event.trim() || typeof callback !== 'function') return 0;

            const isWildcard = isWildcardPattern(event);
            const targetMap  = isWildcard ? _wildcards : _listeners;
            const set        = targetMap.get(event);
            if (!set) return 0;

            const removedCount = removeListenerFromSet(set, callback);
            if (set.size === 0) targetMap.delete(event);
            return removedCount;
        },

        /**
         * Emit an event. Invokes all exact + matching wildcard listeners.
         * Snapshot pattern (Array.from) prevents mid-iteration mutation bugs.
         * once entries have their AbortSignal detached before removal.
         * @returns {number} Count of listeners invoked
         */
        emit(event, payload = undefined) {
            if (guardDestroyed('emit')) return 0;
            if (typeof event !== 'string' || !event.trim()) return 0;

            let count = 0;

            // 1. Exact listeners
            const exactSet = _listeners.get(event);
            if (exactSet) {
                const toCall = Array.from(exactSet); // snapshot before iteration
                for (const entry of toCall) {
                    if (!exactSet.has(entry)) continue; // removed mid-flight guard
                    safeCall(entry.callback, event, payload);
                    count++;
                    if (entry.once) {
                        detachAbort(entry); // FROM DEV ONE — Dev Two missed this
                        exactSet.delete(entry);
                    }
                }
                if (exactSet.size === 0) _listeners.delete(event);
            }

            // 2. Wildcard listeners
            for (const [pattern, set] of _wildcards) {
                if (!matchesWildcard(pattern, event)) continue;

                const toCall = Array.from(set); // snapshot before iteration
                for (const entry of toCall) {
                    if (!set.has(entry)) continue; // removed mid-flight guard
                    safeCall(entry.callback, event, payload);
                    count++;
                    if (entry.once) {
                        detachAbort(entry); // FROM DEV ONE — consistent with exact path
                        set.delete(entry);
                    }
                }
                if (set.size === 0) _wildcards.delete(pattern);
            }

            return count;
        },

        /**
         * Remove all listeners for a specific event or pattern.
         * @returns {number} Count of removed listeners
         */
        clear(event) {
            if (guardDestroyed('clear')) return 0;
            if (typeof event !== 'string' || !event.trim()) return 0;

            const isWildcard = isWildcardPattern(event);
            const targetMap  = isWildcard ? _wildcards : _listeners;
            const set        = targetMap.get(event);
            if (!set) return 0;

            const removed = set.size;
            removeAllFromSet(set);
            targetMap.delete(event);
            return removed;
        },

        /**
         * Remove ALL listeners across all events and patterns.
         * @returns {number} Total count of removed listeners
         */
        clearAll() {
            let total = 0;
            for (const set of _listeners.values()) { total += set.size; removeAllFromSet(set); }
            for (const set of _wildcards.values()) { total += set.size; removeAllFromSet(set); }
            _listeners.clear();
            _wildcards.clear();
            return total;
        },

        /**
         * Return listener count for a specific event or pattern.
         */
        listenerCount(event) {
            if (typeof event !== 'string' || !event.trim()) return 0;
            const isWildcard = isWildcardPattern(event);
            const map        = isWildcard ? _wildcards : _listeners;
            const set        = map.get(event);
            return set ? set.size : 0;
        },

        /**
         * NEW — Check if any listeners exist for a given event or pattern.
         * Convenience guard for emitters that want to skip payload
         * construction when no one is listening.
         * @returns {boolean}
         */
        has(event) {
            return this.listenerCount(event) > 0;
        },

        /**
         * Return diagnostic snapshot — safe for logging and Runtime.diagnostics().
         */
        diagnostics() {
            let exactListeners    = 0;
            let wildcardListeners = 0;
            for (const set of _listeners.values()) exactListeners    += set.size;
            for (const set of _wildcards.values()) wildcardListeners += set.size;

            return {
                destroyed:        _destroyed,
                totalListeners:   exactListeners + wildcardListeners,
                exactEvents:      _listeners.size,
                wildcardPatterns: _wildcards.size,
                exactListeners,
                wildcardListeners,
                timestamp:        Date.now(),
            };
        },

        /**
         * Return registered event keys and wildcard patterns.
         * Returns shallow copies — callers cannot mutate internal maps.
         */
        registry() {
            return {
                exact:    Array.from(_listeners.keys()),
                wildcard: Array.from(_wildcards.keys()),
            };
        },

        /**
         * Destroy the engine — clears all listeners, marks as inert.
         * All subsequent calls to on/off/emit/clear will no-op with a warning.
         */
        destroy() {
            this.clearAll();
            _destroyed = true;
            if (global.Runtime?.config?.debug) {
                console.log('[EventEngine] Destroyed.');
            }
        },
    };

    // ---------- Expose ----------
    global.EventEngine = EventEngine;

    // EventEngine is passive — it exposes itself on the global scope only.
    // Runtime is responsible for attaching window.EventEngine during its
    // own boot sequence. No DOM dependency, no inverted dependency.

})(typeof window !== 'undefined' ? window : this);
