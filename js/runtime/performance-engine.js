// ================================================================
// PERFORMANCE-ENGINE.JS — Health Observer for IDPORT
// ================================================================
// File: js/runtime/performance-engine.js
// Responsibilities: FPS, memory, long tasks, paint, layout shift,
// animation cost, runtime cost, event cost.
// Does NOT stop animations, change themes, destroy engines, or pause Hero.
//
// SURGICAL FIX PASS — see fix list for full change list. Summary:
//  [FIX 1]  FPS scheduler task is now properly cancelled on stop().
//  [FIX 2]  FPS delta calculation fixed; lastFrameTime only updates on sample.
//  [FIX 3]  PerformanceObservers are now recreated on start() after stop().
//  [FIX 4]  Warnings now fire only on threshold transitions, not on every read.
//  [FIX 5]  Metrics object rebuilt via createDefaultMetrics() factory.
//  [FIX 6]  Console logging gated behind Runtime?.config?.debug.
//  [FIX 7]  EventEngine dependency noted as optional/informal in header.
//  [FIX 8]  performance.memory Chromium-only limitation documented.
//  [FIX 9]  Dead LCP branch inside 'paint' observer removed.
//  [FIX 10] mark() wrapped in try/catch for consistency.
//  [FIX 11] PerformanceObserver existence checked before construction.
//  [FIX 12] Runtime.PerformanceEngine load-order dependency documented.
//  [FIX 13] Fallback rAF vs scheduler loop shape asymmetry documented.
//  [FIX 14] snapshot() cost unbounded nature documented.
//
// NOTES:
//  - EventEngine: This engine emits via getEventEngine(), falling back to 
//    DOM CustomEvents. Per IDPORT contract, event-engine.js is informal.
//  - Memory: performance.memory is Chromium-only. Firefox/Safari will report 0.
//  - Load Order: Runtime.PerformanceEngine attachment requires Runtime to exist.
//  - rAF Fallback: If Scheduler is missing, fallback rAF returns {cancel()} 
//    object, whereas Scheduler returns a number ID. stop() handles both.
//  - Snapshots: snapshot() copies all arrays. Do not call on a tight loop.
// ================================================================

