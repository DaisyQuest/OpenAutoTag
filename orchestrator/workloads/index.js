import { readFile } from "node:fs/promises";
import { runPipeline } from "../pipeline-runner.js";
import { runRedactionPipeline } from "../redaction-runner.js";
import { runTagAndRedactPipeline } from "../tag-redaction-runner.js";
import { runCorruptionRepairPipeline } from "../corruption-repair-runner.js";

function buildTagDeltaSignals(tagDeltaReport) {
  if (!tagDeltaReport?.delta) {
    return [];
  }

  const signals = [
    `Typed node delta ${tagDeltaReport.delta.totalTypedNodesDelta ?? 0}`,
    `Marked content delta ${tagDeltaReport.delta.markedContentOperatorCountDelta ?? 0}`
  ];

  if (tagDeltaReport.delta.tableAttributeNodeCountDelta) {
    signals.push(`Table attr delta ${tagDeltaReport.delta.tableAttributeNodeCountDelta}`);
  }

  if (tagDeltaReport.delta.structTreeAdded) {
    signals.push("Struct tree added");
  }

  return signals;
}

function getAccessibilitySummary(report, tagDeltaReport) {
  return {
    kind: "validation",
    tone: report.isCompliant ? "success" : "danger",
    label: report.isCompliant ? "Validation passed" : `${report.summary?.failedRules ?? 0} failed rule${report.summary?.failedRules === 1 ? "" : "s"}`,
    detail: report.isCompliant
      ? "PDF/UA checks passed."
      : `${report.summary?.failedChecks ?? 0} failed check${report.summary?.failedChecks === 1 ? "" : "s"}.`,
    signals: [
      ...(report.findings || []).map((finding) => finding.code),
      ...buildTagDeltaSignals(tagDeltaReport)
    ].slice(0, 6),
    metadataDiagnostics: report.metadataDiagnostics || null,
    tagDelta: tagDeltaReport?.delta || null
  };
}

function getRedactionSummary(report) {
  const redactedMatches = report.summary?.redactedMatches ?? 0;
  const pagesRedacted = report.summary?.pagesRedacted ?? 0;

  return {
    kind: "redaction",
    tone: redactedMatches > 0 ? "success" : "neutral",
    label: redactedMatches > 0 ? `${redactedMatches} SSN${redactedMatches === 1 ? "" : "s"} redacted` : "No SSNs found",
    detail: redactedMatches > 0 ? `${pagesRedacted} page${pagesRedacted === 1 ? "" : "s"} modified.` : "Output copied without redactions.",
    signals: (report.matches || []).slice(0, 4).map((match) => `Page ${match.pageNumber}: ${match.maskedText}`)
  };
}

function getCorruptionRepairSummary(report) {
  const issuesRepaired = report.issuesRepaired ?? report.repairs?.length ?? 0;
  const riskLevel = report.riskLevel ?? "low";
  const tone = riskLevel === "high" ? "danger" : riskLevel === "medium" ? "warning" : "success";

  return {
    kind: "corruption-repair",
    tone,
    label: issuesRepaired > 0
      ? `${issuesRepaired} issue${issuesRepaired === 1 ? "" : "s"} repaired`
      : "No issues found",
    detail: issuesRepaired > 0
      ? `Repaired ${issuesRepaired} corruption${issuesRepaired === 1 ? "" : "s"}; risk level: ${riskLevel}.`
      : "PDF appears structurally sound.",
    signals: (report.repairs || []).slice(0, 3).map((repair) => repair.description || repair.type || "unknown repair")
  };
}

