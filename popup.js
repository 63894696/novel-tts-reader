// popup.js — 听书 + 抓取任务监控
// v0.3.1:加 tab 切换、抓取任务实时日志、Port 长连接

const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);

// ============================================================
// Tab 切换
// ============================================================
$$('.tab').forEach(t => {
  t.onclick = () => {
    $$('.tab').forEach(x => x.classList.remove('active'));
    $$('.panel').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    document.getElementById('panel-' + t.dataset.tab).classList.add('active');
  };
});

// ============================================================
// 听书部分(原 v0.3 逻辑)
// ============================================================
const state = {
  rawText: '',
  sentences: [],
  chapters: [],
  currentIdx: 0,
  currentChapIdx: 0,
  playing: false,
  paused: false,
  voices: [],
};

// --- 声音 ---
function loadVoices() {
  state.voices = speechSynthesis.getVoices();
  const select = $('#voice');
  const prev = select.value;
  select.innerHTML = '';
  const zh = state.voices.filter(v => v.lang.startsWith('zh'));
  const en = state.voices.filter(v => v.lang.startsWith('en'));
  const other = state.voices.filter(v => !v.lang.startsWith('zh') && !v.lang.startsWith('en'));
  const make = (label, list) => {
    if (!list.length) return;
    const g = document.createElement('optgroup'); g.label = label; select.appendChild(g);
    list.forEach(v => {
      const o = document.createElement('option');
      o.value = v.name;
      o.textContent = `${v.name} (${v.lang})${v.default ? ' ⭐' : ''}`;
      select.appendChild(o);
    });
  };
  make('中文', zh); make('English', en); make('其他', other);
  chrome.storage.local.get(['voice'], r => {
    if (r.voice && state.voices.find(v => v.name === r.voice)) select.value = r.voice;
    else if (zh.length) select.value = zh[0].name;
    else if (state.voices.length) select.value = state.voices[0].name;
  });
}
loadVoices();
speechSynthesis.onvoiceschanged = loadVoices;
$('#btn-refresh-voices').onclick = loadVoices;
$('#voice').onchange = e => chrome.storage.local.set({ voice: e.target.value });

// --- 章节识别 ---
function detectChapters(text) {
  const seps = [];
  const reA = /={5,}\s*(?:第\s*(\d+)\s*章[^\n=]*)\s*={5,}/g;
  let m;
  while ((m = reA.exec(text)) !== null) {
    seps.push({ index: m.index, length: m[0].length, title: m[0].replace(/=/g, '').trim() });
  }
  if (seps.length === 0) {
    const reB = /^第\s*(\d+)\s*章[^\n]*$/gm;
    while ((m = reB.exec(text)) !== null) {
      seps.push({ index: m.index, length: m[0].length, title: m[0].trim() });
    }
  }
  return seps;
}

function splitSentences(text, chapters) {
  if (!text) return [];
  let marked = text;
  chapters.forEach((c, i) => {
    const marker = `\u0001CHAP${i}\u0001`;
    marked = marked.slice(0, c.index) + marker + marked.slice(c.index + c.length);
  });
  const parts = marked.replace(/\r/g, '').split(/(?<=[。.！!？?\n;；])\s*/);
  const sentences = [];
  for (const p of parts) {
    const t = p.trim();
    if (!t) continue;
    let handled = false;
    for (let i = 0; i < chapters.length; i++) {
      if (t === `\u0001CHAP${i}\u0001`) {
        sentences.push({ type: 'chapter', title: chapters[i].title, chapIdx: i });
        handled = true; break;
      }
    }
    if (handled) continue;
    if (!t.startsWith('\u0001') && t.length < 300) sentences.push({ type: 'text', text: t });
  }
  return sentences;
}

