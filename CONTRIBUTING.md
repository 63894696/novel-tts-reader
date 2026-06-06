# Contributing to Novel TTS Reader

Thanks for considering a contribution! Here's the short version.

## What we accept

- **Bug fixes** — if something is broken, send a PR with a reproduction
- **New site adapters** — most contributions fall here; see below
- **Documentation improvements** — typos, clarifications, examples
- **Performance / refactor** — clean code is welcome

## Before opening a PR

1. **Open an issue first** for non-trivial changes. For one-line fixes / typos,
   go straight to PR.
2. **Test your changes manually**:
   - `node --check` any modified `.js`
   - Reload the extension in `chrome://extensions/`
   - Open a page on the affected site, click the floating 📖 button, verify
     the panel output
3. **Match the existing style**:
   - 4-space indent
   - `'use strict';` at the top of IIFEs
   - JSDoc on exported functions

## Adding a new site adapter (most common contribution)

See [`docs/ADAPTER_GUIDE.md`](docs/ADAPTER_GUIDE.md) for the full walkthrough.
The short version:

1. **Save 2 HTML samples** locally: one chapter page, one book index page
2. **Copy** `extractors/adapter-template.js` to `extractors/adapter-<sitename>.js`
3. **Implement** `match`, `extract`, `listChapters`, and (if multi-page index)
   `bookIndexPages`
4. **Add the new file** to `manifest.json` `content_scripts.js`:
   - Position: between `extractors/adapter-default.js` and `extractors/index.js`
   - Default adapter must always be loaded first; your adapter before `index.js`
5. **Test** with a small range (1-5 chapters) using "指定范围" mode
6. **Verify the exported `.txt`** is clean (no ads, no nav, no footer)
7. **Open a PR** with the adapter file + any manifest.json changes
8. **Use the "Adapter" issue template** (`.github/ISSUE_TEMPLATE/adapter.md`)
   for the PR description

### Don't have time to maintain a new adapter?

That's fine — open an issue, mark it `help wanted`, and someone else may pick
it up.

## Code of conduct

Be kind. We're all volunteers here. Disagreements happen; personal attacks don't.

## License

By contributing, you agree your code will be released under the project's MIT
license.
