// ================================================================
// SCHEDULER.JS — Global Timing Coordinator
// ================================================================
// File: js/runtime/scheduler.js
// Responsibilities: Timers, intervals, animation frames, debounce,
// throttle, cancellation, pause/resume, auto-cleanup.
// Does NOT know Hero, Runtime Bridge, Theme, Portrait, or Sections.
//
// SURGICAL FIX PASS — see contract doc for full change list. Summary:
//  [FIX 1]  Memory leak: completed tasks now always removed from _tasks.
//  [FIX 2]  Pause now truly freezes timers (clearTimeout/cancelAnimationFrame)
//           instead of endlessly rescheduling while suppressed.
//  [FIX 3]  Resume now restores the *remaining* delay instead of restarting
//           the full delay/interval from zero.
//  [FIX 4]  debounce({leading:true}) now fires once per burst, not on every call.
//  [FIX 5]  throttle({leading:false}) no longer fires on the very first call.
//  [FIX 6/7] Dead duplicate debounce/throttle implementations removed.
//  [FIX 8]  Task lifecycle made consistent: a task ends in exactly one
//           terminal state ('completed' or 'cancelled'), never both.
//  [FIX 9]  `priority` field removed (was stored, never used anywhere).
//  [FIX 10] `immediate` handling consolidated into Task, no longer
//           duplicated across after()/every().
//  [FIX 11] Unused getStateEngine() removed.
//  [FIX 12] Guards added around window/document/requestAnimationFrame/
//           CustomEvent for non-browser environments.
//  [FIX 13] destroy() is now terminal by default; init() will not silently
//           resurrect a destroyed scheduler unless called with {force:true}.
//  [FIX 14] All console logging gated behind Runtime?.config?.debug.
//  [FIX 15] Runtime.Scheduler attachment unchanged in behavior (load-order
//           dependency documented, not silently "fixed" — see note below).
//
// NOT changed (deliberate, see contract discussion):
//  - Auto-init at bottom of file is KEPT. Runtime.init() follows the same
//    self-initializing pattern per the IDPORT contract doc, so this stays
//    consistent with the rest of the codebase rather than diverging from it.
// ================================================================