function refreshFromTextarea() {
  state.rawText = $('#text').value;
  state.chapters = detectChapters(state.rawText);
  state.sentences = splitSentences(state.rawText, state.chapters);
  state.currentIdx = 0;
  state.currentChapIdx = 0;
  const textCount = state.sentences.filter(s => s.type === 'text').length;
  $('#char-count').textContent = state.rawText.length;
  $('#sent-count').textContent = textCount;
  $('#chap-count').textContent = state.chapters.length ? `· ${state.chapters.length} 章` : '';
  if (state.chapters.length > 0) {
    const sel = $('#chap-select');
    sel.innerHTML = state.chapters.map((c, i) =>
      `<option value="${i}">第 ${i + 1} 章 — ${c.title.replace(/^第\s*\d+\s*章\s*/, '').slice(0, 30)}</option>`
    ).join('');
    $('#chap-jump').style.display = 'flex';
  } else {
    $('#chap-jump').style.display = 'none';
  }
  updateProgress();
  updateControls();
}

$('#text').addEventListener('input', debounce(refreshFromTextarea, 100));
$('#btn-clear').onclick = () => { $('#text').value = ''; refreshFromTextarea(); };
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

$('#btn-file').onclick = () => $('#file-input').click();
$('#file-input').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  await loadFile(file);
  e.target.value = '';
};
async function loadFile(file) {
  try {
    const text = await file.text();
    $('#text').value = text;
    refreshFromTextarea();
    toast(`✅ ${file.name} 加载完成${state.chapters.length ? `,${state.chapters.length} 章` : ''}`);
  } catch (e) { toast(`❌ 读取失败:${e.message}`); }
}
const wrap = $('#ta-wrap');
['dragenter', 'dragover'].forEach(ev => wrap.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); wrap.classList.add('dragover'); }));
['dragleave', 'drop'].forEach(ev => wrap.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); wrap.classList.remove('dragover'); }));
wrap.addEventListener('drop', async e => {
  const file = e.dataTransfer?.files?.[0];
  if (file) await loadFile(file);
});

function play() {
  if (state.sentences.length === 0) { refreshFromTextarea(); if (state.sentences.length === 0) { toast('❌ 文本为空'); return; } }
  if (state.paused) { speechSynthesis.resume(); state.paused = false; state.playing = true; setStatus('播放中'); return; }
  if (state.playing) return;
  state.playing = true; state.paused = false; setStatus('播放中'); playLoop();
}
function playLoop() {
  if (!state.playing) return;
  if (state.currentIdx >= state.sentences.length) { state.playing = false; setStatus('已完成'); return; }
  const s = state.sentences[state.currentIdx];
  if (s.type === 'chapter') { state.currentChapIdx = s.chapIdx; state.currentIdx++; updateProgress(); return playLoop(); }
  const text = s.text;
  const u = new SpeechSynthesisUtterance(text);
  const v = state.voices.find(vv => vv.name === $('#voice').value);
  if (v) u.voice = v;
  u.rate = +$('#rate').value; u.pitch = +$('#pitch').value; u.volume = 1.0; u.lang = v?.lang || 'zh-CN';
  u.onstart = () => showCurrent(state.currentIdx);
  u.onend = () => { state.currentIdx++; updateProgress(); if (state.playing && !state.paused) playLoop(); };
  u.onerror = (e) => { if (e.error !== 'canceled') console.warn('[TTS]', e.error); state.playing = false; setStatus('已停止'); };
  speechSynthesis.speak(u);
}
function pause() { if (!state.playing) return; speechSynthesis.pause(); state.paused = true; state.playing = false; setStatus('已暂停'); }
function stop() { speechSynthesis.cancel(); state.playing = false; state.paused = false; state.currentIdx = 0; state.currentChapIdx = 0; updateProgress(); showCurrent(-1); setStatus('已停止'); }
function next() { speechSynthesis.cancel(); if (state.currentIdx < state.sentences.length - 1) state.currentIdx++; updateProgress(); showCurrent(state.currentIdx); if (state.playing || state.paused) playLoop(); }
function prev() { speechSynthesis.cancel(); if (state.currentIdx > 0) state.currentIdx--; updateProgress(); showCurrent(state.currentIdx); if (state.playing || state.paused) playLoop(); }
function prevChapter() {
  if (state.chapters.length === 0) return;
  const idx = state.sentences.findIndex(s => s.type === 'chapter' && s.chapIdx === state.currentChapIdx - 1);
  if (idx < 0) return;
  speechSynthesis.cancel(); state.currentIdx = idx; state.currentChapIdx = idx >= 0 ? state.currentChapIdx - 1 : 0;
  updateProgress(); showCurrent(state.currentIdx); if (state.playing || state.paused) playLoop();
}
function nextChapter() {
  if (state.chapters.length === 0 || state.currentChapIdx >= state.chapters.length - 1) return;
  const nextChap = state.currentChapIdx + 1;
  const idx = state.sentences.findIndex(s => s.type === 'chapter' && s.chapIdx === nextChap);
  if (idx < 0) return;
  speechSynthesis.cancel(); state.currentIdx = idx; state.currentChapIdx = nextChap;
  updateProgress(); showCurrent(state.currentIdx); if (state.playing || state.paused) playLoop();
}
function jumpToChapter(chapIdx) {
  const idx = state.sentences.findIndex(s => s.type === 'chapter' && s.chapIdx === chapIdx);
  if (idx < 0) return;
  speechSynthesis.cancel(); state.currentIdx = idx; state.currentChapIdx = chapIdx;
  updateProgress(); showCurrent(state.currentIdx); if (state.playing || state.paused) playLoop();
}

