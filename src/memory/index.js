// src/memory/index.js — Memory Agent
// The unified interface that other Razor agents interact with.
// Orchestrates all five memory subsystems into a single coherent API.
// Integrates with the shared state machine — LEARNING state triggers reflection.

import EventEmitter from 'eventemitter3';
import { getStateMachine, States } from '../state/stateMachine.js';
import WorkingMemory from './working-memory.js';
import EpisodicMemory from './episodic-memory.js';
import SemanticMemory from './semantic-memory.js';
import ProceduralMemory from './procedural-memory.js';
import LearningLoop from './learning-loop.js';
import MemoryFile from './memory-file.js';

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_BASE_PATH = join(__dirname, '..', '..', 'data');

export class MemoryAgent extends EventEmitter {
  /**
   * @param {Object} [options]
   * @param {string} [options.basePath] — root directory for all memory storage
   * @param {boolean} [options.enableStateMachine=true] — wire into shared state machine
   */
  constructor(options = {}) {
    super();

    const basePath = options.basePath || DEFAULT_BASE_PATH;
    const enableStateMachine = options.enableStateMachine !== false;

    /** @type {WorkingMemory} — volatile current-conversation context */
    this.working = new WorkingMemory();

    /** @type {EpisodicMemory} — searchable conversation history */
    this.episodic = new EpisodicMemory(basePath);

    /** @type {SemanticMemory} — persistent knowledge graph */
    this.semantic = new SemanticMemory(basePath);

    /** @type {ProceduralMemory} — evolving sales playbook */
    this.procedural = new ProceduralMemory(basePath);

    /** @type {LearningLoop} — post-interaction learning */
    this.learning = new LearningLoop(basePath);

    /** @type {MemoryFile} — MEMORY.md file manager */
    this.memoryFile = new MemoryFile(basePath);

    this.basePath = basePath;

    // ── State Machine Integration ──
    // When the system enters LEARNING state, trigger the reflection cycle.
    // Other agents can push metadata.sessionAnalysis into the transition
    // to provide the LLM-generated analysis for the learning loop.
    if (enableStateMachine) {
      try {
        this.sm = getStateMachine();

        this.sm.onEnter(States.LEARNING, async (record) => {
          const analysis = record?.metadata?.sessionAnalysis;
          if (analysis) {
            try {
              const result = await this.endConversation(analysis);
              this.emit('memory:reflected', result);
            } catch (err) {
              console.error('[MemoryAgent] Reflection failed:', err.message);
            }
          }
          // Transition back to LISTENING after learning completes.
          // The async hook runs outside the synchronous transition lock,
          // so we can transition directly here.
          if (this.sm.getState().state === States.LEARNING) {
            this.sm.transition(States.LISTENING, 'learning_complete');
          }
        });

        // When transitioning to PROCESSING, log that a new interaction started
        this.sm.onEnter(States.PROCESSING, () => {
          if (!this.working.startedAt || this.working.turns.length === 0) {
            this.working.startedAt = Date.now();
          }
        });

        console.log('[MemoryAgent] Wired to state machine — LEARNING triggers reflection');
      } catch (err) {
        console.warn('[MemoryAgent] State machine not available:', err.message);
        this.sm = null;
      }
    } else {
      this.sm = null;
    }
  }

  // ═══════════════════════════════════════════════════════
  //  CONVERSATION LIFECYCLE
  // ═══════════════════════════════════════════════════════

  /**
   * Start a new conversation. Load context for the prospect/deal if known.
   * Call this when a new conversation begins.
   *
   * @param {Object} [context]
   * @param {string} [context.contactId]
   * @param {string} [context.dealId]
   * @param {string} [context.topic]
   * @returns {Promise<Object>} — preloaded context for the LLM
   */
  async startConversation(context = {}) {
    this.working.clear();
    this.working.startedAt = Date.now();

    const result = {
      workingContext: '',
      contactHistory: '',
      dealContext: null,
      suggestedTechniques: [],
      objectionHandles: [],
    };

    // Load contact context
    if (context.contactId) {
      const contact = await this.semantic.getContact(context.contactId);
      if (contact) {
        this.working.setProspect(contact);
      }
      result.contactHistory = await this.episodic.buildContactContext(context.contactId);
    }

    // Load deal context
    if (context.dealId) {
      const dealCtx = await this.semantic.buildDealContext(context.dealId);
      if (dealCtx) {
        this.working.setDeal(dealCtx.deal);
        result.dealContext = dealCtx;
      }
    }

    // Set topic
    if (context.topic) {
      this.working.currentTopic = context.topic;
    }

    // Get recommended techniques for this context
    const categories = ['opener', 'discovery'];
    for (const cat of categories) {
      const techniques = await this.procedural.recommend(cat, {
        industry: result.dealContext?.account?.industry,
        personaType: this.working.activeProspect?.personality,
        dealStage: this.working.activeDeal?.stage,
      });
      result.suggestedTechniques.push(...techniques.slice(0, 2));
    }

    result.workingContext = this.working.toContextString();

    this.emit('memory:recalled', { type: 'conversation_start', context });
    return result;
  }

