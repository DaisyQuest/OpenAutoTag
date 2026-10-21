import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PDFDocument, PDFName, PDFDict, PDFArray } from "pdf-lib";
import { writeTaggedArtifacts } from "../index.js";
import { createListFormFixture } from "./fixtures/list-form-fixture.js";

const name = PDFName.of;
async function setup(t, enabled = true) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "list-repair-"));
  const previous = process.env.PASSTHROUGH_REPAIR_LIST_FORMS;
  process.env.PASSTHROUGH_REPAIR_LIST_FORMS = enabled ? "1" : "0";
  t.after(async () => {
    if (previous === undefined) delete process.env.PASSTHROUGH_REPAIR_LIST_FORMS;
    else process.env.PASSTHROUGH_REPAIR_LIST_FORMS = previous;
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}
const dict = (doc, ref) => doc.context.lookup(ref, PDFDict);
const kids = (doc, ref) => dict(doc, ref).lookup(name("K"), PDFArray).asArray().map(String);

test("list repair preserves references, field values, appearances and order; second run is a no-op", async (t) => {
  const dir = await setup(t);
  for (const variant of ["valid", "array-body", "multi-widget"]) {
    const folder = path.join(dir, variant); await mkdir(folder);
    const fixture = await createListFormFixture(folder, variant), { item, label, body, forms } = fixture.refs;
    const outputPath = path.join(folder, "result.pdf");
    const result = await writeTaggedArtifacts({ ...fixture, outputPath, mode: "auto" });
    assert.equal(result.writerMode, "passthrough"); assert.equal(result.listFormContainersRepaired, 1);
    const original = await readFile(fixture.pdfPath), bytes = await readFile(outputPath);
    assert.deepEqual(bytes.subarray(0, original.length), original);
    const doc = await PDFDocument.load(bytes), source = await PDFDocument.load(original);
    assert.deepEqual(kids(doc, item), [label, body].map(String));
    assert.deepEqual(kids(doc, body), [String(forms[0]), "2", ...(forms[1] ? [String(forms[1])] : [])]);
    for (const ref of forms) {
      assert.equal(dict(doc, ref).get(name("P")).toString(), String(body));
      for (const key of ["K", "ID", "S"]) assert.equal(dict(doc, ref).get(name(key)).toString(), dict(source, ref).get(name(key)).toString());
    }
    for (const key of ["ParentTree", "IDTree"]) {
      const root = (d) => d.catalog.lookup(name("StructTreeRoot"), PDFDict).lookup(name(key), PDFDict).toString();
      assert.equal(root(doc), root(source));
    }
    assert.equal(doc.getForm().getFields().length, 2);
    assert.equal(doc.getForm().getTextField("details").getText(), "Existing details");
    assert.equal(doc.getForm().getCheckBox("request").isChecked(), true);
    // Exercise fill/save/reopen separately from the preserved repair output.
    doc.getForm().getTextField("details").setText("Updated details"); doc.getForm().getCheckBox("request").uncheck();
    const filledPath = path.join(folder, "filled.pdf"); await writeFile(filledPath, await doc.save());
    const filled = await PDFDocument.load(await readFile(filledPath));
    assert.equal(filled.getForm().getTextField("details").getText(), "Updated details");
    assert.equal(filled.getForm().getCheckBox("request").isChecked(), false);
    const again = await writeTaggedArtifacts({ ...fixture, pdfPath: outputPath, outputPath: path.join(folder, "again.pdf"), mode: "auto" });
    assert.equal(again.listFormContainersRepaired, 0);
  }
});

test("list repair is opt-in", async (t) => {
  const dir = await setup(t, false), fixture = await createListFormFixture(dir);
  const result = await writeTaggedArtifacts({ ...fixture, outputPath: path.join(dir, "result.pdf"), mode: "auto" });
  assert.equal(result.listFormContainersRepaired, 0);
  const doc = await PDFDocument.load(await readFile(result.outputPath));
  assert.equal(kids(doc, fixture.refs.item).length, 4);
});

test("ambiguous list shapes, cross-page forms and malformed ownership remain unchanged", async (t) => {
  const dir = await setup(t);
  for (const variant of ["multiple-bodies", "unknown-role", "raw-item-content", "shared-form", "duplicate-widget", "no-body", "bad-parent", "ambiguous-form", "empty-body", "nested-body", "cross-page"]) {
    const folder = path.join(dir, variant); await mkdir(folder);
    const fixture = await createListFormFixture(folder, variant);
    const result = await writeTaggedArtifacts({ ...fixture, outputPath: path.join(folder, "result.pdf"), mode: "auto" });
    assert.equal(result.listFormContainersRepaired, 0, variant);
    const doc = await PDFDocument.load(await readFile(result.outputPath));
    const source = await PDFDocument.load(await readFile(fixture.pdfPath));
    assert.deepEqual(kids(doc, fixture.refs.item), kids(source, fixture.refs.item), variant);
  }
});
