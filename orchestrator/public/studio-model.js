export const defaultStudioHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Accessible Project Brief</title>
    <meta name="author" content="Perfect Studio">
    <meta name="subject" content="PDF/UA-native document authored from semantic HTML">
  </head>
  <body>
    <header data-artifact="true">
      <p>Perfect Studio</p>
    </header>
    <main>
      <h1>Accessible Project Brief</h1>
      <section aria-labelledby="summary-heading">
        <h2 id="summary-heading">Summary</h2>
        <p>This document starts with semantic HTML so the exported PDF can inherit a complete structure tree, language, reading order, and metadata.</p>
      </section>
      <section aria-labelledby="milestones-heading">
        <h2 id="milestones-heading">Milestones</h2>
        <ol>
          <li>Define the document purpose and audience.</li>
          <li>Author sections, tables, figures, links, and forms as semantic elements.</li>
          <li>Validate the source before publishing.</li>
        </ol>
      </section>
      <section aria-labelledby="table-heading">
        <h2 id="table-heading">Release Checklist</h2>
        <table>
          <caption>PDF/UA authoring checks by phase</caption>
          <thead>
            <tr>
              <th scope="col">Phase</th>
              <th scope="col">Required evidence</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Author</th>
              <td>Headings, lists, table headers, and link purpose are present in source HTML.</td>
            </tr>
            <tr>
              <th scope="row">Publish</th>
              <td>Tagged PDF, XMP metadata, language, and validation report are generated together.</td>
            </tr>
          </tbody>
        </table>
      </section>
      <figure>
        <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='240' viewBox='0 0 640 240'%3E%3Crect width='640' height='240' fill='%23edf7f5'/%3E%3Cpath d='M80 168h120l80-96 80 120 68-64 132 40' fill='none' stroke='%230a6b66' stroke-width='16' stroke-linecap='round' stroke-linejoin='round'/%3E%3Ccircle cx='280' cy='72' r='18' fill='%23ca6b2f'/%3E%3C/svg%3E" alt="Line chart showing document quality rising across authoring, validation, and publishing phases.">
        <figcaption>Semantic authoring allows the visual document and accessibility tree to evolve together.</figcaption>
      </figure>
      <p>Read the <a href="https://pdfa.org/resource/pdfua-1/">PDF/UA specification overview</a> before publishing regulated documents.</p>
    </main>
    <footer data-artifact="true">
      <p>Page footer</p>
    </footer>
  </body>
