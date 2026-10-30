import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const sheetBase = 'https://sheets.googleapis.com/v4/spreadsheets';
const clean = value => String(value ?? '').trim();
const rowsToObjects = values => {
  const [headers = [], ...rows] = values;
  return rows.filter(row => row.some(cell => clean(cell))).map(row => Object.fromEntries(headers.map((header, index) => [clean(header), clean(row[index])])));
};
const statusIsHidden = row => clean(row['上架狀態']) === '下架';
const parseDate = value => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};
const normalizeTask = value => clean(value).toUpperCase() === 'FACEBOOK' ? 'FACEBOOK' : 'LINE_OA';
const parseStock = value => {
  const match = clean(value).match(/(\d+)\s*[-~～]\s*(\d+)/);
  if (match) return Number.parseInt(match[2], 10);
  const single = clean(value).match(/(\d+)/);
  return single ? Number.parseInt(single[1], 10) : 0;
};

function loadProductionSeed() {
  try {
    return JSON.parse(readFileSync(new URL('../config/production-seed.json', import.meta.url), 'utf8'));
  } catch {
    return null;
  }
}

function serviceAccount() {
  const file = process.env.GOOGLE_SERVICE_ACCOUNT_FILE || '';
  const raw = file ? readFileSync(file, 'utf8') : process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';
  if (!raw) throw new Error('缺少 GOOGLE_SERVICE_ACCOUNT_JSON 或 GOOGLE_SERVICE_ACCOUNT_FILE，無法同步活動上架資料');
  try { return JSON.parse(raw); } catch { throw new Error(file ? 'GOOGLE_SERVICE_ACCOUNT_FILE 不是有效 JSON' : 'GOOGLE_SERVICE_ACCOUNT_JSON 不是有效 JSON'); }
}

async function accessToken(credentials, fetcher) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claim = Buffer.from(JSON.stringify({
    iss: credentials.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: credentials.token_uri || 'https://oauth2.googleapis.com/token',
    iat: issuedAt,
    exp: issuedAt + 3600,
  })).toString('base64url');
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const assertion = `${header}.${claim}.${signer.sign(credentials.private_key, 'base64url')}`;
  const response = await fetcher(credentials.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('Google 服務帳號授權失敗');
  const payload = await response.json();
  if (!payload.access_token) throw new Error('Google 服務帳號未回傳存取權杖');
  return payload.access_token;
}

export class SheetCampaignSync {
  constructor({ spreadsheetId, fetcher = fetch }) {
    this.spreadsheetId = spreadsheetId;
    this.fetcher = fetcher;
  }

