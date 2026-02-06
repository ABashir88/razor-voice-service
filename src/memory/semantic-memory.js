// src/semantic-memory.js — Semantic Memory
// Accumulated knowledge about accounts, contacts, relationships, preferences.
// Persistent and grows over time. This is the "long-term knowledge base."

import Store from './store.js';

/**
 * @typedef {Object} Contact
 * @property {string}   id
 * @property {string}   name
 * @property {string}   [email]
 * @property {string}   [phone]
 * @property {string}   [title]
 * @property {string}   [company]
 * @property {string}   [accountId]
 * @property {string}   [role]            — 'champion' | 'decision_maker' | 'influencer' | 'blocker' | 'end_user'
 * @property {string}   [personality]     — 'analytical' | 'driver' | 'expressive' | 'amiable'
 * @property {string}   [commStyle]       — 'formal' | 'casual' | 'technical' | 'executive'
 * @property {string[]} [interests]
 * @property {string[]} [painPoints]
 * @property {string[]} [preferences]     — how they like to be approached
 * @property {string[]} [dislikes]        — what to avoid
 * @property {Object}   [relationships]   — { contactId: 'reports_to' | 'peers_with' | 'manages' }
 * @property {string}   [notes]
 * @property {number}   lastContactedAt
 * @property {number}   createdAt
 * @property {number}   updatedAt
 */

/**
 * @typedef {Object} Account
 * @property {string}   id
 * @property {string}   name
 * @property {string}   [industry]
 * @property {string}   [size]           — 'startup' | 'smb' | 'mid_market' | 'enterprise'
 * @property {number}   [revenue]
 * @property {number}   [employees]
 * @property {string}   [stage]          — 'prospect' | 'qualified' | 'opportunity' | 'customer' | 'churned'
 * @property {string[]} [techStack]
 * @property {string[]} [painPoints]
 * @property {string[]} [competitors]    — competitors they're evaluating
 * @property {string}   [decisionProcess] — how they buy
 * @property {string}   [budgetCycle]
 * @property {string[]} [contactIds]
 * @property {string[]} [dealIds]
 * @property {string}   [notes]
 * @property {number}   createdAt
 * @property {number}   updatedAt
 */

/**
 * @typedef {Object} Deal
 * @property {string}   id
 * @property {string}   name
 * @property {string}   accountId
 * @property {string}   [contactId]      — primary contact
 * @property {string}   stage            — 'discovery' | 'qualification' | 'proposal' | 'negotiation' | 'closed_won' | 'closed_lost'
 * @property {number}   value
 * @property {string}   [closeDate]
 * @property {number}   [probability]
 * @property {string[]} [products]
 * @property {string}   [lossReason]
 * @property {string}   [winReason]
 * @property {string}   [notes]
 * @property {number}   createdAt
 * @property {number}   updatedAt
 */

export class SemanticMemory {
  constructor(basePath) {
    this.store = new Store(basePath);
  }

  // ─── Contacts ──────────────────────────────────────────

  async getContact(id) {
    const contacts = await this.store.read('semantic/contacts', {});
    return contacts[id] || null;
  }

  async upsertContact(data) {
    const now = Date.now();
    return this.store.update('semantic/contacts', {}, (contacts) => {
      const existing = contacts[data.id];
      if (existing) {
        // Merge: new data wins, but arrays get union-merged
        contacts[data.id] = this._mergeEntity(existing, data, now);
      } else {
        contacts[data.id] = { ...data, createdAt: now, updatedAt: now };
      }
      return contacts;
    }).then(contacts => contacts[data.id]);
  }

  async searchContacts(query) {
    const contacts = await this.store.read('semantic/contacts', {});
    const needle = query.toLowerCase();
    return Object.values(contacts).filter(c => {
      return (
        c.name?.toLowerCase().includes(needle) ||
        c.email?.toLowerCase().includes(needle) ||
        c.company?.toLowerCase().includes(needle) ||
        c.title?.toLowerCase().includes(needle)
      );
    });
  }

  async getContactsByAccount(accountId) {
    const contacts = await this.store.read('semantic/contacts', {});
    return Object.values(contacts).filter(c => c.accountId === accountId);
  }

  // ─── Accounts ──────────────────────────────────────────

  async getAccount(id) {
    const accounts = await this.store.read('semantic/accounts', {});
    return accounts[id] || null;
  }

  async upsertAccount(data) {
    const now = Date.now();
    return this.store.update('semantic/accounts', {}, (accounts) => {
      const existing = accounts[data.id];
      if (existing) {
        accounts[data.id] = this._mergeEntity(existing, data, now);
      } else {
        accounts[data.id] = { ...data, createdAt: now, updatedAt: now };
      }
      return accounts;
    }).then(accounts => accounts[data.id]);
  }

  async searchAccounts(query) {
    const accounts = await this.store.read('semantic/accounts', {});
    const needle = query.toLowerCase();
    return Object.values(accounts).filter(a => {
      return (
        a.name?.toLowerCase().includes(needle) ||
        a.industry?.toLowerCase().includes(needle)
      );
    });
  }

