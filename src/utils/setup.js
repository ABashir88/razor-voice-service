// src/utils/setup.js – Verify all system dependencies are installed
//
// Usage: npm run setup

import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);

const CHECKS = [
  {
    name: 'sox',
    cmd: ['sox', ['--version']],
    install: 'brew install sox',
    required: true,
  },
  {
    name: 'afplay',
    cmd: ['afplay', ['--help']],
    install: 'Built into macOS',
    required: true,
    expectFail: true, // afplay --help returns non-zero but still works
  },
  {
    name: 'blueutil',
    cmd: ['blueutil', ['--version']],
    install: 'brew install blueutil',
    required: true,
  },
  {
    name: 'SwitchAudioSource',
    cmd: ['SwitchAudioSource', ['-c']],
    install: 'brew install switchaudio-osx',
    required: true,
  },
  {
    name: 'Node.js >= 20',
    cmd: ['node', ['--version']],
    install: 'brew install node@20',
    required: true,
    validate: (stdout) => {
      const major = parseInt(stdout.trim().replace('v', ''));
      return major >= 20;
    },
  },
];

async function checkTool({ name, cmd, install, required, expectFail, validate }) {
  try {
    const { stdout } = await exec(cmd[0], cmd[1]);
    if (validate && !validate(stdout)) {
      return { name, ok: false, msg: `Version check failed`, install };
    }
    return { name, ok: true, msg: stdout.trim().slice(0, 60) };
  } catch (err) {
    if (expectFail) {
      return { name, ok: true, msg: '(exists)' };
    }
    return { name, ok: false, msg: err.message.slice(0, 60), install, required };
  }
}

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  Razor Voice Service – Setup Check');
  console.log('═══════════════════════════════════════════\n');

  let allOk = true;

  for (const check of CHECKS) {
    const result = await checkTool(check);
    const icon = result.ok ? '✅' : '❌';
    console.log(`  ${icon} ${result.name}: ${result.msg}`);
    if (!result.ok) {
      console.log(`     Install: ${result.install}`);
      if (result.required) allOk = false;
    }
  }

  // Check .env file
  console.log('');
  const { existsSync } = await import('fs');
  const { join } = await import('path');
  const envPath = join(process.cwd(), '.env');
  if (existsSync(envPath)) {
    console.log('  ✅ .env file found');
  } else {
    console.log('  ⚠️  No .env file — copy .env.example to .env and fill in your keys');
    console.log('     cp .env.example .env');
  }

  // Check models directory
  const modelsDir = join(process.cwd(), 'models');
  if (existsSync(modelsDir)) {
    console.log('  ✅ models/ directory exists');
  } else {
    console.log('  ℹ️  No models/ directory (needed for Porcupine custom wake word)');
    console.log('     mkdir models');
  }

  console.log('');
  if (allOk) {
    console.log('  ✅ All required dependencies are installed!');
    console.log('  Run: npm start');
  } else {
    console.log('  ❌ Some required dependencies are missing.');
    console.log('  Install them and run: npm run setup');
  }
  console.log('');
}

main().catch(console.error);
