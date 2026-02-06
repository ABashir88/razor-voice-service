// src/store.js — Atomic JSON file store with write locking
// All memory subsystems use this as their persistence layer.

import { readFile, writeFile, mkdir, rename, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';

const LOCK_TIMEOUT_MS = 5000;
const LOCK_POLL_MS = 50;

/** @type {Map<string, Promise<void>>} */
const writeLocks = new Map();

export class Store {
  /**
   * @param {string} basePath — root directory for all JSON files
   */
  constructor(basePath) {
    this.basePath = basePath;
  }

  /** Resolve a logical key like 'episodic/2024-01' to an absolute .json path */
  _resolve(key) {
    // Sanitize: only allow alphanumeric, dash, underscore, slash
    const safe = key.replace(/[^a-zA-Z0-9_\-\/]/g, '_');
    return join(this.basePath, `${safe}.json`);
  }

  /**
   * Read a JSON file. Returns defaultValue if file doesn't exist.
   * @template T
   * @param {string} key
   * @param {T} defaultValue
   * @returns {Promise<T>}
   */
  async read(key, defaultValue = null) {
    const filePath = this._resolve(key);
    try {
      const raw = await readFile(filePath, 'utf-8');
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') return defaultValue;
      // Corrupted JSON — try backup
      try {
        const backup = await readFile(filePath + '.bak', 'utf-8');
        console.warn(`[Store] Recovered from backup: ${key}`);
        return JSON.parse(backup);
      } catch {
        console.error(`[Store] Failed to read ${key}:`, err.message);
        return defaultValue;
      }
    }
  }

  /**
   * Atomic write: write to .tmp, then rename. Keeps .bak of previous.
   * Uses in-process write lock per key to prevent concurrent writes.
   * @param {string} key
   * @param {*} data
   */
  async write(key, data) {
    const filePath = this._resolve(key);
    const dir = dirname(filePath);

    // Ensure directory exists
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    // Acquire in-process lock
    await this._acquireLock(key);

    try {
      const json = JSON.stringify(data, null, 2);
      const tmpPath = filePath + '.tmp';

      // Write to temp file first
      await writeFile(tmpPath, json, 'utf-8');

      // Backup existing file
      if (existsSync(filePath)) {
        try {
          await rename(filePath, filePath + '.bak');
        } catch { /* first write, no backup needed */ }
      }

      // Atomic rename
      await rename(tmpPath, filePath);
    } finally {
      this._releaseLock(key);
    }
  }

  /**
   * Read-modify-write with a mutator function.
   * @template T
   * @param {string} key
   * @param {T} defaultValue
   * @param {(data: T) => T} mutator
   * @returns {Promise<T>} — the new value after mutation
   */
  async update(key, defaultValue, mutator) {
    const current = await this.read(key, defaultValue);
    const next = mutator(current);
    await this.write(key, next);
    return next;
  }

  /**
   * Check if a key exists.
   * @param {string} key
   * @returns {Promise<boolean>}
   */
  async exists(key) {
    const filePath = this._resolve(key);
    try {
      await stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /** Delete a key */
  async delete(key) {
    const filePath = this._resolve(key);
    const { unlink } = await import('fs/promises');
    try {
      await unlink(filePath);
      // Clean backup too
      try { await unlink(filePath + '.bak'); } catch { /* noop */ }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  /** List all keys under a prefix */
  async list(prefix = '') {
    const { readdir } = await import('fs/promises');
    const dir = prefix ? join(this.basePath, prefix) : this.basePath;
    try {
      const entries = await readdir(dir, { recursive: true });
      return entries
        .filter(e => e.endsWith('.json') && !e.endsWith('.tmp') && !e.endsWith('.bak'))
        .map(e => {
          const key = prefix ? `${prefix}/${e}` : e;
          return key.replace(/\.json$/, '');
        });
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  // --- Locking ---

  async _acquireLock(key) {
    const start = Date.now();
    while (writeLocks.has(key)) {
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        console.warn(`[Store] Lock timeout on ${key}, forcing release`);
        writeLocks.delete(key);
        break;
      }
      await new Promise(r => setTimeout(r, LOCK_POLL_MS));
    }
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    promise._resolve = resolve;
    writeLocks.set(key, promise);
  }

  _releaseLock(key) {
    const lock = writeLocks.get(key);
    writeLocks.delete(key);
    if (lock?._resolve) lock._resolve();
  }
}

export default Store;
