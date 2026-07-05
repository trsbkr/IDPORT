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

function initThemeEngine() {
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
}
