import path from "node:path";
import { pathToFileURL } from "node:url";
import { createAgentService } from "./agent-service.js";
import { loadAgentRuntimeConfig } from "./agent-runtime-config.js";

const STATE_PUBLISH_INTERVAL_MS = 1000;

function safeSend(message) {
  if (typeof process.send === "function") {
    try {
      process.send(message);
    } catch {
      // Parent channel may have closed during shutdown; ignore.
    }
  }
}

async function main() {
  const workerIndex = Number(process.env.AGENT_WORKER_INDEX || 0);
  const workerTotal = Number(process.env.AGENT_WORKER_TOTAL || 1);
  const config = await loadAgentRuntimeConfig();

  if (!config?.masterEndpoint) {
    safeSend({ type: "fatal", workerIndex, message: "Missing masterEndpoint in agent runtime config." });
    process.exitCode = 2;
    return;
  }

  const runtimeRoot = process.env.AGENT_RUNTIME_ROOT || undefined;
  const workRoot = runtimeRoot ? path.join(runtimeRoot, "jobs") : undefined;

  const service = await createAgentService({
    ...config,
    ...(runtimeRoot ? { runtimeRoot } : {}),
    ...(workRoot ? { workRoot } : {}),
    enableHttpServer: false
  });

  let shuttingDown = false;
  let publishTimer = null;

  function publishState() {
    safeSend({
      type: "state",
      workerIndex,
      workerTotal,
      state: { ...service.state },
      reportedAt: new Date().toISOString()
    });
  }

  async function shutdown(reason) {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    if (publishTimer) {
      clearInterval(publishTimer);
      publishTimer = null;
    }

    safeSend({ type: "shutting-down", workerIndex, reason });

    try {
      await service.close();
    } catch (error) {
      safeSend({ type: "error", workerIndex, message: error?.message || String(error) });
    }

    publishState();
    safeSend({ type: "closed", workerIndex, reason });
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("message", (message) => {
    if (message && message.type === "shutdown") {
      shutdown("ipc");
    }
  });

  await service.start();
  safeSend({ type: "ready", workerIndex, agentId: service.state.agentId, label: service.state.label });
  publishState();
  publishTimer = setInterval(publishState, STATE_PUBLISH_INTERVAL_MS);
  publishTimer.unref?.();
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  main().catch((error) => {
    safeSend({ type: "fatal", message: error?.message || String(error) });
    process.stderr.write(`${error.stack || error.message || error}\n`);
    process.exitCode = 1;
  });
}
