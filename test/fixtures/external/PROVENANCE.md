# External PDF Fixtures — Provenance

These PDFs are public-domain or openly-licensed materials fetched from
trusted sources. They are checked in so the matcher corpus tests remain
reproducible without a live network dependency.

**Do not fetch these from the upstream URL at test time.** The URL is
recorded here as provenance, not as a live download source. If you need to
refresh the fixture, fetch manually, verify the SHA-256 matches an
intentional change, and update the entry below.

All fixtures downloaded 2026-04-18.

---

## arxiv-2501.18462.pdf

- **Source:** https://arxiv.org/pdf/2501.18462
- **License:** Paper-specific; see arXiv abstract page for license metadata. arXiv CS submissions commonly use CC-BY-4.0.
- **Coverage:** Multi-column academic paper, LaTeX `pdfTeX` producer, heavy mathematical notation.
- **Pages:** 6
- **Bytes:** 367408
- **SHA-256:** `fa62d457ec6925d2c923be430275d55ca575b60429521e5e4fda08da714873db`

## gpo-fr-notice.pdf

- **Source:** https://www.govinfo.gov/content/pkg/FR-2025-08-05/pdf/2025-14846.pdf
- **License:** Public domain (US federal government publication, Federal Register).
- **Coverage:** Federal Register single-notice document; GPO's XyVision-derived layout pipeline.
- **Pages:** 3
- **Bytes:** 232102
- **SHA-256:** `6c81365ed9dd0715243f6877a1bfe633653112195b9420d5f5b41032e5da6972`

## irs-p1040-tax-tables.pdf

- **Source:** https://www.irs.gov/pub/irs-pdf/p1040.pdf
- **License:** Public domain (US federal government publication).
- **Coverage:** Tax tables publication; dense tabular data, many pages, Adobe-family producer.
- **Bytes:** 1452403
- **SHA-256:** `8ae019bd3b28b07b37e46e18597d8e899222a2224ce7482c015b130033403532`

## irs-w9.pdf

- **Source:** https://www.irs.gov/pub/irs-pdf/fw9.pdf
- **License:** Public domain (US federal government publication).
- **Coverage:** Fillable AcroForm PDF; form field widgets, checkbox annotations.
- **Bytes:** 140815
- **SHA-256:** `2d420cbb4123dcf1fb82595b2359cfbb5d81f00b9df9d359fcc7af361d093f53`

## nist-sp-1271.pdf

- **Source:** https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.1271.pdf
- **License:** Public domain (US federal government publication, NIST Special Publication 1271 "Getting Started with the NIST Cybersecurity Framework").
- **Coverage:** NIST publication; Word → PDF pipeline; figures, sidebars, footers.
- **Bytes:** 462621
- **SHA-256:** `f3b4436626b87fceb12cde8dd29da7432254821e3e2753103fe3500dd1f6e17d`

## scotus-24-656.pdf

- **Source:** https://www.supremecourt.gov/opinions/24pdf/24-656_ca7d.pdf
- **License:** Public domain (US Supreme Court slip opinion; federal government work).
- **Coverage:** SCOTUS opinion (TikTok Inc. v. Garland, 2025); Word → Distiller producer; syllabus + majority + concurrence structure.
- **Bytes:** 169103
- **SHA-256:** `780f07a100107f3d2ef4b2e0cc5901f476b583bf45ef4c25cea468dd17c419c4`

## un-ecosoc-multilingual.pdf

- **Source:** https://documents.un.org/doc/undoc/gen/g03/169/00/pdf/g0316900.pdf
- **License:** UN publications are typically distributable for informational use; check individual document header if redistributing derivative work. Used here only as a matcher input fixture.
- **Coverage:** Older-style UN Economic and Social Council document; PDF 1.2 producer (distinct from Distiller/pdfTeX lineage); ISO A4 page size.
- **Pages:** 10
- **Bytes:** 346515
- **SHA-256:** `d6bccdd094077a2a764c4a39d7ff1ba858f0487d3dbfb6975901bb9ab08f892f`

