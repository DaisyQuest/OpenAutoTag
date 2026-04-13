import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";

import { createEnvironmentAuthController } from "../../orchestrator/auth-controller.js";

function createRequest(headers = {}) {
  return {
    headers
  };
}

test("environment auth controller falls back to testing when ADMIN_KEY is unset", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "auth-controller-default-"));
  const auth = createEnvironmentAuthController({
    runtimeRoot,
    env: {
      PUBLIC_MODE: "false"
    }
  });

  const deniedAccess = await auth.describeAccess(createRequest());
  assert.equal(deniedAccess.adminAuthorized, false);

  const grantedAccess = await auth.describeAccess(
    createRequest({
      "x-admin-key": "testing"
    })
  );

  assert.equal(grantedAccess.adminAuthorized, true);
});

test("environment auth controller uses ADMIN_KEY when configured", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "auth-controller-configured-"));
  const auth = createEnvironmentAuthController({
    runtimeRoot,
    env: {
      PUBLIC_MODE: "false",
      ADMIN_KEY: "production-admin-secret"
    }
  });

  const wrongAccess = await auth.describeAccess(
    createRequest({
      "x-admin-key": "testing"
    })
  );
  assert.equal(wrongAccess.adminAuthorized, false);

  const grantedAccess = await auth.describeAccess(
    createRequest({
      "x-admin-key": "production-admin-secret"
    })
  );
  assert.equal(grantedAccess.adminAuthorized, true);
});
