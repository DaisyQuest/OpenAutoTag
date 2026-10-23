import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import inspectionSchema from "../../contracts/pdf-preservation-inspection.schema.json" with { type: "json" };
import reportSchema from "../../contracts/quality-report.schema.json" with { type: "json" };
import auditSchema from "../../contracts/repair-audit.schema.json" with { type: "json" };
import fontRepairSchema from "../../contracts/font-repair-report.schema.json" with { type: "json" };
import outlineReportSchema from "../../contracts/reviewed-outline-report.schema.json" with { type: "json" };
import { buildReviewPlan } from "./review-plan.js";

const ajv = new Ajv2020({ allErrors: true });
const validInspection = ajv.compile(inspectionSchema);
const validReport = ajv.compile(reportSchema);
const validFontRepair = ajv.addSchema(auditSchema).compile(fontRepairSchema);
const validStructureRepair = ajv.getSchema(auditSchema.$id);
const validOutlineReport = ajv.compile(outlineReportSchema);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const safeHash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null;

/** This bounded gate detects regressions; it never certifies overall accessibility. */
export function evaluatePreservation({ source, candidate, validation, semantic, fontRepair, structureRepair, outlineReport, identityPreserved = false, inspectionError } = {}) {
  const report = { schemaVersion: "1.0.0", policy: "preservation-v1", disposition: "review_required",
    sourceHash: safeHash(source?.sourceHash), candidateHash: safeHash(candidate?.sourceHash),
    checks: [], findings: [], limitations: [
      "This gate covers object-preserving repairs only; native rebuilds require a content identity mapping.",
      "Full structure validation, semantic review, visual rendering and interactive behavior remain separate requirements."
    ] };
  const finding = (code, description, location) => report.findings.push({ code, description, ...(location ? { location } : {}) });
  const check = (id, status) => report.checks.push({ id, status });
  let error = false, regression = false;
  const qualifiedOutline=outlineReport&&validOutlineReport(outlineReport)&&outlineReport.sourceHash===report.sourceHash&&outlineReport.candidateHash===report.candidateHash;
  if(outlineReport){check("qualifiedOutlineChanges",qualifiedOutline?"pass":"fail");if(!qualifiedOutline){regression=true;finding("OUTLINE_NOT_VERIFIED","Outline replay proof is malformed or does not match these exact PDFs.");}}
  const qualifiedFonts = fontRepair && validFontRepair(fontRepair) && fontRepair.verification.status === "pass" &&
    fontRepair.sourceHash === report.sourceHash && fontRepair.candidateHash === report.candidateHash;
  const qualifiedStructure = structureRepair && validStructureRepair(structureRepair) &&
    structureRepair.sourceHash === report.sourceHash && structureRepair.candidateHash === report.candidateHash &&
    structureRepair.repairLedger.every((r) => r.decision !== "apply" || ["split-independent-form-widgets", "heading-rank-compaction", "reviewed-heading-paragraph"].includes(r.ruleId));
  const splitOwners = new Set(qualifiedStructure ? structureRepair.repairLedger.filter((r) => r.ruleId === "split-independent-form-widgets" && r.decision === "apply").map((r) => r.target) : []);
  const paragraphTargets = new Set(qualifiedStructure ? structureRepair.repairLedger.filter((r) => r.ruleId === "reviewed-heading-paragraph" && r.decision === "apply").map((r) => r.target) : []);
  if (structureRepair) {
    check("qualifiedStructureChanges", qualifiedStructure ? "pass" : "fail");
    if (!qualifiedStructure) { regression = true; finding("STRUCTURE_REPAIR_NOT_VERIFIED", "Structure replay audit is malformed or does not match these exact PDFs."); }
  }
  if (fontRepair) {
    check("qualifiedFontChanges", qualifiedFonts ? "pass" : "fail");
    if (!qualifiedFonts) { regression = true; finding("FONT_REPAIR_NOT_VERIFIED", "Font repair proof failed, is malformed, or does not match these exact PDFs."); }
  }
  if (inspectionError || !validInspection(source) || !validInspection(candidate)) {
    error = true; check("inspection", "unknown");
    finding("INSPECTION_UNAVAILABLE", inspectionError ? String(inspectionError) : "Required inspection is missing or violates its contract.");
  } else {
    check("inspection", "pass");
    report.limitations.push(...new Set([...source.limitations, ...candidate.limitations]));
    if (!identityPreserved) {
      check("objectIdentity", "unknown");
      finding("IDENTITY_MAPPING_REQUIRED", "The candidate does not retain the source byte prefix; object-reference comparison is not qualified.");
    } else {
      check("objectIdentity", "pass");
      const compare = (id, run) => {
        const before = report.findings.length;
        run();
        const failed = report.findings.length !== before;
        check(id, failed ? "fail" : "pass"); regression ||= failed;
      };
      if(!source.navigation||!candidate.navigation){error=true;check("navigation","unknown");finding("NAVIGATION_NOT_INSPECTED","Saved bookmark, destination and page-label evidence is missing.");}
      else compare("navigation",()=>{
        if(!same(source.navigation.pageLabels,candidate.navigation.pageLabels))finding("PAGE_LABELS_CHANGED","Logical page labels or their ranges changed.");
        if(!same(source.navigation.namedDestinationsHash,candidate.navigation.namedDestinationsHash))finding("NAMED_DESTINATIONS_CHANGED","Named destination definitions changed.");
        if(!qualifiedOutline&&!same(source.navigation.outlines,candidate.navigation.outlines))finding("OUTLINE_CHANGED","Bookmark hierarchy, titles, properties or destinations changed without a verified reviewed outline.");
        if(!same(source.navigation.issues,candidate.navigation.issues))finding("NAVIGATION_REGRESSION","Observed navigation defects changed.");
      });
      if(candidate.navigation?.issues.length)finding("NAVIGATION_REQUIRES_REVIEW","Existing navigation relationships require review.");
      compare("pageContentAndResources", () => {
        if (source.pages.length !== candidate.pages.length) finding("PAGE_COUNT_CHANGED", "Page count changed.");
        const protectedPage = (p) => qualifiedFonts && p ? { geometry: p.geometry, contentHash: p.contentHash } : p;
        for (let i = 0; i < source.pages.length; i++) if (!same(protectedPage(source.pages[i]), protectedPage(candidate.pages[i]))) {
          finding("PAGE_CONTENT_CHANGED", "Page geometry, content, resources or non-widget annotations changed.", `page:${i + 1}`);
        }
      });
      compare("fields", () => {
        for (const id of new Set([...Object.keys(source.fields), ...Object.keys(candidate.fields)])) {
          if (!source.fields[id] || !candidate.fields[id] || (!qualifiedFonts && source.fields[id] !== candidate.fields[id])) finding("FIELD_CHANGED", "A field, its properties or form resources changed or disappeared.", id);
        }
      });
      compare("widgets", () => {
        for (const id of new Set([...Object.keys(source.widgets), ...Object.keys(candidate.widgets)])) {
          const a = source.widgets[id], b = candidate.widgets[id];
          if (!a || !b || (!qualifiedFonts && a.digest !== b.digest) || a.page !== b.page) {
            finding("WIDGET_CHANGED", "A widget, its appearance or its page placement changed or disappeared.", id); continue;
          }
          // A list-body repair may insert LBody, but cannot move a widget to another item or lose its owner.
          const ownership = (owners) => owners.map(({ form, listItem }) => `${form}|${listItem}`).sort();
          const qualifiedSplit = a.owners.length === 1 && b.owners.length === 1 && splitOwners.has(a.owners[0].form) &&
            a.owners[0].listItem === b.owners[0].listItem && a.owners[0].inBody === b.owners[0].inBody;
          if (!qualifiedSplit && (!same(ownership(a.owners), ownership(b.owners)) ||
              a.owners.some((owner) => owner.inBody && !b.owners.some((next) => next.form === owner.form && next.inBody)))) {
            finding("WIDGET_OWNER_CHANGED", "Widget ownership or list-item context changed.", id);
          }
        }
      });
      compare("headingContent", () => {
        for (const heading of source.headings) {
          if (paragraphTargets.has(heading.id)) continue; // Exact saved-object replay retains its content under P.
          if (!heading.contentRefs.length) continue;
          if (!candidate.headings.some((next) => heading.contentRefs.every((id) => next.contentRefs.includes(id)))) {
            finding("HEADING_CONTENT_LOST", "Previously headed content no longer belongs together under a heading.", heading.id);
          }
        }
      });
      compare("links", () => {
        const a = source.links || {}, b = candidate.links || {};
        for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
          const old = a[id], next = b[id];
          if (!old || !next || old.digest !== next.digest || old.page !== next.page || old.uri !== next.uri) {
            finding("LINK_CHANGED", "A link's protected properties, destination or placement changed.", id); continue;
          }
          if (old.contents !== next.contents && (old.contents.trim() || !old.uri || next.contents !== old.uri)) finding("LINK_DESCRIPTION_CHANGED", "Link descriptions may only be filled from the unchanged URI when originally blank.", id);
          if (old.owners.length && !same(old.owners, next.owners)) finding("LINK_OWNER_CHANGED", "An authored link owner changed.", id);
          if (next.owners.length > 1) finding("LINK_OWNER_CHANGED", "A link has multiple owners.", id);
        }
      });
      compare("observedStructure", () => {
        // Compare multiplicities as well as codes so an additional occurrence cannot hide behind a known issue.
        const remaining = [...source.issues];
        for (const issue of candidate.issues) {
          const index = remaining.indexOf(issue);
          if (index >= 0) remaining.splice(index, 1);
          else finding("STRUCTURE_REGRESSION", issue);
        }
      });
      if (candidate.issues.length) finding("EXISTING_STRUCTURE_REQUIRES_REVIEW", "Observed structural defects remain in the candidate.");
      if (source.headings.some((h) => !h.contentRefs.length) || candidate.headings.some((h) => !h.contentRefs.length)) {
        finding("HEADING_REFERENCE_REQUIRES_REVIEW", "At least one heading has no inspectable content reference.");
      }
    }
  }
  const checkerFailed = !validation || validation.status !== "completed" || typeof validation.isCompliant !== "boolean" ||
    !safeHash(validation.pdfSha256) || validation.pdfSha256 !== report.candidateHash ||
    !Array.isArray(validation.findings) || !["pass", "fail"].includes(validation.overall?.status) ||
    validation.fontAudit?.status !== "ok" || validation.engine?.executionError ||
    validation.findings.some((f) => !f || typeof f.code !== "string" || typeof f.severity !== "string" || f.code === "VALIDATOR_EXECUTION_FAILED");
  if (checkerFailed) {
    error = true; check("requiredValidation", "unknown");
    finding("REQUIRED_CHECKER_UNAVAILABLE", "Validation or the mandatory font audit did not complete successfully for this exact candidate hash.");
  } else if (!validation.isCompliant || validation.overall.status !== "pass" || validation.findings.some((f) => ["error", "critical"].includes(f.severity))) {
    check("requiredValidation", "fail");
    finding("VALIDATION_REQUIRES_REVIEW", "Machine validation reports unresolved findings; see the complete validation report.");
  } else check("requiredValidation", "pass");
  report.disposition = error ? "error" : regression ? "rejected" : "review_required";
  Object.assign(report, buildReviewPlan({ candidateHash: report.candidateHash, findings: report.findings, validation: checkerFailed ? undefined : validation, semantic, inspection: candidate }));
  if (!validReport(report)) throw new Error(`Quality report violates its contract: ${ajv.errorsText(validReport.errors)}`);
  return report;
}

async function main() {
  const args = new Map();
  for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
  const read = async (key) => args.has(key) ? JSON.parse(await readFile(args.get(key), "utf8")) : undefined;
  let report;
  try {
    report = evaluatePreservation({ source: await read("--source"), candidate: await read("--candidate"), validation: await read("--validation"),
      semantic: await read("--semantic"),
      fontRepair: await read("--font-repair"), structureRepair: await read("--structure-repair"), outlineReport: await read("--outline-proof"),
      identityPreserved: args.get("--identity-preserved") === "true", inspectionError: args.get("--inspection-error") });
  } catch (error) { report = evaluatePreservation({ inspectionError: error.message }); }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  process.stderr.write(`${error.message}\n`); process.exitCode = 1;
});