(function(global) {
    'use strict';

    const hasWindow = typeof window !== 'undefined';
    const hasDocument = typeof document !== 'undefined';
    const hasRAF = hasWindow && typeof requestAnimationFrame === 'function';
    const hasCustomEvent = typeof CustomEvent !== 'undefined';

    // ---------- Private State ----------
    const _tasks = new Map();           // taskId -> Task
    let _taskIdCounter = 0;
    let _paused = false;
    let _destroyed = false;
    let _isInitialized = false;

    // ---------- Private Helpers ----------
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
        // Errors are surfaced regardless of debug flag — they indicate a
        // real problem in caller code, not internal scheduler chatter.
        console.error(...args);
    }

    function getEventEngine() {
        return (global.Runtime && global.Runtime.EventEngine) || global.EventEngine || null;
    }

    function emit(eventName, payload = {}) {
        const ee = getEventEngine();
        if (ee && typeof ee.emit === 'function') {
            ee.emit(`scheduler:${eventName}`, payload);
            return;
        }
        // Fallback to DOM event for compatibility — only if a DOM is present.
        if (hasDocument && hasCustomEvent) {
            const event = new CustomEvent(`scheduler:${eventName}`, {
                detail: payload,
                bubbles: true,
            });
            document.dispatchEvent(event);
        }
    }

    // [FIX 1/8] Central removal path. This is the ONLY place a task should
    // ever be stripped from _tasks — used by both natural completion and
    // explicit cancellation, so nothing can complete without being cleaned up.
    function removeTask(id) {
        return _tasks.delete(id);
    }

    // ---------- Task Class ----------
    class Task {
        constructor({ id, callback, delay, interval, repeat, type, context, immediate }) {
            this.id = id;
            this.callback = callback;
            this.delay = delay;
            this.interval = interval || delay;
            this.repeat = repeat || false;
            this.type = type || 'timeout';      // 'timeout' | 'interval' | 'animation'
            this.context = context || null;
            this.immediate = immediate || false;
            this.state = 'pending';              // 'pending' | 'running' | 'completed' | 'cancelled'
            this.createdAt = Date.now();
            this.scheduledTime = null;
            this.timerId = null;
            this.frameId = null;
            this.executionCount = 0;
            this.lastExecuted = null;
            this.cancelled = false;

            // [FIX 3] Remaining-time bookkeeping for pause/resume.
            this._remaining = this.type === 'interval' ? this.interval : this.delay;
            this._runStartedAt = null; // when the current timer leg started

            // [FIX 10] immediate is now handled entirely inside the Task.
            if (this.immediate) {
                this._scheduleImmediate();
            } else {
                this._scheduleNext();
            }
        }

        _scheduleImmediate() {
            if (this.cancelled || _destroyed) return;
            // Defer one tick so the caller receives the task id first.
            this.timerId = setTimeout(() => {
                if (!this.cancelled) this.execute();
            }, 0);
            this._runStartedAt = Date.now();
            this.scheduledTime = Date.now();
            this.state = 'pending';
        }

        // Unified "schedule the next leg" — replaces the old
        // _scheduleTimeout / _scheduleInterval / _scheduleFrame trio being
        // called ad-hoc from multiple places.
        _scheduleNext(customDelay) {
            if (this.cancelled || _destroyed || _paused) return;

            if (this.type === 'animation') {
                if (!hasRAF) return;
                this.frameId = requestAnimationFrame(() => this.execute());
                this._runStartedAt = Date.now();
                this.scheduledTime = Date.now();
                this.state = 'pending';
                return;
            }

            const wait = customDelay != null ? customDelay : this._remaining;
            this.timerId = setTimeout(() => this.execute(), Math.max(0, wait));
            this._runStartedAt = Date.now();
            this.scheduledTime = Date.now();
            this.state = 'pending';
        }

        // [FIX 2] Freeze: actually clear the live timer/frame rather than
        // letting it fire and reschedule itself while suppressed.
        _freeze() {
            if (this.type !== 'animation') {
                // Track how much time was left on the current leg.
                if (this._runStartedAt != null) {
                    const elapsed = Date.now() - this._runStartedAt;
                    const base = this.type === 'interval' ? this.interval : this.delay;
                    this._remaining = Math.max(0, (this._remaining != null ? this._remaining : base) - elapsed);
                }
                if (this.timerId !== null) {
                    clearTimeout(this.timerId);
                    this.timerId = null;
                }
            } else if (this.frameId !== null) {
                if (hasRAF) cancelAnimationFrame(this.frameId);
                this.frameId = null;
            }
            this._runStartedAt = null;
        }

        // [FIX 3] Thaw: resume using whatever remaining time was preserved.
        _thaw() {
            if (this.cancelled || _destroyed) return;
            if (this.type === 'animation') {
                this._scheduleNext();
                return;
            }
            this._scheduleNext(this._remaining);
        }

        // Execute the task. Only ever invoked by a live timer/frame, which
        // per [FIX 2] cannot exist while _paused, so no paused-check needed
        // here anymore — the freeze/thaw pair owns that responsibility.
        execute() {
            if (this.cancelled || _destroyed) return;

            this.state = 'running';
            this.executionCount++;
            this.lastExecuted = Date.now();
            this.timerId = null;
            this.frameId = null;

            try {
                this.callback.call(this.context, { taskId: this.id, count: this.executionCount });
            } catch (err) {
                logError(`[Scheduler] Task ${this.id} error:`, err);
                emit('taskError', { taskId: this.id, error: err.message });
            }

            // [FIX 8] A task reaches exactly one terminal state. One-shot
            // timeouts complete and are removed — they never pass through
            // 'cancelled' on the way out.
            if (this.type === 'timeout' && !this.repeat) {
                this.state = 'completed';
                removeTask(this.id);
                emit('taskCompleted', { id: this.id });
                return;
            }

            // Recurring tasks: reset remaining window and reschedule.
            if (this.type === 'interval' || this.repeat) {
                this._remaining = this.interval || this.delay || 1000;
                if (!this.cancelled) this._scheduleNext();
            } else if (this.type === 'animation') {
                if (!this.cancelled) this._scheduleNext();
            }
        }

        // Explicit cancellation — the only path that produces 'cancelled'.
        cancel() {
            if (this.cancelled) return;
            this.cancelled = true;
            this.state = 'cancelled';
            if (this.timerId !== null) {
                clearTimeout(this.timerId);
                this.timerId = null;
            }
            if (this.frameId !== null) {
                if (hasRAF) cancelAnimationFrame(this.frameId);
                this.frameId = null;
            }
        }
    }

    // ---------- Public API ----------
    const Scheduler = {

        /**
         * Initialize the scheduler.
         * [FIX 13] Will not silently resurrect a destroyed scheduler unless
         * explicitly told to via { force: true }.
         */
        init(options = {}) {
            if (_isInitialized && !_destroyed) return this;
            if (_destroyed && !options.force) {
                warn('[Scheduler] init() called after destroy() — pass { force: true } to intentionally revive.');
                return this;
            }
            _isInitialized = true;
            _destroyed = false;
            _paused = false;
            _tasks.clear();
            _taskIdCounter = 0;

            emit('initialized');
            log('[Scheduler] Initialized.');
            return this;
        },

        after(callback, delay, options = {}) {
            if (_destroyed) {
                warn('[Scheduler] Cannot schedule after destroy.');
                return -1;
            }
            if (typeof callback !== 'function') {
                warn('[Scheduler] after: callback must be a function');
                return -1;
            }
            const id = ++_taskIdCounter;
            const task = new Task({
                id,
                callback,
                delay: Math.max(0, delay),
                type: 'timeout',
                repeat: false,
                context: options.context || null,
                immediate: options.immediate || false,
            });
            _tasks.set(id, task);

            emit('taskAdded', { id, type: 'timeout', delay });
            return id;
        },

        every(callback, interval, options = {}) {
            if (_destroyed) {
                warn('[Scheduler] Cannot schedule after destroy.');
                return -1;
            }
            if (typeof callback !== 'function') {
                warn('[Scheduler] every: callback must be a function');
                return -1;
            }
            const id = ++_taskIdCounter;
            const task = new Task({
                id,
                callback,
                delay: Math.max(0, interval),
                interval: Math.max(0, interval),
                type: 'interval',
                repeat: true,
                context: options.context || null,
                immediate: options.immediate || false,
            });
            _tasks.set(id, task);

            emit('taskAdded', { id, type: 'interval', interval });
            return id;
        },

        frame(callback, options = {}) {
            if (_destroyed) {
                warn('[Scheduler] Cannot schedule after destroy.');
                return -1;
            }
            if (typeof callback !== 'function') {
                warn('[Scheduler] frame: callback must be a function');
                return -1;
            }
            if (!hasRAF) {
                warn('[Scheduler] frame: requestAnimationFrame unavailable in this environment.');
                return -1;
            }
            const id = ++_taskIdCounter;
            const task = new Task({
                id,
                callback,
                type: 'animation',
                repeat: true,
                context: options.context || null,
            });
            _tasks.set(id, task);

            emit('taskAdded', { id, type: 'animation' });
            return id;
        },

        cancel(taskId) {
            const task = _tasks.get(taskId);
            if (!task) return false;
            if (task.cancelled) return false;
            task.cancel();
            removeTask(taskId);
            emit('taskCancelled', { id: taskId });
            return true;
        },

        cancelAll() {
            const count = _tasks.size;
            for (const [, task] of _tasks) {
                task.cancel();
            }
            _tasks.clear();
            emit('allCancelled', { count });
            log(`[Scheduler] Cancelled ${count} tasks.`);
            return count;
        },

        // [FIX 2/3] Pause now actually freezes every live task's timer and
        // remembers how much time was left, instead of letting timers keep
        // firing and rescheduling themselves while suppressed.
        pause() {
            if (_paused) return;
            _paused = true;
            for (const [, task] of _tasks) {
                task._freeze();
            }
            emit('paused');
            log('[Scheduler] Paused.');
        },

        // [FIX 3] Resume restarts each task with its preserved remaining
        // time rather than the full original delay/interval.
        resume() {
            if (!_paused) return;
            _paused = false;
            for (const [, task] of _tasks) {
                task._thaw();
            }
            emit('resumed');
            log('[Scheduler] Resumed.');
        },

        isPaused() {
            return _paused;
        },

        isDestroyed() {
            return _destroyed;
        },

        /**
         * Destroy the scheduler, cancelling all tasks.
         * [FIX 13] Terminal by default — see init({force:true}) to revive.
         */
        destroy() {
            if (_destroyed) return;
            _destroyed = true;
            this.cancelAll();
            _paused = false;
            _isInitialized = false;
            emit('destroyed');
            log('[Scheduler] Destroyed.');
        },

        // -------- Debounce & Throttle --------
        // [FIX 6] Dead first-draft implementations removed — only one
        // implementation exists now, and it's the one actually returned.
        // [FIX 4] leading-edge now fires exactly once per burst.
        debounce(callback, delay, options = {}) {
            if (typeof callback !== 'function') {
                warn('[Scheduler] debounce: callback must be a function');
                return () => {};
            }
            const { leading = false, context = null, maxWait = null } = options;
            const self = this;
            let taskId = null;
            let maxTimerId = null;
            let hasLeadingFired = false;

            return function(...args) {
                const callCtx = context || this;

                const runNow = () => {
                    taskId = null;
                    if (maxTimerId !== null) {
                        self.cancel(maxTimerId);
                        maxTimerId = null;
                    }
                    hasLeadingFired = false;
                    callback.apply(callCtx, args);
                };

                // [FIX 4] Only fire immediately if this is the START of a
                // new burst (no pending trailing timer yet).
                if (leading && taskId === null && !hasLeadingFired) {
                    hasLeadingFired = true;
                    callback.apply(callCtx, args);
                    // Still arm a timer so the burst-suppression window
                    // is respected for subsequent rapid calls.
                    taskId = self.after(() => {
                        taskId = null;
                        hasLeadingFired = false;
                    }, delay, { context: callCtx });
                    return;
                }

                if (taskId !== null) {
                    self.cancel(taskId);
                }
                taskId = self.after(runNow, delay, { context: callCtx });

                if (maxWait != null && maxWait > 0 && maxTimerId === null) {
                    maxTimerId = self.after(() => {
                        if (taskId !== null) {
                            self.cancel(taskId);
                            taskId = null;
                        }
                        maxTimerId = null;
                        hasLeadingFired = false;
                        callback.apply(callCtx, args);
                    }, maxWait, { context: callCtx });
                }
            };
        },

        // [FIX 5] leading:false no longer fires on the very first call —
        // lastRun starts as null (not 0) so "no prior run yet" is distinct
        // from "enough time has passed since run at t=0".
        throttle(callback, delay, options = {}) {
            if (typeof callback !== 'function') {
                warn('[Scheduler] throttle: callback must be a function');
                return () => {};
            }
            const { leading = true, trailing = true, context = null } = options;
            const self = this;
            let taskId = null;
            let lastRun = null;
            let pendingArgs = null;

            return function(...args) {
                const callCtx = context || this;
                const now = Date.now();

                const runTrailing = () => {
                    lastRun = Date.now();
                    taskId = null;
                    const finalArgs = pendingArgs || args;
                    pendingArgs = null;
                    callback.apply(callCtx, finalArgs);
                };

                if (lastRun === null) {
                    // Very first call ever.
                    if (leading) {
                        lastRun = now;
                        callback.apply(callCtx, args);
                        return;
                    }
                    // leading:false — treat this as the start of the window
                    // without executing yet.
                    lastRun = now;
                    if (trailing) {
                        pendingArgs = args;
                        if (taskId === null) {
                            taskId = self.after(runTrailing, delay, { context: callCtx });
                        }
                    }
                    return;
                }

                const elapsed = now - lastRun;
                if (elapsed >= delay) {
                    if (taskId !== null) {
                        self.cancel(taskId);
                        taskId = null;
                    }
                    lastRun = now;
                    callback.apply(callCtx, args);
                    return;
                }

                if (trailing) {
                    pendingArgs = args;
                    if (taskId === null) {
                        taskId = self.after(runTrailing, delay - elapsed, { context: callCtx });
                    }
                }
            };
        },

        // -------- Diagnostics --------
        diagnostics() {
            const tasks = [];
            let totalPending = 0;
            let totalRunning = 0;
            let totalCompleted = 0;
            let totalCancelled = 0;

            for (const [, task] of _tasks) {
                tasks.push({
                    id: task.id,
                    type: task.type,
                    state: task.state,
                    repeat: task.repeat,
                    executionCount: task.executionCount,
                    lastExecuted: task.lastExecuted,
                    createdAt: task.createdAt,
                    scheduledTime: task.scheduledTime,
                    delay: task.delay,
                    interval: task.interval,
                    remaining: task._remaining,
                });

                switch (task.state) {
                    case 'pending': totalPending++; break;
                    case 'running': totalRunning++; break;
                    case 'completed': totalCompleted++; break;
                    case 'cancelled': totalCancelled++; break;
                }
            }

            return {
                initialized: _isInitialized,
                destroyed: _destroyed,
                paused: _paused,
                totalTasks: _tasks.size,
                counts: {
                    pending: totalPending,
                    running: totalRunning,
                    completed: totalCompleted,
                    cancelled: totalCancelled,
                },
                tasks,
                timestamp: Date.now(),
            };
        },

        summary() {
            const s = { timeout: 0, interval: 0, animation: 0 };
            for (const [, task] of _tasks) {
                if (task.type === 'timeout') s.timeout++;
                else if (task.type === 'interval') s.interval++;
                else if (task.type === 'animation') s.animation++;
            }
            return s;
        },
    };

    // ---------- Expose to Global ----------
    global.Scheduler = Scheduler;

    // [FIX 15 — noted, not silently patched] This attachment only runs if
    // global.Runtime already exists at the moment this script executes. If
    // Scheduler loads before Runtime, this line does nothing and no warning
    // fires. Load order between scheduler.js and runtime.js must be
    // guaranteed by the page/bundler; consider having Runtime pull in
    // Scheduler itself if that order can't be guaranteed.
    if (global.Runtime) {
        global.Runtime.Scheduler = Scheduler;
    }

    // Auto-init on load — kept intentionally; matches Runtime.init()'s own
    // documented self-initializing pattern (see IDPORT contract doc §6).
    Scheduler.init();

    log('[Scheduler] Loaded and ready.');

})(typeof window !== 'undefined' ? window : this);
