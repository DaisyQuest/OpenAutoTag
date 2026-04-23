# Ontology And Label Policy

## Purpose

This file turns the label-ontology critique into a concrete gate. Bulk generation and training should not begin until the first training ontology is frozen.

## First-Wave Task Ontology

The first ML wave should use these task heads:

| Task head | Unit | Output | Downstream use |
| --- | --- | --- | --- |
| Role classification | Block or region | Role label plus confidence | Candidate evidence for semantic engine or tag builder |
| Object detection | Page region | Bbox plus role | Candidate evidence for tables, figures, stamps, captions, and notes |
| Relationship prediction | Pair or small graph | Relationship label | Footnote links, caption links, header scope, list labels |
| Table structure | Table region | Grid, cells, spans, header scope | Candidate evidence for table structure maps |
| Reading-order ranking | Pair or group | Before/after relation | Candidate evidence for reading-order decisions |
| Tag-tree validation | Proposed subtree | Validity and warnings | Guardrail before PDF writer |
| OOD detection | Page or document | In-distribution decision | Runtime abstention and fallback |

## Role Vocabulary

The ML truth vocabulary may be wider than current engine contracts, but every role must have a projection status.

| ML role | Current projection | Notes |
| --- | --- | --- |
| `Document` | `semantic.schema.json`, `tagging.schema.json` | Compatible |
| `H1`, `H2`, `H3` | `semantic.schema.json`, `tagging.schema.json` | Compatible |
| `H4`, `H5`, `H6` | `tagging.schema.json` | Semantic contract gap |
| `P` | `semantic.schema.json`, `tagging.schema.json` | Compatible |
| `L`, `LI`, `Lbl`, `LBody` | Partial | Semantic has `L` and `LI`; tagging has list substructure |
| `Table`, `TH`, `TD` | `semantic.schema.json`, `tagging.schema.json` | Compatible |
| `THead`, `TBody`, `TFoot`, `TR` | `tagging.schema.json` | Semantic contract gap |
| `Caption` | `tagging.schema.json` | Semantic contract gap |
| `Figure` | `tagging.schema.json` | Semantic contract gap |
| `Form` | `tagging.schema.json` | Semantic contract gap |
| `Aside` | `tagging.schema.json` | Semantic contract gap |
| `BlockQuote` | `tagging.schema.json` | Semantic contract gap |
| `FootnoteReference` | Contract gap | Needs role and relationship policy |
| `FootnoteBody` | Contract gap | Needs role and relationship policy |
| `EndnoteReference` | Contract gap | Needs role and relationship policy |
| `EndnoteBody` | Contract gap | Needs role and relationship policy |
| `Artifact` | `semantic.schema.json` | Compatible as suppression evidence |
| `Unknown` | Research only | Should trigger abstention |
| `Ambiguous` | Research only | Should trigger audit or abstention |

## Footnote And Endnote Policy

Recommended policy:

- Model footnotes and endnotes as both roles and relationships in the truth graph.
- A note marker is a role: `FootnoteReference` or `EndnoteReference`.
- A note body is a role: `FootnoteBody` or `EndnoteBody`.
- The marker-to-body link is a relationship: `footnote-reference` or `endnote-reference`.
- The current engine cannot fully consume these roles, so all note labels start as `contract-gap` until a shared contract update is approved.

This avoids flattening notes into paragraphs too early and gives the future tag-builder enough information to represent note structure.

## Label Confidence Tiers

Every label must carry one tier:

| Tier | Meaning | Training use |
| --- | --- | --- |
| `constructed` | Created by generator intent only | Not enough for high-impact roles |
| `render-verified` | Visual output confirms the label exists | Eligible for low-risk synthetic pretraining |
| `extraction-verified` | Parser-facing extraction confirms text/geometry survived | Eligible for supervised training |
| `engine-projected` | Current pipeline can project it into an expected contract | Useful for regression and teacher comparison |
| `human-verified` | Human audit accepted the label | Required for release-critical validation slices |
| `ambiguous` | Human or verifier cannot decide | Exclude from supervised loss; keep for analysis |
| `contract-gap` | Correct concept but no current downstream representation | Exclude from production training targets until scoped |

High-impact roles are table structure, note links, artifact suppression, reading order, and any role that changes final tag-tree structure.

## Oracle Confidence Tiers

Wave 2 transforms must carry `oracleConfidence`:

| Tier | Meaning |
| --- | --- |
| `constructed` | Transform relation is specified but not independently checked |
| `render-verified` | Render shows the intended visual change |
| `extraction-verified` | Extraction still matches expected relation |
| `human-verified` | Human audit accepted the relation |
| `ambiguous` | Relation may be valid in some contexts but not all |
| `contract-gap` | Relation depends on a concept not represented downstream |

Bulk wave 2 generation is blocked until each transform family has a human-reviewed oracle validation sample.

## Ambiguity Taxonomy

Ambiguous cases should not be forced into hard labels. Use these tags:

- `visual-ambiguous`: humans disagree from rendered page alone.
- `semantic-ambiguous`: visual object is clear but intended role is unclear.
- `contract-ambiguous`: role is real but the current engine has no precise target.
- `extraction-ambiguous`: extraction lost enough evidence that downstream behavior is uncertain.
- `transform-ambiguous`: wave 2 transform may have changed meaning.

Ambiguity is a useful signal. It should create audit and ontology work, not noisy training labels.