  async load(baseCampaign) {
    const seed = loadProductionSeed() || baseCampaign;
    const merchantMap = new Map((seed.merchants || []).map(m => [m.id, { ...m, sample: false }]));
    const prizeMap = new Map((seed.prizes || []).map(p => [p.id, { ...p, sample: false }]));

    if (!this.spreadsheetId) {
      return { ...seed, sample: false, merchants: [...merchantMap.values()], prizes: [...prizeMap.values()] };
    }

    const credentials = serviceAccount();
    const token = await accessToken(credentials, this.fetcher);
    const ranges = ['表單回覆 1!A:J', '店家上架管理!A:N', '獎品上架管理!A:I'];
    const url = new URL(`${sheetBase}/${encodeURIComponent(this.spreadsheetId)}/values:batchGet`);
    for (const range of ranges) url.searchParams.append('ranges', range);
    const response = await this.fetcher(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error('無法讀取 Google Sheet；請確認已將工作表分享給服務帳號');
    const payload = await response.json();
    const [formRange = {}, merchantRange = {}, prizeRange = {}] = payload.valueRanges || [];
    const formSubmittedIds = new Set();
    const explicitlyActiveIds = new Set();
    const explicitlyHiddenIds = new Set();

    // 1. Merge from 表單回覆 1
    for (const row of rowsToObjects(formRange.values || [])) {
      const name = clean(row['店家名稱']);
      if (!name) continue;
      const existing = [...merchantMap.values()].find(m => m.name.includes(name) || name.includes(m.name));
      const id = existing ? existing.id : `shop-${Buffer.from(name).toString('hex').slice(0, 8)}`;
      formSubmittedIds.add(id);
      const lineOaUrl = clean(row['LINE 官方帳號連結（例：https://lin.ee/xxxx）']);
      const facebookUrl = clean(row['Facebook 粉絲專頁連結（例：https://www.facebook.com/店家名稱）']);
      const giftName = clean(row['可提供的禮物／優惠內容（例：飲品、商品、折扣或體驗）']) || '禮品待補';
      const qtyRaw = clean(row['提供數量（份）（例：10 份）']);
      const stock = parseStock(qtyRaw);
      const hours = clean(row['店家營業時間（例：週一至週五 11:00–19:00；週日公休）']) || existing?.hours || '待補';
      const giftSummary = `${giftName}（${qtyRaw || (stock ? `${stock}份` : '份數待補')}）`;
      const prev = existing || {
        id, name, category: '合作店家', icon: '⌂', color: 'sage', address: '', navigationName: name,
        taskType: lineOaUrl ? 'LINE_OA' : (facebookUrl ? 'FACEBOOK' : 'LINE_OA'),
        hasLineOA: Boolean(lineOaUrl), officialAccountId: '', sample: false,
      };
      merchantMap.set(id, {
        ...prev,
        lineOaUrl: lineOaUrl || prev.lineOaUrl || '',
        facebookUrl: facebookUrl || prev.facebookUrl || '',
        hours,
        giftSummary,
        description: prev.description || `禮品：${giftSummary}`,
        sample: false,
      });
      const existingPrize = [...prizeMap.values()].find(p => p.redemptionMerchantIds?.includes(id));
      const prizeId = existingPrize ? existingPrize.id : `${id}-gift`;
      prizeMap.set(prizeId, {
        id: prizeId,
        name: `${prev.name.split('（')[0]}｜${giftName}`,
        description: giftSummary,
        stock: Number.isInteger(stock) && stock >= 0 ? stock : (existingPrize?.stock || 0),
        redemptionMerchantIds: [id],
        expiresAt: existingPrize?.expiresAt || null,
        instructions: `請於 ${prev.name} 出示此數位券，由店員確認後核銷。`,
        sample: false,
      });
    }

    // 2. Merge from 店家上架管理
    for (const row of rowsToObjects(merchantRange.values || [])) {
      const id = clean(row['店家代號']);
      if (!id) continue;
      if (statusIsHidden(row)) {
        explicitlyHiddenIds.add(id);
        merchantMap.delete(id);
        continue;
      }
      if (clean(row['上架狀態']) === '上架') {
        explicitlyActiveIds.add(id);
      }
      const prev = merchantMap.get(id) || { id, category: '合作店家', icon: '⌂', color: 'sage', sample: false };
      const name = clean(row['店家名稱']) || prev.name;
      if (!name) continue;
      merchantMap.set(id, {
        ...prev,
        id,
        name,
        address: clean(row['店家地址']) || prev.address || '',
        navigationName: clean(row['導航名稱']) || prev.navigationName || name,
        taskType: row['任務方式'] ? normalizeTask(row['任務方式']) : (prev.taskType || 'LINE_OA'),
        hasLineOA: (row['任務方式'] ? normalizeTask(row['任務方式']) : (prev.taskType || 'LINE_OA')) !== 'FACEBOOK',
        lineOaUrl: clean(row['LINE OA 連結']) || prev.lineOaUrl || '',
        officialAccountId: clean(row['LINE @ID']) || prev.officialAccountId || '',
        facebookUrl: clean(row['Facebook 粉專連結']) || prev.facebookUrl || '',
        hours: clean(row['營業時間']) || prev.hours || '待補',
        description: clean(row['公開簡介']) || prev.description || '一起收下這一站的和美印記。',
        startsAt: parseDate(row['有效起日']) || prev.startsAt || null,
        endsAt: parseDate(row['有效迄日']) || prev.endsAt || null,
        sample: false,
      });
    }

    // 3. Merge from 獎品上架管理
    for (const row of rowsToObjects(prizeRange.values || [])) {
      const id = clean(row['獎品代號']);
      if (!id) continue;
      if (statusIsHidden(row)) {
        prizeMap.delete(id);
        continue;
      }
      const prev = prizeMap.get(id) || { id, sample: false };
      const name = clean(row['獎品／優惠內容']) || prev.name;
      const stockVal = Number.parseInt(clean(row['庫存']), 10);
      const redemptionMerchantIds = clean(row['可核銷店家代號']).split(',').map(v => v.trim()).filter(Boolean);
      prizeMap.set(id, {
        ...prev,
        id,
        name: name.includes('｜') ? name : `${merchantMap.get(redemptionMerchantIds[0])?.name?.split('（')[0] || ''}｜${name}`.replace(/^｜/, ''),
        description: clean(row['民眾顯示說明']) || prev.description || name,
        stock: Number.isInteger(stockVal) && stockVal >= 0 ? stockVal : (prev.stock ?? 0),
        redemptionMerchantIds: redemptionMerchantIds.length ? redemptionMerchantIds : (prev.redemptionMerchantIds || []),
        expiresAt: parseDate(row['有效迄日']) || prev.expiresAt || null,
        instructions: clean(row['民眾顯示說明']) || prev.instructions || '請出示數位券，由店員確認後核銷。',
        sample: false,
      });
    }

    // Filter merchants: only keep stores that have filled out 表單回覆 1, or are explicitly '上架' in 店家上架管理
    const activeMerchants = [...merchantMap.values()].filter(m => {
      if (explicitlyHiddenIds.has(m.id)) return false;
      return formSubmittedIds.has(m.id) || explicitlyActiveIds.has(m.id);
    });
    const activeMerchantIds = new Set(activeMerchants.map(m => m.id));

    return {
      ...seed,
      sample: false,
      merchants: activeMerchants,
      prizes: [...prizeMap.values()].filter(p => p.redemptionMerchantIds?.every(id => activeMerchantIds.has(id))),
    };
  }
}