function showCurrent(i) {
  const el = $('#current');
  if (i < 0 || i >= state.sentences.length) { el.classList.add('empty'); el.textContent = '当前朗读内容会显示在这里'; return; }
  const s = state.sentences[i];
  if (s.type === 'chapter') { el.classList.remove('empty'); el.textContent = `📖 ${s.title}`; }
  else { el.classList.remove('empty'); el.textContent = `${i + 1}. ${s.text}`; }
}
function updateProgress() {
  const total = state.sentences.length; const cur = state.currentIdx;
  const pct = total ? Math.round((cur / total) * 100) : 0;
  $('#progress-fill').style.width = pct + '%';
  const chapInfo = state.chapters.length ? ` · 第 ${state.currentChapIdx + 1}/${state.chapters.length} 章` : '';
  $('#progress-text').textContent = `${cur}/${total} (${pct}%)${chapInfo}`;
}
function updateControls() {
  const has = state.sentences.length > 0;
  $('#btn-play').disabled = !has;
  $('#btn-prev').disabled = !has || state.currentIdx === 0;
  $('#btn-next').disabled = !has || state.currentIdx >= state.sentences.length - 1;
  $('#btn-pause').disabled = !state.playing;
  $('#btn-stop').disabled = !state.playing && !state.paused;
  $('#btn-prev-chap').disabled = !has || state.currentChapIdx === 0;
  $('#btn-next-chap').disabled = !has || state.currentChapIdx >= state.chapters.length - 1;
}
function setStatus(s) { $('#status-badge').textContent = s; updateControls(); }
function toast(msg) { const old = document.title; document.title = msg; setTimeout(() => { document.title = old; }, 1500); }

$('#btn-play').onclick = play;
$('#btn-pause').onclick = pause;
$('#btn-stop').onclick = stop;
$('#btn-prev').onclick = prev;
$('#btn-next').onclick = next;
$('#btn-prev-chap').onclick = prevChapter;
$('#btn-next-chap').onclick = nextChapter;
$('#btn-jump').onclick = () => jumpToChapter(+$('#chap-select').value);

$('#rate').oninput = (e) => {
  $('#rate-val').textContent = (+e.target.value).toFixed(1) + 'x';
  chrome.storage.local.set({ rate: +e.target.value });
  if (state.playing) { speechSynthesis.cancel(); playLoop(); }
};
$('#pitch').oninput = (e) => {
  $('#pitch-val').textContent = (+e.target.value).toFixed(1);
  chrome.storage.local.set({ pitch: +e.target.value });
  if (state.playing) { speechSynthesis.cancel(); playLoop(); }
};
chrome.storage.local.get(['rate', 'pitch'], r => {
  if (r.rate) { $('#rate').value = r.rate; $('#rate-val').textContent = r.rate.toFixed(1) + 'x'; }
  if (r.pitch) { $('#pitch').value = r.pitch; $('#pitch-val').textContent = r.pitch.toFixed(1); }
});
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); state.playing ? pause() : play(); }
  if (e.code === 'ArrowRight') next();
  if (e.code === 'ArrowLeft') prev();
  if (e.code === 'PageDown') nextChapter();
  if (e.code === 'PageUp') prevChapter();
  if (e.key === 'Escape') stop();
});

