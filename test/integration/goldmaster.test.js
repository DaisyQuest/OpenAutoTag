import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
} from "../goldmaster/goldmaster-utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

async function readGoldmaster(name) {
  const targetPath = path.join(repoRoot, "test", "goldmasters", name);
  return JSON.parse(await readFile(targetPath, "utf8"));
}

test("native sample pipeline artifacts match the goldmaster", async () => {
  const expected = await readGoldmaster("native-sample.json");
  const actual = await buildNativeSampleGoldmaster();

  assert.deepEqual(actual, expected);
});

test("scanned sample OCR output matches the goldmaster", async () => {
  const expected = await readGoldmaster("scanned-sample-ocr.json");
  const actual = await buildScannedSampleOcrGoldmaster();

  assert.deepEqual(actual, expected);
});

test("Spanish sample pipeline artifacts match the goldmaster", async () => {
  const expected = await readGoldmaster("spanish-sample.json");
  const actual = await buildSpanishSampleGoldmaster();

  assert.deepEqual(actual, expected);
});

test("table-rich pipeline artifacts match the goldmaster", async () => {
  const expected = await readGoldmaster("table-sample.json");
  const actual = await buildTableSampleGoldmaster();

  assert.deepEqual(actual, expected);
});

test("ruled-table pipeline artifacts match the goldmaster", async () => {
  const expected = await readGoldmaster("ruled-table-sample.json");
  const actual = await buildRuledTableSampleGoldmaster();

  assert.deepEqual(actual, expected);
});

test("hellish pipeline artifacts match the goldmaster", async () => {
  const expected = await readGoldmaster("hellish-sample.json");
  const actual = await buildHellishSampleGoldmaster();

  assert.deepEqual(actual, expected);
});

test("academic hell pipeline artifacts match the goldmaster", async () => {
  const expected = await readGoldmaster("academic-hell-sample.json");
  const actual = await buildAcademicHellSampleGoldmaster();

  assert.deepEqual(actual, expected);
});
