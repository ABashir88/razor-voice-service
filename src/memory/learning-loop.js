// src/learning-loop.js — Learning Loop
// After every interaction: extract what worked and what didn't, update the playbook.
// Bridges episodic memory (what happened) with procedural memory (what to do next time).

import EpisodicMemory from './episodic-memory.js';
import SemanticMemory from './semantic-memory.js';
import ProceduralMemory from './procedural-memory.js';
import Store from './store.js';

/**
 * @typedef {Object} LearningInsight
 * @property {string}   id
 * @property {string}   episodeId
 * @property {string}   type           — 'technique_worked' | 'technique_failed' | 'new_pattern' | 'objection_discovered' | 'preference_learned' | 'relationship_found'
 * @property {string}   description
 * @property {string}   [techniqueId]  — linked technique if applicable
 * @property {Object}   [context]
 * @property {boolean}  applied        — whether this insight has been applied to the playbook
 * @property {number}   timestamp
 */

const INSIGHTS_KEY = 'learning/insights';
const METRICS_KEY = 'learning/metrics';

export class LearningLoop {
  /**
   * @param {string} basePath
   */
  constructor(basePath) {
    this.episodic = new EpisodicMemory(basePath);
    this.semantic = new SemanticMemory(basePath);
    this.procedural = new ProceduralMemory(basePath);
    this.store = new Store(basePath);
  }

  /**
   * Main entry point: process the end of a conversation.
   * Extracts insights, updates all memory subsystems.
   *
   * @param {Object} snapshot — WorkingMemory.snapshot() output
   * @param {Object} analysis — LLM-generated analysis of the conversation
   * @param {string} analysis.summary
   * @param {string} analysis.topic
   * @param {string} analysis.outcome — 'positive' | 'neutral' | 'negative' | 'follow_up'
   * @param {string[]} analysis.keyFacts
   * @param {string[]} analysis.commitments
   * @param {string[]} analysis.tags
   * @param {Object[]} [analysis.techniquesUsed] — [{ id, worked }]
   * @param {Object[]} [analysis.objectionsEncountered] — [{ text, handleUsed, worked }]
   * @param {Object} [analysis.contactUpdates] — partial Contact to merge
   * @param {Object} [analysis.accountUpdates] — partial Account to merge
   * @param {Object} [analysis.dealUpdates] — partial Deal to merge
   * @param {Object[]} [analysis.newPatterns] — [{ description, category, trigger }]
   */
  async processConversationEnd(snapshot, analysis) {
    const insights = [];

    // 1. Store the episode
    const episode = await this.episodic.store({
      timestamp: snapshot.startedAt,
      topic: analysis.topic,
      outcome: analysis.outcome,
      contactId: snapshot.activeProspect?.id,
      accountId: snapshot.activeDeal?.accountId,
      dealId: snapshot.activeDeal?.id,
      summary: analysis.summary,
      keyFacts: analysis.keyFacts || [],
      commitments: analysis.commitments || [],
      tags: analysis.tags || [],
      turnCount: snapshot.turnCount,
    });

    // 2. Update semantic memory with learned facts
    if (analysis.contactUpdates && snapshot.activeProspect?.id) {
      await this.semantic.upsertContact({
        id: snapshot.activeProspect.id,
        ...analysis.contactUpdates,
        lastContactedAt: Date.now(),
      });
    }

    if (analysis.accountUpdates && snapshot.activeDeal?.accountId) {
      await this.semantic.upsertAccount({
        id: snapshot.activeDeal.accountId,
        ...analysis.accountUpdates,
      });
    }

    if (analysis.dealUpdates && snapshot.activeDeal?.id) {
      await this.semantic.upsertDeal({
        id: snapshot.activeDeal.id,
        ...analysis.dealUpdates,
      });
    }

    // 3. Update procedural memory — what techniques worked/failed
    if (analysis.techniquesUsed) {
      for (const { id, worked } of analysis.techniquesUsed) {
        await this.procedural.recordUsage(id, worked, {
          contactId: snapshot.activeProspect?.id,
          dealId: snapshot.activeDeal?.id,
          outcome: analysis.outcome,
        });

        insights.push({
          id: this._genId(),
          episodeId: episode.id,
          type: worked ? 'technique_worked' : 'technique_failed',
          description: `Technique ${id}: ${worked ? 'succeeded' : 'failed'} — ${analysis.outcome}`,
          techniqueId: id,
          context: { outcome: analysis.outcome, topic: analysis.topic },
          applied: true,
          timestamp: Date.now(),
        });
      }
    }

    // 4. Process objections encountered
    if (analysis.objectionsEncountered) {
      for (const obj of analysis.objectionsEncountered) {
        if (obj.handleUsed) {
          await this.procedural.recordObjectionUsage(
            obj.handleUsed.id,
            obj.handleUsed.responseIndex || 0,
            obj.worked
          );
        }

        // If it's a new objection, create a handle placeholder
        if (!obj.handleUsed) {
          await this.procedural.upsertObjectionHandle({
            objection: obj.text,
            responses: obj.suggestedResponse ? [obj.suggestedResponse] : [],
            contexts: [analysis.topic],
          });

          insights.push({
            id: this._genId(),
            episodeId: episode.id,
            type: 'objection_discovered',
            description: `New objection: "${obj.text}"`,
            applied: false,
            timestamp: Date.now(),
          });
        }
      }
    }

    // 5. Discover new patterns
    if (analysis.newPatterns) {
      for (const pattern of analysis.newPatterns) {
        // Auto-create a technique from the pattern
        const technique = await this.procedural.upsertTechnique({
          category: pattern.category || 'discovery',
          name: pattern.description.substring(0, 60),
          description: pattern.description,
          triggers: pattern.trigger ? [pattern.trigger] : [],
          source: 'learned',
        });

        insights.push({
          id: this._genId(),
          episodeId: episode.id,
          type: 'new_pattern',
          description: pattern.description,
          techniqueId: technique?.id,
          applied: true,
          timestamp: Date.now(),
        });
      }
    }

    // 6. Store all insights
    if (insights.length > 0) {
      await this.store.update(INSIGHTS_KEY, { insights: [] }, (data) => {
        data.insights.push(...insights);
        // Keep last 200 insights
        if (data.insights.length > 200) {
          data.insights = data.insights.slice(-200);
        }
        return data;
      });
    }

    // 7. Update aggregate metrics
    await this._updateMetrics(analysis.outcome);

    // 8. Periodically prune underperformers
    await this._maybeAutoPrune();

    return {
      episodeId: episode.id,
      insightsGenerated: insights.length,
      insights,
    };
  }

