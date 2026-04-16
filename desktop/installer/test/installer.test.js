import { test } from "node:test";
import assert from "node:assert/strict";
import { getDefaultConfig, mergeWithDefaults, validateConfig } from "../installer-config.js";
import { generateElectronBuilderConfig } from "../index.js";

test("getDefaultConfig returns complete config", () => {
  const config = getDefaultConfig();
  assert.ok(config.productName);
  assert.ok(config.version);
  assert.ok(config.platforms.windows);
  assert.ok(config.branding.company);
  assert.ok(config.advanced.fileAssociations.includes(".pdf"));
});

test("validateConfig accepts valid config", () => {
  const result = validateConfig({ productName: "Test", version: "1.0.0" });
  assert.ok(result.valid);
  assert.equal(result.errors.length, 0);
});

test("validateConfig rejects missing productName", () => {
  const result = validateConfig({ version: "1.0.0" });
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e) => e.includes("productName")));
});

test("mergeWithDefaults fills missing fields", () => {
  const merged = mergeWithDefaults({ productName: "Custom", version: "2.0" });
  assert.equal(merged.productName, "Custom");
  assert.equal(merged.version, "2.0");
  assert.ok(merged.platforms.windows.enabled);
  assert.equal(merged.branding.company, "DaisyQuest");
});

test("generateElectronBuilderConfig produces valid structure", () => {
  const config = generateElectronBuilderConfig({ productName: "Test App", version: "1.0.0" });
  assert.ok(config.appId);
  assert.equal(config.productName, "Test App");
  assert.ok(config.files.length > 0);
  assert.ok(config.win);
  assert.ok(config.nsis);
});
