import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
test("pipeline CLI preserves failed result JSON and returns a failing exit status",async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"pipeline-failure-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const input=path.join(dir,"broken.pdf");await writeFile(input,"%PDF-1.7\ninvalid\n%%EOF");
  await assert.rejects(promisify(execFile)(process.execPath,["orchestrator/pipeline-runner.js","--pdf",input,"--output-dir",path.join(dir,"output")],{windowsHide:true,timeout:30000}),e=>{
    assert.equal(e.code,1);assert.equal(JSON.parse(e.stdout).status,"failed");return true;
  });
});
