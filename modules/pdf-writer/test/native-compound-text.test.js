import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeTaggedArtifacts } from "../index.js";
import { resolveJavaTool, buildJavaExecEnv } from "../../../scripts/java-runtime.js";
import { getRuntimeBuildDir } from "../../../scripts/runtime-paths.js";
import { checkSavedSemantics } from "../../../scripts/check-saved-semantics.js";

test("compound text partitions preserve glyphs, quotes, arrays and nested Forms on all four page rotations", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "native-compound-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pdfPath = path.join(dir,"source.pdf"), outputPath = path.join(dir,"candidate.pdf");
  const tagsPath = path.join(dir,"tags.json"), semanticPath = path.join(dir,"semantic.json");
  const bundledJavaHome = path.resolve("modules/validator/vendor/java");
  const java = await resolveJavaTool("java", "PIPELINE_JAVA_PATH", {bundledJavaHome});
  const env = await buildJavaExecEnv({bundledJavaHome});
  const jar = path.resolve("modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar");
  const probe = path.resolve("modules/pdf-writer/test/fixtures/NativeCompoundProbe.java");
  const run = args => promisify(execFile)(java,args,{env,windowsHide:true,timeout:90000,maxBuffer:50*1024*1024});
  await run(["-cp",jar,probe,"create",pdfPath,path.resolve("modules/font-embedder/vendor/fonts/noto-sans-mono/NotoSansMono-Regular.ttf")]);
  const pairs = [["Name:","Ada",72],["Code:","Bob",96],["Date:","May",120],["City:","Rome",144],["After:","Eve",168],["Unit:","kg",342]];
  const nodes = [];
  for (let page=1;page<=4;page++) for (let row=0;row<pairs.length;row++) for (let part=0;part<2;part++) {
    const [label,value,y] = pairs[row];
    nodes.push({id:`p${page}r${row}c${part}`,sourceBlockId:`b${nodes.length}`,pageNumber:page,role:"P",text:part?value:label,
      bbox:part?[row===4?114:108,y-12,50,14]:[71,y-12,row===4?39:34,14],confidence:1,readingOrder:nodes.length});
  }
  const semantic = {schemaVersion:"1.0.0",documentId:"compound",source:{layoutDocumentId:"compound"},nodes};
  const tags = {schemaVersion:"1.0.0",documentId:"tags",source:{semanticDocumentId:"compound"},root:{id:"root",type:"Document",
    children:nodes.map(n=>({id:n.id,type:n.role,label:n.text,sourceNodeIds:[n.id],children:[]}))}};
  await writeFile(tagsPath,JSON.stringify(tags)); await writeFile(semanticPath,JSON.stringify(semantic));
  await writeTaggedArtifacts({pdfPath,outputPath,tagsPath,semanticPath,mode:"native"});
  const saved = (await run(["-cp",jar,probe,"inspect",outputPath])).stdout.trim().split(/\r?\n/).map(l=>l.split("\t"));
  assert.deepEqual(saved,nodes.map((n,i)=>[String(n.pageNumber),n.text+(i%2===0?" ":""),`oat:${n.id}`]));
  const operators = JSON.parse(await readFile(`${outputPath}.native-operators.json`,"utf8"));
  assert.equal(operators.pages.flatMap(p=>p.operators).filter(o=>o.glyphMap).length,24);
  const plan = JSON.parse(await readFile(`${outputPath}.native-tag-plan.json`,"utf8"));
  assert.equal(plan.pages.flatMap(p=>p.assignments.flatMap(a=>a.operators)).filter(o=>o.sourceGlyphCount).length,48);
  assert.equal((await checkSavedSemantics({pdfPath:outputPath,tagsPath})).summary.failed,0);
  assert.match((await run(["-cp",jar,path.resolve("modules/pdf-writer/test/fixtures/ListSplitProbe.java"),pdfPath,outputPath])).stdout,/Glyph positions and 150 DPI pixels unchanged/);
  assert.match((await run(["-cp",jar,path.resolve("modules/pdf-writer/test/fixtures/NativeOperatorProbe.java"),"pixels",pdfPath,outputPath])).stdout,/All pages pixel-identical/);
  const validation = await promisify(execFile)(process.execPath,[path.resolve("modules/validator/index.js"),"--pdf",outputPath,"--manifest",`${outputPath}.tags.json`],{env,windowsHide:true,timeout:90000,maxBuffer:4*1024*1024});
  assert.equal(JSON.parse(validation.stdout).rawSummary.failedChecks,0);
  const cp = `${getRuntimeBuildDir("modules-pdf-writer",{repoRoot:process.cwd()})}${path.delimiter}${jar}`;
  const mutations = {
    "overlap": refs => refs[1].glyphStart--,
    "gap": refs => refs[1].glyphStart++,
    "missing final glyph": refs => refs[1].glyphEnd--,
    "wrong hash": refs => refs.forEach(r=>r.operandSha256="0".repeat(64)),
    "wrong source text": refs => refs.forEach(r=>r.sourceText+="!"),
    "wrong piece text": refs => refs[0].text="Nam",
    "wrong glyph count": refs => {refs.forEach(r=>r.sourceGlyphCount++);refs[1].glyphEnd++;},
    "fractional range": refs => refs[0].glyphStart=.5,
    "different source address": refs => refs[1].opIndexInStream++,
    "mixed whole and partial": refs => {for(const key of ["glyphStart","glyphEnd","sourceGlyphCount","sourceText","operandSha256"])delete refs[1][key];}
  };
  for (const [name,mutate] of Object.entries(mutations)) await t.test(`rejects ${name} before saving`,async()=>{
    const bad = structuredClone(plan); mutate(bad.pages[0].assignments.slice(0,2).map(a=>a.operators[0]));
    const badPath = path.join(dir,"bad.json"), target = path.join(dir,"bad.pdf"); await writeFile(badPath,JSON.stringify(bad));
    await assert.rejects(run(["-cp",cp,"NativeContentStreamRewriter","--pdf",pdfPath,"--tag-plan",badPath,"--tags",tagsPath,"--output",target]),/partition|multiple owners/);
    await assert.rejects(access(target),{code:"ENOENT"});
  });
  await t.test("overlapping equally supported owners stay unresolved",async()=>{
    const ambiguous = structuredClone(semantic); ambiguous.nodes.push({...nodes[0],id:"duplicate"});
    const ambiguousTags = structuredClone(tags); ambiguousTags.root.children.push({...tags.root.children[0],id:"duplicate",sourceNodeIds:["duplicate"]});
    await writeFile(semanticPath,JSON.stringify(ambiguous)); await writeFile(tagsPath,JSON.stringify(ambiguousTags));
    const out = path.join(dir,"ambiguous-plan.json");
    await run(["-cp",cp,"NativeTagMatcher","--operators",`${outputPath}.native-operators.json`,"--semantic",semanticPath,"--tags",tagsPath,"--output",out]);
    const result = JSON.parse(await readFile(out,"utf8"));
    assert.ok(result.pages[0].unmatchedOperators.some(o=>o.text==="Name: Ada"));
    assert.ok(!result.pages[0].assignments.some(a=>a.operators.some(o=>o.sourceText==="Name: Ada")));
  });
});
