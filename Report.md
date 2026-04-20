I’m separating the PDF tag vocabulary from the software behaviors that auto-generate it, using standards and vendor documentation to map taggable elements, typical detection heuristics, and where native tagging falls short.

I’ve pinned down the element inventory, including the PDF 1.7 set and PDF 2.0 additions. Next I’m detailing native export from source semantics versus Acrobat-style post-processing, especially for annotations, forms, tables, and review-prone cases.

I’ve confirmed “native automatic tagging” is not a formal ISO/PDF term. I’m framing the answer around three distinct workflows: born-tagged export, in-PDF auto-tagging afterward, and Acrobat’s temporary read-time tagging for untagged files.

Thought for 28m 2s
Native automatic PDF accessibility tagging

I’m using “native automatic PDF accessibility tagging” to mean automatic creation of a Tagged PDF structure by the producing system itself, rather than hand-building the tag tree. In practice that happens in two very different ways: semantic export from a source document that already knows what content is a heading, list, table, figure, footnote, etc.; and inference-based auto-tagging of an already-finished PDF, where software analyzes page layout, reading order, and annotations to reconstruct semantics after the fact. Adobe explicitly distinguishes these paths and says export-time tagging from an authoring application is the best route because the source app can use paragraph styles and structural information directly.

1) What the PDF tag system actually is

A tagged PDF stores logical structure separately from visual page appearance. The PDF has a structure tree rooted at StructTreeRoot; the root’s K entry points to the top-level structure element(s), and in tagged PDF that root child must be a Document structure element. Structure is therefore independent of the raw drawing order on the page, which is why tagged PDFs can support reflow, navigation, and assistive technology. The PDF Association cheat sheets and W3C both describe this separation explicitly.

At the low level, each structure element has an S key naming the structure type, a P key for the parent, and a K key for children or content items. Those children can be other structure elements, marked-content identifiers, marked-content reference dictionaries, or object references such as annotations and form widgets. Structure elements can also carry important accessibility properties such as Alt (alternate description), ActualText (exact replacement text), E (expanded form for abbreviations), Lang (language), T (human-readable title), and Ref (references to related structure). PDF 2.0 also adds namespaces, and PDFs can use RoleMap to map custom tags to standard ones.

Tagged PDF is not just about naming things; it is also about semantics plus reading order. The PDF Association’s best-practice guidance summarizes the core rule this way: content should be marked in the structure tree with semantically appropriate tags in a logical reading order. It also notes examples of what that means in practice: list bullets belong in Lbl, complex table headers may need Scope or header relationships, footnote references need explicit semantics, and soft line breaks do not create a new block element.

One more boundary matters: standard tags are finite, but custom tags are not. PDF allows custom structure types, but for accessible processing they should be role-mapped to semantically appropriate standard types. NonStruct is specifically useful when a custom wrapper has no real semantics of its own and only its descendants matter.

2) The complete standard tag inventory

The most complete practical inventory is the union of the standard structure types defined across PDF 1.7 and PDF 2.0, plus PDF 2.0 namespace handling and MathML support. PDF Association’s 2024 cheat sheet lists the full sets and the differences between them.

A. Document and grouping tags

These are the tags that define the overall document organization.

Document: the logical document root. Every tagged PDF starts here under StructTreeRoot.
DocumentFragment: a logical document fragment extracted from another document; intended when the author wants to preserve the fact that content originated elsewhere.
Part: a grouping of structure elements without hierarchy in PDF 2.0; WTPDF treats it as a grouping whose semantic purpose is unrelated to heading hierarchy.
Sect: a hierarchical section grouping; when a heading applies to an entire section, the heading belongs inside that Sect.
Div: a generic or orthogonal grouping. In PDF 2.0 it is explicitly described as grouping orthogonal to the document’s semantic structure.
Aside: content outside the main flow, such as side notes or advertising sidebars.
Art: an article; a relatively self-contained narrative or exposition, especially useful when a larger document contains multiple articles.
TOC and TOCI: table of contents and table-of-contents item. These exist in the PDF 1.7 namespace, are not in the PDF 2.0 standard namespace, but WTPDF still requires TOCs to use TOC and TOCI as defined via ISO/TS 32005.
Index: a sequence of entries containing identifying text accompanied by references.
NonStruct: grouping with no inherent semantics; often used as a role-map target for custom types with no semantic significance.
Private: private application content in PDF 1.7. PDF 2.0 introduced Artifact as a suggested mapping target for some cases instead.
B. Headings, titles, paragraphs, quotations, notes

