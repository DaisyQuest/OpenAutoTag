import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createReadStream} from 'node:fs';
import {readFile,writeFile,mkdir,mkdtemp,rm,stat,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';import os from 'node:os';import {pathToFileURL} from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import reviewSchema from '../../contracts/reviewed-field-names.schema.json' with {type:'json'};
import reportSchema from '../../contracts/reviewed-field-names-report.schema.json' with {type:'json'};
import semanticSchema from '../../contracts/semantic.schema.json' with {type:'json'};
import {validateFieldNameIntent} from './field-name-intent.js';
import {ensureJavaHelperCompiled} from './index.js';
import {resolveJavaTool,buildJavaExecEnv} from '../../scripts/java-runtime.js';
import {getRuntimeBuildDir} from '../../scripts/runtime-paths.js';
const ajv=new Ajv2020(),validateReview=ajv.compile(reviewSchema),validateReport=ajv.compile(reportSchema),validateSemantic=ajv.compile(semanticSchema);
const root=path.resolve(import.meta.dirname,'../..'),bundledJavaHome=path.join(root,'modules/validator/vendor/java');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function hash(file){const d=createHash('sha256');for await(const b of createReadStream(file))d.update(b);return d.digest('hex');}

export async function applyReviewedFieldNames({sourcePdf,outputPdf,candidatePdf,reviewPath,semanticPath}={}) {
  if(!sourcePdf||!reviewPath||!semanticPath||Boolean(outputPdf)===Boolean(candidatePdf))throw Error('Required: source PDF, semantic intent, review, and exactly one output or candidate PDF');
  const source=await realpath(sourcePdf),reviewFile=await realpath(reviewPath),semanticFile=await realpath(semanticPath),target=path.resolve(outputPdf||candidatePdf);
  const targetReal=await realpath(target).catch(e=>{if(e.code!=='ENOENT')throw e;return target;});
  if([source,reviewFile,semanticFile].some(p=>p.toLowerCase()===targetReal.toLowerCase()))throw Error('Field-name output must not overwrite an input');
  if((await stat(reviewFile)).size>1024*1024||(await stat(semanticFile)).size>32*1024*1024)throw Error('Field-name input exceeds size limit');
  const bytes=await readFile(reviewFile),intent=await readFile(semanticFile),review=JSON.parse(bytes),semantic=JSON.parse(intent);
  if(!validateReview(review)||!validateSemantic(semantic))throw Error('Invalid accepted field-name review or semantic intent');
  if(!review.reviewer.trim()||!review.evidence.trim())throw Error('Review attribution and evidence are required');
  const sourceHash=await hash(source),intentHash=digest(intent);
  if(review.sourceHash!==sourceHash||review.intentHash!==intentHash)throw Error('Field-name review source or intent hash is stale');
  validateFieldNameIntent(review,semantic);
  const before=candidatePdf?await hash(target):null;if(outputPdf)await mkdir(path.dirname(target),{recursive:true});
  const temp=await mkdtemp(path.join(os.tmpdir(),'reviewed-field-names-'));
  try {
    const copy=path.join(temp,'review.json');await writeFile(copy,bytes);await ensureJavaHelperCompiled();
    const java=await resolveJavaTool('java','PIPELINE_JAVA_PATH',{bundledJavaHome});
    const {stdout}=await promisify(execFile)(java,['-XX:TieredStopAtLevel=1','-cp',[getRuntimeBuildDir('modules-pdf-writer',{repoRoot:root}),path.join(root,'modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar')].join(path.delimiter),'ReviewedFieldNamesCli',outputPdf?'apply':'verify',source,target,copy],{env:await buildJavaExecEnv({bundledJavaHome}),windowsHide:true,maxBuffer:8*1024*1024,timeout:120000});
    const candidateHash=await hash(target);
    if(sourceHash!==await hash(source)||before&&before!==candidateHash||!bytes.equals(await readFile(reviewFile))||!intent.equals(await readFile(semanticFile)))throw Error('Field-name verification inputs changed');
    const report={schemaVersion:'1.0.0',sourceHash,candidateHash,intentHash,reviewHash:digest(bytes),...JSON.parse(stdout)};
    if(!validateReport(report))throw Error('Invalid saved field-name verification report');return report;
  } finally {await rm(temp,{recursive:true,force:true});}
}
async function main(){const args=new Map();for(let i=2;i<process.argv.length;i+=2){const k=process.argv[i],v=process.argv[i+1];if(!['--pdf','--output','--verify','--review','--semantic'].includes(k)||!v||args.has(k))throw Error('Invalid reviewed-field-names arguments');args.set(k,v);}const result=await applyReviewedFieldNames({sourcePdf:args.get('--pdf'),outputPdf:args.get('--output'),candidatePdf:args.get('--verify'),reviewPath:args.get('--review'),semanticPath:args.get('--semantic')});process.stdout.write(JSON.stringify(result,null,2)+'\n');}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{process.stderr.write(e.message+'\n');process.exitCode=1;});
