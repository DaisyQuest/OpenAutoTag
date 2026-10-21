import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import schema from "../contracts/accuracy-corpus.schema.json" with { type: "json" };
import { calibrateAccuracy } from "./accuracy-calibration.js";
const exec=promisify(execFile),root=path.resolve(import.meta.dirname,".."),valid=new Ajv2020({allErrors:true}).compile(schema);
const hash=b=>createHash("sha256").update(b).digest("hex");
export function validateAccuracyManifest(manifest) {
  if(!valid(manifest))throw new Error("Invalid accuracy corpus contract");
  const ids=new Set(),hashes=new Set(),lineages=new Map();
  for(const d of manifest.documents) {
    if(ids.has(d.id)||hashes.has(d.sha256))throw new Error("Duplicate corpus identity or PDF hash");
    ids.add(d.id);hashes.add(d.sha256);
    if(lineages.has(d.lineage)&&lineages.get(d.lineage)!==d.split)throw new Error("Source lineage leaks between development and holdout");
    lineages.set(d.lineage,d.split);
    if(d.review.status==="adjudicated"&&(!d.review.adjudicator||!Number.isFinite(Date.parse(d.review.reviewedAt))||new Set(d.review.reviewers||[]).size<2||!d.expectations.length))throw new Error("Adjudication requires two reviewers, dated resolution and expectations");
    if(manifest.holdoutState==="frozen"&&d.split==="holdout"&&d.review.status!=="adjudicated")throw new Error("Frozen holdout requires adjudicated references");
    const expectationIds=new Set();for(const e of d.expectations){if(expectationIds.has(e.id))throw new Error("Duplicate expectation identity");expectationIds.add(e.id);}
  }
  return manifest;
}
export function scoreAccuracyExpectations(document, semantic, tagging) {
  const bySource=new Map();for(const n of semantic.nodes)for(const source of n.sourceBlockIds||[n.sourceBlockId])bySource.set(source,n);
  const order=new Map((semantic.orderedNodeIds||[]).map((id,i)=>[id,i]));
  const tags=[];const walk=(n,depth=0)=>{if(depth>128||tags.length>=100000)throw new Error("Tag traversal limit");tags.push(n);for(const c of n.children||[])walk(c,depth+1);};walk(tagging.root);
  return document.expectations.map(e=>{
    const a=bySource.get(e.source),b=bySource.get(e.target);let predicted=null;
    if(e.kind==="role"&&a)predicted=a.role===e.value;
    if(e.kind==="label"&&a)predicted=semantic.relations.some(r=>r.type==="labels"&&r.from===a.id&&r.to===`widget:${e.target}`);
    if(e.kind==="precedence"&&a&&b&&order.has(a.id)&&order.has(b.id))predicted=order.get(a.id)<order.get(b.id);
    if(e.kind==="paragraph"&&a&&b)predicted=Boolean(a.paragraphGroupId&&a.paragraphGroupId===b.paragraphGroupId);
    if(e.kind==="header"&&a&&b){const owners=tags.filter(t=>t.sourceNodeIds?.includes(a.id)),heads=tags.filter(t=>t.sourceNodeIds?.includes(b.id));if(owners.length===1&&heads.length===1)predicted=(owners[0].tableAttrs?.Headers||[]).includes(heads[0].headerId);}
    return {id:e.id,rule:e.rule,documentId:document.id,lineage:document.lineage,split:document.split,reviewStatus:document.review.status,expected:e.expected,predicted};
  });
}
export async function runRealPdfBenchmark({manifestPath=path.join(root,"test/fixtures/accuracy-corpus.json"),outputDir,includeSecondary=false,documentIds}={}) {
  if(!outputDir)throw new Error("An output directory is required");
  const bytes=await readFile(manifestPath),manifest=validateAccuracyManifest(JSON.parse(bytes));
  const selected=manifest.documents.filter(d=>(includeSecondary||d.priority==="primary")&&(!documentIds||documentIds.includes(d.id)));
  if(!selected.length)throw new Error("No selected corpus documents");
  const cases=[],decisions=[];await mkdir(outputDir,{recursive:true});
  for(const d of selected) {
    const pdf=path.resolve(root,d.path),relative=path.relative(root,pdf);
    if(relative.startsWith("..")||path.isAbsolute(relative))throw new Error("Corpus PDF paths must stay within the repository");
    if(hash(await readFile(pdf))!==d.sha256)throw new Error(`Corpus bytes changed: ${d.id}`);
    const dir=path.join(outputDir,d.id);await mkdir(dir,{recursive:true});const start=performance.now();
    let previous=pdf,semantic,tagging,inferred;
    for(const [name,script] of [["01-layout","modules/parser/index.js"],["02-enriched","modules/layout-analyzer/index.js"],["03-semantic","modules/semantic-engine/index.js"],["03b-merged","modules/paragraph-merger/index.js"],["04-ordered","modules/reading-order/index.js"],["05-tagging","modules/tag-builder/index.js"]]) {
      const {stdout}=await exec(process.execPath,[path.join(root,script),previous],{cwd:root,windowsHide:true,timeout:180000,maxBuffer:64*1024*1024,env:{...process.env,PARSER_OCR_MODE:"off"}});
      previous=path.join(dir,`${name}.json`);await writeFile(previous,stdout);
      if(name==="04-ordered")semantic=JSON.parse(stdout);if(name==="05-tagging")tagging=JSON.parse(stdout);
      if(name==="03-semantic")inferred=JSON.parse(stdout);
    }
    if(hash(await readFile(pdf))!==d.sha256)throw new Error(`Corpus input changed during benchmark: ${d.id}`);
    const owned=new Map();const visit=n=>{for(const id of n.sourceNodeIds||[])owned.set(id,(owned.get(id)||0)+1);for(const child of n.children||[])visit(child);};visit(tagging.root);
    const ownershipFailures=semantic.nodes.filter(n=>n.role!=="Artifact"&&owned.get(n.id)!==1).map(n=>n.id);
    const sources=new Set(semantic.nodes.flatMap(n=>n.sourceBlockIds||[n.sourceBlockId]));
    const sourceIdentityFailures=inferred.nodes.flatMap(n=>n.sourceBlockIds||[n.sourceBlockId]).filter(id=>!sources.has(id));
    const rows=scoreAccuracyExpectations(d,semantic,tagging);decisions.push(...rows);
    cases.push({id:d.id,sha256:d.sha256,split:d.split,reviewStatus:d.review.status,elapsedMs:Math.round(performance.now()-start),nodes:semantic.nodes.length,
      ownershipFailures,sourceIdentityFailures,reviewTasks:semantic.semanticReviewTasks?.length||0,unresolvedWidgets:semantic.formNavigation?.unresolvedWidgetIds.length||0,expectations:rows.length,
      failedExpectations:rows.filter(r=>r.predicted!==r.expected).length});
  }
  const report={schemaVersion:"1.0.0",manifestHash:hash(bytes),cases,calibration:calibrateAccuracy(decisions),decisions,
    disposition:cases.some(c=>c.ownershipFailures.length||c.sourceIdentityFailures.length||c.failedExpectations)?"rejected":"review_required",
    limitations:["Unreviewed documents measure pipeline diagnostics, not tagging accuracy.","This benchmark executes parsing through tag building; saved PDFs require check-saved-semantics and preservation checks.","Elapsed time includes process startup; peak child memory is not measured.","The perfect-lineage Wilson bound is a conservative release guard, not a confidence interval for decision precision.","Actual reader sessions and independent adjudication must be supplied by reviewers."]};
  await writeFile(path.join(outputDir,"accuracy-report.json"),JSON.stringify(report,null,2)+"\n");return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const args=new Map();for(let i=2;i<process.argv.length;i+=2){if(!["--manifest","--output-dir","--include-secondary","--documents"].includes(process.argv[i])||!process.argv[i+1]||args.has(process.argv[i]))throw new Error("Invalid benchmark arguments");args.set(process.argv[i],process.argv[i+1]);}
  runRealPdfBenchmark({manifestPath:args.get("--manifest"),outputDir:args.get("--output-dir"),includeSecondary:args.get("--include-secondary")==="true",documentIds:args.get("--documents")?.split(",")}).then(r=>{process.stdout.write(JSON.stringify(r,null,2)+"\n");if(r.disposition==="rejected")process.exitCode=1;}).catch(e=>{process.stderr.write(e.message+"\n");process.exitCode=1;});
}
