# OpenAutoTag TomEE Servlet Install Guide

This guide describes how to build and deploy the OpenAutoTag servlet WAR to
Apache TomEE. It is written for TomEE 10.x, which uses Jakarta EE 10 and the
`jakarta.servlet` APIs required by the servlet module.

## What TomEE Runs

The TomEE deployment is a Java HTTP front end for OpenAutoTag. The WAR contains
the servlet, static dashboard assets, and Java dependencies that are safe to ship
inside the web application. It does not contain the full pipeline runtime.

At request time, the servlet starts existing Node.js runners from a real
OpenAutoTag checkout:

- `orchestrator/pipeline-runner.js`
- `orchestrator/redaction-runner.js`
- `orchestrator/tag-redaction-runner.js`

Because of that architecture, a working TomEE install needs both of these:

- The deployed servlet WAR.
- A complete OpenAutoTag repository checkout with installed Node dependencies.

Deploy the WAR at the root context when possible. The dashboard uses root-based
API paths such as `/jobs`, `/workloads`, `/difftool`, and `/introspector`.

## Required Versions

Use these versions or newer compatible versions:

- Apache TomEE 10.x, preferably TomEE Plus 10.1.x or later.
- Java 21 JDK for TomEE and for pipeline helper tooling.
- Node.js 22.x.
- npm compatible with the selected Node.js runtime.
- veraPDF installed through the project installer or configured with
  `VERAPDF_PATH`.

Older TomEE versions are not a drop-in target:

- TomEE 8 uses `javax.servlet`, while this servlet uses `jakarta.servlet`.
- TomEE 9 targets earlier Jakarta versions and should be avoided unless the
  servlet API level is validated explicitly.
- The servlet uses Java virtual threads, so Java 21 is required.

## Recommended Directory Layout

Use explicit paths instead of relying on TomEE's process working directory.

Windows example:

```text
C:\OpenAutoTag\OpenAutoTag        OpenAutoTag repository checkout
C:\OpenAutoTag\runtime            Writable runtime data root
C:\apache-tomee                   TomEE home
```

Linux example:

```text
/opt/openautotag/OpenAutoTag      OpenAutoTag repository checkout
/var/lib/openautotag              Writable runtime data root
/opt/apache-tomee                 TomEE home
```

The TomEE process user must be able to read the repository checkout and write to
the runtime data root.

## Prepare the Repository

Run these commands from the OpenAutoTag repository root.

```powershell
git fetch origin
git pull origin main
npm ci
npm run install:verapdf
```

Optional but recommended before deployment:

```powershell
npm run test:ci
```

If `npm run install:verapdf` cannot be used in the deployment environment, install
veraPDF separately and set `VERAPDF_PATH` to the `verapdf` executable. On
Windows this is usually a `.bat` file.

## Bootstrap from Config

For repeatable TomEE preparation, use the servlet bootstrap script. It reads
`install_locations.cfg`, where each downloadable dependency can point at a public
source or an internal mirror. The default config uses the public URLs used by the
project: Node.js official distribution archives, the npm registry as one
`node_modules` dependency source, veraPDF releases, Noto CJK fonts, and Maven
Central.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap-servlet-env.ps1
```

Useful options:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap-servlet-env.ps1 -DryRun
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap-servlet-env.ps1 -BuildWar
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap-servlet-env.ps1 -ConfigPath C:\path\install_locations.cfg
```

The script prepares or selects Node 22, runs `npm ci` against the configured
registry, installs veraPDF and CJK fallback fonts from configured URLs, resolves
servlet Java dependencies through the configured Maven repository, and writes
TomEE `setenv` templates under `.servlet-bootstrap`.

## Build the WAR

Gradle is the preferred build path:

```powershell
cd servlet
gradle clean test war
```

The produced WAR is written under:

```text
servlet\build\libs\
```

The file name may include the project version. Copy or rename the produced WAR
as needed for deployment.

Ant is also supported:

```powershell
cd servlet
ant download-dependencies
ant test
ant war
```

The Ant WAR is written to:

```text
servlet\build\dist\buildeverything-servlet.war
```

## Configure TomEE Environment

Prefer TomEE `setenv` files or your service manager for configuration. The
servlet reads servlet init parameters and environment variables. Do not rely on
Java system properties for the TomEE deployment unless you also wire them into
servlet init parameters.

### Windows `bin\setenv.bat`

Create or edit `%TOMEE_HOME%\bin\setenv.bat`:

```bat
set "JAVA_HOME=C:\Program Files\Microsoft\jdk-21.0.6.7-hotspot"
set "BUILD_EVERYTHING_REPO_ROOT=C:\OpenAutoTag\OpenAutoTag"
set "BUILD_EVERYTHING_NODE_PATH=C:\Program Files\nodejs\node.exe"
set "PIPELINE_DATA_ROOT=C:\OpenAutoTag\runtime"
set "PIPELINE_JAVA_HOME=%JAVA_HOME%"
set "VERAPDF_PATH=C:\OpenAutoTag\OpenAutoTag\modules\validator\vendor\verapdf\app\verapdf.bat"
set "CATALINA_OPTS=%CATALINA_OPTS% -Xms512m -Xmx4g"
```