function getTaggedRedactionSummary(redactionReport, validationReport, tagDeltaReport) {
  const redactedMatches = redactionReport.summary?.redactedMatches ?? 0;
  const failedRules = validationReport?.summary?.failedRules ?? 0;

  return {
    kind: "tagged-redaction",
    tone: redactedMatches > 0 ? "success" : validationReport?.isCompliant ? "success" : "danger",
    label:
      redactedMatches > 0
        ? `${redactedMatches} SSN${redactedMatches === 1 ? "" : "s"} redacted`
        : validationReport?.isCompliant
          ? "Tagged PDF emitted"
          : `${failedRules} failed rule${failedRules === 1 ? "" : "s"}`,
    detail:
      redactedMatches > 0
        ? "Visible content and accessibility text were masked before validation."
        : validationReport?.isCompliant
          ? "No SSNs were found. Tagged output still completed."
          : `${validationReport?.summary?.failedChecks ?? 0} failed check${validationReport?.summary?.failedChecks === 1 ? "" : "s"} after tagging.`,
    signals: [
      ...(redactionReport.matches || []).slice(0, 3).map((match) => `Page ${match.pageNumber}: ${match.maskedText}`),
      ...((validationReport?.findings || []).map((finding) => finding.code).slice(0, 3)),
      ...buildTagDeltaSignals(tagDeltaReport)
    ].slice(0, 6)
  };
}

const workloadDefinitions = {
  "accessibility-tagging": {
    id: "accessibility-tagging",
    label: "Accessibility Tagging",
    shortLabel: "Tagging",
    description: "Create tagged, validated PDF/UA output with browser-native reports.",
    primaryArtifact: "validationReport",
    previewArtifacts: ["validationReport", "tagDeltaReport", "writerReport", "tagManifest"],
    downloadArtifacts: ["taggedPdf", "validationReport", "tagDeltaReport", "writerReport", "tagManifest"],
    processor: runPipeline,
    async summarize(job) {
      if (!job?.artifacts?.validationReport) {
        return null;
      }

      const [report, tagDeltaReport, writerReport] = await Promise.all([
        readFile(job.artifacts.validationReport, "utf8").then((content) => JSON.parse(content)),
        job?.artifacts?.tagDeltaReport
          ? readFile(job.artifacts.tagDeltaReport, "utf8").then((content) => JSON.parse(content))
          : Promise.resolve(null),
        job?.artifacts?.writerReport
          ? readFile(job.artifacts.writerReport, "utf8").then((content) => JSON.parse(content)).catch(() => null)
          : Promise.resolve(null)
      ]);

      const writerMode = writerReport?.writerMode || "raster";
      const pagesNative = writerReport?.pagesNative ?? writerReport?.pagesRewritten ?? 0;
      const pagesRaster = writerReport?.pagesRaster ?? 0;
      const matchRate = writerReport?.matchRate ?? writerReport?.operatorMatchRate ?? null;

      return {
        summary: getAccessibilitySummary(report, tagDeltaReport),
        writerMode,
        pagesNative,
        pagesRaster,
        operatorMatchRate: matchRate,
        validation: {
          isCompliant: Boolean(report.isCompliant),
          failedRules: report.summary?.failedRules ?? 0,
          failedChecks: report.summary?.failedChecks ?? 0,
          findingCodes: (report.findings || []).map((finding) => finding.code).slice(0, 6),
          metadataDiagnostics: report.metadataDiagnostics || null,
          tagDelta: tagDeltaReport?.delta || null
        }
      };
    }
  },
  "ssn-redaction": {
    id: "ssn-redaction",
    label: "SSN Redaction",
    shortLabel: "Redaction",
    description: "Detect and redact likely social security numbers, then emit a redaction report and safe output PDF.",
    primaryArtifact: "redactionReport",
    previewArtifacts: ["redactionReport"],
    downloadArtifacts: ["redactedPdf", "redactionReport"],
    processor: runRedactionPipeline,
    async summarize(job) {
      if (!job?.artifacts?.redactionReport) {
        return null;
      }

      const report = JSON.parse(await readFile(job.artifacts.redactionReport, "utf8"));
      return {
        summary: getRedactionSummary(report),
        validation: null
      };
    }
  },
  "tag-and-ssn-redact": {
    id: "tag-and-ssn-redact",
    label: "Tag + SSN Redaction",
    shortLabel: "Tag + Redact",
    description: "Tag the PDF, mask SSNs from visible and accessibility content, then validate the final tagged output.",
    primaryArtifact: "redactionReport",
    previewArtifacts: ["redactionReport", "validationReport", "tagDeltaReport", "writerReport", "tagManifest"],
    downloadArtifacts: ["taggedPdf", "redactionReport", "validationReport", "tagDeltaReport", "writerReport", "tagManifest"],
    processor: runTagAndRedactPipeline,
    async summarize(job) {
      if (!job?.artifacts?.redactionReport) {
        return null;
      }

      const [redactionReport, validationReport, tagDeltaReport] = await Promise.all([
        readFile(job.artifacts.redactionReport, "utf8").then((content) => JSON.parse(content)),
        job.artifacts.validationReport
          ? readFile(job.artifacts.validationReport, "utf8").then((content) => JSON.parse(content))
          : Promise.resolve(null),
        job.artifacts.tagDeltaReport
          ? readFile(job.artifacts.tagDeltaReport, "utf8").then((content) => JSON.parse(content))
          : Promise.resolve(null)
      ]);

      return {
        summary: getTaggedRedactionSummary(redactionReport, validationReport, tagDeltaReport),
        validation: validationReport
          ? {
              isCompliant: Boolean(validationReport.isCompliant),
              failedRules: validationReport.summary?.failedRules ?? 0,
              failedChecks: validationReport.summary?.failedChecks ?? 0,
              findingCodes: (validationReport.findings || []).map((finding) => finding.code).slice(0, 6),
              metadataDiagnostics: validationReport.metadataDiagnostics || null,
              tagDelta: tagDeltaReport?.delta || null
            }
          : null
      };
    }
  },
  "corruption-repair": {
    id: "corruption-repair",
    label: "PDF Corruption Repair",
    shortLabel: "Repair",
    description: "Scans for 8 types of PDF corruption (broken xref, damaged streams, missing fonts, truncation, etc.), applies surgical repairs, runs 24 font health checks, and produces a clean PDF with detailed repair and font reports.",
    primaryArtifact: "repairedPdf",
    previewArtifacts: ["repairReport", "fontReport"],
    downloadArtifacts: ["repairedPdf"],
    processor: runCorruptionRepairPipeline,
    async summarize(job) {
      if (!job?.artifacts?.repairReport) {
        return null;
      }

      const [report, fontReport] = await Promise.all([
        readFile(job.artifacts.repairReport, "utf8").then((content) => JSON.parse(content)),
        job?.artifacts?.fontReport
          ? readFile(job.artifacts.fontReport, "utf8").then((content) => JSON.parse(content))
          : Promise.resolve(null)
      ]);

      const summary = getCorruptionRepairSummary(report);

      if (fontReport) {
        const fontGrade = fontReport.grade || fontReport.fontGrade || null;
        const fontIssueCount = fontReport.issues?.length ?? fontReport.findings?.length ?? 0;

        if (fontGrade) {
          summary.signals.push(`Font grade: ${fontGrade}`);
        }
        if (fontIssueCount > 0) {
          summary.signals.push(`${fontIssueCount} font issue${fontIssueCount === 1 ? "" : "s"}`);
        }
      }

      return {
        summary,
        validation: null,
        fontHealth: fontReport
      };
    }
  }
};

