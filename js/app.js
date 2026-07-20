// app.js — IDPORT Application Orchestrator (Production-Grade Bootstrap)
// Owns: boot, readiness, shutdown, diagnostics, global error handling,
// runtime health watch, dev banner, feature flags.
// Does NOT own: Hero/menu/nav/liquid logic (sections own their internals).

(function AppBootstrap() {
  "use strict";

  /* ============================================================
  CONFIG + FEATURE FLAGS
  ============================================================ */

  const FLAGS = Object.freeze({
    debug: true,                // verbose console logging
    devBanner: true,            // show a small dev banner in non-production
    runtimeHealthWatch: true,   // periodic health check
    captureGlobalErrors: true,  // window.onerror
    captureRejections: true,    // unhandledrejection
  });

  const AppConfig = Object.freeze({
    name: "IDPORT",
    layer: "AppOrchestrator",
    version: "2.1.0",
    build: "development",
    env:
      (typeof location !== "undefined" &&
        /localhost|127\.0\.0\.1|\.local\b/i.test(location.hostname))
        ? "development"
        : "production",

    // Naming keys must remain stable for analytics + SectionController registry
    sections: Object.freeze({
      hero: "hero",
      // future: about, carousel, featured, testimonials, services, footer
    }),

    // Readiness policy:
    // App is "ready" when Runtime initialized AND (if #hero exists) Hero adopted.
    readyTimeoutMs: 8000,

    // Health watch
    healthIntervalMs: 10000,
    healthUnhealthyThreshold: 2, // consecutive failures before emitting app:runtime:unhealthy
  });

  const now = () => Date.now();

  const log = {
    info: (...a) => FLAGS.debug && console.info("[app]", ...a),
    warn: (...a) => console.warn("[app]", ...a),
    error: (...a) => console.error("[app]", ...a),
  };

  /* ============================================================
  INTERNAL STATE
  ============================================================ */

  const state = {
    started: false,
    startTime: now(),

    runtimeInitCalled: false,
    runtimeInitOk: false,

    heroPresent: false,
    heroAdopted: false,

    ready: false,
    readyAt: null,

    shutdown: false,

    // health
    healthTimer: null,
    healthConsecutiveFailures: 0,

    // teardown registry (global listeners, timers, injected nodes)
    teardowns: [],
  };

  function addTeardown(fn) {
    if (typeof fn === "function") state.teardowns.push(fn);
  }

  function dispatchAppEvent(name, detail = {}) {
    document.dispatchEvent(
      new CustomEvent(name, { bubbles: true, cancelable: false, detail })
    );
  }

  function domHas(id) {
    return !!document.getElementById(id);
  }

  function withTimeout(promise, ms, label) {
    let t = null;
    const timeout = new Promise((_, reject) => {
      t = setTimeout(
        () => reject(new Error(`${label || "operation"} timed out after ${ms}ms`)),
        ms
      );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
  }

  /* ============================================================
  DIAGNOSTICS (PUBLIC)
  ============================================================ */

  function runtimeSnapshot() {
    const Runtime = window.Runtime || null;
    const SectionController = Runtime?.SectionController || null;

    return {
      present: !!Runtime,
      hasInit: typeof Runtime?.init === "function",
      hasReceive: typeof Runtime?.receive === "function", // per your contract: currently missing
      sectionController: {
        present: !!SectionController,
        hasAdopt: typeof SectionController?.adopt === "function",
        hasGet: typeof SectionController?.get === "function",
      },
    };
  }

  function heroSnapshot() {
    const Hero = window.Hero || null;
    let status = null;
    try {
      status = typeof Hero?.getStatus === "function" ? Hero.getStatus() : null;
    } catch (_) {}

    return {
      present: !!Hero,
      readyFn: typeof Hero?.ready === "function",
      getStatusFn: typeof Hero?.getStatus === "function",
      status,
      adopted: state.heroAdopted,
      mountPresent: state.heroPresent,
    };
  }

  function diagnostics() {
    return {
      app: {
        name: AppConfig.name,
        version: AppConfig.version,
        build: AppConfig.build,
        env: AppConfig.env,
        started: state.started,
        ready: state.ready,
        readyAt: state.readyAt,
        uptimeMs: now() - state.startTime,
        shutdown: state.shutdown,
        flags: { ...FLAGS },
      },
      runtime: runtimeSnapshot(),
      hero: heroSnapshot(),
    };
  }

  /* ============================================================
  APP READY (PROMISE + EVENT)
  ============================================================ */

  let readyResolve;
  let readyReject;
  const readyPromise = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  function markReady() {
    if (state.ready || state.shutdown) return;

    state.ready = true;
    state.readyAt = now();

    const payload = diagnostics();
    dispatchAppEvent("app:ready", payload);
    readyResolve(payload);

    log.info("App ready.", {
      readyAt: state.readyAt,
      uptimeMs: payload.app.uptimeMs,
      runtime: payload.runtime.present,
      heroAdopted: payload.hero.adopted,
    });
  }

  function markReadyFailed(error) {
    if (state.ready || state.shutdown) return;

    const payload = { error: String(error?.message || error), diagnostics: diagnostics() };
    dispatchAppEvent("app:ready:failed", payload);
    readyReject(error);

    log.error("App failed to become ready:", error);
  }

  /* ============================================================
  GLOBAL ERROR HANDLERS
  ============================================================ */

  function installGlobalHandlers() {
    if (FLAGS.captureGlobalErrors) {
      const onError = (eventOrMessage, source, lineno, colno, error) => {
        const message =
          typeof eventOrMessage === "string"
            ? eventOrMessage
            : eventOrMessage?.message || "Unknown error";

        dispatchAppEvent("app:fatal", {
          type: "error",
          message,
          source,
          lineno,
          colno,
          stack: error?.stack || null,
          diagnostics: diagnostics(),
        });

        // return false so browser still logs default error
        return false;
      };

      window.addEventListener("error", onError);
      addTeardown(() => window.removeEventListener("error", onError));
    }

    if (FLAGS.captureRejections) {
      const onRejection = (event) => {
        const reason = event?.reason;
        dispatchAppEvent("app:fatal", {
          type: "unhandledrejection",
          message: String(reason?.message || reason || "Unhandled rejection"),
          stack: reason?.stack || null,
          diagnostics: diagnostics(),
        });
      };

      window.addEventListener("unhandledrejection", onRejection);
      addTeardown(() => window.removeEventListener("unhandledrejection", onRejection));
    }
  }

  /* ============================================================
  DEVELOPMENT BANNER
  ============================================================ */

  function installDevBanner() {
    if (!FLAGS.devBanner) return;
    if (AppConfig.env !== "development") return;

    const banner = document.createElement("div");
    banner.setAttribute("data-idport-dev-banner", "true");
    banner.textContent = `${AppConfig.name} DEV — v${AppConfig.version} (${AppConfig.build})`;
    banner.style.cssText = [
      "position:fixed",
      "left:12px",
      "bottom:12px",
      "z-index:9999",
      "padding:8px 10px",
      "font:12px/1.2 system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      "letter-spacing:.2px",
      "color:rgba(255,255,255,.92)",
      "background:rgba(10,10,12,.65)",
      "border:1px solid rgba(220,26,42,.55)",
      "border-radius:10px",
      "backdrop-filter: blur(10px)",
      "user-select:none",
      "pointer-events:none",
    ].join(";");

    document.body.appendChild(banner);
    addTeardown(() => banner.remove());
  }

  /* ============================================================
  RUNTIME INIT + HEALTH WATCH
  ============================================================ */

  function initRuntime() {
    const Runtime = window.Runtime;

    state.runtimeInitCalled = true;

    if (!Runtime) {
      log.warn("Runtime missing on window. Ensure runtime.js is loaded before app.js.");
      state.runtimeInitOk = false;
      return null;
    }

    if (typeof Runtime.init === "function") {
      try {
        Runtime.init();
        state.runtimeInitOk = true;
        log.info("Runtime.init() called.");
      } catch (err) {
        state.runtimeInitOk = false;
        log.error("Runtime.init() threw:", err);
      }
    } else {
      state.runtimeInitOk = false;
      log.warn("Runtime exists but Runtime.init() is not a function.");
    }

    return Runtime;
  }

  function startRuntimeHealthWatch() {
    if (!FLAGS.runtimeHealthWatch) return;

    const tick = () => {
      if (state.shutdown) return;

      const snap = runtimeSnapshot();

      // Define "healthy" for now: Runtime exists, SectionController exists + adopt exists.
      // (You can tighten later once Runtime.receive exists.)
      const healthy =
        snap.present &&
        snap.sectionController.present &&
        snap.sectionController.hasAdopt;

      if (!healthy) {
        state.healthConsecutiveFailures += 1;

        if (state.healthConsecutiveFailures >= AppConfig.healthUnhealthyThreshold) {
          dispatchAppEvent("app:runtime:unhealthy", {
            failures: state.healthConsecutiveFailures,
            runtime: snap,
            diagnostics: diagnostics(),
          });
        }
      } else {
        if (state.healthConsecutiveFailures > 0) {
          dispatchAppEvent("app:runtime:healthy", {
            recoveredFromFailures: state.healthConsecutiveFailures,
            runtime: snap,
          });
        }
        state.healthConsecutiveFailures = 0;
      }
    };

    state.healthTimer = setInterval(tick, AppConfig.healthIntervalMs);
    addTeardown(() => clearInterval(state.healthTimer));
    tick();
  }

  /* ============================================================
  SECTION ADOPTION (HERO)
  ============================================================ */

// ============================================================
  // PHASE 10.G.3 — RUNTIME ADOPTION FIX
  // ============================================================
  // ORIGINAL BUG (deterministic, not a rare race):
  //   Two independent things both try to adopt Hero into
  //   SectionController:
  //     1. runtime.js's own internal `hero:initialized` listener,
  //        which calls SectionController.adopt("hero", window.Hero)
  //        SYNCHRONOUSLY, inside the same call stack as the
  //        `document.dispatchEvent("hero:initialized")` call.
  //     2. app.js's attachHero(), which reaches adoptSection() only
  //        AFTER `await window.Hero.ready()` resolves — and Promise
  //        .then()/await continuations are always deferred to the
  //        microtask queue, which only runs AFTER every synchronous
  //        listener for that same event has already finished.
  //   Because of this, path 1 ALWAYS wins and path 2 ALWAYS loses —
  //   not a coin flip, a guaranteed ordering every single time. Before
  //   this fix, SectionController.adopt() rejected the second
  //   (guaranteed-losing) attempt and returned false, which meant:
  //     - a spurious "Hero adoption failed" warning logged on every
  //       single page load, even though Hero was actually adopted
  //       and fully operational via the other path, and
  //     - app.js's own `state.heroAdopted` incorrectly ended up
  //       `false`, which could cascade into `app:ready` rejecting
  //       even though the app was genuinely ready.
  //
  // FIX:
  //   Before attempting adoption, check whether the section is
  //   ALREADY adopted (via SectionController.get(key)). If it is,
  //   that's not a failure — it's the same outcome having already
  //   arrived through the other, faster bootstrap path. Treat it as
  //   success and return true immediately, without ever calling
  //   adopt() a second time.
  //
  // REVIEWER REFINEMENT (Main Dev):
  //   Rather than silently returning true, log an informative message
  //   distinguishing "already adopted via another bootstrap path" from
  //   a genuine failure — improves future debugging without changing
  //   behavior. This does not affect correctness; it only replaces a
  //   misleading rejection warning with an accurate, low-noise info
  //   log.
  // ============================================================
  function adoptSection(runtime, key, instance) {
    const controller = runtime?.SectionController;
    const adopt = controller?.adopt;
    if (typeof adopt !== "function") return false;

    // Section may already be adopted via runtime.js's own internal
    // hero:initialized listener, which — per the timing explanation
    // above — will always have already run by the time this async
    // path reaches this point. Checking first avoids calling adopt()
    // a second time and getting a false rejection back.
    const existing = typeof controller.get === "function"
        ? controller.get(key)
        : null;

    if (existing) {
        log.info(`Section "${key}" already adopted. Skipping duplicate adoption.`);
        return true;
    }

    // Reaches here only if this path genuinely won the race (e.g. if
    // runtime.js's internal listener were ever removed, or Hero
    // becomes ready before Runtime finishes booting in some future
    // load-order change) — in which case this IS the real, first
    // adoption attempt, and should behave exactly as before.
    try {
      return !!adopt.call(controller, key, instance);
    } catch (err) {
      log.error(`SectionController.adopt("${key}") threw:`, err);
      return false;
    }
  }

  async function attachHero(runtime) {
    state.heroPresent = domHas("hero");
    if (!state.heroPresent) return;

    if (!window.Hero?.ready) {
      log.warn("Hero is expected (#hero exists) but window.Hero.ready() is unavailable.");
      return;
    }

    const heroAPI = await withTimeout(
      window.Hero.ready(),
      AppConfig.readyTimeoutMs,
      "Hero.ready()"
    );

    const ok = adoptSection(runtime, AppConfig.sections.hero, heroAPI);
    state.heroAdopted = ok;

    if (!ok) {
      log.warn("Hero adoption failed (SectionController rejected or missing).");
    } else {
      log.info('Hero adopted as section key "hero".');
    }
  }

  /* ============================================================
  BOOT / READY / SHUTDOWN
  ============================================================ */

  async function boot() {
    if (state.started || state.shutdown) return;
    state.started = true;

    // Version logging
    log.info(`${AppConfig.name} boot`, {
      version: AppConfig.version,
      build: AppConfig.build,
      env: AppConfig.env,
      flags: FLAGS,
    });

    installGlobalHandlers();

    // Runtime init
    const runtime = initRuntime();

    // Dev banner needs body
    if (document.body) installDevBanner();
    else {
      const onLoad = () => installDevBanner();
      window.addEventListener("load", onLoad, { once: true });
      addTeardown(() => window.removeEventListener("load", onLoad));
    }

    startRuntimeHealthWatch();

    // If Runtime exists, adopt Hero (if present)
    if (runtime) {
      try {
        await attachHero(runtime);
      } catch (err) {
        // Not fatal by itself; it impacts readiness policy though.
        log.error("attachHero failed:", err);
      }
    }

    // Readiness policy:
    // - Runtime must be present & init ok
    // - If hero mount exists, hero must be adopted
    const runtimeOk = !!runtime && state.runtimeInitOk;
    const heroOk = !state.heroPresent || state.heroAdopted;

    if (runtimeOk && heroOk) markReady();
    else markReadyFailed(new Error("Readiness policy not satisfied."));
  }

  function shutdown(reason = "shutdown") {
    if (state.shutdown) return;
    state.shutdown = true;

    dispatchAppEvent("app:shutdown", { reason, diagnostics: diagnostics() });

    while (state.teardowns.length) {
      const fn = state.teardowns.pop();
      try {
        fn();
      } catch (err) {
        log.error("Teardown failed:", err);
      }
    }

    log.info("App shutdown complete.", { reason });
  }

  /* ============================================================
  PUBLIC SURFACE (OPTIONAL)
  ============================================================ */

  // Expose minimal app API for debugging and future integrations.
  // This is NOT a replacement for your contract doc; it's an app-level helper.
  window.App = Object.freeze({
    info: () => ({
      name: AppConfig.name,
      layer: AppConfig.layer,
      version: AppConfig.version,
      build: AppConfig.build,
      env: AppConfig.env,
    }),
    flags: () => ({ ...FLAGS }),
    ready: () => readyPromise,
    diagnostics,
    shutdown,
  });

  /* ============================================================
  BOOTSTRAP TIMING
  ============================================================ */

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }

  // Optional: allow manual shutdown on page hide (disabled by default)
  // const onPageHide = () => shutdown("pagehide");
  // window.addEventListener("pagehide", onPageHide);
  // addTeardown(() => window.removeEventListener("pagehide", onPageHide));
})();
