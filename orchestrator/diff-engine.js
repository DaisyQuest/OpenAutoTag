/**
 * PDF Accessibility Diff Engine
 *
 * Compares multiple PDF documents across meaningful accessibility categories
 * and determines per-category winners. Designed to power the /difftool dashboard,
 * the Swing desktop client, and the comparison web-service API.
 *
 * Input: an array of document descriptors, each carrying optional report JSON
 * blobs (validationReport, writerReport, tagDeltaReport, fontReport).
 *
 * Output: a structured comparison report suitable for rendering.
 */

const GRADE_ORDER = ["A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "D-", "F"];

function gradeToScore(grade) {
  const index = GRADE_ORDER.indexOf(String(grade || "").toUpperCase());
  return index === -1 ? 0 : (GRADE_ORDER.length - index) / GRADE_ORDER.length;
}

/* -------------------------------------------------------------------------- */
/*  Metric extractors                                                         */
/* -------------------------------------------------------------------------- */

function extractComplianceMetrics(validationReport) {
  if (!validationReport) {
    return null;
  }

  const summary = validationReport.summary || {};
  return {
    isCompliant: Boolean(validationReport.isCompliant),
    failedRules: summary.failedRules ?? null,
    failedChecks: summary.failedChecks ?? null,
    engine: validationReport.engine?.name ?? null,
    findingCodes: (validationReport.findings || []).map((f) => f.code).slice(0, 12)
  };
}

function extractMetadataMetrics(validationReport) {
  const diag = validationReport?.metadataDiagnostics;
  if (!diag) {
    return null;
  }

  const checks = [
    diag.metadataPresent,
    diag.dcTitleDetected,
    diag.pdfUaIdentificationDetected,
    diag.infoMatchesXmp
  ];

  const passed = checks.filter(Boolean).length;
  return {
    metadataPresent: Boolean(diag.metadataPresent),
    dcTitleDetected: Boolean(diag.dcTitleDetected),
    pdfUaIdentificationDetected: Boolean(diag.pdfUaIdentificationDetected),
    infoMatchesXmp: Boolean(diag.infoMatchesXmp),
    suspectedMismatch: Boolean(diag.suspectedVeraPdfMetadataMismatch),
    score: passed / Math.max(checks.length, 1)
  };
}

function extractStructureMetrics(validationReport, tagDeltaReport) {
  const delta = tagDeltaReport?.delta;
  const diag = validationReport?.metadataDiagnostics;

  const hasStructTree =
    delta?.structTreeAdded !== undefined
      ? Boolean(delta.structTreeAdded) || (delta.totalTypedNodesDelta ?? 0) > 0
      : Boolean(diag?.structTreePresent);

  return {
    hasStructureTree: hasStructTree,
    typedNodes: delta?.totalTypedNodesDelta ?? delta?.totalTypedNodes ?? null,
    markedContentOperators: delta?.markedContentOperatorCountDelta ?? delta?.markedContentOperators ?? null,
    tableAttributeNodes: delta?.tableAttributeNodeCountDelta ?? delta?.tableAttributeNodes ?? null
  };
}

function extractFontMetrics(fontReport) {
  if (!fontReport) {
    return null;
  }

  return {
    grade: fontReport.grade || fontReport.fontGrade || null,
    gradeScore: gradeToScore(fontReport.grade || fontReport.fontGrade),
    issueCount: fontReport.issues?.length ?? fontReport.findings?.length ?? 0,
    fontCount: fontReport.fonts?.length ?? fontReport.fontCount ?? null,
    embeddedCount: fontReport.embeddedCount ?? null
  };
}

function extractWriterMetrics(writerReport) {
  if (!writerReport) {
    return null;
  }

  return {
    mode: writerReport.writerMode || null,
    pagesNative: writerReport.pagesNative ?? writerReport.pagesRewritten ?? 0,
    pagesRaster: writerReport.pagesRaster ?? 0,
    operatorMatchRate: writerReport.matchRate ?? writerReport.operatorMatchRate ?? null,
    totalPages: (writerReport.pagesNative ?? writerReport.pagesRewritten ?? 0) + (writerReport.pagesRaster ?? 0)
  };
}

function formatNullableString(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function firstPresent(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== "");
}

function buildDocumentDetails(doc, metrics) {
  const validation = doc.validationReport || null;
  const writer = extractWriterMetrics(doc.writerReport);
  const file = doc.file || {};
  const metadataDiagnostics = validation?.metadataDiagnostics || {};
  const structure = metrics["structure-tree"] || {};
  const font = metrics["font-health"] || {};

  return {
    fileName: formatNullableString(file.fileName || doc.fileName || doc.label),
    originalName: formatNullableString(file.originalName || doc.originalName || doc.label),
    sizeBytes: file.sizeBytes ?? null,
    pageCount: firstPresent(file.pageCount, writer?.totalPages, doc.writerReport?.pageCount) ?? null,
    title: formatNullableString(firstPresent(file.title, metadataDiagnostics.dcTitleValue, doc.writerReport?.title)),
    author: formatNullableString(file.author),
    subject: formatNullableString(file.subject),
    creator: formatNullableString(file.creator),
    producer: formatNullableString(file.producer),
    creationDate: file.creationDate || null,
    modificationDate: file.modificationDate || null,
    downloadUrl: file.downloadUrl || doc.downloadUrl || null,
    downloadLabel: file.downloadLabel || "Download PDF",
    validation: {
      available: Boolean(validation),
      status: validation?.overall?.status || (validation ? (validation.isCompliant ? "pass" : "fail") : "unavailable"),
      isCompliant: validation?.isCompliant ?? null,
      failedRules: validation?.summary?.failedRules ?? null,
      failedChecks: validation?.summary?.failedChecks ?? null,
      findingCount: validation?.findings?.length ?? null,
      engine: validation?.engine?.name || null,
      engineVersion: validation?.engine?.version || null
    },
    metadata: {
      metadataPresent: metadataDiagnostics.metadataPresent ?? null,
      dcTitleDetected: metadataDiagnostics.dcTitleDetected ?? null,
      pdfUaIdentificationDetected: metadataDiagnostics.pdfUaIdentificationDetected ?? null,
      infoMatchesXmp: metadataDiagnostics.infoMatchesXmp ?? null,
      correctedByValidator: metadataDiagnostics.correctedByValidator ?? null
    },
    structure: {
      hasStructureTree: structure.hasStructureTree ?? null,
      typedNodes: structure.typedNodes ?? null,
      markedContentOperators: structure.markedContentOperators ?? null,
      tableAttributeNodes: structure.tableAttributeNodes ?? null
    },
    font: {
      grade: font.grade || null,
      issueCount: font.issueCount ?? null,
      fontCount: font.fontCount ?? null
    },
    writer: writer
      ? {
          requestedMode: doc.writerReport?.requestedMode || null,
          mode: writer.mode || doc.writerReport?.writerMode || null,
          pagesNative: writer.pagesNative,
          pagesRaster: writer.pagesRaster,
          totalPages: writer.totalPages,
          operatorMatchRate: writer.operatorMatchRate,
          nativeTaggingApplied: doc.writerReport?.nativeTaggingApplied ?? null,
          autoFallbackReason: doc.writerReport?.autoFallbackReason || null
        }
      : null
  };
}

function extractTagCoverageMetrics(validationReport, writerReport) {
  const writer = extractWriterMetrics(writerReport);
  const findings = validationReport?.findings || [];
  const tagRelatedFindings = findings.filter(
    (f) => /tag|struct|mark/i.test(f.code) || /tag|struct|mark/i.test(f.description || "")
  );

  return {
    tagRelatedFindingCount: tagRelatedFindings.length,
    operatorMatchRate: writer?.operatorMatchRate ?? null,
    nativePageRatio:
      writer && writer.totalPages > 0
        ? writer.pagesNative / writer.totalPages
        : null
  };
}

/* -------------------------------------------------------------------------- */
/*  Category scorers — each returns 0..1 (higher = better)                    */
/* -------------------------------------------------------------------------- */

function scoreCompliance(metrics) {
  if (!metrics) return 0;
  if (metrics.isCompliant) return 1.0;
  const rulesPenalty = Math.min((metrics.failedRules ?? 0) / 20, 1);
  const checksPenalty = Math.min((metrics.failedChecks ?? 0) / 50, 1);
  return Math.max(0, 1 - (rulesPenalty * 0.6 + checksPenalty * 0.4));
}

function scoreMetadata(metrics) {
  if (!metrics) return 0;
  return metrics.score;
}

function scoreStructure(metrics) {
  if (!metrics) return 0;
  let score = metrics.hasStructureTree ? 0.4 : 0;
  if (metrics.typedNodes !== null && metrics.typedNodes > 0) {
    score += Math.min(metrics.typedNodes / 100, 1) * 0.3;
  }
  if (metrics.markedContentOperators !== null && metrics.markedContentOperators > 0) {
    score += Math.min(metrics.markedContentOperators / 200, 1) * 0.3;
  }
  return Math.min(score, 1);
}

function scoreFontHealth(metrics) {
  if (!metrics) return 0.5; // unknown = neutral
  return metrics.gradeScore * 0.7 + Math.max(0, 1 - metrics.issueCount / 10) * 0.3;
}

function scoreTagCoverage(metrics) {
  if (!metrics) return 0;
  let score = 0;
  if (metrics.operatorMatchRate !== null) {
    score += metrics.operatorMatchRate * 0.5;
  }
  if (metrics.nativePageRatio !== null) {
    score += metrics.nativePageRatio * 0.3;
  }
  score += Math.max(0, 1 - metrics.tagRelatedFindingCount / 10) * 0.2;
  return Math.min(score, 1);
}

/* -------------------------------------------------------------------------- */
/*  Category definitions                                                      */
/* -------------------------------------------------------------------------- */

export const CATEGORIES = [
  {
    id: "pdfua-compliance",
    label: "PDF/UA Compliance",
    description: "Conformance with PDF/UA accessibility standard. Fewer failed rules and checks is better.",
    icon: "🛡️",
    extract: (doc) => extractComplianceMetrics(doc.validationReport),
    score: scoreCompliance,
    weight: 1.0
  },
  {
    id: "metadata-quality",
    label: "Metadata Quality",
    description: "Document metadata completeness including title, language, and XMP synchronization.",
    icon: "📋",
    extract: (doc) => extractMetadataMetrics(doc.validationReport),
    score: scoreMetadata,
    weight: 0.6
  },
  {
    id: "structure-tree",
    label: "Structure Tree",
    description: "Presence and richness of the logical structure tree with typed nodes and marked content.",
    icon: "🌳",
    extract: (doc) => extractStructureMetrics(doc.validationReport, doc.tagDeltaReport),
    score: scoreStructure,
    weight: 0.9
  },
  {
    id: "font-health",
    label: "Font Health",
    description: "Font embedding quality, ToUnicode coverage, and overall font audit grade.",
    icon: "🔤",
    extract: (doc) => extractFontMetrics(doc.fontReport),
    score: scoreFontHealth,
    weight: 0.7
  },
  {
    id: "tag-coverage",
    label: "Tag Coverage",
    description: "Percentage of content operators matched to semantic tags and native page preservation.",
    icon: "🏷️",
    extract: (doc) => extractTagCoverageMetrics(doc.validationReport, doc.writerReport),
    score: scoreTagCoverage,
    weight: 0.8
  }
];

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Extract all metrics from a single document descriptor.
 */
export function extractDocumentMetrics(doc) {
  const metrics = {};
  for (const category of CATEGORIES) {
    metrics[category.id] = category.extract(doc);
  }
  return metrics;
}

/**
 * Compare an array of document descriptors and produce a structured report.
 *
 * @param {Array<{id: string, label: string, role: string, file?, validationReport?, writerReport?, tagDeltaReport?, fontReport?}>} documents
 * @returns {{ documents, categories, overallWinner, generatedAt }}
 */
export function compareDocuments(documents) {
  if (!documents || documents.length === 0) {
    return { documents: [], categories: [], overallWinner: null, generatedAt: new Date().toISOString() };
  }

  const analyzed = documents.map((doc) => {
    const metrics = extractDocumentMetrics(doc);
    const scores = {};
    for (const category of CATEGORIES) {
      scores[category.id] = category.score(metrics[category.id]);
    }

    return {
      id: doc.id,
      label: doc.label,
      role: doc.role || "document",
      details: buildDocumentDetails(doc, metrics),
      metrics,
      scores
    };
  });

  const categoryResults = CATEGORIES.map((category) => {
    const entries = analyzed.map((doc) => ({
      documentId: doc.id,
      label: doc.label,
      score: doc.scores[category.id],
      metrics: doc.metrics[category.id]
    }));

    entries.sort((a, b) => b.score - a.score);
    const bestScore = entries[0]?.score ?? 0;
    const winners = entries.filter((e) => e.score === bestScore && bestScore > 0).map((e) => e.documentId);

    return {
      id: category.id,
      label: category.label,
      description: category.description,
      icon: category.icon,
      weight: category.weight,
      entries,
      winner: winners.length === 1 ? winners[0] : null,
      tied: winners.length > 1 ? winners : null
    };
  });

  // Overall winner: weighted score sum
  const totals = new Map();
  for (const doc of analyzed) {
    let weightedSum = 0;
    let weightTotal = 0;
    for (const category of CATEGORIES) {
      weightedSum += doc.scores[category.id] * category.weight;
      weightTotal += category.weight;
    }
    totals.set(doc.id, weightTotal > 0 ? weightedSum / weightTotal : 0);
  }

  let overallWinner = null;
  let bestTotal = -1;
  for (const [id, total] of totals) {
    if (total > bestTotal) {
      bestTotal = total;
      overallWinner = id;
    }
  }

  return {
    documents: analyzed,
    categories: categoryResults,
    overallWinner,
    overallScores: Object.fromEntries(totals),
    generatedAt: new Date().toISOString()
  };
}

/**
 * Build a human-readable text summary of the comparison.
 */
export function summarizeComparison(report) {
  if (!report || report.documents.length === 0) {
    return "No documents to compare.";
  }

  const lines = [`PDF Accessibility Comparison — ${report.generatedAt}`, ""];

  for (const cat of report.categories) {
    const winnerLabel = cat.winner
      ? report.documents.find((d) => d.id === cat.winner)?.label || cat.winner
      : cat.tied
        ? "Tied"
        : "N/A";

    lines.push(`${cat.icon} ${cat.label}: Winner → ${winnerLabel}`);
    for (const entry of cat.entries) {
      lines.push(`   ${entry.label}: ${(entry.score * 100).toFixed(1)}%`);
    }
    lines.push("");
  }

  if (report.overallWinner) {
    const winner = report.documents.find((d) => d.id === report.overallWinner);
    lines.push(`🏆 Overall Winner: ${winner?.label || report.overallWinner}`);
  }

  return lines.join("\n");
}