function toPublicWorkload(definition) {
  return {
    id: definition.id,
    label: definition.label,
    shortLabel: definition.shortLabel,
    description: definition.description,
    primaryArtifact: definition.primaryArtifact,
    previewArtifacts: [...definition.previewArtifacts],
    downloadArtifacts: [...definition.downloadArtifacts]
  };
}

export function listWorkloads() {
  return Object.values(workloadDefinitions).map((definition) => toPublicWorkload(definition));
}

export function getWorkloadDefinition(workloadId = "accessibility-tagging") {
  return workloadDefinitions[workloadId] || workloadDefinitions["accessibility-tagging"];
}

export function getPublicWorkload(workloadId = "accessibility-tagging") {
  return toPublicWorkload(getWorkloadDefinition(workloadId));
}

export async function runWorkload({ workloadId, ...args }) {
  const definition = getWorkloadDefinition(workloadId);
  return definition.processor({
    ...args,
    workload: toPublicWorkload(definition)
  });
}

export async function summarizeWorkloadJob(job) {
  const definition = getWorkloadDefinition(job?.workload?.id || job?.input?.workloadId);
  const summary = await definition.summarize(job);

  return {
    workload: toPublicWorkload(definition),
    summary: summary?.summary || null,
    validation: summary?.validation || null
  };
}
