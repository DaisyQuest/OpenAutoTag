import { readFile } from "node:fs/promises";
import { compareSavedSemantics } from "./saved-semantics.js";
import Ajv2020 from "ajv/dist/2020.js";
import inspectionSchema from "../../contracts/pdf-preservation-inspection.schema.json" with { type: "json" };
import taggingSchema from "../../contracts/tagging.schema.json" with { type: "json" };
import reportSchema from "../../contracts/saved-semantics.schema.json" with { type: "json" };
const ajv = new Ajv2020({ allErrors: true });
const validInspection = ajv.compile(inspectionSchema), validTagging = ajv.compile(taggingSchema), validReport = ajv.compile(reportSchema);
try {
  if (!process.argv[2]) throw new Error("Usage: saved-semantics-cli.js <comparison-input.json>");
  const input=JSON.parse(await readFile(process.argv[2], "utf8"));
  if(!validInspection(input.inspection) || input.reference && !validInspection(input.reference) || input.tagging && !validTagging(input.tagging)) throw new Error("Invalid semantic comparison input contract");
  const report=compareSavedSemantics(input);
  if(!validReport(report)) throw new Error(`Invalid semantic comparison report: ${ajv.errorsText(validReport.errors)}`);
  process.stdout.write(JSON.stringify(report) + "\n");
} catch (e) { process.stderr.write(e.message + "\n"); process.exitCode = 1; }
