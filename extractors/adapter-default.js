// extractors/adapter-default.js — Readability 兜底适配器
// 任何站点如果没有专门适配器,就 fallback 到这个

(function (global) {
  'use strict';
  const U = global.NTTS_UTILS;

  const defaultAdapter = {
    name: 'default',
    match: () => true,  // 兜底,永远匹配

    extract(html, baseUrl) {
      try {
        const dom = U.parseHTML(html);
        const clone = dom.cloneNode(true);
        const reader = new Readability(clone, { charThreshold: 200, keepClasses: false });
        const article = reader.parse();
        if (!article || !article.textContent || article.textContent.length < 200) return null;

        const bookTitle = article.siteName || new URL(baseUrl).hostname;

        // 找"下一章"链接(通用启发式)
        const keywords = ['下一章', '下一页', 'next chapter', 'next page', '下一节', '下章', '>>'];
        const links = [...dom.querySelectorAll('a')];
        const nextLink = U.findLinkByClass(links, /next|nextpage|nextchap/) || U.findLinkByKeyword(links, keywords);
        const nextUrl = nextLink ? U.resolveURL(nextLink.getAttribute('href'), baseUrl) : null;

        return {
          source: 'readability',
          bookTitle,
          chapterTitle: article.title || '',
          chapterIndex: U.extractChapterIndex(article.title),
          text: U.cleanText(article.textContent),
          pageIndex: 1,
          pages: 1,
          nextPageUrl: null,
          nextChapterUrl: nextUrl,
          bookIndexUrl: null,
          url: baseUrl,
        };
      } catch (e) {
        console.warn('[NTTS default extract] failed:', e);
        return null;
      }
    },

    listChapters() { return []; },
    bookIndexPages() { return []; },
  };

  (global.NTTS_ADAPTERS = global.NTTS_ADAPTERS || {})[defaultAdapter.name] = defaultAdapter;
})(typeof globalThis !== 'undefined' ? globalThis : self);
