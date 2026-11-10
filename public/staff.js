const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
let config, currentShop, pendingCode = new URLSearchParams(location.search).get('coupon') || '', toastTimer;

async function api(path, data) {
  const response = await fetch(path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const payload = await response.json();
  if (!response.ok) throw Error(payload.error);
  return payload;
}

function toast(message) {
  clearTimeout(toastTimer);
  const el = $('#toast') || $('#staff-toast');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}

async function act(button, action) {
  if (button) button.disabled = true;
  try { await action(); }
  catch (error) { toast(error.message); }
  finally { if (button) button.disabled = false; }
}

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(Number(ts)).toLocaleString('zh-TW', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function renderLogin() {
  $('#staff-content').innerHTML = `
    ${config.demo ? '<div class="demo-banner">展示版工作碼：demo-staff</div>' : ''}
    <section class="panel">
      <div class="eyebrow">STAFF &amp; ORGANIZER DESK</div>
      <h1 class="page-title">店家核銷與庫存看板</h1>
      <p>請選擇您的店家並輸入工作碼（登入後 30 天內免重複登入）。登入後可查看本店即時抽獎／核銷數量、剩餘庫存與核銷明細。</p>
      <form id="login">
        <label for="merchant">選擇合作店家</label>
        <select id="merchant">${config.campaign.merchants.map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('')}</select>
        <label for="key">店家工作碼（4 碼數字）</label>
        <input id="key" type="password" inputmode="numeric" required autocomplete="current-password" placeholder="請輸入 4 碼數字工作碼（例：0503）" ${config.demo ? 'value="demo-staff"' : ''}>
        <button class="primary full">登入核銷與庫存後台</button>
      </form>
    </section>
  `;
  $('#login').onsubmit = event => {
    event.preventDefault();
    act($('#login button'), async () => {
      currentShop = (await api('/api/staff/login', { merchantId: $('#merchant').value, key: $('#key').value })).merchant;
      renderDesk();
    });
  };
}

function renderDesk() {
  $('#staff-content').innerHTML = `
    ${config.demo ? '<div class="demo-banner">展示版店家核銷後台</div>' : ''}
    <div class="row" style="flex-wrap:wrap">
      <div>
        <div class="eyebrow">STORE DASHBOARD &amp; REDEEM DESK</div>
        <h1 class="page-title" style="margin:4px 0">${esc(currentShop.name)}</h1>
      </div>
      <div style="display:flex;gap:12px;align-items:center">
        <button class="secondary" id="refresh-stats" style="padding:8px 12px;min-height:36px;font-size:12px">🔄 更新數據</button>
        <button class="text-button" id="logout">切換店家／登出</button>
      </div>
    </div>

    <section class="panel" id="stats-panel">
      <div class="row">
        <h2 style="margin:0">📊 本店禮品兌換與剩餘庫存</h2>
        <span id="stats-updated" class="note">載入中…</span>
      </div>
      <p id="shop-gift-title" class="note" style="margin:6px 0 14px;font-size:13px;color:var(--ink);font-weight:600"></p>
      <div class="stats-grid" id="stats-cards">
        <div class="stat-box"><small>📦 提供總數</small><strong id="st-stock">-</strong><span>份</span></div>
        <div class="stat-box"><small>🎯 已被抽中</small><strong id="st-drawn">-</strong><span>份</span></div>
        <div class="stat-box highlight"><small>✅ 已到店核銷</small><strong id="st-redeemed">-</strong><span>份</span></div>
        <div class="stat-box warn"><small>⏳ 尚未領取</small><strong id="st-unredeemed">-</strong><span>份</span></div>
        <div class="stat-box"><small>🎁 獎池剩餘可抽</small><strong id="st-remaining">-</strong><span>份</span></div>
      </div>
      <div class="stamp-summary-bar">
        <span>📍 本店累計集章打卡人數：<strong id="st-stamps">-</strong> 人</span>
        <small>資料已自動同步至 Google 試算表</small>
      </div>
    </section>

    <section class="panel">
      <h2>🔍 掃描或輸入 6 碼數字券碼核銷</h2>
      <p>可掃描民眾手機上的數位券 QR Code，或直接輸入券面上的 <strong>6 碼數字券碼</strong>（例：<code>582914</code>），也可直接在民眾手機上點選「店員現場核銷」。</p>
      <label for="coupon">兌換券碼（6 碼數字）</label>
      <div style="display:flex;gap:8px">
        <input id="coupon" inputmode="numeric" value="${esc(pendingCode)}" autocomplete="off" placeholder="輸入 6 碼數字券碼（例：582914）或掃碼帶入" style="margin-bottom:0;flex:1">
        <button id="lookup" class="primary" style="white-space:nowrap;min-height:46px">查詢此券</button>
      </div>
      <div id="result"></div>
    </section>

    <section class="panel">
      <div class="row">
        <h2 style="margin:0">📋 本店中獎與核銷明細</h2>
        <span id="coupon-list-count" class="note"></span>
      </div>
      <p class="note" style="margin:4px 0 12px">列出抽中本店禮品的所有民眾紀錄。若民眾人在現場，您也可以直接點右側「直接核銷」按鈕。</p>
      <div id="recent-coupons" class="coupon-log-list"><p class="note">載入明細中…</p></div>
    </section>

    <section class="panel">
      <div class="row" style="cursor:pointer" id="toggle-all-shops">
        <h2 style="margin:0">🏆 全活動 14 店總覽看板（主辦方／各店戰況）</h2>
        <span class="text-button">展開／收合 ▾</span>
      </div>
      <div id="all-shops-box" hidden style="margin-top:14px">
        <p class="note" style="margin-top:0">此總表同步寫入 Google 試算表「即時兌換統計看板」與「中獎與核銷明細紀錄」分頁。</p>
        <div class="table-scroll">
          <table class="overview-table" id="overview-table">
            <thead>
              <tr>
                <th>店家名稱</th>
                <th>集章人數</th>
                <th>提供總數</th>
                <th>已被抽中</th>
                <th>已核銷</th>
                <th>待領取</th>
                <th>剩餘可抽</th>
              </tr>
            </thead>
            <tbody id="overview-tbody"></tbody>
          </table>
        </div>
      </div>
    </section>

    <section class="panel">
      <div class="row" style="cursor:pointer" id="toggle-qr-box">
        <h2 style="margin:0">📱 店內集章 QR Code 與自動回應連結</h2>
        <span class="text-button">展開／收合 ▾</span>
      </div>
      <div id="qr-box-body" hidden style="margin-top:14px">
        <p>有 LINE OA 的店家：民眾掃碼後傳送指定文字，店家自動回應貼上專屬 LIFF 連結。</p>
        <img class="qr" id="entry-qr" alt="店內集章 QR Code">
        <a id="download-qr" class="secondary full" download="homei-store-qr.png">下載店內 QR Code</a>
        <label>店家自動回應的 LIFF 連結</label>
        <input id="liff-link" readonly>
        <button id="copy-link" class="secondary full">複製自動回應連結</button>
        <p id="entry-note" class="note"></p>
      </div>
    </section>
  `;

  $('#logout').onclick = () => act($('#logout'), async () => {
    await api('/api/staff/logout', {});
    currentShop = null;
    renderLogin();
  });
  $('#refresh-stats').onclick = () => act($('#refresh-stats'), loadStats);
  $('#lookup').onclick = () => act($('#lookup'), lookup);
  $('#coupon').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); act($('#lookup'), lookup); } };
  $('#toggle-all-shops').onclick = () => { $('#all-shops-box').hidden = !$('#all-shops-box').hidden; };
  $('#toggle-qr-box').onclick = () => { $('#qr-box-body').hidden = !$('#qr-box-body').hidden; };

  if (pendingCode) lookup();
  loadStats();
  loadEntry();
}

