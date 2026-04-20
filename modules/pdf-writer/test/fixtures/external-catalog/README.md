# External PDF Corpus Catalog

This directory holds a large, text-first fixture catalog for public PDFs sourced from arXiv's public API.

The working model is:

- Track deterministic text fixtures in git:
  - `arxiv-categories.json`
  - `manifest.json`
- Keep downloaded binaries out of git:
  - `downloads/`
  - `state/`

Why arXiv:

- arXiv publishes a public metadata API and a public category taxonomy.
- Its official API terms still require no more than one legacy API request every three seconds.
- The category taxonomy is broad enough to build a 50-category, 5,000-document corpus without scraping arbitrary websites.

Safety choices:

- Discovery is rate-limited by default.
- Category membership is pinned to the paper's primary arXiv category.
- Downloads are resumable, validated as `%PDF-`, and capped by default at 25 MiB per file.
- The default download run is conservative and breadth-first. Use explicit flags if you really want a full local cache.

Commands:

```sh
node modules/pdf-writer/test/fixtures/external-catalog/build-arxiv-corpus.js discover
node modules/pdf-writer/test/fixtures/external-catalog/build-arxiv-corpus.js download
node modules/pdf-writer/test/fixtures/external-catalog/build-arxiv-corpus.js download --max-downloads 5000
```

The `download` command defaults to a small validation run. That is intentional: a full 5,000-PDF cache is multi-GB and slow even with polite throttling.
