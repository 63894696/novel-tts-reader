// content.js — 抓取主控(content script 常驻,不会休眠)
//
// 架构职责:
//  - 浮动按钮 + 抓取面板 + 抓取监控面板
//  - 抓取循环(单 chapter 多页合并,多 chapter 顺序)
//  - 调 background 拉 HTML 和下载文件
//  - 通过 background 广播 progress 和 log(给 popup)
//
// 关键设计:
//  - 所有 IO(fetch / download)都走 background
//  - 抓取状态保存在 content 内存,持久化到 chrome.storage
//  - 暂停/继续/停止 通过 port 双向收发

(() => {
  if (window.__ntts_grabber_injected__) return;
  window.__ntts_grabber_injected__ = true;

  const E = globalThis.NTTS_EXTRACTORS;

  // ============================================================
  // 抓取状态(单一数据源)
  // ============================================================
  const state = {
    task: null,        // 当前 task
    paused: false,
    stopped: false,
    runPromise: null,  // 抓取循环的 promise
  };

  // ============================================================
  // Port 长连接到 background
  // ============================================================
  let port = null;
  let _reqCounter = 0;
  const _pendingReqs = new Map(); // requestId → {resolve, reject, timer}

  function connectPort() {
    if (port) return port;
    try {
      port = chrome.runtime.connect({ name: 'ntts' });
      port.onMessage.addListener(onPortMessage);
      port.onDisconnect.addListener(() => {
        const err = chrome.runtime.lastError;
        port = null;
        if (err && /context invalidated/i.test(err.message || '')) {
          // 扩展刚被更新/重载,旧的 content script 还活着但 background 已无
          // 不重连(重连也没用),提示用户刷新页面
          console.warn('[ntts-content] 扩展已更新,此页面需要刷新才能继续使用');
          toast('⚠️ 扩展已更新,请刷新此页面');
        } else {
          console.log('[ntts-content] port 断开,重连中...');
          setTimeout(connectPort, 1000);
        }
      });
      console.log('[ntts-content] port 已连接');
    } catch (e) {
      // chrome.runtime.connect 同步抛错的情况(扩展已失效,sw 重启等)
      // 区分 context invalidated(永无救,需刷新页面) vs 临时错误(可重连)
      const msg = (e && e.message) || String(e);
      if (/context invalidated/i.test(msg)) {
        console.warn('[ntts-content] 扩展已失效,此页面需要刷新:', msg);
        toast('⚠️ 扩展已更新或重载,请刷新此页面');
        // 不重连,也不置 port = null(避免后续 sendRequest 走重试路径)
      } else {
        console.warn('[ntts-content] port 连接失败,1s 后重试:', msg);
        port = null;
        setTimeout(connectPort, 1000);
      }
    }
    return port;
  }

  function onPortMessage(msg) {
    // 1. 响应 requestId 的命令
    if (msg.requestId && _pendingReqs.has(msg.requestId)) {
      const { resolve, reject, timer } = _pendingReqs.get(msg.requestId);
      _pendingReqs.delete(msg.requestId);
      clearTimeout(timer);
      if (msg.ok === false) reject(new Error(msg.error || '失败'));
      else resolve(msg);
      return;
    }
    // 2. 进度 / 日志 / 控制命令
    if (msg.type === 'NTTS_PROGRESS') {
      // 可能来自自己或 popup
      // 这里 content 是 source of truth,通常是自己推的
      renderTaskMonitor(msg.task);
    } else if (msg.type === 'NTTS_LOG') {
      appendLog(msg.level, msg.message);
    } else if (msg.type === 'NTTS_PAUSE') {
      if (msg.source === 'other') {
        state.paused = true;
        appendLog('info', '⏸ 收到暂停命令(来自 popup)');
      }
    } else if (msg.type === 'NTTS_RESUME') {
      if (msg.source === 'other') {
        state.paused = false;
        appendLog('info', '▶ 收到继续命令(来自 popup)');
      }
    } else if (msg.type === 'NTTS_STOP') {
      if (msg.source === 'other') {
        state.stopped = true;
        appendLog('warn', '⏹ 收到停止命令(来自 popup)');
      }
    } else if (msg.type === 'NTTS_GET_TASK_RESULT') {
      // 启动时拉到的旧任务
      if (msg.task && !state.task) {
        state.task = msg.task;
        renderTaskMonitor(msg.task);
        appendLog('info', `📋 已恢复上次任务:${msg.task.bookTitle || '?'}`);
      }
    }
  }

  function sendRequest(type, payload = {}, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      if (!port) connectPort();
      if (!port) return reject(new Error('port 未连接'));
      const requestId = `req_${Date.now()}_${++_reqCounter}`;
      const timer = setTimeout(() => {
        _pendingReqs.delete(requestId);
        reject(new Error(`请求超时(${timeoutMs / 1000}s)`));
      }, timeoutMs);
      _pendingReqs.set(requestId, { resolve, reject, timer });
      try {
        port.postMessage({ type, requestId, ...payload });
      } catch (e) {
        _pendingReqs.delete(requestId);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  // 浏览器原生下载(走 <a download> + Blob URL,完全不依赖 service worker 的 URL API)
  // 这样保存到用户 Chrome 的默认下载目录(用户的 D:\down\)
  function downloadViaAnchor(text, filename) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    a.style.display = 'none';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      try { document.body.removeChild(a); } catch {}
      try { URL.revokeObjectURL(blobUrl); } catch {}
    }, 2000);
  }

  function broadcastProgress(task) {
    if (!task) return;
    try { port?.postMessage({ type: 'NTTS_BROADCAST_PROGRESS', task }); } catch {}
  }
  function broadcastLog(level, message) {
    try { port?.postMessage({ type: 'NTTS_BROADCAST_LOG', level, message }); } catch {}
  }
  function saveTaskPersist() {
    try { port?.postMessage({ type: 'NTTS_SAVE_TASK', task: state.task }); } catch {}
  }

  // ============================================================
  // 抓取主循环
  // ============================================================

  // 路由 + 提取(走新架构的 safeExtract,失败有兜底)
  function extractWithAdapter(html, baseUrl) {
    return E.safeExtract(baseUrl, html, baseUrl);
  }

  // 列表提取(目录页用)
  function listChaptersWithAdapter(html, baseUrl) {
    const adapter = E.route(baseUrl);
    if (!adapter || typeof adapter.listChapters !== 'function') return [];
    try { return adapter.listChapters(html, baseUrl) || []; }
    catch (e) { console.warn('[NTTS] listChapters 失败:', e); return []; }
  }

  // 目录分页探测
  function bookIndexPagesWithAdapter(html, baseUrl) {
    const adapter = E.route(baseUrl);
    if (!adapter || typeof adapter.bookIndexPages !== 'function') return [baseUrl];
    try { return adapter.bookIndexPages(html, baseUrl) || [baseUrl]; }
    catch (e) { console.warn('[NTTS] bookIndexPages 失败:', e); return [baseUrl]; }
  }

  // fetch 重试包装(3 次指数退避:1s/2s/4s)
  async function fetchWithRetry(url, maxRetries = 3) {
    let lastErr = null;
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await sendRequest('NTTS_FETCH', { url }, 25000);
      } catch (e) {
        lastErr = e;
        if (i < maxRetries - 1) {
          const wait = 1000 * Math.pow(2, i);
          logTask('warn', `  ↳ 拉取失败 ${i + 1}/${maxRetries},${wait}ms 后重试(${e.message})`);
          await sleep(wait);
        }
      }
    }
    throw lastErr || new Error('拉取失败');
  }

  async function startGrab({ startUrl, mode, startIndex, endIndex, resumeFrom }) {
    if (state.runPromise) {
      return { ok: false, error: '已有任务在跑' };
    }
    state.paused = false;
    state.stopped = false;

    // 初始化 task
    state.task = {
      id: 'task_' + Date.now(),
      bookKey: '',
      bookTitle: '加载中…',
      startUrl,
      mode,
      status: 'running',
      startedAt: Date.now(),
      totalChapters: 0,
      toFetchCount: 0,
      currentIdx: 0,
      currentChapter: null,
      currentPageCount: 0,
      chapters: [],
      fetched: [],
      failures: [],
    };
    // 续抓模式:把已抓的 fetched + failures 灌回去
    if (resumeFrom && (resumeFrom.fetched?.length || resumeFrom.failures?.length)) {
      state.task.fetched = resumeFrom.fetched || [];
      state.task.failures = resumeFrom.failures || [];
      state.task.startedAt = Date.now();
      logTask('info', `🔁 续抓:已保留 ${state.task.fetched.length} 章 / ${state.task.failures.length} 失败记录`);
    }
    saveTaskPersist();
    broadcastProgress(snapshotTask(state.task));
    logTask('info', `🚀 启动抓取任务,模式:${mode === 'chase' ? '追更' : (resumeFrom ? '续抓' : '全量')}`);
    logTask('info', `📍 起点:${startUrl}`);

    // 启动后台循环
    state.runPromise = runInitAndGrab(startUrl, mode, { startIndex, endIndex }, resumeFrom).catch(e => {
      logTask('error', `顶层错误:${e.message}`);
      if (state.task) {
        state.task.status = 'error';
        state.task.error = e.message;
        saveTaskPersist();
        broadcastProgress(snapshotTask(state.task));
      }
    }).finally(() => {
      state.runPromise = null;
    });

    return { ok: true, accepted: true, taskId: state.task.id };
  }

  async function runInitAndGrab(startUrl, mode, range = {}, resumeFrom = null) {
    // 1. 拉起点
    logTask('info', `📥 拉取起点页面…`);
    let html;
    try {
      const r = await fetchWithRetry(startUrl);
      html = r.html;
    } catch (e) {
      logTask('error', `起点拉取失败(3次重试后):${e.message}`);
      return;
    }
    logTask('success', `起点拉取完成 (${(html.length / 1024).toFixed(1)} KB)`);

    // 2. 识别适配器 + 提取
    const adapter = E.route(startUrl);
    logTask('info', `🔌 适配器:${adapter ? adapter.name : '(无)'}`);

    const first = E.safeExtract(startUrl, html, startUrl);
    if (first && first.text) {
      logTask('info', `  书名="${first.bookTitle}",章节="${first.chapterTitle}"`);
    } else {
      logTask('warn', `  适配器未提取到正文(可能是目录页,继续走抓整本)`);
    }

    // 拿书名
    let bookTitle = first?.bookTitle || '';
    if (!bookTitle) { const m = html.match(/var\s+Title\s*=\s*["']([^"']+)/); if (m) bookTitle = m[1]; }
    if (!bookTitle) { const h1a = html.match(/<h1[^>]*>\s*<a[^>]*>([^<]+)<\/a>/); if (h1a) bookTitle = h1a[1].trim(); }
    if (!bookTitle) { try { bookTitle = new URL(startUrl).pathname.split('/').filter(Boolean)[0] || '未知'; } catch { bookTitle = '未知'; } }
    state.task.bookTitle = bookTitle;

    // bookKey
    const bookKey = first?.bookIndexUrl || `https://${new URL(startUrl).host}${new URL(startUrl).pathname.split('/').slice(0, 2).join('/')}/`;
    state.task.bookKey = bookKey;

    // 3. 拉目录
    let chapters = [];
    if (adapter && typeof adapter.listChapters === 'function') {
      // 决定要探测的目录基准 URL:
      //   1) 优先用 first.bookIndexUrl(从单章页能提到)
      //   2) 兜底用 bookKey(从 startUrl 推断,如 /416/p-2.html → /416/)
      // 这样从分页页(/416/p-2.html#dir)启动时,也能正常合并首页
      const baseIndexUrl = first?.bookIndexUrl || bookKey;

      // startUrl 的 html 缓存(总是有效的,顶部已经 fetch 成功)
      const html0 = html;
      // 首页/基准页的 html(可能跟 startUrl 同也可能不同,探测分页用)
      let baseIndexHtml = html0;
      if (startUrl !== baseIndexUrl) {
        try {
          baseIndexHtml = (await fetchWithRetry(baseIndexUrl)).html;
        } catch (e) {
          logTask('warn', `拉首页 ${baseIndexUrl} 失败:${e.message} — 分页探测可能不全`);
        }
      }

      // 探测分页
      const pages = bookIndexPagesWithAdapter(baseIndexHtml, baseIndexUrl);

      // indexUrls 顺序:startUrl 优先(用 html0 缓存必成功),再 baseIndexUrl,再其他分页
      // 这样即使其他分页 fetch 失败,startUrl 本身的内容一定能拿到
      const seen = new Set();
      const order = [];
      const tryAdd = (u) => {
        if (!u) return;
        const norm = u.replace(/#.*$/, '');
        // 去重:用去掉 hash 后的 norm 作 seen key
        for (const ex of seen) {
          if (ex.replace(/#.*$/, '') === norm) return;
        }
        seen.add(u);
        order.push(u);
      };
      tryAdd(startUrl);            // 起点优先(html0 缓存)
      tryAdd(baseIndexUrl);        // 基准页
      for (const p of pages) tryAdd(p);  // 所有分页

      const indexUrls = order;
      logTask('info', `📚 探测到 ${indexUrls.length} 个目录页:${indexUrls.map(u => u.replace(/^https?:\/\/[^/]+/, '')).join(', ')}`);

      for (let pi = 0; pi < indexUrls.length; pi++) {
        const iu = indexUrls[pi];
        try {
          if (pi > 0) await sleep(1000);  // 间隔 1s 防限流
          logTask('info', `📑 拉目录页 ${pi + 1}/${indexUrls.length}:${iu.replace(/^https?:\/\/[^/]+/, '')}`);
          // html 缓存复用:startUrl 必有,baseIndexUrl 如果跟 startUrl 不同就用 baseIndexHtml
          let ih;
          const iuNorm = iu.replace(/#.*$/, '');
          const startNorm = startUrl.replace(/#.*$/, '');
          const baseNorm = baseIndexUrl.replace(/#.*$/, '');
          if (iuNorm === startNorm) {
            ih = html0;
          } else if (iuNorm === baseNorm && startNorm !== baseNorm) {
            ih = baseIndexHtml;
          } else {
            ih = (await fetchWithRetry(iu)).html;
          }
          const list = listChaptersWithAdapter(ih, iu);
          logTask('success', `  本页 ${list.length} 章`);
          chapters = chapters.concat(list);
        } catch (e) {
          logTask('error', `  目录页 ${iu} 拉取失败:${e.message}(后续分页会继续,可能缺章!)`);
        }
      }
    }

    if (chapters.length === 0) {
      logTask('warn', `⚠️ 没拿到目录,按单章处理`);
      chapters = [{ index: first?.chapterIndex || 1, title: first?.chapterTitle || '本章', url: startUrl }];
    } else {
      chapters = normalizeChapterIndexes(chapters);
    }
    logTask('success', `📚 识别到 ${chapters.length} 章(去重前合并)`);

    // 详细诊断:显示 chapters 数组里 index 字段的真实分布
    const indexValues = chapters.map(c => c.index).filter(Boolean);
    const minIdx = indexValues.length ? Math.min(...indexValues) : 0;
    const maxIdx = indexValues.length ? Math.max(...indexValues) : 0;
    const placeholderCount = chapters.filter(c => !(c.title || '').match(/第\s*\d+\s*章/)).length;
    logTask('info', `📊 chapters 详情:index 范围 [${minIdx}-${maxIdx}],含"第 N 章"的有 ${indexValues.length},占位 ${placeholderCount}`);

    // 3.5 范围过滤(mode=range 时按用户输入的章节号范围)
    if (mode === 'range' && chapters.length > 0) {
      const s = range.startIndex || 1;
      const e = range.endIndex || 999999;
      const before = chapters.length;
      chapters = chapters.filter(c => c.index >= s && c.index <= e);
      logTask('info', `📍 范围过滤:第 ${s}-${e} 章(过滤后 ${chapters.length} 章,过滤前 ${before})`);
    }

    // 4. 模式分流
    const stored = await getStoredBook(bookKey);
    let toFetch;
    if (resumeFrom) {
      // 续抓模式:按 URL 跳过已抓(不论是 fetched 还是 failures 都不重抓)
      const known = new Set([
        ...(resumeFrom.fetched || []).map(c => c.url),
        ...(resumeFrom.failures || []).map(c => c.url),
      ]);
      toFetch = chapters.filter(c => c.url && !known.has(c.url));
      logTask('info', `🔁 续抓:跳过已抓/失败 ${known.size} 条,待抓 ${toFetch.length}`);
    } else if (mode === 'incremental' && stored?.chapters?.length) {
      // 增量:按章节号(index)去重(适合导入基准后补缺的场景)
      const knownIdx = new Set(stored.chapters.map(c => c.index).filter(Boolean));
      toFetch = chapters.filter(c => !knownIdx.has(c.index));
      logTask('info', `🔄 增量模式:按章节号去重,已存 ${chapters.length - toFetch.length} 章,待抓 ${toFetch.length}`);
    } else if (mode === 'chase' && stored?.chapters?.length) {
      // 追更:按 URL 去重(适合连载站加新章)
      const known = new Set(stored.chapters.map(c => c.url));
      toFetch = chapters.filter(c => !known.has(c.url));
      logTask('info', `🔄 追更模式:按 URL 去重,已存 ${chapters.length - toFetch.length} 章,待抓 ${toFetch.length}`);
    } else {
      toFetch = chapters.slice();
      logTask('info', `📦 全量模式:待抓 ${toFetch.length}`);
    }

    if (toFetch.length === 0) {
      logTask('success', `✨ 没有新章节`);
      state.task.status = 'completed';
      state.task.totalChapters = chapters.length;
      state.task.toFetchCount = 0;
      state.task.finishedAt = Date.now();
      saveTaskPersist();
      broadcastProgress(snapshotTask(state.task));
      return;
    }

    state.task.totalChapters = chapters.length;
    state.task.toFetchCount = toFetch.length;
    state.task.chapters = chapters.map(c => ({ ...c, status: 'pending' }));
    saveTaskPersist();
    broadcastProgress(snapshotTask(state.task));

    // 5. 抓取循环
    await runGrabLoop(adapter, toFetch, bookKey);
  }

  async function runGrabLoop(adapter, toFetch, bookKey) {
    for (let i = 0; i < toFetch.length; i++) {
      // 暂停/停止检测
      if (state.stopped) {
        logTask('warn', `⏹ 任务已停止,已抓 ${state.task.fetched.length} 章`);
        state.task.status = 'stopped';
        break;
      }
      while (state.paused && !state.stopped) {
        if (state.task.status !== 'paused') {
          state.task.status = 'paused';
          saveTaskPersist();
          broadcastProgress(snapshotTask(state.task));
          logTask('info', '⏸ 已暂停');
        }
        await sleep(300);
      }
      if (state.stopped) {
        logTask('warn', `⏹ 任务已停止`);
        state.task.status = 'stopped';
        break;
      }
      if (state.task.status === 'paused') {
        state.task.status = 'running';
        logTask('info', '▶ 已继续');
      }

      const ch = toFetch[i];
      state.task.currentIdx = i;
      state.task.currentChapter = ch;
      state.task.currentPageCount = 0;
      const tCh = state.task.chapters.find(c => c.url === ch.url);
      if (tCh) tCh.status = 'fetching';
      saveTaskPersist();
      broadcastProgress(snapshotTask(state.task));

      logTask('info', `📖 [${i + 1}/${toFetch.length}] ${ch.title}`);

      // 抓取(可能多页)
      try {
        const result = await grabChapter(ch.url, adapter);
        if (result.pages > 1) logTask('info', `  ↳ 合并 ${result.pages} 页`);

        const safeName = sanitizeFilename(`${state.task.bookTitle}_${pad(i + 1, 4)}${result.chapterTitle ? '_' + result.chapterTitle : ''}.txt`);
        // 只存纯净正文;header 留给导出时按需拼(避免整本导出时双重叠加)
        const cleanText = result.text;

        state.task.fetched.push({
          chapterIndex: ch.index,
          title: result.chapterTitle,
          url: ch.url,
          pages: result.pages,
          text: cleanText,
          filename: safeName,
        });
        if (tCh) tCh.status = 'done';
        logTask('success', `  ✓ ${result.chapterTitle} (${result.text.length} 字)`);

        // 写追更记录(包含正文!关 tab 不丢)
        await updateStoredBook(bookKey, {
          title: state.task.bookTitle,
          chapter: {
            url: ch.url,
            title: ch.title || result.chapterTitle,
            index: ch.index,
            pages: result.pages,
            content: result.text,                       // ← 关键:存正文
            text: result.text,                          // 兼容字段
            fingerprint: fingerprint(result.text),
            fetchedAt: Date.now(),
          },
        });
      } catch (e) {
        logTask('error', `  ✗ 失败:${e.message}`);
        state.task.failures.push({ url: ch.url, title: ch.title, error: e.message });
        if (tCh) tCh.status = 'failed';
      }

      saveTaskPersist();
      broadcastProgress(snapshotTask(state.task));
      await sleep(2000); // 限速 2s,避免触发 sudu 反爬
    }

    if (state.task.status === 'running') {
      state.task.status = 'completed';
      logTask('success', `🎉 完成!共 ${state.task.fetched.length} 章${state.task.failures.length ? `,失败 ${state.task.failures.length}` : ''}`);
    }
    state.task.finishedAt = Date.now();
    saveTaskPersist();
    broadcastProgress(snapshotTask(state.task));
  }

  async function grabChapter(startUrl, adapter) {
    const pages = [];
    let cur = startUrl;
    let base = null;
    let pageCount = 0;
    while (cur && pageCount < 50) {
      pageCount++;
      const r = await fetchWithRetry(cur);
      const ext = E.safeExtract(cur, r.html, cur);
      if (!ext) throw new Error(`提取失败:${cur}`);
      if (ext.error) throw new Error(`适配器错误:${ext.error}`);
      if (!base) base = ext;
      pages.push({ url: cur, text: ext.text, pageIndex: ext.pageIndex || pageCount });
      // 推 page 进度
      state.task.currentPageCount = pageCount;
      broadcastProgress(snapshotTask(state.task));
      // 是否继续
      if (ext.nextPageUrl && ext.nextPageUrl !== cur) cur = ext.nextPageUrl;
      else break;
      await sleep(200);
    }
    const merged = pages.sort((a, b) => a.pageIndex - b.pageIndex).map(p => p.text).join('\n\n');
    return { ...base, text: merged, pages: pageCount };
  }

  // ============================================================
  // 追更存储
  // ============================================================
  let _booksCache = null;
  async function getStoredBook(bookKey) {
    if (!_booksCache) {
      try {
        const r = await sendRequest('NTTS_LIST_BOOKS', {}, 5000);
        _booksCache = r.books || {};
      } catch { _booksCache = {}; }
    }
    return _booksCache[bookKey] || null;
  }
  async function updateStoredBook(bookKey, { title, chapter }) {
    if (!_booksCache) await getStoredBook(bookKey);
    _booksCache[bookKey] = _booksCache[bookKey] || { title, chapters: [] };
    if (title) _booksCache[bookKey].title = title;
    _booksCache[bookKey].lastUpdate = Date.now();
    if (chapter && !_booksCache[bookKey].chapters.some(c => c.url === chapter.url)) {
      _booksCache[bookKey].chapters.push(chapter);
    }
    // 写回(content 调 background 的保存,简化:写整个 books 缓存)
    try { port?.postMessage({ type: 'NTTS_SAVE_TASK', task: { _books: _booksCache } }); } catch {}
  }

  // 计算章节指纹(前 200 字 hash) — 用于后续 Phase 1 识别"改稿"
  function fingerprint(text) {
    const head = (text || '').replace(/\s+/g, '').slice(0, 200);
    let h = 0;
    for (let i = 0; i < head.length; i++) h = ((h << 5) - h + head.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  // 拼整本书文本(供"复制到剪贴板"用)
  function buildFullText() {
    if (!state.task || !state.task.fetched.length) return '';
    const sep = (i, ch) => `\n\n${'='.repeat(60)}\n第 ${i} 章  ${ch.title}\n${'='.repeat(60)}\n\n`;
    return [
      `《${state.task.bookTitle}》  整本抓取\n`,
      `共 ${state.task.fetched.length} 章(本次抓取)\n`,
      `抓取时间:${new Date().toLocaleString()}\n`,
      ...state.task.fetched.map((ch, i) => sep(i + 1, ch) + ch.text.replace(/^《.*?》.*?\n=+\n+/s, '')),
    ].join('\n');
  }

  // ============================================================
  // 工具
  // ============================================================
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function pad(n, w) { return String(n).padStart(w, '0'); }
  function sanitizeFilename(s) { return (s || 'x').replace(/[\\/:*?"<>|\r\n\t]/g, '_').slice(0, 120); }
  function snapshotTask(t) {
    return {
      id: t.id, bookKey: t.bookKey, bookTitle: t.bookTitle, mode: t.mode,
      status: t.status, totalChapters: t.totalChapters, toFetchCount: t.toFetchCount,
      currentIdx: t.currentIdx, currentPageCount: t.currentPageCount, currentChapter: t.currentChapter,
      fetchedCount: t.fetched.length, failureCount: t.failures.length,
      startedAt: t.startedAt, finishedAt: t.finishedAt,
    };
  }
  function logTask(level, msg) {
    console.log(`[ntts-content] ${msg}`);
    broadcastLog(level, msg);
  }

  // ============================================================
  // UI
  // ============================================================
  function injectFab() {
    if (document.getElementById('ntts-fab')) return;
    const fab = document.createElement('div');
    fab.id = 'ntts-fab';
    fab.innerHTML = '<span>📖</span><span style="margin-left:6px">抓取</span>';
    Object.assign(fab.style, {
      position: 'fixed', right: '24px', bottom: '80px', zIndex: '2147483647',
      display: 'flex', alignItems: 'center', padding: '10px 16px',
      background: '#1f6feb', color: '#fff', borderRadius: '24px',
      cursor: 'pointer', font: '14px/1 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
      boxShadow: '0 4px 12px rgba(0,0,0,.2)', userSelect: 'none',
      transition: 'transform .15s, opacity .15s',
    });
    fab.onmouseenter = () => fab.style.transform = 'scale(1.05)';
    fab.onmouseleave = () => fab.style.transform = 'scale(1)';

    let busy = false;
    fab.onclick = async () => {
      if (busy) return;
      busy = true;
      const original = fab.innerHTML;
      fab.innerHTML = '<span>⏳</span><span style="margin-left:6px">提取中…</span>';
      fab.style.opacity = '0.7';
      try {
        if (isIndexPage()) {
          fab.innerHTML = original;
          fab.style.opacity = '1';
          openBookConfig({ bookTitle: detectBookTitleFromIndex(), startUrl: location.href });
          return;
        }
        const data = await extractCurrent();
        fab.innerHTML = original;
        fab.style.opacity = '1';
        if (data.__err) { toast(`❌ ${data.__err}`); return; }
        openPanel(data);
      } catch (e) {
        fab.innerHTML = original;
        fab.style.opacity = '1';
        toast(`❌ ${e.message}`);
      } finally {
        busy = false;
      }
    };
    (document.body || document.documentElement).appendChild(fab);
  }

  function isIndexPage() {
    return location.hash === '#dir' || /\/p-\d+\.html/.test(location.pathname) || !!document.querySelector('#list');
  }
  function detectBookTitleFromIndex() {
    const h1 = document.querySelector('h1 a[href*="/226/"], h1 a[href*="/"], .item h1 a');
    if (h1) return h1.textContent.trim();
    return document.title.split(/[-—|]/)[0].trim() || '未知';
  }

  async function extractCurrent() {
    const url = location.href;
    try {
      const r = await sendRequest('NTTS_FETCH', { url }, 15000);
      const adapter = E.route(url);
      const ext = E.safeExtract(url, r.html, url);
      if (!ext) return { __err: '适配器未提取到正文' };
      if (ext.error) return { __err: ext.error };
      return { ...ext, adapterName: adapter ? adapter.name : 'unknown' };
    } catch (e) {
      return { __err: e.message };
    }
  }

  function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function safeFilename(s) { return (s || 'untitled').replace(/[\\/:*?"<>|\r\n\t]/g, '_').slice(0, 60); }
  function toast(msg, ms = 2200) {
    const t = document.createElement('div');
    t.textContent = msg;
    Object.assign(t.style, {
      position: 'fixed', top: '24px', left: '50%', transform: 'translateX(-50%)',
      background: 'rgba(0,0,0,.88)', color: '#fff', padding: '10px 18px',
      borderRadius: '8px', zIndex: '2147483647', font: '14px -apple-system',
    });
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  function openBookConfig({ bookTitle, startUrl }) {
    let panel = document.getElementById('ntts-config');
    if (panel) panel.remove();
    panel = document.createElement('div');
    panel.id = 'ntts-config';
    Object.assign(panel.style, {
      position: 'fixed', top: '0', right: '0', bottom: '0',
      width: '500px', maxWidth: '92vw', zIndex: '2147483647',
      background: '#fff', boxShadow: '-4px 0 20px rgba(0,0,0,.18)',
      display: 'flex', flexDirection: 'column',
      font: '14px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
    });
    panel.innerHTML = `
      <div style="padding:14px 16px;border-bottom:1px solid #eee;background:#fafafa;flex-shrink:0">
        <div style="display:flex;align-items:center;gap:8px">
          <div style="font-size:18px">📚</div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:15px">抓整本</div>
            <div style="font-size:12px;color:#888">${escapeHtml(bookTitle)}</div>
          </div>
          <button id="ntts-cfg-close" style="border:none;background:transparent;font-size:22px;cursor:pointer;color:#888;line-height:1;padding:0 4px">×</button>
        </div>
      </div>
      <div style="padding:14px 16px;flex:1;overflow:auto;line-height:1.7">
        <div style="margin-bottom:12px">
          <div style="font-weight:600;margin-bottom:6px">📖 抓取模式</div>
          <label style="display:block;padding:6px 0;cursor:pointer"><input type="radio" name="ntts-mode" value="range" checked> <b>📍 指定范围</b>(从某章到某章,推荐用于补缺)</label>
          <label style="display:block;padding:6px 0;cursor:pointer"><input type="radio" name="ntts-mode" value="full"> 📦 全量(从 1 抓到末尾)</label>
          <label style="display:block;padding:6px 0;cursor:pointer"><input type="radio" name="ntts-mode" value="chase"> 🔄 追更(按 URL 去重,适合连载站加新章)</label>
        </div>

        <div id="ntts-range-inputs" style="margin-bottom:12px;padding:10px;background:#f5f5f5;border-radius:6px">
          <div style="font-weight:600;margin-bottom:6px;font-size:13px">📍 范围设置(仅"指定范围"模式生效)</div>
          <div style="display:flex;gap:8px;align-items:center">
            <label style="font-size:12px">起始:</label>
            <input type="number" id="ntts-start-index" min="1" placeholder="1" style="flex:1;padding:6px;border:1px solid #ccc;border-radius:4px;font-size:13px">
            <label style="font-size:12px">末尾:</label>
            <input type="number" id="ntts-end-index" min="1" placeholder="末尾(留空=最后一章)" style="flex:1;padding:6px;border:1px solid #ccc;border-radius:4px;font-size:13px">
          </div>
          <div id="ntts-remote-total" style="font-size:11px;color:#666;margin-top:6px;line-height:1.5">加载远端目录中...</div>
          <div style="font-size:11px;color:#666;margin-top:4px">例:补 996-1207 章 → 起始 996,末尾 1207</div>
        </div>

        <div style="font-size:12px;color:#666;background:#fff8e1;padding:10px;border-radius:6px">
          💡 <b>推荐</b>:本地有 995 章想补 212 章 → 选"指定范围",起始 996,末尾 1207。7 分钟搞定,不用纠结 storage 对不对。
        </div>
      </div>
      <div style="padding:12px 16px;border-top:1px solid #eee;background:#fafafa;display:flex;gap:8px;flex-shrink:0">
        <button id="ntts-cfg-cancel" style="flex:1;padding:10px;border:1px solid #ddd;background:#fff;border-radius:6px;cursor:pointer">取消</button>
        <button id="ntts-cfg-go" style="flex:2;padding:10px;border:1px solid #1f6feb;background:#1f6feb;color:#fff;border-radius:6px;cursor:pointer;font-weight:600">🚀 开始抓取</button>
      </div>
    `;
    document.body.appendChild(panel);
    panel.querySelector('#ntts-cfg-close').onclick = () => panel.remove();
    panel.querySelector('#ntts-cfg-cancel').onclick = () => panel.remove();
    panel.querySelector('#ntts-cfg-go').onclick = () => {
      const mode = panel.querySelector('input[name="ntts-mode"]:checked').value;
      const params = { startUrl, mode };
      if (mode === 'range') {
        const s = parseInt(panel.querySelector('#ntts-start-index').value, 10);
        const e = parseInt(panel.querySelector('#ntts-end-index').value, 10);
        if (!s || s < 1) {
          toast('❌ 起始章节号必须 >= 1');
          return;
        }
        params.startIndex = s;
        if (e && e >= s) params.endIndex = e;
        // 不传 endIndex = 抓到最后一章
      }
      panel.remove();
      openTaskMonitor();
      startGrab(params);
    };

    // 异步加载:显示远端目录总数(给用户参考填范围)
    loadRemoteTotal(startUrl, panel);

    // 模式切换时,显隐 range 输入框
    panel.querySelectorAll('input[name="ntts-mode"]').forEach(radio => {
      radio.onchange = () => {
        const isRange = panel.querySelector('input[name="ntts-mode"]:checked').value === 'range';
        panel.querySelector('#ntts-range-inputs').style.opacity = isRange ? '1' : '0.4';
        panel.querySelector('#ntts-range-inputs').style.pointerEvents = isRange ? 'auto' : 'none';
      };
    });
  }

  // 简化为:只显示远端目录总章节数(填范围时参考)
  async function loadRemoteTotal(startUrl, panel) {
    const reportEl = panel.querySelector('#ntts-remote-total');
    if (!reportEl) return;
    reportEl.textContent = '正在拉取远端目录...';
    try {
      // 用 extract 拿 bookIndexUrl
      const html0 = await fetchWithRetry(startUrl);
      const ext0 = E.safeExtract(startUrl, html0, startUrl);
      const listUrl = ext0?.bookIndexUrl || startUrl;
      const html = listUrl === startUrl ? html0 : (await fetchWithRetry(listUrl)).html;
      const adapter = E.route(listUrl);
      const list = adapter.listChapters(html, listUrl) || [];
      const pages = bookIndexPagesWithAdapter(html, listUrl);
      let total = list.length;
      for (let i = 1; i < pages.length; i++) {
        try {
          const h = (await fetchWithRetry(pages[i])).html;
          total += (adapter.listChapters(h, pages[i]) || []).length;
        } catch {}
      }
      reportEl.innerHTML = `📚 远端目录共 <b>${total}</b> 章(填范围时参考这个数字填末尾)`;
    } catch (e) {
      reportEl.textContent = `❌ 拉取远端目录失败:${e.message}`;
    }
  }

  // ============================================================
  // Diff 报告(本地 storage 已知 vs 远端目录)
  // ============================================================
  async function loadDiffReport(startUrl, bookTitle, panel) {
    const reportEl = panel.querySelector('#ntts-diff-report');
    if (!reportEl) return;
    reportEl.innerHTML = '<div>正在查询 storage 已知章节...</div><div>正在拉取远端目录...</div>';

    // 1. 本地
    let localChapters = [];
    try {
      const stored = await getStoredBookByTitle(bookTitle, startUrl);
      localChapters = stored?.chapters || [];
    } catch (e) {
      reportEl.innerHTML = `<div>本地查询失败:${escapeHtml(e.message)}</div>`;
    }

    // 2. 远端(拉目录)
    // 关键:如果 startUrl 是文章页(没 #list),先用 extract 拿 bookIndexUrl,再去目录页拉
    let bookIndexUrl = startUrl;
    try {
      const html0 = await fetchWithRetry(startUrl);
      const ext0 = E.safeExtract(startUrl, html0, startUrl);
      if (ext0?.bookIndexUrl) bookIndexUrl = ext0.bookIndexUrl;
    } catch (e) { /* fall through,继续用 startUrl */ }

    let remoteChapters = [];
    let remoteErr = null;
    try {
      const adapter = E.route(bookIndexUrl);
      const listChapters = (html, base) => {
        try { return adapter.listChapters(html, base) || []; } catch { return []; }
      };
      const html = await fetchWithRetry(bookIndexUrl);
      const first = listChapters(html, bookIndexUrl);
      // 还要拉分页
      const pages = bookIndexPagesWithAdapter(html, bookIndexUrl);
      const allPages = [bookIndexUrl, ...pages.filter(p => p !== bookIndexUrl)];
      const fetched = new Map();
      first.forEach(c => fetched.set(c.url, c));
      for (let i = 1; i < allPages.length; i++) {
        try {
          const h = (await fetchWithRetry(allPages[i])).html;
          const l = listChapters(h, allPages[i]);
          l.forEach(c => fetched.set(c.url, c));
        } catch {}
      }
      remoteChapters = normalizeChapterIndexes([...fetched.values()]);
    } catch (e) {
      remoteErr = e.message;
    }

    // 3. 计算 diff(按章节号 index,不是 URL)
    const localIndexes = new Set(localChapters.map(c => c.index).filter(Boolean));
    const localByIdx = new Map();
    localChapters.forEach(c => { if (c.index) localByIdx.set(c.index, c); });

    const newChapters = remoteChapters.filter(c => !localIndexes.has(c.index));
    const keptChapters = remoteChapters.filter(c => localIndexes.has(c.index));
    const missingInRemote = localChapters.filter(c => c.index && !remoteChapters.some(rc => rc.index === c.index));

    // 渲染
    const rows = [];
    rows.push(`<div><b>本地已知</b>:${localChapters.length} 章</div>`);
    rows.push(`<div><b>远端目录</b>:${remoteChapters.length} 章${remoteErr ? ` <span style="color:#dc2626">(拉取失败:${escapeHtml(remoteErr)})</span>` : ''}</div>`);
    rows.push(`<hr style="border:none;border-top:1px dashed #ddd;margin:6px 0">`);
    rows.push(`<div>📥 <b style="color:#1f6feb">预计新增</b>:<b style="color:#1f6feb">${newChapters.length}</b> 章</div>`);
    rows.push(`<div>✅ 已存在(跳过):${keptChapters.length} 章</div>`);
    if (missingInRemote.length) rows.push(`<div>⚠️ 远端已删:${missingInRemote.length} 章(本地有但远端列表没)</div>`);
    rows.push(`<div style="margin-top:6px;padding-top:6px;border-top:1px dashed #ddd;color:#888">预估耗时:${Math.ceil(newChapters.length * 2 / 60)} 分钟(2s 限速/章)</div>`);
    reportEl.innerHTML = rows.join('');
  }

  // 把 chapter 的 index 统一从标题"第 N 章"提取(避免不同站 listChapters 数组位置跟真实章节号不一致)
  function detectChapters(text) {
    const seps = [];
    // 风格 A:长等号包围的章节标题(我们 downloadFull 时用的格式)
    const reA = /={5,}\s*(?:第\s*(\d+)\s*章[^\n=]*)\s*={5,}/g;
    let m;
    while ((m = reA.exec(text)) !== null) {
      seps.push({ index: m.index, length: m[0].length, title: m[0].replace(/=/g, '').trim() });
    }
    // 风格 B:行首"第 N 章"
    if (seps.length === 0) {
      const reB = /^第\s*(\d+)\s*章[^\n]*$/gm;
      while ((m = reB.exec(text)) !== null) {
        seps.push({ index: m.index, length: m[0].length, title: m[0].trim() });
      }
    }
    return seps;
  }

  function normalizeChapterIndexes(chapters) {
    // 关键:总从 title 提"第 N 章" — 覆盖 adapter 给的 i+1(数组位置不一定等于真实章节号)
    // sudugu 目录里有请假条、卷末小结等占位 li,占位没"第 N 章",保留原 index(0 表示未知)
    return chapters.map(c => {
      const m = (c.title || '').match(/第\s*(\d+)\s*章/);
      if (m) return { ...c, index: parseInt(m[1], 10) };
      return c;  // 占位章节:不参与按 index 过滤(用户也不会输这些)
    });
  }

  // 按 bookTitle 反查 storage(适配从目录页打开配置面板的场景,bookKey 还没确定)
  async function getStoredBookByTitle(bookTitle, startUrl) {
    if (!_booksCache) {
      try {
        const r = await sendRequest('NTTS_LIST_BOOKS', {}, 5000);
        _booksCache = r.books || {};
      } catch { _booksCache = {}; }
    }
    // 优先匹配同书名
    for (const k in _booksCache) {
      if (_booksCache[k]?.title === bookTitle) return _booksCache[k];
    }
    // fallback:匹配 URL 主机
    try {
      const host = new URL(startUrl).host;
      for (const k in _booksCache) {
        if (k.includes(host)) return _booksCache[k];
      }
    } catch {}
    return null;
  }

  // ============================================================
  // 导入本地 txt 作为基准
  // ============================================================
  async function importTxtAsBase(text, bookTitle, startUrl) {
    // 1. 解析章节(用现有逻辑)
    const chapters = detectChapters(text);
    if (chapters.length === 0) {
      throw new Error('未识别到任何章节分隔符,期望格式:`==== 第 N 章 ====`');
    }
    // 2. 切分正文(取每段 chapter 的 text 部分)
    let marked = text;
    chapters.forEach((c, i) => {
      const marker = `\u0001CHAP${i}\u0001`;
      marked = marked.slice(0, c.index) + marker + marked.slice(c.index + c.length);
    });
    const parts = marked.split(/(?<=[。.！!？?\n;；])\s*/);
    const segments = [];
    let curChapIdx = -1;
    for (const p of parts) {
      const t = p.trim();
      if (!t) continue;
      for (let i = 0; i < chapters.length; i++) {
        if (t === `\u0001CHAP${i}\u0001`) { curChapIdx = i; break; }
      }
      if (curChapIdx >= 0 && !t.startsWith('\u0001') && t.length < 5000) {
        segments.push({ chapIdx: curChapIdx, text: t });
      }
    }
    // 合并每个章节的段
    const chapterTexts = chapters.map((c, i) => {
      const segs = segments.filter(s => s.chapIdx === i).map(s => s.text);
      return segs.join('\n\n');
    });

    // 3. 写到 storage
    const bookKey = await getOrCreateBookKey(bookTitle, startUrl);
    if (!_booksCache) _booksCache = {};
    _booksCache[bookKey] = _booksCache[bookKey] || { title: bookTitle, chapters: [] };

    let imported = 0, skipped = 0;
    for (let i = 0; i < chapters.length; i++) {
      const c = chapters[i];
      const content = chapterTexts[i];
      const m = c.title.match(/第\s*(\d+)\s*章/);
      const index = m ? parseInt(m[1], 10) : (i + 1);
      const url = `imported://${bookKey}#${index}`;  // 占位 URL
      const already = _booksCache[bookKey].chapters.some(x => x.url === url);
      if (already) { skipped++; continue; }
      _booksCache[bookKey].chapters.push({
        url, title: c.title.replace(/^第\s*\d+\s*章\s*/, `第 ${index} 章 `),
        index, pages: 1, content, text: content,
        fingerprint: fingerprint(content),
        source: 'local-import',
        fetchedAt: Date.now(),
      });
      imported++;
    }
    _booksCache[bookKey].lastUpdate = Date.now();
    try { port?.postMessage({ type: 'NTTS_SAVE_TASK', task: { _books: _booksCache } }); } catch {}
    return { imported, skipped, total: _booksCache[bookKey].chapters.length };
  }

  async function getOrCreateBookKey(bookTitle, startUrl) {
    // 已有同书名 → 用其 bookKey
    if (_booksCache) {
      for (const k in _booksCache) {
        if (_booksCache[k]?.title === bookTitle) return k;
      }
    }
    // fallback:用 bookIndexUrl
    try {
      const html = await fetchWithRetry(startUrl);
      const adapter = E.route(startUrl);
      const ext = E.safeExtract(startUrl, html, startUrl);
      if (ext?.bookIndexUrl) return ext.bookIndexUrl;
    } catch {}
    // 实在没有,生成一个
    return `local-import://${bookTitle}`;
  }

  // 章节面板(单章模式)
  function openPanel(data) {
    let panel = document.getElementById('ntts-panel');
    if (panel) panel.remove();
    panel = document.createElement('div');
    panel.id = 'ntts-panel';
    Object.assign(panel.style, {
      position: 'fixed', top: '0', right: '0', bottom: '0',
      width: '500px', maxWidth: '92vw', zIndex: '2147483647',
      background: '#fff', boxShadow: '-4px 0 20px rgba(0,0,0,.18)',
      display: 'flex', flexDirection: 'column',
      font: '14px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
    });
    const bookTitle = data.bookTitle || data.siteName || '未知';
    const chapTitle = data.chapterTitle || data.title || '本章';
    panel.innerHTML = `
      <div style="padding:14px 16px;border-bottom:1px solid #eee;background:#fafafa;flex-shrink:0">
        <div style="display:flex;align-items:center;gap:8px">
          <div style="font-size:18px">📖</div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(bookTitle)}</div>
            <div style="font-size:12px;color:#888">${escapeHtml(chapTitle)}</div>
          </div>
          <button id="ntts-close" style="border:none;background:transparent;font-size:22px;cursor:pointer;color:#888;line-height:1;padding:0 4px">×</button>
        </div>
      </div>
      <div style="padding:10px 14px;border-bottom:1px solid #eee;display:flex;gap:6px;flex-wrap:wrap;flex-shrink:0">
        <button data-act="copy"  style="flex:1;min-width:80px;padding:8px;border:1px solid #1f6feb;background:#1f6feb;color:#fff;border-radius:6px;cursor:pointer;font:inherit">📋 复制</button>
        <button data-act="copyb" style="flex:1;min-width:80px;padding:8px;border:1px solid #ddd;background:#fff;border-radius:6px;cursor:pointer;font:inherit">📝 纯文本</button>
        <button data-act="dl"    style="flex:1;min-width:80px;padding:8px;border:1px solid #ddd;background:#fff;border-radius:6px;cursor:pointer;font:inherit">💾 下载</button>
        <button data-act="book-full" style="flex:1;min-width:90px;padding:8px;border:1px solid #f59e0b;background:#fffbeb;color:#b45309;border-radius:6px;cursor:pointer;font:inherit">📚 抓整本</button>
      </div>
      <div id="ntts-text" style="flex:1;overflow:auto;padding:14px 18px;line-height:1.85;font-size:15px;white-space:pre-wrap;background:#fdfdfd">${escapeHtml(data.text)}</div>
      <div style="padding:8px 14px;border-top:1px solid #eee;background:#fafafa;font-size:11px;color:#888;flex-shrink:0">
        适配器:<b>${escapeHtml(data.adapterName || 'default')}</b>
      </div>
    `;
    document.body.appendChild(panel);
    panel.querySelector('#ntts-close').onclick = () => panel.remove();
    panel.querySelectorAll('button[data-act]').forEach(btn => {
      btn.onclick = () => handleChapterAction(btn.dataset.act, data);
    });
  }

  async function handleChapterAction(act, data) {
    const bookTitle = data.bookTitle || data.siteName || '未命名';
    const chapTitle = data.chapterTitle || data.title || '本章';
    if (act === 'copy' || act === 'copyb') {
      const text = act === 'copy' ? `《${bookTitle}》\n${chapTitle}\n来源:${data.url}\n\n${data.text}` : data.text;
      try { await navigator.clipboard.writeText(text); toast('✅ 已复制,粘贴到 TTS 听书器听书'); }
      catch {
        const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); toast('✅ 已复制'); } catch { toast('❌ 复制失败'); }
        ta.remove();
      }
    }
    if (act === 'dl') {
      const fname = safeFilename(`${bookTitle}_${chapTitle}.txt`);
      const text = `《${bookTitle}》\n${chapTitle}\n来源:${data.url}\n抓取时间:${new Date().toLocaleString()}\n${'='.repeat(50)}\n\n${data.text}`;
      try {
        downloadViaAnchor(text, fname);
        toast('💾 已下载');
      } catch (e) { toast(`❌ ${e.message}`); }
    }
    if (act === 'book-full') {
      // 先关掉单章面板,弹配置面板(让用户选模式 / 看 diff / 导入本地 txt)
      const panel = document.getElementById('ntts-panel');
      if (panel) panel.remove();
      openBookConfig({ bookTitle: data.bookTitle || data.siteName || '未命名', startUrl: location.href });
    }
  }

  // 任务监控面板
  let taskMonitorPanel = null;
  function openTaskMonitor() {
    if (taskMonitorPanel && document.body.contains(taskMonitorPanel)) {
      taskMonitorPanel.style.display = 'flex';
      return;
    }
    taskMonitorPanel = document.createElement('div');
    taskMonitorPanel.id = 'ntts-monitor';
    Object.assign(taskMonitorPanel.style, {
      position: 'fixed', top: '0', right: '0', bottom: '0',
      width: '500px', maxWidth: '92vw', zIndex: '2147483646',
      background: '#fff', boxShadow: '-4px 0 20px rgba(0,0,0,.18)',
      display: 'flex', flexDirection: 'column',
      font: '13px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
    });
    taskMonitorPanel.innerHTML = `
      <div style="padding:14px 16px;border-bottom:1px solid #eee;background:#fafafa;flex-shrink:0">
        <div style="display:flex;align-items:center;gap:8px">
          <div style="font-size:18px">📡</div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:15px" id="mon-title">抓取任务</div>
            <div style="font-size:12px;color:#888" id="mon-subtitle">—</div>
          </div>
          <button id="mon-close" style="border:none;background:transparent;font-size:22px;cursor:pointer;color:#888;line-height:1;padding:0 4px">×</button>
        </div>
      </div>
      <div style="padding:12px 16px;border-bottom:1px solid #eee;flex-shrink:0">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
          <span id="mon-status" style="display:inline-block;padding:3px 8px;background:#e3f2fd;color:#1f6feb;border-radius:4px;font-size:11px">空闲</span>
          <span style="flex:1"></span>
          <button data-mon="pause"  style="padding:5px 10px;font-size:12px">⏸</button>
          <button data-mon="resume" style="padding:5px 10px;font-size:12px;display:none">▶</button>
          <button data-mon="resume-task" title="从上次中断处继续抓取剩余章节" style="padding:5px 10px;font-size:12px;background:#16a34a;color:#fff;border-color:#16a34a;display:none">▶ 继续抓取</button>
          <button data-mon="stop"   style="padding:5px 10px;font-size:12px">⏹</button>
          <button data-mon="copy"   title="复制全本到剪贴板(独立于下载)" style="padding:5px 10px;font-size:12px;background:#f0fdf4;color:#15803d;border-color:#86efac">📋</button>
          <button data-mon="dl"     style="padding:5px 10px;font-size:12px;background:#1f6feb;color:#fff;border-color:#1f6feb">💾</button>
        </div>
        <div style="height:6px;background:#eee;border-radius:3px;overflow:hidden"><div id="mon-fill" style="height:100%;background:linear-gradient(90deg,#1f6feb,#06b6d4);width:0;transition:width .3s"></div></div>
        <div style="font-size:12px;color:#666;margin-top:6px" id="mon-progress">0/0 (0%)</div>
        <div style="font-size:12px;color:#444;margin-top:4px" id="mon-current">等待任务</div>
      </div>
      <div id="mon-log" style="flex:1;overflow:auto;padding:10px 16px;background:#fdfdfd;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.6">
        <div style="color:#999;text-align:center;padding:20px">📋 实时日志</div>
      </div>
    `;
    document.body.appendChild(taskMonitorPanel);
    taskMonitorPanel.querySelector('#mon-close').onclick = () => { taskMonitorPanel.style.display = 'none'; };
    taskMonitorPanel.querySelectorAll('button[data-mon]').forEach(btn => {
      btn.onclick = () => handleMonitorAction(btn.dataset.mon);
    });
  }

  function appendLog(level, msg) {
    const log = document.getElementById('mon-log');
    if (!log) return;
    const placeholder = log.querySelector('div[style*="text-align:center"]');
    if (placeholder) placeholder.remove();
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const icon = ({ info: 'ℹ️', success: '✅', warn: '⚠️', error: '❌' })[level] || '·';
    const line = document.createElement('div');
    line.style.cssText = `padding:2px 0;color:${({info:'#374151',success:'#15803d',warn:'#b45309',error:'#dc2626'})[level] || '#374151'};border-bottom:1px dashed #f0f0f0`;
    line.textContent = `[${time}] ${icon} ${msg}`;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
    while (log.children.length > 500) log.removeChild(log.firstChild);
  }

  async function handleMonitorAction(act) {
    if (act === 'pause')  { state.paused = true;  appendLog('info', '⏸ 已暂停'); broadcastProgress(snapshotTask(state.task)); saveTaskPersist(); }
    if (act === 'resume') { state.paused = false; appendLog('info', '▶ 已继续'); broadcastProgress(snapshotTask(state.task)); saveTaskPersist(); }
    if (act === 'stop')   { state.stopped = true; appendLog('warn', '⏹ 已请求停止,当前章节跑完就停'); broadcastProgress(snapshotTask(state.task)); saveTaskPersist(); }
    if (act === 'resume-task') {
      // 从 storage 旧 task 续抓:跳过已抓的章节
      if (!state.task || !state.task.startUrl) { appendLog('error', '没有可续抓的 task'); return; }
      if (state.runPromise) { appendLog('warn', '已有任务在跑,先停止当前任务'); return; }
      const resumeFrom = { fetched: state.task.fetched || [], failures: state.task.failures || [] };
      const startUrl = state.task.startUrl;
      appendLog('success', `🔁 启动续抓:已抓 ${resumeFrom.fetched.length} 章,失败 ${resumeFrom.failures.length}`);
      state.runPromise = startGrab({ startUrl, mode: 'resume', resumeFrom }).then(r => {
        if (r && r.ok === false) appendLog('error', `续抓启动失败:${r.error || '未知'}`);
      }).catch(e => appendLog('error', `续抓错误:${e.message}`)).finally(() => {
        state.runPromise = null;
      });
      return;
    }
    if (act === 'copy')   {
      // 复制全本到剪贴板(独立于 chrome.downloads)
      if (!state.task || !state.task.fetched.length) { appendLog('error', '没有可复制的章节'); return; }
      try {
        const text = buildFullText();
        if (!text) { appendLog('error', '构建文本失败'); return; }
        await navigator.clipboard.writeText(text);
        const kb = (text.length / 1024).toFixed(1);
        appendLog('success', `📋 已复制 ${state.task.fetched.length} 章(${kb} KB)到剪贴板`);
        // toast 也提示一下
        toast(`📋 已复制 ${kb} KB,粘到文本编辑器保存`);
      } catch (e) {
        // 剪贴板 API 失败时用 textarea fallback
        try {
          const text = buildFullText();
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.cssText = 'position:fixed;top:-9999px;left:0;width:1px;height:1px';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
          appendLog('success', `📋 已复制(降级方案)到剪贴板`);
        } catch (e2) {
          appendLog('error', `复制失败:${e2.message}`);
        }
      }
    }
    if (act === 'dl') {
      appendLog('info', '💾 开始下载…');
      if (!state.task || !state.task.fetched.length) { appendLog('error', '没有可下载的章节'); return; }
      // 简洁分章:不加分隔块(===...===),让正文的"第 N 章  标题"首行作自然分章
      // 只有当正文首行不像"第 N 章"开头时,才用 title 兜底补一行
      const cleanTitle = (t) => (t || '').replace(/^第\s*\d+\s*章[　\s]*/, '').trim();
      const allText = [
        `《${state.task.bookTitle}》  整本抓取\n`,
        `共 ${state.task.fetched.length} 章(本次抓取)\n`,
        `抓取时间:${new Date().toLocaleString()}\n`,
        ...state.task.fetched.map((ch) => {
          const firstLine = (ch.text || '').split('\n', 1)[0] || '';
          if (/^第\s*\d+\s*章/.test(firstLine)) return ch.text;  // 正文自带"第 N 章",不加重复
          const idx = ch.chapterIndex || ch.index || 0;
          return `第 ${idx} 章  ${cleanTitle(ch.title)}\n\n${ch.text}`;
        }),
      ].join('\n\n');
      const fname = sanitizeFilename(`${state.task.bookTitle}_全本_${state.task.fetched.length}章_${formatDate()}.txt`);
      try {
        downloadViaAnchor(allText, fname);
        appendLog('success', `💾 已下载:${fname}`);
      } catch (e) {
        appendLog('error', `下载失败:${e.message}`);
      }
    }
  }

  function formatDate() {
    const d = new Date();
    return `${d.getFullYear()}${pad(d.getMonth() + 1, 2)}${pad(d.getDate(), 2)}_${pad(d.getHours(), 2)}${pad(d.getMinutes(), 2)}`;
  }

  function renderTaskMonitor(t) {
    if (!t) {
      const statusEl = document.getElementById('mon-status');
      if (!statusEl) return;
      statusEl.textContent = '空闲';
      document.getElementById('mon-progress').textContent = '无任务';
      document.getElementById('mon-current').textContent = '在某小说页点 📖 抓取 按钮开始';
      return;
    }
    document.getElementById('mon-title').textContent = t.bookTitle || '抓取任务';
    const statusEl = document.getElementById('mon-status');
    statusEl.textContent = ({ running: '抓取中', paused: '已暂停', completed: '已完成', stopped: '已停止', error: '出错了' })[t.status] || t.status;
    statusEl.style.background = ({ running: '#dbeafe', paused: '#fef3c7', completed: '#dcfce7', stopped: '#f3f4f6', error: '#fee2e2' })[t.status] || '#dbeafe';
    statusEl.style.color = ({ running: '#1e40af', paused: '#b45309', completed: '#15803d', stopped: '#374151', error: '#dc2626' })[t.status] || '#1e40af';

    const fetchedCount = t.fetchedCount ?? t.fetched?.length ?? 0;
    const failureCount = t.failureCount ?? t.failures?.length ?? 0;
    const total = t.totalChapters || t.toFetchCount || 0;
    const pct = total > 0 ? Math.round((fetchedCount / total) * 100) : 0;
    document.getElementById('mon-fill').style.width = pct + '%';
    document.getElementById('mon-progress').textContent = `📊 ${fetchedCount}/${total} 章 (${pct}%)${failureCount ? ` · ❌ ${failureCount}` : ''}`;
    const curTitle = t.currentChapter?.title || '等待';
    const pageInfo = t.currentPageCount ? ` · 第 ${t.currentPageCount} 页` : '';
    document.getElementById('mon-current').textContent = `📖 当前:第 ${t.currentIdx + 1} 章 — ${curTitle}${pageInfo}`;
    document.getElementById('mon-subtitle').textContent = `模式:${t.mode === 'chase' ? '追更' : '全量'} · 总章节:${t.totalChapters}`;

    const pauseBtn = taskMonitorPanel.querySelector('[data-mon="pause"]');
    const resumeBtn = taskMonitorPanel.querySelector('[data-mon="resume"]');
    const resumeTaskBtn = taskMonitorPanel.querySelector('[data-mon="resume-task"]');
    const dlBtn = taskMonitorPanel.querySelector('[data-mon="dl"]');
    pauseBtn.style.display = (t.status === 'running') ? '' : 'none';
    resumeBtn.style.display = (t.status === 'paused') ? '' : 'none';
    // ▶ 继续抓取:仅在有 task + 有未抓章节时显示(running 时不显示,避免与 pause 冲突)
    const hasUnfetched = (t.totalChapters || 0) > (t.fetchedCount || 0) + (t.failureCount || 0);
    resumeTaskBtn.style.display = (t.status === 'paused' && hasUnfetched) ? '' : 'none';
    resumeTaskBtn.title = `跳过已抓 ${t.fetchedCount || 0} 章,继续抓剩余`;
    // dl 按钮:paused 状态也能导出(让用户能保存已抓内容)
    dlBtn.disabled = t.fetchedCount === 0;
    dlBtn.style.opacity = dlBtn.disabled ? '0.4' : '1';
  }

  // ============================================================
  // 初始化
  // ============================================================
  connectPort();
  injectFab();

  // 拉旧 task
  (async () => {
    try {
      const r = await sendRequest('NTTS_GET_TASK', {}, 5000);
      if (r && r.task) {
        // 检查是不是同一个 bookKey 的在跑任务
        if (r.task.status === 'running' || r.task.status === 'paused') {
          // 跑循环实际已死(本页是新加载的),统一显示为 paused,让用户能导出 + 续抓
          if (r.task.status === 'running') r.task.status = 'paused';
          state.task = r.task;
          state.paused = true;
          state.stopped = false;
          openTaskMonitor();
          renderTaskMonitor(r.task);
          const fetched = r.task.fetched?.length || 0;
          const total = r.task.totalChapters || r.task.chapters?.length || 0;
          appendLog('warn', `⚠️ 检测到上次未完成任务:${r.task.bookTitle}(已抓 ${fetched}/${total} 章)`);
          appendLog('success', `💡 面板操作:`);
          appendLog('info', `   · 点 "▶ 继续抓取" → 跳过已抓,继续剩余章节`);
          appendLog('info', `   · 点 "💾" 按钮 → 把已抓的 ${fetched} 章导出为 TXT`);
          appendLog('info', `   · 点 "📋" 按钮 → 复制到剪贴板`);
        }
      }
    } catch (e) { console.warn('[ntts-content] 拉旧任务失败:', e); }
  })();

  chrome.runtime.onMessage.addListener(msg => {
    if (msg && msg.type === 'NTTS_RE_GRAB') document.getElementById('ntts-fab')?.click();
  });

  console.log('[ntts-content] 已注入 v0.4');
})();