async function loadStats() {
  try {
    const data = await api('/api/staff/stats');
    const s = data.shopStats || { stock: 0, drawn: 0, redeemed: 0, unredeemed: 0, remaining: 0, stampCount: 0, giftSummary: '' };
    $('#shop-gift-title').textContent = `禮品項目：${s.giftSummary || currentShop.giftSummary || '本店專屬禮品'}`;
    $('#st-stock').textContent = s.stock;
    $('#st-drawn').textContent = s.drawn;
    $('#st-redeemed').textContent = s.redeemed;
    $('#st-unredeemed').textContent = s.unredeemed;
    $('#st-remaining').textContent = s.remaining;
    $('#st-stamps').textContent = s.stampCount;
    $('#stats-updated').textContent = `更新於 ${new Date(data.updatedAt).toLocaleTimeString('zh-TW', { hour12: false })}`;

    const list = data.recentCoupons || [];
    $('#coupon-list-count').textContent = `共 ${list.length} 筆中獎紀錄`;
    if (!list.length) {
      $('#recent-coupons').innerHTML = '<p class="note" style="padding:12px 0">目前尚無民眾抽中本店禮品。</p>';
    } else {
      $('#recent-coupons').innerHTML = list.map(item => `
        <div class="coupon-log-item ${item.usedAt ? 'is-redeemed' : 'is-pending'}">
          <div class="log-main">
            <div class="log-top">
              <span class="badge ${item.usedAt ? 'badge-done' : 'badge-wait'}">${item.usedAt ? '✅ 已核銷' : '⏳ 待領取'}</span>
              <code class="short-code">#${esc(item.shortCode)}</code>
              <strong>${esc(item.visitor)}</strong>
            </div>
            <div class="log-sub">
              <span>${esc(item.prize)}</span>
              <small>${item.usedAt ? `核銷於 ${fmtDate(item.usedAt)}` : `抽中於 ${fmtDate(item.created)}`}</small>
            </div>
          </div>
          ${item.usedAt ? '' : `<button class="secondary quick-redeem" data-quick-code="${esc(item.code)}" data-quick-visitor="${esc(item.visitor)}" data-quick-short="${esc(item.shortCode)}">直接核銷</button>`}
        </div>
      `).join('');

      document.querySelectorAll('[data-quick-code]').forEach(btn => {
        btn.onclick = () => act(btn, async () => {
          const code = btn.dataset.quickCode;
          const visitor = btn.dataset.quickVisitor;
          const sc = btn.dataset.quickShort;
          if (!confirm(`確定要核銷「${visitor}」的數位券（#${sc}）嗎？\n核銷後無法復原，請確認已交付禮品。`)) return;
          await api('/api/staff/coupons/redeem', { code });
          toast(`已核銷 #${sc}（${visitor}）✓`);
          await loadStats();
        });
      });
    }

    const rows = data.allShopsOverview || [];
    const t = data.totals || { stampCount: 0, stock: 0, drawn: 0, redeemed: 0, unredeemed: 0, remaining: 0 };
    $('#overview-tbody').innerHTML = [
      ...rows.map(r => `
        <tr class="${r.merchantId === currentShop.id ? 'current-shop-row' : ''}">
          <td><strong>${esc(r.merchantName)}</strong><br><small class="note">${esc(r.giftSummary)}</small></td>
          <td>${r.stampCount}</td>
          <td>${r.stock}</td>
          <td>${r.drawn}</td>
          <td><strong>${r.redeemed}</strong></td>
          <td>${r.unredeemed}</td>
          <td>${r.remaining}</td>
        </tr>
      `),
      `<tr class="total-row">
        <td><strong>【全活動合計】</strong></td>
        <td><strong>${t.stampCount}</strong></td>
        <td><strong>${t.stock}</strong></td>
        <td><strong>${t.drawn}</strong></td>
        <td><strong>${t.redeemed}</strong></td>
        <td><strong>${t.unredeemed}</strong></td>
        <td><strong>${t.remaining}</strong></td>
      </tr>`,
    ].join('');
  } catch (error) {
    toast(error.message);
  }
}

