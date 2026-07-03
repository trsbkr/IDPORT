/* ================================================================
   IDPORT HERO MODULE
   Version: 1.1.0 — Integration Pass (Level 1)
   ----------------------------------------------------------------
   This file consolidates Engines 1-12 with every fix identified in
   the Master Engine Review & Debug Reference applied. It is written
   as a classic (non-module) script so it can be direct-loaded in
   <head>/<body> for LCP performance, per the locked hybrid loading
   decision, without requiring index.html to switch to ES modules.

   CLEANUP STRATEGY (unified, per Master Fix #1):
   Every engine pushes its own teardown closures into the single
   shared `listeners` array. There is no per-engine destroy(). Only
   Hero.destroy() drains `listeners`. Engines that need runtime
   pause/resume behaviour (distinct from teardown) still expose
   pause()/resume() on their engine object.
================================================================ */

const Hero = (() => {

    "use strict";

    /* ============================================================
       LIFECYCLE STATE MACHINE
    ============================================================ */

    const STATUS = Object.freeze({
        UNINITIALIZED: "uninitialized",
        INITIALIZING:  "initializing",
        ACTIVE:        "active",
        SUSPENDED:     "suspended",
        DESTROYED:     "destroyed"
    });

    let currentStatus = STATUS.UNINITIALIZED;

    /* ============================================================
       PRIVATE REGISTRIES
       (kept as stable object references — destroy() clears keys
       rather than reassigning, so no closure ever holds a stale
       reference to an old object.)
    ============================================================ */

    const engines = {};
    const elements = {};
    const state = {};
    const listeners = []; // shared cleanup: array of () => void

    function clearOwnKeys(obj) {
        Object.keys(obj).forEach(k => delete obj[k]);
    }

    /* ============================================================
       INTERNAL UTILITIES
    ============================================================ */

    function dispatchHeroEvent(name, detail) {
        document.dispatchEvent(new CustomEvent(name, {
            bubbles: true,
            cancelable: false,
            detail
        }));
    }

    function addManagedListener(target, type, handler, options) {
        target.addEventListener(type, handler, options);
        listeners.push(() => target.removeEventListener(type, handler, options));
    }

    /* ============================================================
       DOM CACHE + VALIDATION
    ============================================================ */

    function cacheDOM() {
        elements.heroSection      = document.getElementById("hero");
        elements.fusionCanvas     = document.getElementById("fusion-canvas");
        elements.heroName         = document.querySelector(".hero-name");
        elements.heroQuote        = document.querySelector(".hero-quote");
        elements.heroPortrait     = document.querySelector(".hero-portrait");
        elements.heroPortraitImg  = document.querySelector(".hero-portrait-image");
        elements.heroNav          = document.querySelector(".hero-nav");
        elements.menuSwitch       = document.getElementById("menu-switch");
        elements.dropdownMenu     = document.getElementById("dropdown-menu");
        elements.allSwitchBtns    = document.querySelectorAll(".switch-btn");
        elements.navSwitchBtns    = document.querySelectorAll(".switch-btn[data-target]");
    }

    function validateHeroDOM() {
        const missing = [];
        if (!elements.heroSection) missing.push("#hero");
        if (!elements.heroName)    missing.push(".hero-name");
        if (!elements.heroQuote)   missing.push(".hero-quote");
        if (!elements.heroPortrait) missing.push(".hero-portrait");
        return { valid: missing.length === 0, missing };
    }

    function initialiseState() {
        Object.assign(state, {
            theme: "charcoal-crimson",
            mode: "liquid",
            menuOpen: false,
            activeSwitch: null,
            quoteIndex: 0,
            portraitLoaded: false,
            animationPhase: "idle",
            bridgeReady: false
        });
    }

    /* ============================================================
       ENGINE 2 — NAVIGATION
    ============================================================ */

    function initNavigationEngine() {
        if (!elements.navSwitchBtns || elements.navSwitchBtns.length === 0) {
            console.warn("[Hero] Navigation Engine: no navigation switches found.");
            return;
        }

        const NAVIGATION_DELAY = 450;

        function performNavigation(target) {
            if (state.bridgeReady && engines.runtimeBridge &&
                typeof engines.runtimeBridge.notifyNavigate === "function") {
                engines.runtimeBridge.notifyNavigate(target);
            }
            window.location.href = target;
        }

        function handleSwitchClick(btn) {
            if (!btn || btn.classList.contains("navigating")) return;

            const target = btn.dataset.target;
            if (!target) {
                console.warn("[Hero] Navigation Engine: switch missing data-target.");
                return;
            }

            btn.classList.add("active", "navigating");
            state.activeSwitch = target;

            dispatchHeroEvent("hero:navigation:started", { target });
            dispatchHeroEvent("hero:navigation:beforeNavigate", { target });

            const timer = setTimeout(() => {
                performNavigation(target);
                btn.classList.remove("navigating");
                dispatchHeroEvent("hero:navigation:completed", { target });
            }, NAVIGATION_DELAY);

            listeners.push(() => clearTimeout(timer));
        }

        elements.navSwitchBtns.forEach(btn => {
            const handler = () => handleSwitchClick(btn);
            addManagedListener(btn, "click", handler);
        });

        engines.navigation = {
            getActiveTarget: () => state.activeSwitch,
            navigateTo(target) {
                const btn = Array.from(elements.navSwitchBtns)
                    .find(b => b.dataset.target === target);
                if (btn) handleSwitchClick(btn);
                else console.warn(`[Hero] Navigation Engine: target "${target}" not found.`);
            }
        };
    }

    /* ============================================================
       ENGINE 3 — STATE RESET
    ============================================================ */

    function initStateResetEngine() {

        function resetHeroState(force = false) {
            if (!force &&
                !state.menuOpen &&
                state.activeSwitch === null &&
                state.quoteIndex === 0 &&
                state.animationPhase === "idle" &&
                !state.portraitLoaded) {
                return;
            }

            elements.allSwitchBtns?.forEach(btn => {
                btn.classList.remove("active", "navigating");
            });

            elements.dropdownMenu?.classList.remove("active");
            elements.menuSwitch?.classList.remove("active");
            elements.dropdownMenu?.setAttribute("aria-hidden", "true");
            elements.menuSwitch?.setAttribute("aria-expanded", "false");

            state.menuOpen = false;
            state.activeSwitch = null;
            state.quoteIndex = 0;
            state.animationPhase = "idle";
            state.portraitLoaded = false;
            /* Theme + mode intentionally preserved */

            if (engines.liquidState) {
                elements.allSwitchBtns?.forEach(btn => engines.liquidState.updateFromState(btn));
            }

            dispatchHeroEvent("hero:state:reset", { timestamp: Date.now() });
        }

        const pageShowHandler = (event) => { if (event.persisted) resetHeroState(); };
        addManagedListener(window, "pageshow", pageShowHandler);

        const popStateHandler = () => resetHeroState();
        addManagedListener(window, "popstate", popStateHandler);

        engines.stateReset = {
            reset: resetHeroState,
            resetMenu() {
                elements.dropdownMenu?.classList.remove("active");
                elements.menuSwitch?.classList.remove("active");
                state.menuOpen = false;
            }
        };
    }

    /* ============================================================
       ENGINE 4 — MENU
       (CSS drives visibility via opacity/visibility/transform on
       .dropdown-menu.active — never toggle `hidden`, it forces
       display:none and kills the transition.)
    ============================================================ */

    function initMenuEngine() {
        if (!elements.menuSwitch || !elements.dropdownMenu) {
            console.warn("[Hero] Menu Engine: required elements missing.");
            return;
        }

        const menuSwitch = elements.menuSwitch;
        const dropdownMenu = elements.dropdownMenu;

        function renderMenuState() {
            menuSwitch.classList.toggle("active", state.menuOpen);
            dropdownMenu.classList.toggle("active", state.menuOpen);
            menuSwitch.setAttribute("aria-expanded", String(state.menuOpen));
            dropdownMenu.setAttribute("aria-hidden", String(!state.menuOpen));
        }

        function openMenu() {
            if (state.menuOpen) return;
            state.menuOpen = true;
            renderMenuState();
            dropdownMenu.querySelector(".switch-btn")?.focus();
            dispatchHeroEvent("hero:menu:opened", {});
        }

        function closeMenu(returnFocus = false) {
            if (!state.menuOpen) return;
            state.menuOpen = false;
            renderMenuState();
            if (returnFocus) menuSwitch.focus();
            dispatchHeroEvent("hero:menu:closed", {});
        }

        function toggleMenu() {
            state.menuOpen ? closeMenu(true) : openMenu();
        }

        addManagedListener(menuSwitch, "click", (e) => {
            e.stopPropagation();
            toggleMenu();
        });

        addManagedListener(document, "click", (e) => {
            if (!state.menuOpen) return;
            const insideMenu = dropdownMenu.contains(e.target);
            const insideSwitch = menuSwitch.contains(e.target);
            if (!insideMenu && !insideSwitch) closeMenu(false); // no focus steal on outside click
        });

        addManagedListener(document, "keydown", (e) => {
            if (e.key === "Escape" && state.menuOpen) closeMenu(true);
        });

        addManagedListener(dropdownMenu, "click", (e) => {
            if (e.target.closest(".switch-btn[data-target]")) closeMenu(false);
        });

        engines.menu = {
            open: openMenu,
            close: () => closeMenu(false),
            toggle: toggleMenu,
            isOpen: () => state.menuOpen
        };

        renderMenuState();
    }

    /* ============================================================
       ENGINE 5 — LIQUID POINTER
       (rAF-batched, single shared resize/scroll listener for all
       buttons instead of one pair per button.)
    ============================================================ */

    function initLiquidPointerEngine() {
        if (!elements.allSwitchBtns || elements.allSwitchBtns.length === 0) {
            console.warn("[Hero] Liquid Pointer Engine: no switches found.");
            return;
        }

        const DEFAULT_POINTER = "0.100";
        let paused = false;
        const trackedButtons = [];

        elements.allSwitchBtns.forEach(btn => {
            let rect = btn.getBoundingClientRect();
            let rafId = null;
            let pendingEvent = null;

            function updateBounds() { rect = btn.getBoundingClientRect(); }

            function renderPointer() {
                if (!pendingEvent || paused) { rafId = null; return; }
                const e = pendingEvent;
                const x = (e.clientX - rect.left) / rect.width;
                const y = (e.clientY - rect.top) / rect.height;
                const mx = Math.min(Math.max(x, 0), 1);
                const my = Math.min(Math.max(y, 0), 1);
                btn.style.setProperty("--mx", mx.toFixed(3));
                btn.style.setProperty("--my", my.toFixed(3));
                btn.style.setProperty("--pointer-active", "1");
                pendingEvent = null;
                rafId = null;
            }

            function handlePointerMove(e) {
                if (paused || !e.isPrimary) return;
                pendingEvent = e;
                if (!rafId) rafId = requestAnimationFrame(renderPointer);
            }

            function handlePointerDown() {
                btn.classList.add("pressing");
                btn.style.setProperty("--glow", "1");
            }

            function handlePointerUp() {
                btn.classList.remove("pressing");
                btn.style.setProperty("--glow", "0");
            }

            function handlePointerLeave() {
                btn.classList.remove("pressing");
                btn.style.setProperty("--glow", "0");
                btn.style.setProperty("--pointer-active", "0");
                btn.style.setProperty("--mx", DEFAULT_POINTER);
                btn.style.setProperty("--my", DEFAULT_POINTER);
            }

            addManagedListener(btn, "pointermove", handlePointerMove);
            addManagedListener(btn, "pointerdown", handlePointerDown);
            addManagedListener(btn, "pointerup", handlePointerUp);
            addManagedListener(btn, "pointerleave", handlePointerLeave);

            listeners.push(() => { if (rafId) cancelAnimationFrame(rafId); });

            trackedButtons.push({ element: btn, updateBounds, getRect: () => rect });
        });

        const refreshAllBounds = () => trackedButtons.forEach(tb => tb.updateBounds());
        addManagedListener(window, "resize", refreshAllBounds);
        addManagedListener(window, "scroll", refreshAllBounds, { passive: true });

        engines.liquidPointer = {
            refreshBounds: refreshAllBounds,
            pause() { paused = true; },
            resume() { paused = false; },
            isPaused: () => paused,
            getTrackedButtons: () => trackedButtons
        };
    }

    /* ============================================================
       ENGINE 6 — LIQUID STATE
    ============================================================ */

    function initLiquidStateEngine() {
        if (!elements.allSwitchBtns?.length) {
            console.warn("[Hero] Liquid State Engine: no switches found.");
            return;
        }

        const CLICK_SYNC_DELAY = 350;
        let suspended = false;

        const clamp = (v) => Math.max(0, Math.min(v, 1));

        function setLiquidState(btn, progress) {
            if (suspended || !btn) return;
            btn.style.setProperty("--liq", clamp(progress));
        }

        function updateFromState(btn) {
            if (suspended || !btn) return;
            setLiquidState(btn, btn.classList.contains("active") ? 1 : 0);
        }

        function refreshAll() {
            if (suspended) return;
            elements.allSwitchBtns.forEach(updateFromState);
        }

        refreshAll();

        elements.allSwitchBtns.forEach(btn => {
            const handler = () => {
                const timer = setTimeout(() => updateFromState(btn), CLICK_SYNC_DELAY);
                listeners.push(() => clearTimeout(timer));
            };
            addManagedListener(btn, "click", handler);
        });

        /* Navigation completion re-syncs liquid fill. State-reset already
           calls updateFromState directly per button (Engine 3) so we do
           NOT also listen for hero:state:reset here — avoids a redundant
           double pass over every button on every reset. */
        addManagedListener(document, "hero:navigation:completed", refreshAll);

        engines.liquidState = {
            setState: setLiquidState,
            updateFromState,
            refreshAll,
            suspend() { suspended = true; },
            resume() { suspended = false; refreshAll(); }
        };
    }

    /* ============================================================
       ENGINE 7 — THEME
       Owns Hero design tokens only. Does NOT touch body classList —
       that is the Website Runtime Theme Engine's responsibility
       (see Level 2). Hero only emits hero:theme:changed so Runtime
       can react.
    ============================================================ */

    function initThemeEngine() {
        const REQUIRED_TOKENS = [
            "--hero-bg", "--hero-text", "--hero-quote-color", "--hero-accent",
            "--hero-accent-glow", "--hero-switch-base", "--hero-switch-knob",
            "--hero-dot-color", "--hero-name-weight"
        ];

        const themeRegistry = new Map();

        function validateTheme(config) {
            for (const token of REQUIRED_TOKENS) {
                if (!(token in config)) {
                    console.error(`[Hero Theme] Missing required token: ${token}`);
                    return false;
                }
            }
            return true;
        }

        function registerTheme(name, config) {
            if (!validateTheme(config)) return false;
            themeRegistry.set(name, Object.freeze({ ...config }));
            return true;
        }

        registerTheme("charcoal-crimson", {
            "--hero-bg": "#1a1c20", "--hero-text": "#ffffff",
            "--hero-quote-color": "rgba(255,255,255,0.8)", "--hero-accent": "#dc1a2a",
            "--hero-accent-glow": "rgba(220,26,42,0.4)",
            "--hero-switch-base": "linear-gradient(145deg,#2d2d2d,#121212)",
            "--hero-switch-knob": "linear-gradient(145deg,#4d4d4d,#141414)",
            "--hero-dot-color": "#00ff88", "--hero-name-weight": "600"
        });

        registerTheme("emerald-aurora", {
            "--hero-bg": "#0a1a14", "--hero-text": "#e0f5ec",
            "--hero-quote-color": "rgba(200,240,220,.85)", "--hero-accent": "#00cc77",
            "--hero-accent-glow": "rgba(0,204,119,.5)",
            "--hero-switch-base": "linear-gradient(145deg,#1a3a2a,#0a1a14)",
            "--hero-switch-knob": "linear-gradient(145deg,#2d5a3d,#0a1a14)",
            "--hero-dot-color": "#00ffaa", "--hero-name-weight": "600"
        });

        registerTheme("midnight-gold", {
            "--hero-bg": "#0a0e1a", "--hero-text": "#f5e6c8",
            "--hero-quote-color": "rgba(240,220,180,.85)", "--hero-accent": "#d4a017",
            "--hero-accent-glow": "rgba(212,160,23,.5)",
            "--hero-switch-base": "linear-gradient(145deg,#1a1f2e,#0a0e1a)",
            "--hero-switch-knob": "linear-gradient(145deg,#3a3f4e,#1a1a24)",
            "--hero-dot-color": "#ffcc00", "--hero-name-weight": "700"
        });

        function applyTheme(themeName) {
            let theme = themeRegistry.get(themeName);
            if (!theme) {
                console.warn(`[Hero Theme] "${themeName}" not found. Using fallback.`);
                theme = themeRegistry.get("charcoal-crimson");
                themeName = "charcoal-crimson";
            }

            const root = elements.heroSection || document.documentElement;
            Object.entries(theme).forEach(([property, value]) => {
                if (root.style.getPropertyValue(property) !== value) {
                    root.style.setProperty(property, value);
                }
            });

            state.theme = themeName;
            dispatchHeroEvent("hero:theme:changed", { theme: themeName });
        }

        applyTheme(state.theme || "charcoal-crimson");

        /* Runtime owns body.liquid-mode/neon-mode/normal-mode (Level 2
           Fix 1). Hero only reacts to keep its own tokens in sync —
           it never touches document.body itself. */
        addManagedListener(document, "runtime:theme:changed", (e) => {
            if (e.detail?.theme) applyTheme(e.detail.theme);
        });

        engines.theme = {
            apply: applyTheme,
            register: registerTheme,
            hasTheme: (name) => themeRegistry.has(name),
            getCurrent: () => state.theme,
            getAvailable: () => Array.from(themeRegistry.keys())
        };
    }

    /* ============================================================
       ENGINE 8 — PORTRAIT
    ============================================================ */

    function initPortraitEngine() {
        const portraitImg = elements.heroPortraitImg;

        if (!portraitImg) {
            console.warn("[Hero] Portrait Engine: portrait element not found.");
            engines.portrait = {
                load: () => Promise.reject(new Error("Portrait element missing.")),
                preload: () => Promise.resolve(),
                getCurrent: () => null,
                isLoading: () => false,
                pause() {}, resume() {}
            };
            return;
        }

        let currentSource = null;
        let loading = false;
        let paused = false;
        let pendingLoad = null;

        const portraitSources = {
            default: "./assets/images/portrait-placeholder.png",
            desktop: "./assets/images/portrait-desktop.png",
            tablet:  "./assets/images/portrait-tablet.png",
            mobile:  "./assets/images/portrait-mobile.png"
        };

        const portraitCache = new Map();

        function resolveResponsiveSource() {
            const width = window.innerWidth;
            if (width >= 1200) return portraitSources.desktop || portraitSources.default;
            if (width >= 768)  return portraitSources.tablet  || portraitSources.default;
            return portraitSources.mobile || portraitSources.default;
        }

        function preloadPortrait(src) {
            return new Promise((resolve, reject) => {
                if (!src) { resolve(); return; }
                if (portraitCache.has(src)) { resolve(portraitCache.get(src)); return; }
                const image = new Image();
                image.onload = () => { portraitCache.set(src, image); resolve(image); };
                image.onerror = reject;
                image.src = src;
            });
        }

        function loadPortrait(src = null) {
            if (paused) return Promise.resolve(currentSource);
            if (!src) src = resolveResponsiveSource();

            if (loading && pendingLoad === src) return Promise.resolve(currentSource);
            if (currentSource === src && state.portraitLoaded) return Promise.resolve(src);

            loading = true;
            pendingLoad = src;
            dispatchHeroEvent("hero:portrait:loading", { source: src });

            return preloadPortrait(src).then(() => {
                portraitImg.src = src;
                currentSource = src;
                state.portraitLoaded = true;
                loading = false;
                pendingLoad = null;
                dispatchHeroEvent("hero:portrait:loaded", { source: src });
                return src;
            }).catch(() => {
                loading = false;
                pendingLoad = null;
                dispatchHeroEvent("hero:portrait:error", { source: src });
                if (src !== portraitSources.default) {
                    console.warn(`[Hero] Portrait failed to load "${src}". Falling back.`);
                    return loadPortrait(portraitSources.default);
                }
                console.error("[Hero] Default portrait failed to load.");
                throw new Error("Portrait could not be loaded.");
            });
        }

        function requestPortraitChange(src, { animate = true, force = false } = {}) {
            if (!force && currentSource === src) return Promise.resolve(src);
            dispatchHeroEvent("hero:portrait:change-request", { source: src, animate });
            return loadPortrait(src);
        }

        let resizeTimer = null;
        function handleResponsiveUpdate() {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                const next = resolveResponsiveSource();
                if (next !== currentSource) requestPortraitChange(next, { animate: false });
            }, 250);
        }

        addManagedListener(window, "resize", handleResponsiveUpdate);
        listeners.push(() => clearTimeout(resizeTimer));
        listeners.push(() => portraitCache.clear());

              /* Environment Update Listener - Runtime → Portrait Lighting */
        addManagedListener(document, "hero:environment:update", (e) => {
            updateLighting(e.detail || {});
        });

        function updateLighting(environment = {}) {
            portraitImg.style.setProperty("--portrait-light-x", environment.x ?? 0.5);
            portraitImg.style.setProperty("--portrait-light-y", environment.y ?? 0.5);
            portraitImg.style.setProperty("--portrait-light-intensity", environment.intensity ?? 1);
        }

        /* Wired directly to the environment pipeline — closes the gap
           flagged in Engine 11: Runtime -> Bridge -> here. */
        addManagedListener(document, "hero:environment:update", (e) => {
            updateLighting(e.detail || {});
        });

        engines.portrait = {
            load: loadPortrait,
            preload: preloadPortrait,
            requestChange: requestPortraitChange,
            refreshResponsive: handleResponsiveUpdate,
            updateLighting,
            isLoading: () => loading,
            getCurrent: () => currentSource,
            getSources: () => ({ ...portraitSources }),
            pause() { paused = true; },
            resume() { paused = false; }
        };

        loadPortrait().catch(err => console.error("[Hero] Portrait Engine:", err));
    }

    /* ============================================================
       ENGINE 9 — QUOTE
       Quotation marks restored (hero.css has no ::before/::after on
       .hero-quote, so the text itself must carry them to match the
       static default markup). Cache dropped — quoteRegistry already
       serves that purpose; a second Map added nothing.
       Pause control: rotation pauses on hover/focus of the quote and
       whenever the tab is hidden, satisfying WCAG 2.2.2 without
       requiring new markup. A public toggle is also exposed.
    ============================================================ */

    function initQuoteEngine() {
        const quoteElement = elements.heroQuote;

        if (!quoteElement) {
            console.warn("[Hero] Quote Engine: quote element missing.");
            engines.quote = {
                next() {}, previous() {}, getCurrent: () => null,
                pause() {}, resume() {}
            };
            return;
        }

        const ROTATION_DELAY = 8000;
        let rotationTimer = null;
        let userPaused = false;
        let hoverPaused = false;
        let currentIndex = 0;
        let currentLocale = "en";

        const quoteRegistry = {
            en: [
                "\u201CDesign is intelligence made visible.\u201D",
                "\u201CCode is poetry written in logic.\u201D",
                "\u201CEvery pixel tells a story.\u201D",
                "\u201CSimplicity is the ultimate sophistication.\u201D",
                "\u201CBuild with purpose. Design with intent.\u201D"
            ]
        };

        const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

        function getLocaleQuotes(locale = currentLocale) {
            return quoteRegistry[locale] || quoteRegistry.en;
        }

        function registerLocale(locale, quotes) {
            if (Array.isArray(quotes) && quotes.length) quoteRegistry[locale] = [...quotes];
        }

        function resolveQuote(index, locale = currentLocale) {
            const collection = getLocaleQuotes(locale);
            if (!collection.length) return "";
            index = Math.max(0, Math.min(index, collection.length - 1));
            return collection[index];
        }

        function renderQuote(quote, { animate = true } = {}) {
            quoteElement.textContent = quote;
            quoteElement.setAttribute("data-quote-index", currentIndex);
            dispatchHeroEvent("hero:quote:render", { quote, index: currentIndex, animate });
        }

        function requestQuote(index, { animate = true } = {}) {
            const quote = resolveQuote(index, currentLocale);
            currentIndex = index;
            state.quoteIndex = index;
            renderQuote(quote, { animate });
        }

        function nextQuote() {
            const collection = getLocaleQuotes();
            requestQuote((currentIndex + 1) % collection.length);
        }

        function previousQuote() {
            const collection = getLocaleQuotes();
            requestQuote((currentIndex - 1 + collection.length) % collection.length);
        }

        function isEffectivelyPaused() {
            return userPaused || hoverPaused || document.hidden || reducedMotion;
        }

        function startRotation() {
            stopRotation();
            if (isEffectivelyPaused()) return;
            rotationTimer = setInterval(() => {
                if (!isEffectivelyPaused()) nextQuote();
            }, ROTATION_DELAY);
        }

        function stopRotation() {
            if (rotationTimer) { clearInterval(rotationTimer); rotationTimer = null; }
        }

        function loadQuotes(quotes, locale = currentLocale) {
            if (!Array.isArray(quotes)) return;
            quoteRegistry[locale] = [...quotes];
            dispatchHeroEvent("hero:quotes:loaded", { locale, count: quotes.length });
        }

        function pauseRotation() { userPaused = true; stopRotation(); dispatchHeroEvent("hero:quote:suspended", {}); }
        function resumeRotation() { userPaused = false; if (!rotationTimer) startRotation(); dispatchHeroEvent("hero:quote:resumed", {}); }
        function togglePause() { userPaused ? resumeRotation() : pauseRotation(); }

        /* Accessible pause affordances using existing markup only */
        addManagedListener(quoteElement, "pointerenter", () => { hoverPaused = true; stopRotation(); });
        addManagedListener(quoteElement, "pointerleave", () => { hoverPaused = false; if (!userPaused) startRotation(); });
        addManagedListener(quoteElement, "focusin", () => { hoverPaused = true; stopRotation(); });
        addManagedListener(quoteElement, "focusout", () => { hoverPaused = false; if (!userPaused) startRotation(); });
        addManagedListener(document, "visibilitychange", () => {
            if (document.hidden) stopRotation();
            else if (!isEffectivelyPaused()) startRotation();
        });

        quoteElement.setAttribute("tabindex", "0");
        quoteElement.setAttribute("role", "status");
        quoteElement.setAttribute("aria-live", "polite");
        quoteElement.setAttribute("aria-label", "Rotating quote. Hover or focus to pause.");

        const runtimeQuoteSetHandler = (event) => {
            const index = event.detail?.index;
            if (typeof index === "number") requestQuote(index);
        };
        addManagedListener(document, "runtime:quote:set", runtimeQuoteSetHandler);

        const runtimeLocaleHandler = (event) => {
            const locale = event.detail?.locale;
            if (quoteRegistry[locale]) {
                currentLocale = locale;
                requestQuote(0, { animate: false });
            }
        };
        addManagedListener(document, "runtime:locale:changed", runtimeLocaleHandler);

        listeners.push(() => stopRotation());

        engines.quote = {
            request: requestQuote,
            next: nextQuote,
            previous: previousQuote,
            registerLocale,
            loadQuotes,
            getCurrentQuote: () => resolveQuote(currentIndex, currentLocale),
            getQuoteIndex: () => currentIndex,
            isRotating: () => rotationTimer !== null,
            isPaused: () => userPaused,
            pause: pauseRotation,
            resume: resumeRotation,
            togglePause
        };

        requestQuote(0, { animate: false });
        startRotation();
    }

    /* ============================================================
       ENGINE 10 — ANIMATION
       Consumes hero:portrait:change-request and hero:quote:render
       so portrait swaps and quote rotation actually crossfade
       instead of hard-swapping.
    ============================================================ */

    function initAnimationEngine() {
        if (!elements.heroSection) {
            console.warn("[Hero] Animation Engine: hero section not found.");
            engines.animation = { enter() {}, exit() {} };
            return;
        }

        let currentPhase = "idle";
        let suspended = false;
        let activeAnimations = [];
        const animationRegistry = new Map([
            ["hero-name", elements.heroName],
            ["hero-quote", elements.heroQuote],
            ["hero-portrait", elements.heroPortrait],
            ["hero-navigation", elements.heroNav]
        ]);

        const AnimationConfig = {
            duration: 600,
            easing: "cubic-bezier(.22,.61,.36,1)",
            fadeDuration: 380,
            portraitOffset: 20,
            navigationOffset: -10
        };

        const Timeline = {
            INTRO: ["hero-name", "hero-quote", "hero-portrait", "hero-navigation"],
            EXIT:  ["hero-navigation", "hero-portrait", "hero-quote", "hero-name"]
        };

        let reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
        const motionHandler = (e) => { reducedMotion = e.matches; };
        addManagedListener(motionQuery, "change", motionHandler);

              /* Environment Update Listener - Runtime → Animation Effects */
        addManagedListener(document, "hero:environment:update", (e) => {
            // Future: Use environment data for dynamic animation adjustments
            console.info("[Animation] Environment update received", e.detail);
        });

        function resolveTarget(name) { return animationRegistry.get(name) || null; }

        function runOrFallback(element, keyframes, duration, fallbackOpacity) {
            return new Promise(resolve => {
                if (!element) { resolve(); return; }
                if (reducedMotion || !element.animate) {
                    element.style.opacity = String(fallbackOpacity);
                    resolve();
                    return;
                }
                const animation = element.animate(keyframes, {
                    duration, easing: AnimationConfig.easing, fill: "forwards"
                });
                activeAnimations.push(animation);
                animation.onfinish = () => resolve();
            });
        }

        function animateElement(element, key, direction) {
            if (!element) return Promise.resolve();
            if (reducedMotion) {
                element.style.opacity = direction === "enter" ? "1" : "0";
                return Promise.resolve();
            }
            let keyframes;
            if (direction === "enter") {
                keyframes = [
                    { opacity: 0, transform:
                        key === "hero-name" ? "translate(-50%,-50%) scale(.92)" :
                        key === "hero-portrait" ? `translateX(-50%) translateY(${AnimationConfig.portraitOffset}px)` :
                        key === "hero-navigation" ? `translateY(${AnimationConfig.navigationOffset}px)` :
                        "translateY(8px)" },
                    { opacity: 1, transform:
                        key === "hero-name" ? "translate(-50%,-50%) scale(1)" :
                        key === "hero-portrait" ? "translateX(-50%) translateY(0)" :
                        "translateY(0)" }
                ];
            } else {
                keyframes = [
                    { opacity: 1, transform: "translateY(0)" },
                    { opacity: 0, transform: key === "hero-name" ? "translate(-50%,-50%) scale(.95)" : "translateY(12px)" }
                ];
            }
            return runOrFallback(element, keyframes, AnimationConfig.duration, direction === "enter" ? 1 : 0);
        }

        async function heroEnter() {
            if (suspended || currentPhase === "entering" || currentPhase === "active") return;
            currentPhase = "entering";
            state.animationPhase = currentPhase;
            dispatchHeroEvent("hero:animation:entering", {});
            for (const key of Timeline.INTRO) {
                await animateElement(resolveTarget(key), key, "enter");
            }
            currentPhase = "active";
            state.animationPhase = currentPhase;
            dispatchHeroEvent("hero:animation:entered", {});
        }

        async function heroExit(callback) {
            if (currentPhase === "exiting") return;
            currentPhase = "exiting";
            state.animationPhase = currentPhase;
            dispatchHeroEvent("hero:animation:exiting", {});
            for (const key of Timeline.EXIT) {
                await animateElement(resolveTarget(key), key, "exit");
            }
            currentPhase = "exited";
            state.animationPhase = currentPhase;
            dispatchHeroEvent("hero:animation:exited", {});
            if (typeof callback === "function") callback();
        }

        /* --- Content crossfade for quote/portrait mid-session swaps --- */

        function crossfadeSwap(element, applyChange, duration) {
            if (!element) { applyChange(); return; }
            if (reducedMotion || !element.animate) { applyChange(); return; }
            const outAnim = element.animate(
                [{ opacity: 1 }, { opacity: 0 }],
                { duration: duration / 2, easing: "ease", fill: "forwards" }
            );
            activeAnimations.push(outAnim);
            outAnim.onfinish = () => {
                applyChange();
                const inAnim = element.animate(
                    [{ opacity: 0 }, { opacity: 1 }],
                    { duration: duration / 2, easing: "ease", fill: "forwards" }
                );
                activeAnimations.push(inAnim);
            };
        }

        addManagedListener(document, "hero:quote:render", (e) => {
            const { quote, animate } = e.detail || {};
            if (!elements.heroQuote) return;
            if (animate === false) { elements.heroQuote.textContent = quote; return; }
            crossfadeSwap(elements.heroQuote, () => { elements.heroQuote.textContent = quote; }, AnimationConfig.fadeDuration);
        });

        addManagedListener(document, "hero:portrait:change-request", (e) => {
            const { animate } = e.detail || {};
            if (!elements.heroPortraitImg || animate === false) return;
            /* The Portrait Engine itself swaps `src`; here we only own the
               visual fade envelope so the swap doesn't hard-pop. */
            elements.heroPortraitImg.animate(
                [{ opacity: 1 }, { opacity: 0.15 }, { opacity: 1 }],
                { duration: AnimationConfig.fadeDuration, easing: "ease" }
            );
        });

        function pauseAnimations() {
            suspended = true;
            activeAnimations.forEach(a => { try { a.pause(); } catch (_) {} });
        }
        function resumeAnimations() {
            suspended = false;
            activeAnimations.forEach(a => { try { a.play(); } catch (_) {} });
        }
        function cancelAnimations() {
            activeAnimations.forEach(a => { try { a.cancel(); } catch (_) {} });
            activeAnimations = [];
        }
        listeners.push(cancelAnimations);

        engines.animation = {
            enter: heroEnter,
            exit: heroExit,
            pause: pauseAnimations,
            resume: resumeAnimations,
            cancel: cancelAnimations,
            getPhase: () => currentPhase,
            isAnimating: () => currentPhase === "entering" || currentPhase === "exiting",
            diagnostics: () => ({
                phase: currentPhase,
                suspended,
                reducedMotion,
                activeAnimations: activeAnimations.length,
                registeredTargets: Array.from(animationRegistry.keys())
            })
        };

        heroEnter();
    }

    /* ============================================================
       ENGINE 11 — RUNTIME BRIDGE
       Detects window.Runtime directly (matching the real repo's
       runtime.js global — NOT window.IDPORT.Runtime). Defends
       against Runtime not yet exposing a .receive() method, since
       the current runtime.js stub doesn't have one.
    ============================================================ */

    function initRuntimeBridge() {

        const BridgeConfig = {
            runtimeGlobal: "Runtime",
            maxReconnectAttempts: 10,
            reconnectDelay: 1500,
            heartbeatInterval: 10000,
            queueLimit: 250,
            protocolVersion: "1.0"
        };

        const ConnectionState = Object.freeze({
            DISCONNECTED: "disconnected",
            CONNECTED: "connected",
            RECONNECTING: "reconnecting",
            FAILED: "failed"
        });

        let connectionState = ConnectionState.DISCONNECTED;
        let runtime = null;
        let reconnectAttempts = 0;
        let heartbeatTimer = null;
        const pendingQueue = [];
        let messageCounter = 0;

        function createMessage(type, data = {}) {
            return {
                id: ++messageCounter, type, data, source: "hero",
                timestamp: Date.now(), protocolVersion: BridgeConfig.protocolVersion
            };
        }

        function canReceive() {
            return !!(runtime && typeof runtime.receive === "function");
        }

        function detectRuntime() {
            const candidate = window[BridgeConfig.runtimeGlobal];
            if (!candidate) {
                connectionState = ConnectionState.DISCONNECTED;
                return false;
            }
            runtime = candidate;
            connectionState = ConnectionState.CONNECTED;
            state.bridgeReady = true;
            dispatchHeroEvent("hero:bridge:connected", { version: runtime.version || "unknown" });
            if (!canReceive()) {
                console.info("[Hero] Runtime detected but has no receive() yet — messages will queue.");
            }
            return true;
        }

        function enqueueMessage(packet) {
            if (pendingQueue.length >= BridgeConfig.queueLimit) pendingQueue.shift();
            pendingQueue.push(packet);
        }

        function flushQueue() {
            if (!canReceive()) return;
            while (pendingQueue.length > 0) {
                const packet = pendingQueue.shift();
                try { runtime.receive(packet.type, packet); }
                catch (err) {
                    console.warn("[Hero] Queue flush failed.", err);
                    pendingQueue.unshift(packet);
                    break;
                }
            }
        }

        function startHeartbeat() {
            stopHeartbeat();
            heartbeatTimer = setInterval(() => {
                sendToRuntime("hero:heartbeat", { heartbeat: Date.now() });
            }, BridgeConfig.heartbeatInterval);
        }
        function stopHeartbeat() {
            if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
        }

        function connectRuntime() {
            const wasConnected = connectionState === ConnectionState.CONNECTED;
            const connected = detectRuntime();

            if (connected) {
                reconnectAttempts = 0;
                /* Run flush/heartbeat regardless of whether we were already
                   connected — fixes the hot-path bug where both were only
                   started on a fresh transition into CONNECTED. */
                flushQueue();
                if (!heartbeatTimer) startHeartbeat();
                return true;
            }

            if (!wasConnected) {
                connectionState = ConnectionState.RECONNECTING;
                reconnectAttempts++;
                if (reconnectAttempts <= BridgeConfig.maxReconnectAttempts) {
                    const t = setTimeout(connectRuntime, BridgeConfig.reconnectDelay);
                    listeners.push(() => clearTimeout(t));
                } else {
                    connectionState = ConnectionState.FAILED;
                    console.warn("[Hero] Runtime Bridge: connection failed after max attempts.");
                }
            }
            return false;
        }

        function sendToRuntime(type, data = {}) {
            const packet = createMessage(type, data);
            if (!canReceive()) { enqueueMessage(packet); return false; }
            try { runtime.receive(packet.type, packet); return true; }
            catch (err) {
                console.warn("[Hero] Runtime send failed.", err);
                enqueueMessage(packet);
                return false;
            }
        }

        function receiveFromRuntime(type, payload = {}) {
            switch (type) {
                case "theme:change":
                    engines.theme?.apply(payload.theme);
                    break;
                case "hero:reset":
                    engines.stateReset?.reset();
                    break;
                case "hero:enter":
                    engines.animation?.enter();
                    break;
                case "hero:exit":
                    engines.animation?.exit(payload.callback);
                    break;
                case "quotes:load":
                    engines.quote?.loadQuotes(payload.quotes);
                    break;
                case "portrait:set":
                    engines.portrait?.requestChange(payload.src, { animate: payload.animate !== false });
                    break;
                case "environment:update":
                    dispatchHeroEvent("hero:environment:update", payload);
                    break;
                default:
                    console.info(`[Hero] Runtime Bridge: unhandled message "${type}".`);
            }
        }

        const ForwardEvents = [
            "hero:initialized", "hero:navigation:started", "hero:navigation:completed",
            "hero:theme:changed", "hero:menu:opened", "hero:menu:closed", "hero:state:reset",
            "hero:quote:render", "hero:portrait:loaded", "hero:animation:entered", "hero:animation:exited"
        ];
        ForwardEvents.forEach(eventName => {
            addManagedListener(document, eventName, (event) => {
                sendToRuntime(eventName, event.detail || {});
            });
        });

        window.__heroReceive = receiveFromRuntime;
        listeners.push(() => { if (window.__heroReceive === receiveFromRuntime) delete window.__heroReceive; });

        detectRuntime();
        if (document.readyState === "loading") {
            addManagedListener(document, "DOMContentLoaded", connectRuntime);
        }
        addManagedListener(window, "load", connectRuntime);
        listeners.push(stopHeartbeat);

        connectRuntime();

        engines.runtimeBridge = {
            send: sendToRuntime,
            receive: receiveFromRuntime,
            connect: connectRuntime,
            notifyNavigate: (target) => sendToRuntime("hero:navigation:request", { target }),
            isConnected: () => connectionState === ConnectionState.CONNECTED,
            getState: () => connectionState,
            flush: flushQueue,
            diagnostics: () => ({
                state: connectionState,
                connected: connectionState === ConnectionState.CONNECTED,
                canReceive: canReceive(),
                queuedMessages: pendingQueue.length,
                reconnectAttempts
            })
        };
    }

    /* ============================================================
       ENGINE ORCHESTRATION
    ============================================================ */

    const ENGINE_INIT_ORDER = [
        initNavigationEngine,
        initStateResetEngine,
        initMenuEngine,
        initLiquidPointerEngine,
        initLiquidStateEngine,
        initThemeEngine,
        initPortraitEngine,
        initQuoteEngine,
        initAnimationEngine,
        initRuntimeBridge
    ];

    function init() {
        if (currentStatus !== STATUS.UNINITIALIZED) {
            console.warn("[Hero] Already initialized. Call Hero.destroy() first to reinitialize.");
            return;
        }

        currentStatus = STATUS.INITIALIZING;
        cacheDOM();

        const validation = validateHeroDOM();
        if (!validation.valid) {
            console.error("[Hero] Missing critical elements:", validation.missing);
            currentStatus = STATUS.UNINITIALIZED;
            return;
        }

        initialiseState();

        ENGINE_INIT_ORDER.forEach(fn => {
            try { fn(); }
            catch (err) { console.error(`[Hero] Engine init failed (${fn.name}):`, err); }
        });

        exposeExports();

        currentStatus = STATUS.ACTIVE;
        dispatchHeroEvent("hero:initialized", { timestamp: Date.now() });
        console.log("[Hero] Initialized successfully.");
    }

    function suspend() {
        if (currentStatus !== STATUS.ACTIVE) return;
        currentStatus = STATUS.SUSPENDED;
        engines.liquidPointer?.pause();
        engines.liquidState?.suspend();
        engines.portrait?.pause();
        engines.quote?.pause();
        engines.animation?.pause();
    }

    function resume() {
        if (currentStatus !== STATUS.SUSPENDED) return;
        currentStatus = STATUS.ACTIVE;
        engines.liquidPointer?.resume();
        engines.liquidState?.resume();
        engines.portrait?.resume();
        engines.quote?.resume();
        engines.animation?.resume();
    }

    function destroy() {
        if (currentStatus === STATUS.UNINITIALIZED || currentStatus === STATUS.DESTROYED) return;

        dispatchHeroEvent("hero:destroying", { timestamp: Date.now() });

        while (listeners.length) {
            const cleanup = listeners.pop();
            try { cleanup(); } catch (err) { console.error("[Hero] Cleanup failed:", err); }
        }

        clearOwnKeys(engines);
        clearOwnKeys(elements);
        clearOwnKeys(state);

        delete window.Hero;
        delete window.__heroReceive;

        currentStatus = STATUS.DESTROYED;
        dispatchHeroEvent("hero:destroyed", { timestamp: Date.now() });
        console.log("[Hero] Destroyed.");
    }

    function refresh() {
        destroy();
        currentStatus = STATUS.UNINITIALIZED;
        init();
    }

    /* ============================================================
       ENGINE 12 — EXPORTS
       Returns a frozen, curated public surface. Hero.engine(name)
       returns a shallow frozen clone — callers can invoke exposed
       methods but cannot mutate or replace the live internal
       engine object.
    ============================================================ */

    function exposeExports() {
        const ModuleInfo = Object.freeze({
            name: "IDPORT Hero Module",
            version: "1.1.0",
            protocol: "Hero Runtime Protocol v1"
        });

        const subscriptions = new Map();

        function on(eventName, callback) {
            if (typeof callback !== "function") return;
            document.addEventListener(eventName, callback);
            if (!subscriptions.has(eventName)) subscriptions.set(eventName, new Set());
            subscriptions.get(eventName).add(callback);
        }
        function off(eventName, callback) {
            document.removeEventListener(eventName, callback);
            subscriptions.get(eventName)?.delete(callback);
        }
        function once(eventName, callback) {
            function wrapper(event) { callback(event); off(eventName, wrapper); }
            on(eventName, wrapper);
        }
        listeners.push(() => {
            subscriptions.forEach((callbacks, eventName) => {
                callbacks.forEach(cb => document.removeEventListener(eventName, cb));
            });
            subscriptions.clear();
        });

        function getEngine(name) {
            const engine = engines[name];
            return engine ? Object.freeze({ ...engine }) : null;
        }

        function ready() {
            return new Promise(resolve => {
                if (currentStatus === STATUS.ACTIVE) { resolve(publicAPI); return; }
                once("hero:initialized", () => resolve(publicAPI));
            });
        }

        const publicAPI = Object.freeze({
            info: () => ({ ...ModuleInfo }),
            version: () => ModuleInfo.version,
            isInitialized: () => currentStatus === STATUS.ACTIVE,
            getStatus: () => currentStatus,
            getState: () => ({ ...state }),
            on, off, once, ready,
            engine: getEngine,
            engines: () => Object.keys(engines),

            init: () => { if (currentStatus === STATUS.UNINITIALIZED) init(); },
            destroy: () => destroy(),
            refresh: () => refresh(),
            suspend: () => suspend(),
            resume: () => resume(),
            reset: () => engines.stateReset?.reset(),
            navigate: (target) => engines.navigation?.navigateTo(target),
            theme: (name) => { if (name) engines.theme?.apply(name); return engines.theme?.getCurrent(); },

            menu: {
                open: () => engines.menu?.open(),
                close: () => engines.menu?.close(),
                toggle: () => engines.menu?.toggle(),
                isOpen: () => engines.menu?.isOpen() ?? false
            },
            portrait: {
                requestChange: (src, opts) => engines.portrait?.requestChange(src, opts),
                get: () => engines.portrait?.getCurrent() ?? null
            },
            quotes: {
                next: () => engines.quote?.next(),
                previous: () => engines.quote?.previous(),
                pause: () => engines.quote?.pause(),
                resume: () => engines.quote?.resume(),
                togglePause: () => engines.quote?.togglePause(),
                loadQuotes: (arr) => engines.quote?.loadQuotes(arr),
                getCurrent: () => engines.quote?.getCurrentQuote() ?? null
            },
            bridge: {
                send: (type, data) => engines.runtimeBridge?.send(type, data),
                receive: (type, data) => engines.runtimeBridge?.receive(type, data),
                isConnected: () => engines.runtimeBridge?.isConnected() ?? false
            },
            diagnostics: () => ({
                module: ModuleInfo,
                status: currentStatus,
                heroState: { ...state },
                engines: Object.keys(engines),
                runtime: engines.runtimeBridge?.diagnostics?.() ?? null,
                animation: engines.animation?.diagnostics?.() ?? null
            })
        });

        window.Hero = publicAPI;
    }

    return {
        init, suspend, resume, destroy, refresh,
        getState: () => ({ ...state }),
        getStatus: () => currentStatus,
        ready: () => new Promise(resolve => {
            if (currentStatus === STATUS.ACTIVE) { resolve(window.Hero); return; }
            document.addEventListener("hero:initialized", () => resolve(window.Hero), { once: true });
        })
    };

})();

/* ================================================================
   AUTO-INITIALISATION
   Calls the outer `Hero` module reference directly (guaranteed to
   exist the instant this script finishes evaluating), never
   `window.Hero` — closing the boot-sequence bug where auto-init
   checked for an object that only gets created *by* init() itself.
================================================================ */
(function autoInitialiseHero() {
    function boot() {
        const heroRoot = document.getElementById("hero");
        if (!heroRoot || heroRoot.dataset.heroAutoInit === "false") {
            console.info("[Hero] Auto initialisation skipped.");
            return;
        }
        Hero.init();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot, { once: true });
    } else {
        boot();
    }
})();
