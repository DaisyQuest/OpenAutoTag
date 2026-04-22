# OpenAutoTag Perfect Studio Implementation Plan

## Scope

Deliver a Java Swing studio shell for PDF tagging, remediation, and validation while preserving the repository's contract-first module boundaries from `AGENTS.md`.

## Multi-Step Plan

1. Establish the studio surface
   - Add `PerfectStudioSwingApp` as a new Swing entrypoint instead of modifying the existing diff and introspector tools.
   - Build the shell with `BorderLayout`: menu, toolbar, tag tree, WYSIWYG canvas, properties tabs, reading-order list, validation table, and status bar.
   - Install FlatLaf reflectively when it is available on the runtime classpath, with a deterministic Swing fallback for JDK-only CI.

2. Implement deterministic interaction primitives
   - Add `CoordinateMapper` for PDF point-space to Swing pixel-space conversion across zoom, scroll, and HiDPI scale.
   - Add `SoftPageImageCache` for visible page plus adjacent-page memory retention with `SoftReference` reclamation.
   - Add `TagSpatialIndex` for page-scoped QuadTree hit testing and resize-handle detection.
   - Render canvas overlays through `VolatileImage` and repaint cached output after a 200 ms resize debounce.

3. Enforce contract-safe structure editing
   - Add `TagSchemaRules` backed by `contracts/tagging.schema.json`.
   - Reject reading-order drag/drop operations that violate table, row, cell, list, and figure containment.
   - Surface human-readable schema feedback for invalid drops.

4. Wire validation and remediation behavior
   - Display validator findings in a compliance table.
   - Reflect issues directly on the canvas with red hatch overlays.
   - Double-click an errored element to focus the remediation field in the properties panel.

5. Preserve headless execution
   - Add `PerfectStudioHeadlessRunner` to support `--headless -i <input.pdf> -o <output.pdf>`.
   - Invoke `orchestrator/pipeline-runner.js` as a child process and copy `06-tagged.pdf` to the requested output path.
   - Emit JSON to stdout and errors to stderr without linking Java to native validator internals.

6. Make it runnable
   - Add `runPerfectStudio` to `servlet/build.gradle`.
   - Add `run-perfect-studio` to `servlet/build.xml`.
   - Keep existing Swing launchers intact.

7. Verify continuously
   - Compile the new Java classes from a Node test with the installed JDK.
   - Exercise coordinate mapping, schema rules, QuadTree hit testing, LRU cache behavior, and headless orchestration with deterministic fixtures.
   - Run focused tests first, then the repository's curated CI test command when practical.

## Delivered Components

- `PerfectStudioSwingApp`: UI shell, toolbar, tree, canvas, tabs, validation table, status bar, async loading, async validation.
- `PerfectStudioHeadlessRunner`: contract-preserving headless orchestrator adapter.
- `CoordinateMapper`: deterministic coordinate conversion.
- `SoftPageImageCache`: bounded page image cache.
- `TagSpatialIndex`: QuadTree hit-test index.
- `TagSchemaRules`: contract-backed drag/drop schema guard.
- `StudioTag`: immutable tag tree model for UI state.
