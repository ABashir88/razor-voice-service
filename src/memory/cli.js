#!/usr/bin/env node
// src/cli.js — CLI for memory maintenance operations
// Usage: node src/cli.js <command>
// Commands: compact, archive, stats, export-playbook, analyze, regenerate

import MemoryAgent from './index.js';
const agent = new MemoryAgent();
const command = process.argv[2];

async function main() {
  switch (command) {
    case 'compact':
    case 'regenerate': {
      const result = await agent.refreshMemoryFile();
      console.log(`✓ MEMORY.md regenerated: ${result.lines} lines`);
      console.log(`  Sections: ${result.sections.join(', ')}`);
      break;
    }

    case 'archive': {
      const days = parseInt(process.argv[3]) || 60;
      const result = await agent.archive(days);
      console.log(`✓ Archived ${result.archived} episodes (${result.remaining} remaining)`);
      break;
    }

    case 'stats': {
      const stats = await agent.getStats();
      console.log('── Razor Memory Stats ──');
      console.log(`  MEMORY.md: ${stats.memoryFileLines} lines`);
      console.log(`  Total conversations: ${stats.totalConversations}`);
      console.log(`  Win rate: ${Math.round((stats.winRate || 0) * 100)}%`);
      console.log(`  Working memory active: ${stats.workingMemoryActive}`);
      if (stats.currentProspect) console.log(`  Current prospect: ${stats.currentProspect}`);
      if (stats.currentDeal) console.log(`  Current deal: ${stats.currentDeal}`);
      break;
    }

    case 'export-playbook': {
      const playbook = await agent.exportPlaybook();
      console.log(playbook);
      break;
    }

    case 'analyze': {
      const analysis = await agent.analyze();
      console.log('── Learning Analysis ──');
      console.log(`  Total conversations: ${analysis.metrics.totalConversations}`);
      console.log(`  Win rate: ${Math.round((analysis.metrics.winRate || 0) * 100)}%`);
      console.log(`  Recent insights: ${analysis.insightCount}`);

      if (analysis.topTechniques.length) {
        console.log('\n  Top techniques:');
        for (const t of analysis.topTechniques) {
          console.log(`    ${t.name} [${t.category}] — ${Math.round(t.successRate * 100)}% (${t.uses} uses)`);
        }
      }

      if (analysis.recommendations.length) {
        console.log('\n  Recommendations:');
        for (const r of analysis.recommendations) {
          console.log(`    ⚠ ${r.type}: ${r.reason}`);
        }
      }
      break;
    }

    default:
      console.log('Usage: node src/cli.js <command>');
      console.log('Commands:');
      console.log('  compact / regenerate  — Regenerate MEMORY.md');
      console.log('  archive [days]        — Archive episodes older than N days (default: 60)');
      console.log('  stats                 — Show system statistics');
      console.log('  export-playbook       — Print the full sales playbook');
      console.log('  analyze               — Run learning analysis with recommendations');
      process.exit(1);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
