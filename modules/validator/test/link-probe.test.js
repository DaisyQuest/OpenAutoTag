import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { PDFDocument, PDFName, PDFString, PDFDict } from "pdf-lib";
import { resolveJavaTool, buildJavaExecEnv } from "../../../scripts/java-runtime.js";

const exec = promisify(execFile), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const n = PDFName.of;
async function fixture(variant, widgetMode = false) {
  const d = await PDFDocument.create(), page = d.addPage(), second = d.addPage();
  const reg = (v) => d.context.register(d.context.obj(v));
  const tree = reg({ Type: "StructTreeRoot" }), document = reg({ Type: "StructElem", S: "Document", P: tree });
  const annotation = reg({ Type: "Annot", Subtype: "Link", P: page.ref, Rect: [10,10,100,30], StructParent: 0, Contents: PDFString.of("https://example.test"), A: { S: "URI", URI: PDFString.of("https://example.test") } });
  const objr = d.context.obj({ Type: "OBJR", Obj: annotation, Pg: page.ref });
  const link = reg({ Type: "StructElem", S: "Link", P: document, Pg: page.ref, K: objr });
  const nums = d.context.obj([0, link]), parentTree = reg({ Nums: nums });
  const treeDict = d.context.lookup(tree, PDFDict), linkDict = d.context.lookup(link, PDFDict), docDict = d.context.lookup(document, PDFDict), annotDict = d.context.lookup(annotation, PDFDict);
  treeDict.set(n("K"), d.context.obj([document])); treeDict.set(n("ParentTree"), parentTree);
  docDict.set(n("K"), d.context.obj([link])); d.catalog.set(n("StructTreeRoot"), tree); page.node.set(n("Annots"), d.context.obj([annotation]));
  if (variant === "rolemap") { linkDict.set(n("S"), n("CustomLink")); treeDict.set(n("RoleMap"), d.context.obj({ CustomLink: "Link" })); }
  if (variant === "role-cycle") { linkDict.set(n("S"), n("CustomLink")); treeDict.set(n("RoleMap"), d.context.obj({ CustomLink: "Other", Other: "CustomLink" })); }
  if (variant === "missing-objr") linkDict.delete(n("K"));
  if (variant === "wrong-objr") objr.set(n("Obj"), reg({ Type: "Annot", Subtype: "Link" }));
  if (variant === "wrong-page") objr.set(n("Pg"), second.ref);
  if (variant === "wrong-annotation-page") annotDict.set(n("P"), second.ref);
  if (variant === "bad-parent") linkDict.set(n("P"), tree);
  if (variant === "unreachable-owner") docDict.set(n("K"), d.context.obj([]));
  if (variant === "duplicate-objr") linkDict.set(n("K"), d.context.obj([objr, { Type: "OBJR", Obj: annotation, Pg: page.ref }]));
  if (variant === "wrong-slot") nums.set(1, document);
  if (variant === "missing-slot") annotDict.delete(n("StructParent"));
  if (variant === "shared-slot") page.node.Annots().push(reg({ Type: "Annot", Subtype: "Widget", P: page.ref, Rect: [10,40,100,60], StructParent: 0 }));
  if (variant === "duplicate-slot") { nums.push(d.context.obj(0)); nums.push(link); }
  if (variant === "odd-tree") nums.push(d.context.obj(1));
  if (variant === "cyclic-tree") d.context.lookup(parentTree, PDFDict).set(n("Kids"), d.context.obj([parentTree]));
  if (variant === "structure-cycle") linkDict.set(n("K"), d.context.obj([objr, document]));
  if (widgetMode) {
    annotDict.set(n("Subtype"), n("Widget")); linkDict.set(n("S"), n("Form"));
    if (["two-children", "with-role"].includes(variant)) {
      const other = reg({ Type: "Annot", Subtype: "Widget", P: page.ref, Rect: [10,40,100,60], StructParent: 1 });
      page.node.Annots().push(other); nums.push(d.context.obj(1)); nums.push(link);
      linkDict.set(n("K"), d.context.obj([objr, {Type:"OBJR", Obj:other, Pg:page.ref}]));
    }
    if (variant === "with-role") linkDict.set(n("A"), d.context.obj({O:"PrintField", Role:"cb"}));
  }
  return d.save();
}

test("independent link probe requires reachable, unique, reciprocal ownership on the correct page", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "link-probe-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const bundledJavaHome = path.join(root, "modules/validator/vendor/java");
  const java = await resolveJavaTool("java", "PIPELINE_JAVA_PATH", { bundledJavaHome });
  const javac = await resolveJavaTool("javac", "PIPELINE_JAVAC_PATH", { bundledJavaHome });
  const env = await buildJavaExecEnv({ bundledJavaHome }), jar = path.join(root, "modules/validator/vendor/pdfbox-app-3.0.8.jar");
  await exec(javac, ["-encoding", "UTF-8", "-cp", jar, "-d", dir, path.join(root, "modules/validator/java/MetadataProbeCli.java")], { env, windowsHide: true });
  for (const variant of ["valid", "rolemap", "role-cycle", "missing-objr", "wrong-objr", "wrong-page", "wrong-annotation-page", "bad-parent", "unreachable-owner",
    "duplicate-objr", "wrong-slot", "missing-slot", "shared-slot", "duplicate-slot", "odd-tree", "cyclic-tree", "structure-cycle"]) {
    await t.test(variant, async () => {
      const pdf = path.join(dir, `${variant}.pdf`); await writeFile(pdf, await fixture(variant));
      const run = () => exec(java, ["-cp", [dir, jar].join(path.delimiter), "MetadataProbeCli", "--pdf", pdf], { env, windowsHide: true, timeout: 10000 });
      const { stdout } = await run(), result = JSON.parse(stdout);
      assert.equal(result.linkStructCorrect, ["valid", "rolemap"].includes(variant));
      if (result.linkStructCorrect) assert.equal(result.linkAnnotsResolvingToLinkElement, 1);
    });
  }
  for (const variant of ["valid", "two-children", "with-role", "missing-objr", "wrong-slot", "duplicate-objr", "unreachable-owner"]) {
    await t.test(`widget-${variant}`, async () => {
      const pdf = path.join(dir, `widget-${variant}.pdf`); await writeFile(pdf, await fixture(variant, true));
      const {stdout} = await exec(java, ["-cp", [dir, jar].join(path.delimiter), "MetadataProbeCli", "--pdf", pdf], {env, windowsHide:true, timeout:10000});
      const result=JSON.parse(stdout);
      assert.equal(result.widgetStructCorrect,["valid","two-children","with-role"].includes(variant));
      assert.equal(result.formChildRuleCorrect,!["two-children","missing-objr","duplicate-objr"].includes(variant));
      if(variant==="two-children") assert.equal(result.invalidFormChildCount,1);
    });
  }
});
