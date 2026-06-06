# Novel TTS Reader — Framework

> A Chrome extension that turns any novel-style website into TTS-audio you can listen to.
> Built around a **pluggable adapter architecture**: support for a new site is a single file.

## What this is

This is the **framework core** of Novel TTS Reader. It does **not** contain any
adapter targeting a specific website — it's a generic content-extraction + TTS
playback shell. To use it, you write (or copy) an adapter for the site you care
about, drop it into `extractors/`, and load the extension.

If you only want to use the extension on a specific site, ask whoever gave you
this framework for their **private build** (which contains the site adapters
they've written). This repository is for **developers and contributors** who
want to:

- Add support for a new website by writing one adapter
- Learn the architecture and fork the project
- Tweak the TTS / extraction / storage layer for their own use

## Quick start (for end users of *your* build)

1. **Load the extension**:
   - `chrome://extensions/` → enable **Developer mode**
   - Click **Load unpacked** → select this directory
2. **Visit a page on a supported site** (one for which you've written/wired an adapter)
3. Click the floating **📖 button** (bottom-right) to open the per-chapter panel
4. From the panel:
   - **▶ Listen** — play this chapter via Web Speech API
   - **📋 Copy** — copy the chapter text to clipboard
   - **💾 Download** — save as a `.txt` file
   - **📚 Grab full book** — open the configuration panel and grab the whole book

## Architecture

```
manifest.json              Extension manifest (MV3)
background.js              Thin router — zero top-level await, zero long tasks.
                           Just delegates NTTS_FETCH / NTTS_DOWNLOAD / etc.
content.js                 Main controller. Floating button, per-chapter panel,
                           grab-task loop, resume logic, full-book export.
popup.html / popup.js      TTS listener UI (click the extension icon).
lib/Readability.js         Mozilla Readability — default fallback for unknown sites.
extractors/
  _utils.js                parseHTML / resolveURL / cleanText / readJsVar / etc.
  index.js                 Adapter registry + route() + safeExtract().
  adapter-default.js       Generic Readability-based fallback (always loaded last).
  adapter-template.js      Starter template — copy this for your own adapter.
```

### Content-script load order (in `manifest.json`)

The order matters: utilities first, then site adapters (most specific first),
then the dispatcher, then the main controller.

```json
"js": [
  "lib/Readability.js",        // 1. Mozilla Readability (used by adapter-default)
  "extractors/_utils.js",      // 2. Shared helpers (parseHTML etc.)
  "extractors/adapter-default.js",   // 3. Generic fallback (registered first to global table)
  "extractors/adapter-YOURS.js",     // 4. Your adapter — must be BEFORE index.js
  "extractors/index.js",       // 5. Registry + router (last)
  "content.js"                 // 6. Main controller
]
```

## Writing your first adapter

See **[`docs/ADAPTER_GUIDE.md`](docs/ADAPTER_GUIDE.md)** for a step-by-step
walkthrough, including how to use an LLM (e.g. Mavis, Claude, GPT) to write
the adapter for you given just a few HTML samples and a description of the site.

The TL;DR is: copy `extractors/adapter-template.js` to
`extractors/adapter-mysite.js`, fill in 4 things — `match`, `extract`,
`listChapters`, and optionally `bookIndexPages` — then add a line in
`manifest.json`. That's it.

## License

MIT — see [`LICENSE`](LICENSE).

This framework does not ship with adapters for any specific site. Users are
responsible for ensuring the content they extract with their own adapters has
proper authorization. Please respect author copyrights.
