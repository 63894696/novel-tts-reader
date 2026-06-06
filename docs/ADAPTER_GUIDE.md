# How to Write Your First Adapter (with an LLM)

> **TL;DR**: Give your LLM the `adapter-template.js`, two HTML samples (a chapter
> page and a book index page), and a short description of the site. The LLM
> fills in 4 functions. You verify with a 2-minute test. You're done.

This guide assumes you have:

- A working LLM agent (Mavis, Claude Code, Cursor, etc.) that can read files
  and run commands
- Node.js 14+ (for the test harness)
- A target website that publishes novel-style content with chapter pages and
  a book index

## Why use an LLM

A minimal adapter is **~120 lines of JavaScript** with 4 functions, each of
which is mostly DOM selector logic. That kind of work is exactly what LLMs
excel at: pattern matching against HTML samples, picking selectors, falling
back through alternatives. The bottleneck is **your judgment about whether
the result is correct** — not writing the code.

The hard part is verification, which we cover at the end.

## Step 1: Capture HTML samples

You need **two HTML files saved locally**:

1. **A chapter page** — e.g. `https://example.com/book/123/chapter-1.html`
2. **A book index page** — e.g. `https://example.com/book/123/`

Save them with your browser's "View Source" → Save As. Or, from the
browser console:

```js
// Open a chapter page, then in DevTools console:
copy(document.documentElement.outerHTML);
// Paste into /tmp/chapter.html

// Open the book index, repeat:
copy(document.documentElement.outerHTML);
// Paste into /tmp/index.html
```

You need only one of each. The LLM doesn't need the full HTML, but **more
context = better selectors**. Aim for at least 50KB each.

## Step 2: Tell the LLM what to build

Open your LLM agent and paste something like the following (adjust to taste):

````
I want to add support for the website "example.com" to my Chrome extension
Novel TTS Reader. It's a novel-reading site.

I have two HTML samples attached:
- /tmp/chapter.html — a single chapter page
- /tmp/index.html — a book index (table of contents)

Please:
1. Read `extractors/adapter-template.js` to understand the adapter contract.
2. Look at /tmp/chapter.html and /tmp/index.html.
3. Write a new file `extractors/adapter-example.js` that:
   - matches URLs on example.com
   - extracts book title, chapter title, chapter index, and chapter body
   - extracts the list of all chapter URLs from the index page
   - handles pagination if the index has multiple pages
4. Add the adapter to `manifest.json` content_scripts.js, BEFORE
   `extractors/index.js` but AFTER `extractors/adapter-default.js`.
5. Verify the new file passes `node --check`.

Report back:
- Which selectors you used and why
- Any edge cases you found (multi-page chapters, weird title formats, etc.)
- A 3-line summary of what you changed
````

## Step 3: Verify the adapter (the part LLMs get wrong)

**Don't trust the LLM that the output is correct.** LLMs are good at producing
plausible-looking code; they're not good at knowing whether it actually works
on your specific site. You must verify.

### 3a. Static check

```bash
node --check extractors/adapter-example.js
```

Catches syntax errors. Catches nothing else.

### 3b. Functional check (recommended)

Create `test-adapter.mjs` in the project root:

```js
import fs from 'fs';
import { JSDOM } from 'jsdom';  // npm i jsdom
// Or use the same parser as the extension (DOMParser) in Node 18+ via
//   import { DOMParser } from 'whatwg-url'; ... actually just polyfill
//
// Easiest: run it in the browser, see 3c.

const html = fs.readFileSync('chapter.html', 'utf8');
const adapter = (await import('./extractors/adapter-example.js')).default;
// ... but the adapter is an IIFE that registers to globalThis, so:
globalThis.NTTS_UTILS = require('./extractors/_utils.js');
require('./extractors/adapter-example.js');
const result = globalThis.NTTS_ADAPTERS.example.extract(html, 'https://example.com/book/123/chapter-1.html');
console.log(JSON.stringify(result, null, 2));
```

Simpler: just load the extension in Chrome and try it. See 3c.

### 3c. Live browser test (the real test)

