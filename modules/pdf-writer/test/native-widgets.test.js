import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {PDFDocument,PDFName,PDFString} from 'pdf-lib';
import {parsePdf} from '../../parser/index.js';import {analyzeLayout} from '../../layout-analyzer/index.js';import {buildSemanticDocument} from '../../semantic-engine/index.js';import {buildTagTree} from '../../tag-builder/index.js';import {writeTaggedArtifacts} from '../index.js';import {checkSavedSemantics} from '../../../scripts/check-saved-semantics.js';import {resolveJavaTool,buildJavaExecEnv} from '../../../scripts/java-runtime.js';
const all=n=>[n,...n.children.flatMap(all)],key=PDFName.of;
test('native widgets keep distinct source ownership, field properties and editable behavior',async t=>{
 const dir=process.env.WIDGET_EVIDENCE_DIR||await mkdtemp(path.join(os.tmpdir(),'native-widgets-'));await mkdir(dir,{recursive:true});if(!process.env.WIDGET_EVIDENCE_DIR)t.after(()=>rm(dir,{recursive:true,force:true}));
 const pdfPath=path.join(dir,'source.pdf'),rawPath=path.join(dir,'raw.json'),layoutPath=path.join(dir,'layout.json'),semanticPath=path.join(dir,'semantic.json'),tagsPath=path.join(dir,'tags.json'),outputPath=path.join(dir,'candidate.pdf');
 const bundledJavaHome=path.resolve('modules/validator/vendor/java'),java=await resolveJavaTool('java','PIPELINE_JAVA_PATH',{bundledJavaHome}),env=await buildJavaExecEnv({bundledJavaHome});
 const run=(name,...args)=>promisify(execFile)(java,['-XX:TieredStopAtLevel=1','-cp',path.resolve('modules/pdf-writer/vendor/pdfbox-app-3.0.8.jar'),path.resolve(`modules/pdf-writer/test/fixtures/${name}.java`),...args],{env,windowsHide:true,timeout:120000,maxBuffer:8*1024*1024});
 await run('NativeWidgetFixture','create',pdfPath,path.resolve('modules/font-embedder/vendor/fonts/noto-sans/NotoSans-Regular.ttf'));const original=await readFile(pdfPath);
 await writeFile(rawPath,JSON.stringify(await parsePdf(pdfPath)));await writeFile(layoutPath,JSON.stringify(await analyzeLayout(rawPath)));const semantic=await buildSemanticDocument(layoutPath);await writeFile(semanticPath,JSON.stringify(semantic));const tags=await buildTagTree(semanticPath);await writeFile(tagsPath,JSON.stringify(tags));
 const forms=all(tags.root).filter(n=>n.nativeWidget);assert.equal(forms.length,8);assert.equal(new Set(forms.map(n=>n.nativeWidget.sourceRef)).size,8);assert.equal(forms.filter(n=>n.nativeWidget.fieldName==='name').length,2);assert.ok(forms.filter(n=>n.nativeWidget.fieldName==='name').every(n=>n.nativeWidget.placement==='label-context'));
 await writeTaggedArtifacts({pdfPath,outputPath,semanticPath,tagsPath,mode:'native'});
 const check=async file=>checkSavedSemantics({pdfPath:file,tagsPath,sourcePdfPath:pdfPath,ownershipPath:outputPath+'.ownership.json'});
 const saved=await check(outputPath);await writeFile(path.join(dir,'saved.json'),JSON.stringify(saved,null,2));assert.equal(saved.summary.failed,0,JSON.stringify(saved.checks.filter(c=>c.status==='fail')));assert.equal(saved.checks.filter(c=>c.code==='NATIVE_WIDGET_FORM_OWNER').length,8);
 const report=JSON.parse(await readFile(outputPath+'.ownership.json'));assert.equal(report.nativeWidgets.length,8);assert.ok(report.nativeWidgets.every(w=>!w.generated));
 assert.match((await run('NativeOperatorProbe','pixels',pdfPath,outputPath)).stdout,/All pages pixel-identical/);
 for(const [input,output] of [[pdfPath,outputPath+'.source-filled.pdf'],[outputPath,outputPath+'.filled.pdf']])assert.match((await run('NativeWidgetFixture','edit',input,output)).stdout,/survived save\/reopen/);
 assert.match((await run('NativeOperatorProbe','pixels',outputPath+'.source-filled.pdf',outputPath+'.filled.pdf')).stdout,/All pages pixel-identical/);assert.deepEqual(await readFile(pdfPath),original);
 const corrupt=async(name,mutate,expected)=>{
  const doc=await PDFDocument.load(await readFile(outputPath));const objects=doc.context.enumerateIndirectObjects().map(([ref,obj])=>({ref,obj}));await mutate(doc,objects);const file=path.join(dir,name+'.pdf');await writeFile(file,await doc.save({updateFieldAppearances:false}));const validation=await check(file);assert.ok(validation.checks.some(c=>c.status==='fail'&&expected.includes(c.code)),JSON.stringify(validation.checks.filter(c=>c.status==='fail')));
 };
 await t.test('swapping OBJRs between same-field widgets rejects',()=>corrupt('swapped',(doc,objects)=>{
  const selected=forms.filter(n=>n.nativeWidget.fieldName==='name').map(n=>objects.find(v=>v.obj.get?.(key('ID'))?.decodeText?.()==='oat:'+n.id).obj);const k=selected[0].get(key('K'));selected[0].set(key('K'),selected[1].get(key('K')));selected[1].set(key('K'),k);
 },['NATIVE_WIDGET_FORM_OWNER']));
 await t.test('changing a saved tooltip rejects',()=>corrupt('tooltip',(doc,objects)=>{objects.find(v=>v.obj.get?.(key('T'))?.decodeText?.()==='name').obj.set(key('TU'),PDFString.of('Wrong label'));},['NATIVE_WIDGET_FIELDSTATEHASH']));
 await t.test('changing a saved value rejects',()=>corrupt('value',(doc,objects)=>{objects.find(v=>v.obj.get?.(key('T'))?.decodeText?.()==='name').obj.set(key('V'),PDFString.of('Wrong value'));},['NATIVE_WIDGET_FIELDSTATEHASH']));
 await t.test('changing a saved action rejects',()=>corrupt('action',(doc,objects)=>{objects.find(v=>v.obj.get?.(key('S'))===key('ResetForm')).obj.set(key('Flags'),doc.context.obj(1));},['NATIVE_WIDGET_NATIVEDIGEST']));
 await t.test('wrong ParentTree key rejects',()=>corrupt('parent-key',(doc,objects)=>{objects.find(v=>v.obj.get?.(key('Subtype'))===key('Widget')).obj.set(key('StructParent'),doc.context.obj(100000));},['NATIVE_WIDGET_PARENT_KEY']));
 await t.test('missing appearance rejects',()=>corrupt('appearance',(doc,objects)=>{objects.find(v=>v.obj.get?.(key('Subtype'))===key('Widget')).obj.delete(key('AP'));},['NATIVE_WIDGET_APPEARANCEHASH']));
 await t.test('wrong widget page rejects',()=>corrupt('page',(doc,objects)=>{objects.find(v=>v.obj.get?.(key('Subtype'))===key('Widget')).obj.set(key('P'),doc.getPage(1).ref);},['NATIVE_WIDGET_NATIVEDIGEST']));
 await t.test('missing saved widget rejects',()=>corrupt('missing-widget',doc=>{doc.getPage(0).node.lookup(key('Annots')).remove(0);},['NATIVE_WIDGET_COUNT']));
 await t.test('disconnecting a field from AcroForm rejects',()=>corrupt('missing-field',doc=>{doc.catalog.lookup(key('AcroForm')).lookup(key('Fields')).remove(0);},['NATIVE_WIDGET_FIELDSTATEHASH']));
 await t.test('older intent still owns every widget and raster cannot flatten them',async()=>{
  const legacy=structuredClone(tags),strip=n=>{n.children=n.children.filter(c=>!c.nativeWidget);n.children.forEach(strip);};strip(legacy.root);delete legacy.source.widgetNavigation;
  const legacyTags=path.join(dir,'legacy-tags.json'),candidate=path.join(dir,'legacy.pdf');await writeFile(legacyTags,JSON.stringify(legacy));
  await writeTaggedArtifacts({pdfPath,outputPath:candidate,semanticPath,tagsPath:legacyTags,mode:'native'});
  const result=await checkSavedSemantics({pdfPath:candidate,tagsPath:legacyTags,sourcePdfPath:pdfPath,ownershipPath:candidate+'.ownership.json'});assert.equal(result.summary.failed,0,JSON.stringify(result.checks.filter(c=>c.status==='fail')));
  const ownership=JSON.parse(await readFile(candidate+'.ownership.json'));assert.equal(ownership.nativeWidgets.length,8);assert.ok(ownership.nativeWidgets.every(w=>w.generated&&w.placement==='unresolved'));
  await assert.rejects(writeTaggedArtifacts({pdfPath,outputPath:path.join(dir,'flattened.pdf'),semanticPath,tagsPath:legacyTags,mode:'raster'}),/Raster output would flatten native form widgets/);
  const damaged=await PDFDocument.load(original);damaged.getPage(0).node.lookup(key('Annots')).remove(0);const orphan=path.join(dir,'orphan-source.pdf');await writeFile(orphan,await damaged.save({updateFieldAppearances:false}));
  await assert.rejects(writeTaggedArtifacts({pdfPath:orphan,outputPath:path.join(dir,'orphan.pdf'),semanticPath,tagsPath:legacyTags,mode:'native'}),/Native field widget is absent from page annotations/);
 });
 await t.test('missing authored names remain missing without generic tooltips',async()=>{
  const source=path.join(dir,'missing-name-source.pdf'),candidate=path.join(dir,'missing-name.pdf');const pdf=await PDFDocument.load(original);
  pdf.context.enumerateIndirectObjects().find(([,v])=>v.get?.(key('T'))?.decodeText?.()==='name')[1].delete(key('TU'));await writeFile(source,await pdf.save({updateFieldAppearances:false}));
  await writeTaggedArtifacts({pdfPath:source,outputPath:candidate,semanticPath,tagsPath,mode:'native'});
  const result=await checkSavedSemantics({pdfPath:candidate,tagsPath,sourcePdfPath:source,ownershipPath:candidate+'.ownership.json'});assert.equal(result.summary.failed,0,JSON.stringify(result.checks.filter(c=>c.status==='fail')));
  const savedDoc=await PDFDocument.load(await readFile(candidate)),objects=savedDoc.context.enumerateIndirectObjects().map(([,v])=>v),field=objects.find(v=>v.get?.(key('T'))?.decodeText?.()==='name');assert.equal(field.get(key('TU')),undefined);
  for(const child of field.lookup(key('Kids')).asArray()){const widget=savedDoc.context.lookup(child);assert.equal(widget.get(key('TU')),undefined);assert.equal(widget.get(key('Contents')),undefined);}
 });
 for(const mutation of ['wrong-reference','wrong-page','wrong-name','duplicate'])await t.test(`refuse ${mutation} intent without changing the source`,async()=>{
  const bad=structuredClone(tags),widgets=all(bad.root).filter(n=>n.nativeWidget),n=widgets[0];if(mutation==='wrong-reference')n.nativeWidget.sourceRef='999999 0 R';if(mutation==='wrong-page')n.nativeWidget.pageNumber=2;if(mutation==='wrong-name')n.nativeWidget.fieldName='other';if(mutation==='duplicate'){widgets[1].nativeWidget={...n.nativeWidget};}
  const p=path.join(dir,mutation+'.json');await writeFile(p,JSON.stringify(bad));await assert.rejects(writeTaggedArtifacts({pdfPath,outputPath:path.join(dir,mutation+'.pdf'),semanticPath,tagsPath:p,mode:'native'}),/intent does not resolve uniquely/);assert.deepEqual(await readFile(pdfPath),original);
 });
 await writeFile(path.join(dir,'evidence.json'),JSON.stringify({pdfPath,outputPath,semanticPath,tagsPath,rawPath,layoutPath,saved:saved.summary,widgets:8,forms:forms.map(n=>({id:n.id,...n.nativeWidget})),pixelMatch:true,fillSaveReopen:['text','checkbox','radio','choice']},null,2));
});
