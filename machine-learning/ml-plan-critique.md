# ML Plan Critique

## Bottom Line

The current plan is strong as a deterministic corpus and reporting program. It is not yet strong enough as a machine-learning program.

The central weakness is that it treats scale, mathematical coverage, and synthetic truth as if they are sufficient. They are necessary, but not sufficient. A million derivative PDFs can still teach a model the wrong shortcuts if the generator has recognizable artifacts, if labels are wrong after rendering/extraction, if train/test splits leak templates, or if evaluation is dominated by near-duplicate children.

The plan should keep its corpus rigor, but it needs stronger ML-specific controls before training starts.

## Research Signals Used

- DocLayNet shows that document-layout models trained on narrower sources can generalize poorly to broader document layouts. Reference: https://arxiv.org/abs/2206.01062
- Shortcut learning describes how deep networks can exploit easy but non-causal cues. Reference: https://arxiv.org/abs/2004.07780
- Leakage research shows that ML studies often report overoptimistic results because train/test separation is flawed. Reference: https://arxiv.org/abs/2207.07048
- Hidden Technical Debt in ML Systems warns about entanglement, undeclared consumers, configuration debt, and silent feedback loops. Reference: https://papers.nips.cc/paper/5656-hidden-technical-debt-in-machine-learning-syst
- Datasheets for Datasets argues that dataset motivation, composition, collection, preprocessing, uses, and limitations must be documented. Reference: https://arxiv.org/abs/1803.09010
- Model Cards require explicit intended use, evaluation conditions, limitations, and subgroup metrics. Reference: https://arxiv.org/abs/1810.03993
- Calibration work shows that modern neural networks can be accurate but overconfident. Reference: https://arxiv.org/abs/1706.04599
- OOD detection baselines show that misclassified and out-of-distribution inputs need separate detection and reporting. Reference: https://arxiv.org/abs/1610.02136
- Noisy-label surveys show that label errors can be memorized and can harm generalization. Reference: https://arxiv.org/abs/2012.03061
- ML testing surveys emphasize test adequacy, data behavior, model behavior, and workflow behavior as separate concerns. Reference: https://arxiv.org/abs/1906.10742
- Metamorphic testing is useful when exact oracles are hard, but metamorphic relations themselves must be validated. Reference: https://doi.org/10.1145/3143561
- Combinatorial testing supports pairwise and higher-order factor coverage, but it does not replace real-distribution validation. Reference: https://www.nist.gov/publications/practical-combinatorial-testing-beyond-pairwise

## Major Criticisms

### 1. The Plan Overvalues Raw Corpus Size

The plan says 100,000 PDFs in wave 1 and 1,000,000 derivatives in wave 2. That sounds large, but ML does not see "number of files"; it sees effective diversity.

If 1,000,000 PDFs share templates, fonts, page constructors, text generators, artifact styles, or transform signatures, the effective sample size may be far smaller. A model can learn "this looks like our generator's footnote case" instead of "this is a footnote."

Required correction:

- Report effective sample size by parent cluster, template family, transform family, text source, producer profile, and rendered visual signature.
- Always report parent-clustered metrics and worst-parent metrics.
- Create template-holdout, transform-holdout, producer-holdout, and text-source-holdout splits.
- Treat wave 2 children as correlated samples, not independent samples.

### 2. The Synthetic-To-Real Gap Is Still Too Vague

The plan says "synthetic plus real anchors," but it does not yet say how much real data, how it is sampled, how it is labeled, or how it blocks release.

DocLayNet is a direct warning here: broader document variety changed generalization behavior. Our synthetic corpus can be mathematically beautiful and still miss real producer quirks, OCR failures, government forms, old scans, user-generated PDFs, accessibility tool outputs, and broken PDFs.

Required correction:

- Add a real-anchor corpus before model training, not after.
- Target at least 5,000 to 10,000 real public PDFs across government, legal, academic, finance, forms, healthcare-like public documents, standards, multilingual sources, old scans, and born-digital reports.
- Label a stratified subset manually or semi-manually with human audit.
- Make real-anchor performance a hard gate for release.
- Track synthetic-to-real divergence with feature distributions and failure slices.