These are the main block-text and structural-text tags.

H: generic heading whose level is inferred from nesting depth. It exists, but WTPDF says conforming files should use explicit H1–Hn and not H.
H1–H6 / Hn: explicit heading levels. PDF 1.7 limits numbered headings to 1–6; PDF 2.0 allows Hn where n ≥ 1.
Title: the title of a document in the structure tree. WTPDF says titles should be tagged as Title, not as headings. This is distinct from PDF metadata /Title, which is also important for accessibility.
P: paragraph. WTPDF says use P for semantic paragraphs, and not for arbitrary text fragments that are not really paragraphs.
BlockQuote: one or more paragraphs quoted from another source.
Quote: inline quoted content from another source; WTPDF distinguishes this from BlockQuote.
Caption: caption text. PDF 2.0 broadens its use beyond tables/lists/figures, and the PDF Association cheat sheet notes it must be the first or last child in the semantic parent element.
Note: explanatory note such as a footnote or endnote in PDF 1.7.
FENote: PDF 2.0 footnote/endnote structure type. WTPDF says FENote effectively replaces Note for footnotes and endnotes and can carry a NoteType attribute of Footnote, Endnote, or None.
Sub: semantic subdivision within a block-level element.
C. List tags

Lists are represented by a small but strict family.

L: list. In PDF 1.7 it is block-only; in PDF 2.0 it can be block or inline.
LI: list item.
Lbl: the bullet, number, or other label distinguishing one item from another. WTPDF stresses that real content functioning as a label belongs in Lbl.
LBody: the body/content of the list item.
D. Table tags

Tables use a standard family describing row groups, rows, and cells.

Table: the 2D logical structure of table cells in table rows.
THead / Thead: header row group. PDF Association’s PDF 1.7 listing uses THead, while its PDF 2.0 page shows Thead; Microsoft’s exporter documentation still documents THead in actual outputs.
TBody: body row group.
TFoot: footer row group.
TR: table row.
TH: header cell. The best-practice guide notes that if header relationships are not otherwise defined with Header/ID, Scope is needed.
TD: data cell.
E. Inline semantics, references, annotations, forms

These tags attach semantics to inline content, citations, links, and interactive objects.

Span: generic inline content with no inherent semantics. WTPDF says use it only when no more semantically appropriate inline type exists and the attributes do not apply to the parent.
Em: emphasis.
Strong: strong importance, seriousness, or urgency.
Code: fragment of computer code.
BibEntry: bibliographic entry for cited material.
Reference: a reference to content elsewhere, especially intra-document targets in WTPDF.
Link: the structure element associated with a link annotation and its content. W3C notes that link text is the accessible name source for assistive tech.
Annot: annotations other than link and widget annotations.
Form: widget annotations / interactive form fields and associated content.
F. Figures, formulas, and math
Figure: graphical content. PDF 1.7 and PDF 2.0 both define it broadly as an item of or enclosure for graphical content.
Formula: mathematical formula.
math: MathML structure elements in the MathML namespace in PDF 2.0. PDF 2.0 added explicit MathML support.
G. Ruby / Warichu tags

These support East Asian annotation systems.

Ruby, RB, RT, RP: ruby assembly, ruby base, ruby text, ruby punctuation. WTPDF explains Ruby is for glosses/phonetic aids and that omitted overlapping characters can require ActualText on RT.
Warichu, WT, WP: warichu assembly, warichu text, warichu punctuation.
H. Artifact / non-content
Artifact: layout content that is not “real content,” such as page numbers, decorative borders, or some table borders. PDF 2.0 defines Artifact as a standard structure type, and PDF also supports artifact marking at the marked-content level in content streams. Best-practice guidance stresses that artifacts must be clearly distinguished from real content.
3) Important properties and attribute systems that matter just as much as tags

Automatic tagging is not only about choosing the right structure element; it also depends on attaching the right properties.

