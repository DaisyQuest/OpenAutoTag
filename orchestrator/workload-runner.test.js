import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runJsonStage } from "./workload-runner.js";

test("runJsonStage streams stage output larger than the legacy maxBuffer limit", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "workload-runner-stream-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));

  const scriptPath = path.join(tempDir, "emit-large-json.js");
  const outputPath = path.join(tempDir, "large-stage-output.json");

  await writeFile(
    scriptPath,
    [
      "process.stdout.write('{\"kind\":\"large-stage\",\"data\":\"');",
      'const chunk = "x".repeat(1024 * 1024);',
      "for (let index = 0; index < 12; index += 1) {",
      "  process.stdout.write(chunk);",
      "}",
      "process.stdout.write('\"}\\n');"
    ].join("\n")
  );

  const writtenPath = await runJsonStage(scriptPath, [], outputPath);
  const payload = JSON.parse(await readFile(outputPath, "utf8"));

  assert.equal(writtenPath, path.resolve(outputPath));
  assert.equal(payload.kind, "large-stage");
  assert.equal(payload.data.length, 12 * 1024 * 1024);
});

test("runJsonStage does not publish a partial artifact when the child process fails", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "workload-runner-failure-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));

  const scriptPath = path.join(tempDir, "fail-stage.js");
  const outputPath = path.join(tempDir, "failed-stage-output.json");

  await writeFile(
    scriptPath,
    [
      "process.stdout.write('{\"status\":\"partial\"}\\n');",
      "process.stderr.write('synthetic stage failure\\n');",
      "process.exitCode = 1;"
    ].join("\n")
  );

  await assert.rejects(() => runJsonStage(scriptPath, [], outputPath), /synthetic stage failure/);
  await assert.rejects(() => access(outputPath));
});
