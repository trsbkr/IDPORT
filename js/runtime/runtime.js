// ================================================================
// RUNTIME.JS — Website Operating System (Fully Equipped)
// ================================================================

window.Runtime = {
    version: {},
    state: {},
    engines: {},
    components: {},

    // ---------- Application Boot ----------
    init() {
        console.log("%c[Runtime] Initializing IDPORT Operating System...", "color:#dc1a2a; font-weight:bold");

        // Load Order Safety Check
        if (!window.SectionController) {
            console.error("[Runtime] CRITICAL: SectionController not found. Check script load order in index.html");
        }

        // Adopt Hero after it signals ready
        document.addEventListener("hero:initialized", () => {
            if (window.SectionController) {
                window.SectionController.adopt("hero", window.Hero);
            }
        }, { once: true });

        this.config = this.loadConfig();

        this.state = {
            currentSection: "hero",
            previousSection: null,
            isSuspended: false,
            isDestroyed: false,
            bootTime: Date.now(),
            ...this.state
        };

        this.startHealthMonitoring();
        this.setupGlobalErrorHandler();

        this.emit('runtime:booted', { timestamp: this.state.bootTime });
        console.log('[Runtime] Fully initialized.');
    },

    // ---------- Global Lifecycle ----------
    suspend() {
        if (this.state.isSuspended) return;
        this.state.isSuspended = true;

        const hero = this.SectionController?.get('hero');
        if (hero && typeof hero.suspend === 'function') {
            hero.suspend();
        }

        this.emit('runtime:suspended', { timestamp: Date.now() });
        console.log('[Runtime] Suspended.');
    },

    resume() {
        if (!this.state.isSuspended) return;
        this.state.isSuspended = false;

        const hero = this.SectionController?.get('hero');
        if (hero && typeof hero.resume === 'function') {
            hero.resume();
        }

        this.emit('runtime:resumed', { timestamp: Date.now() });
        console.log('[Runtime] Resumed.');
    },

    destroy() {
        if (this.state.isDestroyed) return;
        this.state.isDestroyed = true;

        const hero = this.SectionController?.get('hero');
        if (hero && typeof hero.destroy === 'function') {
            try {
                hero.destroy();
            } catch (e) {
                this.reportError(e, { section: 'hero', action: 'destroy' });
            }
        }

        clearInterval(this._healthInterval);
        this.emit('runtime:destroyed', { timestamp: Date.now() });
        console.log('[Runtime] Destroyed.');
    },

    // ---------- Configuration ----------
    config: {
        appName: 'IDPORT',
        version: '1.0.0',
        environment: 'development',
        debug: true,
        healthCheckInterval: 30000
    },

    loadConfig() {
        const meta = document.querySelector('meta[name="runtime-config"]');
        if (meta) {
            try {
                return { ...this.config, ...JSON.parse(meta.content) };
            } catch (e) {
                console.warn('[Runtime] Invalid config meta, using defaults.');
            }
        }
        return this.config;
    },

    // ---------- Event Emission ----------
    emit(eventName, detail = {}) {
        const event = new CustomEvent(eventName, { detail });
        document.dispatchEvent(event);
        if (this.config.debug) {
            console.debug(`[Runtime] → ${eventName}`, detail);
        }
    },

    // ---------- Error Handling ----------
    reportError(error, context = {}) {
        const errorReport = {
            message: error.message || String(error),
            stack: error.stack,
            context,
            timestamp: Date.now(),
            runtimeState: this.state,
        };
        console.error('[Runtime] Error reported:', errorReport);
        this.emit('runtime:error', errorReport);
    },

    setupGlobalErrorHandler() {
        window.addEventListener('error', (e) => {
            this.reportError(e.error || e.message, { source: 'global' });
        });
        window.addEventListener('unhandledrejection', (e) => {
            this.reportError(e.reason, { source: 'unhandledRejection' });
        });
    },

    // ---------- Health Monitoring ----------
    startHealthMonitoring() {
        if (this._healthInterval) clearInterval(this._healthInterval);
        this._healthInterval = setInterval(() => this.healthCheck(), this.config.healthCheckInterval);
        setTimeout(() => this.healthCheck(), 1000);
    },

    healthCheck() {
        const statuses = {};
        let allHealthy = true;
        const hero = this.SectionController?.get('hero');

        if (hero) {
            try {
                const status = typeof hero.getStatus === 'function' ? hero.getStatus() : 'unknown';
                statuses['hero'] = status;
                if (status === 'error' || status === 'unhealthy') allHealthy = false;
            } catch (err) {
                statuses['hero'] = 'error';
                allHealthy = false;
                this.reportError(err, { section: 'hero', action: 'healthCheck' });
            }
        }

        this.emit('runtime:health', { statuses, allHealthy, timestamp: Date.now() });
        return { statuses, allHealthy };
    },

    // ---------- Diagnostics ----------
    diagnostics() {
        const sectionDiagnostics = {};
        const hero = this.SectionController?.get('hero');

        if (hero && typeof hero.diagnostics === 'function') {
            try {
                sectionDiagnostics['hero'] = hero.diagnostics();
            } catch (e) {
                sectionDiagnostics['hero'] = { error: e.message };
            }
        }

        return {
            runtime: {
                version: this.version,
                state: this.state,
                config: this.config,
                uptime: Date.now() - this.state.bootTime,
                // list() exists in section-controller.js but not yet in contract §6.
                // Optional chaining + fallback keeps this safe until contract is updated.
                sections: this.SectionController?.list?.() || ['hero']
            },
            sections: sectionDiagnostics
        };
    },

    // ---------- Message Receiver ----------
    // FIX: was missing from contract §6. Now implemented.
    // Contract §5: payload is the FULL bridge envelope {id,type,data,source,timestamp,protocolVersion}.
    // Real content lives at payload.data — NOT payload directly.
    receive(type, payload = {}) {
        switch (type) {
            case "hero:heartbeat":
                // Heartbeat acknowledged — connection health confirmed
                break;

            case "hero:navigation:request": {
                // FIX: contract §5 — content is at payload.data.target, not payload.target.
                // Fallback to payload.target retained for backward compatibility only.
                const target = payload.data?.target ?? payload.target;
                console.info(`[Runtime] Navigation request received: ${target}`);
                // Future: handle internal routing or state update here
                break;
            }

            // Hero lifecycle events — logged for observability
            case "hero:initialized":
            case "hero:navigation:started":
            case "hero:navigation:completed":
            case "hero:theme:changed":
            case "hero:menu:opened":
            case "hero:menu:closed":
            case "hero:state:reset":
            case "hero:quote:render":
            case "hero:portrait:loaded":
            case "hero:animation:entered":
            case "hero:animation:exited":
                console.debug(`[Runtime] Hero event: ${type}`, payload);
                break;

            default:
                console.info(`[Runtime] Unhandled message: ${type}`, payload);
        }
    }
};

// ==================== VERSION ====================
Runtime.version = {
    website: "1.0.0",
    runtime: "4.6.0",
    theme: "Charcoal Crimson 4.6.0",
    build: "Development"
};

// ==================== SECTION CONTROLLER REFERENCE ====================
// Single reference pointer only. Definition lives in section-controller.js.
// section-controller.js MUST be loaded before runtime.js in index.html.
Runtime.SectionController = window.SectionController;

// ==================== BOOTSTRAP ====================
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => Runtime.init(), { once: true });
} else {
    Runtime.init();
}