### Linux `bin/setenv.sh`

Create or edit `$TOMEE_HOME/bin/setenv.sh`:

```sh
#!/usr/bin/env sh
export JAVA_HOME=/usr/lib/jvm/jdk-21
export BUILD_EVERYTHING_REPO_ROOT=/opt/openautotag/OpenAutoTag
export BUILD_EVERYTHING_NODE_PATH=/usr/bin/node
export PIPELINE_DATA_ROOT=/var/lib/openautotag
export PIPELINE_JAVA_HOME="$JAVA_HOME"
export VERAPDF_PATH=/opt/openautotag/OpenAutoTag/modules/validator/vendor/verapdf/app/verapdf
export CATALINA_OPTS="$CATALINA_OPTS -Xms512m -Xmx4g"
```

Make the file executable:

```sh
chmod +x "$TOMEE_HOME/bin/setenv.sh"
```

### Core Settings

These are the settings most deployments should define:

| Setting | Required | Purpose |
| --- | --- | --- |
| `BUILD_EVERYTHING_REPO_ROOT` | Yes | Absolute path to the OpenAutoTag checkout. |
| `BUILD_EVERYTHING_NODE_PATH` | Yes | Absolute path to the Node.js executable. |
| `PIPELINE_DATA_ROOT` | Yes | Writable root for jobs, uploads, caches, and runtime files. |
| `PIPELINE_JAVA_HOME` | Recommended | JDK used by pipeline Java helper tooling. |
| `JAVA_HOME` | Yes | JDK used by TomEE. |
| `VERAPDF_PATH` | Recommended | Explicit veraPDF executable path. |
| `VERAPDF_FLAVOUR` | Optional | veraPDF flavour, defaults to `ua1`. |

If `PIPELINE_DATA_ROOT` is not set, the servlet checks `APP_RUNTIME_ROOT`, then
some hosted-environment defaults, then falls back to `tmp` under the repository.
For TomEE, set `PIPELINE_DATA_ROOT` explicitly.

### Remote PDF Download Settings

The `/process-pdf-url` endpoint uses conservative defaults:

| Setting | Default | Purpose |
| --- | --- | --- |
| `BUILD_EVERYTHING_REMOTE_ALLOW_PRIVATE_HOSTS` | `false` | Whether private or loopback hosts can be fetched. |
| `BUILD_EVERYTHING_REMOTE_MAX_BYTES` | `52428800` | Maximum downloaded PDF size in bytes. |
| `BUILD_EVERYTHING_REMOTE_MAX_REDIRECTS` | `5` | Redirect limit. |
| `BUILD_EVERYTHING_REMOTE_PROBE_BYTES` | `1024` | Initial probe size. |
| `BUILD_EVERYTHING_REMOTE_TIMEOUT_MS` | `15000` | Request timeout in milliseconds. |

Only enable private host downloads in a trusted network.

### Servlet Init Parameter Alternative

Environment variables are simpler for TomEE operations, but the servlet also
supports init parameters inside `WEB-INF/web.xml`. Put these inside the existing
`<servlet>` element before rebuilding the WAR:

```xml
<init-param>
  <param-name>buildeverything.repoRoot</param-name>
  <param-value>C:\OpenAutoTag\OpenAutoTag</param-value>
</init-param>
<init-param>
  <param-name>buildeverything.runtimeRoot</param-name>
  <param-value>C:\OpenAutoTag\runtime</param-value>
</init-param>
<init-param>
  <param-name>buildeverything.nodeExecutable</param-name>
  <param-value>C:\Program Files\nodejs\node.exe</param-value>
</init-param>
```

Remote download settings are also available as init parameters using names such
as `buildeverything.remoteDownload.maxBytes`.

## Deploy to TomEE

Stop TomEE before replacing the WAR.

Windows:

```powershell
cd $env:TOMEE_HOME
.\bin\shutdown.bat
```

Linux:

```sh
cd "$TOMEE_HOME"
./bin/shutdown.sh
```

Deploy at the root context:

1. Remove any existing `webapps\ROOT.war` and unpacked `webapps\ROOT` directory.
2. Copy the OpenAutoTag WAR to `webapps\ROOT.war`.
3. Start TomEE.

Windows example:

```powershell
Remove-Item "$env:TOMEE_HOME\webapps\ROOT.war" -Force -ErrorAction SilentlyContinue
Remove-Item "$env:TOMEE_HOME\webapps\ROOT" -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item "C:\OpenAutoTag\OpenAutoTag\servlet\build\libs\buildeverything-servlet-0.1.0.war" "$env:TOMEE_HOME\webapps\ROOT.war"
cd $env:TOMEE_HOME
.\bin\startup.bat
```

