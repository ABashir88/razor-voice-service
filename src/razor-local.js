import { spawn } from 'child_process';
import { FellowVoiceHandler } from './fellow-voice-handler.js';

class RazorLocal {
  constructor() {
    this.fellowHandler = null;
  }

  async initialize() {
    this.fellowHandler = new FellowVoiceHandler({
      apiKey: process.env.FELLOW_API_KEY || 'a91418aafd74d89399a7c78aa322e54b5eadffd96fc10bbc5fd4e24df6bce363',
      subdomain: process.env.FELLOW_SUBDOMAIN || 'telnyx',
      userName: 'Alrazi Bashir'
    });
    await this.fellowHandler.connect();
    console.log('✅ Fellow connected');
  }

  // Speak through Mac/Bluetooth speaker
  speak(text) {
    return new Promise((resolve) => {
      console.log(`🔊 Speaking: "${text.substring(0, 80)}..."`);
      const say = spawn('say', ['-v', 'Samantha', '-r', '190', text]);
      say.on('close', resolve);
    });
  }

  // Process voice command
  async processCommand(input) {
    console.log(`\n🎤 Command: "${input}"`);
    
    try {
      const result = await this.fellowHandler.handleVoiceCommand(input);
      
      if (result.error) {
        await this.speak(result.error);
      } else if (result.speech) {
        await this.speak(result.speech);
      }
      
      return result;
    } catch (err) {
      console.error('Error:', err.message);
      await this.speak('Sorry, something went wrong.');
    }
  }

  // Interactive test mode
  startInteractive() {
    console.log('\n🎙️  RAZOR LOCAL - Type commands or say them to your speaker');
    console.log('Examples:');
    console.log('  - "Razor, what are my action items?"');
    console.log('  - "Razor, how did my last call go?"');
    console.log('  - "Razor, what recordings do I have?"');
    console.log('\nType "quit" to exit\n');

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', async (data) => {
      const input = data.trim();
      if (input.toLowerCase() === 'quit') {
        await this.shutdown();
        process.exit(0);
      }
      if (input) {
        await this.processCommand(input);
        console.log('\n> Ready for next command...');
      }
    });
  }

  async shutdown() {
    if (this.fellowHandler) {
      await this.fellowHandler.disconnect();
    }
    console.log('👋 Razor shutdown');
  }
}

// Start
const razor = new RazorLocal();
razor.initialize().then(() => {
  razor.speak('Razor is ready').then(() => {
    razor.startInteractive();
  });
}).catch(err => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});

export { RazorLocal };
