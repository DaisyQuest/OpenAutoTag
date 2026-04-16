import { stat } from "node:fs/promises";

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

/**
 * Classify a raw repair report from the Java CLI, adding derived fields.
 *
 * Expected raw report shape:
 *   { issues: [{ type, severity, message, repaired }], ... }
 *
 * severity values: "error" | "warning" | "info"
 */
export function classifyRepairReport(report) {
  const issues = report.issues || [];
  const totalIssues = issues.length;
  const repairedCount = issues.filter((issue) => issue.repaired).length;

  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  const unrepairedErrors = issues.filter((issue) => issue.severity === "error" && !issue.repaired).length;
  const unrepairedWarnings = issues.filter((issue) => issue.severity === "warning" && !issue.repaired).length;

  const healthScore = computeHealthScore({ totalIssues, errorCount, warningCount, unrepairedErrors, unrepairedWarnings });
  const repairEffectiveness = totalIssues > 0 ? repairedCount / totalIssues : 1;
  const riskLevel = computeRiskLevel({ healthScore, unrepairedErrors });
  const humanSummary = buildHumanSummary({ totalIssues, repairedCount, riskLevel, errorCount, warningCount });

  return {
    ...report,
    healthScore,
    repairEffectiveness,
    riskLevel,
    humanSummary,
  };
}

function computeHealthScore({ totalIssues, errorCount, warningCount, unrepairedErrors, unrepairedWarnings }) {
  if (totalIssues === 0) {
    return 1;
  }

  // Each unrepaired error costs 0.25, each unrepaired warning costs 0.1
  // Each repaired error costs 0.05, each repaired warning costs 0.02
  const repairedErrors = errorCount - unrepairedErrors;
  const repairedWarnings = warningCount - unrepairedWarnings;

  const penalty =
    unrepairedErrors * 0.25 +
    unrepairedWarnings * 0.1 +
    repairedErrors * 0.05 +
    repairedWarnings * 0.02;

  return Math.max(0, Math.min(1, Math.round((1 - penalty) * 1000) / 1000));
}

function computeRiskLevel({ healthScore, unrepairedErrors }) {
  if (healthScore === 1) {
    return "clean";
  }
  if (unrepairedErrors >= 3) {
    return "critical";
  }
  if (unrepairedErrors >= 1) {
    return "high";
  }
  if (healthScore >= 0.8) {
    return "low";
  }
  return "medium";
}

function buildHumanSummary({ totalIssues, repairedCount, riskLevel, errorCount, warningCount }) {
  if (totalIssues === 0) {
    return "No issues found; the PDF appears structurally clean.";
  }

  const parts = [];
  if (errorCount > 0) {
    parts.push(`${errorCount} error${errorCount !== 1 ? "s" : ""}`);
  }
  if (warningCount > 0) {
    parts.push(`${warningCount} warning${warningCount !== 1 ? "s" : ""}`);
  }
  const infoCount = totalIssues - errorCount - warningCount;
  if (infoCount > 0) {
    parts.push(`${infoCount} informational issue${infoCount !== 1 ? "s" : ""}`);
  }

  const issueDesc = parts.join(", ");
  const repairedDesc = repairedCount === totalIssues
    ? "all repaired"
    : `${repairedCount} of ${totalIssues} repaired`;

  return `Found ${issueDesc} (${repairedDesc}); risk level: ${riskLevel}.`;
}

/**
 * Order repairs by severity (errors first, then warnings, then info).
 * Returns a timeline array of { step, severity, type, message, repaired }.
 */
export function buildRepairTimeline(report) {
  const issues = report.issues || [];

  const sorted = [...issues].sort((a, b) => {
    const aOrder = SEVERITY_ORDER[a.severity] ?? 3;
    const bOrder = SEVERITY_ORDER[b.severity] ?? 3;
    return aOrder - bOrder;
  });

  return sorted.map((issue, index) => ({
    step: index + 1,
    severity: issue.severity,
    type: issue.type,
    message: issue.message,
    repaired: Boolean(issue.repaired),
  }));
}

/**
 * Compare input and output PDF by file size.
 * Returns { inputSize, outputSize, delta, deltaPercent }.
 */
export async function compareBeforeAfter(inputPath, outputPath) {
  const [inputStats, outputStats] = await Promise.all([
    stat(inputPath),
    stat(outputPath),
  ]);

  const inputSize = inputStats.size;
  const outputSize = outputStats.size;
  const delta = outputSize - inputSize;
  const deltaPercent = inputSize > 0
    ? Math.round((delta / inputSize) * 10000) / 100
    : 0;

  return { inputSize, outputSize, delta, deltaPercent };
}
