# A46: native widget structure ownership

Completed 2026-10-23 from engine baseline 2f9623f.

## Delivered behavior

Native tagging binds exact PDF.js widget references to source annotation objects and emits one Form per widget, including repeated text fields, radio choices and hidden widgets. Existing unique label relationships determine placement within their paragraph or beside their heading. Merged label fragments retain a shared anchor. Names are never used as substitutes for object identity. Old plans receive distinct source-derived Forms with explicitly unresolved placement.

The native writer preserves authored field names, values, flags, actions and appearance streams. It no longer invents generic tooltips or widget Contents. Duplicate bindings, invalid page/name references, orphan field-tree widgets and unsafe tree traversal reject. Every emitted OBJR has reciprocal ParentTree ownership. Source/intent hashes bind the report; independent inspection checks field ancestry, AcroForm roots/calculation order, global field settings, original appearances and one saved Form owner per widget.

Raster rebuilds refuse sources with native widgets or field trees, including automatic fallback and older plans that omit widgets. Raster table/diagram tests retain positive coverage on separate form-free sources. The geometry fixture drops relationships to pages absent from its form-free variant.

The stronger checks exposed PDFBox's default AcroForm accessor adding /DA and fallback fonts during Unicode processing. That pass now uses the accessor without fixups. Font auditing also uses it, so it reports authored fonts instead of fonts introduced by the auditor. Actual authored Standard 14 and missing-font findings remain tested.

The design follows the [PDF Association Tagged PDF Best Practice Guide, pages 50–53](https://pdfa.org/download-area/publications/Tagged-PDF-Best-Practice-Guide.pdf): logical Form ownership is per widget, while field identity remains in the AcroForm hierarchy. Text-label placement does not create a new PDF-level label association property.

## Verification

The initial serial baseline recorded 958 passes and four failures representing three regressions (one parent/subtest pair): a continued-table raster flattening expectation, explicit raster fallback for forms, and an AcroForm default appearance mutation. Each is corrected and covered by subsequent passing runs: 80 affected, 49 metadata/form, 6 geometry, 43 helper and 21 audit cases. Runs overlap and span successive revisions; no single final-revision full baseline or repository-wide coverage is claimed.

The three new JavaScript helpers have 100% line/function and 91.74% aggregate branch coverage in the focused run. Java and repository-wide coverage are not measured here. Negative cases include swapped same-field OBJRs, removed appearances/widgets/field roots, changed tooltip/value/action/page, incorrect ParentTree keys, missing evidence and conflicting intent.

The two-page fixture preserves six fields and eight widgets. It passes **375 saved checks and 966 raw veraPDF checks**, with zero font-audit errors. Text, checkbox, radio and choice controls retain tested fill/save/reopen behavior; the reset action is preserved as data, not executed.

Fresh TEST-FORM native rebuilding preserves **32 fields and 33 widgets**, passing **5,585 saved checks and 15,112 raw checks**, with zero font-audit errors. Twenty-five widgets have label-context placement; eight remain unresolved. Two real fields pass exact accented text sample qualification on both source and candidate.

Independent pypdf inspection verifies all 41 reciprocal Form owners, field properties, appearance stream bytes, text operands/spacing and page geometry. All **ten Poppler page pairs at 120 DPI** match, including edited forms. Representative fixture and TEST-FORM pages were visually inspected. The 28-page geometry regression also passes its six cases, including native fields, rotations/scaling, raster text and redaction.

## Remaining work

Ownership is established; it does not establish accessible-name quality, radio-choice naming, keyboard order or human usability. Missing TU names remain missing for a reviewed repair. Unresolved label placement remains explicit. Native image/resource and font limitations elsewhere remain governed by their own evidence. This delivery does not certify arbitrary PDFs as fully accessible.

Evidence: [machine-readable record](evidence/accessibility-50-batch29-20261023.json). **A01–A46 complete; A47–A50 remain.**
