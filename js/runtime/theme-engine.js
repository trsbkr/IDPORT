// theme-engine.js — Website Runtime Theme Engine
// ================================================================
// PHASE 10.G.2 — FINAL REVISION
// (Deterministic Runtime attachment, restore() strictly scoped to
//  confirmed ownership, duplicate-attachment guard, guaranteed
//  body-mode reapplication on restore, forward-compatible
//  persistence shape.)
// ================================================================
// Owns:
//   - Current application theme + mode (normal / liquid / neon)
//   - body.<mode>-mode class ownership (the ONLY thing that
//     drives Hero's liquid-metal/neon CSS effects)
//   - Persistence of the user's theme choice (localStorage, inline)
//   - Optional Theme Library override lookup (falls back cleanly
//     if Theme Library is absent or still a stub)
//   - Broadcasting `runtime:theme:changed` for any listener
//
// Does NOT own (belongs to Hero's own Engine 7 / hero.js):
//   - Hero design tokens (--hero-bg, --hero-accent, etc.)
//   - Hero token registry / validation
//   - Portrait, Quote, Navigation, Animation logic
//
// Does NOT own (belongs to Charcoal Crimson):
//   - Environment, Lighting, Materials, Atmosphere, Rendering
// ================================================================

(function(global) {
    'use strict';

    const STORAGE_KEY = 'idport:runtime:theme';

    // Runtime's own local mode resolver is the primary source of
    // truth. Theme Library (if/when populated) is an optional
    // override layer, never a required dependency — Theme Library
    // is still a stub as of Phase 10, so Runtime must be able to
    // function correctly without it.
    const LOCAL_MODE_MAP = {
        'charcoal-crimson': 'liquid-mode',
        // future themes map here, e.g. 'emerald-aurora': 'neon-mode'
    };

    function resolveMode(themeName) {
        const library = global.ThemeLibrary || global.Runtime?.ThemeLibrary;
        const fromLibrary = library?.list?.find?.(t => t.name === themeName);
        if (fromLibrary?.mode) return fromLibrary.mode;
        return LOCAL_MODE_MAP[themeName] || 'normal-mode';
    }

    // ── Persistence (forward-compatible shape) ──────────────────
    // Stored as { theme: name } rather than a raw string, so future
    // fields (mode, timestamp, version, migration info, etc.) can be
    // added later without needing a storage-format migration.
    function readStorage(key) {
        try {
            const raw = global.localStorage?.getItem(key);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch (err) {
            return null;
        }
    }

    function writeStorage(key, value) {
        try {
            global.localStorage?.setItem(key, JSON.stringify(value));
        } catch (err) {
            console.warn('[ThemeEngine] Persistence failed:', err);
        }
    }

    // ── Body mode ownership ──────────────────────────────────────
    // This is the ONLY code in the whole codebase that should ever
    // touch body.liquid-mode / neon-mode / normal-mode. Hero's own
    // Theme Engine (Engine 7, inside hero.js) must never do this —
    // that was the exact contamination this file's restoration
    // exists to remove.
    function applyBodyMode(mode) {
        document.body.classList.remove('liquid-mode', 'neon-mode', 'normal-mode');
        document.body.classList.add(mode);
    }

    const ThemeEngine = {
        current: 'charcoal-crimson',

        /**
         * Set the active application theme/mode.
         * Owns body class, persistence, and broadcast only.
         *
         * @param {string} name
         * @param {{force?: boolean}} [opts] - force reapplies the body
         *   mode class even if `name` matches the current theme.
         *   Needed by restore() — see below.
         */
        set(name, { force = false } = {}) {
            // Naming note: `sameTheme` means "the requested theme is
            // already the current one" — not "only the mode changed".
            // (Earlier draft used the more ambiguous name
            // `modeChangedOnly`, corrected per review.)
            const sameTheme = this.current === name;
            if (sameTheme && !force) return;

            this.current = name;
            const mode = resolveMode(name);

            applyBodyMode(mode);
            writeStorage(STORAGE_KEY, { theme: name });

            document.dispatchEvent(new CustomEvent('runtime:theme:changed', {
                detail: { theme: name, mode }
            }));
        },

        /**
         * Restore a previously persisted theme choice, if any.
         *
         * IMPORTANT: always calls set() with { force: true } — even
         * when the stored theme equals `this.current` — because a
         * plain equality check would otherwise skip reapplying the
         * body mode class entirely. Without `force`, this scenario
         * would silently fail to restore the visual state:
         *   1. Runtime believes the current theme is already
         *      "charcoal-crimson" (this.current already matches).
         *   2. The <body> class was removed/reset for any reason
         *      (hot reload, partial refresh, external script).
         *   3. restore() calls set("charcoal-crimson") with no force.
         *   4. set() sees `sameTheme === true`, returns immediately.
         *   5. body class is never reapplied — app "loses" its
         *      visual state even though ThemeEngine's internal
         *      record thinks everything is fine.
         * `force: true` guarantees step 4 never short-circuits the
         * DOM repair, regardless of what ThemeEngine already believes
         * the current theme to be.
         */
        restore() {
            const saved = readStorage(STORAGE_KEY);
            const name = (saved && typeof saved.theme === 'string') ? saved.theme : this.current;
            this.set(name, { force: true });
        },

        getCurrent() { return this.current; },
        getMode() { return resolveMode(this.current); },
    };

    global.ThemeEngine = ThemeEngine;

    // ── Runtime attachment (deterministic, not guessed) ──────────
    // Do not assume `global.Runtime` already exists at the moment
    // this file is evaluated — that depends entirely on script load
    // order, which should never be something this file has to guess
    // about. Instead:
    //   - If `global.Runtime` already exists, Runtime has already
    //     finished its own synchronous script execution (including
    //     Runtime.init()) by the time this script runs — attach now.
    //   - Otherwise, wait for the same `runtime:booted` event that
    //     runtime.js already dispatches at the end of its own init().
    // This exactly mirrors the dual-path pattern already used by
    // section-controller.js, for consistency across Runtime files.
    //
    // Adjustment A (ownership strictness) — restore() must run ONLY
    // inside the branch where Runtime is confirmed to exist AND has
    // actually received ThemeEngine. An earlier draft called
    // ThemeEngine.restore() unconditionally inside attachToRuntime(),
    // meaning restoration (and body-class mutation) could happen even
    // if Runtime was never actually attached — e.g. if something
    // called attachToRuntime() manually before Runtime existed. That
    // violates "Runtime is the authoritative owner of this state."
    // Restoration is now strictly downstream of confirmed attachment.
    //
    // Adjustment B (duplicate-attachment guard) — the `attached` flag
    // prevents attachToRuntime()'s effects (Runtime assignment +
    // restore()) from running more than once, in case `runtime:booted`
    // is ever dispatched more than once (accidentally or otherwise).
    // Note the guard only latches to `true` AFTER both the "not
    // already attached" and "Runtime actually exists" checks pass —
    // so a call that arrives before Runtime exists safely no-ops
    // without permanently blocking a later, legitimate attach attempt.
    let attached = false;

    function attachToRuntime() {
        if (attached) return;
        if (!global.Runtime) return;

        attached = true;
        global.Runtime.ThemeEngine = ThemeEngine;
        ThemeEngine.restore();
    }

    if (global.Runtime) {
        attachToRuntime();
    } else {
        document.addEventListener('runtime:booted', attachToRuntime, { once: true });
    }

})(typeof window !== 'undefined' ? window : this);




























/* ============================================================
   ENGINE 7 — THEME (REVISED with all reviewer fixes)
   ============================================================
   Fixes applied:
   1. ✅ Duplicate theme prevention
   2. ✅ Transition lock + pending queue
   3. ✅ Fallback event emission
   4. ✅ NO unregister (as reviewer requested)
   5. ✅ Theme ready event
   6. ✅ Enhanced diagnostics
   7. ✅ Token verification
   8. ✅ Theme metadata (version, author)
   9. ✅ Token diffing
   10. ✅ Destroy/initialization guards
   11-14. ✅ Notify Animation, Portrait, Quote, Navigation
   15. ✅ Initialization guard
   ============================================================ */

/* function initThemeEngine() {
    const REQUIRED_TOKENS = [
        "--hero-bg", "--hero-text", "--hero-quote-color", "--hero-accent",
        "--hero-accent-glow", "--hero-switch-base", "--hero-switch-knob",
        "--hero-dot-color", "--hero-name-weight"
    ];

    const themeRegistry = new Map();

    // ---------- FIX 8: Theme Metadata ----------
    function createThemeEntry(name, tokens, metadata = {}) {
        return Object.freeze({
            name,
            tokens: Object.freeze({ ...tokens }),
            version: metadata.version || "1.0.0",
            author: metadata.author || "IDPORT",
            createdAt: metadata.createdAt || new Date().toISOString(),
            description: metadata.description || "",
        });
    }

    function validateTheme(config) {
        for (const token of REQUIRED_TOKENS) {
            if (!(token in config)) {
                console.error(`[Hero Theme] Missing required token: ${token}`);
                return false;
            }
        }
        return true;
    }

    // ---------- FIX 2: Transition Lock + Queue ----------
    let _transitionLock = false;
    let _pendingTheme = null;
    let _pendingMode = null;
    let _isFirstBoot = true;
    let _initialThemeApplied = false;

    // ---------- FIX 15: Initialization Guard ----------
    let _initialized = false;

    // ---------- FIX 10: Destroy Guard ----------
    function isThemeAllowed() {
        const status = window.Hero?.getStatus ? window.Hero.getStatus() : currentStatus;
        if (status === "destroyed" || status === "uninitialized") {
            console.warn(`[Hero Theme] Theme update blocked: status = ${status}`);
            return false;
        }
        return true;
    }

    // ---------- FIX 9: Token Diffing ----------
    function getTokenDiff(oldTokens, newTokens) {
        const changed = {};
        const allKeys = new Set([...Object.keys(oldTokens || {}), ...Object.keys(newTokens || {})]);
        for (const key of allKeys) {
            const oldVal = oldTokens?.[key];
            const newVal = newTokens?.[key];
            if (oldVal !== newVal) {
                changed[key] = newVal;
            }
        }
        return changed;
    }

    // ---------- FIX 7: Token Verification ----------
    function verifyTokenApplication(root, token, expectedValue) {
        if (!root || !root.style) return false;
        try {
            const computed = getComputedStyle(root);
            const actualValue = computed.getPropertyValue(token).trim();
            // Normalize both values for comparison
            const expected = String(expectedValue).trim();
            const actual = String(actualValue).trim();
            return actual === expected;
        } catch (_) {
            return false;
        }
    }

    // ---------- Core Registration ----------
    function registerTheme(name, config, metadata = {}) {
        if (!validateTheme(config)) return false;

        // FIX 15: Guard against re-registration
        if (themeRegistry.has(name) && _initialized) {
            console.warn(`[Hero Theme] Theme "${name}" already registered. Skipping duplicate.`);
            return false;
        }

        const entry = createThemeEntry(name, config, metadata);
        themeRegistry.set(name, entry);
        console.log(`[Hero Theme] Registered: ${name} v${entry.version}`);
        return true;
    }

    // ---------- Register Built-in Themes ----------
    registerTheme("charcoal-crimson", {
        "--hero-bg": "#1a1c20",
        "--hero-text": "#ffffff",
        "--hero-quote-color": "rgba(255,255,255,0.8)",
        "--hero-accent": "#dc1a2a",
        "--hero-accent-glow": "rgba(220,26,42,0.4)",
        "--hero-switch-base": "linear-gradient(145deg,#2d2d2d,#121212)",
        "--hero-switch-knob": "linear-gradient(145deg,#4d4d4d,#141414)",
        "--hero-dot-color": "#00ff88",
        "--hero-name-weight": "600"
    }, {
        version: "4.6.0.5.7",
        author: "IDPORT",
        description: "Charcoal Crimson v4.6.0.5.7 — signature dark theme"
    });

    registerTheme("emerald-aurora", {
        "--hero-bg": "#0a1a14",
        "--hero-text": "#e0f5ec",
        "--hero-quote-color": "rgba(200,240,220,.85)",
        "--hero-accent": "#00cc77",
        "--hero-accent-glow": "rgba(0,204,119,.5)",
        "--hero-switch-base": "linear-gradient(145deg,#1a3a2a,#0a1a14)",
        "--hero-switch-knob": "linear-gradient(145deg,#2d5a3d,#0a1a14)",
        "--hero-dot-color": "#00ffaa",
        "--hero-name-weight": "600"
    }, {
        version: "1.0.0",
        author: "IDPORT",
        description: "Emerald Aurora — neon green accents"
    });

    registerTheme("midnight-gold", {
        "--hero-bg": "#0a0e1a",
        "--hero-text": "#f5e6c8",
        "--hero-quote-color": "rgba(240,220,180,.85)",
        "--hero-accent": "#d4a017",
        "--hero-accent-glow": "rgba(212,160,23,.5)",
        "--hero-switch-base": "linear-gradient(145deg,#1a1f2e,#0a0e1a)",
        "--hero-switch-knob": "linear-gradient(145deg,#3a3f4e,#1a1a24)",
        "--hero-dot-color": "#ffcc00",
        "--hero-name-weight": "700"
    }, {
        version: "1.0.0",
        author: "IDPORT",
        description: "Midnight Gold — warm golden accents on deep navy"
    });

    _initialized = true;

    // ---------- Core Apply Function (with all fixes) ----------
    function applyTheme(themeName, options = {}) {
        const { force = false, source = "internal" } = options;

        // ---------- FIX 10: Destroy Guard ----------
        if (!isThemeAllowed()) return false;

        // ---------- FIX 1: Duplicate Prevention ----------
        if (!force && themeName === state.theme) {
            console.debug(`[Hero Theme] Theme "${themeName}" already active. Skipping.`);
            return true;
        }

        // ---------- FIX 2: Transition Lock ----------
        if (_transitionLock && !force) {
            _pendingTheme = themeName;
            _pendingMode = options.mode || null;
            console.debug(`[Hero Theme] Transition locked. Queued: "${themeName}"`);
            return false;
        }

        // Resolve theme
        let themeEntry = themeRegistry.get(themeName);
        let resolvedName = themeName;

        // ---------- FIX 3: Fallback + Event ----------
        if (!themeEntry) {
            console.warn(`[Hero Theme] "${themeName}" not found. Using fallback.`);
            themeEntry = themeRegistry.get("charcoal-crimson");
            resolvedName = "charcoal-crimson";

            // Emit fallback event so Runtime knows
            dispatchHeroEvent("hero:theme:fallback", {
                requested: themeName,
                fallback: resolvedName,
                timestamp: Date.now()
            });
        }

        if (!themeEntry) {
            console.error("[Hero Theme] No fallback available.");
            return false;
        }

        // Acquire transition lock
        _transitionLock = true;

        const root = elements.heroSection || document.documentElement;
        const oldTokens = state._lastThemeTokens || {};
        const newTokens = themeEntry.tokens;

        // ---------- FIX 9: Token Diffing ----------
        const changedTokens = getTokenDiff(oldTokens, newTokens);
        const changedKeys = Object.keys(changedTokens);

        // Apply only changed tokens
        let appliedCount = 0;
        for (const [property, value] of Object.entries(changedTokens)) {
            if (root.style.getPropertyValue(property) !== value) {
                root.style.setProperty(property, value);
                appliedCount++;
            }
        }

        // Store for future diff
        state._lastThemeTokens = { ...newTokens };

        // ---------- FIX 7: Token Verification ----------
        if (changedKeys.length > 0) {
            let verificationFailed = false;
            for (const token of changedKeys.slice(0, 5)) { // Check first 5 changed tokens
                const expected = changedTokens[token];
                const verified = verifyTokenApplication(root, token, expected);
                if (!verified) {
                    console.warn(`[Hero Theme] Token verification failed: ${token} = ${expected}`);
                    verificationFailed = true;
                }
            }
            if (verificationFailed) {
                dispatchHeroEvent("hero:theme:verification", {
                    theme: resolvedName,
                    failed: true,
                    timestamp: Date.now()
                });
            }
        }

        // Update state
        state.theme = resolvedName;

        // ---------- FIX 5: Theme Ready Event (first boot only) ----------
        if (_isFirstBoot) {
            _isFirstBoot = false;
            _initialThemeApplied = true;
            dispatchHeroEvent("hero:theme:ready", {
                theme: resolvedName,
                timestamp: Date.now()
            });
            console.log(`[Hero Theme] Ready: ${resolvedName}`);
        }

        // Emit theme changed event
        dispatchHeroEvent("hero:theme:changed", {
            theme: resolvedName,
            previous: state._previousTheme || null,
            changedTokens: changedKeys,
            appliedCount,
            timestamp: Date.now()
        });

        state._previousTheme = resolvedName;

        // ---------- FIX 11-14: Notify Other Engines ----------
        // Notify Animation Engine
        dispatchHeroEvent("hero:theme:animation:update", {
            theme: resolvedName,
            changedTokens: changedKeys,
        });

        // Notify Portrait Engine
        dispatchHeroEvent("hero:theme:portrait:update", {
            theme: resolvedName,
            accentColor: newTokens["--hero-accent"] || null,
        });

        // Notify Quote Engine
        dispatchHeroEvent("hero:theme:quote:update", {
            theme: resolvedName,
            quoteColor: newTokens["--hero-quote-color"] || null,
            accentColor: newTokens["--hero-accent"] || null,
        });

        // Notify Navigation Engine
        dispatchHeroEvent("hero:theme:navigation:update", {
            theme: resolvedName,
            accentColor: newTokens["--hero-accent"] || null,
            glowColor: newTokens["--hero-accent-glow"] || null,
        });

        console.log(`[Hero Theme] Applied: ${resolvedName} (${appliedCount} tokens changed)`);

        // Release lock and process pending
        _transitionLock = false;
        if (_pendingTheme && !force) {
            const pending = _pendingTheme;
            const pendingMode = _pendingMode;
            _pendingTheme = null;
            _pendingMode = null;
            // Use setTimeout to avoid reentrancy
            setTimeout(() => {
                applyTheme(pending, { mode: pendingMode, force: true });
            }, 0);
        }

        return true;
    }

    // ---------- Apply Initial Theme ----------
    const initialTheme = state.theme || "charcoal-crimson";
    applyTheme(initialTheme, { force: true });

    // ---------- FIX 10: Destroy Guard in Listener ----------
    // Runtime listener with destroy guard
    addManagedListener(document, "runtime:theme:changed", (e) => {
        if (!isThemeAllowed()) return;
        const theme = e.detail?.theme;
        if (theme) {
            applyTheme(theme);
        }
    });

    // Also listen for hero theme requests
    addManagedListener(document, "hero:theme:request", (e) => {
        if (!isThemeAllowed()) return;
        const { theme, mode } = e.detail || {};
        if (theme) {
            applyTheme(theme, { mode });
        }
    });

    // ---------- Public API ----------
    engines.theme = {
        apply: applyTheme,
        register: registerTheme,
        hasTheme: (name) => themeRegistry.has(name),
        getCurrent: () => state.theme,

        // ---------- FIX 6: Enhanced Diagnostics ----------
        diagnostics: () => {
            const entries = Array.from(themeRegistry.entries()).map(([name, entry]) => ({
                name,
                version: entry.version || "1.0.0",
                author: entry.author || "IDPORT",
                tokenCount: Object.keys(entry.tokens).length,
                isActive: name === state.theme,
            }));

            return {
                activeTheme: state.theme,
                previousTheme: state._previousTheme || null,
                totalThemes: themeRegistry.size,
                availableThemes: Array.from(themeRegistry.keys()),
                themeDetails: entries,
                isTransitionLocked: _transitionLock,
                hasPendingTheme: !!_pendingTheme,
                pendingTheme: _pendingTheme,
                isFirstBoot: _isFirstBoot,
                initialThemeApplied: _initialThemeApplied,
                lastAppliedTokens: state._lastThemeTokens
                    ? Object.keys(state._lastThemeTokens).length + " tokens"
                    : "none",
                timestamp: Date.now(),
            };
        },

        // Additional methods for metadata access
        getThemeInfo: (name) => {
            const entry = themeRegistry.get(name);
            if (!entry) return null;
            return {
                name: entry.name,
                version: entry.version,
                author: entry.author,
                description: entry.description,
                tokenCount: Object.keys(entry.tokens).length,
            };
        },

        getAllThemesInfo: () => {
            return Array.from(themeRegistry.entries()).map(([name, entry]) => ({
                name,
                version: entry.version,
                author: entry.author,
                description: entry.description,
                isActive: name === state.theme,
            }));
        },

        // ---------- FIX 2: Transition Control ----------
        getTransitionState: () => ({
            locked: _transitionLock,
            pending: _pendingTheme,
            isFirstBoot: _isFirstBoot,
        }),

        // ---------- FIX 10: Force unlock if stuck ----------
        forceUnlock: () => {
            if (_transitionLock) {
                _transitionLock = false;
                _pendingTheme = null;
                _pendingMode = null;
                console.warn("[Hero Theme] Transition lock force-unlocked.");
                return true;
            }
            return false;
        },
    };
} */
