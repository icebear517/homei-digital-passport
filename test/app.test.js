import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createApp } from '../server/app.js';

const campaignConfig = JSON.parse(readFileSync(new URL('../config/campaign.json', import.meta.url)));

async function setup(t, options = {}) {
  const origin = 'http://localhost:3000';
  const app = createApp({ origin, ...options });
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); app.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(path, data, cookie = '', requestOrigin = origin) {
    const response = await fetch(base + path, { method: data === undefined ? 'GET' : 'POST', headers: { Origin: requestOrigin, Cookie: cookie, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, body: response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  return { call, member: async () => (await call('/api/auth/demo', {})).cookie, staff: async id => (await call('/api/staff/login', { merchantId: id || '503-stationery', key: 'demo-staff' })).cookie };
}

test('each member can collect each store only once and needs three different stores to draw', async t => {
  const { call, member } = await setup(t), visitor = await member();
  assert.equal((await call('/api/stamps/collect', { merchantId: '503-stationery' }, visitor)).body.stamps.length, 1);
  assert.equal((await call('/api/stamps/collect', { merchantId: '503-stationery' }, visitor)).body.stamps.length, 1);
  assert.equal((await call('/api/draw', {}, visitor)).status, 403);
  for (const id of ['demo-cafe', 'demo-craft']) await call('/api/stamps/collect', { merchantId: id }, visitor);
  assert.equal((await call('/api/me', undefined, visitor)).body.stamps.length, 3);
});

test('draw creates a stored QR coupon once and only its eligible store can redeem it', async t => {
  const { call, member, staff } = await setup(t), visitor = await member();
  for (const id of ['503-stationery', 'demo-cafe', 'demo-craft']) await call('/api/stamps/collect', { merchantId: id }, visitor);
  const draw = await call('/api/draw', {}, visitor);
  assert.equal(draw.status, 200); assert.ok(draw.body.qr.startsWith('data:image/png;base64,'));
  const code = draw.body.coupons[0].code;
  assert.equal((await call('/api/coupon/qr', { code }, visitor)).body.qr.startsWith('data:image/png;base64,'), true);
  assert.equal((await call('/api/draw', {}, visitor)).status, 403);
  const wrong = await staff('demo-cafe'), right = await staff('503-stationery');
  assert.equal((await call('/api/staff/coupons/lookup', { code }, wrong)).status, 403);
  assert.equal((await call('/api/staff/coupons/lookup', { code }, right)).body.prize.length > 0, true);
  const race = await Promise.all([call('/api/staff/coupons/redeem', { code }, right), call('/api/staff/coupons/redeem', { code }, right)]);
  assert.deepEqual(race.map(item => item.status).sort(), [200, 409]);
  assert.ok((await call('/api/me', undefined, visitor)).body.coupons[0].usedAt);
});

test('members cannot redeem, forged stores do not stamp, and cross-origin writes fail', async t => {
  const { call, member } = await setup(t), visitor = await member();
  assert.equal((await call('/api/stamps/collect', { merchantId: 'not-a-store' }, visitor)).status, 404);
  assert.equal((await call('/api/staff/coupons/redeem', { code: 'forged' }, visitor)).status, 401);
  assert.equal((await call('/api/stamps/collect', { merchantId: '503-stationery' }, visitor, 'https://evil.example')).status, 403);
  assert.equal((await call('/api/staff/login', { merchantId: '503-stationery', key: 'wrong' })).status, 401);
});

test('six different stores grant two draw opportunities', async t => {
  const campaign = structuredClone(campaignConfig);
  for (const id of ['demo-food', 'demo-flower', 'demo-book']) campaign.merchants.push({ id, name: id, category: '展示', icon: '✦', color: 'sage', description: '', address: '', hasLineOA: false, sample: true });
  const { call, member } = await setup(t, { campaign });
  const visitor = await member();
  for (const item of campaign.merchants) await call('/api/stamps/collect', { merchantId: item.id }, visitor);
  assert.equal((await call('/api/me', undefined, visitor)).body.availableDraws, 2);
  await call('/api/draw', {}, visitor);
  assert.equal((await call('/api/me', undefined, visitor)).body.availableDraws, 1);
  await call('/api/draw', {}, visitor);
  const state = await call('/api/me', undefined, visitor);
  assert.equal(state.body.availableDraws, 0);
  assert.equal(state.body.coupons.length, 2);
});

test('production rejects sample campaign data', () => {
  assert.throws(() => createApp({ mode: 'production', origin: 'https://example.com', liffId: '123', channelId: '456' }), /sample campaign/);
});