// ============================================================
// 抓取任务 tab(通过 Port 长连接 background,v0.4 协议)
// ============================================================
let port = null;
const grabLog = [];

// port 发命令 — background 收到后会回一条同类型的消息(带 requestId)
let _reqCounter = 0;
function sendControl(type, payload = {}, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    if (!port) { try { connectPort(); } catch {} }
    if (!port) return reject(new Error('port 未连接'));
    const requestId = `req_${Date.now()}_${++_reqCounter}`;
    const onMsg = (msg) => {
      if (msg.requestId !== requestId) return;
      // 任何带 requestId 且 source='self' 的消息都算成功回执
      if (msg.source === 'self' || msg.type === 'NTTS_CMD_RESULT' || msg.type === 'NTTS_GRAB_BOOK_RESULT') {
        port.onMessage.removeListener(onMsg);
        clearTimeout(timer);
        if (msg.ok === false) reject(new Error(msg.error || '失败'));
        else resolve(msg);
      }
    };
    const timer = setTimeout(() => {
      port.onMessage.removeListener(onMsg);
      reject(new Error(`请求超时(${timeoutMs / 1000}s)`));
    }, timeoutMs);
    port.onMessage.addListener(onMsg);
    try { port.postMessage({ type, requestId, ...payload }); }
    catch (e) {
      port.onMessage.removeListener(onMsg);
      clearTimeout(timer);
      reject(e);
    }
  });
}

function appendLog(level, msg) {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const icon = ({ info: 'ℹ️', success: '✅', warn: '⚠️', error: '❌' })[level] || '·';
  const line = document.createElement('div');
  line.className = `line ${level}`;
  line.textContent = `[${time}] ${icon} ${msg}`;
  const log = $('#grab-log');
  // 第一次插入时去掉占位
  const placeholder = log.querySelector('div[style*="text-align:center"]');
  if (placeholder) placeholder.remove();
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
  // 限行
  while (log.children.length > 500) log.removeChild(log.firstChild);
  // 内存里也存一份
  grabLog.push({ ts: Date.now(), level, msg });
  if (grabLog.length > 500) grabLog.shift();
  // 更新 tab badge(有 error 时高亮)
  const errCount = grabLog.filter(l => l.level === 'error').length;
  if (errCount > 0) {
    $('#tab-badge').textContent = errCount;
    $('#tab-badge').style.background = '#dc2626';
  }
}