Linux example:

```sh
rm -f "$TOMEE_HOME/webapps/ROOT.war"
rm -rf "$TOMEE_HOME/webapps/ROOT"
cp /opt/openautotag/OpenAutoTag/servlet/build/libs/buildeverything-servlet-0.1.0.war "$TOMEE_HOME/webapps/ROOT.war"
cd "$TOMEE_HOME"
./bin/startup.sh
```

If deploying under a non-root context such as `/openautotag`, place the WAR at
`webapps/openautotag.war`. This is not the recommended setup unless a reverse
proxy rewrites root-based API paths or the dashboard is adjusted for the context
path.

## TomEE Connector Notes

TomEE normally serves HTTP on port 8080. Confirm the connector in:

```text
$TOMEE_HOME/conf/server.xml
```

For large PDF uploads, tune connector upload limits if needed. A common local
configuration is:

```xml
<Connector port="8080"
           protocol="HTTP/1.1"
           connectionTimeout="20000"
           redirectPort="8443"
           maxPostSize="-1"
           maxSwallowSize="-1" />
```

Use deployment-specific limits in production. Unlimited upload settings should
be paired with network, authentication, and storage protections.

## Smoke Test

After TomEE starts, check the logs first:

```text
$TOMEE_HOME/logs/catalina.out
$TOMEE_HOME/logs/localhost.*.log
```

Then open these URLs:

```text
http://localhost:8080/health
http://localhost:8080/workloads
http://localhost:8080/
http://localhost:8080/introspector
http://localhost:8080/difftool
```

`/health` should report the configured runtime, jobs, and upload directories.
`/workloads` should return the available workload definitions. Finally, upload a
small PDF through the dashboard and confirm a job record and artifacts are
created under `PIPELINE_DATA_ROOT`.

## Security Checklist

The servlet deployment should be treated as an internal application unless an
authentication layer is added in front of it.

- Put TomEE behind a reverse proxy with TLS.
- Require SSO, basic auth, client certificates, VPN access, or TomEE container
  authentication before exposing the dashboard.
- Restrict `/process-pdf-url` remote downloads to trusted use cases.
- Keep `BUILD_EVERYTHING_REMOTE_ALLOW_PRIVATE_HOSTS=false` unless private
  network PDF fetching is required.
- Run TomEE as a dedicated low-privilege service account.
- Give the service account write access only to `PIPELINE_DATA_ROOT` and required
  read access to the repository checkout.
- Monitor runtime storage growth under jobs, uploads, and caches.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `404` for `/workloads` or `/jobs` | WAR is deployed under a non-root context. | Deploy as `ROOT.war` or add a reverse proxy rewrite. |
| `Cannot run program node` | TomEE cannot find Node.js. | Set `BUILD_EVERYTHING_NODE_PATH` to the full executable path. |
| Node reports missing modules | `node_modules` is absent or not readable. | Run `npm ci` in the repository checkout as the deployment user or fix permissions. |
| veraPDF not found | Vendor install is missing or path detection failed. | Run `npm run install:verapdf` or set `VERAPDF_PATH`. |
| Java helper tooling fails | TomEE is using a JRE or wrong Java install. | Use a Java 21 JDK and set `JAVA_HOME` plus `PIPELINE_JAVA_HOME`. |
| Uploads fail before reaching the servlet | TomEE connector upload limits are too low. | Tune `maxPostSize` and `maxSwallowSize` in `server.xml`. |
| Jobs fail with permission errors | Runtime root is not writable by TomEE. | Set `PIPELINE_DATA_ROOT` to a writable directory and fix ownership. |
| Static dashboard looks stale | WAR contains older copied public assets. | Rebuild the WAR after frontend asset changes. |
| Remote URL processing rejects private hosts | Private host download protection is active. | Keep it disabled for safety, or explicitly set `BUILD_EVERYTHING_REMOTE_ALLOW_PRIVATE_HOSTS=true` in trusted deployments. |

## Redeploy Checklist

Use this sequence for upgrades:

1. Pull the latest OpenAutoTag checkout.
2. Run `npm ci` if `package-lock.json` changed.
3. Reinstall or verify veraPDF if validator dependencies changed.
4. Run the project test suite appropriate for the release.
5. Build a fresh servlet WAR.
6. Stop TomEE.
7. Replace `ROOT.war` and remove the unpacked `ROOT` directory.
8. Start TomEE.
9. Check `/health`, `/workloads`, and one sample PDF job.

## Local Embedded Servlet Runner

The servlet module also includes an embedded Jetty runner for local development:

```powershell
cd servlet
gradle runStandalone -Pport=3000
```

or:

```powershell
cd servlet
ant run-standalone
```

This runner is useful for development smoke tests, but it is separate from the
TomEE deployment path.
