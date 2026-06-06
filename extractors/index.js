// extractors/index.js — 适配器注册表 + 路由 + safeExtract
// 必须最后加载(adapters 都注册完后再执行)

(function (global) {
  'use strict';

  // 注册表:由各 adapter 文件 IIFE 时往 global.NTTS_ADAPTERS 里挂
  const table = global.NTTS_ADAPTERS || {};

  // 路由:具体站优先,default 永远兜底
  function route(url) {
    const ids = Object.keys(table);
    // 把 default 排到末尾,其他按注册顺序
    const ordered = [
      ...ids.filter(id => id !== 'default'),
      ...ids.filter(id => id === 'default'),
    ];
    for (const id of ordered) {
      const a = table[id];
      if (!a || typeof a.match !== 'function') continue;
      try {
        if (a.match(url)) return a;
      } catch (e) {
        console.warn(`[NTTS] ${id}.match 异常:`, e);
      }
    }
    return table.default || null;
  }

  // 安全提取:故障隔离,单个适配器抛错不影响调度
  function safeExtract(url, html, baseUrl) {
    const adapter = route(url);
    if (!adapter) {
      console.warn('[NTTS] 没有可用适配器:', url);
      return null;
    }
    try {
      const result = adapter.extract(html, baseUrl);
      if (!result) return null;
      return { source: adapter.name, ...result };
    } catch (e) {
      console.error(`[NTTS] 适配器 ${adapter.name} extract 失败:`, e);
      return { source: adapter.name, error: e.message, text: '' };
    }
  }

  // 列出已注册的适配器(调试用)
  function listAdapters() {
    return Object.keys(table);
  }

  global.NTTS_EXTRACTORS = {
    route,
    safeExtract,
    listAdapters,
    table,  // 直接暴露表,方便调试
  };

  console.log('[NTTS] 适配器已注册:', listAdapters().join(', '));
})(typeof globalThis !== 'undefined' ? globalThis : self);
