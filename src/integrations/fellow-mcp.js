/**
 * Fellow MCP Client
 * Connects to Fellow's MCP server via SSE transport
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('fellow-mcp');

export class FellowMCPClient {
  constructor(apiKey) {
    if (!apiKey) throw new Error('FellowMCPClient requires an API key');
    this.apiKey = apiKey;
    this.client = null;
    this.connected = false;
    this.tools = [];
  }

  async connect() {
    if (this.connected) return;

    const url = new URL('https://fellow.app/mcp');
    url.searchParams.set('api_key', this.apiKey);

    const transport = new SSEClientTransport(url);
    this.client = new Client({ name: 'razor-voice', version: '1.0.0' }, { capabilities: {} });

    await this.client.connect(transport);
    this.connected = true;

    // Discover available tools
    const { tools } = await this.client.listTools();
    this.tools = tools;
    log.info(`Fellow MCP connected. Available tools: ${tools.map(t => t.name).join(', ')}`);

    return this.tools;
  }

  async callTool(name, args = {}) {
    if (!this.connected) await this.connect();

    try {
      const result = await this.client.callTool({ name, arguments: args });
      return result.content;
    } catch (err) {
      log.error(`Tool ${name} failed:`, err.message);
      throw err;
    }
  }

  // Convenience methods
  async getActionItems(opts = {}) {
    return this.callTool('get_action_items', opts);
  }

  async getMeetings(opts = {}) {
    return this.callTool('get_meetings', opts);
  }

  async searchNotes(query) {
    return this.callTool('search_notes', { query });
  }

  async close() {
    if (this.client) {
      await this.client.close();
      this.connected = false;
    }
  }
}

export function createFellowMCPClient(config) {
  const apiKey = config?.fellow?.apiKey || process.env.FELLOW_API_KEY;
  if (!apiKey) {
    log.info('Fellow MCP: missing API key — client disabled');
    return null;
  }
  return new FellowMCPClient(apiKey);
}