  /**
   * Get recent insights, optionally filtered by type.
   */
  async getInsights(type = null, limit = 20) {
    const data = await this.store.read(INSIGHTS_KEY, { insights: [] });
    let filtered = data.insights;
    if (type) filtered = filtered.filter(i => i.type === type);
    return filtered.slice(-limit).reverse();
  }

  /**
   * Get aggregate performance metrics.
   */
  async getMetrics() {
    return this.store.read(METRICS_KEY, {
      totalConversations: 0,
      outcomes: { positive: 0, neutral: 0, negative: 0, follow_up: 0 },
      winRate: 0,
      avgConversationsPerDay: 0,
      streaks: { current: 0, best: 0 },
      lastUpdated: null,
    });
  }

  /**
   * Run a full learning analysis: identify trends, recommend playbook changes.
   * Call this periodically (e.g., daily or weekly).
   */
  async runAnalysis() {
    const metrics = await this.getMetrics();
    const recentInsights = await this.getInsights(null, 50);
    const techniques = await this.procedural.getTechniques();

    const recommendations = [];

    // Find declining techniques
    for (const tech of techniques) {
      if (tech.active && tech.timesUsed >= 5 && tech.successRate < 0.2) {
        recommendations.push({
          type: 'retire_technique',
          techniqueId: tech.id,
          reason: `"${tech.name}" has a ${Math.round(tech.successRate * 100)}% success rate over ${tech.timesUsed} uses`,
        });
      }
    }

    // Find frequently discovered objections without good handles
    const newObjections = recentInsights.filter(i => i.type === 'objection_discovered');
    if (newObjections.length >= 3) {
      recommendations.push({
        type: 'review_objections',
        count: newObjections.length,
        reason: `${newObjections.length} new objections discovered recently — review and add responses`,
      });
    }

    // Check overall win rate trend
    if (metrics.totalConversations > 20 && metrics.winRate < 0.25) {
      recommendations.push({
        type: 'review_approach',
        reason: `Overall win rate is ${Math.round(metrics.winRate * 100)}% — consider reviewing sales approach`,
      });
    }

    return {
      metrics,
      insightCount: recentInsights.length,
      recommendations,
      topTechniques: techniques
        .filter(t => t.active && t.timesUsed >= 3)
        .sort((a, b) => b.successRate - a.successRate)
        .slice(0, 5)
        .map(t => ({ name: t.name, category: t.category, successRate: t.successRate, uses: t.timesUsed })),
    };
  }

  // ─── Internal ──────────────────────────────────────────

  async _updateMetrics(outcome) {
    await this.store.update(METRICS_KEY, {
      totalConversations: 0,
      outcomes: { positive: 0, neutral: 0, negative: 0, follow_up: 0 },
      winRate: 0,
      streaks: { current: 0, best: 0 },
      lastUpdated: null,
    }, (m) => {
      m.totalConversations += 1;
      m.outcomes[outcome] = (m.outcomes[outcome] || 0) + 1;

      // Win rate = positive / total
      m.winRate = m.totalConversations > 0
        ? Math.round((m.outcomes.positive / m.totalConversations) * 100) / 100
        : 0;

      // Streak tracking
      if (outcome === 'positive') {
        m.streaks.current += 1;
        if (m.streaks.current > m.streaks.best) {
          m.streaks.best = m.streaks.current;
        }
      } else if (outcome === 'negative') {
        m.streaks.current = 0;
      }

      m.lastUpdated = new Date().toISOString();
      return m;
    });
  }

  async _maybeAutoPrune() {
    // Auto-prune every 50 conversations
    const metrics = await this.getMetrics();
    if (metrics.totalConversations > 0 && metrics.totalConversations % 50 === 0) {
      const deactivated = await this.procedural.pruneUnderperformers();
      if (deactivated.length > 0) {
        console.log(`[LearningLoop] Auto-pruned ${deactivated.length} underperforming techniques`);
      }
    }
  }

  _genId() {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).substring(2, 6);
    return `ins_${ts}_${rand}`;
  }
}

export default LearningLoop;
