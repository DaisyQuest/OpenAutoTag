# OpenAutoTag Portable Package Guide

The portable package is the non-servlet distribution path. It builds a folder
that can be zipped, copied to another machine, extracted, and run without TomEE,
system Node.js, npm, or system Java.

## What The Package Contains

Each portable package contains:

- `app/`: OpenAutoTag application source, public dashboard assets, pipeline
  modules, scripts, schemas, and `node_modules`.
- `runtime/node/`: a bundled Node.js 22 runtime for the target platform.
- `runtime/java/`: a bundled JDK 21 runtime for PDFBox, helper compilation, and
  veraPDF.
- `app/modules/validator/vendor/verapdf/`: the installed veraPDF runtime.
- `data/`: writable runtime data for uploads, jobs, caches, and manual CLI runs.
- `start.bat` / `start.sh`: dashboard launcher.
- `process-pdf.bat` / `process-pdf.sh`: one-file CLI launcher.

## Configure Download Sources

The portable builder uses `install_locations.cfg`. The same file can point at
public sources or internal mirrors:

- `[node_engine]`: Node.js 22 distribution archive source.
- `[node_modules]`: npm registry, treating all of `node_modules` as one
  dependency for the Node engine.
- `[java_runtime]`: JDK 21 archive source or local JDK path.
- `[verapdf]`: veraPDF installer source.
- `[fonts]`: Noto CJK font source.
- `[portable]`: output folder, package name, zip behavior, and default port.

Defaults use the public sources already used by the project.

## Build The Package

From the repository root:

```powershell
npm run portable:build
```

Equivalent direct invocation:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-portable.ps1
```

Useful options:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-portable.ps1 -DryRun
powershell -ExecutionPolicy Bypass -File .\scripts\build-portable.ps1 -NoZip
powershell -ExecutionPolicy Bypass -File .\scripts\build-portable.ps1 -OutputRoot C:\portable-builds
powershell -ExecutionPolicy Bypass -File .\scripts\build-portable.ps1 -ConfigPath C:\path\install_locations.cfg
```

The default output path is:

```text
dist/portable/OpenAutoTag-portable-<platform>-<arch>
dist/portable/OpenAutoTag-portable-<platform>-<arch>.zip
```

## Run After Extraction

Windows:

```bat
start.bat
```

Linux or macOS:

```sh
chmod +x ./start.sh ./process-pdf.sh
./start.sh
```

Then open:

```text
http://127.0.0.1:3001/
```

Set `PORT` before launching to use a different port.

## Command-Line PDF Processing

Windows:

```bat
process-pdf.bat C:\path\document.pdf
```

Linux or macOS:

```sh
./process-pdf.sh /path/document.pdf
```

By default, output is written under:

```text
data/manual-runs/<input-file-name>
```

Pass a second argument to choose a specific output directory.

## Notes And Limits

- Packages are platform-specific because Node and the JDK are platform-specific.
- Build Windows packages on Windows, Linux packages on Linux, and macOS packages
  on macOS unless you also provide platform-appropriate archives and validate
  the output.
- The builder does not require Gradle, Ant, or TomEE.
- The portable launchers put bundled Node and bundled Java first on `PATH`, then
  set `PIPELINE_DATA_ROOT`, `PIPELINE_JAVA_HOME`, `VALIDATOR_JAVA_HOME`, and
  `VERAPDF_PATH` to package-local paths.
