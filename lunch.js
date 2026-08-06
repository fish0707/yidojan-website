/**
 * 午餐訂單彙整系統 — 共用工具
 * lunch.html 與 lunch_admin.html 都會載入這支。
 */

// 午餐訂單專用的 GAS 部署網址（與飲料店那組是不同的試算表與部署，不要混用）
// 之後在 Apps Script 重新部署時若產生了新網址，記得回來換這一行
const GAS_URL = 'https://script.google.com/macros/s/AKfycbz9haHSLuwnAbzA4qBFY8dayuUooiStARUSwjA-XvsPuKmauSHqCLrfRTDYBOlLZHwX1w/exec';

// ─── API ─────────────────────────────────────────────────────────────────────
async function gasGet(params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${GAS_URL}?${qs}`);
  return res.json();
}

// 注意：刻意不帶 Content-Type header。加了會觸發 CORS preflight，
// 而 Google Apps Script Web App 不回應 OPTIONS 請求。
async function gasPost(body) {
  const res = await fetch(GAS_URL, { method: 'POST', body: JSON.stringify(body) });
  return res.json();
}

// ─── 本機身分 ─────────────────────────────────────────────────────────────────
const LS_NAME  = 'lunch_my_name';
const LS_TOKEN = 'lunch_client_token';
const LS_LAST  = 'lunch_last_order_';   // + restaurantId

function getMyName() {
  return localStorage.getItem(LS_NAME) || '';
}

function setMyName(name) {
  localStorage.setItem(LS_NAME, String(name || '').trim());
}

/** 用來證明「這筆訂單是我送的」，避免誤改到別人的單 */
function getClientToken() {
  let t = localStorage.getItem(LS_TOKEN);
  if (!t) {
    t = 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
    localStorage.setItem(LS_TOKEN, t);
  }
  return t;
}

function saveLastOrder(restaurantId, items) {
  try {
    localStorage.setItem(LS_LAST + restaurantId, JSON.stringify(items || []));
  } catch (e) { /* 容量滿了就算了，不影響主流程 */ }
}

function loadLastOrder(restaurantId) {
  try {
    return JSON.parse(localStorage.getItem(LS_LAST + restaurantId) || '[]');
  } catch (e) {
    return [];
  }
}

// ─── 格式化 ───────────────────────────────────────────────────────────────────
function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString('zh-TW');
}

function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtClock(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
}

/** 一律經過這裡輸出到 innerHTML，避免名字或備註裡的字元破壞版面 */
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ─── 伺服器時間校正 ───────────────────────────────────────────────────────────
// 同事的電腦時鐘可能不準，倒數一律以伺服器時間為準。
let _clockSkew = 0;

function syncClock(serverNow) {
  if (serverNow) _clockSkew = serverNow - Date.now();
}

function serverTime() {
  return Date.now() + _clockSkew;
}

/**
 * 倒數計時。onTick(remainMs) 每秒呼叫一次，歸零時再呼叫 onExpire 一次。
 * 回傳 stop 函式。
 */
function startCountdown(closeAt, onTick, onExpire) {
  let expired = false;
  const tick = () => {
    const remain = closeAt - serverTime();
    onTick(remain);
    if (remain <= 0 && !expired) {
      expired = true;
      if (onExpire) onExpire();
    }
  };
  tick();
  const id = setInterval(tick, 1000);
  return () => clearInterval(id);
}

function fmtRemain(ms) {
  if (ms <= 0) return '已截止';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

// ─── Toast ───────────────────────────────────────────────────────────────────
let _toastTimer = null;

function showToast(msg, isError) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

// ─── 複製到剪貼簿 ─────────────────────────────────────────────────────────────
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('已複製，可直接貼到 LINE 群組');
    return true;
  } catch (e) {
    // http 或舊瀏覽器沒有 clipboard API，退回 execCommand
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    showToast(ok ? '已複製，可直接貼到 LINE 群組' : '複製失敗，請手動選取', !ok);
    return ok;
  }
}

// ─── 圖片壓縮 ─────────────────────────────────────────────────────────────────
/**
 * 手機直拍的照片動輒 4～8MB，轉成 base64 還會再脹 33%，
 * 直接送會撐爆 GAS 的請求上限、也讓辨識變慢。
 * 先在瀏覽器縮到長邊 1600px 再轉 JPEG —— 這個解析度對讀菜單文字綽綽有餘。
 */
function compressImage(file, maxEdge, quality) {
  maxEdge = maxEdge || 1600;
  quality = quality || 0.85;

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('讀取檔案失敗'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('這個檔案不是有效的圖片'));
      img.onload = () => {
        let { width, height } = img;
        const scale = Math.min(1, maxEdge / Math.max(width, height));
        width = Math.round(width * scale);
        height = Math.round(height * scale);

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        resolve({
          base64: dataUrl.split(',')[1],
          mimeType: 'image/jpeg',
          dataUrl,
          width,
          height,
        });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ─── 純文字彙整（給店家 / 給收錢） ────────────────────────────────────────────
function summaryTextForShop(summary) {
  const lines = [];
  const r = summary.restaurant || {};
  lines.push(`【${summary.session?.title || '午餐訂單'}】${r.name || ''}`);
  if (r.phone) lines.push(`電話：${r.phone}`);
  lines.push('');
  summary.byItem.forEach((it) => {
    const note = it.note ? `（${it.note}）` : '';
    lines.push(`${it.name}${note} x${it.qty} = ${fmtMoney(it.subtotal)}`);
  });
  lines.push('');
  lines.push(`共 ${summary.totalQty} 份，總計 ${fmtMoney(summary.grandTotal)}`);
  return lines.join('\n');
}

function summaryTextForMoney(summary) {
  const lines = [];
  lines.push(`【${summary.session?.title || '午餐訂單'}】收錢清單`);
  lines.push('');
  summary.byPerson.forEach((p) => {
    const items = p.items.map((it) => {
      const q = it.qty > 1 ? ` x${it.qty}` : '';
      const note = it.note ? `(${it.note})` : '';
      return `${it.name}${note}${q}`;
    }).join('、');
    lines.push(`${p.name}：${items} → ${fmtMoney(p.total)}`);
  });
  lines.push('');
  lines.push(`共 ${summary.peopleCount} 人，總計 ${fmtMoney(summary.grandTotal)}`);
  return lines.join('\n');
}
