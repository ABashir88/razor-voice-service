// tests/run.js — Integration test for the complete memory system
// Exercises: store → working → semantic → episodic → procedural → learning → MEMORY.md
// Usage: node tests/run.js

import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import MemoryAgent from '../src/memory/index.js';

let testDir;
let agent;
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    failed++;
  }
}

async function setup() {
  testDir = await mkdtemp(join(tmpdir(), 'razor-mem-test-'));
  agent = new MemoryAgent({ basePath: testDir, enableStateMachine: false });
}

async function teardown() {
  await rm(testDir, { recursive: true, force: true });
}

// ─── Tests ───────────────────────────────────────────────

async function testWorkingMemory() {
  console.log('\n── Working Memory ──');

  agent.working.clear();
  agent.addTurn('user', 'Hi, I want to discuss pricing');
  agent.addTurn('assistant', 'Sure, let me pull up your account');

  assert(agent.working.turns.length === 2, 'Tracks conversation turns');

  agent.working.setProspect({ id: 'c1', name: 'Jane Smith', title: 'VP Sales', company: 'Acme' });
  assert(agent.working.activeProspect.name === 'Jane Smith', 'Sets active prospect');

  agent.working.setDeal({ id: 'd1', name: 'Acme Enterprise', stage: 'negotiation', value: 50000 });
  assert(agent.working.activeDeal.stage === 'negotiation', 'Sets active deal');

  agent.working.addCommitment('Send revised pricing by Friday');
  assert(agent.working.commitments.length === 1, 'Records commitments');

  const ctx = agent.working.toContextString();
  assert(ctx.includes('Jane Smith'), 'Context string includes prospect');
  assert(ctx.includes('negotiation'), 'Context string includes deal stage');
  assert(ctx.includes('revised pricing'), 'Context string includes commitments');

  const snapshot = agent.working.snapshot();
  assert(snapshot.turnCount === 2, 'Snapshot captures turn count');
  assert(snapshot.activeProspect.name === 'Jane Smith', 'Snapshot captures prospect');
}

async function testSemanticMemory() {
  console.log('\n── Semantic Memory ──');

  // Contacts
  await agent.semantic.upsertContact({
    id: 'c1',
    name: 'Jane Smith',
    email: 'jane@acme.com',
    title: 'VP Sales',
    company: 'Acme Corp',
    accountId: 'a1',
    role: 'decision_maker',
    painPoints: ['slow onboarding'],
  });

  const contact = await agent.semantic.getContact('c1');
  assert(contact.name === 'Jane Smith', 'Stores and retrieves contact');
  assert(contact.role === 'decision_maker', 'Stores contact role');

  // Merge update
  await agent.semantic.upsertContact({
    id: 'c1',
    painPoints: ['reporting gaps'],
    personality: 'driver',
  });
  const updated = await agent.semantic.getContact('c1');
  assert(updated.painPoints.length === 2, 'Merge-updates arrays (union)');
  assert(updated.personality === 'driver', 'Merge-updates scalars');
  assert(updated.name === 'Jane Smith', 'Preserves existing fields on merge');

  // Accounts
  await agent.semantic.upsertAccount({
    id: 'a1',
    name: 'Acme Corp',
    industry: 'SaaS',
    size: 'mid_market',
    stage: 'opportunity',
    techStack: ['Salesforce', 'Slack'],
  });
  const acct = await agent.semantic.getAccount('a1');
  assert(acct.name === 'Acme Corp', 'Stores and retrieves account');

  // Deals
  await agent.semantic.upsertDeal({
    id: 'd1',
    name: 'Acme Enterprise',
    accountId: 'a1',
    contactId: 'c1',
    stage: 'negotiation',
    value: 50000,
  });
  const deal = await agent.semantic.getDeal('d1');
  assert(deal.value === 50000, 'Stores and retrieves deal');

  // Search
  const results = await agent.semantic.searchContacts('jane');
  assert(results.length === 1, 'Searches contacts by name');

  // Deal context builder
  const dealCtx = await agent.semantic.buildDealContext('d1');
  assert(dealCtx.contextString.includes('Acme Corp'), 'Deal context includes account');
  assert(dealCtx.contextString.includes('Jane Smith'), 'Deal context includes contacts');

  // Relationships
  await agent.semantic.setRelationship('c1', 'c2', 'reports_to');
  const rels = await agent.semantic.getRelationships('c1');
  assert(rels['c2']?.type === 'reports_to', 'Stores relationships');
}

