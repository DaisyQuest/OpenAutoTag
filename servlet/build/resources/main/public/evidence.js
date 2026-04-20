// Source-link injection: adds "View Source" GitHub links to each section
(function() {
  const REPO = "https://github.com/DaisyQuest/OpenAutoTag/blob/main";
  const sourceMap = {
    "conformance-claims": [
      { label: "Profile schema (PDF/UA fields)",   path: "contracts/profile.schema.json", line: 1 },
      { label: "Validator (veraPDF integration)",   path: "modules/validator/index.js", line: 305 },
      { label: "Font audit (8 finding codes)",      path: "modules/validator/java/FontAuditCli.java", line: 1 },
      { label: "TH Scope guarantee",               path: "modules/pdf-writer/index.js", line: 160 }
    ],
    "validation-methodology": [
      { label: "CI test runner",                    path: "scripts/run-ci-tests.js", line: 1 },
      { label: "veraPDF invocation + resilience",   path: "modules/validator/index.js", line: 305 },
      { label: "Font audit pre-pass",              path: "modules/validator/index.js", line: 368 },
      { label: "Report parsing + task exception",   path: "modules/validator/index.js", line: 265 }
    ],
    "corpus-results": [
      { label: "Font embedder (24-check analysis)", path: "modules/font-embedder/index.js", line: 129 },
      { label: "Font analysis engine",              path: "modules/font-embedder/lib/analyze.js", line: 140 },
      { label: "Text-structure merge",              path: "modules/paragraph-merger/lib/text-structure-merge.js", line: 66 },
      { label: "Post-merge validators (5 checks)",  path: "modules/paragraph-merger/lib/validators.js", line: 41 },
      { label: "Corpus validation runner",          path: "modules/paragraph-merger/validate-corpus.js", line: 1 },
      { label: "Borderless table detection",        path: "modules/layout-analyzer/index.js", line: 505 },
      { label: "Cross-page table continuation",     path: "modules/semantic-engine/index.js", line: 59 },
      { label: "Native operator parser",            path: "modules/pdf-writer/java/NativeContentStreamParser.java", line: 28 },
      { label: "Native tag matcher",                path: "modules/pdf-writer/java/NativeTagMatcher.java", line: 20 },
      { label: "Line-group epsilon (RTL fix)",      path: "modules/reading-order/index.js", line: 150 },
      { label: "9-version tournament evaluator",    path: "modules/paragraph-merger/evaluator.js", line: 1 }
    ],
    "known-limitations": [
      { label: "Auto-selector decision tree",       path: "modules/paragraph-merger/lib/auto-selector.js", line: 1 },
      { label: "Native match threshold",            path: "contracts/profile.schema.json", line: 385 }
    ],
    "continuous-improvement": [
      { label: "Profile registry (6 presets)",      path: "orchestrator/profile-registry.js", line: 72 },
      { label: "MCP introspection (16 tools)",      path: "modules/mcp-api-introspect/index.js", line: 1 },
      { label: "MCP corpus eval (4 tools)",         path: "modules/mcp-corpus-eval/index.js", line: 1 },
      { label: "Font health (24 checks)",           path: "modules/corruption-repairer/java/FontRepairCli.java", line: 59 }
    ]
  };

  for (const [sectionId, links] of Object.entries(sourceMap)) {
    const section = document.getElementById(sectionId);
    if (!section) continue;
    const container = document.createElement("div");
    container.className = "source-links";
    container.innerHTML = '<span class="source-links-label">\u{1F4C2} View Source:</span> ' +
      links.map(l => `<a href="${REPO}/${l.path}#L${l.line}" target="_blank" rel="noopener" title="${l.path}:${l.line}">${l.label}</a>`).join(" &middot; ");
    const heading = section.querySelector("h2, h3");
    if (heading) heading.after(container);
    else section.prepend(container);
  }
})();
