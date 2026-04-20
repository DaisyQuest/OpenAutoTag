// Scroll-spy: highlights the active ToC link as the user scrolls
(function () {
  const links = document.querySelectorAll('.toc-sidebar a');
  const ids = Array.from(links).map(a => a.getAttribute('href').slice(1));
  const sections = ids.map(id => document.getElementById(id)).filter(Boolean);

  function update() {
    let current = '';
    for (const sec of sections) {
      if (sec.getBoundingClientRect().top <= 80) current = sec.id;
    }
    links.forEach(a => {
      a.classList.toggle('active', a.getAttribute('href') === '#' + current);
    });
  }

  window.addEventListener('scroll', update, { passive: true });
  update();
})();

// Source-link injection: adds "View Source" GitHub links to each section
(function() {
  const REPO = "https://github.com/DaisyQuest/OpenAutoTag/blob/main";
  const sourceMap = {
    "parser":        [
      { label: "Text block grouping",           path: "modules/parser/index.js",                        line: 136 },
      { label: "OCR sparseness thresholds",      path: "modules/parser/index.js",                        line: 224 },
      { label: "Render variants & recognition",  path: "modules/parser/index.js",                        line: 8   }
    ],
    "layout":        [
      { label: "Column gap detection",           path: "modules/layout-analyzer/index.js",               line: 109 },
      { label: "Heading classification",         path: "modules/layout-analyzer/index.js",               line: 143 },
      { label: "Text-grid table detection",      path: "modules/layout-analyzer/index.js",               line: 215 },
      { label: "Borderless table detection",     path: "modules/layout-analyzer/index.js",               line: 505 },
      { label: "Vector header row detection",    path: "modules/layout-analyzer/index.js",               line: 378 }
    ],
    "semantic":      [
      { label: "Role & confidence assignment",   path: "modules/semantic-engine/index.js",               line: 319 },
      { label: "Table continuation logic",       path: "modules/semantic-engine/index.js",               line: 85  },
      { label: "Cross-page column anchor match", path: "modules/semantic-engine/index.js",               line: 59  },
      { label: "Semantic node builder",          path: "modules/semantic-engine/index.js",               line: 343 }
    ],
    "merger":        [
      { label: "Text-structure merge algorithm", path: "modules/paragraph-merger/lib/text-structure-merge.js", line: 66 },
      { label: "Body margin detection",          path: "modules/paragraph-merger/lib/text-structure-merge.js", line: 21 },
      { label: "Median line spacing",            path: "modules/paragraph-merger/lib/text-structure-merge.js", line: 32 },
      { label: "Strategy dispatch",              path: "modules/paragraph-merger/index.js",              line: 290 },
      { label: "Post-merge validators",          path: "modules/paragraph-merger/lib/validators.js",     line: 41  }
    ],
    "reading-order": [
      { label: "Line-group epsilon (6pt)",       path: "modules/reading-order/index.js",                 line: 150 },
      { label: "Compare units sort",             path: "modules/reading-order/index.js",                 line: 152 },
      { label: "Column band detection",          path: "modules/reading-order/index.js",                 line: 74  }
    ],
    "tag-builder":   [
      { label: "Table section normalization",    path: "modules/tag-builder/index.js",                   line: 579 },
      { label: "Irregular table repair",         path: "modules/tag-builder/index.js",                   line: 737 },
      { label: "Header row detection",           path: "modules/tag-builder/index.js",                   line: 459 },
      { label: "Section validation (TD→TH)",     path: "modules/tag-builder/index.js",                   line: 914 },
      { label: "Repeated header detection",      path: "modules/tag-builder/index.js",                   line: 963 }
    ],
    "font-embedder": [
      { label: "Font inventory builder",         path: "modules/font-embedder/index.js",                 line: 129 },
      { label: "Font analysis & plan emission",  path: "modules/font-embedder/lib/analyze.js",           line: 140 },
      { label: "Standard 14 fallback mapping",   path: "modules/font-embedder/lib/standard14.js",        line: 80  },
      { label: "Fallback font vendoring",        path: "modules/font-embedder/vendor/fonts/fallbacks.json", line: 1 }
    ],
    "pdf-writer":    [
      { label: "Writer mode dispatch",           path: "modules/pdf-writer/index.js",                    line: 548 },
      { label: "TH Scope inference",             path: "modules/pdf-writer/index.js",                    line: 160 },
      { label: "CIDSet cleanup (saveIncremental)",path: "modules/pdf-writer/java/PdfTagWriterCli.java",  line: 383 },
      { label: "Native flow orchestration",      path: "modules/pdf-writer/index.js",                    line: 499 },
      { label: "Operator-level parser (Java)",   path: "modules/pdf-writer/java/NativeContentStreamParser.java", line: 28 },
      { label: "Tag matcher (Java)",             path: "modules/pdf-writer/java/NativeTagMatcher.java",  line: 20  },
      { label: "Content stream rewriter (Java)", path: "modules/pdf-writer/java/NativeContentStreamRewriter.java", line: 57 }
    ],
    "validator":     [
      { label: "Font audit pre-pass",            path: "modules/validator/index.js",                     line: 368 },
      { label: "veraPDF invocation",             path: "modules/validator/index.js",                     line: 305 },
      { label: "Report parsing + task exception",path: "modules/validator/index.js",                     line: 265 },
      { label: "Resilient validation pipeline",  path: "modules/validator/index.js",                     line: 612 },
      { label: "Font audit CLI (Java)",          path: "modules/validator/java/FontAuditCli.java",       line: 1   }
    ],
    "profiles":      [
      { label: "Profile schema (50+ fields)",    path: "contracts/profile.schema.json",                  line: 1   },
      { label: "Profile registry & resolution",  path: "orchestrator/profile-registry.js",               line: 72  },
      { label: "Profile runtime injection",      path: "orchestrator/profile-runtime.js",                line: 1   },
      { label: "Default profile",                path: "orchestrator/profiles/default.json",             line: 1   },
      { label: "Legal profile",                  path: "orchestrator/profiles/legal.json",               line: 1   }
    ],
    "native":        [
      { label: "Design document",                path: "docs/native-tagging-design.md",                  line: 1   },
      { label: "Operator parser",                path: "modules/pdf-writer/java/NativeContentStreamParser.java", line: 52 },
      { label: "Tag matcher",                    path: "modules/pdf-writer/java/NativeTagMatcher.java",  line: 20  },
      { label: "Stream rewriter",                path: "modules/pdf-writer/java/NativeContentStreamRewriter.java", line: 57 },
      { label: "Verification pipeline",          path: "modules/native-verify/index.js",                 line: 1   }
    ],
    "repair":        [
      { label: "Structural repair (8 checks)",   path: "modules/corruption-repairer/java/PdfRepairCli.java", line: 69 },
      { label: "Font health (24 checks)",        path: "modules/corruption-repairer/java/FontRepairCli.java", line: 59 },
      { label: "Repair report model",            path: "modules/corruption-repairer/lib/report-model.js", line: 1  },
      { label: "Workload definition",            path: "orchestrator/workloads/index.js",                line: 1   }
    ]
  };

  for (const [sectionId, links] of Object.entries(sourceMap)) {
    const section = document.getElementById(sectionId);
    if (!section) continue;
    const container = document.createElement("div");
    container.className = "source-links";
    container.innerHTML = '<span class="source-links-label">\u{1F4C2} View Source:</span> ' +
      links.map(l => `<a href="${REPO}/${l.path}#L${l.line}" target="_blank" rel="noopener" title="${l.path}:${l.line}">${l.label}</a>`).join(" · ");
    const heading = section.querySelector("h2, h3");
    if (heading) heading.after(container);
    else section.prepend(container);
  }
})();
