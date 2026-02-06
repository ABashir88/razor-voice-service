import { EventEmitter } from 'events';
import {
  States,
  StateTimeouts,
  TimeoutTargets,
  TransitionMap,
  defaultContext,
  HISTORY_BUFFER_SIZE,
} from './stateConfig.js';

// ─────────────────────────────────────────────────────────────
// stateMachine.js — Razor's observable, guarded state machine
// ─────────────────────────────────────────────────────────────

export class RazorStateMachine extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} [opts.initialState]     Override starting state
   * @param {object} [opts.context]          Seed context (merged w/ defaults)
   * @param {object} [opts.timeoutOverrides] Per-state timeout overrides (ms)
   * @param {boolean} [opts.verbose]         Log transitions to stdout
   */
  constructor(opts = {}) {
    super();
    this.setMaxListeners(50);

    this._state          = opts.initialState || States.IDLE;
    this._context        = { ...defaultContext(), ...(opts.context || {}) };
    this._stateEnteredAt = Date.now();

    this._timeoutOverrides = { ...(opts.timeoutOverrides || {}) };
    this._verbose          = opts.verbose ?? false;

    this._guards     = new Map(); // "FROM→TO" → Function[]
    this._enterHooks = new Map(); // state → callback[]
    this._exitHooks  = new Map(); // state → callback[]

    this._history     = [];
    this._historySize = HISTORY_BUFFER_SIZE;

    this._timeoutHandle = null;
    this._transitioning = false;

    this._armTimeout();
  }

  // ═══════════════════════════════════════════════════════════
  //  PUBLIC API
  // ═══════════════════════════════════════════════════════════

  /**
   * Request a state transition.
   *
   * @param  {string} target     Target state (use States enum)
   * @param  {string} trigger    What caused this ('wake_word', 'stt_complete', …)
   * @param  {object} [metadata] Payload attached to this transition
   * @returns {{ ok: boolean, error?: string }}
   */
  transition(target, trigger, metadata = {}) {
    if (!States[target]) {
      return this._reject(`Unknown state: "${target}"`);
    }
    if (this._state === target) {
      return this._reject(`Already in ${target}`);
    }
    if (this._transitioning) {
      return this._reject(`Transition already in progress (→ ${target})`);
    }

    // ── Check transition map ──────────────────────────────────
    const allowed = TransitionMap[this._state];
    if (!allowed || !allowed.has(target)) {
      return this._reject(`Illegal transition: ${this._state} → ${target}`);
    }

    // ── Run guard functions ───────────────────────────────────
    const guardKey = `${this._state}→${target}`;
    const guards = this._guards.get(guardKey) || [];
    for (const guard of guards) {
      try {
        if (!guard(this._context, metadata)) {
          return this._reject(`Guard blocked ${this._state} → ${target}`);
        }
      } catch (err) {
        return this._reject(`Guard threw for ${guardKey}: ${err.message}`);
      }
    }

    // ── Execute ───────────────────────────────────────────────
    this._transitioning = true;
    const from      = this._state;
    const timestamp = Date.now();
    const duration  = timestamp - this._stateEnteredAt;

    this._clearTimeout();

    // Exit hooks for the state we're leaving
    this._fireHooks(this._exitHooks, from, { target, trigger, metadata });

    // Commit
    this._state          = target;
    this._stateEnteredAt = timestamp;

    // Merge contextUpdate if present
    if (metadata.contextUpdate && typeof metadata.contextUpdate === 'object') {
      Object.assign(this._context, metadata.contextUpdate);
    }

    const record = Object.freeze({
      from,
      to: target,
      trigger,
      timestamp,
      durationInPrevState: duration,
      metadata: Object.freeze({ ...metadata }),
    });

    // History ring buffer
    this._history.push(record);
    if (this._history.length > this._historySize) {
      this._history.shift();
    }

    // Events
    this.emit('transition', record);
    this.emit(`enter:${target}`, record);
    this.emit(`exit:${from}`, record);

    // Enter hooks for the new state
    this._fireHooks(this._enterHooks, target, { from, trigger, metadata });

    if (this._verbose) {
      const ts = new Date(timestamp).toISOString();
      console.log(
        `[Razor SM] ${ts}  ${from} → ${target}  (${trigger})  ${duration}ms in prev`
      );
    }

    this._armTimeout();
    this._transitioning = false;
    return { ok: true };
  }

  /** Current state + full context snapshot (frozen copy). */
  getState() {
    return Object.freeze({
      state:     this._state,
      context:   { ...this._context },
      enteredAt: this._stateEnteredAt,
      elapsed:   Date.now() - this._stateEnteredAt,
    });
  }

  /**
   * Is a transition to `target` legal from the current state?
   * Checks adjacency map only — does NOT evaluate guards.
   */
  canTransition(target) {
    const allowed = TransitionMap[this._state];
    return !!(allowed && allowed.has(target));
  }

  /**
   * Register a callback to fire when entering a specific state.
   * @returns {function} unsubscribe
   */
  onEnter(state, cb) {
    return this._addHook(this._enterHooks, state, cb);
  }

  /**
   * Register a callback to fire when exiting a specific state.
   * @returns {function} unsubscribe
   */
  onExit(state, cb) {
    return this._addHook(this._exitHooks, state, cb);
  }

  /** Last `n` transition records (or all if omitted). */
  getHistory(n) {
    if (n === undefined) return [...this._history];
    return this._history.slice(-n);
  }

  /**
   * Patch context without changing state.
   * Emits 'context:updated'.
   */
  updateContext(patch) {
    Object.assign(this._context, patch);
    this.emit('context:updated', {
      state:     this._state,
      context:   { ...this._context },
      timestamp: Date.now(),
    });
  }

  /**
   * Register a guard for a specific FROM→TO edge.
   * Guard: (context, metadata) → boolean. Must return true to allow.
   * @returns {function} unregister
   */
  addGuard(from, to, guardFn) {
    const key = `${from}→${to}`;
    if (!this._guards.has(key)) this._guards.set(key, []);
    this._guards.get(key).push(guardFn);
    return () => {
      const arr = this._guards.get(key);
      if (arr) {
        const idx = arr.indexOf(guardFn);
        if (idx !== -1) arr.splice(idx, 1);
      }
    };
  }

  /** Override a state's timeout at runtime. Pass null to disable. */
  setTimeoutOverride(state, ms) {
    this._timeoutOverrides[state] = ms;
    if (this._state === state) {
      this._clearTimeout();
      this._armTimeout();
    }
  }

  /** Emergency reset — bypasses guards and map. Returns to IDLE. */
  forceReset() {
    this._clearTimeout();
    const from = this._state;
    this._state          = States.IDLE;
    this._context        = defaultContext();
    this._stateEnteredAt = Date.now();
    this._transitioning  = false;

    const record = Object.freeze({
      from,
      to:                  States.IDLE,
      trigger:             'force_reset',
      timestamp:           this._stateEnteredAt,
      durationInPrevState: 0,
      metadata:            Object.freeze({ forced: true }),
    });
    this._history.push(record);
    if (this._history.length > this._historySize) this._history.shift();
    this.emit('transition', record);
    this.emit('reset', record);
    this._armTimeout();

    if (this._verbose) {
      console.log(`[Razor SM] ⚠ FORCE RESET from ${from}`);
    }
  }

  /** Clean shutdown — clears timers and all listeners. */
  destroy() {
    this._clearTimeout();
    this.removeAllListeners();
    this._guards.clear();
    this._enterHooks.clear();
    this._exitHooks.clear();
  }

  // ═══════════════════════════════════════════════════════════
  //  INTERNALS
  // ═══════════════════════════════════════════════════════════

  _armTimeout() {
    const state    = this._state;
    const override = this._timeoutOverrides[state];
    const ms       = override !== undefined ? override : StateTimeouts[state];
    if (ms == null) return;

    const target = TimeoutTargets[state];
    if (!target) return;

    this._timeoutHandle = setTimeout(() => {
      if (this._state !== state) return;
      if (this._verbose) {
        console.log(`[Razor SM] ⏱  Timeout in ${state} after ${ms}ms → ${target}`);
      }
      this.transition(target, `timeout:${state}`, {
        reason:   `${state} exceeded ${ms}ms`,
        timedOut: true,
      });
    }, ms);

    if (this._timeoutHandle.unref) this._timeoutHandle.unref();
  }

  _clearTimeout() {
    if (this._timeoutHandle) {
      clearTimeout(this._timeoutHandle);
      this._timeoutHandle = null;
    }
  }

  _addHook(map, state, cb) {
    if (!map.has(state)) map.set(state, []);
    map.get(state).push(cb);
    return () => {
      const arr = map.get(state);
      if (arr) {
        const idx = arr.indexOf(cb);
        if (idx !== -1) arr.splice(idx, 1);
      }
    };
  }

  _fireHooks(map, state, payload) {
    const hooks = map.get(state);
    if (!hooks) return;
    for (const hook of hooks) {
      try {
        hook(payload);
      } catch (err) {
        console.error(`[Razor SM] Hook error in ${state}:`, err.message);
      }
    }
  }

  _reject(reason) {
    if (this._verbose) {
      console.log(`[Razor SM] ✗ ${reason}`);
    }
    this.emit('transition:rejected', {
      state:     this._state,
      reason,
      timestamp: Date.now(),
    });
    return { ok: false, error: reason };
  }
}

// ─────────────────────────────────────────────────────────────
// Factory + singleton
// ─────────────────────────────────────────────────────────────

export function createStateMachine(opts) {
  return new RazorStateMachine(opts);
}

let _instance = null;

export function getStateMachine(opts) {
  if (!_instance) _instance = new RazorStateMachine(opts);
  return _instance;
}

export function resetSingleton() {
  if (_instance) { _instance.destroy(); _instance = null; }
}

export { States };
