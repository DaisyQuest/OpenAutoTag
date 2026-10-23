import test from 'node:test';import assert from 'node:assert/strict';import{mkdtemp,mkdir,readFile,writeFile,rm,open}from'node:fs/promises';import path from'node:path';import os from'node:os';import{createHash}from'node:crypto';import{execFile}from'node:child_process';import{promisify}from'node:util';import{PDFDocument,PDFName,PDFString}from'pdf-lib';
import{parsePdf}from'../../parser/index.js';import{analyzeLayout}from'../../layout-analyzer/index.js';import{buildSemanticDocument}from'../../semantic-engine/index.js';import{buildTagTree}from'../../tag-builder/index.js';import{writeTaggedArtifacts}from'../index.js';import{applyReviewedFieldNames}from'../reviewed-field-names.js';import{checkSavedSemantics}from'../../../scripts/check-saved-semantics.js';import{resolveJavaTool,buildJavaExecEnv}from'../../../scripts/java-runtime.js';
import{checkPdfPreservation}from'../../../scripts/check-pdf-preservation.js';import{validateTaggedArtifacts}from'../../validator/index.js';
const hash=b=>createHash('sha256').update(b).digest('hex'),key=PDFName.of;
test('accepted missing names change only TU and survive fresh tagging and field editing',async t=>{
 const dir=process.env.FIELD_NAME_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),'field-name-'));await mkdir(dir,{recursive:true});if(!process.env.FIELD_NAME_EVIDENCE_DIR)t.after(()=>rm(dir,{recursive:true,force:true}));
 const sourcePdf=path.join(dir,'source.pdf'),outputPdf=path.join(dir,'named.pdf'),semanticPath=path.join(dir,'semantic.json'),reviewPath=path.join(dir,'review.json');
 const bundledJavaHome=path.resolve('modules/validator/vendor/java'),java=await resolveJavaTool('java','PIPELINE_JAVA_PATH',{bundledJavaHome}),env=await buildJavaExecEnv({bundledJavaHome});
 const run=(name,...args)=>promisify(execFile)(java,['-XX:TieredStopAtLevel=1','-cp',path.resolve('modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar'),path.resolve(`modules/pdf-writer/test/fixtures/${name}.java`),...args],{env,windowsHide:true,timeout:120000,maxBuffer:8*1024*1024});
 await run('NativeWidgetFixture','create',sourcePdf,path.resolve('modules/font-embedder/vendor/fonts/noto-sans/NotoSans-Regular.ttf'),'missing-name');const original=await readFile(sourcePdf);
 async function semantics(pdf,file){const raw=file+'.raw.json',layout=file+'.layout.json';await writeFile(raw,JSON.stringify(await parsePdf(pdf)));await writeFile(layout,JSON.stringify(await analyzeLayout(raw)));const value=await buildSemanticDocument(layout);await writeFile(file,JSON.stringify(value));return value;}
 const semantic=await semantics(sourcePdf,semanticPath),widgets=semantic.formRelationships.find(f=>f.id==='name').widgets;
 assert.equal(widgets.length,2);assert.ok(widgets.every(w=>!w.tooltip&&w.fieldRef===widgets[0].fieldRef));assert.equal(semantic.formRelationships.find(f=>f.id==='consent').widgets[0].tooltip,'Consent');
 const entry={fieldRef:widgets[0].fieldRef,fieldName:'name',widgetRefs:widgets.map(w=>w.id.replace(/^(\d+)R(\d*)$/,(_,n,g)=>`${n} ${g||0} R`)),label:'Full name',labelNodeIds:widgets.flatMap(w=>w.labelNodeIds)};
 const review={schemaVersion:'1.0.0',sourceHash:hash(original),intentHash:hash(await readFile(semanticPath)),decision:'accepted',reviewer:'Automated regression oracle',evidence:'Fixture label is explicitly authored Full name on both pages; this is test approval, not human review.',fields:[entry]};await writeFile(reviewPath,JSON.stringify(review));
 const proof=await applyReviewedFieldNames({sourcePdf,outputPdf,semanticPath,reviewPath});assert.equal(proof.changedFields.length,1);assert.equal(proof.verification.status,'pass');await writeFile(path.join(dir,'proof.json'),JSON.stringify(proof,null,2));
 assert.deepEqual((await readFile(outputPdf)).subarray(0,original.length),original);
 const verified=await applyReviewedFieldNames({sourcePdf,candidatePdf:outputPdf,semanticPath,reviewPath});assert.equal(verified.candidateHash,proof.candidateHash);
 await t.test('CLI verifies saved output and rejects ambiguous arguments',async()=>{
  const cli=path.resolve('modules/pdf-writer/reviewed-field-names.js'),args=['--pdf',sourcePdf,'--verify',outputPdf,'--semantic',semanticPath,'--review',reviewPath];
  const {stdout}=await promisify(execFile)(process.execPath,[cli,...args],{windowsHide:true});assert.equal(JSON.parse(stdout).candidateHash,proof.candidateHash);
  for(const tail of [['--unknown','x'],['--review',reviewPath],['--output']])await assert.rejects(promisify(execFile)(process.execPath,[cli,...args,...tail],{windowsHide:true}),/Invalid reviewed-field-names arguments/);
 });
 await t.test('input limits and review attribution fail before producing output',async()=>{
  const options={sourcePdf,outputPdf:path.join(dir,'unsafe-output.pdf'),semanticPath,reviewPath};
  await assert.rejects(applyReviewedFieldNames(),/Required/);await assert.rejects(applyReviewedFieldNames({...options,candidatePdf:outputPdf}),/Required/);
  for(const property of ['reviewer','evidence']){const file=path.join(dir,'blank-'+property+'.json');await writeFile(file,JSON.stringify({...review,[property]:' '}));await assert.rejects(applyReviewedFieldNames({...options,reviewPath:file}),/attribution and evidence/);}
  for(const [property,size]of[['reviewPath',1024*1024+1],['semanticPath',32*1024*1024+1]]){const file=path.join(dir,property+'-oversize.json'),handle=await open(file,'w');try{await handle.truncate(size);}finally{await handle.close();}await assert.rejects(applyReviewedFieldNames({...options,[property]:file}),/size limit/);}
  await assert.rejects(readFile(options.outputPdf),{code:'ENOENT'});
 });
 const named=await semantics(outputPdf,path.join(dir,'named-semantic.json'));assert.ok(named.formRelationships.find(f=>f.id==='name').widgets.every(w=>w.tooltip==='Full name'&&w.tooltipSource==='field-TU'));
 const tagsPath=path.join(dir,'tags.json'),candidate=path.join(dir,'candidate.pdf');await writeFile(tagsPath,JSON.stringify(await buildTagTree(path.join(dir,'named-semantic.json'))));await writeTaggedArtifacts({pdfPath:outputPdf,outputPath:candidate,semanticPath:path.join(dir,'named-semantic.json'),tagsPath,mode:'native'});
 const saved=await checkSavedSemantics({pdfPath:candidate,tagsPath,sourcePdfPath:outputPdf,ownershipPath:candidate+'.ownership.json',outputPath:path.join(dir,'saved.json')});assert.equal(saved.summary.failed,0,JSON.stringify(saved.checks.filter(c=>c.status==='fail')));
 assert.match((await run('NativeOperatorProbe','pixels',sourcePdf,candidate)).stdout,/All pages pixel-identical/);
 for(const [input,output]of[[sourcePdf,candidate+'.source-filled.pdf'],[candidate,candidate+'.filled.pdf']])assert.match((await run('NativeWidgetFixture','edit',input,output)).stdout,/survived save\/reopen/);
 assert.match((await run('NativeOperatorProbe','pixels',candidate+'.source-filled.pdf',candidate+'.filled.pdf')).stdout,/All pages pixel-identical/);
 const mutate=async(input,name,change)=>{const doc=await PDFDocument.load(await readFile(input),{updateMetadata:false});const objects=doc.context.enumerateIndirectObjects().map(([,v])=>v);change(doc,objects);const file=path.join(dir,name+'.pdf');await writeFile(file,await doc.save({updateFieldAppearances:false}));return file;};
 await t.test('preservation gate independently qualifies only the reviewed names',async()=>{
  const validationReport=path.join(dir,'named-validation.json');await writeFile(validationReport,JSON.stringify(await validateTaggedArtifacts({pdfPath:outputPdf,manifestPath:candidate+'.tags.json'})));
  const quality=await checkPdfPreservation({sourcePdf,candidatePdf:outputPdf,semanticPath,fieldNameReviewPath:reviewPath,validationReport,outputPath:path.join(dir,'quality.json')});
  for(const id of ['qualifiedFieldNameChanges','fields','widgets','pageContentAndResources'])assert.equal(quality.checks.find(c=>c.id===id)?.status,'pass',JSON.stringify(quality));assert.equal(quality.disposition,'review_required');
  const without=await checkPdfPreservation({sourcePdf,candidatePdf:outputPdf,semanticPath,validationReport,outputPath:path.join(dir,'unqualified-quality.json')});assert.equal(without.disposition,'rejected');
 });
 await t.test('missing default appearance is not invented during name repair',async()=>{
  const noDa=await mutate(sourcePdf,'no-da',doc=>doc.catalog.lookup(key('AcroForm')).delete(key('DA'))),request=path.join(dir,'no-da-review.json'),target=path.join(dir,'no-da-named.pdf');await writeFile(request,JSON.stringify({...review,sourceHash:hash(await readFile(noDa))}));
  await applyReviewedFieldNames({sourcePdf:noDa,outputPdf:target,semanticPath,reviewPath:request});const pdf=await PDFDocument.load(await readFile(target));assert.equal(pdf.catalog.lookup(key('AcroForm')).get(key('DA')),undefined);
 });
 await t.test('accepted text, checkbox, choice and button names change in one bounded repair',async()=>{
  const source=await mutate(sourcePdf,'multi-source',(_,objects)=>{for(const field of objects.filter(v=>['consent','state','reset'].includes(v.get?.(key('T'))?.decodeText?.())))field.delete(key('TU'));});
  const intentPath=path.join(dir,'multi-semantic.json'),intent=await semantics(source,intentPath),entries=[];
  for(const [name,label]of[['name','Full name'],['consent','Consent'],['state','State'],['reset','Reset form']]) {
    const group=intent.formRelationships.find(f=>f.id===name).widgets;
    // These two explicit associations are fixture review decisions; the
    // ordinary inference remains conservative for distant visual labels.
    if(['consent','state'].includes(name))for(const w of group){w.labelStatus='associated';w.labelNodeIds=intent.nodes.filter(n=>n.pageNumber===w.pageNumber&&n.text===label+':').map(n=>n.id);assert.equal(w.labelNodeIds.length,1);}
    entries.push({fieldRef:group[0].fieldRef,fieldName:name,widgetRefs:group.map(w=>w.id.replace(/^(\d+)R(\d*)$/,(_,n,g)=>`${n} ${g||0} R`)),label,labelNodeIds:group.flatMap(w=>w.labelNodeIds||[])});
  }
  await writeFile(intentPath,JSON.stringify(intent));const request=path.join(dir,'multi-review.json'),target=path.join(dir,'multi-named.pdf');await writeFile(request,JSON.stringify({...review,sourceHash:hash(await readFile(source)),intentHash:hash(await readFile(intentPath)),fields:entries}));
  const result=await applyReviewedFieldNames({sourcePdf:source,outputPdf:target,semanticPath:intentPath,reviewPath:request});assert.equal(result.changedFields.length,4);await writeFile(path.join(dir,'multi-proof.json'),JSON.stringify(result,null,2));assert.match((await run('NativeOperatorProbe','pixels',source,target)).stdout,/All pages pixel-identical/);
 });
 for(const kind of ['value','name','action','appearance'])await t.test(`saved ${kind} corruption fails exact replay`,async()=>{
  const bad=await mutate(outputPdf,'bad-'+kind,(doc,objects)=>{const field=objects.find(v=>v.get?.(key('T'))?.decodeText?.()==='name');if(kind==='value')field.set(key('V'),PDFString.of('Wrong'));if(kind==='name')field.set(key('TU'),PDFString.of('Wrong'));if(kind==='action')field.delete(key('AA'));if(kind==='appearance')doc.context.lookup(field.lookup(key('Kids')).get(0)).delete(key('AP'));});
  await assert.rejects(applyReviewedFieldNames({sourcePdf,candidatePdf:bad,semanticPath,reviewPath}),/Unexpected saved-object change/);
 });
 for(const kind of ['stale-source','stale-intent','pending','partial-widgets','wrong-label','duplicate'])await t.test(`refuse ${kind} review`,async()=>{
  const bad=structuredClone(review);if(kind==='stale-source')bad.sourceHash='0'.repeat(64);if(kind==='stale-intent')bad.intentHash='0'.repeat(64);if(kind==='pending')bad.decision='pending';if(kind==='partial-widgets')bad.fields[0].widgetRefs.pop();if(kind==='wrong-label')bad.fields[0].label='Other name';if(kind==='duplicate')bad.fields.push(bad.fields[0]);
  const file=path.join(dir,kind+'.json');await writeFile(file,JSON.stringify(bad));await assert.rejects(applyReviewedFieldNames({sourcePdf,outputPdf:path.join(dir,kind+'.pdf'),semanticPath,reviewPath:file}));
 });
 for(const where of ['field','widget'])await t.test(`existing ${where} name is never overwritten`,async()=>{
  const namedSource=await mutate(sourcePdf,'authored-'+where,(doc,objects)=>{const field=objects.find(v=>v.get?.(key('T'))?.decodeText?.()==='name'),target=where==='field'?field:doc.context.lookup(field.lookup(key('Kids')).get(0));target.set(key('TU'),PDFString.of('Authored name'));});
  const updated={...review,sourceHash:hash(await readFile(namedSource))},file=path.join(dir,where+'-review.json');await writeFile(file,JSON.stringify(updated));await assert.rejects(applyReviewedFieldNames({sourcePdf:namedSource,outputPdf:path.join(dir,where+'-refused.pdf'),semanticPath,reviewPath:file}),/authored accessible name already exists/);
 });
 for(const kind of ['xfa','signed','encrypted','no-form'])await t.test(`unsupported ${kind} source declines without output`,async()=>{
  const changed=kind==='encrypted'?path.join(dir,'encrypted.pdf'):await mutate(sourcePdf,'unsupported-'+kind,(doc,objects)=>{
   if(kind==='xfa')doc.catalog.lookup(key('AcroForm')).set(key('XFA'),doc.context.obj([]));
   if(kind==='no-form')doc.catalog.delete(key('AcroForm'));
   if(kind==='signed'){const field=objects.find(v=>v.get?.(key('T'))?.decodeText?.()==='name');field.set(key('FT'),key('Sig'));field.set(key('V'),doc.context.obj({Type:'Sig'}));}
  });
  if(kind==='encrypted')await run('NativeWidgetFixture','encrypt',sourcePdf,changed);
  const request=path.join(dir,kind+'-review.json'),target=path.join(dir,kind+'-refused.pdf');await writeFile(request,JSON.stringify({...review,sourceHash:hash(await readFile(changed))}));
  await assert.rejects(applyReviewedFieldNames({sourcePdf:changed,outputPdf:target,semanticPath,reviewPath:request}),/Encrypted or signed|native AcroForm/);await assert.rejects(readFile(target),{code:'ENOENT'});
 });
 await t.test('a blank terminal name can be repaired without changing widget-local properties',async()=>{
  const blank=await mutate(sourcePdf,'blank-source',(_,objects)=>objects.find(v=>v.get?.(key('T'))?.decodeText?.()==='name').set(key('TU'),PDFString.of('   '))),request=path.join(dir,'blank-review.json');await writeFile(request,JSON.stringify({...review,sourceHash:hash(await readFile(blank))}));
  const result=await applyReviewedFieldNames({sourcePdf:blank,outputPdf:path.join(dir,'blank-named.pdf'),semanticPath,reviewPath:request});assert.equal(result.changedFields[0].label,'Full name');
 });
 await assert.rejects(applyReviewedFieldNames({sourcePdf,outputPdf:sourcePdf,semanticPath,reviewPath}),/overwrite an input/);await assert.rejects(applyReviewedFieldNames({sourcePdf,outputPdf,semanticPath,reviewPath}),/overwrite existing output/);assert.deepEqual(await readFile(sourcePdf),original);
 await writeFile(path.join(dir,'evidence.json'),JSON.stringify({sourcePdf,outputPdf,semanticPath,reviewPath,candidate,tagsPath,sourceHash:hash(original),namedHash:proof.candidateHash,candidateHash:hash(await readFile(candidate)),saved:saved.summary,fields:6,widgets:8,changedFields:proof.changedFields,pixelMatch:true,editable:['text','checkbox','radio','choice']},null,2));
});