async function testProceduralMemory() {
  console.log('\n── Procedural Memory ──');

  // Add techniques
  await agent.procedural.upsertTechnique({
    id: 'tech_opener_1',
    category: 'opener',
    name: 'Pain-First Opener',
    description: 'Lead with the prospects biggest pain point from prior research.',
    triggers: ['first call', 'cold outreach'],
    contexts: ['SaaS', 'mid_market'],
  });

  await agent.procedural.upsertTechnique({
    id: 'tech_close_1',
    category: 'closing',
    name: 'Assumptive Close',
    description: 'Assume the deal is happening, discuss implementation timeline.',
    triggers: ['positive signals', 'asked about onboarding'],
  });

  // Record usage
  await agent.procedural.recordUsage('tech_opener_1', true);
  await agent.procedural.recordUsage('tech_opener_1', true);
  await agent.procedural.recordUsage('tech_opener_1', false);

  const techs = await agent.procedural.getTechniques('opener');
  const opener = techs.find(t => t.id === 'tech_opener_1');
  assert(opener.timesUsed === 3, 'Tracks usage count');
  assert(Math.abs(opener.successRate - 0.67) < 0.01, 'Calculates success rate');

  // Recommendations
  const recs = await agent.procedural.recommend('opener', {
    industry: 'SaaS',
    dealStage: 'discovery',
  });
  assert(recs.length > 0, 'Returns technique recommendations');
  assert(recs[0].name === 'Pain-First Opener', 'Ranks by relevance + success');

  // Objection handles
  await agent.procedural.upsertObjectionHandle({
    id: 'obj_price',
    objection: 'Your product is too expensive',
    responses: [
      'I understand. Let me show you the ROI our similar-sized customers see.',
      'What budget range were you expecting?',
    ],
    contexts: ['negotiation'],
  });

  const handle = await agent.procedural.findObjectionHandle('this is way too expensive for us');
  assert(handle !== null, 'Finds matching objection handle');
  assert(handle?.bestResponse?.includes('ROI') || handle?.bestResponse?.includes('budget'), 'Returns best response');

  // Playbook export
  const playbook = await agent.procedural.exportPlaybook();
  assert(playbook.includes('Pain-First Opener'), 'Exports playbook with techniques');
  assert(playbook.includes('too expensive'), 'Exports playbook with objections');
}

async function testEpisodicMemory() {
  console.log('\n── Episodic Memory ──');

  const ep1 = await agent.episodic.store({
    timestamp: Date.now() - 86400000, // yesterday
    topic: 'pricing_discussion',
    outcome: 'positive',
    contactId: 'c1',
    accountId: 'a1',
    dealId: 'd1',
    summary: 'Discussed enterprise pricing. Jane was receptive to the annual plan.',
    keyFacts: ['Prefers annual billing', 'Budget approved for Q1'],
    commitments: ['Send revised proposal by Friday'],
    tags: ['pricing', 'enterprise', 'annual'],
  });
  assert(ep1.id.startsWith('ep_'), 'Stores episode with ID');

  await agent.episodic.store({
    timestamp: Date.now(),
    topic: 'demo',
    outcome: 'positive',
    contactId: 'c1',
    accountId: 'a1',
    dealId: 'd1',
    summary: 'Product demo went well. Jane loved the reporting dashboard.',
    keyFacts: ['Impressed by analytics', 'Wants integration with Salesforce'],
    commitments: ['Schedule technical deep-dive'],
    tags: ['demo', 'product'],
  });

  // Search
  const results = await agent.episodic.search({ contactId: 'c1' });
  assert(results.length === 2, 'Searches episodes by contact');

  const textResults = await agent.episodic.search({ text: 'annual billing' });
  assert(textResults.length >= 1, 'Searches episodes by text');

  // Contact history
  const history = await agent.episodic.buildContactContext('c1');
  assert(history.includes('pricing_discussion'), 'Builds contact history context');

  // Recent
  const recent = await agent.episodic.getRecent(1);
  assert(recent.length === 1, 'Gets recent episodes');
  assert(recent[0].topic === 'demo', 'Most recent first');
}

