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

test("native rebuilding preserves layer visibility and evidenced artifact properties without hiding assigned text",async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"native-properties-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const pdfPath=path.join(dir,"source.pdf"),outputPath=path.join(dir,"candidate.pdf"),tagsPath=path.join(dir,"tags.json"),semanticPath=path.join(dir,"semantic.json");
  const bundledJavaHome=path.resolve("modules/validator/vendor/java"),java=await resolveJavaTool("java","PIPELINE_JAVA_PATH",{bundledJavaHome}),env=await buildJavaExecEnv({bundledJavaHome});
  const jar=path.resolve("modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar"),probe=path.resolve("modules/pdf-writer/test/fixtures/NativeMarkedPropertiesProbe.java"),font=path.resolve("modules/font-embedder/vendor/fonts/noto-sans/NotoSans-Regular.ttf");
  const run=args=>promisify(execFile)(java,args,{env,windowsHide:true,timeout:90000,maxBuffer:50*1024*1024});
  await run(["-cp",jar,probe,"create",pdfPath,font]);
  const nodes=[[1,"Repeated heading",650],[2,"Visible A",600],[3,"Nested A and B",570],[4,"Hidden B",540],[5,"Membership both",510],[7,"Form layer B",400],[8,"Outside layers",350]]
    .map(([id,text,y],i)=>({id:`n${id}`,sourceBlockId:`b${id}`,pageNumber:1,role:"P",text,bbox:[71,792-y-12,180,15],confidence:1,readingOrder:i}));
  await writeFile(semanticPath,JSON.stringify({schemaVersion:"1.0.0",documentId:"properties",source:{layoutDocumentId:"properties"},nodes}));
  await writeFile(tagsPath,JSON.stringify({schemaVersion:"1.0.0",documentId:"tags",source:{semanticDocumentId:"properties"},root:{id:"root",type:"Document",children:nodes.map(n=>({id:n.id,type:"P",sourceNodeIds:[n.id],label:n.text,children:[]}))}}));
  await writeTaggedArtifacts({pdfPath,outputPath,tagsPath,semanticPath,mode:"native"});
  assert.match((await run(["-cp",jar,probe,"verify",pdfPath,outputPath])).stdout,/Layer scopes, artifact properties, semantic ownership and 150 DPI pixels preserved/);
  assert.equal((await checkSavedSemantics({pdfPath:outputPath,tagsPath})).summary.failed,0);
  const validation=await promisify(execFile)(process.execPath,[path.resolve("modules/validator/index.js"),"--pdf",outputPath,"--manifest",`${outputPath}.tags.json`],{env,windowsHide:true,timeout:90000,maxBuffer:4*1024*1024});
  assert.equal(JSON.parse(validation.stdout).rawSummary.failedChecks,0);
  const cp=`${getRuntimeBuildDir("modules-pdf-writer",{repoRoot:process.cwd()})}${path.delimiter}${jar}`;
  for(const variant of ["unclosed","unbalanced","missing","invalid","inline","excessive"])await t.test(`rejects ${variant} source scopes before saving`,async()=>{
    const bad=path.join(dir,`${variant}.pdf`),out=path.join(dir,`${variant}-saved.pdf`);
    await run(["-cp",jar,probe,"create",bad,font,variant]);
    await assert.rejects(run(["-cp",cp,"NativeContentStreamRewriter","--pdf",bad,"--tag-plan",`${outputPath}.native-tag-plan.json`,"--tags",tagsPath,"--output",out]),/source marked.content|marked-content|optional-content/i);
    await assert.rejects(access(out),{code:"ENOENT"});
  });
});
