# Changelog

## v0.7.0 (2026-06)

### Framework changes
- Improved pagination detection for book indexes (multi-page sites)
- Better `indexUrls` ordering: start URL preferred, hash-aware dedup
- All `chrome.downloads` Blob-URL logic moved out of background; content
  script now uses `<a download>` for full-book export (avoids service-worker
  `URL.createObjectURL` reliability issues)
- "Resume" task: persists the in-progress task in `chrome.storage.local` so
  a page reload can pick it up via a "▶ Resume" button
- Per-chapter export button enabled even when task is paused (so you can
  save partial progress)

### Documentation
- New `docs/ADAPTER_GUIDE.md` — step-by-step guide for writing your first
  site adapter, with a worked example of using an LLM to do the heavy
  lifting and you doing the verification
- Public README is now English and contributor-focused (the original
  Chinese user-facing README lives in private builds)

### Internal
- Manifest version bumped to 0.7.0
- Removed `adapter-sudugu.js` from public repo (moved to private build
  to keep the public framework free of any specific-site adapters)
