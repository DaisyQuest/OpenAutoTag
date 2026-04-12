# Java Servlet Packaging

This directory adds a parallel Java HTTP deployment path for the existing service. It does not replace the current Node server, and it does not modify the pipeline modules. The servlet keeps the current HTTP/UI surface and delegates workload execution to the existing Node CLI runners under [`orchestrator/`](C:/Users/tabur/Videos/BuildEverything/orchestrator).

## What it provides

- a single servlet entrypoint: `buildeverything.servlet.BuildEverythingServlet`
- an embedded-Jetty launcher for local Java HTTP hosting
- a WAR build for servlet-container deployment
- configurable Gradle and Ant builds that resolve the Java-side dependencies
- static UI reuse from [`orchestrator/public/`](C:/Users/tabur/Videos/BuildEverything/orchestrator/public)

## Important boundary

The HTTP server is Java. The workload execution remains the existing Node pipeline, invoked through its stable CLI contracts:

- `orchestrator/pipeline-runner.js`
- `orchestrator/redaction-runner.js`
- `orchestrator/tag-redaction-runner.js`

That preserves the current Node deployment path and avoids changes in owned module code.

## Configuration

Supported system properties and environment variables:

- `buildeverything.repoRoot` or `BUILD_EVERYTHING_REPO_ROOT`
- `buildeverything.nodeExecutable` or `BUILD_EVERYTHING_NODE_PATH`
- `buildeverything.runtimeRoot` or `PIPELINE_DATA_ROOT`
- `buildeverything.port`
- `buildeverything.remoteDownload.allowPrivateHosts`
- `buildeverything.remoteDownload.maxBytes`
- `buildeverything.remoteDownload.maxRedirects`
- `buildeverything.remoteDownload.probeBytes`
- `buildeverything.remoteDownload.timeoutMs`

## Gradle

```powershell
cd C:\Users\tabur\Videos\BuildEverything\servlet
gradle downloadDependencies
gradle test
gradle war
gradle runStandalone -Pport=3000
```

## Ant

```powershell
cd C:\Users\tabur\Videos\BuildEverything\servlet
ant download-dependencies
ant test
ant war
ant run-standalone
```

## Outputs

- Gradle WAR: `servlet/build/libs/buildeverything-servlet.war`
- Ant WAR: `servlet/build/dist/buildeverything-servlet.war`

Deploy the WAR at the root context if you want the existing browser assets to work without rewriting their absolute `/jobs/...` and `/workloads` calls.