Alt provides alternate descriptions for images, formulas, and other non-text items. W3C says this is normally done in authoring tools.
ActualText provides exact replacement text, useful for OCR gaps, glyph substitutions, drop caps, images of words, or other content whose visible encoding is not the text that should be read aloud or copied.
E provides an expanded form for abbreviations and acronyms; W3C’s PDF8 says this is normally accomplished with an authoring tool and is often applied on a Span.
Lang marks document-level or passage-level language, including inline spans where language changes.
Ref links related structure, such as TOC items to destinations or footnote references to footnotes/endnotes.

PDF also defines attribute owners for different semantic layers: Layout, List, Table, PrintField, UserProperties, and in PDF 2.0 additional translation-oriented owners such as ARIA-1.1, HTML-5.00, CSS-3, RDFa-1.10, Artifact, and NSO. These are not structure types themselves, but they are part of how high-quality tagging is expressed.

4) How automatic tagging is actually accomplished
   A. Best case: semantic export from the source document

This is the strongest form of “native automatic tagging.” Adobe states plainly that tagging during conversion is preferable because the authoring application can use its own structural knowledge—paragraph styles, table structures, alt text, links, bookmarks, and other document features—to generate a more accurate logical structure tree and reading order than Acrobat can infer later from finished page geometry. W3C’s PDF techniques say the same thing for headings, lists, tables, links, titles, and image alt text: these are typically easiest and best created in the authoring tool before PDF conversion.

Microsoft Word

Microsoft publishes explicit export mappings for Word. Its PDF exporter maps the document root to Document; headings to H1, H2, etc.; quote styles to BlockQuote or inline Quote; captions to Caption; lists to L / LI / Lbl / LBody; nested lists inside LBody; tables to Table, THead, TBody, TH, and TD; images with alt text to Figure; hyperlinks to Link; language changes to Span with Lang; and equations to Formula with an MSFT_MathML attribute. Word also artifacts headers/footers, decorative graphics, bullets rendered as images, and similar layout content. Microsoft’s newer ExportAsFixedFormat3 API adds an ImproveExportTagging option for footnotes/endnotes, block quotes, inline quotes, captions, title, comments, equations, layout tables, and content spanning pages.

Word’s documentation also shows a good example of the difference between standard and producer-specific tagging: it documents comments using a CommentAnchor container with Span and Annot. PDF allows such custom or private structures, but interoperable accessibility depends on their relationship to the standard model through semantics and role mapping.

Microsoft Excel

Excel’s exporter maps workbooks and cell ranges into table-oriented structures. It documents Document, Table, TR, TD, TH, THead, and TBody; graphical objects to Figure; equations to Formula; text-bearing shapes without alt text to Sect; and hyperlinks on cells or objects to Link. It also artifacts layout-only content such as grid lines, cell borders, cell shading, and decorative graphics.

Microsoft PowerPoint

PowerPoint documents the presentation as Document, slides as Sect, title placeholders as H1 or H2, paragraphs as P, lists as L / LI / Lbl / LBody, tables as Table / THead / TBody / TFoot / TH / TD, objects with alt text as Figure, equations as Formula, and hyperlinks as Link. It also uses TOC / TOCI for Summary Zoom, Section Zoom, and Slide Zoom, and creates bookmarks from section names and slide titles. Objects from Slide Master view are generally not tagged except for hyperlinks, and decorative objects are artifacted.

Office-wide improvements

Microsoft’s Office 2024 / Microsoft 365 accessibility documentation says PDF accessibility is “greatly improved” in current releases, including broader Figure coverage, better SmartArt/group handling, Formula for equations, improved alt text composition, THead / TFoot / Scope handling, and other exporter changes.

Adobe InDesign

InDesign supports automatic tagged export with Create Tagged PDF. Adobe says this automatically tags content such as headlines, stories, and figures; the Structure pane lets authors reorder tagged content; Add Untagged Items automatically applies Story/Figure tags to untagged frames and graphics; the Articles panel precisely controls what gets tagged and in what order; and alt text / ActualText can be attached before export. Adobe’s accessibility guidance for InDesign also recommends anchoring images into the text flow, adding export tagging instructions to styles, using object export options for alt text, establishing reading order with the Articles panel, and adding bookmarks, cross-references, and hyperlinks before export.

