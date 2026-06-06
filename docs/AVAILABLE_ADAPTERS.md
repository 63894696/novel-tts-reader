# Available adapters

> Community-maintained adapters for the **novel-tts-reader** framework.
> Each adapter is a small `extractors/adapter-<sitename>.js` file that lets the
> extension understand a specific novel-publishing website.

## How to use an adapter

There are **two ways** to use an adapter:

### Option A: Pre-built drop (easiest)

Some adapter projects publish a **complete, self-contained Chrome extension**
that already bundles the framework + their adapter. Just download, load as
unpacked, done.

| Site | Drop repo | Adapter author | Status |
|------|-----------|----------------|--------|
| _(none yet)_ | | | |

### Option B: Add to your own fork

1. Fork [novel-tts-reader](https://github.com/63894696/novel-tts-reader)
2. Copy the adapter file (`adapter-<sitename>.js`) into your fork's
   `extractors/` directory
3. Edit `manifest.json` to include the new file in `content_scripts.js`
   (between `adapter-default.js` and `index.js`)
4. Reload the extension in `chrome://extensions/`

## Contributing a new adapter

See [`docs/ADAPTER_GUIDE.md`](docs/ADAPTER_GUIDE.md) for the full walkthrough,
and [`.github/ISSUE_TEMPLATE/adapter.md`](.github/ISSUE_TEMPLATE/adapter.md)
for the PR template.

When your adapter is merged, add it to the table above (or open a PR that
adds the row — we curate this list).

## Curation criteria

An adapter listed here should:

- Be in a public repo (GitHub, GitLab, Codeberg, etc.)
- Have a clear license (MIT preferred, but any OSI-approved is OK)
- Have a working test on at least one full book
- Be maintained (issues responded to within ~30 days, or marked archived)

We don't enforce these strictly, but we may unlist abandoned adapters after
a year.
