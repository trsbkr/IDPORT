// ================================================================
// COMPONENT-REGISTRY.JS — Global Component Directory
// ================================================================
// File: js/runtime/component-registry.js
// Responsibilities: Register, resolve, mount, and manage reusable UI components.
// Does NOT render directly — provides components to sections.
//
// Patch notes (surgical fix pass):
//   FIX #1  mount(): string-factory output now resolves to a real,
//           trackable DOM node instead of a DocumentFragment.
//   FIX #2  remove(): sweeps stale instance entries for a removed
//           component regardless of destroyed state.
//   FIX #3  SSR/non-browser guards around document/performance use.
//   FIX #4  console logging gated behind _state.config.debug.
//   FIX #5  (resolved by FIX #4 — debug flag now actually read)
//   FIX #6  getScheduler() removed — was fetched but never used.
//   FIX #7  Element check widened to include cross-realm nodes.
//   FIX #8  Props are now shallow-copied on assignment, not held
//           by live reference to the caller's object.
//   FIX #9  strictMode now governs whether lifecycle hook errors
//           are rethrown (strict) or only warned (lenient).
//   FIX #10 autoCleanup now ties into remove(): when enabled,
//           removing a component force-destroys its instances
//           without requiring an explicit force flag.
//   FIX #11 registeredBy is now an optional per-registration field
//           instead of a hardcoded constant.
//   FIX #12 EventEngine contract documented inline.
// ================================================================

