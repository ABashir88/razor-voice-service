// src/episodic-memory.js — Episodic Memory
// Stores every conversation with timestamp, topic, outcome, key facts.
// Searchable by contact, account, topic, date range, outcome.
// Sharded by month: episodic/2024-01, episodic/2024-02, etc.

import Store from './store.js';

/**
 * @typedef {Object} Episode
 * @property {string}   id          — unique episode ID (uuid-like)
 * @property {number}   timestamp   — epoch ms when conversation started
 * @property {string}   date        — ISO date string
 * @property {string}   topic       — classified topic
 * @property {string}   outcome     — 'positive' | 'neutral' | 'negative' | 'follow_up'
 * @property {string}   [contactId] — linked contact ID
 * @property {string}   [accountId] — linked account ID
 * @property {string}   [dealId]    — linked deal ID
 * @property {string}   summary     — 2-3 sentence summary of the conversation
 * @property {string[]} keyFacts    — extracted key facts
 * @property {string[]} commitments — promises / next steps
 * @property {string[]} tags        — freeform tags for search
 * @property {number}   turnCount   — number of conversation turns
 * @property {Object}   [metadata]  — arbitrary extra data
 */

export class EpisodicMemory {
  /**
   * @param {string} basePath — root knowledge directory
   */
  constructor(basePath) {
    this._store = new Store(basePath);
  }

  /** Get the shard key for a given timestamp */
  _shardKey(timestamp) {
    const d = new Date(timestamp);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return `episodic/${yyyy}-${mm}`;
  }

