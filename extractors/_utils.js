// extractors/_utils.js — 适配器共享工具
// 通过 globalThis.NTTS_UTILS 暴露
// 必须先于任何 adapter 加载

(function (global) {
  'use strict';

  const utils = {
    // HTML 字符串 → DOM
    parseHTML(html) {
      return new DOMParser().parseFromString(html, 'text/html');
    },

    // 解析相对/绝对 URL
    resolveURL(href, base) {
      try { return new URL(href, base).href; } catch { return null; }
    },

    // 文本清理
    cleanText(s) {
      return (s || '')
        .replace(/\u00A0/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    },

    // 从 <script>var X = "..."</script> 读字符串
    readJsVar(html, name) {
      const re = new RegExp('var\\s+' + name + '\\s*=\\s*["\']([^"\']+)');
      const m = html.match(re);
      return m ? m[1] : '';
    },

    // 从 <script>var X = 123</script> 读数字
    readJsNumber(html, name) {
      const re = new RegExp('var\\s+' + name + '\\s*=\\s*["\']?(\\d+)');
      const m = html.match(re);
      return m ? parseInt(m[1], 10) : 0;
    },

    // 章节号提取(从 "第 123 章 xxx" 提 123)
    extractChapterIndex(title) {
      if (!title) return 0;
      const m = String(title).match(/第\s*(\d+)\s*章/);
      return m ? parseInt(m[1], 10) : 0;
    },

    // 找链接(按关键词)
    findLinkByKeyword(links, keywords) {
      for (const a of links) {
        const t = (a.textContent || '').trim().toLowerCase();
        if (!t) continue;
        if (keywords.some(k => t === k || t.includes(k))) return a;
      }
      return null;
    },

    // 找链接(按 class/id)
    findLinkByClass(links, regex) {
      for (const a of links) {
        const cls = ((a.className || '') + ' ' + (a.id || '')).toLowerCase();
        if (regex.test(cls)) return a;
      }
      return null;
    },
  };

  global.NTTS_UTILS = utils;
})(typeof globalThis !== 'undefined' ? globalThis : self);
