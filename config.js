import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Environment variables are loaded via Node's --env-file=.env flag in package.json scripts.
// If running directly (node server.js), set variables in your shell or use: node --env-file=.env server.js

const config = {
  // Server
  port: parseInt(process.env.CC_PORT || '7700', 10),
  host: process.env.CC_HOST || '0.0.0.0',

  // Database
  dbPath: process.env.CC_DB_PATH || './data/control-center.sqlite',

  // PTY
  ptyGracePeriodMs: 30_000,      // Keep PTY alive 30s after last client disconnects
  scrollbackBufferSize: 50_000,  // Characters of scrollback to replay on connect

  // OpenClaw (optional — leave token empty to disable notifications)
  openclawUrl: process.env.OPENCLAW_URL || 'http://127.0.0.1:18789/v1/responses',
  openclawToken: process.env.OPENCLAW_TOKEN || '',
  openclawAgent: process.env.OPENCLAW_AGENT || 'main',

  // tmux
  tmuxSessionPrefix: 'cc-',
};

// Ensure data directory exists
mkdirSync(dirname(config.dbPath), { recursive: true });

export default config;
