// background.js — 薄路由器(MV3 兼容性最强版本)
//
// 设计原则:零顶层 await,零 importScripts,零长任务。
// background 只做消息转发和 IO(fetch / download),不保存任何业务状态。
//
// 端口协议(所有端口都叫 "ntts"):
//   接收:
//     NTTS_FETCH(url, requestId)        → 拉 HTML,回 NTTS_FETCH_RESULT
//     NTTS_DOWNLOAD(filename, text, baseDir, requestId) → 触发下载,回 NTTS_CMD_RESULT
//     NTTS_BROADCAST_PROGRESS(task)     → 广播给其他端口(content 推 progress)
//     NTTS_BROADCAST_LOG(level, message)→ 广播给其他端口
//     NTTS_SAVE_TASK(task)              → 持久化到 storage
//     NTTS_GET_TASK(requestId)          → 读 storage 的 task,回 NTTS_GET_TASK_RESULT
//     NTTS_PAUSE / NTTS_RESUME / NTTS_STOP(requestId) → 广播给所有端口
//   主动推送:
//     NTTS_PROGRESS(task)               → 推给所有端口
//     NTTS_LOG(level, message)          → 推给所有端口
//     NTTS_CMD_RESULT(...)              → 推回发起者(配 requestId)

const ports = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ntts') return;
  ports.add(port);
  console.log('[ntts-bg] 端口连接,当前总数:', ports.size);
  port.onDisconnect.addListener(() => {
    ports.delete(port);
    console.log('[ntts-bg] 端口断开,当前总数:', ports.size);
  });
  port.onMessage.addListener((msg) => {
    // 同步处理:不 await 任何东西
    try {
      const t = msg && msg.type;
      if (t === 'NTTS_FETCH') {
        doFetch(msg).catch(e => console.warn('[ntts-bg] fetch err', e));
      } else if (t === 'NTTS_DOWNLOAD') {
        doDownload(msg).catch(e => console.warn('[ntts-bg] download err', e));
      } else if (t === 'NTTS_BROADCAST_PROGRESS') {
        broadcastProgress(msg.task);
      } else if (t === 'NTTS_BROADCAST_LOG') {
        broadcastLog(msg.level, msg.message);
      } else if (t === 'NTTS_SAVE_TASK') {
        // 修复:msg.task 是 { _books: {...} },正确写入 books 字段
        if (msg.task && msg.task._books) {
          chrome.storage.local.set({ books: msg.task._books }).catch(() => {});
        } else {
          // 旧路径:把 task 自身当 currentGrabTask(给 0.4 检测未完成任务用)
          chrome.storage.local.set({ currentGrabTask: msg.task }).catch(() => {});
        }
      } else if (t === 'NTTS_GET_TASK') {
        chrome.storage.local.get(['currentGrabTask']).then(r => {
          try { port.postMessage({ type: 'NTTS_GET_TASK_RESULT', requestId: msg.requestId, task: r.currentGrabTask || null }); } catch {}
        }).catch(() => {});
      } else if (t === 'NTTS_PAUSE' || t === 'NTTS_RESUME' || t === 'NTTS_STOP') {
        // 广播给所有端口(包括 content 和 popup)
        for (const p of ports) {
          try { p.postMessage({ type: t, requestId: msg.requestId, source: port === p ? 'self' : 'other' }); } catch {}
        }
        // 同时持久化 stop 状态,content 可能没在线
        if (t === 'NTTS_STOP') {
          chrome.storage.local.get(['currentGrabTask']).then(r => {
            if (r.currentGrabTask) {
              r.currentGrabTask.stopRequested = true;
              chrome.storage.local.set({ currentGrabTask: r.currentGrabTask }).catch(() => {});
            }
          }).catch(() => {});
        }
      } else if (t === 'NTTS_LIST_BOOKS') {
        chrome.storage.local.get(['books']).then(r => {
          try { port.postMessage({ type: 'NTTS_LIST_BOOKS_RESULT', requestId: msg.requestId, books: r.books || {} }); } catch {}
        }).catch(() => {});
      }
    } catch (e) {
      console.error('[ntts-bg] 消息处理失败:', e);
    }
  });
});

// 兼容旧的 sendMessage(只保留查询类)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  try {
    if (msg && msg.type === 'NTTS_PING') {
      sendResponse({ ok: true, ts: Date.now() });
      return false;
    }
  } catch (e) {
    sendResponse({ ok: false, error: e.message });
    return false;
  }
  // 其他都不再处理 — 强制让所有调用方用 port
  sendResponse({ ok: false, error: '请用长连接 port 通信' });
  return false;
});

