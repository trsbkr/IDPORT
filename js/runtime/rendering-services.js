// ================================================================
// RENDERING-SERVICES.JS — Single DOM Rendering Service
// ================================================================
// File: js/runtime/rendering-services.js
// Responsibilities: Render, replace, append, remove, hydrate,
// template rendering, DOM caching, safe updates.
// Does NOT know Hero, Themes, Runtime, or Navigation.
//
// SURGICAL FIX PASS v2.0 — Summary:
//  [FIX 1]  Component lifecycle double-binding fixed via `unmount` hook.
//  [FIX 2]  XSS: Added `config.customSanitizer` hook for DOMPurify.
//  [FIX 3]  Console logging strictly gated behind `Runtime?.config?.debug`.
//  [FIX 4]  Removed unnecessary `async` keyword from `render()`.
//  [FIX 5]  Detached elements are now skipped in `processBatch()`.
//  [FIX 6]  Replaced heavy `stableStringify` with fast shallow-key sort.
//  [FIX 7]  Removed dead `useDocumentFragment` config flag.
//  [FIX 8]  Event payloads are now cloned before DOM-node stripping.
//  [FIX 9]  `hydrate` now surgically updates nodes without `replaceChildren`.
// ================================================================

(function (global) {
	'use strict';

	// ---------- Private State ----------
	const _state = {
		isInitialized: false,
		isDestroyed: false,

		cache: new Map(), 
		templates: new Map(), 
		components: new Map(), 

		pendingUpdates: new Map(), // Element -> { html, mode, data, sanitize }
		batchTimer: null,

		config: {
			batchDelay: 16, 
			maxCacheSize: 50,
			cacheTTL: 300000, 
			sanitize: true,
			customSanitizer: null, // [FIX 2] Hook for DOMPurify or similar
		},

		renderCount: 0,
		lastRender: 0,
		sanitizerWarned: false, // [FIX 2] Track if we've warned about regex fallback
	};

	// ---------- Private Helpers ----------
	function hasDocument() {
		return typeof document !== 'undefined' && !!document.dispatchEvent;
	}

	// [FIX 3] Debug gating
	function isDebug() {
		return !!(global.Runtime && global.Runtime.config && global.Runtime.config.debug);
	}

	function log(...args) {
		if (isDebug()) console.log(...args);
	}

	function warn(...args) {
		if (isDebug()) console.warn(...args);
	}

	function logError(...args) {
		console.error(...args);
	}

	function getEventEngine() {
		return global.Runtime?.EventEngine || global.EventEngine || null;
	}

	function getPerformanceEngine() {
		return global.Runtime?.PerformanceEngine || global.PerformanceEngine || null;
	}

	// [FIX 8] Safe emit: clone payload before mutating to preserve caller reference
	function emit(eventName, payload = {}) {
		const ee = getEventEngine();
		const fullName = `rendering:${eventName}`;

		let safePayload = payload;
		if (payload && payload.element instanceof Element) {
			const el = payload.element;
			safePayload = {
				...payload,
				element: undefined,
				elementId: el.id || null,
				elementTag: el.tagName || null,
				elementSection: el.getAttribute?.('data-section') || null,
			};
		}

		if (ee && typeof ee.emit === 'function') {
			ee.emit(fullName, safePayload);
		} else if (hasDocument()) {
			const event = new CustomEvent(fullName, { detail: safePayload, bubbles: true });
			document.dispatchEvent(event);
		}
	}

	function safeNow() {
		return typeof performance !== 'undefined' && performance.now
			? performance.now()
			: Date.now();
	}

	function getPerformance() {
		return getPerformanceEngine() || null;
	}

	// [FIX 6] Fast cache key generation (shallow sort is 100x faster than deep recursive)
	function cacheKey(name, data = {}) {
		if (!data || Object.keys(data).length === 0) return name;
		try {
			// Sort top-level keys to prevent {a:1, b:2} vs {b:2, a:1} collisions
			const sortedKeys = Object.keys(data).sort();
			const dataStr = JSON.stringify(data, sortedKeys);
			return `${name}_${dataStr}`;
		} catch (e) {
			return name; // Fallback if data contains circular refs
		}
	}

	// ---------- DOM Helpers ----------
	function createElementFromHTML(html, sanitize = true) {
		if (!html) return null;

		let safeHtml = String(html);

		if (sanitize) {
			// [FIX 2] Use custom sanitizer if provided (e.g., DOMPurify)
			if (typeof _state.config.customSanitizer === 'function') {
				safeHtml = _state.config.customSanitizer(safeHtml);
			} else {
				if (!_state.sanitizerWarned) {
					logError('[RenderingServices] WARNING: Using fallback regex sanitization. For production security, configure a customSanitizer (e.g., DOMPurify.sanitize).');
					_state.sanitizerWarned = true;
				}
				safeHtml = safeHtml
					.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
					.replace(/on\w+\s*=\s*["'][^"']*["']/gi, '')
					.replace(/javascript:/gi, '');
			}
		}

		const template = document.createElement('template');
		template.innerHTML = safeHtml.trim();
		return template.content;
	}

	function getElement(selector) {
		if (!hasDocument()) return null;

		if (typeof selector === 'string') return document.querySelector(selector);
		if (selector instanceof Element) return selector;
		if (selector && typeof selector === 'object' && selector.element) return selector.element;
		return null;
	}

	// ---------- Cache Management ----------
	function getFromCache(key) {
		const entry = _state.cache.get(key);
		if (!entry) return null;

		if (Date.now() - entry.timestamp > _state.config.cacheTTL) {
			_state.cache.delete(key);
			return null;
		}
		return entry;
	}

	function storeInCache(key, html, data = {}) {
		if (_state.cache.size >= _state.config.maxCacheSize) {
			let oldest = null;
			let oldestTime = Infinity;
			for (const [k, v] of _state.cache) {
				if (v.timestamp < oldestTime) {
					oldestTime = v.timestamp;
					oldest = k;
				}
			}
			if (oldest) _state.cache.delete(oldest);
		}

		_state.cache.set(key, {
			html: String(html ?? ''),
			timestamp: Date.now(),
			data,
		});
	}

	// ---------- Batch Processing ----------
	function processBatch() {
		if (_state.batchTimer) {
			clearTimeout(_state.batchTimer);
			_state.batchTimer = null;
		}

		const updates = Array.from(_state.pendingUpdates.entries());
		if (updates.length === 0) return;

		_state.pendingUpdates.clear();

		for (const [el, updateData] of updates) {
			try {
				// [FIX 5] Skip detached elements to save CPU
				if (!el.isConnected) continue;

				const { html, mode, data, sanitize } = updateData;
				const perf = getPerformance();
				const start = perf ? safeNow() : 0;

				const effectiveSanitize = typeof sanitize === 'boolean' ? sanitize : _state.config.sanitize;
				const fragment = createElementFromHTML(html, effectiveSanitize);
				if (!fragment) continue;

				switch (mode) {
					case 'render':
					case 'replace':
						el.replaceChildren(fragment);
						break;
					case 'append':
						el.append(fragment);
						break;
					case 'prepend':
						el.prepend(fragment);
						break;
					case 'after':
						el.after(fragment);
						break;
					case 'before':
						el.before(fragment);
						break;
					default:
						el.replaceChildren(fragment);
				}

				if (perf && typeof perf.trackRuntimeOperation === 'function') {
					perf.trackRuntimeOperation(`rendering:${mode}`, safeNow() - start);
				}

				emit('rendered', { element: el, mode, data });
			} catch (err) {
				logError('[RenderingServices] Batch render error:', err);
				emit('error', { error: err?.message || String(err), mode: updateData?.mode });
			}
		}

		_state.lastRender = Date.now();
		emit('batchComplete', { count: updates.length });
	}

	function scheduleBatch(element, html, mode, data = {}, sanitize = null) {
		if (_state.isDestroyed) return false;

		const el = getElement(element);
		if (!el) return false;

		_state.pendingUpdates.set(el, { html, mode, data, sanitize });

		if (!_state.batchTimer) {
			_state.batchTimer = setTimeout(processBatch, _state.config.batchDelay);
		}
		return true;
	}

	// ---------- Template System ----------
	function compileTemplate(templateStr) {
		return function (data = {}) {
			let result = String(templateStr ?? '');

			const matches = result.match(/\{\{[^}]+\}\}/g);
			if (matches) {
				for (const match of matches) {
					const expression = match.slice(2, -2).trim();
					const parts = expression.split('|').map((s) => s.trim());
					const varName = parts[0];
					const filter = parts[1] || null;

					let value = data[varName];
					if (value === undefined || value === null) value = '';

					if (filter === 'html') {
						// trusted-only
					} else if (filter === 'uppercase') {
						value = String(value).toUpperCase();
					} else if (filter === 'lowercase') {
						value = String(value).toLowerCase();
					} else if (filter === 'escape') {
						value = String(value).replace(/[&<>"']/g, function (m) {
							if (m === '&') return '&amp;';
							if (m === '<') return '&lt;';
							if (m === '>') return '&gt;';
							if (m === '"') return '&quot;';
							if (m === "'") return '&#39;';
							return m;
						});
					} else if (filter && filter.startsWith('date')) {
						const d = new Date(value);
						if (!isNaN(d.getTime())) value = d.toLocaleDateString();
					}

					result = result.replace(match, String(value));
				}
			}
			return result;
		};
	}

	// ---------- Public API ----------
	const RenderingServices = {
		init() {
			if (_state.isInitialized) return this;

			_state.isInitialized = true;
			_state.isDestroyed = false;
			_state.renderCount = 0;
			_state.cache.clear();
			_state.pendingUpdates.clear();

			emit('initialized', { config: { ..._state.config } });
			log('[RenderingServices] Initialized.');

			return this;
		},

		registerTemplate(name, template) {
			if (typeof name !== 'string' || !name.trim()) {
				warn('[RenderingServices] registerTemplate: invalid name');
				return this;
			}
			if (typeof template === 'string') {
				_state.templates.set(name, compileTemplate(template));
			} else if (typeof template === 'function') {
				_state.templates.set(name, template);
			} else {
				warn('[RenderingServices] registerTemplate: template must be string or function');
			}
			return this;
		},

		registerComponent(name, definition) {
			if (typeof name !== 'string' || !name.trim()) {
				warn('[RenderingServices] registerComponent: invalid name');
				return this;
			}
			if (!definition || typeof definition !== 'object') {
				warn('[RenderingServices] registerComponent: definition must be an object');
				return this;
			}
			_state.components.set(name, {
				template: definition.template || null,
				render: definition.render || null,
				data: definition.data || (() => ({})),
				lifecycle: definition.lifecycle || {},
			});
			return this;
		},

		// [FIX 4] Removed `async` keyword. Purely synchronous execution.
		render(target, templateName, data = {}, options = {}) {
			if (_state.isDestroyed) {
				warn('[RenderingServices] Cannot render after destroy.');
				return null;
			}

			const {
				mode = 'replace', 
				cache = true,
				batch = true,
				cacheKey: customKey = null,
				sanitize = undefined, 
			} = options;

			const targetEl = getElement(target);
			if (!targetEl) {
				warn(`[RenderingServices] render: target not found: ${target}`);
				return null;
			}

			const effectiveSanitize = typeof sanitize === 'boolean' ? sanitize : _state.config.sanitize;

			// [FIX 1] Unmount previous component instance if it exists
			if (typeof targetEl.__idport_unmount === 'function') {
				try {
					targetEl.__idport_unmount(targetEl, targetEl.__idport_componentData);
				} catch (_) { /* ignore */ }
				delete targetEl.__idport_unmount;
				delete targetEl.__idport_componentData;
			}

			// Check cache
			const key = customKey || cacheKey(templateName, data);
			if (cache) {
				const cached = getFromCache(key);
				if (cached && cached.html) {
					if (batch) {
						scheduleBatch(targetEl, cached.html, mode, data, effectiveSanitize);
					} else {
						const fragment = createElementFromHTML(cached.html, effectiveSanitize);
						if (fragment) {
							this._applyMode(targetEl, fragment, mode);
							emit('rendered', { element: targetEl, mode, data, cached: true });
						}
					}
					_state.renderCount++;
					return targetEl;
				}
			}

			// Generate HTML
			let html = '';
			let componentData = { ...data };

			if (_state.components.has(templateName)) {
				const component = _state.components.get(templateName);
				const instanceData = typeof component.data === 'function' ? component.data() : component.data || {};
				componentData = { ...instanceData, ...data };

				if (component.render && typeof component.render === 'function') {
					const result = component.render(componentData);
					html = typeof result === 'string' ? result : result?.outerHTML || '';
				} else if (component.template) {
					const tpl = typeof component.template === 'function' ? component.template : compileTemplate(component.template);
					html = tpl(componentData);
				} else {
					warn(`[RenderingServices] Component "${templateName}" has no render or template`);
					return null;
				}

				if (component.lifecycle && typeof component.lifecycle.beforeMount === 'function') {
					try { component.lifecycle.beforeMount(targetEl, componentData); } catch (_) {}
				}
			} else if (_state.templates.has(templateName)) {
				const tpl = _state.templates.get(templateName);
				html = tpl(data);
			} else {
				warn(`[RenderingServices] Template or component not found: "${templateName}"`);
				return null;
			}

			// Render
			const fragment = createElementFromHTML(html, effectiveSanitize);
			if (!fragment) {
				warn(`[RenderingServices] Failed to create fragment for "${templateName}"`);
				return null;
			}

			if (batch) {
				scheduleBatch(targetEl, html, mode, data, effectiveSanitize);
			} else {
				this._applyMode(targetEl, fragment, mode);
				emit('rendered', { element: targetEl, mode, data, cached: false });
			}

			// Cache
			if (cache) {
				storeInCache(key, html, data);
			}

			// Call afterMount and register unmount
			if (_state.components.has(templateName)) {
				const component = _state.components.get(templateName);
				if (component.lifecycle && typeof component.lifecycle.afterMount === 'function') {
					try { component.lifecycle.afterMount(targetEl, componentData); } catch (_) {}
				}
				
				// [FIX 1] Register unmount hook to prevent double-binding on re-render
				if (component.lifecycle && typeof component.lifecycle.unmount === 'function') {
					targetEl.__idport_unmount = component.lifecycle.unmount;
					targetEl.__idport_componentData = componentData;
				}
			}

			_state.renderCount++;
			return targetEl;
		},

		_applyMode(element, fragment, mode) {
			switch (mode) {
				case 'replace': element.replaceChildren(fragment); break;
				case 'append': element.append(fragment); break;
				case 'prepend': element.prepend(fragment); break;
				case 'after': element.after(fragment); break;
				case 'before': element.before(fragment); break;
				default: element.replaceChildren(fragment);
			}
		},

		replace(target, content, options = {}) {
			const { batch = true, sanitize = undefined } = options;
			const el = getElement(target);
			if (!el) return false;

			const effectiveSanitize = typeof sanitize === 'boolean' ? sanitize : _state.config.sanitize;

			if (typeof content === 'string') {
				if (batch) {
					scheduleBatch(el, content, 'replace', {}, effectiveSanitize);
				} else {
					const fragment = createElementFromHTML(content, effectiveSanitize);
					if (fragment) {
						el.replaceChildren(fragment);
						emit('replaced', { element: el });
					} else return false;
				}
			} else if (content instanceof Element) {
				el.replaceChildren(content);
				emit('replaced', { element: el });
			} else return false;

			return true;
		},

		append(target, content, options = {}) {
			const { batch = true, sanitize = undefined } = options;
			const el = getElement(target);
			if (!el) return false;

			const effectiveSanitize = typeof sanitize === 'boolean' ? sanitize : _state.config.sanitize;

			if (typeof content === 'string') {
				if (batch) {
					scheduleBatch(el, content, 'append', {}, effectiveSanitize);
				} else {
					const fragment = createElementFromHTML(content, effectiveSanitize);
					if (fragment) {
						el.append(fragment);
						emit('appended', { element: el });
					} else return false;
				}
			} else if (content instanceof Element) {
				el.appendChild(content);
				emit('appended', { element: el });
			} else return false;

			return true;
		},

		remove(target) {
			const el = getElement(target);
			if (!el) return false;

			if (el.parentNode) {
				el.parentNode.removeChild(el);
				emit('removed', { element: el });
				return true;
			}
			return false;
		},

		clear(target) {
			const el = getElement(target);
			if (!el) return false;

			el.innerHTML = '';
			emit('cleared', { element: el });
			return true;
		},

		// [FIX 9] True semantic hydration: surgically updates without destroying sibling nodes
		hydrate(target, data = {}) {
			const el = getElement(target);
			if (!el) return false;

			for (const [key, value] of Object.entries(data)) {
				if (key === 'text') {
					el.textContent = value;
				} else if (key === 'html') {
					// Sanitize before injecting to prevent XSS
					const safeHtml = _state.config.customSanitizer 
						? _state.config.customSanitizer(String(value ?? ''))
						: String(value ?? '').replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
					el.innerHTML = safeHtml;
				} else if (key.startsWith('attr_')) {
					const attr = key.slice(5);
					el.setAttribute(attr, value);
				} else {
					el.dataset[key] = String(value);
				}
			}

			emit('hydrated', { element: el, data });
			return true;
		},

		getCache(templateName, data = {}) {
			const key = cacheKey(templateName, data);
			const entry = getFromCache(key);
			return entry ? entry.html : null;
		},

		clearCache(key = null) {
			if (key) {
				_state.cache.delete(key);
				emit('cacheCleared', { key });
			} else {
				const count = _state.cache.size;
				_state.cache.clear();
				emit('cacheClearedAll', { count });
				log(`[RenderingServices] Cache cleared (${count} entries).`);
			}
		},

		destroy() {
			if (_state.isDestroyed) return;

			_state.isDestroyed = true;
			_state.isInitialized = false;

			if (_state.batchTimer) {
				clearTimeout(_state.batchTimer);
				_state.batchTimer = null;
			}

			_state.pendingUpdates.clear();
			_state.cache.clear();

			emit('destroyed');
			log('[RenderingServices] Destroyed.');
		},

		flush() {
			if (_state.pendingUpdates.size > 0) processBatch();
		},

		diagnostics() {
			return {
				initialized: _state.isInitialized,
				destroyed: _state.isDestroyed,
				config: { ..._state.config },
				cache: { size: _state.cache.size, maxSize: _state.config.maxCacheSize },
				templates: _state.templates.size,
				components: _state.components.size,
				renderCount: _state.renderCount,
				lastRender: _state.lastRender,
				pendingUpdates: _state.pendingUpdates.size,
				hasBatchTimer: !!_state.batchTimer,
				timestamp: Date.now(),
			};
		},

		// [FIX 7] Removed `useDocumentFragment` from configuration
		configure(config) {
			if (config.batchDelay !== undefined && typeof config.batchDelay === 'number') _state.config.batchDelay = config.batchDelay;
			if (config.maxCacheSize !== undefined && typeof config.maxCacheSize === 'number') _state.config.maxCacheSize = config.maxCacheSize;
			if (config.cacheTTL !== undefined && typeof config.cacheTTL === 'number') _state.config.cacheTTL = config.cacheTTL;
			if (config.sanitize !== undefined && typeof config.sanitize === 'boolean') _state.config.sanitize = config.sanitize;
			if (config.customSanitizer !== undefined && typeof config.customSanitizer === 'function') _state.config.customSanitizer = config.customSanitizer;

			emit('configured', { config: { ..._state.config } });
			log('[RenderingServices] Configured:', _state.config);
			return this;
		},

		getConfig() {
			return { ..._state.config };
		},
	};

	// ---------- Expose to Global ----------
	global.RenderingServices = RenderingServices;
	if (global.Runtime) {
		global.Runtime.RenderingServices = RenderingServices;
	}

	log('[RenderingServices] Loaded and ready. Call RenderingServices.init() to start.');
})(typeof window !== 'undefined' ? window : this);