  /**
   * Process a conversation turn. Updates working memory.
   * Call this on every message in the conversation.
   *
   * @param {string} role — 'user' | 'assistant' | 'system'
   * @param {string} content
   * @param {Object} [metadata]
   */
  addTurn(role, content, metadata = {}) {
    this.working.addTurn(role, content, metadata);
    this.emit('memory:stored', { tier: 'working', type: 'turn', role });
  }

  /**
   * End the current conversation. Triggers the full learning loop.
   * Call this when the conversation is over.
   *
   * @param {Object} analysis — LLM-generated analysis (see LearningLoop.processConversationEnd)
   * @returns {Promise<Object>} — learning results
   */
  async endConversation(analysis) {
    const snapshot = this.working.snapshot();

    // Run the learning loop
    const learningResult = await this.learning.processConversationEnd(snapshot, analysis);

    // Regenerate MEMORY.md
    await this.memoryFile.regenerate();

    // Clear working memory
    this.working.clear();

    this.emit('memory:reflected', learningResult);
    return learningResult;
  }

  // ═══════════════════════════════════════════════════════
  //  REAL-TIME ASSISTS (during conversation)
  // ═══════════════════════════════════════════════════════

  /**
   * Handle an objection in real-time. Searches procedural memory for the best response.
   * @param {string} objectionText
   * @returns {Promise<Object|null>}
   */
  async handleObjection(objectionText) {
    // Record in working memory
    if (this.working.activeProspect) {
      this.working.activeProspect.objections = this.working.activeProspect.objections || [];
      this.working.activeProspect.objections.push(objectionText);
    }

    return this.procedural.findObjectionHandle(objectionText);
  }

  /**
   * Get a technique recommendation for the current moment.
   * @param {string} category — 'closing' | 'discovery' | 'follow_up' | etc.
   * @param {string} [signal] — what triggered the need (e.g., "they asked about pricing")
   * @returns {Promise<Object[]>}
   */
  async suggestTechnique(category, signal = '') {
    return this.procedural.recommend(category, {
      industry: this.working.activeDeal?.industry,
      personaType: this.working.activeProspect?.personality,
      dealStage: this.working.activeDeal?.stage,
      signal,
    });
  }

  /**
   * Get the full current context string for LLM prompt injection.
   * Combines working memory + relevant semantic context.
   * @returns {string}
   */
  getContext() {
    return this.working.toContextString();
  }

  // ═══════════════════════════════════════════════════════
  //  QUERY & SEARCH
  // ═══════════════════════════════════════════════════════

  /**
   * Universal search across all memory subsystems.
   * @param {string} query
   * @returns {Promise<Object>}
   */
  async search(query) {
    const [episodes, contacts, accounts] = await Promise.all([
      this.episodic.search({ text: query, limit: 5 }),
      this.semantic.searchContacts(query),
      this.semantic.searchAccounts(query),
    ]);

    this.emit('memory:recalled', { type: 'search', query });
    return { episodes, contacts, accounts };
  }

  // ═══════════════════════════════════════════════════════
  //  MAINTENANCE
  // ═══════════════════════════════════════════════════════

  /**
   * Run archival: move episodes older than 60 days to archive.
   * @param {number} [daysOld=60]
   */
  async archive(daysOld = 60) {
    return this.episodic.archive(daysOld);
  }

  /**
   * Regenerate MEMORY.md from current state.
   */
  async refreshMemoryFile() {
    return this.memoryFile.regenerate();
  }

  /**
   * Get the current MEMORY.md contents.
   */
  async getMemoryFile() {
    return this.memoryFile.read();
  }

  /**
   * Run the full learning analysis — trends, recommendations, top techniques.
   */
  async analyze() {
    return this.learning.runAnalysis();
  }

  /**
   * Export the sales playbook as a formatted string.
   */
  async exportPlaybook() {
    return this.procedural.exportPlaybook();
  }

  /**
   * Get system stats.
   */
  async getStats() {
    const metrics = await this.learning.getMetrics();
    const memContent = await this.memoryFile.read();
    const memLines = memContent ? memContent.split('\n').length : 0;

    return {
      memoryFileLines: memLines,
      totalConversations: metrics.totalConversations,
      winRate: metrics.winRate,
      workingMemoryActive: this.working.turns.length > 0,
      workingMemoryTurns: this.working.turns.length,
      currentProspect: this.working.activeProspect?.name || null,
      currentDeal: this.working.activeDeal?.name || null,
    };
  }
}

// ═══════════════════════════════════════════════════════
//  NAMED EXPORTS for direct subsystem access
// ═══════════════════════════════════════════════════════

export { WorkingMemory } from './working-memory.js';
export { EpisodicMemory } from './episodic-memory.js';
export { SemanticMemory } from './semantic-memory.js';
export { ProceduralMemory } from './procedural-memory.js';
export { LearningLoop } from './learning-loop.js';
export { MemoryFile } from './memory-file.js';
export { Store } from './store.js';

export default MemoryAgent;