// ============================================================
// fetch
// ============================================================
async function doFetch(msg) {
  const { url, requestId } = msg;
  const port = findPort();
  if (!port) return;
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 20000);
    const resp = await fetch(url, { credentials: 'omit', headers: { 'Accept': 'text/html,*/*' }, signal: ctrl.signal });
    clearTimeout(tid);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = await resp.arrayBuffer();
    const html = decodeHtml(buf, resp.headers.get('content-type'));
    try { port.postMessage({ type: 'NTTS_FETCH_RESULT', requestId, ok: true, html }); } catch {}
  } catch (e) {
    // 翻译 fetch 错误为更友好的中文
    let msg = e.message || String(e);
    if (msg === 'Failed to fetch' || msg.includes('Failed to fetch')) {
      msg = '网络请求失败(可能被服务器限流/拒绝)';
    } else if (e.name === 'AbortError') {
      msg = '请求超时(>25s)';
    } else if (msg.includes('NS_BINDING_ABORTED') || msg.includes('aborted')) {
      msg = '请求被中止';
    } else if (msg.includes('CORS') || msg.includes('cross-origin')) {
      msg = '跨域被拒绝';
    }
    try { port.postMessage({ type: 'NTTS_FETCH_RESULT', requestId, ok: false, error: msg }); } catch {}
  }
}

// 找到最初发 NTTS_FETCH 的那个端口(最近一个非自身)
// 简化:总是从 ports 集合里挑第一个(content 只有一个)
function findPort() {
  for (const p of ports) {
    try { return p; } catch {}
  }
  return null;
}

function decodeHtml(buf, contentType) {
  let charset = 'utf-8';
  if (contentType) {
    const m = contentType.match(/charset=([^;]+)/i);
    if (m) charset = m[1].trim();
  }
  try {
    const peek = new TextDecoder(charset, { fatal: false }).decode(buf.slice(0, 2048));
    const mm = peek.match(/<meta[^>]+charset=["']?([^"'>\s]+)/i);
    if (mm) charset = mm[1];
  } catch {}
  try { return new TextDecoder(charset, { fatal: false }).decode(buf); }
  catch { return new TextDecoder('utf-8', { fatal: false }).decode(buf); }
}

// ============================================================
// download
// ============================================================
async function doDownload(msg) {
  const { filename, text, baseDir, requestId } = msg;
  const port = findPort();
  if (!port) return;
  const safe = (s) => (s || 'untitled').replace(/[\\/:*?"<>|\r\n\t]/g, '_').slice(0, 60);
  const fullName = `${baseDir || 'novels'}/${safe(filename)}`;

  // v0.5 修:改用 Blob URL(MV3 对 data: URL 静默丢文件)
  // Blob URL 在 service worker 上下文里 createObjectURL 能用
  let blobUrl = null;
  try {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    blobUrl = URL.createObjectURL(blob);
    const id = await chrome.downloads.download({
      url: blobUrl,
      filename: fullName,
      saveAs: false,
      conflictAction: 'uniquify',
    });
    // Chrome 拿到文件后 revoke(给点时间,5s 足够)
    setTimeout(() => { try { URL.revokeObjectURL(blobUrl); } catch {} }, 5000);
    try { port.postMessage({ type: 'NTTS_CMD_RESULT', requestId, ok: true, id, filename: fullName, method: 'blob-url' }); } catch {}
  } catch (e) {
    // Blob URL 也失败的话,降级:让 content 自己用 <a download> 触发
    let msg2 = e.message || String(e);
    if (msg2.includes('Failed to fetch') || msg2 === 'Failed to fetch') {
      msg2 = '网络请求失败(可能被服务器限流)';
    } else if (e.name === 'AbortError') {
      msg2 = '请求超时';
    }
    try { port.postMessage({ type: 'NTTS_CMD_RESULT', requestId, ok: false, error: msg2, fallback: 'use-clipboard' }); } catch {}
  } finally {
    if (blobUrl) {
      // 不立即 revoke,等 Chrome 处理
      setTimeout(() => { try { URL.revokeObjectURL(blobUrl); } catch {} }, 10000);
    }
  }
}

// ============================================================
// 广播
// ============================================================
function broadcastProgress(task) {
  for (const p of ports) {
    try { p.postMessage({ type: 'NTTS_PROGRESS', task }); } catch {}
  }
}

function broadcastLog(level, message) {
  for (const p of ports) {
    try { p.postMessage({ type: 'NTTS_LOG', level, message }); } catch {}
  }
}

console.log('[ntts-bg] service worker 已启动');
