import{readFile,writeFile,stat,realpath}from'node:fs/promises';import{createReadStream}from'node:fs';import{createHash}from'node:crypto';import{pathToFileURL}from'node:url';import path from'node:path';import Ajv2020 from'ajv/dist/2020.js';
import semanticSchema from'../../contracts/semantic.schema.json' with {type:'json'};import reviewSchema from'../../contracts/form-choice-review.schema.json' with {type:'json'};
const ajv=new Ajv2020(),validSemantic=ajv.compile(semanticSchema),validReview=ajv.compile(reviewSchema),sha=b=>createHash('sha256').update(b).digest('hex');
const require=(ok,why)=>{if(!ok)throw Error(why);};
const normal=value=>value.normalize('NFKC').replace(/[\s:]+$/u,'').replace(/\s+/gu,' ').trim();
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

/** Review changes logical label associations only. Native options, names,
 * selected values and exports remain authored data, independently verified later. */
export function applyChoiceReview({semanticBytes,reviewBytes,sourceHash}) {
 const semantic=JSON.parse(semanticBytes),review=JSON.parse(reviewBytes);
 require(validSemantic(semantic)&&validReview(review),'Invalid choice review or semantic contract');
 require(!semantic.formChoiceReview,'Apply a complete choice review to the original intent');
 require(review.sourceHash===sourceHash&&review.intentHash===sha(semanticBytes),'Choice review source or intent hash is stale');
 require(review.reviewer.trim()&&review.evidence.trim(),'Choice review attribution is required');
 const nodes=new Map(semantic.nodes.map(n=>[n.id,n])),widgets=new Map(),groups=new Map(),selected=new Set();require(nodes.size===semantic.nodes.length,'Duplicate semantic node identity');
 for(const field of semantic.formRelationships||[])for(const widget of field.widgets){require(!widgets.has(widget.id),'Duplicate semantic widget identity');widgets.set(widget.id,widget);const entries=groups.get(widget.fieldRef)||[];entries.push(widget);groups.set(widget.fieldRef,entries);}
 for(const decision of review.groups){
  require(!selected.has(decision.fieldRef),'Duplicate reviewed group');selected.add(decision.fieldRef);const group=groups.get(decision.fieldRef);
  require(group?.length&&same(group.map(w=>w.id).sort(),decision.widgets.map(w=>w.widgetId).sort()),'Review must identify every native group widget exactly once');
  require(group.every(w=>!w.choiceMetadataError&&w.choiceControl?.fieldRef===decision.fieldRef&&w.choiceControl.kind===decision.kind&&w.choiceControl.groupName===decision.groupName&&w.choiceControl.stateIssues.length===0&&w.choiceControl.widgetCount===group.length),'Group metadata is missing, inconsistent or unreviewable');
  require(same(group.map(w=>w.choiceControl.widgetIndex).sort((a,b)=>a-b),group.map((_,i)=>i)),'Group widget indices are incomplete');
  require(group.every(w=>w.fieldName===group[0].fieldName&&w.choiceControl.flags===group[0].choiceControl.flags),'Conflicting native group identity');
  if(decision.kind==='choice')require(group.every(w=>same(w.choiceControl.options,decision.options)),'Reviewed options differ from authored display/export pairs');
  for(const item of decision.widgets){
   const widget=widgets.get(item.widgetId),labels=item.labelNodeIds.map(id=>nodes.get(id));
   require(labels.every(n=>n&&n.pageNumber===widget.pageNumber&&n.role!=='Artifact'&&normal(n.text)),'Choice labels must resolve to visible text on the widget page');
   require(item.label.trim()===item.label&&item.label.isWellFormed()&&!/[\x00-\x1f\x7f-\x9f\ufffd]/u.test(item.label)&&normal(item.label)===normal(labels.map(n=>n.text.trim()).join(' ')),'Reviewed choice label must equal its complete visible text');
   const ordered=[...labels].sort((a,b)=>a.bbox[1]-b.bbox[1]||a.bbox[0]-b.bbox[0]);require(same(ordered.map(n=>n.id),item.labelNodeIds),'Reviewed label fragments are out of order');
   for(const node of nodes.values())if(node.formFieldIds?.includes(widget.id))node.formFieldIds=node.formFieldIds.filter(id=>id!==widget.id);
   for(const node of labels)node.formFieldIds=[...new Set([...(node.formFieldIds||[]),widget.id])];
   widget.labelStatus='associated';widget.labelNodeIds=[...item.labelNodeIds];widget.choiceLabel=item.label;widget.choiceLabelStatus='accepted';
   widget.labelAssociation={kind:decision.kind==='radio'?'radio-choice':'reviewed-choice',evidence:'accepted-source-bound-choice-label'};
   semantic.relations=(semantic.relations||[]).filter(r=>!(r.type==='labels'&&r.to===`widget:${widget.id}`));for(const label of labels)semantic.relations.push({type:'labels',from:label.id,to:`widget:${widget.id}`,evidence:'accepted-source-bound-choice-label'});
  }
 }
 const chosen=new Set(review.groups.flatMap(g=>g.widgets.map(w=>w.widgetId)));
 semantic.semanticReviewTasks=(semantic.semanticReviewTasks||[]).filter(t=>!chosen.has(t.widgetId)||!['FORM_LABEL_AMBIGUOUS','FORM_CHOICE_LABEL_REVIEW'].includes(t.code));
 for(const field of semantic.formRelationships||[])field.labels=[...new Set(field.widgets.flatMap(w=>w.labelNodeIds||[]))];
 if(semantic.formNavigation)semantic.formNavigation.unresolvedWidgetIds=semantic.formNavigation.unresolvedWidgetIds.filter(id=>!chosen.has(id));
 semantic.formChoiceReview={schemaVersion:'1.0.0',sourceHash,originalIntentHash:review.intentHash,reviewHash:sha(reviewBytes),contentHash:sha(JSON.stringify(semantic)),reviewer:review.reviewer,evidence:review.evidence,fieldRefs:review.groups.map(g=>g.fieldRef)};
 require(validSemantic(semantic),'Reviewed choice output failed semantic contract');return semantic;
}
async function main(){
 const a=new Map();for(let i=2;i<process.argv.length;i+=2){require(['--pdf','--semantic','--review','--output'].includes(process.argv[i])&&process.argv[i+1]&&!a.has(process.argv[i]),'Invalid choice review arguments');a.set(process.argv[i],process.argv[i+1]);}require(a.size===4,'Required: --pdf --semantic --review --output');
 const source=await realpath(a.get('--pdf')),intent=await realpath(a.get('--semantic')),review=await realpath(a.get('--review')),target=path.resolve(a.get('--output'));
 require(![source,intent,review].some(p=>p.toLowerCase()===target.toLowerCase()),'Output must differ from every input');require((await stat(intent)).size<=32*1024*1024&&(await stat(review)).size<=1024*1024,'Choice review inputs exceed size limit');
 const hash=createHash('sha256');for await(const bytes of createReadStream(source))hash.update(bytes);const sourceHash=hash.digest('hex'),semanticBytes=await readFile(intent),reviewBytes=await readFile(review),result=applyChoiceReview({semanticBytes,reviewBytes,sourceHash});
 const again=createHash('sha256');for await(const bytes of createReadStream(source))again.update(bytes);require(sourceHash===again.digest('hex')&&semanticBytes.equals(await readFile(intent))&&reviewBytes.equals(await readFile(review)),'Choice review inputs changed');
 await writeFile(target,JSON.stringify(result,null,2)+'\n',{flag:'wx'});process.stdout.write(JSON.stringify(result.formChoiceReview)+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{process.stderr.write(e.message+'\n');process.exitCode=1;});
