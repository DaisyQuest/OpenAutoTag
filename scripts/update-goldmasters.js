import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAcademicHellSampleGoldmaster,
  buildHellishSampleGoldmaster,
  buildNativeSampleGoldmaster,
  buildRuledTableSampleGoldmaster,
  buildScannedSampleOcrGoldmaster,
  buildSpanishSampleGoldmaster,
  buildTableSampleGoldmaster
} from "../test/goldmaster/goldmaster-utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const goldmasterDir = path.join(repoRoot, "test", "goldmasters");

async function writeJson(targetPath, value) {
  await writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  await mkdir(goldmasterDir, { recursive: true });

  const nativeSample = await buildNativeSampleGoldmaster();
  const scannedSampleOcr = await buildScannedSampleOcrGoldmaster();
  const spanishSample = await buildSpanishSampleGoldmaster();
  const tableSample = await buildTableSampleGoldmaster();
  const ruledTableSample = await buildRuledTableSampleGoldmaster();
  const hellishSample = await buildHellishSampleGoldmaster();
  const academicHellSample = await buildAcademicHellSampleGoldmaster();

  await writeJson(path.join(goldmasterDir, "native-sample.json"), nativeSample);
  await writeJson(path.join(goldmasterDir, "scanned-sample-ocr.json"), scannedSampleOcr);
  await writeJson(path.join(goldmasterDir, "spanish-sample.json"), spanishSample);
  await writeJson(path.join(goldmasterDir, "table-sample.json"), tableSample);
  await writeJson(path.join(goldmasterDir, "ruled-table-sample.json"), ruledTableSample);
  await writeJson(path.join(goldmasterDir, "hellish-sample.json"), hellishSample);
  await writeJson(path.join(goldmasterDir, "academic-hell-sample.json"), academicHellSample);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
