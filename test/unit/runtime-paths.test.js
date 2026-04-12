import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  getRuntimeBuildDir,
  getRuntimeRoot,
  getRuntimeSubdir,
  isAzureAppServiceRuntime
} from "../../scripts/runtime-paths.js";

function withEnv(overrides, callback) {
  const previousValues = new Map();

  for (const [key, value] of Object.entries(overrides)) {
    previousValues.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    if (value == null) {
      delete process.env[key];
      continue;
    }

    process.env[key] = value;
  }

  try {
    return callback();
  } finally {
    for (const [key, value] of previousValues.entries()) {
      if (value === undefined) {
        delete process.env[key];
        continue;
      }

      process.env[key] = value;
    }
  }
}

test("runtime paths prefer explicit data root overrides", () => {
  withEnv(
    {
      PIPELINE_DATA_ROOT: "/tmp/custom-runtime-root",
      WEBSITE_SITE_NAME: null,
      WEBSITE_RUN_FROM_PACKAGE: null
    },
    () => {
      assert.equal(getRuntimeRoot({ repoRoot: "/repo" }), path.resolve("/tmp/custom-runtime-root"));
      assert.equal(getRuntimeSubdir("jobs", { repoRoot: "/repo" }), path.resolve("/tmp/custom-runtime-root", "jobs"));
    }
  );
});

test("runtime paths switch to a writable home-backed location on Azure App Service", () => {
  withEnv(
    {
      PIPELINE_DATA_ROOT: null,
      WEBSITE_SITE_NAME: "pdf-st",
      WEBSITE_RUN_FROM_PACKAGE: "1",
      HOME: "/home"
    },
    () => {
      assert.equal(isAzureAppServiceRuntime(), true);
      assert.equal(getRuntimeRoot({ repoRoot: "/repo" }), path.resolve("/home", "data", "openautotag"));
    }
  );
});

test("runtime paths stay repo-local outside Azure when no override is configured", () => {
  withEnv(
    {
      PIPELINE_DATA_ROOT: null,
      WEBSITE_SITE_NAME: null,
      WEBSITE_RUN_FROM_PACKAGE: null,
      WEBSITES_ENABLE_APP_SERVICE_STORAGE: null
    },
    () => {
      assert.equal(isAzureAppServiceRuntime(), false);
      assert.equal(getRuntimeRoot({ repoRoot: "/repo" }), path.resolve("/repo", "tmp"));
    }
  );
});

test("runtime build paths stay stable across processes for shared helper reuse", () => {
  withEnv(
    {
      PIPELINE_DATA_ROOT: null,
      WEBSITE_SITE_NAME: null,
      WEBSITE_RUN_FROM_PACKAGE: null,
      WEBSITES_ENABLE_APP_SERVICE_STORAGE: null
    },
    () => {
      assert.equal(
        getRuntimeBuildDir("modules-validator", { repoRoot: "/repo" }),
        path.resolve("/repo", "tmp", "build", "modules-validator")
      );
    }
  );
});
