// runtime.js - Website Runtime bootstrap

window.Runtime = {
    version: {},
    state: {},
    engines: {},
    components: {},

    init() {
        console.log("IDPORT Runtime Initialised");

        // Adopt Hero after it signals ready (Hybrid Architecture)
        document.addEventListener("hero:initialized", () => {
            Runtime.SectionController.adopt("hero", window.Hero);
        }, { once: true });
    }
};

Runtime.version = {
    website: "1.0.0",
    runtime: "V4.6.§.5.7",
    theme: "Charcoal Crimson V4.6.§.5.7",
    build: "Development Build 001",
    deployment: "Local Development"
};

// ==================== SECTION CONTROLLER ====================
Runtime.SectionController = {
    sections: {},   // Single source of truth

    adopt(sectionName, instance) {
        if (!instance || typeof instance.getStatus !== "function") {
            console.warn(`[Runtime] Invalid section instance for "${sectionName}"`);
            return false;
        }
        if (this.sections[sectionName]) {
            console.warn(`[Runtime] Section "${sectionName}" already adopted.`);
            return false;
        }
        this.sections[sectionName] = instance;
        console.log(`[Runtime] Successfully adopted section: ${sectionName}`);
        return true;
    },

    get(sectionName) {
        return this.sections[sectionName] || null;
    }
};

// ==================== BOOTSTRAP ====================
// Ensure Runtime always initializes
Runtime.init();







// ==================== RUNTIME MESSAGE RECEIVER ====================
// Hero Bridge → Runtime communication handler
Runtime.receive = function (type, payload = {}) {
    switch (type) {
        case "hero:heartbeat":
            // Heartbeat acknowledged - can be used for connection health
            break;

        case "hero:navigation:request": {
            const target = payload.data?.target ?? payload.target;
            console.info(`[Runtime] Navigation request received: ${target}`);
            // Future: handle internal routing or state update here
            break;
        }

        // Hero lifecycle events (no-op for now, but logged for observability)
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
            console.info(`[Runtime] Unhandled message type: ${type}`, payload);
    }
};