</html>`;

export const studioTemplates = [
  {
    id: "brief",
    label: "Project Brief",
    source: defaultStudioHtml
  },
  {
    id: "report",
    label: "Compliance Report",
    source: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Quarterly Accessibility Report</title>
    <meta name="author" content="Perfect Studio">
    <meta name="subject" content="Accessible compliance report">
  </head>
  <body>
    <main>
      <h1>Quarterly Accessibility Report</h1>
      <section aria-labelledby="overview">
        <h2 id="overview">Overview</h2>
        <p>The report is authored as structured HTML and prepared for tagged PDF publishing.</p>
      </section>
      <section aria-labelledby="findings">
        <h2 id="findings">Findings</h2>
        <ul>
          <li>PDF/UA authoring rules are validated before export.</li>
          <li>Tables use header cells, scopes, and captions.</li>
          <li>Figures carry meaningful alternate text.</li>
        </ul>
      </section>
      <section aria-labelledby="metrics">
        <h2 id="metrics">Metrics</h2>
        <table>
          <caption>Accessibility quality trend</caption>
          <thead>
            <tr>
              <th scope="col">Quarter</th>
              <th scope="col">Documents shipped</th>
              <th scope="col">PDF/UA pass rate</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Q1</th>
              <td>28</td>
              <td>92%</td>
            </tr>
            <tr>
              <th scope="row">Q2</th>
              <td>36</td>
              <td>98%</td>
            </tr>
          </tbody>
        </table>
      </section>
    </main>
  </body>
</html>`
  },
  {
    id: "form",
    label: "Accessible Form",
    source: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Accessible Intake Form</title>
    <meta name="author" content="Perfect Studio">
    <meta name="subject" content="PDF/UA-ready form">
  </head>
  <body>
    <main>
      <h1>Accessible Intake Form</h1>
      <section aria-labelledby="contact">
        <h2 id="contact">Contact Details</h2>
        <form>
          <p>
            <label for="full-name">Full name</label>
            <input id="full-name" name="full-name" type="text">
          </p>
          <p>
            <label for="email">Email address</label>
            <input id="email" name="email" type="email">
          </p>
          <p>
            <label for="request-type">Request type</label>
            <select id="request-type" name="request-type">
              <option>Document creation</option>
              <option>Remediation review</option>
            </select>
          </p>
        </form>
      </section>
    </main>
  </body>
</html>`
  }
];

export const studioSnippets = [
  {
    id: "section",
    label: "Section",
    source: `\n<section aria-labelledby="new-section-heading">\n  <h2 id="new-section-heading">New Section</h2>\n  <p>Write the section content here.</p>\n</section>`
  },
  {
    id: "figure",
    label: "Figure",
    source: `\n<figure>\n  <img src="chart.png" alt="Describe the chart, diagram, or image for readers who cannot see it.">\n  <figcaption>Short visible caption for the figure.</figcaption>\n</figure>`
  },
  {
    id: "table",
    label: "Table",
    source: `\n<table>\n  <caption>Describe what this table compares</caption>\n  <thead>\n    <tr>\n      <th scope="col">Column A</th>\n      <th scope="col">Column B</th>\n    </tr>\n  </thead>\n  <tbody>\n    <tr>\n      <th scope="row">Row label</th>\n      <td>Value</td>\n    </tr>\n  </tbody>\n</table>`
  },
  {
    id: "form-field",
    label: "Form Field",
    source: `\n<p>\n  <label for="field-id">Field label</label>\n  <input id="field-id" name="field-id" type="text">\n</p>`
  },
  {
    id: "artifact",
    label: "Artifact",
    source: `\n<div data-artifact="true" aria-hidden="true">\n  Decorative or repeating page material\n</div>`
  }
];

const genericLinkText = new Set(["click here", "here", "read more", "more", "learn more"]);
const blockTags = new Set([
  "article",
  "aside",
  "blockquote",
  "caption",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul"
]);

function stripTags(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getElements(source, tagName) {
  const tag = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const matches = [];
  let match;

  while ((match = pattern.exec(source)) !== null) {
    matches.push({
      tagName: tagName.toLowerCase(),
      attrs: parseAttributes(match[1] || ""),
      text: stripTags(match[2] || ""),
      innerHtml: match[2] || "",
      raw: match[0],
      index: match.index
    });
  }

  return matches;
}

function getVoidElements(source, tagName) {
  const tag = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<${tag}\\b([^>]*)\\/?>`, "gi");
  const matches = [];
  let match;

  while ((match = pattern.exec(source)) !== null) {
    matches.push({
      tagName: tagName.toLowerCase(),
      attrs: parseAttributes(match[1] || ""),
      text: "",
      innerHtml: "",
      raw: match[0],
      index: match.index
    });
  }

  return matches;
}