LibreOffice

LibreOffice’s Universal Accessibility (PDF/UA) export creates a PDF/UA-oriented PDF, automatically enables Tagged PDF, and checks a set of source-document conditions before export, including title, language, alt text/title on graphics and OLE objects, prohibition of split/merged table cells, integrated numbering rather than manual numbering, presence of hyperlink text, contrast, no blinking text, no footnotes/endnotes, and sequential heading levels. LibreOffice also exposes a pre-export accessibility check.

LaTeX

The LaTeX project’s tagged PDF work is another example of native automatic tagging from a source format. The project says it now provides examples conforming to PDF/UA-1 and WTPDF/PDF/UA-2, guidance for producing accessible PDF, and compatibility tables for packages and classes. LaTeX’s \DocumentMetadata command must appear before \documentclass; project updates describe automatic tagging support for sectioning, figures, table listings, floats, citations, bibliographies, and more, and the project reports that a subset of LaTeX documents can now automatically generate PDF/UA-2 / WTPDF-compliant output.

B. Inference-based tagging of existing PDFs

When the source document is unavailable, the software has to infer semantics from the finished PDF. Adobe says Acrobat’s “Automatically tag PDF” command analyzes the PDF to interpret page elements, their hierarchical structure, and intended reading order, then builds a tag tree and creates tags for links, cross-references, and bookmarks added in Acrobat. Adobe also says this works reasonably for standard layouts but can fail on closely spaced columns, irregular alignment, non-fillable form fields, and borderless tables, and can misclassify decorative borders or graphical characters as figures. Adobe recommends evaluating and repairing the result afterward.

Acrobat’s newer cloud-based auto-tagging adds stronger layout inference for eligible files. Adobe says it can identify heading levels, detect borderless tables, detect lists and nested lists, and establish reading order for multicolumn layouts. It also says the PDF is not saved on the cloud, and that Acrobat falls back to local tagging if the document is not suitable for the cloud workflow.

Adobe’s PDF Accessibility Auto-Tag API makes the same idea available programmatically. Adobe documents it as a first step that can generate a tagged PDF and optional XLSX report, can replace existing tags, improves heading levels, reading order, complex lists, links, references, and tables, and performs language identification for each paragraph. Adobe also states that the output is not guaranteed to meet WCAG or PDF/UA without further review, and specifically says figures need alt text added and complex tables need review. Adobe further notes that the service is optimized for English, OCR is configured for English, XFA/fillable form elements are unsupported, and scan quality or CAD/vector-art-like PDFs can reduce output quality.

A reasonable inference from Adobe’s public docs is that inference-based auto-tagging uses a pipeline roughly like this: text extraction or OCR, page segmentation, reading-order inference, element classification (heading, paragraph, list, table, figure, footnote, etc.), relationship inference (nesting, labels, header cells, links), and structure-tree construction. Adobe does not publish the full algorithm, but its Extract API says Sensei AI can extract contextual text blocks such as paragraphs, headings, lists, and footnotes, along with tables including cell structure and spans, figures, and natural reading order from native or scanned PDFs, which strongly supports that reconstruction model.

C. OCR-first tagging for scanned PDFs

Scanned PDFs are a separate case because they often contain images of text, not usable text. W3C says that when the source file is unavailable, scanned images of text can be converted using OCR and then Acrobat can be used to create accessible text. Adobe’s auto-tagging products likewise state that they can work on scanned PDFs, but warn that skew, shadows, obscured or overlapping fonts, and resolution under 200 DPI lower quality.

ActualText is especially important here. It is the mechanism for supplying the exact text replacement for content whose visible encoding is not trustworthy or not text at all. The PDF Association’s guidance and the PDF/UA-1 vs PDF/UA-2 image-tagging discussion both show it being used to repair OCR gaps or image-encoded words.

5) What auto-taggers usually map, and how

Below is the practical mapping model most native auto-taggers follow.

