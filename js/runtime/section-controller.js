// ================================================================
// SECTION CONTROLLER — Single Source of Truth
// ================================================================
// File: js/runtime/section-controller.js
// Responsibilities: Registry and lifecycle management for sections.
// Does NOT render, fetch, apply themes, navigate, or animate.
// ================================================================

(function(global) {
    'use strict';

    // ---------- Private Registry ----------
    const _sections = new Map(); // name -> instance

    // ---------- Event Emission ----------
    function emit(eventName, detail = {}) {
        const event = new CustomEvent(`section:${eventName}`, { detail, bubbles: true });
        document.dispatchEvent(event);
        if (global.Runtime?.config?.debug) {
            console.debug(`[SectionController] Event: ${eventName}`, detail);
        }
    }

    // ---------- Validation Helper ----------
    function isValidSectionInstance(instance) {
        return instance &&
            (typeof instance.getStatus === 'function' ||
             typeof instance.init === 'function' ||
             typeof instance.ready === 'function' ||
             typeof instance.destroy === 'function');
    }

    // ---------- SectionController Object ----------
    const SectionController = {

        // --- Core Contract ---

        /**
         * Adopt a live section instance.
         * @param {string} name - Unique section identifier.
         * @param {object} instance - Section instance with lifecycle methods.
         * @returns {boolean} Success/failure.
         */
        adopt(name, instance) {
            if (typeof name !== 'string' || !name.trim()) {
                console.error('[SectionController] adopt: invalid name');
                return false;
            }
            if (!isValidSectionInstance(instance)) {
                console.warn(`[SectionController] adopt: invalid instance for "${name}"`);
                return false;
            }
            if (_sections.has(name)) {
                console.warn(`[SectionController] adopt: section "${name}" already adopted.`);
                return false;
            }
            _sections.set(name, instance);
            emit('adopted', { name });
            console.log(`[SectionController] Adopted section: ${name}`);
            return true;
        },

        /**
         * Get a registered section instance.
         * @param {string} name - Section identifier.
         * @returns {object|null} The instance or null.
         */
        get(name) {
            return _sections.get(name) || null;
        },

        /**
         * Check if a section is registered.
         * @param {string} name - Section identifier.
         * @returns {boolean}
         */
        has(name) {
            return _sections.has(name);
        },

        /**
         * List all registered section names.
         * @returns {string[]} Array of names.
         */
        list() {
            return Array.from(_sections.keys());
        },

        /**
         * Unregister a section (remove from registry) without calling destroy.
         * @param {string} name - Section identifier.
         * @returns {boolean} Success.
         */
        unregister(name) {
            if (!_sections.has(name)) {
                console.warn(`[SectionController] unregister: section "${name}" not found.`);
                return false;
            }
            _sections.delete(name);
            emit('unregistered', { name });
            console.log(`[SectionController] Unregistered section: ${name}`);
            return true;
        },

        /**
         * Register a section (alias for adopt, kept for API completeness).
         * @param {string} name - Section identifier.
         * @param {object} instance - Section instance.
         * @returns {boolean} Success.
         */
        register(name, instance) {
            return this.adopt(name, instance);
        },

        // --- Lifecycle Management ---

        /**
         * Destroy a specific section (calls its destroy method).
         * @param {string} name - Section identifier.
         * @param {boolean} [removeFromRegistry=true] - Whether to remove from registry.
         * @returns {boolean} Success.
         */
        destroy(name, removeFromRegistry = true) {
            const instance = _sections.get(name);
            if (!instance) {
                console.warn(`[SectionController] destroy: section "${name}" not found.`);
                return false;
            }
            if (typeof instance.destroy === 'function') {
                try {
                    instance.destroy();
                } catch (err) {
                    console.error(`[SectionController] Error destroying section "${name}":`, err);
                    emit('error', { name, error: err.message });
                    return false;
                }
            }
            if (removeFromRegistry) {
                _sections.delete(name);
                emit('destroyed', { name });
                console.log(`[SectionController] Destroyed section: ${name}`);
            } else {
                console.log(`[SectionController] Destroyed (but kept) section: ${name}`);
            }
            return true;
        },

        /**
         * Destroy all registered sections.
         * @param {boolean} [clearRegistry=true] - Whether to clear registry after destroying.
         * @returns {number} Number of sections destroyed.
         */
        destroyAll(clearRegistry = true) {
            const names = Array.from(_sections.keys());
            let count = 0;
            for (const name of names) {
                if (this.destroy(name, false)) {
                    count++;
                }
            }
            if (clearRegistry) {
                _sections.clear();
            }
            emit('destroyedAll', { count, names });
            console.log(`[SectionController] Destroyed ${count} sections.`);
            return count;
        },

        /**
         * Suspend a specific section (calls its suspend method).
         * @param {string} name - Section identifier.
         * @returns {boolean} Success.
         */
        suspend(name) {
            const instance = _sections.get(name);
            if (!instance) {
                console.warn(`[SectionController] suspend: section "${name}" not found.`);
                return false;
            }
            if (typeof instance.suspend === 'function') {
                try {
                    instance.suspend();
                    emit('suspended', { name });
                    console.log(`[SectionController] Suspended section: ${name}`);
                    return true;
                } catch (err) {
                    console.error(`[SectionController] Error suspending section "${name}":`, err);
                    emit('error', { name, error: err.message });
                    return false;
                }
            }
            console.log(`[SectionController] Section "${name}" has no suspend method.`);
            return false;
        },

        /**
         * Resume a specific section (calls its resume method).
         * @param {string} name - Section identifier.
         * @returns {boolean} Success.
         */
        resume(name) {
            const instance = _sections.get(name);
            if (!instance) {
                console.warn(`[SectionController] resume: section "${name}" not found.`);
                return false;
            }
            if (typeof instance.resume === 'function') {
                try {
                    instance.resume();
                    emit('resumed', { name });
                    console.log(`[SectionController] Resumed section: ${name}`);
                    return true;
                } catch (err) {
                    console.error(`[SectionController] Error resuming section "${name}":`, err);
                    emit('error', { name, error: err.message });
                    return false;
                }
            }
            console.log(`[SectionController] Section "${name}" has no resume method.`);
            return false;
        },

        /**
         * Suspend all registered sections.
         * @returns {number} Number of sections suspended.
         */
        suspendAll() {
            const names = Array.from(_sections.keys());
            let count = 0;
            for (const name of names) {
                if (this.suspend(name)) count++;
            }
            emit('suspendedAll', { count, names });
            console.log(`[SectionController] Suspended ${count} sections.`);
            return count;
        },

        /**
         * Resume all registered sections.
         * @returns {number} Number of sections resumed.
         */
        resumeAll() {
            const names = Array.from(_sections.keys());
            let count = 0;
            for (const name of names) {
                if (this.resume(name)) count++;
            }
            emit('resumedAll', { count, names });
            console.log(`[SectionController] Resumed ${count} sections.`);
            return count;
        },

        // --- Advanced Features ---

        /**
         * Mount a section (lazy-load / initialize).
         * For future sections like About, Carousel, etc.
         * @param {string} name - Section identifier.
         * @param {object} [config] - Optional configuration.
         * @returns {Promise<boolean>} Resolves to success status.
         */
        mount(name, config = {}) {
            if (typeof name !== 'string' || !name.trim()) {
                console.error('[SectionController] mount: invalid name');
                return Promise.resolve(false);
            }
            if (_sections.has(name)) {
                console.warn(`[SectionController] mount: section "${name}" already registered.`);
                return Promise.resolve(false);
            }
            emit('mounting', { name, config });
            console.log(`[SectionController] Mount request for section: ${name}`, config);
            // Placeholder: section should call adopt(name, instance) after loading.
            // Future: import(`./sections/${name}.js`).then(module => { ... });
            emit('mounted', { name, config });
            return Promise.resolve(true);
        },

        /**
         * Return a copy of the registry (for inspection).
         * @returns {Object} Map-like object with names and instance statuses.
         */
        registry() {
            const result = {};
            for (const [name, instance] of _sections) {
                result[name] = {
                    exists: true,
                    hasGetStatus: typeof instance.getStatus === 'function',
                    hasInit: typeof instance.init === 'function',
                    hasDestroy: typeof instance.destroy === 'function',
                    hasSuspend: typeof instance.suspend === 'function',
                    hasResume: typeof instance.resume === 'function',
                    status: typeof instance.getStatus === 'function' ? instance.getStatus() : 'unknown'
                };
            }
            return result;
        },

        /**
         * Get diagnostics for all sections.
         * @returns {Object} Diagnostic info.
         */
        diagnostics() {
            const diag = {
                total: _sections.size,
                names: this.list(),
                details: {}
            };
            for (const [name, instance] of _sections) {
                diag.details[name] = {
                    status: typeof instance.getStatus === 'function' ? instance.getStatus() : 'unknown',
                    hasLifecycle: {
                        init: typeof instance.init === 'function',
                        destroy: typeof instance.destroy === 'function',
                        suspend: typeof instance.suspend === 'function',
                        resume: typeof instance.resume === 'function',
                    }
                };
                if (typeof instance.diagnostics === 'function') {
                    try {
                        diag.details[name].internal = instance.diagnostics();
                    } catch (_) { /* ignore */ }
                }
            }
            return diag;
        },

        /**
         * Reset the registry (clear all sections without calling destroy).
         * Use with caution.
         */
        resetRegistry() {
            _sections.clear();
            emit('registryReset');
            console.log('[SectionController] Registry reset.');
        }
    };

    // ---------- Expose to Global ----------
    // This is the single source of truth. runtime.js references this — it does not redefine it.
    global.SectionController = SectionController;

    // If Runtime already exists on the global (load order: runtime.js first),
    // attach immediately. Otherwise wait for the runtime:booted event.
    if (global.Runtime) {
        global.Runtime.SectionController = SectionController;
    } else {
        document.addEventListener('runtime:booted', () => {
            if (global.Runtime) {
                global.Runtime.SectionController = SectionController;
            }
        }, { once: true });
    }

    console.log('[SectionController] Loaded and ready.');

})(typeof window !== 'undefined' ? window : this);
