---
name: Add a site adapter
about: Submit a new site adapter (or improve an existing one)
title: "[Adapter]: "
labels: adapter, enhancement
assignees: ""
---

## Site info

- **Site name**:
- **Homepage URL**:
- **Sample chapter URL**:
- **Sample index URL**:

## Adapter file

- [ ] I've added `extractors/adapter-<sitename>.js`
- [ ] I've added the file to `manifest.json` `content_scripts.js` (BEFORE `extractors/index.js`)
- [ ] `node --check extractors/adapter-<sitename>.js` passes

## Verification done

- [ ] Loaded the extension, opened a chapter on the target site
- [ ] Verified the floating 📖 button shows correct book/chapter title
- [ ] Verified "📚 Grab full book" with a small range (1-5) works
- [ ] Verified the exported .txt looks clean (no ads, no nav, no footer)

## Notes

<!-- Anything else — pagination tricks, chapter index quirks, multi-page chapters, etc. -->
