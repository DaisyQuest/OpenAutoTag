import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument, PDFDict, PDFArray, PDFName, PDFString } from "pdf-lib";
import { createListFormFixture } from "../../modules/pdf-writer/test/fixtures/list-form-fixture.js";
import { inspectPdfLowLevel } from "../../scripts/inspect-pdf-low-level.js";
const name = PDFName.of;
test("saved-PDF inspector resolves RoleMap chains and detects invalid ownership indexes", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "structure-inspect-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const variants = ["mapped-heading", "role-cycle", "unmapped-role", "parent-slot", "id-slot", "duplicate-mcid", "duplicate-objr"];
  const expected = [null, "ROLE_MAP_CYCLE", "UNMAPPED_ROLE", "PARENT_TREE", "ID_TREE", "DUPLICATE", "DUPLICATE"];
  for (let i = 0; i < variants.length; i++) {
    const folder = path.join(dir, variants[i]); await mkdir(folder); const input = await createListFormFixture(folder);
    const doc = await PDFDocument.load(await readFile(input.pdfPath)), root = doc.catalog.lookup(name("StructTreeRoot"), PDFDict);
    const heading = doc.context.lookup(input.refs.heading, PDFDict);
    if (variants[i].includes("role") || variants[i] === "mapped-heading") {
      heading.set(name("S"), name("CustomHeading"));
      root.set(name("RoleMap"), doc.context.obj({ CustomHeading: name("Alias"), ...(variants[i] === "unmapped-role" ? {} : { Alias: name(variants[i] === "role-cycle" ? "CustomHeading" : "H4") }) }));
    } else if (variants[i] === "parent-slot") root.lookup(name("ParentTree"), PDFDict).lookup(name("Nums"), PDFArray).lookup(1, PDFArray).set(0, input.refs.body);
    else if (variants[i] === "id-slot") root.lookup(name("IDTree"), PDFDict).lookup(name("Names"), PDFArray).set(1, input.refs.body);
    else if (variants[i] === "duplicate-mcid") heading.set(name("K"), doc.context.obj([0, 0]));
    else if (variants[i] === "duplicate-objr") {
      const form = doc.context.lookup(input.refs.forms[0], PDFDict), objr = form.lookup(name("K"), PDFDict);
      form.set(name("K"), doc.context.obj([objr, objr.clone()]));
    }
    await writeFile(input.pdfPath, await doc.save());
    const inspected = await inspectPdfLowLevel({ pdfPath: input.pdfPath, preservation: true });
    if (!expected[i]) { assert.deepEqual(inspected.issues, []); assert.equal(inspected.headings[0].role, "H4"); }
    else assert.ok(inspected.issues.some((issue) => issue.includes(expected[i])), `${variants[i]}: ${inspected.issues.join(",")}`);
  }
});
