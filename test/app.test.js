import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createApp } from '../server/app.js';

const campaignConfig = JSON.parse(readFileSync(new URL('../config/campaign.json', import.meta.url)));
const ticket = id => createHmac('sha256', 'demo-entry-secret').update(`${campaignConfig.id}:${id}`).digest('base64url');

async function setup(t, options = {}) {
  const origin = 'http://localhost:3000';
  const app = await createApp({ origin, ...options });
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await app.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(path, data, cookie = '', requestOrigin = origin) {
    const response = await fetch(base + path, { method: data === undefined ? 'GET' : 'POST', headers: { Origin: requestOrigin, Cookie: cookie, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, body: response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  return { call, member: async () => (await call('/api/auth/demo', {})).cookie, staff: async id => (await call('/api/staff/login', { merchantId: id || '503-stationery', key: 'demo-staff' })).cookie };
}

test('a store QR ticket is required and each visitor can stamp a store once', async t => {
  const { call, member } = await setup(t), visitor = await member();
  assert.equal((await call('/api/stamps/collect', { merchantId: '503-stationery' }, visitor)).status, 403);
  assert.equal((await call('/api/stamps/collect', { merchantId: 'not-a-store', entry: 'bad' }, visitor)).status, 404);
  const first = await call('/api/stamps/collect', { merchantId: '503-stationery', entry: ticket('503-stationery') }, visitor);
  assert.equal(first.body.stamps.length, 1);
  const duplicate = await call('/api/stamps/collect', { merchantId: '503-stationery', entry: ticket('503-stationery') }, visitor);
  assert.equal(duplicate.body.stamps.length, 1);
});

test('three different store tickets grant one draw and a coupon redeems once', async t => {
  const { call, member, staff } = await setup(t), visitor = await member();
  for (const id of ['503-stationery', 'demo-cafe', 'demo-craft']) await call('/api/stamps/collect', { merchantId: id, entry: ticket(id) }, visitor);
  const draw = await call('/api/draw', {}, visitor);
  assert.equal(draw.status, 200); assert.ok(draw.body.qr.startsWith('data:image/png;base64,'));
  const code = draw.body.coupons[0].code, wrong = await staff('demo-cafe'), right = await staff('503-stationery');
  assert.equal((await call('/api/staff/coupons/lookup', { code }, wrong)).status, 403);
  const race = await Promise.all([call('/api/staff/coupons/redeem', { code }, right), call('/api/staff/coupons/redeem', { code }, right)]);
  assert.deepEqual(race.map(result => result.status).sort(), [200, 409]);
});

test('six stores grant two draw opportunities and cross-origin writes fail', async t => {
  const campaign = structuredClone(campaignConfig);
  for (const id of ['demo-food', 'demo-flower', 'demo-book']) campaign.merchants.push({ id, name: id, category: '展示', icon: '✦', color: 'sage', description: '', address: '', sample: true });
  const { call, member } = await setup(t, { campaign });
  const visitor = await member();
  const signed = id => createHmac('sha256', 'demo-entry-secret').update(`${campaign.id}:${id}`).digest('base64url');
  for (const item of campaign.merchants) await call('/api/stamps/collect', { merchantId: item.id, entry: signed(item.id) }, visitor);
  assert.equal((await call('/api/me', undefined, visitor)).body.availableDraws, 2);
  assert.equal((await call('/api/stamps/collect', { merchantId: '503-stationery', entry: signed('503-stationery') }, visitor, 'https://evil.example')).status, 403);
});

test('production rejects an unprepared sample campaign', async () => {
  await assert.rejects(() => createApp({ mode: 'production', origin: 'https://example.com', liffId: '123', channelId: '456', entrySigningSecret: 'secret' }), /上架資料|正式環境/);
});
