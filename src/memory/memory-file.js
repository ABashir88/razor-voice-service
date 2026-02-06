// src/memory-file.js — MEMORY.md File Manager
// Maintains a human-readable summary file: key accounts, active deals,
// recent lessons, top techniques. Kept under 200 lines.
// Compressed and deduped on every update.

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import Store from './store.js';
import SemanticMemory from './semantic-memory.js';
import ProceduralMemory from './procedural-memory.js';
import EpisodicMemory from './episodic-memory.js';

const MAX_LINES = 200;

export class MemoryFile {
  /**
   * @param {string} basePath — knowledge directory root
   */
  constructor(basePath) {
    this.basePath = basePath;
    this.filePath = join(basePath, 'MEMORY.md');
    this.store = new Store(basePath);
    this.semantic = new SemanticMemory(basePath);
    this.procedural = new ProceduralMemory(basePath);
    this.episodic = new EpisodicMemory(basePath);
  }

  /**
   * Regenerate MEMORY.md from the current state of all memory subsystems.
   * Call after significant changes or on a schedule.
   * @returns {Promise<{lines: number, sections: string[]}>}
   */
  async regenerate() {
    const sections = [];

    // ── Header
    sections.push(this._section('RAZOR MEMORY — LIVING DOCUMENT', [
      `Last updated: ${new Date().toISOString()}`,
      'Auto-generated. Do not edit manually.',
    ]));

    // ── Active Deals (max 30 lines)
    const deals = await this.semantic.getActiveDeals();
    if (deals.length > 0) {
      const dealLines = [];
      // Top 8 deals by value
      const topDeals = deals.sort((a, b) => (b.value || 0) - (a.value || 0)).slice(0, 8);
      for (const d of topDeals) {
        const account = await this.semantic.getAccount(d.accountId);
        const acctName = account?.name || d.accountId;
        dealLines.push(`- **${d.name}** @ ${acctName} — ${d.stage} — $${(d.value || 0).toLocaleString()}`);
        if (d.closeDate) dealLines.push(`  Close target: ${d.closeDate}`);
      }
      if (deals.length > 8) dealLines.push(`...and ${deals.length - 8} more deals`);
      sections.push(this._section('ACTIVE DEALS', dealLines));
    }

    // ── Key Accounts (max 40 lines)
    const accounts = await this.store.read('semantic/accounts', {});
    const acctList = Object.values(accounts);
    if (acctList.length > 0) {
      const acctLines = [];
      // Top 10 accounts by recent activity
      const sorted = acctList.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 10);
      for (const a of sorted) {
        acctLines.push(`- **${a.name}** — ${a.industry || '?'} — ${a.stage || '?'} — ${a.size || '?'}`);
        if (a.painPoints?.length) acctLines.push(`  Pains: ${a.painPoints.slice(0, 3).join(', ')}`);
        if (a.competitors?.length) acctLines.push(`  Evaluating: ${a.competitors.join(', ')}`);
      }
      sections.push(this._section('KEY ACCOUNTS', acctLines));
    }

    // ── Recent Lessons (max 30 lines)
    const insights = await this.store.read('learning/insights', { insights: [] });
    const recentInsights = insights.insights.slice(-10).reverse();
    if (recentInsights.length > 0) {
      const lessonLines = recentInsights.map(i => {
        const date = new Date(i.timestamp).toLocaleDateString();
        const icon = i.type === 'technique_worked' ? '✓' : i.type === 'technique_failed' ? '✗' : '•';
        return `${icon} [${date}] ${i.description}`;
      });
      sections.push(this._section('RECENT LESSONS', lessonLines));
    }

    // ── Top Techniques (max 25 lines)
    const techniques = await this.procedural.getTechniques();
    const active = techniques.filter(t => t.active && t.timesUsed >= 2);
    if (active.length > 0) {
      const topTech = active.sort((a, b) => b.successRate - a.successRate).slice(0, 8);
      const techLines = topTech.map(t => {
        const rate = `${Math.round(t.successRate * 100)}%`;
        return `- **${t.name}** [${t.category}] — ${rate} success (${t.timesUsed} uses)`;
      });
      sections.push(this._section('TOP TECHNIQUES', techLines));
    }

    // ── Objection Cheat Sheet (max 25 lines)
    const objections = await this.store.read('procedural/objections', { handles: {} });
    const objList = Object.values(objections.handles).slice(0, 6);
    if (objList.length > 0) {
      const objLines = [];
      for (const h of objList) {
        objLines.push(`**"${h.objection}"**`);
        if (h.responses?.[0]) objLines.push(`  → ${h.responses[0]}`);
      }
      sections.push(this._section('OBJECTION CHEAT SHEET', objLines));
    }

    // ── Performance Snapshot (max 10 lines)
    const metrics = await this.store.read('learning/metrics', null);
    if (metrics) {
      const perfLines = [
        `Total conversations: ${metrics.totalConversations}`,
        `Win rate: ${Math.round((metrics.winRate || 0) * 100)}%`,
        `Outcomes: ✓${metrics.outcomes?.positive || 0} / ~${metrics.outcomes?.neutral || 0} / ✗${metrics.outcomes?.negative || 0}`,
        `Current streak: ${metrics.streaks?.current || 0} | Best: ${metrics.streaks?.best || 0}`,
      ];
      sections.push(this._section('PERFORMANCE', perfLines));
    }

    // ── Assemble and enforce line limit
    let content = sections.join('\n\n');
    let lines = content.split('\n');

    if (lines.length > MAX_LINES) {
      content = this._compress(sections);
      lines = content.split('\n');
    }

    await writeFile(this.filePath, content, 'utf-8');

    return {
      lines: lines.length,
      sections: sections.map(s => s.split('\n')[0]),
    };
  }

  /**
   * Read the current MEMORY.md contents.
   * @returns {Promise<string>}
   */
  async read() {
    try {
      return await readFile(this.filePath, 'utf-8');
    } catch {
      return '';
    }
  }

  // ─── Helpers ───────────────────────────────────────────

  _section(title, lines) {
    return [`## ${title}`, ...lines].join('\n');
  }

  /**
   * Compress sections to fit within MAX_LINES.
   * Strategy: reduce each section proportionally, trim from the bottom.
   */
  _compress(sections) {
    const totalLines = sections.reduce((sum, s) => sum + s.split('\n').length, 0);
    const ratio = (MAX_LINES - sections.length) / totalLines; // leave room for blank lines between sections

    const compressed = sections.map(section => {
      const lines = section.split('\n');
      const header = lines[0];
      const body = lines.slice(1);
      const maxBody = Math.max(2, Math.floor(body.length * ratio));
      return [header, ...body.slice(0, maxBody)].join('\n');
    });

    return compressed.join('\n\n');
  }
}

export default MemoryFile;