async function testLearningLoop() {
  console.log('\n── Learning Loop ──');

  // Simulate ending a conversation
  agent.working.clear();
  agent.working.setProspect({ id: 'c1', name: 'Jane Smith' });
  agent.working.setDeal({ id: 'd1', name: 'Acme Enterprise', accountId: 'a1', stage: 'negotiation', value: 50000 });
  agent.addTurn('user', 'What about the price?');
  agent.addTurn('assistant', 'Let me walk through the ROI...');

  const snapshot = agent.working.snapshot();

  const result = await agent.learning.processConversationEnd(snapshot, {
    topic: 'negotiation',
    outcome: 'positive',
    summary: 'Successfully navigated pricing objection using ROI approach.',
    keyFacts: ['Responded well to ROI framing', 'Mentioned Q1 budget deadline'],
    commitments: ['Send ROI calculator'],
    tags: ['pricing', 'objection_handled'],
    techniquesUsed: [{ id: 'tech_opener_1', worked: true }],
    objectionsEncountered: [{
      text: 'This seems expensive',
      handleUsed: { id: 'obj_price', responseIndex: 0 },
      worked: true,
    }],
    contactUpdates: { preferences: ['ROI-driven discussions'] },
    newPatterns: [{
      description: 'ROI framing works well with driver personalities in negotiation',
      category: 'closing',
      trigger: 'price objection from driver personality',
    }],
  });

  assert(result.episodeId.startsWith('ep_'), 'Creates episode from conversation');
  assert(result.insightsGenerated >= 2, 'Generates learning insights');

  // Check that technique stats were updated
  const techs = await agent.procedural.getTechniques('opener');
  const opener = techs.find(t => t.id === 'tech_opener_1');
  assert(opener.timesUsed === 4, 'Learning loop updates technique stats');

  // Check metrics
  const metrics = await agent.learning.getMetrics();
  assert(metrics.totalConversations >= 1, 'Updates aggregate metrics');

  // Run analysis
  const analysis = await agent.learning.runAnalysis();
  assert(analysis.metrics !== null, 'Runs learning analysis');
  assert(Array.isArray(analysis.recommendations), 'Produces recommendations');
}

async function testMemoryFile() {
  console.log('\n── MEMORY.md ──');

  const result = await agent.memoryFile.regenerate();
  assert(result.lines <= 200, `Under 200 lines (got ${result.lines})`);
  assert(result.sections.length >= 2, 'Has multiple sections');

  const content = await agent.memoryFile.read();
  assert(content.includes('RAZOR MEMORY'), 'Has header');
  assert(content.includes('Acme'), 'Contains account data');
}

async function testUnifiedSearch() {
  console.log('\n── Unified Search ──');

  const results = await agent.search('Jane');
  assert(results.contacts.length >= 1, 'Finds contacts');
  assert(results.episodes.length >= 1, 'Finds episodes');
}

async function testConversationLifecycle() {
  console.log('\n── Full Conversation Lifecycle ──');

  // Start
  const ctx = await agent.startConversation({
    contactId: 'c1',
    dealId: 'd1',
    topic: 'follow_up',
  });
  assert(ctx.workingContext.includes('Jane'), 'Preloads prospect context');
  assert(ctx.contactHistory.length > 0, 'Preloads contact history');

  // During conversation
  agent.addTurn('user', 'Can you match the competitor price?');
  const objHandle = await agent.handleObjection('Can you match the competitor price?');
  // May or may not match — depends on fuzzy matching

  const techniques = await agent.suggestTechnique('closing', 'asked about competitor pricing');
  assert(Array.isArray(techniques), 'Suggests techniques during conversation');

  // End
  const endResult = await agent.endConversation({
    topic: 'competitive_pricing',
    outcome: 'follow_up',
    summary: 'Prospect asked about competitor pricing. Committed to comparison doc.',
    keyFacts: ['Evaluating competitor X'],
    commitments: ['Send comparison document by Monday'],
    tags: ['competitive', 'pricing'],
  });
  assert(endResult.episodeId.startsWith('ep_'), 'End conversation stores episode');
  assert(agent.working.turns.length === 0, 'Clears working memory after end');
}

// ─── Run ─────────────────────────────────────────────────

async function run() {
  console.log('═══ Razor Memory Agent — Integration Tests ═══');

  await setup();

  try {
    await testWorkingMemory();
    await testSemanticMemory();
    await testProceduralMemory();
    await testEpisodicMemory();
    await testLearningLoop();
    await testMemoryFile();
    await testUnifiedSearch();
    await testConversationLifecycle();

    console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══`);
    process.exit(failed > 0 ? 1 : 0);
  } catch (err) {
    console.error('\nFATAL ERROR:', err);
    process.exit(1);
  } finally {
    await teardown();
  }
}

run();