function parseAttributes(value) {
  const attrs = {};
  const pattern = /([A-Za-z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;

  while ((match = pattern.exec(String(value || ""))) !== null) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }

  return attrs;
}

function hasAttribute(element, name) {
  return Object.hasOwn(element.attrs, name.toLowerCase());
}

function getAttribute(element, name) {
  return element.attrs[name.toLowerCase()] ?? "";
}

function pushIssue(issues, severity, id, label, detail, action) {
  issues.push({ severity, id, label, detail, action });
}

function countSeverity(issues, severity) {
  return issues.filter((issue) => issue.severity === severity).length;
}

export function validateStudioHtml(source) {
  const html = String(source || "");
  const issues = [];
  const htmlMatch = html.match(/<html\b([^>]*)>/i);
  const htmlAttrs = parseAttributes(htmlMatch?.[1] || "");
  const title = getElements(html, "title")[0]?.text || "";
  const mainCount = getElements(html, "main").length;
  const headings = [1, 2, 3, 4, 5, 6]
    .flatMap((level) => getElements(html, `h${level}`).map((heading) => ({ ...heading, level })))
    .sort((left, right) => left.index - right.index);
  const images = getVoidElements(html, "img");
  const figures = getElements(html, "figure");
  const tables = getElements(html, "table");
  const links = getElements(html, "a");
  const inputs = getVoidElements(html, "input")
    .concat(getElements(html, "select"))
    .concat(getElements(html, "textarea"));
  const labels = getElements(html, "label");

  if (!htmlAttrs.lang || !htmlAttrs.lang.trim()) {
    pushIssue(
      issues,
      "error",
      "document-language",
      "Document language",
      "The root html element does not declare a language.",
      "Add lang to the html element, for example <html lang=\"en\">."
    );
  }

  if (!title.trim()) {
    pushIssue(
      issues,
      "error",
      "document-title",
      "Document title",
      "The document is missing a title element.",
      "Add a concise title in the head so PDF metadata can be generated."
    );
  }

  if (mainCount !== 1) {
    pushIssue(
      issues,
      "error",
      "main-landmark",
      "Main landmark",
      `Expected exactly one main element and found ${mainCount}.`,
      "Keep the primary reading sequence inside a single main element."
    );
  }

  const h1Count = headings.filter((heading) => heading.level === 1).length;
  if (h1Count !== 1) {
    pushIssue(
      issues,
      "error",
      "single-h1",
      "Primary heading",
      `Expected exactly one h1 and found ${h1Count}.`,
      "Use one h1 for the document title and continue with h2 sections."
    );
  }

  let previousLevel = 0;
  for (const heading of headings) {
    if (previousLevel && heading.level > previousLevel + 1) {
      pushIssue(
        issues,
        "error",
        "heading-order",
        "Heading order",
        `${heading.tagName.toUpperCase()} "${heading.text || "(empty)"}" skips from H${previousLevel} to H${heading.level}.`,
        "Do not skip heading levels; insert the missing parent heading or lower this heading level."
      );
    }
    previousLevel = heading.level;
  }

  for (const image of images) {
    const alt = getAttribute(image, "alt");
    const artifact = getAttribute(image, "data-artifact") === "true" || getAttribute(image, "role") === "presentation" || getAttribute(image, "aria-hidden") === "true";
    if (!artifact && !alt.trim()) {
      pushIssue(
        issues,
        "error",
        "image-alt",
        "Image alternate text",
        `Image ${getAttribute(image, "src") || "(inline)"} has no alt text.`,
        "Add meaningful alt text or mark decorative images as artifacts."
      );
    }
  }

  for (const figure of figures) {
    if (!/<figcaption\b/i.test(figure.innerHtml)) {
      pushIssue(
        issues,
        "warning",
        "figure-caption",
        "Figure caption",
        `Figure near character ${figure.index} does not include a figcaption.`,
        "Add a visible caption when the figure needs a published label."
      );
    }
  }

  for (const table of tables) {
    if (!/<caption\b/i.test(table.innerHtml)) {
      pushIssue(
        issues,
        "error",
        "table-caption",
        "Table caption",
        `Table near character ${table.index} has no caption.`,
        "Add a table caption so the PDF structure has a table title."
      );
    }

    if (!/<th\b/i.test(table.innerHtml)) {
      pushIssue(
        issues,
        "error",
        "table-headers",
        "Table headers",
        `Table near character ${table.index} has no th header cells.`,
        "Use th cells with scope or id/header relationships."
      );
    }

    const tableHeaders = getElements(table.raw, "th");
    for (const header of tableHeaders) {
      if (!hasAttribute(header, "scope") && !hasAttribute(header, "id")) {
        pushIssue(
          issues,
          "warning",
          "table-header-scope",
          "Header scope",
          `Header "${header.text || "(empty)"}" has no scope or id.`,
          "Use scope=\"col\" or scope=\"row\" for simple tables."
        );
      }
    }
  }

  for (const link of links) {
    const text = link.text.toLowerCase();
    if (!getAttribute(link, "href").trim()) {
      pushIssue(
        issues,
        "error",
        "link-target",
        "Link target",
        `Link "${link.text || "(empty)"}" has no href.`,
        "Add the destination URL or remove the link."
      );
    }

    if (!link.text.trim() || genericLinkText.has(text)) {
      pushIssue(
        issues,
        "warning",
        "link-purpose",
        "Link purpose",
        `Link text "${link.text || "(empty)"}" is not specific enough.`,
        "Use visible text that names the destination or action."
      );
    }
  }

  const labelTargets = new Set(labels.map((label) => getAttribute(label, "for")).filter(Boolean));
  for (const input of inputs) {
    const type = getAttribute(input, "type").toLowerCase();
    if (type === "hidden" || getAttribute(input, "aria-hidden") === "true") {
      continue;
    }

    const id = getAttribute(input, "id");
    const hasProgrammaticName =
      (id && labelTargets.has(id)) ||
      hasAttribute(input, "aria-label") ||
      hasAttribute(input, "aria-labelledby");

    if (!hasProgrammaticName) {
      pushIssue(
        issues,
        "error",
        "form-label",
        "Form label",
        `${input.tagName} field ${id || "(without id)"} has no programmatic label.`,
        "Add a label with a for/id pair, aria-label, or aria-labelledby."
      );
    }
  }

  if (/\b(order|grid-area)\s*:/i.test(html)) {
    pushIssue(
      issues,
      "warning",
      "css-reading-order",
      "Visual order",
      "The source contains CSS that can separate visual order from DOM order.",
      "Keep the DOM order as the intended PDF reading order."
    );
  }

  if (!/<meta\b[^>]+name=["']author["']/i.test(html)) {
    pushIssue(
      issues,
      "warning",
      "metadata-author",
      "Author metadata",
      "The source does not include author metadata.",
      "Add <meta name=\"author\" content=\"...\"> before publishing."
    );
  }

  if (!/<meta\b[^>]+name=["']subject["']/i.test(html)) {
    pushIssue(
      issues,
      "warning",
      "metadata-subject",
      "Subject metadata",
      "The source does not include subject metadata.",
      "Add <meta name=\"subject\" content=\"...\"> for richer PDF metadata."
    );
  }

  return {
    status: countSeverity(issues, "error") === 0 ? "ready" : "blocked",
    issues,
    summary: {
      errors: countSeverity(issues, "error"),
      warnings: countSeverity(issues, "warning")
    }
  };
}

export function buildStructureModel(source) {
  const html = String(source || "");
  const items = [];

  for (const tagName of blockTags) {
    for (const element of getElements(html, tagName)) {
      const levelMatch = tagName.match(/^h([1-6])$/);
      const label = getStructureLabel(element);

      items.push({
        role: mapTagToPdfRole(tagName, element.attrs),
        tagName,
        level: levelMatch ? Number(levelMatch[1]) : undefined,
        label: label.slice(0, 96),
        artifact: element.attrs["data-artifact"] === "true" || element.attrs["aria-hidden"] === "true",
        index: element.index
      });
    }
  }

  return items.sort((left, right) => left.index - right.index);
}

function getStructureLabel(element) {
  const attrs = element.attrs || {};
  if (attrs["aria-label"]) {
    return attrs["aria-label"];
  }

  if (element.tagName === "section" && attrs["aria-labelledby"]) {
    return attrs["aria-labelledby"];
  }

  if (element.tagName === "table") {
    return getElements(element.raw, "caption")[0]?.text || element.text || "table";
  }

  if (element.tagName === "figure") {
    return getElements(element.raw, "figcaption")[0]?.text || element.text || "figure";
  }

  return element.text || attrs.id || attrs.name || element.tagName;
}

export function summarizeStudioDocument(source) {
  const validation = validateStudioHtml(source);
  const structure = buildStructureModel(source);
  const score = Math.max(0, 100 - validation.summary.errors * 18 - validation.summary.warnings * 6);
  const html = String(source || "");

  return {
    status: validation.status,
    score,
    errorCount: validation.summary.errors,
    warningCount: validation.summary.warnings,
    structureCount: structure.length,
    headingCount: structure.filter((item) => /^H[1-6]$/.test(item.role)).length,
    tableCount: getElements(html, "table").length,
    figureCount: getElements(html, "figure").length,
    formFieldCount: getVoidElements(html, "input").length + getElements(html, "select").length + getElements(html, "textarea").length
  };
}

export function createDownloadHtml(source) {
  const trimmed = String(source || "").trim();
  if (/^<!doctype html>/i.test(trimmed)) {
    return `${trimmed}\n`;
  }

  return `<!doctype html>\n${trimmed}\n`;
}

function mapTagToPdfRole(tagName, attrs) {
  if (attrs["data-artifact"] === "true" || attrs["aria-hidden"] === "true") {
    return "Artifact";
  }

  const heading = tagName.match(/^h([1-6])$/);
  if (heading) {
    return `H${heading[1]}`;
  }

  const roles = {
    article: "Sect",
    aside: "Aside",
    blockquote: "BlockQuote",
    caption: "Caption",
    figcaption: "Caption",
    figure: "Figure",
    footer: "Artifact",
    form: "Form",
    header: "Artifact",
    li: "LI",
    main: "Document",
    nav: "TOC",
    ol: "L",
    p: "P",
    section: "Sect",
    table: "Table",
    tbody: "TBody",
    td: "TD",
    tfoot: "TFoot",
    th: "TH",
    thead: "THead",
    tr: "TR",
    ul: "L"
  };

  return roles[tagName] || "Div";
}
