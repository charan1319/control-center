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
  scrollbackBufferSize: 300_000, // Characters of scrollback to replay on connect (history + live)

  // tmux
  tmuxSessionPrefix: 'cc-',

  // AI summaries via DeepSeek (OpenAI-compatible API)
  // Set CC_AI_SUMMARY=false in .env to disable without removing the key
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || '',
  deepseekBaseUrl: 'https://api.deepseek.com/v1',
  deepseekModel: 'deepseek-chat',
  aiSummaryEnabled: process.env.CC_AI_SUMMARY !== 'false',

  // Auto-approve permissions: tool names that get silently approved
  autoApproveTools: (process.env.CC_AUTO_APPROVE_TOOLS || 'Read,Glob,Grep,WebFetch,WebSearch,LS').split(',').map(t => t.trim()).filter(Boolean),

  // Session cleanup: auto-delete stopped sessions older than N days (0 = disabled)
  sessionCleanupDays: parseInt(process.env.CC_SESSION_CLEANUP_DAYS || '7', 10),

  // Web Push (PWA notifications) — requires HTTPS (Tailscale Serve)
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || '',
  vapidEmail: process.env.VAPID_EMAIL || '',
  pushEnabled: !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY),
  // Auto-approve Bash: commands matching this prefix pattern are silently approved
  autoApproveBashPattern: '^(ls|ll|find|tree|cat|head|tail|wc|grep|rg|python[0-9.]*|git\\s+(status|log|diff|show|branch|stash\\s+list|remote\\s+-v)|ps|df|du|free|uname|hostname|echo|pwd|which|date|printenv|env)(\\s|$)',

  // Usage stats — disable with CC_TELEMETRY=false in .env
  telemetryEnabled: process.env.CC_TELEMETRY !== 'false',
  telemetryUrl: 'https://script.google.com/macros/s/AKfycbxn6CpA0OA04C095757DIkFhT13z5E4B0Eddhf44SdcmHdTwDE9RYrENUgj5PpJtETc/exec',
};

// Ensure data directory exists
mkdirSync(dirname(config.dbPath), { recursive: true });

export default config;