### 3. The Label Ontology Is Not Settled

The current plan wants models to classify footnotes, endnotes, captions, figures, forms, and asides. The current `semantic.schema.json` cannot represent all of those roles. The plan recognizes this, but the criticism is sharper: training before resolving ontology will create labels that the engine cannot consume safely.

Required correction:

- Freeze a task ontology before generating labels at scale.
- Decide whether footnotes and endnotes are roles, relationships, tag-builder-only structures, or both.
- Define one truth graph that can project into layout, semantic, table, and tagging contracts.
- Add explicit "contract gap" labels so impossible downstream mappings are not treated as model failures.

### 4. Generator Truth Is Not Automatically Real Truth

The plan says labels by construction and labels by verification. That is good, but still too optimistic. PDF generation has many places where truth can drift:

- Text may be clipped.
- Glyphs may be substituted.
- The extractor may merge or split text unexpectedly.
- OCR layers may disagree with the rendered image.
- A crop transform may remove visual context required for the role.
- A metamorphic transform may unintentionally change semantics.

Required correction:

- Add label confidence levels: constructed, render-verified, extraction-verified, engine-projected, human-verified.
- Never train high-impact roles only from constructed labels.
- Require human verification for a statistically meaningful sample from every generator and transform family.
- Treat failed truth morphisms as label bugs, not model errors.

### 5. Wave 2 Metamorphic Relations Can Be Wrong

Wave 2 depends on preserving, monotonic, threshold, counterfactual, and extraction oracles. That is the right direction, but the metamorphic relations are themselves hypotheses.

Example: moving a footnote body closer to a table may preserve the visual note, but it may change the human reading-order interpretation. Removing table rules may preserve table structure in a clean synthetic document, but in a real-looking page it may convert a table into an ambiguous aligned list.

Required correction:

- Every transform family needs an oracle validation set manually reviewed before bulk generation.
- Reports must distinguish model failure from invalid metamorphic relation.
- Add an `oracleConfidence` field to wave 2 manifests.
- Promote "ambiguous by human judgment" to a first-class outcome.

### 6. Leakage Risk Is Bigger Than The Plan Admits

The split inheritance rule is good, but not enough.

Leakage can happen through:

- Shared templates.
- Shared text snippets.
- Shared random backgrounds.
- Shared table schemas.
- Shared stamp designs.
- Shared font bundles.
- Shared OCR noise patterns.
- Shared document producer signatures.
- Preprocessing normalization fitted on all splits.
- Hyperparameter tuning on locked audit reports.

Required correction:

- Split before generation where possible.
- Hash and cluster templates, source text, rendered backgrounds, table schemas, and artifact assets.
- Add leakage scanners to CI.
- Keep locked audit reports hidden from model-selection workflows.
- Record every model-selection query against validation/test/audit data.

### 7. The Plan Is Too Classifier-Centric

PDF tagging is not merely classification. It includes structured prediction:

- Reading order is relational.
- Table extraction is grid and hierarchy prediction.
- Footnote handling is link prediction.
- Tag building is tree construction.
- Artifact suppression is context-sensitive.

If we optimize isolated block labels, we can get high local F1 and still build a bad tag tree.

Required correction:

- Define task heads explicitly: role classification, object detection, relationship prediction, table-structure prediction, reading-order ranking, and tag-tree validation.
- Evaluate downstream tag quality, not only block classification.
- Add graph-level and tree-level metrics before training.
- Use model outputs as evidence with abstention, not as direct final tags.

### 8. Confidence And Abstention Are Underspecified

The plan mentions calibration, but it needs to be a release blocker. For an accessibility engine, overconfident wrong predictions are worse than uncertainty.

Required correction:

- Calibrate per role and per slice, not just globally.
- Define abstention thresholds for each task.
- Track coverage versus accuracy.
- Require reliability plots and expected calibration error for every release.
- When out-of-distribution or low-confidence, the engine must fall back to deterministic behavior.

### 9. OOD Detection Is Missing From The Runtime Story

A deployed classifier will see PDFs outside the corpus: broken scans, unusual producers, handwritten annotations, agency-specific forms, and hostile content streams.

