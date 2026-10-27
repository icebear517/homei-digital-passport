import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import QRCode from 'qrcode';
import { openDatabase } from './database.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(24).toString('base64url');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const text = (value, max = 512) => typeof value === 'string' && value.length <= max ? value.trim() : '';

function assertCampaign(campaign, production, allowEmpty = false) {
  if (!campaign || !campaign.id || !Number.isInteger(campaign.stampTarget) || campaign.stampTarget < 1) throw new Error('活動設定不正確');
  if (new Set(campaign.merchants.map(item => item.id)).size !== campaign.merchants.length || new Set(campaign.prizes.map(item => item.id)).size !== campaign.prizes.length) throw new Error('活動資料有重複代號');
  if (production) {
    for (const item of campaign.merchants) if (!item.id || !item.name || (item.taskType === 'FACEBOOK' ? !item.facebookUrl : (!item.officialAccountId && !item.lineOaUrl))) throw new Error('店家上架資料不完整');
    for (const item of campaign.prizes) if (!Number.isInteger(item.stock) || item.stock < 0 || !Array.isArray(item.redemptionMerchantIds) || !item.redemptionMerchantIds.length || item.redemptionMerchantIds.some(id => !campaign.merchants.some(merchant => merchant.id === id))) throw new Error('獎品上架資料不完整');
    if (campaign.sample || (!allowEmpty && (!campaign.merchants.length || !campaign.prizes.length))) throw new Error('正式環境需要已上架的店家與獎品資料');
  }
}

const publicCampaign = campaign => ({
  id: campaign.id, title: campaign.title, subtitle: campaign.subtitle, periodLabel: campaign.periodLabel, organizer: campaign.organizer, keyword: campaign.keyword, stampTarget: campaign.stampTarget, drawRule: campaign.drawRule,
  merchants: campaign.merchants.map(({ id, name, category, icon, color, description, address, navigationName, taskType, hours, facebookUrl }) => ({ id, name, category, icon, color, description, address, navigationName, taskType, hours, facebookUrl })),
});

