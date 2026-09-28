import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createApp } from '../server/app.js';

const sample = JSON.parse(readFileSync(new URL('../config/campaign.json', import.meta.url)));
async function setup(t, options = {}) {
  const origin = 'http://localhost:3000';
  const app = createApp({ origin, ...options });
  const server = createServer(app.handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); app.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(path, data, cookie = '', customOrigin = options.origin || origin) {
    const response = await fetch(base + path, { method: data === undefined ? 'GET' : 'POST', headers: { Origin: customOrigin, Cookie: cookie, 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  async function member() { return (await call('/api/auth/demo', {})).cookie; }
  async function staff(id = 'sample-cafe') { return (await call('/api/staff/login', { merchantId: id, key: 'demo-staff' })).cookie; }
  const callback = async (query, cookie = '') => {
    const response = await fetch(`${base}/auth/merchant/callback?${new URLSearchParams(query)}`, { headers: { Cookie: cookie }, redirect: 'manual' });
    return { status: response.status, location: response.headers.get('location') };
  };
  return { call, member, staff, callback };
}

test('only staff can issue; member cannot self-award using merchant ID or a forged token', async t => {
  const { call, member } = await setup(t);
  const cookie = await member();
  assert.equal((await call('/api/staff/vouchers', {}, cookie)).status, 401);
  assert.equal((await call('/api/stamps/claim', { merchantId: 'sample-cafe', token: 'forged' }, cookie)).status, 409);
  assert.equal((await call('/api/me', undefined, cookie)).body.stamps.length, 0);
});

test('eco voucher is single-use and daily limit spans merchants without awarding a store stamp', async t => {
  const { call, member, staff } = await setup(t);
  const visitor = await member(), shop = await staff();
  const first = (await call('/api/staff/vouchers', { tasks: ['reusable-cup'] }, shop)).body;
  assert.ok(first.qr.startsWith('data:image/png;base64,'));
  assert.equal(new URL(first.url).searchParams.get('shop'), 'sample-cafe');
  const race = await Promise.all([call('/api/stamps/claim', { token: first.token }, visitor), call('/api/stamps/claim', { token: first.token }, visitor)]);
  assert.deepEqual(race.map(item => item.status).sort(), [200, 409]);
  const otherShop = await staff('sample-food');
  const second = (await call('/api/staff/vouchers', { tasks: ['reusable-cup'] }, otherShop)).body;
  assert.equal((await call('/api/stamps/claim', { token: second.token }, visitor)).status, 409);
  const state = (await call('/api/me', undefined, visitor)).body;
  assert.equal(state.stamps.length, 0);
  assert.equal(state.ecoPoints, 1);
});

test('expired QR, cross-origin writes and invalid staff keys are rejected', async t => {
  let time = Date.now();
  const { call, member, staff } = await setup(t, { now: () => time });
  const visitor = await member(), shop = await staff();
  const token = (await call('/api/staff/vouchers', { tasks: ['moovo'] }, shop)).body.token;
  time += 120_001;
  assert.equal((await call('/api/stamps/claim', { token }, visitor)).status, 409);
  assert.equal((await call('/api/staff/vouchers', {}, shop, 'https://evil.example')).status, 403);
  assert.equal((await call('/api/staff/login', { merchantId: 'sample-cafe', key: 'wrong' })).status, 401);
});

test('redemption requires threshold, permitted staff, and atomic one-time redemption', async t => {
  const { call, member, staff } = await setup(t);
  const visitor = await member();
  assert.equal((await call('/api/rewards/request', { rewardId: 'sample-gift' }, visitor)).status, 403);
  for (const id of sample.merchants.map(m => m.id)) {
    assert.equal((await call('/api/demo/friendship', { merchantId: id, friend: true }, visitor)).status, 200);
  }
  const first = (await call('/api/rewards/request', { rewardId: 'sample-gift' }, visitor)).body.token;
  const token = (await call('/api/rewards/request', { rewardId: 'sample-gift' }, visitor)).body.token;
  const correctShop = await staff(), wrongShop = await staff('sample-craft');
  assert.equal((await call('/api/staff/rewards/lookup', { token: first }, correctShop)).status, 409);
  assert.equal((await call('/api/staff/rewards/redeem', { token }, wrongShop)).status, 403);
  assert.equal((await call('/api/staff/rewards/redeem', { token }, visitor)).status, 401);
  assert.equal((await call('/api/staff/rewards/lookup', { token }, correctShop)).body.reward, '和美小心意');
  const race = await Promise.all([call('/api/staff/rewards/redeem', { token }, correctShop), call('/api/staff/rewards/redeem', { token }, correctShop)]);
  assert.deepEqual(race.map(item => item.status).sort(), [200, 409]);
  assert.equal((await call('/api/rewards/request', { rewardId: 'sample-gift' }, visitor)).status, 409);
  const state = (await call('/api/me', undefined, visitor)).body;
  assert.equal(state.redemptions.length, 1);
  assert.equal(state.stamps.length, 3);
});

test('demo distinguishes non-friends, friends and duplicate awards; URL or client flags do not award', async t => {
  const { call, member } = await setup(t);
  const visitor = await member();
  assert.equal((await call('/api/merchants/verify', { merchantId: 'sample-cafe', friend: true }, visitor)).body.demo, true);
  assert.equal((await call('/api/me', undefined, visitor)).body.stamps.length, 0);
  assert.equal((await call('/api/demo/friendship', { merchantId: 'sample-cafe', friend: false }, visitor)).body.stamps.length, 0);
  for (let i = 0; i < 2; i++) assert.equal((await call('/api/demo/friendship', { merchantId: 'sample-cafe', friend: true }, visitor)).body.stamps.length, 1);
});

test('eco task validation, partial awards and Asia/Taipei midnight reset', async t => {
  let time = Date.parse('2026-09-28T15:59:00Z');
  const { call, member, staff } = await setup(t, { now: () => time });
  const visitor = await member(), shop = await staff();
  for (const tasks of [[], ['fake'], ['moovo', 'moovo']]) assert.equal((await call('/api/staff/vouchers', { tasks }, shop)).status, 400);
  async function award(tasks) { const token = (await call('/api/staff/vouchers', { tasks }, shop)).body.token; return call('/api/stamps/claim', { token, points: 9999 }, visitor); }
  assert.equal((await award(['reusable-cup'])).body.ecoPoints, 1);
  const both = await award(['reusable-cup', 'moovo']);
  assert.equal(both.body.ecoPoints, 2);
  assert.deepEqual(both.body.awarded, { accepted: ['moovo'], skipped: ['reusable-cup'] });
  assert.equal((await award(['moovo'])).status, 409);
  time += 60_000;
  const tomorrow = await award(['reusable-cup', 'moovo']);
  assert.equal(tomorrow.body.ecoPoints, 4);
  assert.equal(tomorrow.body.today, '2026-09-29');
});

test('green reward requires both store stamps and eco credits', async t => {
  const { call, member, staff } = await setup(t);
  const visitor = await member(), shop = await staff();
  for (const m of sample.merchants) await call('/api/demo/friendship', { merchantId: m.id, friend: true }, visitor);
  assert.equal((await call('/api/rewards/request', { rewardId: 'sample-green-gift' }, visitor)).status, 403);
  const voucher = (await call('/api/staff/vouchers', { tasks: ['reusable-cup', 'moovo'] }, shop)).body;
  await call('/api/stamps/claim', { token: voucher.token }, visitor);
  assert.equal((await call('/api/rewards/request', { rewardId: 'sample-green-gift' }, visitor)).status, 200);
});

async function oauthSetup(t) {
  const campaign = structuredClone(sample);
  campaign.sample = false; campaign.startsAt = '2020-01-01T00:00:00Z'; campaign.endsAt = '2030-01-01T00:00:00Z';
  campaign.merchants.forEach((m, i) => { m.sample = false; m.officialAccountId = `@shop${i}`; });
  campaign.rewards.forEach(r => { r.sample = false; });
  let time = Date.now(), nonce = '', friend = true, variant = '', mainUser = 'main-user', shopUser = 'shop-user';
  const exchanges = [];
  const fetcher = async (url, init = {}) => {
    const body = init.body;
    let result;
    if (url.endsWith('/token')) { exchanges.push(Object.fromEntries(body)); result = { id_token: 'shop-id', access_token: 'shop-access' }; }
    else if (url.includes('verify?')) result = { client_id: '123', expires_in: 300 };
    else if (url.endsWith('/verify') && body.get('client_id') === '456') result = { sub: shopUser, aud: variant === 'wrong-channel' ? '999' : '456', nonce: variant === 'wrong-nonce' ? 'wrong' : nonce, exp: variant === 'expired-id' ? 0 : time / 1000 + 300 };
    else if (url.endsWith('/verify')) result = { sub: mainUser, aud: '123', exp: time / 1000 + 300 };
    else if (url.endsWith('/profile')) result = { userId: init.headers.Authorization === 'Bearer shop-access' ? (variant === 'wrong-user' ? 'wrong' : shopUser) : mainUser, displayName: 'Test visitor' };
    else if (url.includes('/friendship/')) {
      if (variant === 'network-error' && init.headers.Authorization === 'Bearer shop-access') throw new Error('upstream unavailable');
      result = { friendFlag: init.headers.Authorization === 'Bearer shop-access' ? friend : true };
    }
    return { ok: true, json: async () => result };
  };
  const env = await setup(t, { mode: 'production', origin: 'https://example.com', liffId: '123-abc', channelId: '123', mainOaId: '@main', campaign, fetcher, now: () => time, merchantLogins: { 'sample-cafe': { channelId: '456', channelSecret: 'server-only' } }, staffCredentials: { 'sample-cafe': createHash('sha256').update('staff-secret').digest('hex') } });
  const login = async () => (await env.call('/api/auth/line', { idToken: 'main-id', accessToken: 'main-access' })).cookie;
  const start = async cookie => {
    const response = await env.call('/api/merchants/verify', { merchantId: 'sample-cafe', friend: true }, cookie);
    assert.equal(response.status, 200);
    const url = new URL(response.body.url); nonce = url.searchParams.get('nonce'); return url;
  };
  return { ...env, login, start, exchanges, set: values => { if ('friend' in values) friend = values.friend; if ('variant' in values) variant = values.variant; if ('mainUser' in values) mainUser = values.mainUser; if ('shopUser' in values) shopUser = values.shopUser; if ('advance' in values) time += values.advance; } };
}

test('production OAuth uses PKCE and verified merchant identity, returns to same passport and awards once', async t => {
  const app = await oauthSetup(t), cookie = await app.login(), url = await app.start(cookie);
  assert.equal(url.origin, 'https://access.line.me');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://example.com/auth/merchant/callback');
  assert.equal(url.searchParams.get('client_id'), '456');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('scope'), 'openid profile');
  const query = { state: url.searchParams.get('state'), code: 'line-code' };
  const result = await app.callback(query, cookie);
  assert.equal(result.status, 303);
  assert.equal(new URL(result.location).searchParams.get('verification'), 'success');
  assert.equal((await app.call('/api/me', undefined, cookie)).body.stamps.length, 1);
  assert.equal(createHash('sha256').update(app.exchanges[0].code_verifier).digest('base64url'), url.searchParams.get('code_challenge'));
  assert.equal(app.exchanges[0].client_secret, 'server-only');
  assert.equal(new URL((await app.callback(query, cookie)).location).searchParams.get('verification'), 'error');
  assert.equal(app.exchanges.length, 1);
  assert.equal((await app.call('/api/merchants/verify', { merchantId: 'sample-cafe' }, cookie)).body.collected, true);
  const publicConfig = JSON.stringify((await app.call('/api/config')).body);
  assert.ok(!publicConfig.includes('server-only'));
  assert.equal((await app.call('/api/demo/friendship', { merchantId: 'sample-cafe', friend: true }, cookie)).status, 404);
  assert.equal((await app.call('/api/merchants/verify', { merchantId: 'sample-food' }, cookie)).status, 503);
});

test('OAuth non-friend, cancellation, forged state, wrong browser and expired state never award', async t => {
  const app = await oauthSetup(t), cookie = await app.login();
  let url = await app.start(cookie);
  assert.equal(new URL((await app.callback({ state: 'forged', code: 'code' }, cookie)).location).searchParams.get('verification'), 'error');
  assert.equal(new URL((await app.callback({ state: url.searchParams.get('state'), code: 'code' })).location).searchParams.get('verification'), 'error');
  const otherCookie = await app.login();
  assert.equal(new URL((await app.callback({ state: url.searchParams.get('state'), code: 'code' }, otherCookie)).location).searchParams.get('verification'), 'error');
  assert.equal(app.exchanges.length, 0);
  app.set({ friend: false });
  assert.equal(new URL((await app.callback({ state: url.searchParams.get('state'), code: 'code' }, cookie)).location).searchParams.get('verification'), 'not-friend');
  url = await app.start(cookie);
  assert.equal(new URL((await app.callback({ state: url.searchParams.get('state'), error: 'access_denied' }, cookie)).location).searchParams.get('verification'), 'cancelled');
  url = await app.start(cookie); app.set({ advance: 300_001 });
  assert.equal(new URL((await app.callback({ state: url.searchParams.get('state'), code: 'code' }, cookie)).location).searchParams.get('verification'), 'error');
  assert.equal((await app.call('/api/me', undefined, cookie)).body.stamps.length, 0);
});

test('OAuth validates channel, nonce, expiry, subject and strict friendship boolean', async t => {
  const app = await oauthSetup(t), cookie = await app.login();
  for (const variant of ['wrong-channel', 'wrong-nonce', 'expired-id', 'wrong-user', 'network-error', 'string-flag']) {
    app.set({ variant, friend: variant === 'string-flag' ? 'true' : true });
    const url = await app.start(cookie);
    const result = await app.callback({ state: url.searchParams.get('state'), code: 'code' }, cookie);
    assert.equal(new URL(result.location).searchParams.get('verification'), 'error', variant);
    assert.equal((await app.call('/api/me', undefined, cookie)).body.stamps.length, 0);
  }
});

test('a merchant identity cannot earn the same shop stamp for a second main account', async t => {
  const app = await oauthSetup(t), cookie = await app.login();
  let url = await app.start(cookie);
  await app.callback({ state: url.searchParams.get('state'), code: 'code' }, cookie);
  app.set({ mainUser: 'another-main-user' });
  const other = await app.login(); url = await app.start(other);
  const result = await app.callback({ state: url.searchParams.get('state'), code: 'code' }, other);
  assert.equal(new URL(result.location).searchParams.get('verification'), 'error');
  assert.equal((await app.call('/api/me', undefined, other)).body.stamps.length, 0);
});

test('production fails closed with sample data and missing LINE configuration', () => {
  assert.throws(() => createApp({ mode: 'production' }), /Production requires/);
  assert.throws(() => createApp({ mode: 'production', origin: 'https://example.com', liffId: '123', channelId: '123', mainOaId: '@example' }), /sample campaign/);
});

test('LINE verification rejects wrong channel and mismatched subject, permits verified identity only', async t => {
  const campaign = structuredClone(sample);
  campaign.sample = false; campaign.startsAt = '2020-01-01T00:00:00Z'; campaign.endsAt = '2030-01-01T00:00:00Z';
  campaign.merchants.forEach(m => { m.sample = false; }); campaign.rewards.forEach(r => { r.sample = false; });
  let variant = 'wrong-channel';
  const fetcher = async url => {
    let result;
    if (url.includes('verify?')) result = { client_id: variant === 'wrong-channel' ? 'another-channel' : '123', expires_in: 300 };
    else if (url.endsWith('/verify')) result = { sub: 'line-user', aud: '123', exp: Date.now() / 1000 + 300 };
    else if (url.endsWith('/profile')) result = { userId: variant === 'wrong-user' ? 'other-user' : 'line-user', displayName: 'Verified visitor' };
    else result = { friendFlag: true };
    return { ok: true, json: async () => result };
  };
  const { call } = await setup(t, { mode: 'production', origin: 'https://example.com', liffId: '123-abc', channelId: '123', mainOaId: '@example', campaign, fetcher, staffCredentials: { 'sample-cafe': createHash('sha256').update('test-secret').digest('hex') } });
  assert.equal((await call('/api/auth/demo', {})).status, 404);
  assert.equal((await call('/api/auth/line', { userId: 'forged' })).status, 401);
  assert.equal((await call('/api/auth/line', { idToken: 'id', accessToken: 'access' })).status, 401);
  variant = 'wrong-user';
  assert.equal((await call('/api/auth/line', { idToken: 'id', accessToken: 'access' })).status, 401);
  variant = 'valid';
  const result = await call('/api/auth/line', { idToken: 'id', accessToken: 'access', userId: 'forged' });
  assert.equal(result.status, 200); assert.equal(result.body.user.name, 'Verified visitor'); assert.equal(result.body.user.friend, 1);
});
