const DEFAULT_AGENT_STALE_GRACE_MS = 30_000;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cloneJsonValue(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeText(value, fallback = "") {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

function normalizeInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function computeStaleWindowMs(agent) {
  const intervals = [
    normalizeInteger(agent?.heartbeatIntervalMs, 0) * 3,
    normalizeInteger(agent?.checkInIntervalMs, 0) * 3,
    DEFAULT_AGENT_STALE_GRACE_MS
  ];

  return Math.max(...intervals);
}

function isAgentStale(agent, now = new Date()) {
  const lastSeenAt = new Date(agent?.lastSeenAt || 0).getTime();
  if (!Number.isFinite(lastSeenAt) || lastSeenAt <= 0) {
    return true;
  }

  return now.getTime() - lastSeenAt > computeStaleWindowMs(agent);
}

function summarizeAgent(agent, now = new Date()) {
  return {
    ...clone(agent),
    stale: isAgentStale(agent, now)
  };
}

export function createAgentRegistry() {
  const agents = new Map();

  function getOrThrowAgent(agentId) {
    const resolvedAgentId = normalizeText(agentId);
    if (!resolvedAgentId) {
      throw new Error("agentId is required.");
    }

    return resolvedAgentId;
  }

  function touchAgent(agentId, patch = {}, timestamp = new Date().toISOString()) {
    const current = agents.get(agentId) || {
      agentId,
      registeredAt: timestamp,
      jobsClaimed: 0,
      jobsCompleted: 0,
      jobsFailed: 0
    };

    const next = {
      ...current,
      ...cloneJsonValue(patch),
      agentId,
      updatedAt: timestamp,
      lastSeenAt: timestamp
    };

    if (!next.label) {
      next.label = next.hostname || agentId;
    }

    agents.set(agentId, next);
    return next;
  }

  return {
    checkIn(report = {}) {
      const agentId = getOrThrowAgent(report.agentId);
      const timestamp = new Date().toISOString();
      const currentJobId = normalizeText(report.currentJobId);
      const status = currentJobId ? "busy" : normalizeText(report.status, "idle");
      const next = touchAgent(
        agentId,
        {
          label: normalizeText(report.label, report.hostname || agentId),
          hostname: normalizeText(report.hostname) || null,
          version: normalizeText(report.version) || null,
          platform: normalizeText(report.platform) || null,
          arch: normalizeText(report.arch) || null,
          pid: normalizeInteger(report.pid, 0) || null,
          startedAt: normalizeText(report.startedAt) || null,
          checkInIntervalMs: normalizeInteger(report.checkInIntervalMs, 0) || null,
          heartbeatIntervalMs: normalizeInteger(report.heartbeatIntervalMs, 0) || null,
          capabilities: cloneJsonValue(report.capabilities) || null,
          runtime: cloneJsonValue(report.runtime) || null,
          status,
          currentJobId: currentJobId || null,
          currentWorkloadId: normalizeText(report.currentWorkloadId) || null,
          currentMessage: normalizeText(report.currentMessage) || null,
          currentStage: cloneJsonValue(report.currentStage) || null
        },
        timestamp
      );

      return summarizeAgent(next);
    },
    noteClaim(agentId, { jobId, workload, heartbeatIntervalMs } = {}) {
      const resolvedAgentId = getOrThrowAgent(agentId);
      const timestamp = new Date().toISOString();
      const current = agents.get(resolvedAgentId);
      const next = touchAgent(
        resolvedAgentId,
        {
          label: current?.label || resolvedAgentId,
          status: "busy",
          currentJobId: normalizeText(jobId) || null,
          currentWorkloadId: normalizeText(workload?.id) || null,
          currentMessage: "Downloading source workspace from the master.",
          currentStage: null,
          heartbeatIntervalMs: normalizeInteger(heartbeatIntervalMs, current?.heartbeatIntervalMs || 0) || null,
          jobsClaimed: Number(current?.jobsClaimed || 0) + 1
        },
        timestamp
      );

      return summarizeAgent(next);
    },
    noteHeartbeat(agentId, { jobId, statusDetail } = {}) {
      const resolvedAgentId = getOrThrowAgent(agentId);
      const timestamp = new Date().toISOString();
      const current = agents.get(resolvedAgentId);
      const next = touchAgent(
        resolvedAgentId,
        {
          label: current?.label || resolvedAgentId,
          status: normalizeText(jobId) ? "busy" : "idle",
          currentJobId: normalizeText(jobId) || null,
          currentMessage: normalizeText(statusDetail?.message) || current?.currentMessage || null,
          currentStage: cloneJsonValue(statusDetail?.currentStage) ?? current?.currentStage ?? null,
          heartbeatIntervalMs: normalizeInteger(statusDetail?.heartbeatIntervalMs, current?.heartbeatIntervalMs || 0) || null
        },
        timestamp
      );

      return summarizeAgent(next);
    },
    noteCompletion(agentId, { jobId, status, error } = {}) {
      const resolvedAgentId = getOrThrowAgent(agentId);
      const timestamp = new Date().toISOString();
      const current = agents.get(resolvedAgentId);
      const completed = status === "completed";
      const failed = status === "failed";
      const next = touchAgent(
        resolvedAgentId,
        {
          label: current?.label || resolvedAgentId,
          status: "idle",
          currentJobId: null,
          currentWorkloadId: null,
          currentMessage: completed
            ? `Completed job ${jobId}.`
            : failed
              ? `Job ${jobId} failed.`
              : current?.currentMessage || null,
          currentStage: null,
          lastCompletedAt: timestamp,
          lastResult: normalizeText(status) || null,
          lastError: failed ? normalizeText(error) || "Remote job failed." : null,
          jobsCompleted: Number(current?.jobsCompleted || 0) + (completed ? 1 : 0),
          jobsFailed: Number(current?.jobsFailed || 0) + (failed ? 1 : 0)
        },
        timestamp
      );

      return summarizeAgent(next);
    },
    noteLeaseExpiry(expiredAssignments = []) {
      const timestamp = new Date().toISOString();

      for (const assignment of expiredAssignments) {
        const agentId = normalizeText(assignment?.agentId);
        if (!agentId || !agents.has(agentId)) {
          continue;
        }

        touchAgent(
          agentId,
          {
            status: "stale",
            currentJobId: null,
            currentWorkloadId: null,
            currentStage: null,
            currentMessage: `Lease expired for job ${assignment.jobId}.`,
            lastError: `Lease expired for job ${assignment.jobId}.`
          },
          timestamp
        );
      }
    },
    get(agentId) {
      const agent = agents.get(normalizeText(agentId));
      return agent ? summarizeAgent(agent) : null;
    },
    list() {
      const now = new Date();
      return [...agents.values()]
        .map((agent) => summarizeAgent(agent, now))
        .sort(
          (left, right) =>
            Number(left.stale) - Number(right.stale) ||
            String(right.lastSeenAt || "").localeCompare(String(left.lastSeenAt || "")) ||
            left.label.localeCompare(right.label)
        );
    },
    countIdle() {
      const now = new Date();
      return [...agents.values()].filter((agent) => !isAgentStale(agent, now) && agent.status === "idle").length;
    },
    stats() {
      const summary = {
        total: 0,
        idle: 0,
        busy: 0,
        stale: 0,
        jobsClaimed: 0,
        jobsCompleted: 0,
        jobsFailed: 0
      };

      for (const agent of this.list()) {
        summary.total += 1;
        summary.jobsClaimed += Number(agent.jobsClaimed || 0);
        summary.jobsCompleted += Number(agent.jobsCompleted || 0);
        summary.jobsFailed += Number(agent.jobsFailed || 0);

        if (agent.stale) {
          summary.stale += 1;
        } else if (agent.status === "busy") {
          summary.busy += 1;
        } else {
          summary.idle += 1;
        }
      }

      return summary;
    }
  };
}
