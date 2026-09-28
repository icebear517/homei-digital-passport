import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import QRCode from 'qrcode';

const hash = value => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(24).toString('base64url');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const text = (value, max = 512) => typeof value === 'string' && value.length <= max ? value : '';

export function createApp(options = {}) {
  const { mode = 'demo', origin = 'http://localhost:3000', dbPath = ':memory:', liffId = '', channelId = '', mainOaId = '', staffCredentials = {}, merchantLogins = {}, previewPassword = '', fetcher = fetch, now = Date.now } = options;
  const campaign = options.campaign || JSON.parse(readFileSync(new URL('../config/campaign.json', import.meta.url)));
  const demo = mode !== 'production';
  const preview = mode === 'preview';
  const ecoTasks = campaign.ecoTasks || [];
  if (new URL(origin).origin !== origin) throw new Error('APP_ORIGIN must be an origin without path or trailing slash');
  if (new Set(ecoTasks.map(item => item.id)).size !== ecoTasks.length || ecoTasks.some(item => !item.id || !Number.isInteger(item.points) || item.points < 1 || !Number.isInteger(item.dailyLimit) || item.dailyLimit < 1)) throw new Error('Invalid eco task configuration');
  const usedChannels = new Set();
  for (const [id, login] of Object.entries(merchantLogins)) {
    const shop = campaign.merchants.find(item => item.id === id);
    if (!shop || !/^@[A-Za-z0-9._-]+$/.test(shop.officialAccountId || '') || !/^\d+$/.test(login.channelId || '') || typeof login.channelSecret !== 'string' || !login.channelSecret || usedChannels.has(login.channelId)) throw new Error('Invalid or duplicate merchant LINE Login configuration');
    usedChannels.add(login.channelId);
  }
  if (!['demo', 'preview', 'production'].includes(mode)) throw new Error('Unknown APP_MODE');
  if (preview && (new URL(origin).protocol !== 'https:' || typeof previewPassword !== 'string' || previewPassword.length < 16)) throw new Error('Preview requires HTTPS APP_ORIGIN and a 16+ character PREVIEW_PASSWORD');
  if (!demo && (!liffId || !channelId || !mainOaId || new URL(origin).protocol !== 'https:')) throw new Error('Production requires HTTPS APP_ORIGIN, LIFF_ID, LINE_LOGIN_CHANNEL_ID and MAIN_OA_ID');
  if (!demo && (campaign.sample || campaign.merchants.some(m => m.sample) || campaign.rewards.some(r => r.sample))) throw new Error('Replace sample campaign data before production');
  if (!demo && (!campaign.startsAt || !campaign.endsAt || !Number.isFinite(Date.parse(campaign.startsAt)) || !Number.isFinite(Date.parse(campaign.endsAt)) || Date.parse(campaign.endsAt) <= Date.parse(campaign.startsAt))) throw new Error('Production requires a valid campaign date range');
  if (!demo && (Object.keys(staffCredentials).length === 0 || Object.entries(staffCredentials).some(([id, key]) => !campaign.merchants.some(m => m.id === id) || !/^[a-f0-9]{64}$/.test(key)))) throw new Error('Configure merchant-specific SHA-256 staff credential hashes');
  if (new Set(campaign.merchants.map(m => m.id)).size !== campaign.merchants.length || new Set(campaign.rewards.map(r => r.id)).size !== campaign.rewards.length) throw new Error('Duplicate campaign IDs');
  for (const reward of campaign.rewards) if (!Number.isInteger(reward.threshold) || reward.threshold < 1 || !Number.isInteger(reward.ecoThreshold ?? 0) || (reward.ecoThreshold ?? 0) < 0 || !Number.isInteger(reward.stock) || reward.stock < 0 || !reward.merchantIds.length || reward.merchantIds.some(id => !campaign.merchants.some(m => m.id === id))) throw new Error('Invalid reward configuration');

  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, friend INTEGER, updated INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, role TEXT NOT NULL, subject TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS visits (id INTEGER PRIMARY KEY, campaign TEXT NOT NULL, user_id TEXT NOT NULL, merchant TEXT, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS vouchers (token TEXT PRIMARY KEY, campaign TEXT NOT NULL, merchant TEXT NOT NULL, expires INTEGER NOT NULL, used_by TEXT, used_at INTEGER);
    CREATE TABLE IF NOT EXISTS stamps (campaign TEXT NOT NULL, user_id TEXT NOT NULL, merchant TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(campaign,user_id,merchant));
    CREATE TABLE IF NOT EXISTS requests (token TEXT PRIMARY KEY, campaign TEXT NOT NULL, user_id TEXT NOT NULL, reward TEXT NOT NULL, expires INTEGER NOT NULL, used_at INTEGER);
    CREATE TABLE IF NOT EXISTS redemptions (campaign TEXT NOT NULL, user_id TEXT NOT NULL, reward TEXT NOT NULL, merchant TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(campaign,user_id,reward));
    CREATE TABLE IF NOT EXISTS friendship_flows (state TEXT PRIMARY KEY, campaign TEXT NOT NULL, user_id TEXT NOT NULL, merchant TEXT NOT NULL, session_hash TEXT NOT NULL, nonce TEXT NOT NULL, verifier TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS merchant_identities (merchant TEXT NOT NULL, channel TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL, verified INTEGER NOT NULL, PRIMARY KEY(merchant,channel,subject), UNIQUE(merchant,channel,user_id));
    CREATE TABLE IF NOT EXISTS friendship_audit (id INTEGER PRIMARY KEY, campaign TEXT NOT NULL, user_id TEXT NOT NULL, merchant TEXT NOT NULL, channel TEXT NOT NULL, friend INTEGER NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS eco_voucher_tasks (token TEXT NOT NULL, task TEXT NOT NULL, PRIMARY KEY(token,task));
    CREATE TABLE IF NOT EXISTS eco_credits (id INTEGER PRIMARY KEY, campaign TEXT NOT NULL, user_id TEXT NOT NULL, merchant TEXT NOT NULL, task TEXT NOT NULL, points INTEGER NOT NULL, day TEXT NOT NULL, created INTEGER NOT NULL, voucher TEXT NOT NULL, UNIQUE(voucher,task));
    CREATE INDEX IF NOT EXISTS eco_daily ON eco_credits(campaign,user_id,task,day);
  `);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } };
  const active = () => { if ((campaign.startsAt && now() < Date.parse(campaign.startsAt)) || (campaign.endsAt && now() >= Date.parse(campaign.endsAt))) fail(403, '目前不在活動期間'); };
  const merchant = id => campaign.merchants.find(m => m.id === id) || fail(404, '找不到店家');
  const reward = id => campaign.rewards.find(r => r.id === id) || fail(404, '找不到獎勵');
  const count = user => get('SELECT COUNT(*) AS n FROM stamps WHERE campaign=? AND user_id=?', campaign.id, user).n;
  const ecoTotal = user => get('SELECT COALESCE(SUM(points),0) AS n FROM eco_credits WHERE campaign=? AND user_id=?', campaign.id, user).n;
  const localDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now());
  const state = user => ({ user: get('SELECT name,friend FROM users WHERE id=?', user), stamps: all('SELECT merchant,created FROM stamps WHERE campaign=? AND user_id=?', campaign.id, user), ecoPoints: ecoTotal(user), ecoCredits: all('SELECT merchant,task,points,day,created FROM eco_credits WHERE campaign=? AND user_id=? ORDER BY created DESC,id DESC', campaign.id, user), today: localDay(), redemptions: all('SELECT reward,merchant,created FROM redemptions WHERE campaign=? AND user_id=?', campaign.id, user) });
  const cookie = (token, role, age) => `${role === 'staff' ? 'staff_session' : 'member_session'}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${mode === 'demo' ? '' : '; Secure'}`;
  const previewAuthorization = preview ? `Basic ${Buffer.from(`preview:${previewPassword}`).toString('base64')}` : '';
  const sessionRow = (req, role) => {
    const name = role === 'staff' ? 'staff_session' : 'member_session';
    const token = (req.headers.cookie || '').split(';').map(c => c.trim()).find(c => c.startsWith(`${name}=`))?.slice(name.length + 1);
    const row = token && get('SELECT * FROM sessions WHERE token=? AND role=? AND expires>?', hash(token), role, now());
    if (!row) fail(401, '請重新登入');
    return row;
  };
  const session = (req, role) => sessionRow(req, role).subject;
  const establish = (res, subject, role) => {
    const token = random();
    run('DELETE FROM sessions WHERE expires<=?', now());
    run('INSERT INTO sessions VALUES (?,?,?,?)', hash(token), role, subject, now() + 2 * 60 * 60 * 1000);
    res.setHeader('Set-Cookie', cookie(token, role, 7200));
  };
  const rates = new Map();
  function limit(key, max) {
    const time = now();
    for (const [k, value] of rates) if (value.end < time) rates.delete(k);
    const item = rates.get(key) || { end: time + 60_000, count: 0 };
    item.count++; rates.set(key, item);
    if (item.count > max) fail(429, '操作太頻繁，請稍後再試');
  }
  async function body(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) fail(415, '請使用 JSON 格式');
    let data = ''; for await (const chunk of req) { data += chunk; if (data.length > 16_384) fail(413, '資料太大'); }
    try { const value = JSON.parse(data || '{}'); if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, '資料格式不正確'); return value; } catch { fail(400, '資料格式不正確'); }
  }
  async function line(url, init) {
    let response; try { response = await fetcher(url, { ...init, signal: AbortSignal.timeout(8000) }); } catch { fail(503, 'LINE 連線暫時無法使用，請稍後重試'); }
    if (!response.ok) fail(401, 'LINE 登入驗證失敗，請重新登入');
    return response.json();
  }
  async function identity(data) {
    const idToken = text(data.idToken, 8192), accessToken = text(data.accessToken, 4096);
    if (!idToken || !accessToken) fail(401, '缺少 LINE 登入憑證');
    const id = await line('https://api.line.me/oauth2/v2.1/verify', { method: 'POST', body: new URLSearchParams({ id_token: idToken, client_id: channelId }) });
    const access = await line(`https://api.line.me/oauth2/v2.1/verify?access_token=${encodeURIComponent(accessToken)}`);
    if (!id.sub || id.aud !== channelId || !Number.isFinite(id.exp) || id.exp * 1000 <= now() || access.client_id !== channelId || !Number.isFinite(access.expires_in) || access.expires_in <= 0) fail(401, 'LINE 憑證不屬於此活動或已失效');
    const headers = { Authorization: `Bearer ${accessToken}` };
    const profile = await line('https://api.line.me/v2/profile', { headers });
    if (profile.userId !== id.sub) fail(401, 'LINE 憑證身分不一致');
    let friend = null;
    try { const flag = (await line('https://api.line.me/friendship/v1/status', { headers })).friendFlag; friend = flag === true ? 1 : flag === false ? 0 : null; } catch { /* Unknown remains unknown. */ }
    return { id: id.sub, name: profile.displayName || '和美旅人', friend };
  }
  const callbackUrl = `${origin}/auth/merchant/callback`;
  const publicCampaign = () => ({ ...campaign, merchants: campaign.merchants.map(shop => ({ ...shop, friendshipEnabled: demo || Boolean(merchantLogins[shop.id]) })) });
  function awardFriendship(user, shop, loginChannel, subject) {
    return tx(() => {
      active();
      const identityOwner = get('SELECT user_id FROM merchant_identities WHERE merchant=? AND channel=? AND subject=?', shop, loginChannel, subject);
      const prior = get('SELECT subject FROM merchant_identities WHERE merchant=? AND channel=? AND user_id=?', shop, loginChannel, user);
      if ((identityOwner && identityOwner.user_id !== user) || (prior && prior.subject !== subject)) fail(409, '這個店家好友身分已綁定其他集章會員，請聯絡主辦單位');
      run('INSERT INTO merchant_identities VALUES (?,?,?,?,?) ON CONFLICT(merchant,channel,subject) DO UPDATE SET verified=excluded.verified', shop, loginChannel, subject, user, now());
      run('INSERT INTO friendship_audit (campaign,user_id,merchant,channel,friend,created) VALUES (?,?,?,?,1,?)', campaign.id, user, shop, loginChannel, now());
      run('INSERT OR IGNORE INTO stamps VALUES (?,?,?,?)', campaign.id, user, shop, now());
    });
  }
  async function friendshipCallback(req, res, url) {
    const rawState = text(url.searchParams.get('state'));
    let shop = '', outcome = 'error';
    try {
      const member = sessionRow(req, 'member');
      const flow = tx(() => {
        const row = get('SELECT * FROM friendship_flows WHERE state=? AND campaign=?', hash(rawState), campaign.id);
        if (!row || row.expires <= now() || row.user_id !== member.subject || row.session_hash !== member.token) fail(403, '驗證已失效，請回到原本的 LINE 集章頁重試');
        run('DELETE FROM friendship_flows WHERE state=?', row.state);
        return row;
      });
      shop = flow.merchant;
      active();
      if (url.searchParams.has('error')) outcome = 'cancelled';
      else {
        const login = merchantLogins[shop], code = text(url.searchParams.get('code'), 4096);
        if (!login || !code) fail(400, '缺少店家驗證資料');
        const tokens = await line('https://api.line.me/oauth2/v2.1/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: callbackUrl, client_id: login.channelId, client_secret: login.channelSecret, code_verifier: flow.verifier }) });
        if (!tokens.id_token || !tokens.access_token) fail(401, '缺少店家驗證憑證');
        const id = await line('https://api.line.me/oauth2/v2.1/verify', { method: 'POST', body: new URLSearchParams({ id_token: tokens.id_token, client_id: login.channelId, nonce: flow.nonce }) });
        if (!id.sub || id.aud !== login.channelId || id.nonce !== flow.nonce || !Number.isFinite(id.exp) || id.exp * 1000 <= now()) fail(401, '店家身分驗證失敗');
        const headers = { Authorization: `Bearer ${tokens.access_token}` };
        const profile = await line('https://api.line.me/v2/profile', { headers });
        if (profile.userId !== id.sub) fail(401, '店家驗證身分不一致');
        const status = await line('https://api.line.me/friendship/v1/status', { headers });
        // Recheck the original browser session after asynchronous LINE requests.
        if (sessionRow(req, 'member').token !== flow.session_hash) fail(403, '會員登入已變更，請重新驗證');
        if (status.friendFlag === true) { awardFriendship(flow.user_id, shop, login.channelId, id.sub); outcome = 'success'; }
        else if (status.friendFlag === false) {
          run('INSERT INTO friendship_audit (campaign,user_id,merchant,channel,friend,created) VALUES (?,?,?,?,0,?)', campaign.id, flow.user_id, shop, login.channelId, now());
          outcome = 'not-friend';
        } else fail(503, 'LINE 未回傳有效好友狀態');
      }
    } catch { /* Never expose OAuth codes, tokens, secrets or provider errors in redirects. */ }
    const destination = new URL('/', origin);
    if (shop) destination.searchParams.set('shop', shop);
    destination.searchParams.set('verification', outcome);
    res.statusCode = 303; res.setHeader('Location', destination.href); res.end();
  }
  async function api(req, res, path) {
    if (req.method === 'GET' && path === '/api/config') return { campaign: publicCampaign(), demo, liffId, mainOaId, origin };
    if (req.method === 'GET' && path === '/api/me') return state(session(req, 'member'));
    if (req.method === 'GET' && path === '/api/staff/me') return { merchant: merchant(session(req, 'staff')) };
    if (req.method !== 'POST') fail(404, '找不到此功能');
    if (req.headers.origin !== origin) fail(403, '請從活動頁面操作');
    limit(`all:${req.socket.remoteAddress}`, 180);
    const data = await body(req);
    if (path === '/api/auth/line' || path === '/api/auth/demo') {
      limit(`login:${req.socket.remoteAddress}`, 30);
      if (path.endsWith('/demo') && !demo) fail(404, '找不到此功能');
      const user = path.endsWith('/demo') ? { id: 'demo-visitor', name: '和美旅人', friend: null } : await identity(data);
      run('INSERT INTO users VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,friend=excluded.friend,updated=excluded.updated', user.id, user.name, user.friend, now());
      const source = campaign.merchants.some(m => m.id === data.source) ? data.source : null;
      run('INSERT INTO visits (campaign,user_id,merchant,created) VALUES (?,?,?,?)', campaign.id, user.id, source, now());
      establish(res, user.id, 'member');
      return state(user.id);
    }
    if (path === '/api/staff/login') {
      limit(`staff-login:${req.socket.remoteAddress}`, 10);
      const id = text(data.merchantId), key = text(data.key);
      const expected = demo ? hash('demo-staff') : staffCredentials[id];
      if (!expected || !timingSafeEqual(Buffer.from(hash(key), 'hex'), Buffer.from(expected, 'hex'))) fail(401, '店家或工作金鑰不正確');
      merchant(id); establish(res, id, 'staff'); return { merchant: merchant(id) };
    }
    if (path === '/api/logout' || path === '/api/staff/logout') {
      const role = path.includes('/staff/') ? 'staff' : 'member';
      session(req, role);
      const name = role === 'staff' ? 'staff_session' : 'member_session';
      const token = (req.headers.cookie || '').split(';').map(c => c.trim()).find(c => c.startsWith(`${name}=`))?.slice(name.length + 1);
      run('DELETE FROM sessions WHERE token=?', hash(token)); res.setHeader('Set-Cookie', cookie('', role, 0)); return { ok: true };
    }
    if (path === '/api/merchants/verify') {
      const member = sessionRow(req, 'member'), shop = merchant(text(data.merchantId)); active(); limit(`friend:${member.subject}`, 15);
      if (get('SELECT 1 FROM stamps WHERE campaign=? AND user_id=? AND merchant=?', campaign.id, member.subject, shop.id)) return { collected: true };
      if (demo) return { demo: true };
      const login = merchantLogins[shop.id];
      if (!login) fail(503, '這間店尚未啟用 LINE 好友驗證，請稍後再試');
      const oauthState = randomBytes(32).toString('hex'), nonce = randomBytes(32).toString('hex'), verifier = randomBytes(32).toString('base64url');
      run('DELETE FROM friendship_flows WHERE expires<=? OR (campaign=? AND user_id=? AND merchant=?)', now(), campaign.id, member.subject, shop.id);
      run('INSERT INTO friendship_flows VALUES (?,?,?,?,?,?,?,?)', hash(oauthState), campaign.id, member.subject, shop.id, member.token, nonce, verifier, now() + 300_000);
      const url = new URL('https://access.line.me/oauth2/v2.1/authorize');
      for (const [key, value] of Object.entries({ response_type: 'code', client_id: login.channelId, redirect_uri: callbackUrl, state: oauthState, scope: 'openid profile', nonce, bot_prompt: 'normal', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })) url.searchParams.set(key, value);
      return { url: url.href };
    }
    if (path === '/api/demo/friendship') {
      if (!demo) fail(404, '找不到此功能');
      const user = session(req, 'member'), shop = merchant(text(data.merchantId)); active();
      if (data.friend === true) awardFriendship(user, shop.id, 'demo', user);
      return { ...state(user), demoFriend: data.friend === true };
    }
    if (path === '/api/staff/vouchers') {
      const shop = session(req, 'staff'); active(); limit(`issue:${shop}`, 60);
      const tasks = data.tasks;
      if (!Array.isArray(tasks) || !tasks.length || tasks.length > ecoTasks.length || new Set(tasks).size !== tasks.length || tasks.some(id => !ecoTasks.some(item => item.id === id))) fail(400, '請選擇已現場確認的環保任務');
      const token = random(), expires = now() + 120_000;
      tx(() => {
        run('INSERT INTO vouchers (token,campaign,merchant,expires) VALUES (?,?,?,?)', hash(token), campaign.id, shop, expires);
        for (const task of tasks) run('INSERT INTO eco_voucher_tasks VALUES (?,?)', hash(token), task);
      });
      const url = new URL(demo ? origin : `https://liff.line.me/${liffId}`);
      url.searchParams.set('claim', token); url.searchParams.set('shop', shop);
      return { token, expires, url: url.href, qr: await QRCode.toDataURL(url.href, { width: 360, margin: 2, errorCorrectionLevel: 'M' }) };
    }
    if (path === '/api/stamps/claim') {
      const user = session(req, 'member'); active(); limit(`claim:${user}`, 20);
      const awarded = tx(() => {
        const voucher = get('SELECT * FROM vouchers WHERE token=? AND campaign=?', hash(text(data.token)), campaign.id);
        if (!voucher || voucher.used_by || voucher.expires <= now()) fail(409, '環保加分碼已使用或過期，請店家重新產生');
        merchant(voucher.merchant);
        const tasks = all('SELECT task FROM eco_voucher_tasks WHERE token=?', voucher.token).map(row => ecoTasks.find(item => item.id === row.task));
        if (!tasks.length || tasks.some(item => !item)) fail(409, '任務規則已變更，請店家重新產生');
        const day = localDay(), accepted = [], skipped = [];
        for (const task of tasks) {
          const used = get('SELECT COUNT(*) AS n FROM eco_credits WHERE campaign=? AND user_id=? AND task=? AND day=?', campaign.id, user, task.id, day).n;
          if (used >= task.dailyLimit) { skipped.push(task.id); continue; }
          run('INSERT INTO eco_credits (campaign,user_id,merchant,task,points,day,created,voucher) VALUES (?,?,?,?,?,?,?,?)', campaign.id, user, voucher.merchant, task.id, task.points, day, now(), voucher.token);
          accepted.push(task.id);
        }
        if (!accepted.length) fail(409, '這些環保任務今天已達上限，不能跨店重複加分');
        run('UPDATE vouchers SET used_by=?,used_at=? WHERE token=?', user, now(), voucher.token);
        return { accepted, skipped };
      }); return { ...state(user), awarded };
    }
    if (path === '/api/rewards/request') {
      const user = session(req, 'member'); active(); limit(`reward:${user}`, 10);
      const item = reward(text(data.rewardId));
      if (count(user) < item.threshold) fail(403, '集章數還不夠，繼續探索吧');
      if (ecoTotal(user) < (item.ecoThreshold || 0)) fail(403, '環保分尚未達到這份獎勵的門檻');
      if (get('SELECT 1 FROM redemptions WHERE campaign=? AND user_id=? AND reward=?', campaign.id, user, item.id)) fail(409, '這份獎勵已領取');
      if (get('SELECT COUNT(*) AS n FROM redemptions WHERE campaign=? AND reward=?', campaign.id, item.id).n >= item.stock) fail(409, '這份獎勵已兌換完畢');
      const token = randomBytes(8).toString('hex').toUpperCase(), expires = now() + 300_000;
      tx(() => {
        run('DELETE FROM requests WHERE campaign=? AND user_id=? AND reward=? AND used_at IS NULL', campaign.id, user, item.id);
        run('INSERT INTO requests (token,campaign,user_id,reward,expires) VALUES (?,?,?,?,?)', hash(token), campaign.id, user, item.id, expires);
      });
      return { token, expires, merchantNames: item.merchantIds.map(id => merchant(id).name) };
    }
    if (path === '/api/staff/rewards/lookup' || path === '/api/staff/rewards/redeem') {
      const shop = session(req, 'staff'); active(); limit(`redeem:${shop}`, 30);
      return tx(() => {
        const request = get('SELECT * FROM requests WHERE token=? AND campaign=?', hash(text(data.token).toUpperCase().replaceAll(' ', '')), campaign.id);
        if (!request || request.used_at || request.expires <= now()) fail(409, '兌換碼已使用或過期');
        const item = reward(request.reward);
        if (!item.merchantIds.includes(shop)) fail(403, '此店家不是指定兌換點');
        if (count(request.user_id) < item.threshold) fail(403, '集章數不足');
        if (ecoTotal(request.user_id) < (item.ecoThreshold || 0)) fail(403, '環保分不足');
        if (get('SELECT 1 FROM redemptions WHERE campaign=? AND user_id=? AND reward=?', campaign.id, request.user_id, item.id)) fail(409, '這份獎勵已領取');
        if (get('SELECT COUNT(*) AS n FROM redemptions WHERE campaign=? AND reward=?', campaign.id, item.id).n >= item.stock) fail(409, '這份獎勵已兌換完畢');
        const result = { name: get('SELECT name FROM users WHERE id=?', request.user_id).name, reward: item.name, ok: true };
        if (path.endsWith('/redeem')) {
          run('INSERT INTO redemptions VALUES (?,?,?,?,?)', campaign.id, request.user_id, item.id, shop, now());
          run('UPDATE requests SET used_at=? WHERE token=?', now(), request.token);
        }
        return result;
      });
    }
    fail(404, '找不到此功能');
  }
  const assets = new Map([
    ['/', ['index.html', 'text/html']], ['/staff', ['staff.html', 'text/html']],
    ['/app.js', ['app.js', 'text/javascript']], ['/staff.js', ['staff.js', 'text/javascript']],
    ['/styles.css', ['styles.css', 'text/css']], ['/eco.css', ['eco.css', 'text/css']]
  ]);
  return {
    close: () => db.close(),
    handler: async (req, res) => {
      res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://static.line-scdn.net; connect-src 'self' https://*.line.me https://*.line-scdn.net https://*.line.biz; img-src 'self' data: https://*.line-scdn.net; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      if (mode !== 'demo') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
      try {
        if (preview) {
          const supplied = text(req.headers.authorization, 512);
          const actual = Buffer.from(hash(supplied), 'hex');
          const expected = Buffer.from(hash(previewAuthorization), 'hex');
          if (!timingSafeEqual(actual, expected)) {
            res.statusCode = 401;
            res.setHeader('WWW-Authenticate', 'Basic realm="Homei phone preview", charset="UTF-8"');
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end('此預覽需要帳號與密碼');
            return;
          }
        }
        const url = new URL(req.url, origin), path = url.pathname;
        if (path === '/auth/merchant/callback' && req.method === 'GET') { await friendshipCallback(req, res, url); return; }
        if (path.startsWith('/api/')) { const result = await api(req, res, path); res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(result)); return; }
        if (path === '/healthz') { res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}'); return; }
        const asset = assets.get(path);
        if (req.method !== 'GET' || !asset) fail(404, '找不到頁面');
        res.setHeader('Content-Type', `${asset[1]}; charset=utf-8`); res.end(readFileSync(new URL(`../public/${asset[0]}`, import.meta.url)));
      } catch (error) {
        res.statusCode = error.status || 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: error.status ? error.message : '系統暫時無法處理，請稍後重試' }));
        if (!error.status) console.error('Request failed:', error.message);
      }
    }
  };
}