function renderGrabTask(t) {
  if (!t) {
    $('#grab-empty').style.display = 'flex';
    $('#grab-active').style.display = 'none';
    $('#tab-badge').classList.add('empty');
    return;
  }
  $('#grab-empty').style.display = 'none';
  $('#grab-active').style.display = 'flex';
  $('#tab-badge').classList.remove('empty');

  $('#grab-title').textContent = t.bookTitle || '抓取任务';
  const statusEl = $('#grab-status-badge');
  statusEl.textContent = ({ running: '抓取中', paused: '已暂停', completed: '已完成', stopped: '已停止', error: '出错了' })[t.status] || t.status;
  statusEl.style.background = ({ running: '#dbeafe', paused: '#fef3c7', completed: '#dcfce7', stopped: '#f3f4f6', error: '#fee2e2' })[t.status] || '#dbeafe';
  statusEl.style.color = ({ running: '#1e40af', paused: '#b45309', completed: '#15803d', stopped: '#374151', error: '#dc2626' })[t.status] || '#1e40af';

  const total = t.toFetchCount || 0;
  const pct = total > 0 ? Math.round((t.fetchedCount / total) * 100) : 0;
  $('#grab-fill').style.width = pct + '%';
  $('#grab-progress-text').textContent = `📊 ${t.fetchedCount}/${total} 章 (${pct}%)${t.failureCount ? ` · ❌ 失败 ${t.failureCount}` : ''}`;

  const curTitle = t.currentChapter?.title || '等待';
  const pageInfo = t.currentPageCount ? ` · 第 ${t.currentPageCount} 页` : '';
  $('#grab-current-text').textContent = `📖 当前:第 ${t.currentIdx + 1} 章 — ${curTitle}${pageInfo}`;
  $('#grab-meta-text').textContent = `模式:${t.mode === 'chase' ? '追更' : '全量'} · 总章节:${t.totalChapters}`;

  // 按钮
  const pauseBtn = $('[data-grab="pause"]');
  const resumeBtn = $('[data-grab="resume"]');
  const dlBtn = $('[data-grab="dl"]');
  pauseBtn.style.display = (t.status === 'running') ? '' : 'none';
  resumeBtn.style.display = (t.status === 'paused') ? '' : 'none';
  dlBtn.disabled = (t.status === 'running' || t.status === 'paused') || t.fetchedCount === 0;
  dlBtn.style.opacity = dlBtn.disabled ? '0.4' : '1';
  dlBtn.style.cursor = dlBtn.disabled ? 'not-allowed' : 'pointer';

  // 任务进行中,tab badge 显示进度数字
  if (t.status === 'running' || t.status === 'paused') {
    $('#tab-badge').textContent = `${t.fetchedCount}/${total}`.slice(0, 8);
    $('#tab-badge').style.background = t.status === 'paused' ? '#f59e0b' : '#1f6feb';
  } else if (t.status === 'completed') {
    $('#tab-badge').textContent = '✓';
    $('#tab-badge').style.background = '#16a34a';
  } else if (t.status === 'stopped') {
    $('#tab-badge').textContent = `${t.fetchedCount}`;
    $('#tab-badge').style.background = '#6b7280';
  }
}

async function handleGrabAction(act) {
  try {
    if (act === 'pause')  { await sendControl('NTTS_PAUSE', {}, 5000); appendLog('info', '⏸ 请求暂停'); }
    if (act === 'resume') { await sendControl('NTTS_RESUME', {}, 5000); appendLog('info', '▶ 请求继续'); }
    if (act === 'stop')   { await sendControl('NTTS_STOP', {}, 5000); appendLog('warn', '⏹ 请求停止 — 当前章节跑完就会停'); }
    if (act === 'dl') {
      appendLog('info', '💾 开始下载…');
      const r = await sendControl('NTTS_DOWNLOAD_FETCHED', { asOneFile: true }, 30000);
      if (r.ok) {
        const ok = (r.results || []).filter(x => x.ok).length;
        appendLog('success', `下载了 ${ok} 个文件`);
      } else {
        appendLog('error', `下载失败:${r.error}`);
      }
    }
  } catch (e) {
    appendLog('error', e.message);
  }
}

$$('[data-grab]').forEach(btn => btn.onclick = () => handleGrabAction(btn.dataset.grab));

// 连接 background
function connectPort() {
  if (port) return port;
  try {
    port = chrome.runtime.connect({ name: 'ntts' });
    port.onMessage.addListener((msg) => {
      if (msg.type === 'NTTS_PROGRESS') renderGrabTask(msg.task);
      else if (msg.type === 'NTTS_LOG') appendLog(msg.level, msg.message);
      // sendControl 的回执也走这里(已在 sendControl 内部加 listener)
    });
    port.onDisconnect.addListener(() => {
      port = null;
      // 5s 后重连
      setTimeout(connectPort, 500);
    });
    console.log('[popup] port 已连接');
  } catch (e) {
    console.warn('[popup] port 连接失败:', e);
    setTimeout(connectPort, 1000);
  }
  return port;
}

(async () => {
  connectPort();
  // 拉一次当前 task
  try {
    const r = await sendControl('NTTS_GET_TASK', {}, 5000);
    if (r && r.task) renderGrabTask(r.task);
  } catch (e) { console.warn('[popup] 拉 task 失败:', e); }
})();

// ============================================================
// 初始化
// ============================================================
refreshFromTextarea();
window.addEventListener('beforeunload', () => speechSynthesis.cancel());
