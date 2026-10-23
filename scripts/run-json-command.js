import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import os from "node:os";
import path from "node:path";

// Keep the CLI's JSON contract, without execFile's buffered stdout ceiling.
// Disk output, stderr and runtime are bounded; a partial result is never parsed.
export async function runJsonCommand(command, args, {
  cwd, env, timeout = 60000, maxOutputBytes = 128 * 1024 * 1024
} = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "json-command-"));
  let child, timer, completion;
  try {
    const file = path.join(dir, "result.json");
    child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "", stderrBytes = 0, timedOut = false;
    child.stderr.on("data", chunk => {
      if (stderrBytes < 65536) stderr += chunk.subarray(0, 65536 - stderrBytes).toString("utf8");
      stderrBytes += chunk.length;
    });
    completion = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (timedOut) reject(new Error(`JSON command timed out after ${timeout}ms`));
        else if (code !== 0) reject(new Error(`JSON command failed (${code ?? signal}): ${stderr.trim()}${stderrBytes > 65536 ? " [stderr truncated]" : ""}`));
        else resolve();
      });
    });
    timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    let bytes = 0;
    const limit = new Transform({ transform(chunk, encoding, callback) {
      bytes += chunk.length;
      callback(bytes > maxOutputBytes ? new Error(`JSON command output exceeds ${maxOutputBytes} bytes`) : null, chunk);
    } });
    const transfer = pipeline(child.stdout, limit, createWriteStream(file, { flags: "wx" }));
    try { await Promise.all([completion, transfer]); }
    catch (error) {
      child.kill();
      await Promise.allSettled([completion, transfer]);
      throw error;
    }
    return JSON.parse(await readFile(file, "utf8"));
  } finally {
    clearTimeout(timer);
    await rm(dir, { recursive: true, force: true });
  }
}
