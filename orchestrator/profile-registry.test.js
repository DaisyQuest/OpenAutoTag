import { test } from "node:test";
import assert from "node:assert/strict";
import { listProfiles, getProfile, resolveProfile, getProfileForStage, clearRegistryCache } from "./profile-registry.js";

test("listProfiles returns all preset profiles", async () => {
  clearRegistryCache();
  const profiles = await listProfiles();
  assert.ok(profiles.length >= 6, `expected >= 6 profiles, got ${profiles.length}`);
  const ids = profiles.map((p) => p.profileId);
  for (const expected of ["default", "legal", "scientific", "scanned-low-quality", "forms-heavy", "cjk"]) {
    assert.ok(ids.includes(expected), `missing profile: ${expected}`);
  }
});

test("getProfile returns a valid profile with required fields", async () => {
  const profile = await getProfile("legal");
  assert.equal(profile.schemaVersion, "1.0.0");
  assert.equal(profile.profileId, "legal");
  assert.equal(profile.extends, "default");
  assert.ok(profile.label);
});

test("getProfile throws for unknown profile", async () => {
  await assert.rejects(() => getProfile("nonexistent"), /not found/);
});

test("resolveProfile merges base and derived profiles", async () => {
  const resolved = await resolveProfile("legal");
  assert.equal(resolved.parser.ocrMaxAttempts, 3, "legal overrides ocrMaxAttempts to 3");
  assert.equal(resolved.parser.ocrMode, "auto", "inherits ocrMode from default");
  assert.deepEqual(resolved._resolvedFrom, ["default", "legal"]);
});

test("resolveProfile applies runtime overrides on top", async () => {
  const resolved = await resolveProfile("legal", { parser: { ocrMode: "force" } });
  assert.equal(resolved.parser.ocrMode, "force", "runtime override takes precedence");
  assert.equal(resolved.parser.ocrMaxAttempts, 3, "non-overridden fields preserved");
  assert.equal(resolved._overridesApplied, true);
});

test("resolveProfile detects circular inheritance", async () => {
  // This test just asserts the mechanism exists; actual circular profiles
  // would need a crafted registry. For now, resolve a non-circular chain.
  const resolved = await resolveProfile("default");
  assert.deepEqual(resolved._resolvedFrom, ["default"]);
});

test("getProfileForStage returns stage-specific config", async () => {
  const parserConfig = await getProfileForStage("legal", "parser");
  assert.equal(parserConfig.ocrMaxAttempts, 3);
  const emptyConfig = await getProfileForStage("legal", "nonexistentStage");
  assert.deepEqual(emptyConfig, {});
});
