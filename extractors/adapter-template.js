// extractors/adapter-template.js — 新站适配器模板
// 复制一份,改 name / match / extract / listChapters / bookIndexPages 即可
// 然后在 manifest.json 的 content_scripts.js 数组里加一行

(function (global) {
  'use strict';
  const U = global.NTTS_UTILS;

  const mySite = {
    name: 'mysite',                            // ← 唯一 ID,跟文件名 adapter-mysite.js 对应
    homepage: 'https://www.example.com',       // ← 站点主域(用于文档)
    match: (url) => /example\.com/i.test(url), // ← URL 匹配规则

    /**
     * 从 HTML 提取文章
     * @param {string} html   完整 HTML
     * @param {string} baseUrl 当前页 URL
     * @returns {object|null}  提取结果
     */
    extract(html, baseUrl) {
      const dom = U.parseHTML(html);

      // 1. 找正文容器(用 querySelector,根据站点实际结构改)
      const container = dom.querySelector('#content, .article, .chapter-content, div.content');
      if (!container) return null;

      // 2. 拿书名
      const bookTitle =
        U.readJsVar(html, 'BookName') ||         // 站点 A:JS 变量
        dom.querySelector('h1 a, .book-name')?.textContent.trim() ||  // 站点 B:面包屑
        dom.title.split(/[-_|]/)[0].trim();     // 站点 C:title 截取

      // 3. 拿章节标题
      const chapterTitle =
        U.readJsVar(html, 'ChapterTitle') ||
        dom.querySelector('h2, .chapter-title')?.textContent.trim() ||
        '';

      // 4. 拿章节号
      const chapterIndex = U.extractChapterIndex(chapterTitle);

      // 5. 提取段落
      const paras = [...container.querySelectorAll('p')]
        .map(p => p.textContent.trim())
        .filter(Boolean);
      // 如果第一个段落是章节标题重复,跳过
      if (paras[0] === chapterTitle) paras.shift();
      const text = U.cleanText(paras.join('\n\n'));

      if (text.length < 100) return null;

      // 6. 找下一页 / 下一章
      const allLinks = [...dom.querySelectorAll('a')];
      const nextLink = U.findLinkByClass(allLinks, /next|nextpage|nextchap/) ||
                       U.findLinkByKeyword(allLinks, ['下一章', '下一页', 'next']);
      let nextPageUrl = null;
      let nextChapterUrl = null;
      if (nextLink) {
        const href = nextLink.getAttribute('href');
        const resolved = U.resolveURL(href, baseUrl);
        if (resolved) {
          // 规则:-N.html → 同章分页,无 -N → 跨章
          if (/-\d+\.html$/.test(resolved)) nextPageUrl = resolved;
          else nextChapterUrl = resolved;
        }
      }

      // 7. 找目录页 URL(用于"抓整本"模式)
      const bookIndexUrl =
        U.readJsNumber(html, 'BookID') ?
          `https://www.example.com/${U.readJsNumber(html, 'BookID')}/` :
          null;

      return {
        source: 'mysite',
        bookTitle: bookTitle.trim(),
        chapterTitle: chapterTitle.trim(),
        chapterIndex,
        text,
        pageIndex: 1,
        pages: 1,
        nextPageUrl,
        nextChapterUrl,
        bookIndexUrl,
        url: baseUrl,
      };
    },

    /**
     * 从目录页解析章节列表
     */
    listChapters(html, baseUrl) {
      const dom = U.parseHTML(html);
      // 适配站点:目录里 li a 包含章节链接
      const items = [...dom.querySelectorAll('#chapter-list li a, .chapter-list a, .dir-list a')];
      return items
        .map((a, i) => ({
          index: i + 1,
          title: a.textContent.trim(),
          url: U.resolveURL(a.getAttribute('href'), baseUrl),
        }))
        .filter(c => c.url);
    },

    /**
     * 探测目录分页(返回所有目录页 URL)
     */
    bookIndexPages(html, baseUrl) {
      // 简单:返回 [baseUrl](无分页)
      // 复杂:看 <select> / <a> 找页码
      return [baseUrl];
    },
  };

  (global.NTTS_ADAPTERS = global.NTTS_ADAPTERS || {})[mySite.name] = mySite;
})(typeof globalThis !== 'undefined' ? globalThis : self);