  // ─── Deals ─────────────────────────────────────────────

  async getDeal(id) {
    const deals = await this.store.read('semantic/deals', {});
    return deals[id] || null;
  }

  async upsertDeal(data) {
    const now = Date.now();
    return this.store.update('semantic/deals', {}, (deals) => {
      const existing = deals[data.id];
      if (existing) {
        deals[data.id] = this._mergeEntity(existing, data, now);
      } else {
        deals[data.id] = { ...data, createdAt: now, updatedAt: now };
      }
      return deals;
    }).then(deals => deals[data.id]);
  }

  async getDealsByAccount(accountId) {
    const deals = await this.store.read('semantic/deals', {});
    return Object.values(deals).filter(d => d.accountId === accountId);
  }

  async getActiveDeals() {
    const deals = await this.store.read('semantic/deals', {});
    return Object.values(deals).filter(d =>
      !['closed_won', 'closed_lost'].includes(d.stage)
    );
  }

  // ─── Relationship Graph ────────────────────────────────

  /**
   * Record a relationship between two contacts.
   * @param {string} fromId
   * @param {string} toId
   * @param {string} type — 'reports_to' | 'peers_with' | 'manages' | 'influenced_by' | 'knows'
   */
  async setRelationship(fromId, toId, type) {
    await this.store.update('semantic/relationships', {}, (rels) => {
      if (!rels[fromId]) rels[fromId] = {};
      rels[fromId][toId] = { type, updatedAt: Date.now() };
      return rels;
    });
  }

  /** Get all relationships for a contact */
  async getRelationships(contactId) {
    const rels = await this.store.read('semantic/relationships', {});
    return rels[contactId] || {};
  }

  /**
   * Build the org chart / power map for an account.
   * Returns contacts with their relationships.
   */
  async getAccountPowerMap(accountId) {
    const contacts = await this.getContactsByAccount(accountId);
    const rels = await this.store.read('semantic/relationships', {});
    return contacts.map(c => ({
      ...c,
      relationships: rels[c.id] || {},
    }));
  }

  // ─── Full Context Builder ──────────────────────────────

  /**
   * Build rich context for a deal — the account, all contacts, relationships, history.
   * Used for injecting into LLM prompts before a call or meeting.
   */
  async buildDealContext(dealId) {
    const deal = await this.getDeal(dealId);
    if (!deal) return null;

    const account = await this.getAccount(deal.accountId);
    const contacts = await this.getContactsByAccount(deal.accountId);
    const powerMap = await this.getAccountPowerMap(deal.accountId);

    return {
      deal,
      account,
      contacts,
      powerMap,
      contextString: this._formatDealContext(deal, account, powerMap),
    };
  }

  _formatDealContext(deal, account, powerMap) {
    const lines = [];

    if (account) {
      lines.push(`[Account] ${account.name} — ${account.industry || 'Unknown industry'} — ${account.size || 'Unknown size'}`);
      if (account.techStack?.length) lines.push(`  Tech stack: ${account.techStack.join(', ')}`);
      if (account.painPoints?.length) lines.push(`  Pain points: ${account.painPoints.join(', ')}`);
      if (account.competitors?.length) lines.push(`  Evaluating: ${account.competitors.join(', ')}`);
    }

    lines.push(`[Deal] ${deal.name} — Stage: ${deal.stage} — Value: $${deal.value?.toLocaleString()}`);
    if (deal.closeDate) lines.push(`  Target close: ${deal.closeDate}`);

    if (powerMap.length) {
      lines.push('[People]');
      for (const c of powerMap) {
        const role = c.role ? ` (${c.role})` : '';
        const style = c.commStyle ? ` — Style: ${c.commStyle}` : '';
        lines.push(`  ${c.name} — ${c.title || 'Unknown title'}${role}${style}`);
        if (c.painPoints?.length) lines.push(`    Cares about: ${c.painPoints.join(', ')}`);
        if (c.dislikes?.length) lines.push(`    Avoid: ${c.dislikes.join(', ')}`);
      }
    }

    return lines.join('\n');
  }

  // ─── Helpers ───────────────────────────────────────────

  /** Smart merge: new scalars overwrite, arrays get unioned, timestamps update */
  _mergeEntity(existing, incoming, now) {
    const merged = { ...existing };

    for (const [key, value] of Object.entries(incoming)) {
      if (value === undefined || value === null) continue;

      if (Array.isArray(value) && Array.isArray(existing[key])) {
        // Union merge for arrays, dedup
        merged[key] = [...new Set([...existing[key], ...value])];
      } else if (typeof value === 'object' && !Array.isArray(value) && typeof existing[key] === 'object') {
        // Shallow merge for nested objects
        merged[key] = { ...existing[key], ...value };
      } else {
        merged[key] = value;
      }
    }

    merged.updatedAt = now;
    // Preserve original creation time
    merged.createdAt = existing.createdAt;

    return merged;
  }
}

export default SemanticMemory;
