const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let config, me, currentTab = 'passport', filter = '全部', source = '', claimToken = '', toastTimer;
async function api(path, data) {
  const response = await fetch(path, { method: data === undefined ? 'GET' : 'POST', headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '連線失敗，請稍後重試');
  return result;
}
function toast(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false; toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 6500); }
function modal(title, html) { $('#modal-title').textContent = title; $('#modal-body').innerHTML = html; if (!$('#modal').open) $('#modal').showModal(); }
function closeModal() { $('#modal').close(); }
async function perform(button, fn) { button.disabled = true; try { await fn(); } catch (error) { toast(error.message); } finally { if (button.isConnected) button.disabled = false; } }
const collected = id => me.stamps.some(stamp => stamp.merchant === id);
const tasks = () => config.campaign.ecoTasks || [];
const todayCount = id => me.ecoCredits.filter(row => row.task === id && row.day === me.today).length;
function shopCard(shop) {
  return `<button class="shop-card" data-shop="${esc(shop.id)}"><span class="shop-art ${['peach','sage','yellow'].includes(shop.color) ? shop.color : 'sage'}">${esc(shop.icon)}</span><span class="shop-copy"><span class="category">${esc(shop.category)}${collected(shop.id) ? ' · 已集章 ✓' : ''}</span><h3>${esc(shop.name)}</h3><p>${esc(shop.description)}</p></span><span class="shop-arrow">↗</span></button>`;
}
function render() {
  document.querySelectorAll('[data-tab]').forEach(button => { button.classList.toggle('selected', button.dataset.tab === currentTab); if (button.dataset.tab === currentTab) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
  const campaign = config.campaign, total = me.stamps.length, target = campaign.rewards[0]?.threshold || campaign.merchants.length || 1;
  if (currentTab === 'passport') {
    const entry = campaign.merchants.find(shop => shop.id === source);
    $('#main').innerHTML = `${entry ? `<div class="source-banner">從「${esc(entry.name)}」出發${collected(entry.id) ? ' · 好友章已收藏 ✓' : ' · 驗證好友，收藏這一站'}</div>` : ''}
      <section class="hero"><div class="eyebrow">${esc(campaign.periodLabel)}</div><h1>小鎮慢慢走，<br><em>好日子集起來。</em></h1><p>你好，${esc(me.user.name)}<br>加入小店好友，把和美收藏起來。</p><div class="hero-art" aria-hidden="true"><i class="sun"></i><i class="house"></i><i class="house second"></i><i class="tree"></i><i class="ground"></i></div></section>
      <section class="passport-card" aria-label="集章進度"><div class="card-top"><span class="eyebrow">MY LOCAL PASSPORT</span><span class="tag">${esc(campaign.organizer)}・探店護照</span></div><div class="passport-count"><strong>${String(total).padStart(2, '0')}</strong><span>/ ${campaign.merchants.length} 枚店家好友章</span></div><div class="progress-track"><progress max="${target}" value="${Math.min(total, target)}" aria-label="首份獎勵集章進度"></progress></div><div class="progress-caption"><span>${total >= target ? '店家章已達標，看看好禮條件！' : `再收集 ${target - total} 枚章，達到首份好禮章數`}</span><span>${total} / ${target}</span></div><button class="primary" id="explore-open">${entry && !collected(entry.id) ? '確認這間店的好友資格' : '探索店家，加入好友集章'} ↗</button></section>
      <section class="eco-summary"><div><span class="eyebrow">GREEN ACTIONS</span><h2>讓這趟小旅行，更綠一點。</h2><p>自備杯、騎 MOOVO，讓行動變成環保分。</p></div><strong>${me.ecoPoints}<small>環保分</small></strong><button class="text-button" data-go="eco">查看環保任務 ↗</button></section>
      <aside class="friend-card"><span class="friend-icon">✦</span><div class="friend-copy"><strong>${me.user.friend === 1 ? '已加入主辦官方帳號' : '和美的下一站，LINE 告訴你'}</strong><p>${config.demo ? '正式版將連結主辦單位的官方帳號' : '活動消息，一個帳號就收得到。'}</p></div><button class="text-button" id="friend-action">${me.user.friend === 1 ? '開啟聊天 ↗' : '加入好友 ↗'}</button></aside>
      <div class="section-heading"><h2>我的店家好友章</h2><span>每店限領一次</span></div><div class="stamp-grid">${campaign.merchants.map(shop => `<button class="stamp-slot ${collected(shop.id) ? 'collected' : ''}" data-shop="${esc(shop.id)}"><span class="stamp-icon">${esc(shop.icon)}</span><strong>${esc(shop.name)}</strong><small>${collected(shop.id) ? '已收藏 ✓' : '加入好友集章'}</small></button>`).join('')}</div><p class="note">既有好友也能領章。系統確認資格後自動入章，不必消費。</p><div class="section-heading"><h2>下一站，去哪裡？</h2><button class="text-button" data-go="explore">探索全部 ↗</button></div>${campaign.merchants.filter(shop => !collected(shop.id)).slice(0, 2).map(shopCard).join('') || '<p class="note">店家好友章都集齊了！繼續完成環保任務吧。</p>'}`;
    $('#explore-open').onclick = () => entry && !collected(entry.id) ? shopDialog(entry.id) : navigate('explore');
    $('#friend-action').onclick = () => openOa(config.mainOaId);
  } else if (currentTab === 'explore') {
    const categories = ['全部', ...new Set(campaign.merchants.map(shop => shop.category))];
    $('#main').innerHTML = `<div class="eyebrow">WANDER AROUND HOMEI</div><h1 class="page-title">把和美，走成日常。</h1><p class="intro">認識小店的故事，加入好友收藏店家章。<br>${campaign.sample ? '目前為 3 間示範店家，正式名單待確認。' : `共 ${campaign.merchants.length} 間合作店家。`}</p><div class="filter-row" aria-label="店家分類">${categories.map(category => `<button class="${filter === category ? 'active' : ''}" data-filter="${esc(category)}">${esc(category)}</button>`).join('')}</div>${campaign.merchants.filter(shop => filter === '全部' || shop.category === filter).map(shopCard).join('')}`;
    document.querySelectorAll('[data-filter]').forEach(button => button.onclick = () => { filter = button.dataset.filter; render(); });
  } else if (currentTab === 'eco') {
    $('#main').innerHTML = `<div class="eyebrow">SMALL ACTIONS, GREENER DAYS</div><h1 class="page-title">為和美，多做一點。</h1><p class="intro">你已累積 ${me.ecoPoints} 分環保分。<br>完成任務後，請店員確認並提供加分碼。</p>${tasks().map(task => `<section class="eco-task"><span class="eco-icon" aria-hidden="true">${esc(task.icon)}</span><div><h2>${esc(task.name)} <small>+${task.points}</small></h2><p>${esc(task.description)}</p><p class="note">每人每日 ${task.dailyLimit} 次，所有店家合計<br>今日已完成 ${todayCount(task.id)} / ${task.dailyLimit} 次${todayCount(task.id) >= task.dailyLimit ? ' ✓' : ''}</p></div></section>`).join('')}<button id="eco-claim" class="primary full">掃描店員提供的環保加分碼</button><p class="note">環保分與店家章分開計算。每日次數於臺灣時間 00:00 重置。${campaign.sample ? '目前分數、每日上限皆為示範設定。' : ''}</p><div class="section-heading"><h2>我的環保紀錄</h2></div>${me.ecoCredits.length ? `<ul class="history-list">${me.ecoCredits.map(row => `<li><div><strong>${esc(tasks().find(task => task.id === row.task)?.name || row.task)}</strong><small>${esc(campaign.merchants.find(shop => shop.id === row.merchant)?.name)} · ${esc(row.day)}</small></div><span>+${row.points}</span></li>`).join('')}</ul>` : '<p class="note">還沒有紀錄，從今天帶上自己的杯子開始。</p>'}`;
    $('#eco-claim').onclick = claimDialog;
  } else {
    $('#main').innerHTML = `<div class="eyebrow">A LITTLE LOCAL DELIGHT</div><h1 class="page-title">收集的小美好，換成禮。</h1><p class="intro">你有 ${total} 枚店家章、${me.ecoPoints} 分環保分。<br>達標後，請到指定兌換點出示兌換碼。</p>${campaign.rewards.map(item => {
      const redeemed = me.redemptions.some(row => row.reward === item.id), missingStamps = Math.max(0, item.threshold - total), missingEco = Math.max(0, (item.ecoThreshold || 0) - me.ecoPoints), ready = !missingStamps && !missingEco;
      const missing = [missingStamps ? `${missingStamps} 枚章` : '', missingEco ? `${missingEco} 環保分` : ''].filter(Boolean).join('、');
      return `<section class="reward-card"><div class="reward-art" aria-hidden="true">♧</div><span class="eyebrow">${item.sample ? '示範獎勵' : '在地好禮'}</span><h2>${esc(item.name)}</h2><p>${esc(item.description)}</p><p>門檻：${item.threshold} 枚店家章${item.ecoThreshold ? ` ＋ ${item.ecoThreshold} 環保分` : ''}</p><small>兌換點：${item.merchantIds.map(id => esc(campaign.merchants.find(shop => shop.id === id).name)).join('、')}<br>每人限領一次 · 不扣章或環保分 · 數量有限</small><button class="primary full" data-reward="${esc(item.id)}" ${redeemed || !ready ? 'disabled' : ''}>${redeemed ? '已完成兌換 ✓' : ready ? '出示兌換碼 ↗' : `還差 ${missing}`}</button></section>`;
    }).join('')}`;
    document.querySelectorAll('[data-reward]').forEach(button => button.onclick = () => perform(button, async () => {
      const id = button.dataset.reward, result = await api('/api/rewards/request', { rewardId: id });
      modal('到店出示兌換碼', `<p>請到「${result.merchantNames.map(esc).join('、')}」出示此畫面。由店員核對並交付好禮。</p><code class="code-display">${esc(result.token)}</code><p class="note">有效至 ${new Date(result.expires).toLocaleTimeString('zh-TW', { hour12: false })}，重新產生會使舊碼失效。</p><button id="redemption-refresh" class="primary full">店家已核銷，更新紀錄</button>`);
      $('#redemption-refresh').onclick = () => perform($('#redemption-refresh'), async () => { me = await api('/api/me'); render(); closeModal(); toast(me.redemptions.some(row => row.reward === id) ? '兌換完成，謝謝你來和美走走！' : '尚未核銷，請由店家確認後再更新'); });
    }));
  }
  document.querySelectorAll('[data-shop]').forEach(button => button.onclick = () => shopDialog(button.dataset.shop));
  document.querySelectorAll('[data-go]').forEach(button => button.onclick = () => navigate(button.dataset.go));
}
function navigate(tab) { currentTab = tab; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
function openOa(id) {
  if (config.demo || !id) { toast(config.demo ? '這是示範帳號，不會開啟真實店家 LINE。' : '此官方帳號尚未設定。'); return; }
  const url = `https://line.me/R/ti/p/${encodeURIComponent(id)}`;
  if (window.liff?.isInClient()) window.liff.openWindow({ url, external: false }); else window.open(url, '_blank', 'noopener');
}
function shopDialog(id, notice = '') {
  const shop = config.campaign.merchants.find(item => item.id === id);
  if (!shop) return;
  modal(shop.name, `${notice ? `<p class="source-banner" role="status">${esc(notice)}</p>` : ''}<p>${esc(shop.description)}</p><p><strong>加入這間店的 LINE，收藏好友章</strong><br>新好友、既有好友都能領取，每人每店限一枚。</p><p class="note">${esc(shop.address)}${shop.sample ? '<br>此為示範店家，並非正式合作名單。' : ''}</p>${collected(id) ? '<p class="success">這一站已收藏 ✓</p>' : `<button class="primary full" id="shop-verify" ${shop.friendshipEnabled ? '' : 'disabled'}>${shop.friendshipEnabled ? (config.demo ? '預覽好友驗證流程' : '確認好友資格並領章') : '尚未啟用好友驗證'}</button><p class="note">${config.demo ? '示範流程不會連線 LINE，也不代表已加入真實好友。' : '首次驗證可能需要同意店家的 LINE 授權，完成後會回到集章冊。'}</p>`}<button id="shop-add" class="secondary full">開啟店家 LINE／加入好友 ↗</button>`);
  if ($('#shop-verify')) $('#shop-verify').onclick = () => perform($('#shop-verify'), () => verifyShop(id));
  $('#shop-add').onclick = () => openOa(shop.officialAccountId);
}
async function verifyShop(id) {
  const result = await api('/api/merchants/verify', { merchantId: id });
  if (result.collected) { me = await api('/api/me'); render(); shopDialog(id); return; }
  if (result.demo) {
    modal('好友驗證 · 本機示範', '<p>正式版會向 LINE 查詢這間店的好友狀態。現在可以體驗兩種結果：</p><div class="form-actions"><button id="demo-yes" class="primary full">模擬：已加入好友</button><button id="demo-no" class="secondary full">模擬：尚未加入好友</button></div><p class="note">本機示範操作不會加入任何 LINE 帳號。</p>');
    for (const [selector, friend] of [['#demo-yes', true], ['#demo-no', false]]) $(selector).onclick = () => perform($(selector), async () => { me = await api('/api/demo/friendship', { merchantId: id, friend }); render(); shopDialog(id, friend ? '好友資格確認成功，店家章已入帳。' : '尚未加入好友，請先加入店家 LINE 再確認。'); });
    return;
  }
  const url = new URL(result.url);
  if (url.origin !== 'https://access.line.me') throw new Error('驗證網址不正確');
  location.assign(url.href);
}
function readToken(value) {
  try { const url = new URL(value); const allowed = config.demo ? new URL(config.origin).origin : 'https://liff.line.me'; if (url.origin !== allowed || (!config.demo && url.pathname !== `/${config.liffId}`)) throw new Error(); return url.searchParams.get('claim') || ''; } catch { return /^[\w-]{32}$/.test(value.trim()) ? value.trim() : ''; }
}
function claimDialog() {
  modal('領取環保加分', '<p>完成自備杯或 MOOVO 任務後，請店員確認並提供限時 QR Code。</p><div class="form-actions"><button id="scan-button" class="primary">開啟 LINE 掃描器</button></div><label for="claim-input">或貼上環保加分連結／代碼</label><input id="claim-input" autocomplete="off" placeholder="貼上店員提供的連結或代碼"><button id="claim-submit" class="secondary full">確認領取環保分</button><p class="note">每個碼 2 分鐘內有效，僅限一位訪客使用。</p>');
  $('#scan-button').onclick = () => perform($('#scan-button'), async () => {
    if (config.demo || !window.liff?.isInClient() || !window.liff.isApiAvailable('scanCodeV2')) { toast('請使用 LINE 或手機相機掃描，或將店家代碼貼到下方'); return; }
    const result = await window.liff.scanCodeV2(); if (result.value) await claim(readToken(result.value));
  });
  $('#claim-submit').onclick = () => perform($('#claim-submit'), () => claim(readToken($('#claim-input').value)));
}
async function claim(token) {
  if (!token) throw new Error('請貼上有效的環保加分連結或代碼');
  me = await api('/api/stamps/claim', { token });
  sessionStorage.removeItem('homei-claim'); claimToken = '';
  closeModal(); currentTab = 'eco'; render();
  toast(`環保分已入帳！${me.awarded?.skipped.length ? '部分任務今日已達上限，未重複加分。' : ''}`);
}
function info() {
  modal('這本護照，怎麼使用？', `<p>從任一家店的 LINE 進入同一本護照。系統驗證店家好友資格後，自動發給該店一枚章，既有好友也可領取。</p><p>自備杯與 MOOVO 任務由店員現場確認，再掃加分碼取得環保分。兩種紀錄分開累積，兌換條件以獎勵頁為準。</p><p><strong>資料使用</strong><br>系統保存會員識別碼、顯示名稱、店家帳號綁定與好友驗證紀錄、集章、環保加分及兌換紀錄，用於活動與防止重複領取。店家 LINE 授權只用來核對好友資格並連回本集章會員。驗證後不保存 LINE access token、ID token 或騎乘截圖。</p><p class="note">主辦：${esc(config.campaign.organizer)}<br>資料更正、刪除或活動洽詢：${esc(config.campaign.privacyContact)}${config.demo ? '<br>本機示範共用一個示範會員，未連線驗證 LINE。' : ''}</p><button class="secondary full" id="refresh-account">更新集章與主帳號好友狀態</button>`);
  $('#refresh-account').onclick = () => perform($('#refresh-account'), async () => { await authenticate(); render(); closeModal(); toast('狀態已更新'); });
}
async function authenticate() {
  me = await api(config.demo ? '/api/auth/demo' : '/api/auth/line', config.demo ? { source } : { idToken: window.liff.getIDToken(), accessToken: window.liff.getAccessToken(), source });
}
async function boot() {
  try {
    config = await api('/api/config');
    $('#demo-banner').hidden = !config.demo && !config.campaign.sample;
    if (!config.demo) {
      await new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = 'https://static.line-scdn.net/liff/edge/2/sdk.js'; script.onload = resolve; script.onerror = () => reject(new Error('LINE 元件載入失敗，請重試')); document.head.append(script); });
      await window.liff.init({ liffId: config.liffId });
    }
    const params = new URLSearchParams(location.search);
    const incomingShop = params.get('shop') || params.get('source') || '';
    source = incomingShop || sessionStorage.getItem('homei-source') || '';
    if (!config.campaign.merchants.some(shop => shop.id === source)) source = '';
    if (source) sessionStorage.setItem('homei-source', source);
    claimToken = params.get('claim') || sessionStorage.getItem('homei-claim') || '';
    if (claimToken) sessionStorage.setItem('homei-claim', claimToken);
    if (!config.demo && !window.liff.isLoggedIn()) { window.liff.login({ redirectUri: location.href }); return; }
    await authenticate();
    const outcome = params.get('verification');
    for (const name of ['claim', 'verification']) params.delete(name);
    history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`);
    render();
    if (claimToken) {
      modal('領取這次的環保加分', '<p>店員已提供加分碼。確認後，系統會檢查各項任務的今日上限。</p><button class="primary full" id="pending-claim">確認領取環保分</button>');
      $('#pending-claim').onclick = () => perform($('#pending-claim'), async () => { try { await claim(claimToken); } catch (error) { sessionStorage.removeItem('homei-claim'); claimToken = ''; throw error; } });
    } else if (outcome) {
      const messages = { success: collected(source) ? '好友驗證成功，店家章已入帳。' : '尚未取得店家章，請重新驗證。', 'not-friend': '尚未加入好友或已封鎖，請先加入店家 LINE 再確認。', cancelled: '你已取消授權，這次沒有新增店家章。', error: '好友驗證未完成。請在原本的 LINE 集章頁重試。' };
      if (source) shopDialog(source, messages[outcome] || messages.error); else toast(messages.error);
    } else if (incomingShop && source && !collected(source)) {
      try { await verifyShop(source); } catch (error) { shopDialog(source, error.message); }
    } else if (incomingShop && !source) toast('找不到這個店家入口，請從店家列表選擇。');
  } catch (error) { $('#main').innerHTML = `<div class="error-panel"><strong>護照暫時打不開</strong><p>${esc(error.message)}</p><button class="secondary" id="retry">重新載入</button></div>`; $('#retry').onclick = () => location.reload(); }
}
$('#close-modal').onclick = closeModal;
$('#modal').addEventListener('click', event => { if (event.target === $('#modal')) { const bounds = $('#modal').getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeModal(); } });
document.querySelectorAll('[data-tab]').forEach(button => button.onclick = () => { if (me) navigate(button.dataset.tab); });
$('#profile-button').onclick = $('#privacy-button').onclick = () => { if (me) info(); };
boot();
