import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createReadStream} from 'node:fs';
import {readFile,writeFile,mkdir,mkdtemp,rm,stat,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import reviewSchema from '../../contracts/reviewed-outline.schema.json' with {type:'json'};
import reportSchema from '../../contracts/reviewed-outline-report.schema.json' with {type:'json'};
import {ensureJavaHelperCompiled} from './index.js';
import {resolveJavaTool,buildJavaExecEnv} from '../../scripts/java-runtime.js';
import {getRuntimeBuildDir} from '../../scripts/runtime-paths.js';
const ajv=new Ajv2020(),validateReview=ajv.compile(reviewSchema),validateReport=ajv.compile(reportSchema),exec=promisify(execFile);
const root=path.resolve(import.meta.dirname,'../..'),bundledJavaHome=path.join(root,'modules/validator/vendor/java');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function hash(file){const d=createHash('sha256');for await(const b of createReadStream(file))d.update(b);return d.digest('hex');}
function boundedReview(review){
 const seen=new Set(),stack=review.bookmarks.map(n=>[n,0]);
 while(stack.length){const [n,depth]=stack.pop();if(depth>32||seen.size>=4096||seen.has(n.id))throw Error('Duplicate or excessive reviewed outline');seen.add(n.id);
  for(const text of [n.id,n.title])if(!text.trim()||!text.isWellFormed()||/[\x00-\x1f\x7f-\x9f]/u.test(text))throw Error('Invalid reviewed outline text');
  stack.push(...n.children.map(c=>[c,depth+1]));
 }
}
/** Adds only accepted, hash-bound bookmark decisions; verify mode never writes a PDF. */
export async function applyReviewedOutline({sourcePdf,outputPdf,candidatePdf,reviewPath}={}){
 if(!sourcePdf||!reviewPath||Boolean(outputPdf)===Boolean(candidatePdf))throw Error('Required: source PDF, review, and exactly one output or candidate PDF');
 const source=await realpath(sourcePdf),reviewFile=await realpath(reviewPath),target=path.resolve(outputPdf||candidatePdf);
 const targetReal=await realpath(target).catch(e=>{if(e.code!=='ENOENT')throw e;return target;});
 if([source,reviewFile].some(p=>p.toLowerCase()===targetReal.toLowerCase()))throw Error('Outline output must not overwrite an input');
 if((await stat(reviewFile)).size>1024*1024)throw Error('Outline review exceeds size limit');
 const bytes=await readFile(reviewFile),review=JSON.parse(bytes);if(!validateReview(review))throw Error('Invalid accepted outline review');boundedReview(review);
 const sourceHash=await hash(source);if(review.sourceHash!==sourceHash)throw Error('Outline review source hash is stale');
 const before=candidatePdf?await hash(target):null;if(outputPdf)await mkdir(path.dirname(target),{recursive:true});
 const temp=await mkdtemp(path.join(os.tmpdir(),'reviewed-outline-'));
 try{
  const reviewCopy=path.join(temp,'review.json');await writeFile(reviewCopy,bytes);await ensureJavaHelperCompiled();
  const java=await resolveJavaTool('java','PIPELINE_JAVA_PATH',{bundledJavaHome});
  const {stdout}=await exec(java,['-XX:TieredStopAtLevel=1','-cp',[getRuntimeBuildDir('modules-pdf-writer',{repoRoot:root}),path.join(root,'modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar')].join(path.delimiter),'ReviewedOutlineCli',outputPdf?'apply':'verify',source,target,reviewCopy],{env:await buildJavaExecEnv({bundledJavaHome}),windowsHide:true,maxBuffer:8*1024*1024,timeout:120000});
  const candidateHash=await hash(target);if(sourceHash!==await hash(source)||before&&before!==candidateHash||!bytes.equals(await readFile(reviewFile)))throw Error('Outline verification inputs changed');
  const report={schemaVersion:'1.0.0',sourceHash,candidateHash,reviewHash:digest(bytes),...JSON.parse(stdout)};if(!validateReport(report))throw Error('Invalid saved outline verification report');return report;
 }finally{await rm(temp,{recursive:true,force:true});}
}
async function main(){const args=new Map();for(let i=2;i<process.argv.length;i+=2){const k=process.argv[i],v=process.argv[i+1];if(!['--pdf','--output','--verify','--review'].includes(k)||!v||args.has(k))throw Error('Invalid reviewed-outline arguments');args.set(k,v);}const result=await applyReviewedOutline({sourcePdf:args.get('--pdf'),outputPdf:args.get('--output'),candidatePdf:args.get('--verify'),reviewPath:args.get('--review')});process.stdout.write(JSON.stringify(result,null,2)+'\n');}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{process.stderr.write(e.message+'\n');process.exitCode=1;});
