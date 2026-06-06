# Screenshots

This directory holds screenshots referenced from the top-level
[`README.md`](../../README.md#screenshots).

The framework is **site-agnostic** — what it looks like depends entirely
on which site adapter is loaded. The placeholder slots in the main
README are filled in for example purposes; the real screenshots in a
release come from whichever build is being shipped.

## Conventions

- Filename: lowercase, kebab-case, descriptive — e.g.
  `floating-button.png`, `per-chapter-panel.png`, `popup-tts.png`,
  `grab-config-panel.png`.
- Format: PNG, max width 1200 px (the README renders at ~720 px on
  GitHub desktop — anything larger just makes the diff harder to read).
- File size: keep each under ~300 KB; prefer lossless tools (e.g.
  `pngquant` or `oxipng`) before committing.
- No real book text or chapter content in the screenshot. Use
  public-domain or fabricated content for demo shots.

## What to capture

For a typical build you'll want 3–4 screenshots covering:

1. **Floating button** — the 📖 button that injects into supported pages.
2. **Per-chapter panel** — the small panel that opens when you click the
   button on a chapter page (Listen / Copy / Download / Grab full book).
3. **Grab config panel** — the multi-step configuration for a full-book
   grab (mode, range, concurrency).
4. **Popup TTS listener** — the toolbar-popup TTS UI you get from the
   extension icon.

## Adding a screenshot

1. Drop the PNG into this directory.
2. Edit `../../README.md` and replace the placeholder row with your
   image:

   ```markdown
   ![Floating button](docs/screenshots/floating-button.png)
   ```

3. Update the table at the top of `README.md` accordingly.

PRs adding new screenshots are welcome.
