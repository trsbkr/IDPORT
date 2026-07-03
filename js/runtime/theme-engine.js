// theme-engine.js - theme management
/* export const ThemeEngine = {
  current: 'default',

  modeMap: Object.freeze({
    'charcoal-crimson': 'liquid-mode'
    /* future themes map here, e.g. 'emerald-aurora': 'neon-mode' */
/*  }),

  set(name) {
    if (this.current === name) return;

    this.current = name;
    const mode = this.modeMap[name] || 'normal-mode';

    document.body.classList.remove('liquid-mode', 'neon-mode', 'normal-mode');
    document.body.classList.add(mode);

    document.dispatchEvent(new CustomEvent('runtime:theme:changed', {
      detail: { theme: name, mode }
    }));
  }
}; */






// ============================================================
// LEVEL 5.1 — THEME ENGINE
// Runtime-consumer only. Runtime owns application mode.
// Hero Theme Engine owns Hero visual theme only.
// ============================================================

const ThemeEngine = (() => {

    let current = "charcoal-crimson";

    const registry = new Map([
        [
            "charcoal-crimson",
            {
                id: "charcoal-crimson",
                attribute: "charcoal-crimson"
            }
        ]
        // Future themes:
        // [
        //     "emerald-aurora",
        //     { id: "emerald-aurora", attribute: "emerald-aurora" }
        // ]
    ]);

    function apply(theme) {

        const config = registry.get(theme);

        if (!config) {
            console.warn(`[Theme] Unknown theme "${theme}"`);
            return false;
        }

        current = config.id;

        document.documentElement.setAttribute(
            "data-theme",
            config.attribute
        );

        dispatchHeroEvent("hero:theme:changed", {
            theme: current,
            timestamp: Date.now()
        });

        return true;
    }

    function getCurrent() {
        return current;
    }

    function register(name, config) {

        if (!name || !config) return false;

        registry.set(name, config);

        return true;
    }

    function destroy() {

        document.documentElement.removeAttribute("data-theme");

        current = null;

    }

    // ========================================================
    // Runtime Integration
    // Runtime remains the single owner of website theme.
    // Hero simply reacts.
    // ========================================================

    addManagedListener(
        document,
        "runtime:theme:changed",
        (e) => {

            const theme = e.detail?.theme;

            if (theme) {
                apply(theme);
            }

        }
    );

    return {

        apply,
        getCurrent,
        register,
        destroy

    };

})();
