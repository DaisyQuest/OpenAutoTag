# Bundled fallback fonts

These fonts are loaded by `pdf-writer` when the source PDF references an
unembeddable font (Standard 14, missing font program, symbolic without a usable
encoding, etc.). Every font here is **SIL Open Font License 1.1** — safe to
bundle and redistribute with attribution.

## Layout

| Family                | Files                                                  | Replaces                          |
|-----------------------|--------------------------------------------------------|-----------------------------------|
| Noto Sans             | Regular / Bold / Italic / BoldItalic                   | Helvetica and sans-serif fallback |
| Noto Serif            | Regular / Bold / Italic / BoldItalic                   | Times and serif fallback          |
| Noto Sans Mono        | Regular / Bold                                         | Courier and monospace fallback    |
| Noto Sans Symbols     | Regular                                                | Symbol                            |
| Noto Sans Symbols 2   | Regular                                                | ZapfDingbats                      |
| Noto Sans CJK         | JP / SC / TC / KR (installed via script, not committed)| CJK fallback                      |

## Sources

- Noto family (Latin, Symbols): https://github.com/googlefonts/noto-fonts
- Noto Sans CJK: https://github.com/notofonts/noto-cjk

Each family folder contains its own `LICENSE.txt` copy of the OFL-1.1 license.

## Installing the CJK pack

CJK fonts are ~20MB per weight and are intentionally **not** committed. Run:

```bash
npm run install:fonts
```

The script is idempotent and validates font magic bytes before accepting a
download. A manifest is written to `noto-sans-cjk/install-manifest.json` with
SHA-256 of each installed file.

## Mapping

`fallbacks.json` is the canonical mapping from source font identifier to
fallback descriptor. `pdf-writer` reads this file when executing a
`substitute-fallback` plan action from the font-embedder inventory.
