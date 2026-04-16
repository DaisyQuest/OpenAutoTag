# Native PDF Tagging — Design Document

## Problem Statement

The current PDF writer rasterizes every page into a flat image and overlays
invisible text for accessibility. This destroys native PDF content: vector
text becomes pixels, fonts are discarded, links and form fields are lost,
and the output is functionally a scanned document.

"Native tagging" preserves the original PDF content streams and injects
structure annotations (BMC/BDC/EMC marked-content sequences) around the
existing text operators. The result is a tagged PDF where text stays sharp,
fonts stay embedded, and the structure tree points at real content — not a
synthetic overlay.

## Architecture

```
                    ┌─────────────────────────────┐
                    │     Existing Pipeline        │
                    │  parser → layout → semantic  │
                    │  → reading-order → tags      │
                    └──────────┬──────────────────┘
                               │
                    ┌──────────▼──────────────────┐
                    │    Native Tagging Bridge     │
                    │                              │
                    │  1. Operator-level parser    │
                    │     (content stream → ops)   │
                    │                              │
                    │  2. Operator-to-tag matcher  │
                    │     (ops → sourceTextMap     │
                    │      → semantic → tag tree)  │
                    │                              │
                    │  3. Content stream rewriter  │
                    │     (inject BDC/MCID/EMC)    │
                    └──────────┬──────────────────┘
                               │
                    ┌──────────▼──────────────────┐
                    │     Writer Mode Dispatch     │
                    │                              │
                    │  mode=native:  rewrite ops   │
                    │  mode=raster:  current path  │
                    │  mode=auto:    native first,  │
                    │    fall back to raster/page   │
                    └─────────────────────────────┘
```

## Three New Components

### 1. Operator-Level Content Stream Parser (Java)

`NativeContentStreamParser.java` — walks each page's content stream using
PDFBox's `PDFStreamEngine`, recording every operator with:

```java
class ContentOperator {
    String type;        // "Tj", "TJ", "'", "\"", "Tm", "Td", etc.
    int streamOffset;   // byte offset in the content stream
    int sequenceIndex;  // ordinal position among all operators
    String text;        // extracted text (for text operators)
    float[] position;   // [x, y] from the text matrix
    float fontSize;
    String fontName;
    // For text operators: the raw bytes that constitute this operator
    byte[] rawBytes;
}
```

This is finer-grained than sourceTextMap's run-level extraction. Each
Tj/TJ call becomes a separate operator record with its exact stream
position.

### 2. Operator-to-Tag Matcher

`NativeTagMatcher.java` — connects the three data sources:

```
Content operators (from step 1)
    ↕ match by text content + position
Source text runs (from sourceTextMap)
    ↕ match by sourceBlockId
Semantic nodes (from pipeline)
    ↕ match by node id
Tag tree nodes (from tag-builder)
    → MCID assignment
```

The matcher produces a **native tag plan**: for each tag tree leaf that
carries text, the plan specifies which content stream operators to wrap
with BDC/MCID/EMC.

```json
{
  "page": 1,
  "tagNodeId": "p1",
  "mcid": 0,
  "operators": [
    { "streamOffset": 1234, "length": 56, "text": "Hello World" }
  ]
}
```

Match confidence is tracked per-operator. When confidence is below a
threshold (e.g., operator text doesn't match expected text), the plan
marks that region as "unmatched" and the writer falls back to raster
for that specific content.

### 3. Content Stream Rewriter (Java)

`NativeContentStreamRewriter.java` — takes the original content stream
bytes and the native tag plan, and produces a new content stream with
BMC/BDC/EMC sequences injected at the correct positions.

Before:
```
BT /F1 12 Tf 72 700 Td (Hello World) Tj ET
```

After:
```
BT /F1 12 Tf 72 700 Td /P <</MCID 0>> BDC (Hello World) Tj EMC ET
```

The rewriter:
- Preserves all non-text operators verbatim
- Inserts BDC before matched text operator groups
- Inserts EMC after them
- Handles multi-operator spans (e.g., several Tj calls that form one paragraph)
- Does NOT recompress or re-encode — works on the decompressed stream
  and lets PDFBox handle re-compression on save

## Writer Mode

New profile field: `pdfWriter.mode`

| Mode | Behavior |
|------|----------|
| `native` | Parse operators, match to tags, rewrite streams. Fail if <80% of text content can be matched. |
| `raster` | Current behavior (rasterize + overlay). Always works. |
| `auto` | Try native per-page. Fall back to raster for pages where operator matching confidence is below threshold. Report which pages used which mode. |

Default: `auto` (try native, degrade gracefully).

## What "Provably Capable" Means

The system can produce a **native tagging proof report** per document:

1. **Content preservation score**: percentage of text that remains as
   native vector operators (not rasterized). 100% = fully native.
2. **Operator match confidence**: per-page confidence that text operators
   were correctly identified and wrapped.
3. **Structure fidelity**: diff the structure tree against the raster-mode
   tree — same reading order, same roles, same text content?
4. **veraPDF comparison**: run both modes, diff the findings.
5. **File size comparison**: native mode should produce smaller files
   (no raster images).
6. **Visual comparison**: render both outputs, pixel-diff. Native should
   be identical to the original; raster may have DPI artifacts.

## Implementation Phases

### Phase 1: Operator Parser + Proof of Concept
- Build NativeContentStreamParser in Java
- Run it on one LRBTest PDF, produce operator-level map
- Match operators to sourceTextMap runs manually
- Verify the mapping is correct

### Phase 2: Matcher + Rewriter
- Build NativeTagMatcher connecting operators → tags
- Build NativeContentStreamRewriter injecting BDC/MCID/EMC
- Produce a natively-tagged PDF for one document
- Verify with veraPDF

### Phase 3: Integration + Auto Mode
- Wire into pdf-writer as a mode option
- Implement per-page fallback (auto mode)
- Profile knob + dashboard toggle
- Native tagging proof report

### Phase 4: Hardening
- Handle XObject forms (nested content streams)
- Handle inline images mixed with text
- Handle content streams with existing (incorrect) marked content
- Handle encrypted PDFs where content streams are decrypted on read

## Why This Is Not Snake Oil

The difference between "native" and "raster" tagging is measurable:

| Property | Raster (current) | Native (target) |
|----------|------------------|-----------------|
| Text rendering | 144 DPI pixels | Vector (infinite resolution) |
| File size | ~6 MB (10-page doc) | ~200 KB (same doc) |
| Copy/paste | Overlay text (approximate) | Original text (exact) |
| Search | Overlay text | Original text |
| Links | Destroyed | Preserved |
| Form fields | Destroyed | Preserved |
| Zoom quality | Degrades | Perfect |
| Font fidelity | Noto Sans overlay | Original fonts |
| veraPDF findings | More (synthetic content) | Fewer (native content) |

Every one of these properties is objectively testable. The proof report
makes the claim verifiable per-document.