async function loadEntry() {
  try {
    const entry = await api('/api/staff/entry');
    $('#entry-qr').src = entry.qr;
    $('#download-qr').href = entry.qr;
    $('#download-qr').download = `${currentShop.id}-homei-qr.png`;
    $('#liff-link').value = entry.liffLink;
    $('#entry-note').textContent = entry.lineLink ? `LINE OA QR 已預填「${entry.keyword}」。請把上方 LIFF 連結貼入關鍵字自動回應。` : '此店為 Facebook 任務入口；QR 直接開啟該店任務頁。';
    $('#copy-link').onclick = () => act($('#copy-link'), async () => {
      await navigator.clipboard.writeText(entry.liffLink);
      toast('已複製 LIFF 自動回應連結');
    });
  } catch (error) {
    toast(error.message);
  }
}

async function lookup() {
  const code = $('#coupon').value.trim();
  if (!code) throw Error('請掃描或輸入兌換券碼');
  const result = await api('/api/staff/coupons/lookup', { code });
  pendingCode = result.code || code;
  $('#result').innerHTML = `
    <div class="coupon-check">
      <span class="eyebrow">VALID COUPON · #${esc(result.shortCode || '')}</span>
      <h3>${esc(result.prize)}</h3>
      <p>中獎會員：<strong>${esc(result.visitor)}</strong></p>
      <p class="note">${esc(result.instructions)}${result.expires ? `<br>有效至 ${new Date(result.expires).toLocaleString('zh-TW')}` : ''}</p>
      <button id="redeem" class="primary full">確認交付獎品並核銷</button>
    </div>
  `;
  $('#redeem').onclick = () => act($('#redeem'), async () => {
    await api('/api/staff/coupons/redeem', { code: pendingCode });
    $('#result').innerHTML = '<p class="success"><strong>✅ 核銷完成！</strong>請將禮品交給民眾，上方統計與明細已即時更新。</p>';
    $('#coupon').value = '';
    pendingCode = '';
    history.replaceState(null, '', '/staff');
    await loadStats();
  });
}

async function boot() {
  try {
    config = await api('/api/config');
    try { currentShop = (await api('/api/staff/me')).merchant; } catch { /* Login required. */ }
    if (currentShop) renderDesk();
    else renderLogin();
  } catch (error) {
    $('#staff-content').innerHTML = `<div class="error-panel">${esc(error.message)}</div>`;
  }
}

boot();