  /** Generate a compact unique ID */
  _genId() {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).substring(2, 8);
    return `ep_${ts}_${rand}`;
  }

  /**
   * Store a new episode. Called when a conversation ends.
   * @param {Omit<Episode, 'id'|'date'>} data
   * @returns {Promise<Episode>}
   */
  async store(data) {
    const episode = {
      id: this._genId(),
      date: new Date(data.timestamp).toISOString(),
      ...data,
    };

    const shardKey = this._shardKey(data.timestamp);

    await this._store.update(shardKey, { episodes: [] }, (shard) => {
      shard.episodes.push(episode);
      return shard;
    });

    // Also update the index for fast lookup
    await this._updateIndex(episode);

    return episode;
  }

  /**
   * Search episodes by flexible criteria.
   * @param {Object} query
   * @param {string}  [query.contactId]
   * @param {string}  [query.accountId]
   * @param {string}  [query.dealId]
   * @param {string}  [query.topic]
   * @param {string}  [query.outcome]
   * @param {string}  [query.tag]
   * @param {string}  [query.text]         — full-text search in summary + keyFacts
   * @param {number}  [query.since]        — epoch ms
   * @param {number}  [query.until]        — epoch ms
   * @param {number}  [query.limit]        — max results (default 20)
   * @returns {Promise<Episode[]>}
   */
  async search(query = {}) {
    const limit = query.limit || 20;
    const shardKeys = await this._store.list('episodic');
    const results = [];

    // Iterate shards in reverse chronological order (skip index and archive)
    const sorted = shardKeys
      .filter(k => !k.includes('_index') && !k.includes('archive'))
      .sort()
      .reverse();

    for (const key of sorted) {
      const shard = await this._store.read(key, { episodes: [] });

      for (const ep of [...shard.episodes].reverse()) {
        if (results.length >= limit) break;
        if (this._matches(ep, query)) {
          results.push(ep);
        }
      }

      if (results.length >= limit) break;
    }

    return results;
  }

  /**
   * Get all episodes for a specific contact, most recent first.
   * @param {string} contactId
   * @param {number} [limit=10]
   * @returns {Promise<Episode[]>}
   */
  async getContactHistory(contactId, limit = 10) {
    return this.search({ contactId, limit });
  }

  /**
   * Get all episodes for a specific deal.
   * @param {string} dealId
   * @param {number} [limit=20]
   * @returns {Promise<Episode[]>}
   */
  async getDealHistory(dealId, limit = 20) {
    return this.search({ dealId, limit });
  }

  /**
   * Get the last N episodes, regardless of any filter.
   * @param {number} [n=5]
   * @returns {Promise<Episode[]>}
   */
  async getRecent(n = 5) {
    return this.search({ limit: n });
  }

  /**
   * Build a context string for a contact — their conversation history summarized.
   * @param {string} contactId
   * @returns {Promise<string>}
   */
  async buildContactContext(contactId) {
    const episodes = await this.getContactHistory(contactId, 5);
    if (!episodes.length) return '';

    const lines = [`Last ${episodes.length} interactions:`];
    for (const ep of episodes) {
      const dateStr = new Date(ep.timestamp).toLocaleDateString();
      lines.push(`  ${dateStr} — ${ep.topic} → ${ep.outcome}: ${ep.summary}`);
      if (ep.commitments?.length) {
        lines.push(`    Commitments: ${ep.commitments.join('; ')}`);
      }
    }
    return lines.join('\n');
  }

  /**
   * Archive episodes older than a given number of days.
   * Moves them to archive/ shard and removes from active shards.
   * @param {number} [daysOld=60]
   * @returns {Promise<{archived: number, remaining: number}>}
   */
  async archive(daysOld = 60) {
    const cutoff = Date.now() - (daysOld * 24 * 60 * 60 * 1000);
    const shardKeys = await this._store.list('episodic');
    let archived = 0;
    let remaining = 0;

    for (const key of shardKeys) {
      if (key.startsWith('episodic/archive')) continue;

      const shard = await this._store.read(key, { episodes: [] });
      const keep = [];
      const toArchive = [];

      for (const ep of shard.episodes) {
        if (ep.timestamp < cutoff) {
          toArchive.push(ep);
        } else {
          keep.push(ep);
        }
      }

      if (toArchive.length > 0) {
        // Compress archived episodes: strip full turns, keep summary
        const compressed = toArchive.map(ep => ({
          id: ep.id,
          timestamp: ep.timestamp,
          date: ep.date,
          topic: ep.topic,
          outcome: ep.outcome,
          contactId: ep.contactId,
          accountId: ep.accountId,
          dealId: ep.dealId,
          summary: ep.summary,
          keyFacts: ep.keyFacts,
          commitments: ep.commitments,
          tags: ep.tags,
        }));

        const archiveKey = key.replace('episodic/', 'episodic/archive/');
        await this._store.update(archiveKey, { episodes: [] }, (arch) => {
          arch.episodes.push(...compressed);
          return arch;
        });

        // Update active shard
        await this._store.write(key, { episodes: keep });

        archived += toArchive.length;
      }

      remaining += keep.length;
    }

    return { archived, remaining };
  }

  // --- Internal ---

  _matches(episode, query) {
    if (query.contactId && episode.contactId !== query.contactId) return false;
    if (query.accountId && episode.accountId !== query.accountId) return false;
    if (query.dealId && episode.dealId !== query.dealId) return false;
    if (query.topic && episode.topic !== query.topic) return false;
    if (query.outcome && episode.outcome !== query.outcome) return false;
    if (query.since && episode.timestamp < query.since) return false;
    if (query.until && episode.timestamp > query.until) return false;
    if (query.tag && !episode.tags?.includes(query.tag)) return false;

    if (query.text) {
      const needle = query.text.toLowerCase();
      const haystack = [
        episode.summary,
        ...(episode.keyFacts || []),
        ...(episode.tags || []),
      ].join(' ').toLowerCase();
      if (!haystack.includes(needle)) return false;
    }

    return true;
  }

  async _updateIndex(episode) {
    // Maintain a lightweight index for fast lookups by contact/account/deal
    await this._store.update('episodic/_index', { byContact: {}, byAccount: {}, byDeal: {} }, (idx) => {
      if (episode.contactId) {
        if (!idx.byContact[episode.contactId]) idx.byContact[episode.contactId] = [];
        idx.byContact[episode.contactId].push(episode.id);
        // Keep index entries bounded
        if (idx.byContact[episode.contactId].length > 100) {
          idx.byContact[episode.contactId] = idx.byContact[episode.contactId].slice(-100);
        }
      }
      if (episode.accountId) {
        if (!idx.byAccount[episode.accountId]) idx.byAccount[episode.accountId] = [];
        idx.byAccount[episode.accountId].push(episode.id);
        if (idx.byAccount[episode.accountId].length > 100) {
          idx.byAccount[episode.accountId] = idx.byAccount[episode.accountId].slice(-100);
        }
      }
      if (episode.dealId) {
        if (!idx.byDeal[episode.dealId]) idx.byDeal[episode.dealId] = [];
        idx.byDeal[episode.dealId].push(episode.id);
        if (idx.byDeal[episode.dealId].length > 50) {
          idx.byDeal[episode.dealId] = idx.byDeal[episode.dealId].slice(-50);
        }
      }
      return idx;
    });
  }
}

export default EpisodicMemory;
