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

  // Notifications via OpenClaw → Telegram (leave either empty to disable)
  openclawBin: process.env.OPENCLAW_BIN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',

  // tmux
  tmuxSessionPrefix: 'cc-',

  // AI summaries via DeepSeek (OpenAI-compatible API)
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || '',
  deepseekBaseUrl: 'https://api.deepseek.com/v1',
  deepseekModel: 'deepseek-chat',

  // Auto-approve permissions: tool names that get silently approved
  autoApproveTools: (process.env.CC_AUTO_APPROVE_TOOLS || 'Read,Glob,Grep,WebFetch,WebSearch,LS').split(',').map(t => t.trim()).filter(Boolean),
  // Auto-approve Bash: commands matching this prefix pattern are silently approved
  autoApproveBashPattern: '^(ls|ll|find|tree|cat|head|tail|wc|grep|rg|git\\s+(status|log|diff|show|branch|stash\\s+list|remote\\s+-v)|ps|df|du|free|uname|hostname|echo|pwd|which|date|printenv|env)(\\s|$)',
};

// Ensure data directory exists
mkdirSync(dirname(config.dbPath), { recursive: true });

export default config;