Document/container semantics come from the source model or inferred hierarchy: document root, sections, articles, sidebars, TOCs, and fragments become Document, Sect, Art, Aside, TOC, TOCI, or DocumentFragment.
Heading semantics usually come from source styles or detected typography. W3C describes heading tags as H, H1–H6; PDF 2.0 generalizes that to Hn; WTPDF prefers explicit numbered headings rather than generic H.
Titles should be distinguished from headings. In the structure tree they are Title; in document metadata they are /Title plus viewer behavior to display the title. These are related but not the same thing.
Paragraphs, quotations, captions, and notes come from source paragraph styles or block classification and become P, BlockQuote, Quote, Caption, Note, or FENote.
Lists are best created from true list constructs in the source. W3C says the easiest path is proper list markup in the authoring tool. Exporters then map list containers to L, items to LI, bullets/numbers to Lbl, and item text to LBody; nested lists go inside LBody.
Tables are best created from real table objects, not visual alignment. W3C says table markup is typically accomplished in the authoring tool. Exporters and auto-taggers map tables to Table, row groups to THead/Thead, TBody, TFoot, rows to TR, and cells to TH or TD. For more complex tables, header relationships may also need Scope, ID, or Headers relationships.
Links and references come from hyperlink objects or annotation analysis. W3C says the simplest path is to create them in the source document before PDF conversion. In tagged PDF they become Link or, for intra-document targets, often Reference; object references (OBJR) tie the structure to the annotation.
Figures and non-text objects typically become Figure, with Alt when they need an accessible description. W3C says /Alt is normally set through authoring tools.
Mathematics can be tagged as Formula, and in PDF 2.0 may also be represented through math in the MathML namespace. Word’s exporter documents Formula plus a MathML attribute for equations.
Language changes come from document metadata or character/run properties and become Lang on the document, paragraph, or Span. Adobe’s Auto-Tag API also documents per-paragraph language identification.
Abbreviations and glyph substitutions use E and ActualText, often on Span, so the assistive-technology text stream is correct even when the visible glyph stream is not.
Forms are tagged as Form and rely on proper control names, roles, values, labels, descriptions/tooltips, and tab order. Acrobat’s workflow specifically supports auto-detecting form fields and setting descriptions that screen readers announce.
Decorative or layout-only content should become Artifact, not semantic content. PDF best-practice guidance specifically calls out page numbers, headers/footers, decorative borders, and similar layout items as artifacts rather than real content.
6) A major PDF/UA nuance: the same visible object may need different tags

One of the most important newer developments is that PDF/UA-2 is more semantic than PDF/UA-1. PDF/UA-1 generally required tagged images to be inside Figure tags, while PDF/UA-2 requires the most semantically appropriate tag regardless of encoding. That means an image that functions as a paragraph should be tagged P; an image used as a word inside a sentence may be tagged Span with ActualText; an image used as a list bullet should be Lbl; and mathematical content should be Formula. This is crucial because automatic tagging is not merely object detection; it is semantic classification.

7) Where native automatic tagging still usually needs human review

Even the best automation still has predictable weak spots. Adobe explicitly says human review is still needed for reading order, tagging problems, and accessibility errors after auto-tagging. Common failure points include: close columns, irregular alignment, borderless or complex tables, distinguishing decorative from informative graphics, drop caps or graphical characters, form labels/tab order, low-quality scans, and nonstandard content such as XFA forms or vector-art/CAD-like PDFs.

So the practical quality order is usually:

Best: export from a structurally rich source file with good accessibility practices already in place.
Second-best: inference-based auto-tagging on a born-digital PDF.
Weakest: OCR plus inference on a scan.
Bottom line

The concept is best understood as automatic construction of the PDF structure tree, using either known source semantics or heuristic reconstruction. The fully standard tag universe is the set of PDF 1.7 and PDF 2.0 structure types listed above, plus custom role-mapped types and accessibility properties like Alt, ActualText, Lang, E, Ref, and table/list/layout attributes. In mature workflows, “native automatic tagging” is really a serialization problem: the exporter maps a document model into Document, Sect, Hn, P, L, Table, Link, Figure, Formula, Artifact, and related structures. In remediation workflows, it is a reconstruction problem: the tool infers those same structures from page geometry, OCR, annotations, and layout cues, then a human finishes the edge cases.

A useful next artifact would be a crosswalk matrix showing each tag, its PDF 1.7/PDF 2.0 status, typical source-document trigger, common auto-tagging heuristic, and common remediation issues.