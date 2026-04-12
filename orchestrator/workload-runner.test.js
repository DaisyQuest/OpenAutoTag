import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runJsonStage, runManagedWorkload } from "./workload-runner.js";

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

test("runManagedWorkload stages the source file so later stages survive source removal", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "workload-runner-stage-source-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));

  const sourcePath = path.join(tempDir, "source.pdf");
  const outputDir = path.join(tempDir, "output");
  const removalReportPath = path.join(outputDir, "01-removal-report.json");
  const lateReadReportPath = path.join(outputDir, "02-late-read.json");
  const lateReadArtifactPath = path.join(outputDir, "02-late-read.txt");

  await writeFile(sourcePath, "stable source payload");

  const job = await runManagedWorkload({
    filePath: sourcePath,
    outputDir,
    jobId: "stage-source-test",
    workload: {
      id: "test-workload",
      label: "Test Workload"
    },
    buildStagePlan: ({ filePath, sourceFilePath, resolvedOutputDir }) => [
      {
        key: "removeSource",
        label: "remove-source",
        outputPath: removalReportPath,
        run: async () => {
          await rm(sourceFilePath, { force: true });
          await writeFile(removalReportPath, `${JSON.stringify({ removedSourceFilePath: sourceFilePath }, null, 2)}\n`);
          return {
            outputPath: removalReportPath
          };
        }
      },
      {
        key: "lateRead",
        label: "late-read",
        outputPath: lateReadReportPath,
        run: async () => {
          const stagedContents = await readFile(filePath, "utf8");
          await writeFile(lateReadArtifactPath, stagedContents);
          await writeFile(
            lateReadReportPath,
            `${JSON.stringify({ stagedFilePath: filePath, lateReadArtifactPath }, null, 2)}\n`
          );
          return {
            outputPath: lateReadReportPath,
            artifacts: {
              lateReadArtifact: lateReadArtifactPath
            }
          };
        }
      }
    ]
  });

  assert.equal(job.status, "completed");
  assert.equal(await readFile(lateReadArtifactPath, "utf8"), "stable source payload");
  await assert.rejects(() => access(sourcePath));
  assert.equal(job.input.filePath, path.resolve(sourcePath));
  assert.equal(job.input.stagedFilePath, path.resolve(path.join(outputDir, "00-source.pdf")));
});
