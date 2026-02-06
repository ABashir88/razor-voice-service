// src/procedural-memory.js — Procedural Memory
// What works in sales: objection handles, successful openers, winning angles.
// Evolves over time through the learning loop. Tracks effectiveness stats.

import Store from './store.js';

/**
 * @typedef {Object} Technique
 * @property {string}   id
 * @property {string}   category      — 'opener' | 'objection_handle' | 'closing' | 'discovery' | 'follow_up' | 'reengagement'
 * @property {string}   name          — short label
 * @property {string}   description   — the actual technique / script
 * @property {string[]} [triggers]    — when to use this (keywords, signals)
 * @property {string[]} [contexts]    — industry, persona type, deal stage
 * @property {number}   timesUsed     — total usage count
 * @property {number}   timesWorked   — positive outcome count
 * @property {number}   successRate   — timesWorked / timesUsed
 * @property {string}   [lastUsed]    — ISO date
 * @property {string}   [source]      — 'manual' | 'learned' | 'imported'
 * @property {boolean}  active        — still in the playbook?
 * @property {number}   createdAt
 * @property {number}   updatedAt
 */

/**
 * @typedef {Object} ObjectionHandle
 * @property {string}   id
 * @property {string}   objection     — the objection text / pattern
 * @property {string[]} responses     — ranked list of responses (best first)
 * @property {string[]} [contexts]
 * @property {Object}   stats         — { [responseIndex]: { used: number, worked: number } }
 * @property {number}   createdAt
 * @property {number}   updatedAt
 */

const STORE_KEY = 'procedural/playbook';
const OBJECTION_KEY = 'procedural/objections';
const LOG_KEY = 'procedural/usage_log';

export class ProceduralMemory {
  constructor(basePath) {
    this.store = new Store(basePath);
  }

