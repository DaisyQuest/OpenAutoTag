# A37: rotated and QuadPoints link geometry

Native link ownership now uses source glyph positions in default user space and the annotation's actual quadrilateral regions. It supports rotated pages, crop offsets, UserUnit scaling, rotated/sheared horizontal text and nested Form transforms. Text inside a large annotation rectangle but outside its valid active quadrilaterals remains outside the Link.

[ISO 32000's Link annotation rules](https://pdf-issues.pdfa.org/32000-2-2020/clause12.html) specify default-user-space coordinates and counterclockwise vertices. They also define rectangular fallback when quad coordinates extend outside Rect. The [Link structure rules](https://pdf-issues.pdfa.org/32000-2-2020/clause14.html) associate wrapped content with one annotation using multiple quadrilaterals. We preserve these original annotation values and actions; uncertain fallback cases remain explicit review tasks rather than silently treating a broad rectangle as the intended text anchor.

## Implementation

The parser captures unprojected glyph displacements specifically for the native link pass. This avoids the cardinal-axis projection used by PDFTextStripper's legacy layout calculations. Exact source font codes, operand bytes, Unicode, glyph count and final decoded text must agree. Layout consumers keep their existing geometry contract and do not retain the additional link geometry. The dedicated capture fails at one million glyphs per page, before retaining an unbounded position list.

The writer and saved validator independently interpret simple counterclockwise quads, including concave shapes and unions of disjoint regions. Point-in-polygon tests use a quarter-default-user-unit boundary tolerance. Repeated regions do not duplicate glyph ownership. Each quad must be numeric, finite, nondegenerate, non-self-intersecting and contained in Rect. Clockwise/Z-ordered, empty, truncated, nonnumeric, degenerate, excessive and out-of-rectangle arrays require review. Link Path geometry is outside this qualification. An unsupported visible annotation still conservatively blocks a competing annotation through its rectangle.

Saved inspection adds optional `quadPoints` and `linkPathPresent` fields. Rectangle and quad coordinates use the same numeric representation; a real-document derivative exposed and now tests the exact-edge precision case. Source annotation fingerprints still check every original geometry/action value. The source-ownership format and CLI arguments are unchanged. One annotation supports up to 1,024 quads; writer and validator work budgets charge quadrilateral checks. No dependencies were added.

## Evidence

The production baseline passed **694 cases** with zero failures or skips. The final affected run passed **38 cases**, including the added exact-boundary fixture and final concave-region support. The configured baseline is 695 cases, covered across these overlapping runs. No single final 695-case run or coverage percentage is claimed. The preceding 76-case focused run also passed, covering the existing A36 link tests.

The final fixture has **30 pages**, **22 bound annotations** and **9 explicit reviews**. It covers all four page rotations, nonzero crop origins, UserUnit 2, text at 37/90/180/270 degrees, shear, nested Forms, concave and repeated quads, disjoint annotations whose rectangles overlap, and a two-line anchor with unrelated text between its quad regions. It passes **1,381 saved checks** and **4,055 raw veraPDF checks**. Tampering with saved QuadPoints, removing them or forging source ranges that steal surrounding text is rejected. Malformed cases passing raw veraPDF remain review cases; raw conformance does not establish correct anchor ownership.

Independent pypdf inspection verifies source text operand bytes, TJ adjustments, page geometry, annotation properties, field values and widget appearance bytes. PDFBox checks all fixture pages before and after filling the existing field with `José café 987`, saving and reopening. **All 63 Poppler page pairs at 120 DPI match exactly**: 30 original fixture pairs, 30 edited/reopened pairs and three real-document/derived pairs. Representative rotated-text and NASA pages were visually inspected.

The official [NASA Hinode source](https://science.nasa.gov/wp-content/uploads/2023/09/hinode-one-pager.pdf) retains its original hash. It is replayed with batch 10's corrected reading-order intent. Two additional test sources derive from it: a 90-degree rotation, and a 270-degree rotation with a changed crop, UserUnit 2 and Rect-equivalent QuadPoints. These are disclosed synthetic transformations of a reputable source, not naturally occurring corpus examples. All three outputs bind **four links each** and pass **1,043 saved checks** and **5,246 raw veraPDF checks** each.

Existing production TEST-FORM and booklet files retain their hashes. Their earlier field/edit evidence and outstanding booklet findings are not recharacterized as new runs. The new native fixture verifies an existing editable field directly. The booklet's six raw failures, 196 saved failures and 158 pending OCR segments remain unresolved.

## Reproduce and remaining work

```text
node --test --test-concurrency=1 modules/pdf-writer/test/native-link-geometry.test.js modules/validator/test/link-geometry.test.js
```

Set `NATIVE_LINK_GEOMETRY_EVIDENCE_DIR` to a fresh directory to keep the source, candidate, corruption probes and reports. Exact artifact and log hashes are in [the evidence report](evidence/accessibility-50-batch21-20261023.json).

Multiple runs belonging to one intended owner can now follow multiple valid quad regions. Grouping anchors across distinct semantic nodes remains A38; source-authored replacements, unsupported vertical fonts, ambiguous overlap and custom Path activation remain for review. This batch does not validate descriptive link purpose, arbitrary logical reading order or keyboard/screen-reader usability, and does not certify fully accessible PDFs.
