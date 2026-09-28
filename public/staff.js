const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let config, shop, expiryTimer, toastTimer;
async function api(path, data) { const response = await fetch(path, { method: data === undefined ? 'GET' : 'POST', headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }); const result = await response.json(); if (!response.ok) throw new Error(result.error); return result; }
function toast(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false; toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 6000); }
async function act(button, fn) { button.disabled = true; try { await fn(); } catch (error) { toast(error.message); } finally { button.disabled = false; } }
function renderLogin() {
  clearInterval(expiryTimer);
  $('#staff-content').innerHTML = `${config.demo ? '<div class="demo-banner">本機示範｜工作金鑰為 demo-staff</div>' : ''}<section class="panel"><h1 class="page-title">你好，和美夥伴。</h1><p>登入你的店家，為完成任務的旅人集章。</p><form id="login-form"><label for="merchant">合作店家</label><select id="merchant">${config.campaign.merchants.map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('')}</select><label for="key">店家工作金鑰</label><input id="key" type="password" autocomplete="current-password" required ${config.demo ? 'value="demo-staff"' : ''}><button class="primary full" id="login-submit">登入工作台</button></form><p class="note">工作金鑰由主辦單位單獨提供，請勿張貼給訪客。</p></section>`;
  $('#login-form').onsubmit = event => { event.preventDefault(); act($('#login-submit'), async () => { const result = await api('/api/staff/login', { merchantId: $('#merchant').value, key: $('#key').value }); shop = result.merchant; renderDesk(); }); };
}
function renderDesk() {
  clearInterval(expiryTimer);
  const entry = new URL(config.demo ? config.origin : `https://liff.line.me/${config.liffId}`); entry.searchParams.set('shop', shop.id);
  $('#staff-content').innerHTML = `${config.demo ? '<div class="demo-banner">本機示範｜店家、任務與獎勵均為示範</div>' : ''}<div class="row"><h1 class="page-title">${esc(shop.name)}</h1><button class="text-button" id="logout">登出</button></div><p class="intro">好友章由系統驗證後自動發放。你只需要確認環保任務，以及交付好禮。</p><section class="panel"><h2>店家 LINE 集章入口</h2><p>將下方網址放進你們的 LINE 圖文選單。</p><p class="entry-link">${esc(entry.href)}</p><button class="secondary full" id="copy-entry">複製店家入口連結</button><p class="note">${config.demo ? '目前是本機預覽連結，不能放到正式 LINE 選單。' : config.campaign.merchants.find(item => item.id === shop.id).friendshipEnabled ? '已配置好友驗證，正式使用前需完成 LINE 實機測試。' : '尚未配置這間店的好友驗證，請聯絡主辦方。'}</p></section><section class="panel"><h2>01 · 環保任務加分</h2><p>請勾選這位訪客「本次確實完成」的項目。</p>${(config.campaign.ecoTasks || []).map(task => `<label class="task-option"><input type="checkbox" name="eco-task" value="${esc(task.id)}"><span><strong>${esc(task.name)} ＋${task.points} 分</strong><small>${esc(task.description)}<br>每人每日 ${task.dailyLimit} 次，跨店合計。</small></span></label>`).join('')}<button id="issue" class="primary full">確認完成，產生環保加分碼</button><div id="voucher"></div><p class="note">每個碼 2 分鐘內有效、僅限一人使用。每位訪客需產生新碼。</p></section><section class="panel"><h2>02 · 核銷好禮</h2><label for="redeem-token">訪客出示的 16 位兌換碼</label><input id="redeem-token" autocomplete="off" maxlength="24" placeholder="請輸入訪客手機上的兌換碼"><button id="lookup" class="secondary full">查詢兌換資料</button><div id="redemption"></div></section>`;
  $('#copy-entry').onclick = () => act($('#copy-entry'), async () => { await navigator.clipboard.writeText(entry.href); toast('已複製店家入口'); });
  $('#logout').onclick = () => act($('#logout'), async () => { await api('/api/staff/logout', {}); shop = null; renderLogin(); });
  $('#issue').onclick = () => act($('#issue'), async () => {
    const selected = [...document.querySelectorAll('[name="eco-task"]:checked')].map(input => input.value);
    const result = await api('/api/staff/vouchers', { tasks: selected });
    document.querySelectorAll('[name="eco-task"]').forEach(input => { input.checked = false; });
    clearInterval(expiryTimer);
    $('#voucher').innerHTML = `<p class="success">本次核准：${selected.map(id => esc(config.campaign.ecoTasks.find(task => task.id === id).name)).join('、')}</p><img class="qr" src="${esc(result.qr)}" alt="此位訪客專用環保加分 QR Code"><p id="expiry" class="note"></p><label for="voucher-token">無法掃描時，請訪客貼上此碼</label><input id="voucher-token" readonly value="${esc(result.token)}"><button id="copy" class="secondary full">複製環保加分連結</button>${config.demo ? `<p class="note"><a href="${esc(result.url)}" target="_blank" rel="noopener">本機示範：開啟訪客加分頁 ↗</a></p>` : ''}`;
    $('#copy').onclick = () => act($('#copy'), async () => { await navigator.clipboard.writeText(result.url); toast('已複製集章連結'); });
    const tick = () => { const seconds = Math.max(0, Math.ceil((result.expires - Date.now()) / 1000)); $('#expiry').textContent = seconds ? `有效時間剩餘 ${seconds} 秒。若訪客已使用，請重新產生。` : '此碼已過期，請產生新碼。'; if (!seconds) { clearInterval(expiryTimer); $('#voucher .qr').hidden = true; $('#copy').disabled = true; $('#voucher-token').value = '已過期'; } };
    tick(); expiryTimer = setInterval(tick, 1000);
  });
  $('#redeem-token').oninput = () => { $('#redemption').innerHTML = ''; };
  $('#lookup').onclick = () => act($('#lookup'), async () => {
    $('#redemption').innerHTML = '';
    const token = $('#redeem-token').value;
    const result = await api('/api/staff/rewards/lookup', { token });
    $('#redemption').innerHTML = `<p><strong>${esc(result.name)}</strong><br>兌換：${esc(result.reward)}</p><button id="redeem" class="primary full">確認交付好禮並核銷</button>`;
    $('#redeem').onclick = () => act($('#redeem'), async () => { await api('/api/staff/rewards/redeem', { token }); $('#redemption').innerHTML = '<p class="success">核銷完成 ✓，請交付好禮。</p>'; $('#redeem-token').value = ''; });
  });
}
try { config = await api('/api/config'); try { shop = (await api('/api/staff/me')).merchant; } catch { /* Show login when session is absent or expired. */ } if (shop) renderDesk(); else renderLogin(); } catch (error) { $('#staff-content').innerHTML = `<p class="error-panel">${esc(error.message)}，請重新載入。</p>`; }
