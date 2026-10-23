import test from "node:test";
import assert from "node:assert/strict";
import { runJsonCommand } from "../../scripts/run-json-command.js";

test("file-backed JSON handles output beyond the former 32 MiB ceiling and Unicode", async () => {
  const result = await runJsonCommand(process.execPath, ["-e", 'process.stdout.write(JSON.stringify({text:"’—é",data:"x".repeat(33*1024*1024)}))']);
  assert.equal(result.text, "’—é");
  assert.equal(result.data.length, 33 * 1024 * 1024);
});
test("JSON command rejects partial output, process errors, limits and timeout", async () => {
  const run = (code, options) => runJsonCommand(process.execPath, ["-e", code], options);
  await assert.rejects(run('process.stdout.write("{")'), SyntaxError);
  await assert.rejects(run('console.log("{}"); console.error("diagnostic"); process.exitCode=2'), /failed.*diagnostic/);
  await assert.rejects(run('process.stdout.write("x".repeat(10000))', {maxOutputBytes:100}), /exceeds 100 bytes/);
  await assert.rejects(run('setInterval(()=>{},1000)', {timeout:150}), /timed out/);
  await assert.rejects(runJsonCommand("nonexistent-oat-json-command-32831", []), /ENOENT/);
  await assert.rejects(run('process.stderr.write("e".repeat(70000)); process.exitCode=1'), /stderr truncated/);
});
