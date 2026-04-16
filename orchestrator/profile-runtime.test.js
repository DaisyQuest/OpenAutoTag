import { test } from "node:test";
import assert from "node:assert/strict";
import { clearRegistryCache } from "./profile-registry.js";
import { createProfileContext, injectProfileEnv } from "./profile-runtime.js";

test("createProfileContext returns a frozen context with .get()", async () => {
  clearRegistryCache();
  const ctx = await createProfileContext("default");

  assert.equal(ctx.profileId, "default");
  assert.ok(Object.isFrozen(ctx), "context object should be frozen");
  assert.ok(Object.isFrozen(ctx.resolved), "resolved profile should be frozen");

  const parser = ctx.get("parser");
  assert.equal(parser.ocrMode, "auto");
  assert.equal(typeof parser.ocrMaxAttempts, "number");
});

test("createProfileContext applies overrides", async () => {
  clearRegistryCache();
  const ctx = await createProfileContext("default", {
    parser: { ocrMode: "force" }
  });

  assert.equal(ctx.get("parser").ocrMode, "force");
  assert.equal(ctx.resolved._overridesApplied, true);
});

test("createProfileContext defaults to 'default' when no profileId given", async () => {
  clearRegistryCache();
  const ctx = await createProfileContext();
  assert.equal(ctx.profileId, "default");
});

test("createProfileContext throws for unknown profile", async () => {
  clearRegistryCache();
  await assert.rejects(
    () => createProfileContext("nonexistent-profile"),
    /not found/
  );
});

test("createProfileContext resolves inheritance (legal extends default)", async () => {
  clearRegistryCache();
  const ctx = await createProfileContext("legal");
  assert.equal(ctx.profileId, "legal");
  assert.equal(ctx.get("parser").ocrMode, "auto", "inherits ocrMode from default");
  assert.equal(ctx.get("parser").ocrMaxAttempts, 3, "legal overrides ocrMaxAttempts");
});

test("get() returns empty object for unknown stage", async () => {
  clearRegistryCache();
  const ctx = await createProfileContext("default");
  const result = ctx.get("nonExistentStage");
  assert.deepEqual(result, {});
});

test("injectProfileEnv maps parser fields to PARSER_ env vars", async () => {
  clearRegistryCache();
  const ctx = await createProfileContext("default");
  const env = injectProfileEnv(ctx);

  assert.equal(env.PARSER_OCR_MODE, "auto");
  assert.ok("PARSER_OCR_LANGS" in env, "should include PARSER_OCR_LANGS");
  assert.ok("PARSER_OCR_MAX_ATTEMPTS" in env, "should include PARSER_OCR_MAX_ATTEMPTS");
  assert.equal(env.PARSER_OCR_MAX_ATTEMPTS, "2");
});

test("injectProfileEnv maps layout analyzer fields", async () => {
  clearRegistryCache();
  const ctx = await createProfileContext("default");
  const env = injectProfileEnv(ctx);

  assert.ok("LAYOUT_COLUMN_GAP_THRESHOLD_PERCENT" in env);
  assert.ok("LAYOUT_HEADING_SCORE_THRESHOLD" in env);
});

test("injectProfileEnv maps validator fields", async () => {
  clearRegistryCache();
  const ctx = await createProfileContext("default");
  const env = injectProfileEnv(ctx);

  if (ctx.get("validator").targetStandard != null) {
    assert.ok("VALIDATOR_TARGET_STANDARD" in env);
  }
});

test("injectProfileEnv with overridden parser produces correct env vars", async () => {
  clearRegistryCache();
  const ctx = await createProfileContext("default", {
    parser: { ocrMode: "force", ocrLanguages: "jpn+eng" }
  });
  const env = injectProfileEnv(ctx);

  assert.equal(env.PARSER_OCR_MODE, "force");
  assert.equal(env.PARSER_OCR_LANGS, "jpn+eng");
});

test("profile overrides propagate to stage env via the full flow", async () => {
  clearRegistryCache();
  const ctx = await createProfileContext("scanned-low-quality", {
    parser: { ocrMode: "force" }
  });
  const env = injectProfileEnv(ctx);

  assert.equal(env.PARSER_OCR_MODE, "force", "runtime override takes precedence");
  assert.ok(Number(env.PARSER_OCR_MAX_ATTEMPTS) >= 2, "base profile values preserved");
});
