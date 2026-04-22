# OpenAutoTag Perfect Studio Test Matrix

| Area | Requirement | Test Type | Deterministic Assertion |
| --- | --- | --- | --- |
| Layout shell | Menu, toolbar, tree, canvas, right tabs, and status bar exist | Java compile plus source smoke | `PerfectStudioSwingApp` compiles with JDK-only classpath |
| Headless CLI | `--headless -i input.pdf -o output.pdf` bypasses UI | Unit harness with fake process executor | Runner invokes `orchestrator/pipeline-runner.js`, copies `06-tagged.pdf`, emits JSON |
| Coordinate mapping | PDF points map to Swing pixels with zoom and HiDPI | Unit harness | PDF box round-trips through `toScreen` and `toPdf` within tolerance |
| Memory control | Only visible page and adjacent pages remain cached | Unit harness | Access-ordered cache evicts beyond max and `retainAround()` keeps `current +/- 1` |
| Spatial index | Canvas hit testing is sub-linear and prefers nested targets | Unit harness | QuadTree returns the smallest containing tag at a point |
| Schema guard | Invalid table/list reparenting is rejected | Unit harness | `<TD>` outside `<TR>` and `<P>` directly under `<Table>` are rejected |
| Contract vocabulary | UI tag options come from `contracts/tagging.schema.json` | Unit harness | Schema loader exposes expected valid types and rejects unknown tags |
| Validation overlays | Error findings are visible on canvas | Java compile plus model assertion | Validation issue list binds to tag ids consumed by canvas painting |
| Remediation focus | Double-clicking an error focuses the relevant field | Manual UI smoke | Figure without alternate text focuses Alternate Text |
| Responsiveness | Resize does not trigger immediate expensive reraster loops | Java compile plus source smoke | Canvas owns a 200 ms debounce timer and invalidates cached buffer after resize |
| HiDPI/vector | Icons avoid raster assets | Java compile plus source smoke | Toolbar uses vector-painted `Icon` instances and no raster files |
| Existing CI | New work does not break existing Node tests | Command test | `node --test test/unit/perfect-studio-java.test.js` and targeted existing tests pass |

## Manual Smoke Checklist

1. Launch the studio through `servlet` build tooling.
2. Confirm the first viewport opens at a 1440 by 900 preferred size and remains usable at 1024 by 768.
3. Select tree nodes and confirm canvas selection, properties fields, and status text update together.
4. Run Compliance Validation and confirm the validation table and canvas hatch overlay update.
5. Hold Space or Alt over the canvas and confirm X-Ray mode dims the page while strengthening overlays.
6. Try dropping table content outside a valid table row and confirm the operation is rejected.
7. Run headless mode on a known fixture PDF and inspect the JSON stdout plus copied output PDF.
