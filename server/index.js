import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createApp } from './app.js';

const mode = process.env.APP_MODE || 'demo';
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const origin = process.env.APP_ORIGIN || `http://localhost:${port}`;
const dbPath = process.env.DATABASE_PATH || './data/passport.sqlite';
if (mode === 'demo' && (!['127.0.0.1', '::1', 'localhost'].includes(host) || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname))) {
  throw new Error('Demo must bind to localhost and use a localhost APP_ORIGIN.');
}
if (mode === 'preview' && !['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Preview must bind to localhost.');
mkdirSync(dirname(dbPath), { recursive: true });
const app = createApp({ mode, origin, dbPath, liffId: process.env.LIFF_ID || '', channelId: process.env.LINE_LOGIN_CHANNEL_ID || '', mainOaId: process.env.MAIN_OA_ID || '', staffCredentials: JSON.parse(process.env.STAFF_CREDENTIALS_JSON || '{}'), merchantLogins: JSON.parse(process.env.MERCHANT_LINE_LOGINS_JSON || '{}'), previewPassword: process.env.PREVIEW_PASSWORD || '' });
const server = createServer(app.handler);
server.listen(port, host, () => console.log(`Homei passport (${mode}): ${origin}\nStaff console: ${origin}/staff`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => { app.close(); process.exit(0); }));
