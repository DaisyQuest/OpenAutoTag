# Research Notes

This planning pass uses document AI, synthetic-data, and model-evaluation literature as guardrails. The aim is not to copy any one dataset, but to adopt patterns that have survived scrutiny: diverse layouts, complete ground truth, diagnostic factor coverage, independent evaluation, and calibrated confidence.

## Document Layout Datasets

DocLayNet is the strongest warning against a narrow corpus. Its authors report that models trained on scientific-only datasets drop on more diverse layouts, and they created a manually annotated corpus across varied document sources with layout boxes and class labels. For OpenAutoTag, that means the 100,000-PDF corpus must include legal, government, forms, reports, academic, multilingual, tables, scans, and adversarial near-misses, not only article-like pages.

Reference: https://arxiv.org/abs/2206.01062

PubLayNet shows the value of large-scale weak or automatic annotation from source documents. It uses XML and PDF alignment at scale for document layout training. For OpenAutoTag, generated PDFs should keep their authoring source, construction graph, and rendered output tied together so labels are not inferred after the fact.

Reference: https://arxiv.org/abs/1908.07836

## Tables

PubTables-1M is directly relevant because it emphasizes complete and unambiguous table ground truth, including headers and locations, and it addresses inconsistent oversegmentation. For OpenAutoTag, table labels must include cell grid structure, functional role, header scope, row and column spans, and canonicalized cell ownership, especially for sparse and borderless tables.

Reference: https://arxiv.org/abs/2110.00061

TableBank shows that weak supervision from authoring formats can scale table detection and recognition. For this repo, that supports a generator design where the source layout DSL, not the PDF extraction result, is the primary truth source.

Reference: https://arxiv.org/abs/1903.01949

## Noisy Scans And Forms

FUNSD focuses on noisy scanned forms and includes text, layout, entity labels, and relationships. The lesson is that noise is not just a visual effect. It changes OCR quality, bounding-box quality, linking quality, and relation extraction. Our corpus should represent both born-digital PDFs and rendered-then-reassembled PDFs with controlled OCR and scan degradation.

Reference: https://arxiv.org/abs/1905.13538

RVL-CDIP is a document image classification reference point with hundreds of thousands of grayscale document images and 16 document classes. It is useful as scale context and as a reminder that document-level type can be a separate signal from block-level tagging.

Reference: https://paperswithcode.com/dataset/rvl-cdip

## Synthetic Generation

SynthDoG, described with Donut, supports the idea that synthetic document generation can help pretraining across languages and domains. The important lesson for OpenAutoTag is to keep synthetic data structured and varied enough that models learn layout behavior, not accidental fixture style.

Reference: https://arxiv.org/abs/2111.15664

Domain randomization argues that simulation can transfer better when the simulator varies enough that real cases become another variation. For PDFs, this maps to controlled variation in fonts, margins, columns, compression, scan noise, stamps, table rules, note placement, and producer quirks.

Reference: https://arxiv.org/abs/1703.06907

CLEVR is useful even though it is not a PDF dataset. It demonstrates diagnostic synthetic generation with known scene graphs and factor-controlled tests. Our PDF corpus should follow that spirit: every document should have a construction graph, every label should be grounded, and evaluation should expose which reasoning or layout factors failed.

Reference: https://arxiv.org/abs/1612.06890

## Model Architecture Direction

LayoutLM demonstrates that text alone is insufficient for visually rich documents; text, layout coordinates, and visual features should be modeled together. OpenAutoTag should start with simple baselines, but the planned data representation should not prevent multimodal models later.

Reference: https://arxiv.org/abs/1912.13318

DiT shows that document-image pretraining can be useful across document classification, layout analysis, table detection, and text detection. That supports keeping page images and overlays as first-class corpus artifacts, not only JSON text blocks.

Reference: https://arxiv.org/abs/2203.02378

## Evaluation And Confidence

DocLayNet reports mAP baselines and inter-annotator agreement, which is a useful reminder that object-detection-style metrics and human agreement should both be visible.

Reference: https://arxiv.org/abs/2206.01062

Guo et al. show that modern neural networks can be poorly calibrated and that post-training calibration can matter. For OpenAutoTag, every classifier report should include calibration metrics, not just accuracy.

Reference: https://arxiv.org/abs/1706.04599

## Direct Implications For OpenAutoTag

1. Do not build one monolithic "tagging classifier" first. Start with role, table, note, artifact, and ordering tasks.
2. Do not trust synthetic labels by construction alone. Run independent PDF, render, OCR, and pipeline probes.
3. Do not let class imbalance hide failure. Report every role and every difficult slice separately.
4. Do not let confidence steer production until calibration and abstention behavior are measured.
5. Do not evaluate only on synthetic data. Keep a real-PDF anchor suite for distribution drift and false confidence.