(function(global) {
    'use strict';

    // ---------- Environment Guards (FIX #3) ----------
    const hasDOM = typeof document !== 'undefined';
    const hasPerformance = typeof performance !== 'undefined';

    // ---------- Private State ----------
    const _state = {
        isInitialized: false,
        isDestroyed: false,
        components: new Map(),          // name -> ComponentDefinition
        instances: new Map(),           // instanceId -> ComponentInstance
        componentIdCounter: 0,
        config: {
            allowOverwrite: false,
            strictMode: true,           // FIX #9: now actually governs lifecycle error handling
            autoCleanup: true,          // FIX #10: now actually governs remove() behavior
            debug: false,               // FIX #4/#5: now actually gates console output
        },
    };

    // ---------- Private Helpers ----------
    // FIX #12: expected shape if Runtime.EventEngine is present:
    //   { emit(eventName: string, payload?: object): void }
    // This is an informal, best-effort integration — ComponentRegistry
    // falls back to a plain DOM CustomEvent if EventEngine is absent
    // or doesn't expose `emit`.
    function getEventEngine() {
        return global.Runtime?.EventEngine || global.EventEngine || null;
    }

    function getPerformanceEngine() {
        return global.Runtime?.PerformanceEngine || global.PerformanceEngine || null;
    }

    // FIX #6: getScheduler() removed — it was fetched but never used
    // anywhere in this file. Re-add only when a real use case (e.g.
    // deferred/batched mounting) actually calls it.

    function emit(eventName, payload = {}) {
        const ee = getEventEngine();
        if (ee && typeof ee.emit === 'function') {
            ee.emit(`component:${eventName}`, payload);
        } else if (hasDOM) {
            // FIX #3: guarded — no-op in non-DOM environments
            const event = new CustomEvent(`component:${eventName}`, {
                detail: payload,
                bubbles: true,
            });
            document.dispatchEvent(event);
        }
    }

    // FIX #4: centralized, debug-gated logging helpers
    function logInfo(...args) {
        if (_state.config.debug) console.log('[ComponentRegistry]', ...args);
    }
    function logWarn(...args) {
        if (_state.config.debug) console.warn('[ComponentRegistry]', ...args);
    }
    function logError(...args) {
        // Hard errors always surface, regardless of debug flag.
        console.error('[ComponentRegistry]', ...args);
    }

    function now() {
        return hasPerformance ? performance.now() : Date.now(); // FIX #3
    }

    function generateInstanceId() {
        return `comp_${++_state.componentIdCounter}_${Date.now()}`;
    }

    // ---------- Component Definition ----------
    class ComponentDefinition {
        constructor({ name, factory, version, description, category, tags, dependencies, lifecycle, registeredBy }) {
            this.name = name;
            this.factory = factory;
            this.version = version || '1.0.0';
            this.description = description || '';
            this.category = category || 'uncategorized';
            this.tags = tags || [];
            this.dependencies = dependencies || [];
            this.lifecycle = lifecycle || {};
            this.registeredAt = Date.now();
            this.registeredBy = registeredBy || 'IDPORT'; // FIX #11: overridable, defaults preserved
            this.instanceCount = 0;
        }

        createInstance(props = {}) {
            try {
                const instance = this.factory(props);
                this.instanceCount++;
                return instance;
            } catch (err) {
                logError(`Factory error for "${this.name}":`, err);
                throw err;
            }
        }
    }

    // ---------- Component Instance ----------
    class ComponentInstance {
        constructor({ id, name, element, props, instance, lifecycle }) {
            this.id = id;
            this.name = name;
            this.element = element;
            this.props = { ...(props || {}) }; // FIX #8: shallow copy, not a live reference
            this.instance = instance;
            this.lifecycle = lifecycle || {};
            this.mountedAt = Date.now();
            this.isMounted = false;
            this.isDestroyed = false;
            this._cleanupFns = [];
        }

        // FIX #9: shared helper — runs a lifecycle hook, respecting strictMode
        _runLifecycle(hookName, ...args) {
            const hook = this.lifecycle[hookName];
            if (typeof hook !== 'function') return;
            try {
                hook(...args);
            } catch (err) {
                if (_state.config.strictMode) {
                    logError(`${hookName} error for "${this.name}" (strictMode — rethrowing):`, err);
                    throw err;
                }
                logWarn(`${hookName} error for "${this.name}":`, err);
            }
        }

        mount(container, mountOptions = {}) {
            if (this.isMounted) {
                logWarn(`Component "${this.name}" already mounted.`);
                return this.element;
            }

            const { prepend = false, replace = false } = mountOptions;

            this._runLifecycle('beforeMount', this.element, this.props);

            // Mount the element
            if (this.element) {
                if (replace && container) {
                    container.replaceChildren(this.element);
                } else if (prepend && container) {
                    container.prepend(this.element);
                } else if (container) {
                    container.appendChild(this.element);
                }
            }

            this.isMounted = true;

            this._runLifecycle('afterMount', this.element, this.props);

            emit('mounted', { name: this.name, id: this.id, element: this.element });
            return this.element;
        }

        update(newProps = {}) {
            if (this.isDestroyed) {
                logWarn(`Cannot update destroyed component "${this.name}"`);
                return;
            }

            const oldProps = { ...this.props };
            this.props = { ...this.props, ...newProps };

            this._runLifecycle('update', this.element, this.props, oldProps);

            emit('updated', { name: this.name, id: this.id, props: this.props });
        }

        destroy() {
            if (this.isDestroyed) return;

            this._runLifecycle('beforeDestroy', this.element, this.props);

            // Remove from DOM — now safe: `element` is guaranteed to be a
            // real, still-attached node (see mount() / FIX #1 at the
            // ComponentRegistry.mount() call site).
            if (this.element && this.element.parentNode) {
                this.element.parentNode.removeChild(this.element);
            }

            this._runLifecycle('destroy', this.element, this.props);

            for (const fn of this._cleanupFns) {
                try {
                    fn();
                } catch (err) {
                    logWarn(`cleanup error for "${this.name}":`, err);
                }
            }
            this._cleanupFns = [];

            this.isDestroyed = true;
            this.isMounted = false;

            emit('destroyed', { name: this.name, id: this.id });
        }

        addCleanup(fn) {
            if (typeof fn === 'function') {
                this._cleanupFns.push(fn);
            }
        }

        getState() {
            return {
                id: this.id,
                name: this.name,
                mounted: this.isMounted,
                destroyed: this.isDestroyed,
                mountedAt: this.mountedAt,
                props: { ...this.props },
                element: this.element,
            };
        }
    }

    // ---------- Public API ----------
    const ComponentRegistry = {

        init() {
            if (_state.isInitialized) return this;

            _state.isInitialized = true;
            _state.isDestroyed = false;
            _state.components.clear();
            _state.instances.clear();

            emit('initialized', { config: { ..._state.config } });
            logInfo('Initialized.');
            return this;
        },

        register(name, factory, options = {}) {
            if (_state.isDestroyed) {
                logWarn('Cannot register after destroy.');
                return false;
            }

            if (typeof name !== 'string' || !name.trim()) {
                logWarn('Invalid component name.');
                return false;
            }

            if (_state.components.has(name)) {
                if (!_state.config.allowOverwrite && !options.overwrite) {
                    logWarn(`Component "${name}" already registered. Use overwrite: true to replace.`);
                    return false;
                }
                logInfo(`Overwriting component: ${name}`);
            }

            let factoryFn = factory;
            if (typeof factory === 'object' && factory !== null && typeof factory.render === 'function') {
                factoryFn = (props) => {
                    const result = factory.render(props);
                    return typeof result === 'string' ? result : result?.element || result;
                };
            }

            if (typeof factoryFn !== 'function') {
                logWarn('Factory must be a function or object with render method.');
                return false;
            }

            const definition = new ComponentDefinition({
                name,
                factory: factoryFn,
                version: options.version || '1.0.0',
                description: options.description || '',
                category: options.category || 'uncategorized',
                tags: options.tags || [],
                dependencies: options.dependencies || [],
                lifecycle: options.lifecycle || {},
                registeredBy: options.registeredBy, // FIX #11
            });

            _state.components.set(name, definition);

            emit('registered', {
                name,
                version: definition.version,
                category: definition.category,
                tags: definition.tags,
            });

            logInfo(`Registered component: ${name} v${definition.version}`);
            return true;
        },

        get(name) {
            return _state.components.get(name) || null;
        },

        exists(name) {
            return _state.components.has(name);
        },

        remove(name, force = false) {
            // FIX #10: autoCleanup, when enabled, behaves as if force were
            // always true — removing a component definition also removes
            // its instances without requiring the caller to opt in.
            const effectiveForce = force || _state.config.autoCleanup;

            const hasInstances = Array.from(_state.instances.values())
                .some(inst => inst.name === name && !inst.isDestroyed);

            if (hasInstances && !effectiveForce) {
                logWarn(`Cannot remove "${name}" — active instances exist. Use force: true.`);
                return false;
            }

            // FIX #2: sweep ALL instance entries for this name — including
            // already-destroyed ones — not just active instances blocking
            // removal. Previously these stale entries were never pruned.
            for (const [id, instance] of _state.instances) {
                if (instance.name !== name) continue;
                if (!instance.isDestroyed) instance.destroy();
                _state.instances.delete(id);
            }

            const removed = _state.components.delete(name);
            if (removed) {
                emit('removed', { name });
                logInfo(`Removed component: ${name}`);
            }
            return removed;
        },

        list(category = null, tag = null) {
            let names = Array.from(_state.components.keys());

            if (category) {
                names = names.filter(name => {
                    const def = _state.components.get(name);
                    return def && def.category === category;
                });
            }

            if (tag) {
                names = names.filter(name => {
                    const def = _state.components.get(name);
                    return def && def.tags.includes(tag);
                });
            }

            return names;
        },

        listAll(category = null, tag = null) {
            const names = this.list(category, tag);
            return names.map(name => _state.components.get(name));
        },

        getCategories() {
            const categories = new Set();
            for (const [, def] of _state.components) {
                categories.add(def.category);
            }
            return Array.from(categories);
        },

        getTags() {
            const tags = new Set();
            for (const [, def] of _state.components) {
                for (const tag of def.tags) {
                    tags.add(tag);
                }
            }
            return Array.from(tags);
        },

        mount(name, container, props = {}, options = {}) {
            if (!hasDOM) { // FIX #3
                logWarn('mount() requires a DOM environment.');
                return null;
            }

            const definition = _state.components.get(name);
            if (!definition) {
                logWarn(`Component "${name}" not found.`);
                return null;
            }

            const containerEl = typeof container === 'string'
                ? document.querySelector(container)
                : container;
            if (!containerEl) {
                logWarn(`Container not found for "${name}".`);
                return null;
            }

            const perf = getPerformanceEngine();
            const start = perf ? now() : 0;

            let instanceData;
            let element;

            // FIX #1: shared resolver — turns a string factory result into a
            // single, real, trackable DOM node instead of a DocumentFragment.
            // A DocumentFragment's children are moved out (and the fragment
            // emptied) the moment it's appended, which previously left
            // instance.element pointing at nothing — breaking destroy(),
            // update(), and getState() for every HTML-string component.
            function resolveStringToElement(htmlString) {
                const wrapper = document.createElement('div');
                wrapper.innerHTML = htmlString.trim();
                // Unwrap a single root for a cleaner DOM; otherwise keep the
                // wrapper itself as the stable, removable root node.
                return wrapper.childElementCount === 1
                    ? wrapper.firstElementChild
                    : wrapper;
            }

            try {
                instanceData = definition.createInstance(props);

                if (typeof instanceData === 'string') {
                    element = resolveStringToElement(instanceData);
                } else if (instanceData && instanceData.nodeType === 1) {
                    // FIX #7: nodeType check instead of `instanceof Element`
                    // — remains correct for nodes created in another realm
                    // (e.g. an iframe), where `instanceof` would fail.
                    element = instanceData;
                } else if (instanceData && typeof instanceData === 'object' && instanceData.element) {
                    element = instanceData.element;
                } else if (instanceData && typeof instanceData === 'object' && typeof instanceData.render === 'function') {
                    const renderResult = instanceData.render(props);
                    element = typeof renderResult === 'string'
                        ? resolveStringToElement(renderResult) // FIX #1 (second occurrence)
                        : renderResult;
                } else {
                    element = document.createTextNode(String(instanceData));
                }
            } catch (err) {
                logError(`Mount error for "${name}":`, err);
                emit('mountError', { name, error: err.message });
                return null;
            }

            if (!element) {
                logWarn(`Component "${name}" produced no element.`);
                return null;
            }

            const instanceId = generateInstanceId();
            const instance = new ComponentInstance({
                id: instanceId,
                name,
                element,
                props,
                instance: instanceData,
                lifecycle: definition.lifecycle,
            });

            instance.mount(containerEl, options);

            _state.instances.set(instanceId, instance);

            if (perf && typeof perf.trackRuntimeOperation === 'function') {
                const duration = now() - start;
                perf.trackRuntimeOperation(`component:mount:${name}`, duration);
            }

            emit('created', { name, id: instanceId, element });
            logInfo(`Mounted component: ${name} (${instanceId})`);

            return instance;
        },

        getInstance(instanceId) {
            return _state.instances.get(instanceId) || null;
        },

        getInstances(name) {
            const result = [];
            for (const [, instance] of _state.instances) {
                if (instance.name === name && !instance.isDestroyed) {
                    result.push(instance);
                }
            }
            return result;
        },

        getAllInstances(name = null) {
            const result = [];
            for (const [, instance] of _state.instances) {
                if (!instance.isDestroyed) {
                    if (name === null || instance.name === name) {
                        result.push(instance);
                    }
                }
            }
            return result;
        },

        destroyInstance(instanceId) {
            const instance = _state.instances.get(instanceId);
            if (!instance) return false;
            if (instance.isDestroyed) return true;

            instance.destroy();
            _state.instances.delete(instanceId);
            emit('instanceDestroyed', { id: instanceId, name: instance.name });
            return true;
        },

        destroyInstances(name) {
            const instances = this.getInstances(name);
            let count = 0;
            for (const instance of instances) {
                if (this.destroyInstance(instance.id)) {
                    count++;
                }
            }
            return count;
        },

        destroyAllInstances() {
            const ids = Array.from(_state.instances.keys());
            let count = 0;
            for (const id of ids) {
                if (this.destroyInstance(id)) {
                    count++;
                }
            }
            return count;
        },

        configure(config) {
            if (config.allowOverwrite !== undefined) {
                _state.config.allowOverwrite = config.allowOverwrite;
            }
            if (config.strictMode !== undefined) {
                _state.config.strictMode = config.strictMode;
            }
            if (config.autoCleanup !== undefined) {
                _state.config.autoCleanup = config.autoCleanup;
            }
            if (config.debug !== undefined) {
                _state.config.debug = config.debug;
            }
            emit('configured', { config: { ..._state.config } });
            logInfo('Configured:', _state.config);
            return this;
        },

        getConfig() {
            return { ..._state.config };
        },

        diagnostics() {
            const componentSummaries = {};
            for (const [name, def] of _state.components) {
                const instances = this.getInstances(name);
                componentSummaries[name] = {
                    version: def.version,
                    category: def.category,
                    tags: def.tags,
                    instanceCount: def.instanceCount,
                    activeInstances: instances.length,
                    registeredAt: def.registeredAt,
                    registeredBy: def.registeredBy,
                };
            }

            const instanceSummaries = [];
            for (const [id, instance] of _state.instances) {
                if (!instance.isDestroyed) {
                    instanceSummaries.push({
                        id,
                        name: instance.name,
                        mounted: instance.isMounted,
                        mountedAt: instance.mountedAt,
                        props: { ...instance.props },
                    });
                }
            }

            return {
                initialized: _state.isInitialized,
                destroyed: _state.isDestroyed,
                config: { ..._state.config },
                components: {
                    count: _state.components.size,
                    names: Array.from(_state.components.keys()),
                    categories: this.getCategories(),
                    tags: this.getTags(),
                    details: componentSummaries,
                },
                instances: {
                    count: instanceSummaries.length,
                    details: instanceSummaries.slice(0, 20),
                },
                timestamp: Date.now(),
            };
        },

        destroy() {
            if (_state.isDestroyed) return;

            this.destroyAllInstances();
            _state.components.clear();

            _state.isDestroyed = true;
            _state.isInitialized = false;

            emit('destroyed');
            logInfo('Destroyed.');
        },
    };

    // ---------- Expose to Global ----------
    global.ComponentRegistry = ComponentRegistry;

    if (global.Runtime) {
        global.Runtime.ComponentRegistry = ComponentRegistry;
    }

    ComponentRegistry.init();

    logInfo('Loaded and ready.');

})(typeof window !== 'undefined' ? window : this);
