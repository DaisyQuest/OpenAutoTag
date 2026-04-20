import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgentSupervisor } from "./agent-supervisor.js";
import { clampWorkerConcurrency, MAX_WORKER_CONCURRENCY } from "./agent-runtime-config.js";

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.killed = false;
    this.sent = [];
  }

  send(message) {
    this.sent.push(message);
    return true;
  }

  kill(signal) {
    this.killed = true;
    this.killSignal = signal;
  }

  simulateExit(code = 1, signal = null) {
    this.emit("exit", code, signal);
  }

  simulateMessage(message) {
    this.emit("message", message);
  }
}

function createForkRecorder() {
  const children = [];
  let nextPid = 10000;

  function fork(modulePath, args, options) {
    const child = new FakeChild(nextPid++);
    children.push({ child, modulePath, args, options });
    return child;
  }

  return { fork, children };
}

async function makeTempRoot(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-supervisor-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for supervisor state.");
}

test("clampWorkerConcurrency enforces the documented range", () => {
  assert.equal(clampWorkerConcurrency(0), 1);
  assert.equal(clampWorkerConcurrency(-3), 1);
  assert.equal(clampWorkerConcurrency(undefined), 1);
  assert.equal(clampWorkerConcurrency("not-a-number"), 1);
  assert.equal(clampWorkerConcurrency(3), 3);
  assert.equal(clampWorkerConcurrency(5), 5);
  assert.equal(clampWorkerConcurrency(6), MAX_WORKER_CONCURRENCY);
  assert.equal(clampWorkerConcurrency(100), MAX_WORKER_CONCURRENCY);
  assert.equal(clampWorkerConcurrency(2.7), 2);
});

test("createAgentSupervisor forks the requested number of workers with scoped env", async (t) => {
  const runtimeRoot = await makeTempRoot(t);
  const recorder = createForkRecorder();

  const supervisor = createAgentSupervisor({
    config: { masterEndpoint: "https://master.test/" },
    concurrency: 3,
    runtimeRoot,
    baseAgentId: "base-agent",
    baseLabel: "site",
    env: {},
    forkFn: recorder.fork,
    workerWatchdogMs: 0,
    logger: { warn() {}, error() {} }
  });

  await supervisor.start({ enableHttpServer: false });
  t.after(() => supervisor.close({ timeoutMs: 10 }));

  assert.equal(recorder.children.length, 3);

  const seenIndexes = recorder.children.map(({ options }) => options.env.AGENT_WORKER_INDEX);
  assert.deepEqual(seenIndexes, ["0", "1", "2"]);

  for (const [index, { options }] of recorder.children.entries()) {
    assert.equal(options.env.AGENT_ID, `base-agent-w${index}`);
    assert.equal(options.env.AGENT_LABEL, `site.w${index}`);
    assert.equal(options.env.AGENT_WORKER_TOTAL, "3");
    assert.equal(options.env.AGENT_RUNTIME_ROOT, path.join(runtimeRoot, "workers", `worker-${index}`));
    assert.equal(options.env.PORT, undefined);
  }
});

test("createAgentSupervisor respawns a crashed worker with exponential backoff", async (t) => {
  const runtimeRoot = await makeTempRoot(t);
  const recorder = createForkRecorder();

  const supervisor = createAgentSupervisor({
    config: { masterEndpoint: "https://master.test/" },
    concurrency: 1,
    runtimeRoot,
    baseAgentId: "base-agent",
    env: {},
    forkFn: recorder.fork,
    backoff: { initialMs: 20, maxMs: 80, stabilityThresholdMs: 60_000 },
    workerWatchdogMs: 0,
    logger: { warn() {}, error() {} }
  });

  await supervisor.start({ enableHttpServer: false });
  t.after(() => supervisor.close({ timeoutMs: 10 }));

  assert.equal(recorder.children.length, 1);
  const first = recorder.children[0].child;

  first.simulateExit(1);
  await waitFor(() => recorder.children.length >= 2);

  const secondSpawnDelay = Date.now();
  const second = recorder.children[1].child;
  second.simulateExit(1);

  await waitFor(() => recorder.children.length >= 3);
  const thirdSpawnDelay = Date.now() - secondSpawnDelay;

  // Second restart should wait longer than the first (>=~40ms after doubling from 20ms).
  assert.ok(thirdSpawnDelay >= 30, `expected backoff to grow; observed ${thirdSpawnDelay}ms`);

  const snapshot = supervisor.getSnapshot();
  assert.equal(snapshot.slots[0].restarts, 2);
});

test("createAgentSupervisor does not respawn workers once close() has been called", async (t) => {
  const runtimeRoot = await makeTempRoot(t);
  const recorder = createForkRecorder();

  const supervisor = createAgentSupervisor({
    config: { masterEndpoint: "https://master.test/" },
    concurrency: 2,
    runtimeRoot,
    baseAgentId: "base-agent",
    env: {},
    forkFn: recorder.fork,
    backoff: { initialMs: 10, maxMs: 40, stabilityThresholdMs: 60_000 },
    workerWatchdogMs: 0,
    logger: { warn() {}, error() {} }
  });

  await supervisor.start({ enableHttpServer: false });

  assert.equal(recorder.children.length, 2);
  const closePromise = supervisor.close({ timeoutMs: 50 });

  // Simulate the children obeying SIGTERM.
  for (const { child } of recorder.children) {
    assert.deepEqual(child.sent[0], { type: "shutdown" });
    child.simulateExit(0, "SIGTERM");
  }

  await closePromise;

  // No additional spawns after close.
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(recorder.children.length, 2);
  assert.equal(supervisor.getSnapshot().shuttingDown, true);
});

test("createAgentSupervisor aggregates worker state messages into the snapshot", async (t) => {
  const runtimeRoot = await makeTempRoot(t);
  const recorder = createForkRecorder();

  const supervisor = createAgentSupervisor({
    config: { masterEndpoint: "https://master.test/" },
    concurrency: 2,
    runtimeRoot,
    baseAgentId: "base-agent",
    env: {},
    forkFn: recorder.fork,
    workerWatchdogMs: 0,
    logger: { warn() {}, error() {} }
  });

  await supervisor.start({ enableHttpServer: false });
  t.after(() => supervisor.close({ timeoutMs: 10 }));

  recorder.children[0].child.simulateMessage({
    type: "state",
    workerIndex: 0,
    workerTotal: 2,
    state: { status: "busy", currentJobId: "job-abc", label: "site.w0", lastError: null, currentMessage: "Running." }
  });
  recorder.children[1].child.simulateMessage({
    type: "state",
    workerIndex: 1,
    workerTotal: 2,
    state: { status: "idle", currentJobId: null, label: "site.w1", lastError: null, currentMessage: "Idle." }
  });

  const snapshot = supervisor.getSnapshot();
  assert.equal(snapshot.summary.busy, 1);
  assert.equal(snapshot.summary.idle, 1);
  assert.equal(snapshot.slots[0].currentJobId, "job-abc");
  assert.equal(snapshot.slots[0].label, "site.w0");
  assert.equal(snapshot.slots[1].status, "idle");
});
