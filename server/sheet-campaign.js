import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const sheetBase = 'https://sheets.googleapis.com/v4/spreadsheets';
const clean = value => String(value ?? '').trim();
const rowsToObjects = values => {
  const [headers = [], ...rows] = values;
  return rows.filter(row => row.some(cell => clean(cell))).map(row => Object.fromEntries(headers.map((header, index) => [clean(header), clean(row[index])])));
};
const statusIsLive = row => clean(row['上架狀態']) === '上架';
const parseDate = value => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};
const normalizeTask = value => clean(value).toUpperCase() === 'FACEBOOK' ? 'FACEBOOK' : 'LINE_OA';

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
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
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
    if (!this.spreadsheetId) throw new Error('缺少 GOOGLE_SHEET_ID，無法同步活動上架資料');
    const credentials = serviceAccount();
    const token = await accessToken(credentials, this.fetcher);
    const ranges = ['店家上架管理!A:N', '獎品上架管理!A:I'];
    const url = new URL(`${sheetBase}/${encodeURIComponent(this.spreadsheetId)}/values:batchGet`);
    for (const range of ranges) url.searchParams.append('ranges', range);
    const response = await this.fetcher(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error('無法讀取 Google Sheet；請確認已將工作表分享給服務帳號');
    const payload = await response.json();
    const [merchantRange = {}, prizeRange = {}] = payload.valueRanges || [];
    const merchants = rowsToObjects(merchantRange.values || []).filter(statusIsLive).map(row => ({
      id: clean(row['店家代號']),
      name: clean(row['店家名稱']),
      address: clean(row['店家地址']),
      navigationName: clean(row['導航名稱']) || clean(row['店家名稱']),
      taskType: normalizeTask(row['任務方式']),
      hasLineOA: normalizeTask(row['任務方式']) !== 'FACEBOOK',
      lineOaUrl: clean(row['LINE OA 連結']),
      officialAccountId: clean(row['LINE @ID']),
      facebookUrl: clean(row['Facebook 粉專連結']),
      hours: clean(row['營業時間']),
      description: clean(row['公開簡介']) || '一起收下這一站的和美印記。',
      startsAt: parseDate(row['有效起日']),
      endsAt: parseDate(row['有效迄日']),
      category: '合作店家', icon: '⌂', color: 'sage', sample: false,
    })).filter(item => item.id && item.name && (item.taskType === 'FACEBOOK' ? item.facebookUrl : item.officialAccountId || item.lineOaUrl));
    const merchantIds = new Set(merchants.map(item => item.id));
    const prizes = rowsToObjects(prizeRange.values || []).filter(statusIsLive).map(row => ({
      id: clean(row['獎品代號']),
      name: clean(row['獎品／優惠內容']),
      description: clean(row['民眾顯示說明']) || clean(row['獎品／優惠內容']),
      stock: Number.parseInt(clean(row['庫存']), 10),
      redemptionMerchantIds: clean(row['可核銷店家代號']).split(',').map(value => value.trim()).filter(Boolean),
      expiresAt: parseDate(row['有效迄日']),
      instructions: clean(row['民眾顯示說明']) || '請出示數位券，由店員確認後核銷。',
      sample: false,
    })).filter(item => item.id && item.name && Number.isInteger(item.stock) && item.stock >= 0 && item.redemptionMerchantIds.length && item.redemptionMerchantIds.every(id => merchantIds.has(id)));
    return { ...baseCampaign, sample: false, merchants, prizes };
  }
}
