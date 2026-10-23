import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,writeFile,rm,access} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {writeTaggedArtifacts} from "../index.js";
import {resolveJavaTool,buildJavaExecEnv} from "../../../scripts/java-runtime.js";
import {getRuntimeBuildDir} from "../../../scripts/runtime-paths.js";
import {checkSavedSemantics} from "../../../scripts/check-saved-semantics.js";

test("native retagging preserves authored replacements and expansion scopes without swallowing neighbors",async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"authored-text-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const pdfPath=path.join(dir,"source.pdf"),outputPath=path.join(dir,"candidate.pdf"),tagsPath=path.join(dir,"tags.json"),semanticPath=path.join(dir,"semantic.json");
  const bundledJavaHome=path.resolve("modules/validator/vendor/java"),java=await resolveJavaTool("java","PIPELINE_JAVA_PATH",{bundledJavaHome}),env=await buildJavaExecEnv({bundledJavaHome});
  const jar=path.resolve("modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar"),probe=path.resolve("modules/pdf-writer/test/fixtures/AuthoredTextProbe.java"),font=path.resolve("modules/font-embedder/vendor/fonts/noto-sans/NotoSans-Regular.ttf");
  const run=args=>promisify(execFile)(java,args,{env,windowsHide:true,timeout:90000,maxBuffer:50*1024*1024});
  await run(["-cp",jar,probe,"create",pdfPath,font]);
  const nodes=["Before ﬁ after","NASA neighbor","Start Co end","Left noise right","Tab.. end","abc neighbor","Before ST after","EU neighbor","ﬁ","ﬁ","XY","ﬁ"].map((text,i)=>({id:`n${i+1}`,sourceBlockId:`b${i+1}`,pageNumber:1,role:"P",text,bbox:[70,792-(740-40*i)-14,450,18],confidence:1,readingOrder:i}));
  await writeFile(semanticPath,JSON.stringify({schemaVersion:"1.0.0",documentId:"authored",source:{layoutDocumentId:"authored"},nodes}));
  const tags={schemaVersion:"1.0.0",documentId:"tags",source:{semanticDocumentId:"authored"},root:{id:"root",type:"Document",children:nodes.map(n=>({id:n.id,type:"P",sourceNodeIds:[n.id],label:n.text,children:[]}))}};
  await writeFile(tagsPath,JSON.stringify(tags));
  const report=await writeTaggedArtifacts({pdfPath,outputPath,tagsPath,semanticPath,mode:"native"});
  assert.equal(report.preservedAuthoredTextScopes,13);assert.equal(report.shadowedAuthoredTextScopes,1);
  assert.deepEqual(report.suppressedGeneratedActualText,[]);
  assert.match((await run(["-cp",jar,probe,"verify",pdfPath,outputPath])).stdout,/Authored replacement, expansion, neighbors, ownership, glyphs and 150 DPI pixels verified/);
  const saved=await checkSavedSemantics({pdfPath:outputPath,tagsPath,sourcePdfPath:pdfPath,ownershipPath:report.sourceOwnershipPath});
  assert.equal(saved.summary.failed,0,JSON.stringify(saved.checks?.filter(c=>c.status==="fail")));
  const validation=await promisify(execFile)(process.execPath,[path.resolve("modules/validator/index.js"),"--pdf",outputPath,"--manifest",`${outputPath}.tags.json`],{env,windowsHide:true,timeout:90000,maxBuffer:4*1024*1024});
  assert.equal(JSON.parse(validation.stdout).rawSummary.failedChecks,0);
  const cp=`${getRuntimeBuildDir("modules-pdf-writer",{repoRoot:process.cwd()})}${path.delimiter}${jar}`;
  const planPath=`${outputPath}.native-tag-plan.json`,plan=JSON.parse(await readFile(planPath,"utf8"));
  for(const variant of ["intervening","visibility"])await t.test(`refuses to coalesce across ${variant} content`,async()=>{
    const bad=path.join(dir,`${variant}.pdf`),out=path.join(dir,`${variant}-saved.pdf`);
    await run(["-cp",jar,probe,"create",bad,font,variant]);
    await assert.rejects(writeTaggedArtifacts({pdfPath:bad,outputPath:out,tagsPath,semanticPath,mode:"native"}),/Authored text crosses unrelated paint or visibility scopes/);
    await assert.rejects(access(out),{code:"ENOENT"});
  });
  await t.test("source replacement survives generated ancestor text and the intent conflict remains visible",async()=>{
    const conflicting=structuredClone(tags);conflicting.root.actualText="WRONG GENERATED ANCESTOR";
    conflicting.root.children.forEach((n,i)=>{n.actualText=nodes[i].text;});
    const conflictPath=path.join(dir,"conflicting-tags.json"),out=path.join(dir,"conflicting.pdf");await writeFile(conflictPath,JSON.stringify(conflicting));
    await run(["-cp",cp,"NativeContentStreamRewriter","--pdf",pdfPath,"--tag-plan",planPath,"--tags",conflictPath,"--output",out]);
    assert.match((await run(["-cp",jar,probe,"verify",pdfPath,out])).stdout,/Authored replacement/);
    const audited=await checkSavedSemantics({pdfPath:out,tagsPath:conflictPath});
    const failures=audited.checks.filter(c=>c.status==="fail");assert.equal(failures.length,13);assert.ok(failures.every(c=>c.code==="ACTUAL_TEXT"));
  });
  for(const variant of ["invalid","empty-scope","graphic","missing-reference","cycle"])await t.test(`rejects ${variant} authored data before saving`,async()=>{
    const bad=path.join(dir,`${variant}.pdf`),out=path.join(dir,`${variant}-saved.pdf`);
    await run(["-cp",jar,probe,"create",bad,font,variant]);
    await assert.rejects(run(["-cp",cp,"NativeContentStreamRewriter","--pdf",bad,"--tag-plan",planPath,"--tags",tagsPath,"--output",out]),/authored text|source structure/i);
    await assert.rejects(access(out),{code:"ENOENT"});
  });
  for(const variant of ["unassigned","cross-tag"])await t.test(`rejects ${variant} inferred ownership before saving`,async()=>{
    const modified=structuredClone(plan),assignment=modified.pages[0].assignments.find(a=>a.tagNodeId==="n3");
    assert.equal(assignment.operators.length,4);
    if(variant==="unassigned")assignment.operators.splice(2,1);
    if(variant==="cross-tag")modified.pages[0].assignments.push({...assignment,tagNodeId:"n4",operators:assignment.operators.splice(2,1)});
    const modifiedPath=path.join(dir,`${variant}.json`),out=path.join(dir,`${variant}.pdf`);await writeFile(modifiedPath,JSON.stringify(modified));
    await assert.rejects(run(["-cp",cp,"NativeContentStreamRewriter","--pdf",pdfPath,"--tag-plan",modifiedPath,"--tags",tagsPath,"--output",out]),/authored text/i);
    await assert.rejects(access(out),{code:"ENOENT"});
  });
  await t.test("a continuous replacement keeps its source operators together despite an inconsistent plan order",async()=>{
    const modified=structuredClone(plan),assignment=modified.pages[0].assignments.find(a=>a.tagNodeId==="n3");
    [assignment.operators[2],assignment.operators[3]]=[assignment.operators[3],assignment.operators[2]];
    const modifiedPath=path.join(dir,"reordered.json"),out=path.join(dir,"reordered.pdf");await writeFile(modifiedPath,JSON.stringify(modified));
    await run(["-cp",cp,"NativeContentStreamRewriter","--pdf",pdfPath,"--tag-plan",modifiedPath,"--tags",tagsPath,"--output",out]);
    assert.match((await run(["-cp",jar,probe,"verify",pdfPath,out])).stdout,/Authored replacement/);
  });
  await t.test("legacy flat CLI also preserves authored groups",async()=>{
    const out=path.join(dir,"flat.pdf");await run(["-cp",cp,"NativeContentStreamRewriter","--pdf",pdfPath,"--tag-plan",planPath,"--output",out]);
    assert.match((await run(["-cp",jar,probe,"verify",pdfPath,out])).stdout,/Authored replacement/);
  });
});