(function(global) {
    'use strict';

    // ---------- Private State & Helpers ----------
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

    function createDefaultMetrics() {
        return {
            fps: { current: 60, average: 60, min: 60, max: 60, samples: [], drops: 0, lastSampleTime: 0 },
            memory: { usedJSHeapSize: 0, totalJSHeapSize: 0, jsHeapSizeLimit: 0, usedPercent: 0, samples: [] },
            longTasks: { count: 0, totalDuration: 0, maxDuration: 0, recent: [] },
            layout: { cumulativeShift: 0, shifts: 0, recent: [] },
            paint: { fcp: null, lcp: null, fid: null, inp: null, ttfb: null, fcpTime: null, lcpTime: null, fidTime: null, inpTime: null, ttfbTime: null },
            eventCost: { counts: new Map(), totals: new Map(), averages: new Map(), recent: [] },
            animationCost: { frames: 0, totalTime: 0, averageTime: 0, maxTime: 0, recent: [] },
            runtimeCost: { startupTime: 0, initTime: 0, totalOperations: 0, operationTimes: new Map() }
        };
    }

    const _state = {
        isRunning: false,
        isInitialized: false,
        startTime: 0,
        marks: new Map(),
        measurements: new Map(),
        metrics: createDefaultMetrics(),
        observers: [],
        frameCount: 0,
        lastFrameTime: 0,
        fpsInterval: 1000,
        maxSamples: 120,
        warningThresholds: {
            fpsLow: 30,
            fpsCritical: 15,
            memoryHigh: 80,
            memoryCritical: 95,
            longTaskWarning: 50,
            longTaskCritical: 100,
            clsWarning: 0.1,
            clsCritical: 0.25,
        },
        _fpsTimerId: null,
        _memoryTimerId: null,
        warnings: [],
        snapshots: [],
    };

    // [FIX 4] Track warning states to prevent spamming on every read
    const _warningState = {
        fps: null,
        memory: null,
        longTask: null,
        cls: null
    };

    function getEventEngine() {
        return global.Runtime?.EventEngine || global.EventEngine || null;
    }

    function emit(eventName, payload = {}) {
        const ee = getEventEngine();
        if (ee && typeof ee.emit === 'function') {
            ee.emit(`performance:${eventName}`, payload);
        } else if (typeof document !== 'undefined' && typeof CustomEvent !== 'undefined') {
            const event = new CustomEvent(`performance:${eventName}`, {
                detail: payload,
                bubbles: true,
            });
            document.dispatchEvent(event);
        }
    }

    function getScheduler() {
        return global.Runtime?.Scheduler || global.Scheduler || null;
    }

    function now() {
        return performance.now();
    }

    function formatBytes(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
        return (bytes / 1073741824).toFixed(1) + ' GB';
    }

    function getMemoryInfo() {
        // [FIX 8] performance.memory is Chromium-only. Firefox/Safari will return 0s.
        if (performance.memory) {
            const mem = performance.memory;
            return {
                usedJSHeapSize: mem.usedJSHeapSize || 0,
                totalJSHeapSize: mem.totalJSHeapSize || 0,
                jsHeapSizeLimit: mem.jsHeapSizeLimit || 0,
                usedPercent: mem.jsHeapSizeLimit > 0
                    ? (mem.usedJSHeapSize / mem.jsHeapSizeLimit) * 100
                    : 0,
            };
        }
        return {
            usedJSHeapSize: 0,
            totalJSHeapSize: 0,
            jsHeapSizeLimit: 0,
            usedPercent: 0,
        };
    }

    function addWarning(message, level = 'warning', data = {}) {
        const warning = {
            message,
            level,
            data,
            timestamp: Date.now(),
        };
        _state.warnings.push(warning);
        if (_state.warnings.length > 50) {
            _state.warnings.shift();
        }
        emit('warning', warning);
        
        if (level === 'critical') {
            logError(`[PerformanceEngine] CRITICAL: ${message}`, data);
        } else {
            warn(`[PerformanceEngine] ${message}`, data);
        }
    }

    function checkWarnings(metrics) {
        const { fps, memory, longTasks, layout } = metrics;

        // FPS
        let newFpsState = null;
        if (fps.current < _state.warningThresholds.fpsCritical) newFpsState = 'critical';
        else if (fps.current < _state.warningThresholds.fpsLow) newFpsState = 'warning';
        
        if (newFpsState !== _warningState.fps) {
            _warningState.fps = newFpsState;
            if (newFpsState === 'critical') addWarning(`FPS critically low: ${fps.current.toFixed(1)}`, 'critical', { fps: fps.current });
            else if (newFpsState === 'warning') addWarning(`FPS low: ${fps.current.toFixed(1)}`, 'warning', { fps: fps.current });
        }

        // Memory
        let newMemState = null;
        if (memory.usedPercent > _state.warningThresholds.memoryCritical) newMemState = 'critical';
        else if (memory.usedPercent > _state.warningThresholds.memoryHigh) newMemState = 'warning';
        
        if (newMemState !== _warningState.memory) {
            _warningState.memory = newMemState;
            if (newMemState === 'critical') addWarning(`Memory usage critical: ${memory.usedPercent.toFixed(1)}%`, 'critical', { used: formatBytes(memory.usedJSHeapSize), limit: formatBytes(memory.jsHeapSizeLimit) });
            else if (newMemState === 'warning') addWarning(`Memory usage high: ${memory.usedPercent.toFixed(1)}%`, 'warning', { used: formatBytes(memory.usedJSHeapSize), limit: formatBytes(memory.jsHeapSizeLimit) });
        }

        // Long Task
        if (longTasks.maxDuration > _state.warningThresholds.longTaskCritical && _warningState.longTask !== 'critical') {
            _warningState.longTask = 'critical';
            addWarning(`Long task critical: ${longTasks.maxDuration.toFixed(1)}ms`, 'critical', { maxDuration: longTasks.maxDuration, count: longTasks.count });
        } else if (longTasks.maxDuration > _state.warningThresholds.longTaskWarning && _warningState.longTask !== 'warning') {
            _warningState.longTask = 'warning';
            addWarning(`Long task: ${longTasks.maxDuration.toFixed(1)}ms`, 'warning', { maxDuration: longTasks.maxDuration, count: longTasks.count });
        }

        // CLS
        let newClsState = null;
        if (layout.cumulativeShift > _state.warningThresholds.clsCritical) newClsState = 'critical';
        else if (layout.cumulativeShift > _state.warningThresholds.clsWarning) newClsState = 'warning';
        
        if (newClsState !== _warningState.cls) {
            _warningState.cls = newClsState;
            if (newClsState === 'critical') addWarning(`CLS critical: ${layout.cumulativeShift.toFixed(3)}`, 'critical', { cls: layout.cumulativeShift });
            else if (newClsState === 'warning') addWarning(`CLS high: ${layout.cumulativeShift.toFixed(3)}`, 'warning', { cls: layout.cumulativeShift });
        }
    }

    // ---------- Sampling Functions ----------
    function sampleFPS() {
        if (!_state.isRunning) return;

        const nowTime = now();
        const delta = nowTime - _state.lastFrameTime;

        _state.frameCount++;

        if (delta >= _state.fpsInterval) {
            const fps = (_state.frameCount / delta) * 1000;
            const currentFPS = Math.round(Math.min(120, Math.max(0, fps)));

            _state.metrics.fps.samples.push(currentFPS);
            if (_state.metrics.fps.samples.length > _state.maxSamples) {
                _state.metrics.fps.samples.shift();
            }

            if (_state.metrics.fps.samples.length > 1) {
                _state.metrics.fps.min = Math.min(..._state.metrics.fps.samples);
                _state.metrics.fps.max = Math.max(..._state.metrics.fps.samples);
                _state.metrics.fps.average = _state.metrics.fps.samples.reduce((a, b) => a + b, 0) / _state.metrics.fps.samples.length;
            }
            _state.metrics.fps.current = currentFPS;

            if (currentFPS < 30) {
                _state.metrics.fps.drops++;
            }

            _state.metrics.fps.lastSampleTime = nowTime;
            
            // [FIX 2] CRITICAL: Only reset frameCount and lastFrameTime AFTER a sample is taken
            _state.frameCount = 0;
            _state.lastFrameTime = nowTime;

            emit('fps', {
                current: currentFPS,
                average: _state.metrics.fps.average,
                min: _state.metrics.fps.min,
                max: _state.metrics.fps.max,
                drops: _state.metrics.fps.drops,
                timestamp: Date.now(),
            });

            checkWarnings({ fps: _state.metrics.fps, memory: _state.metrics.memory, longTasks: _state.metrics.longTasks, layout: _state.metrics.layout });
        }
    }

    function sampleMemory() {
        if (!_state.isRunning) return;

        const mem = getMemoryInfo();
        _state.metrics.memory = {
            ...mem,
            samples: _state.metrics.memory.samples || [],
        };

        _state.metrics.memory.samples.push(mem.usedPercent);
        if (_state.metrics.memory.samples.length > _state.maxSamples) {
            _state.metrics.memory.samples.shift();
        }

        emit('memory', {
            used: mem.usedJSHeapSize,
            total: mem.totalJSHeapSize,
            limit: mem.jsHeapSizeLimit,
            usedPercent: mem.usedPercent,
            timestamp: Date.now(),
        });

        checkWarnings({ fps: _state.metrics.fps, memory: _state.metrics.memory, longTasks: _state.metrics.longTasks, layout: _state.metrics.layout });
    }

    // ---------- PerformanceObserver Setup ----------
    function setupObservers() {
        // [FIX 11] Guard against environments without PerformanceObserver
        if (typeof PerformanceObserver === 'undefined') return;

        // 1. Long Tasks
        try {
            const longTaskObserver = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    const duration = entry.duration || 0;
                    _state.metrics.longTasks.count++;
                    _state.metrics.longTasks.totalDuration += duration;
                    if (duration > _state.metrics.longTasks.maxDuration) {
                        _state.metrics.longTasks.maxDuration = duration;
                    }
                    _state.metrics.longTasks.recent.push({
                        duration,
                        startTime: entry.startTime,
                        name: entry.name,
                        timestamp: Date.now(),
                    });
                    if (_state.metrics.longTasks.recent.length > 20) {
                        _state.metrics.longTasks.recent.shift();
                    }

                    emit('longTask', { duration, name: entry.name, timestamp: Date.now() });
                    checkWarnings({ fps: _state.metrics.fps, memory: _state.metrics.memory, longTasks: _state.metrics.longTasks, layout: _state.metrics.layout });
                }
            });
            longTaskObserver.observe({ entryTypes: ['longtask'] });
            _state.observers.push(longTaskObserver);
        } catch (_) { /* not supported */ }

        // 2. Layout Shift (CLS)
        try {
            let clsValue = _state.metrics.layout.cumulativeShift; // Preserve existing CLS if restarting
            const layoutObserver = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    if (!entry.hadRecentInput) {
                        clsValue += entry.value || 0;
                        _state.metrics.layout.shifts++;
                        _state.metrics.layout.recent.push({
                            value: entry.value,
                            hadRecentInput: entry.hadRecentInput,
                            timestamp: Date.now(),
                        });
                        if (_state.metrics.layout.recent.length > 20) {
                            _state.metrics.layout.recent.shift();
                        }
                    }
                }
                _state.metrics.layout.cumulativeShift = clsValue;
                emit('layoutShift', { value: clsValue, timestamp: Date.now() });
                checkWarnings({ fps: _state.metrics.fps, memory: _state.metrics.memory, longTasks: _state.metrics.longTasks, layout: _state.metrics.layout });
            });
            layoutObserver.observe({ entryTypes: ['layout-shift'] });
            _state.observers.push(layoutObserver);
        } catch (_) { /* not supported */ }

        // 3. Paint (FCP) & LCP
        try {
            const paintObserver = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    if (entry.name === 'first-contentful-paint') {
                        _state.metrics.paint.fcp = entry.startTime;
                        _state.metrics.paint.fcpTime = Date.now();
                        emit('fcp', { value: entry.startTime, timestamp: Date.now() });
                    }
                    // [FIX 9] Removed dead LCP branch here; LCP is handled by its own observer below.
                }
            });
            paintObserver.observe({ entryTypes: ['paint'] });
            _state.observers.push(paintObserver);

            const lcpObserver = new PerformanceObserver((list) => {
                const entries = list.getEntries();
                const lastEntry = entries[entries.length - 1];
                if (lastEntry) {
                    _state.metrics.paint.lcp = lastEntry.startTime;
                    _state.metrics.paint.lcpTime = Date.now();
                    emit('lcp', { value: lastEntry.startTime, timestamp: Date.now() });
                }
            });
            lcpObserver.observe({ entryTypes: ['largest-contentful-paint'] });
            _state.observers.push(lcpObserver);
        } catch (_) { /* not supported */ }

        // 4. First Input Delay (FID) / Interaction to Next Paint (INP)
        try {
            const interactionObserver = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    if (entry.name === 'first-input' && !_state.metrics.paint.fid) {
                        _state.metrics.paint.fid = entry.processingStart - entry.startTime;
                        _state.metrics.paint.fidTime = Date.now();
                        emit('fid', { value: _state.metrics.paint.fid, timestamp: Date.now() });
                    }
                    const duration = entry.duration || 0;
                    if (!_state.metrics.paint.inp || duration > _state.metrics.paint.inp) {
                        _state.metrics.paint.inp = duration;
                        _state.metrics.paint.inpTime = Date.now();
                        emit('inp', { value: duration, timestamp: Date.now() });
                    }
                }
            });
            interactionObserver.observe({ entryTypes: ['first-input', 'event'] });
            _state.observers.push(interactionObserver);
        } catch (_) { /* not supported */ }

        // 5. Navigation (TTFB)
        try {
            const navObserver = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    if (entry.entryType === 'navigation') {
                        _state.metrics.paint.ttfb = entry.responseStart || 0;
                        _state.metrics.paint.ttfbTime = Date.now();
                        emit('ttfb', { value: _state.metrics.paint.ttfb, timestamp: Date.now() });
                    }
                }
            });
            navObserver.observe({ entryTypes: ['navigation'] });
            _state.observers.push(navObserver);
        } catch (_) { /* not supported */ }
    }

    // ---------- Public API ----------
    const PerformanceEngine = {

        init() {
            if (_state.isInitialized) return this;

            _state.startTime = now();
            _state.isInitialized = true;

            setupObservers();

            try {
                const perfEntries = performance.getEntriesByType('paint');
                for (const entry of perfEntries) {
                    if (entry.name === 'first-contentful-paint') {
                        _state.metrics.paint.fcp = entry.startTime;
                        _state.metrics.paint.fcpTime = Date.now();
                    }
                }
                const navEntries = performance.getEntriesByType('navigation');
                if (navEntries.length > 0) {
                    _state.metrics.paint.ttfb = navEntries[0].responseStart || 0;
                    _state.metrics.paint.ttfbTime = Date.now();
                }
            } catch (_) { /* ignore */ }

            try {
                const lcpEntries = performance.getEntriesByType('largest-contentful-paint');
                if (lcpEntries.length > 0) {
                    const last = lcpEntries[lcpEntries.length - 1];
                    _state.metrics.paint.lcp = last.startTime;
                    _state.metrics.paint.lcpTime = Date.now();
                }
            } catch (_) { /* ignore */ }

            emit('initialized', { timestamp: Date.now() });
            log('[PerformanceEngine] Initialized.');

            return this;
        },

        start() {
            if (_state.isRunning) return this;
            if (!_state.isInitialized) {
                this.init();
            }

            _state.isRunning = true;
            _state.lastFrameTime = now();
            _state.frameCount = 0;
            _state.metrics.fps.samples = [];
            _state.metrics.fps.drops = 0;

            const scheduler = getScheduler();

            if (scheduler && typeof scheduler.frame === 'function') {
                _state._fpsTimerId = scheduler.frame(() => {
                    if (!_state.isRunning) return;
                    sampleFPS();
                });
            } else {
                let frameId = null;
                const loop = () => {
                    if (!_state.isRunning) {
                        if (frameId) cancelAnimationFrame(frameId);
                        return;
                    }
                    sampleFPS();
                    frameId = requestAnimationFrame(loop);
                };
                loop();
                // [FIX 13] Fallback returns {cancel()} object, unlike Scheduler's number ID.
                _state._fpsTimerId = { cancel: () => { if (frameId) cancelAnimationFrame(frameId); } };
            }

            if (scheduler && typeof scheduler.every === 'function') {
                _state._memoryTimerId = scheduler.every(() => {
                    sampleMemory();
                }, 5000);
            } else {
                _state._memoryTimerId = setInterval(() => {
                    sampleMemory();
                }, 5000);
            }

            sampleMemory();

            // [FIX 3] Recreate observers (they were disconnected on previous stop())
            setupObservers();

            emit('started', { timestamp: Date.now() });
            log('[PerformanceEngine] Started monitoring.');

            return this;
        },

        stop() {
            if (!_state.isRunning) return this;

            _state.isRunning = false;

            // [FIX 1] Clean up FPS timer properly
            if (_state._fpsTimerId) {
                if (typeof _state._fpsTimerId === 'object' && typeof _state._fpsTimerId.cancel === 'function') {
                    _state._fpsTimerId.cancel();
                } else if (typeof _state._fpsTimerId === 'number') {
                    const scheduler = getScheduler();
                    if (scheduler && typeof scheduler.cancel === 'function') {
                        scheduler.cancel(_state._fpsTimerId);
                    }
                }
                _state._fpsTimerId = null;
            }

            if (_state._memoryTimerId) {
                const scheduler = getScheduler();
                if (scheduler && typeof scheduler.cancel === 'function') {
                    scheduler.cancel(_state._memoryTimerId);
                } else {
                    clearInterval(_state._memoryTimerId);
                }
                _state._memoryTimerId = null;
            }

            for (const observer of _state.observers) {
                try {
                    observer.disconnect();
                } catch (_) { /* ignore */ }
            }
            _state.observers = [];

            emit('stopped', { timestamp: Date.now() });
            log('[PerformanceEngine] Stopped monitoring.');

            return this;
        },

        destroy() {
            this.stop();
            _state.isInitialized = false;
            
            // [FIX 5] Use factory to reset metrics
            _state.metrics = createDefaultMetrics();
            _state.warnings = [];
            _state.snapshots = [];
            
            // Reset warning state to prevent stale thresholds
            _warningState.fps = null;
            _warningState.memory = null;
            _warningState.longTask = null;
            _warningState.cls = null;

            emit('destroyed', { timestamp: Date.now() });
            log('[PerformanceEngine] Destroyed.');

            return this;
        },

        snapshot(label = '') {
            // [FIX 14] Note: This copies all arrays. Do not call on a tight loop.
            const data = this.getMetrics();
            const snapshot = {
                label,
                timestamp: Date.now(),
                metrics: data,
                warnings: [..._state.warnings],
            };
            _state.snapshots.push(snapshot);
            if (_state.snapshots.length > 50) {
                _state.snapshots.shift();
            }
            emit('snapshot', { label, timestamp: Date.now() });
            return snapshot;
        },

        getMetrics() {
            const metrics = {
                fps: { ..._state.metrics.fps },
                memory: { ..._state.metrics.memory },
                longTasks: {
                    count: _state.metrics.longTasks.count,
                    totalDuration: _state.metrics.longTasks.totalDuration,
                    maxDuration: _state.metrics.longTasks.maxDuration,
                    recent: [..._state.metrics.longTasks.recent],
                },
                layout: {
                    cumulativeShift: _state.metrics.layout.cumulativeShift,
                    shifts: _state.metrics.layout.shifts,
                    recent: [..._state.metrics.layout.recent],
                },
                paint: { ..._state.metrics.paint },
                eventCost: {
                    counts: Object.fromEntries(_state.metrics.eventCost.counts),
                    totals: Object.fromEntries(_state.metrics.eventCost.totals),
                    averages: Object.fromEntries(_state.metrics.eventCost.averages),
                    recent: [..._state.metrics.eventCost.recent],
                },
                animationCost: {
                    frames: _state.metrics.animationCost.frames,
                    totalTime: _state.metrics.animationCost.totalTime,
                    averageTime: _state.metrics.animationCost.averageTime,
                    maxTime: _state.metrics.animationCost.maxTime,
                    recent: [..._state.metrics.animationCost.recent],
                },
                runtimeCost: {
                    startupTime: _state.metrics.runtimeCost.startupTime,
                    initTime: _state.metrics.runtimeCost.initTime,
                    totalOperations: _state.metrics.runtimeCost.totalOperations,
                    operationTimes: Object.fromEntries(_state.metrics.runtimeCost.operationTimes),
                },
                warnings: [..._state.warnings],
                uptime: now() - _state.startTime,
                isRunning: _state.isRunning,
                isInitialized: _state.isInitialized,
                timestamp: Date.now(),
            };

            // [FIX 4] Removed checkWarnings() from here to prevent spam on every read.

            return metrics;
        },

        getCoreWebVitals() {
            return {
                LCP: _state.metrics.paint.lcp,
                FID: _state.metrics.paint.fid,
                CLS: _state.metrics.layout.cumulativeShift,
                INP: _state.metrics.paint.inp,
                TTFB: _state.metrics.paint.ttfb,
                timestamp: Date.now(),
            };
        },

        mark(name) {
            const time = now();
            _state.marks.set(name, time);
            // [FIX 10] Wrap in try/catch for consistency
            try {
                performance.mark(name);
            } catch (_) { /* ignore */ }
            emit('mark', { name, time });
        },

        measure(name, startMark, endMark = null, metadata = {}) {
            const start = _state.marks.get(startMark);
            if (start === undefined) {
                warn(`[PerformanceEngine] measure: start mark "${startMark}" not found`);
                return 0;
            }
            const end = endMark ? _state.marks.get(endMark) : now();
            if (endMark && end === undefined) {
                warn(`[PerformanceEngine] measure: end mark "${endMark}" not found`);
                return 0;
            }
            const duration = end - start;

            _state.measurements.set(name, {
                duration,
                start,
                end,
                metadata,
                timestamp: Date.now(),
            });

            try {
                if (endMark) {
                    performance.measure(name, startMark, endMark);
                } else {
                    performance.measure(name, startMark);
                }
            } catch (_) { /* ignore */ }

            emit('measure', { name, duration, metadata, timestamp: Date.now() });
            return duration;
        },

        clear(name) {
            if (name) {
                _state.marks.delete(name);
                _state.measurements.delete(name);
                try {
                    performance.clearMarks(name);
                    performance.clearMeasures(name);
                } catch (_) { /* ignore */ }
            } else {
                _state.marks.clear();
                _state.measurements.clear();
                try {
                    performance.clearMarks();
                    performance.clearMeasures();
                } catch (_) { /* ignore */ }
            }
            emit('cleared', { name: name || 'all' });
        },

        getMarks() {
            return Object.fromEntries(_state.marks);
        },

        getMeasurements() {
            return Object.fromEntries(_state.measurements);
        },

        getWarnings() {
            return [..._state.warnings];
        },

        clearWarnings() {
            _state.warnings = [];
            emit('warningsCleared');
        },

        getSnapshots(limit = 10) {
            return _state.snapshots.slice(-limit);
        },

        trackEvent(eventName, duration) {
            const counts = _state.metrics.eventCost.counts;
            const totals = _state.metrics.eventCost.totals;
            const averages = _state.metrics.eventCost.averages;

            counts.set(eventName, (counts.get(eventName) || 0) + 1);
            totals.set(eventName, (totals.get(eventName) || 0) + duration);

            const count = counts.get(eventName) || 1;
            const total = totals.get(eventName) || duration;
            averages.set(eventName, total / count);

            _state.metrics.eventCost.recent.push({ eventName, duration, timestamp: Date.now() });
            if (_state.metrics.eventCost.recent.length > 100) {
                _state.metrics.eventCost.recent.shift();
            }

            if (duration > 50) {
                emit('expensiveEvent', { eventName, duration, timestamp: Date.now() });
                if (duration > 100) {
                    addWarning(`Expensive event: ${eventName} took ${duration.toFixed(1)}ms`, 'warning', {
                        eventName,
                        duration,
                    });
                }
            }
        },

        trackAnimationFrame(duration) {
            const metrics = _state.metrics.animationCost;
            metrics.frames++;
            metrics.totalTime += duration;
            metrics.averageTime = metrics.totalTime / metrics.frames;
            if (duration > metrics.maxTime) {
                metrics.maxTime = duration;
            }
            metrics.recent.push({ duration, timestamp: Date.now() });
            if (metrics.recent.length > 60) {
                metrics.recent.shift();
            }

            if (duration > 16.67) {
                emit('slowFrame', { duration, timestamp: Date.now() });
                if (duration > 33.33) {
                    addWarning(`Slow frame: ${duration.toFixed(1)}ms (${(1000/duration).toFixed(1)}fps)`, 'warning', {
                        duration,
                    });
                }
            }
        },

        trackRuntimeOperation(operationName, duration) {
            const metrics = _state.metrics.runtimeCost;
            metrics.totalOperations++;

            const opTimes = metrics.operationTimes;
            const current = opTimes.get(operationName) || { count: 0, total: 0 };
            current.count++;
            current.total += duration;
            opTimes.set(operationName, current);

            if (duration > 10) {
                emit('expensiveOperation', { operationName, duration, timestamp: Date.now() });
            }
        },

        markStartupComplete(label = '') {
            const duration = now() - _state.startTime;
            _state.metrics.runtimeCost.startupTime = duration;
            _state.metrics.runtimeCost.initTime = Date.now();
            emit('startupComplete', { duration, label, timestamp: Date.now() });
            log(`[PerformanceEngine] Startup complete in ${duration.toFixed(1)}ms${label ? ' (' + label + ')' : ''}`);
            return duration;
        },

        diagnostics() {
            return {
                initialized: _state.isInitialized,
                running: _state.isRunning,
                startTime: _state.startTime,
                uptime: now() - _state.startTime,
                observers: _state.observers.length,
                marks: _state.marks.size,
                measurements: _state.measurements.size,
                warnings: _state.warnings.length,
                snapshots: _state.snapshots.length,
                metrics: this.getMetrics(),
                coreWebVitals: this.getCoreWebVitals(),
                timestamp: Date.now(),
            };
        },
    };

    // ---------- Expose to Global ----------
    global.PerformanceEngine = PerformanceEngine;

    // [FIX 12] Load-order dependency: Only attaches if Runtime already exists.
    if (global.Runtime) {
        global.Runtime.PerformanceEngine = PerformanceEngine;
    }

    log('[PerformanceEngine] Loaded and ready. Call PerformanceEngine.init() and start() to begin.');

})(typeof window !== 'undefined' ? window : this);