## un-ga-chinese.pdf

- **Source:** https://documents.un.org/doc/undoc/gen/n23/423/15/pdf/n2342315.pdf
- **License:** UN publications are typically distributable for informational use. Used here only as a matcher input fixture.
- **Coverage:** UN General Assembly document, Chinese-language (CJK script); PDF 1.7, Microsoft Word for Microsoft 365 producer; has structure tree and marked content.
- **Pages:** 12
- **Bytes:** 455222
- **SHA-256:** `f029e4037f841c91861a449d98c18e1602e0736d1b9071cb4a3c0e6a18ff449e`

## un-sc-arabic.pdf

- **Source:** https://documents.un.org/doc/undoc/gen/n23/423/14/pdf/n2342314.pdf
- **License:** UN publications are typically distributable for informational use. Used here only as a matcher input fixture.
- **Coverage:** UN Security Council document, Arabic-language (right-to-left script); PDF 1.7, Microsoft Word for Microsoft 365 producer; has structure tree and marked content. Exercises matcher's RTL-script handling and long-text normalization path (~13 K operators).
- **Pages:** 15
- **Bytes:** 436623
- **SHA-256:** `dacf4ab8912f7aa4e6dacca9a472113721bf83f9cc8bdb5bc19ce9e272c34d8e`

## usgs-of2024-1001.pdf

- **Source:** https://pubs.usgs.gov/of/2024/1001/ofr20241001.pdf
- **License:** Public domain (US Geological Survey open-file report).
- **Coverage:** USGS Open-File Report with 24 landscape pages using the `/Rotate 90` PDF convention (rather than a rotated MediaBox). PDF 1.7, Adobe PDF Library 17.0 producer; has structure tree and marked content. This fixture pins the matcher's `unrotateOpToPortrait` transform — without the rotation fix, the 24 rotated pages match at 10-30% while the 44 non-rotated pages match at 70-90%; with the fix, the whole document matches at 100%.
- **Pages:** 68 (24 rotated + 44 non-rotated)
- **Bytes:** 2494917
- **SHA-256:** `0b16f15d4f43d1fad192ae0c3803c3ed346653fe4ad6d143aa762f2f67c17957`

## un-ga-hebrew.pdf

- **Source:** https://documents.un.org/doc/undoc/gen/n23/423/16/pdf/n2342316.pdf
- **License:** UN publications are typically distributable for informational use. Used here only as a matcher input fixture.
- **Coverage:** UN General Assembly English-language resolution (English translation/original; the filename `hebrew` reflects the source URL's document series slot rather than the content language — content is 100% English by character count). Kept as coverage for short-form Microsoft Word UN resolution layouts. Hebrew-specific RTL verification is by code-range argument, not empirical: the matcher's `containsRtl` predicate covers both Arabic (0x0600-0x06FF) and Hebrew (0x0590-0x05FF) via the same Unicode range check, and `un-sc-arabic.pdf` empirically confirms the reverse-containment path.
- **Pages:** 13
- **Bytes:** 279193
- **SHA-256:** `904ee71804b41e68a80d6d36acb4479ea29ca247df91d6654784bd3131b60c77`

## thai-constitution-en.pdf

- **Source:** https://www.constitutionalcourt.or.th/occ_en/download/article_20170410173022.pdf
- **License:** Thailand government publication; licensing assumed permissive for informational/research use. Used here only as a matcher input fixture.
- **Coverage:** Thai Constitution (English translation) — PDF 1.3, Mac OS X 10.12.3 Quartz PDFContext producer (rare; distinct Apple-platform text pipeline). 115 pages, ~15 K operators; exercises older PDF version handling and a producer outside the Windows/Linux mainstream.
- **Pages:** 115
- **Bytes:** 3170945
- **SHA-256:** `44d285f03fce87eacbd1da9fa7c6c7369f5ee1094aa9f1682094594c44857f2e`