export async function createApp(options = {}) {
  const { mode = 'demo', origin = 'http://localhost:3000', dbPath = ':memory:', databaseUrl = '', liffId = '', staffLiffId = '', channelId = '', staffCredentials = {}, fetcher = fetch, now = Date.now, sheetSync = null, entrySigningSecret = '' } = options;
  let campaign = options.campaign || JSON.parse(readFileSync(new URL('../config/campaign.json', import.meta.url)));
  const demo = mode !== 'production';
  if (!['demo', 'preview', 'production'].includes(mode)) throw new Error('Unknown APP_MODE');
  if (new URL(origin).origin !== origin) throw new Error('APP_ORIGIN must be an origin without path or trailing slash');
  if (!demo && (!liffId || !channelId || !entrySigningSecret || new URL(origin).protocol !== 'https:')) throw new Error('Production requires HTTPS APP_ORIGIN, LIFF_ID, LINE_LOGIN_CHANNEL_ID and ENTRY_SIGNING_SECRET');
  if (demo || !sheetSync) assertCampaign(campaign, !demo);
  const db = await openDatabase({ databaseUrl, dbPath });
  const signingSecret = entrySigningSecret || 'demo-entry-secret';
  const merchant = id => campaign.merchants.find(item => item.id === id) || fail(404, '找不到店家');
  const prize = id => campaign.prizes.find(item => item.id === id) || fail(404, '找不到獎品');
  const active = () => { if ((campaign.startsAt && now() < Date.parse(campaign.startsAt)) || (campaign.endsAt && now() >= Date.parse(campaign.endsAt))) fail(403, '目前不在活動期間'); };
  const isMerchantActive = item => (!item.startsAt || now() >= Date.parse(item.startsAt)) && (!item.endsAt || now() < Date.parse(item.endsAt));
  const entrySignature = id => createHmac('sha256', signingSecret).update(`${campaign.id}:${id}`).digest('base64url');
  const validEntry = (id, token) => {
    if (!token || token.length !== entrySignature(id).length) return false;
    return timingSafeEqual(Buffer.from(entrySignature(id)), Buffer.from(token));
  };
  const entryUrl = id => { const url = new URL(demo ? '/' : `https://liff.line.me/${liffId}/`, origin); url.searchParams.set('shop', id); url.searchParams.set('entry', entrySignature(id)); return url.href; };
  const couponUrl = code => { const url = staffLiffId ? new URL(`https://liff.line.me/${staffLiffId}/`) : new URL('/staff', origin); url.searchParams.set('coupon', code); return url.href; };
  const count = async (user, store = db) => Number((await store.get('SELECT COUNT(*) AS n FROM stamps WHERE campaign=? AND user_id=?', campaign.id, user)).n);
  const couponState = async (user, token, store = db) => { const coupon = await store.get('SELECT * FROM coupons WHERE token=? AND campaign=? AND user_id=?', token, campaign.id, user); if (!coupon) return null; const item = prize(coupon.prize); return { code: coupon.token, prize: item.name, instructions: item.instructions, expires: coupon.expires ? Number(coupon.expires) : null, usedAt: coupon.used_at ? Number(coupon.used_at) : null }; };
  const state = async (user, store = db) => { const stamps = await store.all('SELECT merchant,created FROM stamps WHERE campaign=? AND user_id=? ORDER BY created', campaign.id, user); const entries = await store.all('SELECT coupon FROM draw_entries WHERE campaign=? AND user_id=? ORDER BY created DESC', campaign.id, user); const coupons = (await Promise.all(entries.map(row => couponState(user, row.coupon, store)))).filter(Boolean); const totalChances = Math.floor(stamps.length / campaign.stampTarget); return { user: await store.get('SELECT name FROM members WHERE id=?', user), stamps, stampTarget: campaign.stampTarget, coupons, totalChances, availableDraws: Math.max(0, totalChances - coupons.length) }; };
  const cookie = (token, role, age) => `${role === 'staff' ? 'staff_session' : 'member_session'}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${demo ? '' : '; Secure'}`;
  const sessionRow = async (req, role) => { const name = role === 'staff' ? 'staff_session' : 'member_session'; const token = (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`))?.slice(name.length + 1); const row = token && await db.get('SELECT * FROM sessions WHERE token=? AND role=? AND expires>?', hash(token), role, now()); if (!row) fail(401, '請重新登入'); return row; };
  const session = async (req, role) => (await sessionRow(req, role)).subject;
  const establish = async (res, subject, role) => { const token = random(); await db.run('DELETE FROM sessions WHERE expires<=?', now()); await db.run('INSERT INTO sessions VALUES (?,?,?,?)', hash(token), role, subject, now() + 7_200_000); res.setHeader('Set-Cookie', cookie(token, role, 7200)); };
  const rates = new Map();
  const limit = (key, max) => { const time = now(); for (const [id, item] of rates) if (item.end < time) rates.delete(id); const item = rates.get(key) || { end: time + 60_000, count: 0 }; item.count++; rates.set(key, item); if (item.count > max) fail(429, '操作太頻繁，請稍後再試'); };
  async function body(req) { if (!req.headers['content-type']?.startsWith('application/json')) fail(415, '請使用 JSON 格式'); let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 16_384) fail(413, '資料太大'); } try { const data = JSON.parse(raw || '{}'); if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400, '資料格式不正確'); return data; } catch { fail(400, '資料格式不正確'); } }
  async function line(url, init) { let response; try { response = await fetcher(url, { ...init, signal: AbortSignal.timeout(8000) }); } catch { fail(503, 'LINE 連線暫時無法使用，請稍後重試'); } if (!response.ok) fail(401, 'LINE 登入驗證失敗，請重新登入'); return response.json(); }
  async function identity(data) { const idToken = text(data.idToken, 8192), accessToken = text(data.accessToken, 4096); if (!idToken || !accessToken) fail(401, '缺少 LINE 登入憑證'); const id = await line('https://api.line.me/oauth2/v2.1/verify', { method: 'POST', body: new URLSearchParams({ id_token: idToken, client_id: channelId }) }); const access = await line(`https://api.line.me/v2/oauth/verify?access_token=${encodeURIComponent(accessToken)}`); if (!id.sub || id.aud !== channelId || !Number.isFinite(id.exp) || id.exp * 1000 <= now() || access.client_id !== channelId || !Number.isFinite(access.expires_in) || access.expires_in <= 0) fail(401, 'LINE 憑證不屬於此活動或已失效'); const profile = await line('https://api.line.me/v2/profile', { headers: { Authorization: `Bearer ${accessToken}` } }); if (profile.userId !== id.sub) fail(401, 'LINE 憑證身分不一致'); return { id: id.sub, name: profile.displayName || '和美旅人' }; }
  const collect = async (user, shopId, entryToken) => db.transaction(async store => { active(); const item = merchant(shopId); if (!isMerchantActive(item)) fail(403, '此店家目前未開放集章'); if (!validEntry(shopId, entryToken)) fail(403, '請使用店內 QR Code 進入集章頁'); await store.run('INSERT INTO stamps VALUES (?,?,?,?) ON CONFLICT (campaign,user_id,merchant) DO NOTHING', campaign.id, user, shopId, now()); return state(user, store); });
  async function draw(user) { return db.transaction(async store => { active(); const totalChances = Math.floor(await count(user, store) / campaign.stampTarget); const used = Number((await store.get('SELECT COUNT(*) AS n FROM draw_entries WHERE campaign=? AND user_id=?', campaign.id, user)).n); if (totalChances <= used) fail(403, `每集滿 ${campaign.stampTarget} 間不同店家可增加一次轉盤機會`); const available = []; for (const item of campaign.prizes) if (Number((await store.get('SELECT COUNT(*) AS n FROM coupons WHERE campaign=? AND prize=?', campaign.id, item.id)).n) < item.stock) available.push(item); if (!available.length) fail(409, '本次活動獎品已全數送完'); const item = available[randomInt(available.length)], code = random(), expires = item.expiresAt ? Date.parse(item.expiresAt) : null; await store.run('INSERT INTO coupons (token,campaign,user_id,prize,expires,created) VALUES (?,?,?,?,?,?)', code, campaign.id, user, item.id, Number.isFinite(expires) ? expires : null, now()); await store.run('INSERT INTO draw_entries VALUES (?,?,?,?)', campaign.id, user, code, now()); return { code, item }; }); }
  async function validateCoupon(shopId, code, store) { const coupon = await store.get('SELECT * FROM coupons WHERE token=? AND campaign=?', text(code, 128), campaign.id); if (!coupon) fail(404, '找不到此兌換券'); const item = prize(coupon.prize); if (!item.redemptionMerchantIds.includes(shopId)) fail(403, '此券不能在這間店核銷'); if (coupon.used_at) fail(409, '此券已經核銷'); if (coupon.expires && Number(coupon.expires) <= now()) fail(409, '此券已過有效期限'); return { coupon, item, visitor: (await store.get('SELECT name FROM members WHERE id=?', coupon.user_id))?.name || '活動會員' }; }
  async function api(req, res, path) {
    if (req.method === 'GET' && path === '/api/config') return { campaign: publicCampaign(campaign), demo, liffId, origin };
    if (req.method === 'GET' && path === '/api/me') return state(await session(req, 'member'));
    if (req.method === 'GET' && path === '/api/staff/me') return { merchant: merchant(await session(req, 'staff')) };
    if (req.method === 'GET' && path === '/api/staff/entry') { const item = merchant(await session(req, 'staff')); const liffLink = entryUrl(item.id); const lineLink = item.officialAccountId ? `https://line.me/R/oaMessage/${encodeURIComponent(item.officialAccountId)}/?${encodeURIComponent(campaign.keyword)}` : null; return { keyword: campaign.keyword, liffLink, lineLink, qr: await QRCode.toDataURL(lineLink || liffLink, { width: 420, margin: 2, errorCorrectionLevel: 'M' }) }; }
    if (req.method !== 'POST') fail(404, '找不到此功能'); if (req.headers.origin !== origin) fail(403, '請從活動頁面操作'); limit(`all:${req.socket.remoteAddress}`, 180); const data = await body(req);
    if (path === '/api/auth/demo' || path === '/api/auth/line') { if (path.endsWith('/demo') && !demo) fail(404, '找不到此功能'); const user = path.endsWith('/demo') ? { id: 'demo-visitor', name: '和美旅人' } : await identity(data); await db.run('INSERT INTO members VALUES (?,?,?) ON CONFLICT (id) DO UPDATE SET name=excluded.name,updated=excluded.updated', user.id, user.name, now()); await establish(res, user.id, 'member'); return state(user.id); }
    if (path === '/api/stamps/collect') return collect(await session(req, 'member'), text(data.merchantId), text(data.entry, 128));
    if (path === '/api/coupon/qr') { const user = await session(req, 'member'), coupon = await couponState(user, text(data.code, 128)); if (!coupon) fail(404, '找不到此數位券'); return { qr: await QRCode.toDataURL(couponUrl(coupon.code), { width: 420, margin: 2, errorCorrectionLevel: 'M' }) }; }
    if (path === '/api/draw') { const user = await session(req, 'member'); limit(`draw:${user}`, 5); const result = await draw(user); return { ...await state(user), won: { name: result.item.name, description: result.item.description }, qr: await QRCode.toDataURL(couponUrl(result.code), { width: 420, margin: 2, errorCorrectionLevel: 'M' }) }; }
    if (path === '/api/staff/login') { limit(`staff-login:${req.socket.remoteAddress}`, 10); const id = text(data.merchantId), key = text(data.key), expected = demo ? hash('demo-staff') : staffCredentials[id]; merchant(id); if (!expected || !/^[a-f0-9]{64}$/i.test(expected) || !timingSafeEqual(Buffer.from(hash(key), 'hex'), Buffer.from(expected, 'hex'))) fail(401, '店家或工作碼不正確'); await establish(res, id, 'staff'); return { merchant: merchant(id) }; }
    if (path === '/api/staff/coupons/lookup' || path === '/api/staff/coupons/redeem') { const shop = await session(req, 'staff'); limit(`coupon:${shop}`, 30); return db.transaction(async store => { const result = await validateCoupon(shop, data.code, store); const output = { visitor: result.visitor, prize: result.item.name, instructions: result.item.instructions, expires: result.coupon.expires ? Number(result.coupon.expires) : null }; if (path.endsWith('/redeem')) { const changed = await store.run('UPDATE coupons SET used_by=?,used_at=? WHERE token=? AND used_at IS NULL', shop, now(), result.coupon.token); if (Number(changed.rowCount ?? changed.changes) !== 1) fail(409, '此券已被其他店員核銷'); } return output; }); }
    if (path === '/api/logout' || path === '/api/staff/logout') { const role = path.includes('/staff/') ? 'staff' : 'member', row = await sessionRow(req, role); await db.run('DELETE FROM sessions WHERE token=?', row.token); res.setHeader('Set-Cookie', cookie('', role, 0)); return { ok: true }; }
    fail(404, '找不到此功能');
  }
  const assets = new Map([['/', ['index.html', 'text/html']], ['/staff', ['staff.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/staff.js', ['staff.js', 'text/javascript']], ['/styles.css', ['styles.css', 'text/css']]]);
  return {
    close: () => db.close(),
    async syncCampaign() { if (!sheetSync) return { synced: false }; const next = await sheetSync.load(campaign); assertCampaign(next, !demo, true); campaign = next; return { synced: true, merchants: campaign.merchants.length, prizes: campaign.prizes.length, at: new Date(now()).toISOString() }; },
    handler: async (req, res) => {
      res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://static.line-scdn.net; connect-src 'self' https://*.line.me https://*.line-scdn.net https://*.line.biz; img-src 'self' data: https://*.facebook.com; style-src 'self'; frame-src https://www.facebook.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      try { const url = new URL(req.url, origin), path = url.pathname; if (path.startsWith('/api/')) { const output = await api(req, res, path); res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(output)); return; } if (path === '/healthz') { res.setHeader('Content-Type', 'application/json'); res.end('{\"ok\":true}'); return; } const asset = assets.get(path); if (req.method !== 'GET' || !asset) fail(404, '找不到頁面'); res.setHeader('Content-Type', `${asset[1]}; charset=utf-8`); res.end(readFileSync(new URL(`../public/${asset[0]}`, import.meta.url))); }
      catch (error) { res.statusCode = error.status || 500; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ error: error.status ? error.message : '系統暫時無法處理，請稍後重試' })); if (!error.status) console.error('Request failed:', error.message); }
    },
  };
}
