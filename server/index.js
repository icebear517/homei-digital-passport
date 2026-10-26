import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createApp } from './app.js';
import { SheetCampaignSync } from './sheet-campaign.js';

const mode = process.env.APP_MODE || 'demo';
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const origin = process.env.APP_ORIGIN || `http://localhost:${port}`;
const dbPath = process.env.DATABASE_PATH || './data/passport.sqlite';
if (mode === 'demo' && (!['127.0.0.1', '::1', 'localhost'].includes(host) || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname))) {
  throw new Error('Demo must bind to localhost and use a localhost APP_ORIGIN.');
}
if (mode === 'preview' && !['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Preview must bind to localhost.');
if (!process.env.DATABASE_URL) mkdirSync(dirname(dbPath), { recursive: true });
const sheetSync = mode === 'production' ? new SheetCampaignSync({ spreadsheetId: process.env.GOOGLE_SHEET_ID || '' }) : null;
const app = await createApp({
  mode, origin, dbPath, databaseUrl: process.env.DATABASE_URL || '', liffId: process.env.LIFF_ID || '', staffLiffId: process.env.STAFF_LIFF_ID || '', channelId: process.env.LINE_LOGIN_CHANNEL_ID || '',
  entrySigningSecret: process.env.ENTRY_SIGNING_SECRET || '', staffCredentials: JSON.parse(process.env.STAFF_CREDENTIALS_JSON || '{}'), sheetSync,
});
if (sheetSync) {
  const summary = await app.syncCampaign();
  console.log(`Google Sheet synced: ${summary.merchants} shops, ${summary.prizes} prizes`);
  setInterval(() => app.syncCampaign().then(summary => console.log(`Google Sheet synced: ${summary.merchants} shops, ${summary.prizes} prizes`)).catch(error => console.error('Google Sheet sync failed:', error.message)), 5 * 60_000).unref();
}
const server = createServer(app.handler);
server.listen(port, host, () => console.log(`Homei passport (${mode}): ${origin}\nStaff console: ${origin}/staff`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(async () => { await app.close(); process.exit(0); }));