  _genId(prefix = 'tech') {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).substring(2, 6);
    return `${prefix}_${ts}_${rand}`;
  }

  // ─── Techniques ────────────────────────────────────────

  /**
   * Add or update a technique in the playbook.
   * @param {Partial<Technique> & { name: string, category: string }} data
   * @returns {Promise<Technique>}
   */
  async upsertTechnique(data) {
    const now = Date.now();
    return this.store.update(STORE_KEY, { techniques: {} }, (pb) => {
      const id = data.id || this._genId('tech');
      const existing = pb.techniques[id];

      if (existing) {
        pb.techniques[id] = {
          ...existing,
          ...data,
          updatedAt: now,
          // Don't overwrite stats on update unless explicitly passed
          timesUsed: data.timesUsed ?? existing.timesUsed,
          timesWorked: data.timesWorked ?? existing.timesWorked,
          successRate: data.successRate ?? existing.successRate,
        };
      } else {
        pb.techniques[id] = {
          id,
          timesUsed: 0,
          timesWorked: 0,
          successRate: 0,
          active: true,
          source: 'manual',
          triggers: [],
          contexts: [],
          createdAt: now,
          updatedAt: now,
          ...data,
        };
      }

      return pb;
    }).then(pb => pb.techniques[data.id || Object.keys(pb.techniques).pop()]);
  }

  /**
   * Record that a technique was used, and whether it worked.
   * Updates stats and recalculates success rate.
   */
  async recordUsage(techniqueId, worked, context = {}) {
    const now = Date.now();

    // Update technique stats
    await this.store.update(STORE_KEY, { techniques: {} }, (pb) => {
      const tech = pb.techniques[techniqueId];
      if (!tech) return pb;

      tech.timesUsed += 1;
      if (worked) tech.timesWorked += 1;
      tech.successRate = tech.timesUsed > 0
        ? Math.round((tech.timesWorked / tech.timesUsed) * 100) / 100
        : 0;
      tech.lastUsed = new Date(now).toISOString();
      tech.updatedAt = now;

      return pb;
    });

    // Append to usage log for the learning loop
    await this.store.update(LOG_KEY, { entries: [] }, (log) => {
      log.entries.push({
        techniqueId,
        worked,
        context,
        timestamp: now,
      });

      // Keep last 500 log entries
      if (log.entries.length > 500) {
        log.entries = log.entries.slice(-500);
      }

      return log;
    });
  }

  /**
   * Get the best technique for a given situation.
   * Considers category, context, and success rate.
   * @param {string} category
   * @param {Object} [context] — { industry, personaType, dealStage, signal }
   * @returns {Promise<Technique[]>} — top techniques, ranked by relevance + success
   */
  async recommend(category, context = {}) {
    const pb = await this.store.read(STORE_KEY, { techniques: {} });
    const candidates = Object.values(pb.techniques).filter(t =>
      t.active && t.category === category
    );

    // Score each technique
    const scored = candidates.map(t => {
      let score = t.successRate * 100; // Base score from success rate

      // Bonus for context match
      if (context.industry && t.contexts?.includes(context.industry)) score += 20;
      if (context.personaType && t.contexts?.includes(context.personaType)) score += 15;
      if (context.dealStage && t.contexts?.includes(context.dealStage)) score += 10;

      // Bonus for relevant triggers
      if (context.signal && t.triggers?.some(tr =>
        context.signal.toLowerCase().includes(tr.toLowerCase())
      )) {
        score += 25;
      }

      // Small bonus for battle-tested techniques (used more = more reliable data)
      if (t.timesUsed >= 10) score += 5;
      if (t.timesUsed >= 25) score += 5;

      // Penalty for stale techniques (not used in 30+ days)
      if (t.lastUsed) {
        const daysSince = (Date.now() - new Date(t.lastUsed).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSince > 30) score -= 10;
      }

      return { ...t, _score: score };
    });

    return scored.sort((a, b) => b._score - a._score).slice(0, 5);
  }

  /**
   * Get all techniques, optionally filtered by category.
   */
  async getTechniques(category = null) {
    const pb = await this.store.read(STORE_KEY, { techniques: {} });
    const all = Object.values(pb.techniques);
    return category ? all.filter(t => t.category === category) : all;
  }

  /**
   * Deactivate underperforming techniques (success rate < threshold after N uses).
   * @param {number} [minUses=10]
   * @param {number} [minRate=0.15]
   * @returns {Promise<string[]>} — IDs of deactivated techniques
   */
  async pruneUnderperformers(minUses = 10, minRate = 0.15) {
    const deactivated = [];

    await this.store.update(STORE_KEY, { techniques: {} }, (pb) => {
      for (const [id, tech] of Object.entries(pb.techniques)) {
        if (tech.active && tech.timesUsed >= minUses && tech.successRate < minRate) {
          tech.active = false;
          tech.updatedAt = Date.now();
          deactivated.push(id);
        }
      }
      return pb;
    });

    return deactivated;
  }

  // ─── Objection Handles ─────────────────────────────────

  /**
   * Add or update an objection handle.
   */
  async upsertObjectionHandle(data) {
    const now = Date.now();
    return this.store.update(OBJECTION_KEY, { handles: {} }, (oh) => {
      const id = data.id || this._genId('obj');
      const existing = oh.handles[id];

      if (existing) {
        oh.handles[id] = {
          ...existing,
          ...data,
          // Merge responses, don't overwrite
          responses: data.responses
            ? [...new Set([...data.responses, ...(existing.responses || [])])]
            : existing.responses,
          updatedAt: now,
        };
      } else {
        oh.handles[id] = {
          id,
          stats: {},
          contexts: [],
          createdAt: now,
          updatedAt: now,
          ...data,
        };
      }

      return oh;
    });
  }

  /**
   * Find the best response for an objection.
   * Fuzzy matches the objection text against known patterns.
   * @param {string} objectionText
   * @returns {Promise<{handle: ObjectionHandle, bestResponse: string} | null>}
   */
  async findObjectionHandle(objectionText) {
    const oh = await this.store.read(OBJECTION_KEY, { handles: {} });
    const needle = objectionText.toLowerCase();

    let bestMatch = null;
    let bestScore = 0;

    for (const handle of Object.values(oh.handles)) {
      const words = handle.objection.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      if (words.length === 0) continue;
      const matchedWords = words.filter(w => needle.includes(w));
      const score = matchedWords.length / words.length;

      if (score > bestScore && score > 0.25) {
        bestScore = score;
        bestMatch = handle;
      }
    }

    if (!bestMatch || !bestMatch.responses?.length) return null;

    // Pick the response with the best stats
    let bestResponseIdx = 0;
    let bestResponseRate = -1;

    for (let i = 0; i < bestMatch.responses.length; i++) {
      const stat = bestMatch.stats?.[i];
      if (stat && stat.used > 0) {
        const rate = stat.worked / stat.used;
        if (rate > bestResponseRate) {
          bestResponseRate = rate;
          bestResponseIdx = i;
        }
      }
    }

    return {
      handle: bestMatch,
      bestResponse: bestMatch.responses[bestResponseIdx],
    };
  }

  /**
   * Record usage of an objection handle response.
   */
  async recordObjectionUsage(handleId, responseIndex, worked) {
    await this.store.update(OBJECTION_KEY, { handles: {} }, (oh) => {
      const handle = oh.handles[handleId];
      if (!handle) return oh;

      if (!handle.stats) handle.stats = {};
      if (!handle.stats[responseIndex]) handle.stats[responseIndex] = { used: 0, worked: 0 };

      handle.stats[responseIndex].used += 1;
      if (worked) handle.stats[responseIndex].worked += 1;
      handle.updatedAt = Date.now();

      return oh;
    });
  }

  // ─── Playbook Export ───────────────────────────────────

  /**
   * Export the entire playbook as a formatted string for review or printing.
   */
  async exportPlaybook() {
    const pb = await this.store.read(STORE_KEY, { techniques: {} });
    const oh = await this.store.read(OBJECTION_KEY, { handles: {} });

    const lines = ['# Razor Sales Playbook', `Generated: ${new Date().toISOString()}`, ''];

    // Group techniques by category
    const byCategory = {};
    for (const tech of Object.values(pb.techniques)) {
      if (!byCategory[tech.category]) byCategory[tech.category] = [];
      byCategory[tech.category].push(tech);
    }

    for (const [cat, techs] of Object.entries(byCategory)) {
      lines.push(`## ${cat.toUpperCase().replace(/_/g, ' ')}`);
      lines.push('');

      const sorted = techs.sort((a, b) => b.successRate - a.successRate);
      for (const t of sorted) {
        const status = t.active ? '✓' : '✗';
        const rate = `${Math.round(t.successRate * 100)}%`;
        lines.push(`${status} **${t.name}** — ${rate} success (${t.timesUsed} uses)`);
        lines.push(`  ${t.description}`);
        if (t.triggers?.length) lines.push(`  Triggers: ${t.triggers.join(', ')}`);
        lines.push('');
      }
    }

    lines.push('## OBJECTION HANDLES');
    lines.push('');

    for (const handle of Object.values(oh.handles)) {
      lines.push(`### "${handle.objection}"`);
      for (let i = 0; i < handle.responses.length; i++) {
        const stat = handle.stats?.[i];
        const rate = stat?.used ? `${Math.round((stat.worked / stat.used) * 100)}%` : 'N/A';
        lines.push(`  ${i + 1}. ${handle.responses[i]} [${rate}]`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }
}

export default ProceduralMemory;