Required correction:

- Add OOD scoring to the ML prediction contract.
- Use real-anchor and held-out producer families for OOD evaluation.
- Log "unknown document profile" as a normal outcome.
- Never allow ML-assisted tagging to silently operate on a page profile outside its validated envelope.

### 10. Human Audit Is Too Late In The Loop

The plan includes human audit reports, but audit should shape the corpus before massive generation, not only validate after generation.

Required correction:

- Run audit after the first 1,000 cases, before 10,000.
- Run audit after the first 20,000 wave 2 children, before 1,000,000.
- Maintain an ambiguity taxonomy.
- Feed label bugs and ambiguous cases back into the ontology and generator rules.

### 11. Cost And Storage Are Underestimated

One million PDFs plus rendered pages, overlays, manifests, pipeline outputs, and reports can become very large. If average materialized artifact size is even 2 MB, the suite becomes multiple terabytes before logs and model artifacts.

Required correction:

- Decide which artifacts are always materialized and which are lazy.
- Keep a small CI subset, a medium nightly subset, and a full scheduled corpus.
- Use shard manifests and content-addressed storage.
- Budget runtime, disk, memory, and cloud cost before generation.

### 12. Integration Debt Is A Real Product Risk

Hidden Technical Debt in ML Systems applies directly. If model predictions leak into deterministic modules without clear boundaries, debugging will become difficult.

Required correction:

- Keep ML as a separate CLI with explicit input and output contracts.
- Run shadow mode first.
- Store per-node decision logs: deterministic evidence, ML evidence, final decision, fallback reason.
- Make default behavior deterministic-only until release gates are met.
- Define an emergency disable flag and model version pinning.

## Revised Go/No-Go Gates

Do not start bulk model training until all of these are true:

- The task ontology is frozen for the first training wave.
- Footnote, endnote, caption, figure, form, aside, and artifact representation is settled or explicitly scoped out.
- A dataset datasheet draft exists.
- A model card template exists.
- Leakage scanners exist for template, text, table schema, asset, producer, and split inheritance.
- At least 1,000 wave 1 PDFs and 20,000 wave 2 children have passed verification and human audit sampling.
- At least one real-anchor corpus exists and has baseline deterministic metrics.
- Every training label has a label confidence tier.
- Every planned model output has a contract path or an explicit "research only" tag.

Do not enable ML-assisted production output until all of these are true:

- Shadow-mode reports show improvement on weak deterministic slices.
- Strong deterministic slices do not regress.
- Calibration passes per task and per critical slice.
- OOD behavior is measured and conservative.
- Locked audit and real-anchor metrics pass.
- Validator impact is non-negative.
- Runtime and memory budgets pass.
- Rollback path is tested.

## Concrete Amendments To The Existing Plan

1. Add a `dataset-datasheet.md` deliverable before the 10,000-PDF pilot.
2. Add a `model-card-template.md` deliverable before baseline model training.
3. Add a real-anchor corpus phase before the full 100,000 synthetic corpus is treated as training-ready.
4. Add label confidence tiers to the truth manifest.
5. Add oracle confidence to wave 2 transforms.
6. Add template-holdout, transform-holdout, producer-holdout, and text-source-holdout splits.
7. Add leakage scanners before training.
8. Add OOD and abstention fields to the planned ML prediction contract.
9. Add parent-clustered metrics as primary wave 2 metrics.
10. Add shadow-mode integration before any ML-assisted tag changes.

## Strongest Version Of The Plan

The strongest version is not "generate 1,100,000 PDFs and train a classifier."

The strongest version is:

1. Define a precise tagging ontology.
2. Generate truth-bearing cases with full lineage.
3. Verify that the rendered and extracted PDFs match the truth.
4. Use wave 2 to create controlled local perturbations and counterfactuals.
5. Anchor everything against real PDFs.
6. Measure leakage, calibration, OOD, and downstream tag quality.
7. Integrate ML only as explicit evidence behind a contract and fallback.

That version is slower, but it is much more likely to produce a classifier that makes the engine more robust instead of merely more complicated.