1. Reload the extension: `chrome://extensions/` → click the **refresh** icon
2. Open a chapter page on your target site
3. Click the floating **📖 button**
4. Check the panel:
   - **Book title** correct?
   - **Chapter title** correct?
   - **Chapter text** non-empty, no obvious garbage (e.g. ads, nav)?
   - **章节号** (chapter index) detected?
5. Open the book index page, click 📖 → **📚 Grab full book**
6. Pick **指定范围**, set a small range like **1-5** to test
7. Watch the monitor panel: it should report each chapter fetched
8. After 5 chapters complete, click **💾** → check the downloaded `.txt`
9. Open the txt, scan: any garbage lines? missing paragraphs? wrong order?

If any of these fail, **paste the failing output back into the LLM** and ask
it to fix. The LLM can iterate; you can verify.

## Step 4: Edge cases to watch for

These are the things that bit me (the original author) when I wrote
adapters. Tell the LLM explicitly about them up front, and you'll save a
round trip:

- **Multi-page chapters**: a single chapter can be split across `?page=2`
  or `-2.html` URLs. Use `<link rel="next">`, the "下一页" link, or a JS
  variable (`var NextPage`).
- **Mixed Chinese/English chapter titles**: `第 123 章` vs `Chapter 123` vs
  `第 1 章 终章(完)` — your regex needs to be lenient.
- **Index pages with hundreds of chapters**: the page may use `<select>`
  pagination, AJAX loading, or infinite scroll. Always test with a
  **multi-page** index site, not a 10-chapter one.
- **Author / admin pages mixed in**: the URL `example.com/book/123/` may
  also have links to "管理后台" (admin) or "打赏" (donate). Filter by
  URL pattern (e.g. must match `/\d+\.html$/`).
- **Placeholder chapters**: some sites put "完结感言" or "请期待下集" as
  numbered list items. The LLM should treat these as chapters or filter
  them — your call.

## Step 5: Iterate

Almost no adapter is right on the first try. Typical iteration loop:

```
1. LLM writes adapter based on samples
2. You load it, find a bug
3. Paste the bug + the failing HTML to the LLM
4. LLM fixes the selector or adds a fallback
5. Repeat 2-4
```

The 80/20 here: **most bugs are "selector didn't match because the site
uses a different class name on this page"**. A 1-line fix.

## When to give up and write it yourself

If after 2-3 iterations the LLM keeps producing plausible-but-wrong code,
just write it yourself. The template is short, and at that point you've
already learned the site's structure better than the LLM has.

The good news: you can keep your private adapter **out of this public
repo**. The framework doesn't care what's in `extractors/`. The public
repo has no opinions about which sites are supported.

## Sanity checklist before you publish

- [ ] `node --check` passes
- [ ] `manifest.json` lists the adapter in the correct position
- [ ] At least one full chapter extracts correctly
- [ ] At least 5 consecutive chapters extract correctly (range 1-5)
- [ ] The full-book export reads naturally
- [ ] Re-load the extension after editing — old code lingers otherwise
- [ ] You have a `.crdownload` or two in your Downloads to clean up
  (Chrome keeps partial downloads from interrupted full-book exports)

## Reference: what the framework expects

The framework (`content.js` and `extractors/index.js`) will call:

- `match(url)` — your adapter's `match` function returns true if this URL
  belongs to your site. **Don't over-match**: if your regex is too loose,
  you'll accidentally handle other sites.
- `extract(html, baseUrl)` — for a chapter page. Returns an object with
  at minimum `{ bookTitle, chapterTitle, text, bookIndexUrl }`. Missing
  fields gracefully degrade.
- `listChapters(html, baseUrl)` — for a book index page. Returns
  `[{ index, title, url }]`. The framework will deduplicate and re-index
  based on title patterns automatically.
- `bookIndexPages(html, baseUrl)` — optional. Returns `string[]` of all
  index-page URLs (used when the index has pagination). If omitted, the
  framework assumes there's only one index page.

The exact contract is documented inline in
[`extractors/adapter-template.js`](../extractors/adapter-template.js).
