// Independently qualify writer-declared native links against saved objects and
// source glyph matrices. Unqualified extra Link containers are never transparent.
import {inspectLinkGeometry,containsLinkGlyph} from './link-geometry.js';
export function inspectNativeLinks({ source, inspection, ownership, sourceRuns, intendedNodes, add }) {
  const transparent = new Set(), grouped = new Set(), redundantActualText = new Set(); let valid = true;
  const byTag = new Map(intendedNodes.map(v => [v.n.id, v.id]));
  const intents = new Map(intendedNodes.map(v => [v.n.id, v.n]));
  const structures = new Map(inspection.structure.map(n => [n.objectRef, n]));
  const byId = new Map(inspection.structure.map(n => [n.identifier, n]));
  const declarations = ownership.nativeLinks || [], used = new Set();
  const rangesByTag = new Map();
  for (const range of ownership.ranges) { const list=rangesByTag.get(range.tagNodeId)||[];list.push(range);rangesByTag.set(range.tagNodeId,list); }
  const regions=new Map(Object.values(source.links || {}).map(link=>[link,inspectLinkGeometry(link)]));
  // Index once. Keep successful reports proportional to annotations, not glyphs.
  const sourceLinksByPage = new Map(), sourceRunsByPage = new Map(), savedByAddress = new Map();
  const append = (map, key, value) => { const values=map.get(key)||[];values.push(value);map.set(key,values); };
  for (const value of Object.values(source.links || {})) append(sourceLinksByPage,value.page,value);
  for (const run of source.textRuns || []) append(sourceRunsByPage,run.pageNumber,run);
  for (const entry of Object.entries(inspection.links || {})) append(savedByAddress,`${entry[1].page}:${entry[1].annotationIndex}`,entry);
  let work=0;
  const tick=()=>{if(++work>10000000)throw new Error('Native link verification work limit exceeded');};
  const check = (code, target, expected, actual) => {
    add(code, target, expected, actual);
    const passed = JSON.stringify(expected) === JSON.stringify(actual); valid &&= passed; return passed;
  };
  const contains = (annotation,matrix) => containsLinkGlyph(regions.get(annotation),matrix,tick);
  for (const link of declarations) {
    const target = `${link.pageNumber}:${link.annotationIndex}`, original = source.links?.[link.sourceAnnotationRef];
    check('NATIVE_LINK_UNIQUE_DECLARATION',target,false,used.has(target));used.add(target);
    check('NATIVE_LINK_DECLARED_SOURCE',target,true,Boolean(original&&original.page===link.pageNumber&&original.annotationIndex===link.annotationIndex));
    if (link.status !== 'bound') continue;
    let local = true;
    const verify = (code, expected, actual) => { const ok=check(code,target,expected,actual);local &&= ok;return ok; };
    const savedEntries=savedByAddress.get(target)||[];
    const [savedRef,saved] = savedEntries.length===1?savedEntries[0]:[];
    const node=byId.get(link.linkStructureId), owner=byId.get(byTag.get(link.ownerTagId));
    verify('NATIVE_LINK_SOURCE',true,Boolean(original&&original.page===link.pageNumber&&original.annotationIndex===link.annotationIndex&&original.visible&&regions.get(original).valid));
    verify('NATIVE_LINK_SAVED_ANNOTATION',true,Boolean(saved));
    verify('NATIVE_LINK_ROLE','Link',node?.role);
    verify('NATIVE_LINK_OWNER',true,Boolean(node&&owner&&(node===owner||node.parentRef===owner.objectRef)));
    if (!original||!saved||!node||!owner)continue;
    verify('NATIVE_LINK_ANNOTATION_PRESERVED',original.nativeDigest,saved.nativeDigest);
    verify('NATIVE_LINK_FINGERPRINT_AVAILABLE',true,Boolean(original.nativeDigest&&saved.nativeDigest));
    verify('NATIVE_LINK_DOCUMENT_GEOMETRY',source.pages?.map(p=>p.geometry),inspection.pages?.map(p=>p.geometry));
    if(original.contents?.trim())verify('NATIVE_LINK_AUTHORED_CONTENTS',original.contents,saved.contents);
    verify('NATIVE_LINK_OBJR',[node.objectRef],saved.owners);
    verify('NATIVE_LINK_PARENT_KEY',link.parentTreeKey,saved.structParent);
    const groupIds=link.groupedOwnerTagIds, members=groupIds?.map(id=>byId.get(byTag.get(id)));
    verify('NATIVE_LINK_CHILDREN',members?members.map(m=>m?.objectRef):[],node.children);
    verify('NATIVE_LINK_REPLACEMENT',false,Boolean(node.actualTextPresent||node.actualText));
    verify('NATIVE_LINK_OBJECT_REFERENCE',[`obj:${savedRef}`],node.contentRefs.filter(r=>r.startsWith('obj:')));
    let ancestor=structures.get(node.parentRef),depth=0,unmasked=true;
    while(ancestor&&++depth<=128){if(ancestor.actualTextPresent||ancestor.actualText)unmasked=false;ancestor=structures.get(ancestor.parentRef);}
    verify('NATIVE_LINK_ANCESTOR_REPLACEMENT',true,unmasked&&depth<=128);
    if(link.suppressedRedundantActualText){
      const intent=intents.get(link.ownerTagId),glyphs=[];let resolves=true;
      for(const range of ownership.ranges){
        tick();if(range.tagNodeId!==link.ownerTagId)continue;
        const run=sourceRuns.get(`${range.pageNumber}:${range.streamOrigin}:${range.operatorIndex}`);
        if(!run||range.glyphStart<0||range.glyphEnd>run.glyphs.length){resolves=false;continue;}
        for(let g=range.glyphStart;g<range.glyphEnd;g++){tick();glyphs.push({page:range.pageNumber,index:run.glyphStart+g,text:run.glyphs[g][1]});}
      }
      glyphs.sort((a,b)=>a.page-b.page||a.index-b.index);
      verify('NATIVE_LINK_REDUNDANT_REPLACEMENT',true,Boolean(resolves&&intent?.actualText&&!intent.children?.length&&
        !owner.actualTextPresent&&!owner.actualText&&glyphs.map(g=>g.text).join('')===intent.actualText));
    }
    const expected=[],known=new Set(),text=[];
    let rangesValid=true,unique=true,geometryValid=true,pageValid=true;
    for (const range of link.ranges || []) {
      tick();
      const run=sourceRuns.get(`${link.pageNumber}:${range.streamOrigin}:${range.operatorIndex}`);
      if(!run||!Number.isInteger(range.glyphStart)||!Number.isInteger(range.glyphEnd)||range.glyphStart<0||range.glyphEnd<=range.glyphStart||range.glyphEnd>run.glyphs.length){rangesValid=false;continue;}
      for(let g=range.glyphStart;g<range.glyphEnd;g++) {
        tick();
        const key=run.glyphStart+g;
        unique &&= !known.has(key);known.add(key);expected.push(key);text.push(run.glyphs[g][1]);
        if(run.glyphs[g][1].trim()&&!contains(original,run.positions?.[g]))geometryValid=false;
      }
    }
    verify('NATIVE_LINK_SOURCE_RANGE',true,rangesValid);
    verify('NATIVE_LINK_UNIQUE_GLYPH',true,unique);
    verify('NATIVE_LINK_GLYPH_GEOMETRY',true,geometryValid);
    verify('NATIVE_LINK_ANCHOR_TEXT',text.join(''),link.anchorText);
    const content=new Set(node.contentRefs.filter(r=>!r.startsWith('obj:'))),actual=[];
    if(groupIds) {
      const parentIntent=intents.get(link.ownerTagId), siblings=parentIntent?.children||[];
      const first=siblings.findIndex(c=>c.id===groupIds[0]), logical=[];
      verify('NATIVE_LINK_GROUP_SIBLINGS',true,Boolean(groupIds.length>=2&&groupIds.length<=4096&&new Set(groupIds).size===groupIds.length&&
        ['P','H1','H2','H3','H4','H5','H6','Caption','LBody','TH','TD'].includes(parentIntent?.type)&&
        first>=0&&groupIds.every((id,i)=>siblings[first+i]?.id===id)&&!(rangesByTag.get(link.ownerTagId)?.length)));
      verify('NATIVE_LINK_GROUP_CONTENT',[],[...content]);
      verify('NATIVE_LINK_GROUP_SUPPRESSION',false,Boolean(link.suppressedRedundantActualText));
      for(let i=0;i<groupIds.length;i++) {
        tick();const id=groupIds[i], intent=intents.get(id),member=members[i],glyphs=[];let resolves=true;
        for(const range of rangesByTag.get(id)||[]) {
          tick();const run=sourceRuns.get(`${range.pageNumber}:${range.streamOrigin}:${range.operatorIndex}`);
          if(!run||range.pageNumber!==link.pageNumber||range.glyphStart<0||range.glyphEnd>run.glyphs.length||range.glyphEnd<=range.glyphStart){resolves=false;continue;}
          for(let g=range.glyphStart;g<range.glyphEnd;g++){tick();glyphs.push({index:run.glyphStart+g,text:run.glyphs[g][1]});}
        }
        glyphs.sort((a,b)=>a.index-b.index);for(const glyph of glyphs)logical.push(glyph.index);
        const raw=glyphs.map(g=>g.text).join('');
        verify('NATIVE_LINK_GROUP_MEMBER',true,Boolean(resolves&&glyphs.length&&intent?.type==='Span'&&!intent.children?.length&&!intent.ocrSegments?.length&&
          !intent.alt&&(!intent.actualText||intent.actualText===raw)&&member?.role==='Span'&&member.parentRef===node.objectRef&&
          !member.children.length&&!member.alt&&(!member.actualTextPresent||member.actualText===raw)));
        for(const ref of member?.contentRefs||[]){tick();if(ref.startsWith('obj:'))verify('NATIVE_LINK_GROUP_MEMBER_OBJR',false,true);else content.add(ref);}
      }
      verify('NATIVE_LINK_GROUP_SOURCE_ORDER',logical,expected);
      // The logical sibling order may differ from source paint order. Both are
      // verified independently: /K above, physical glyph membership below.
      expected.sort((a,b)=>a-b);
    }
    for(const run of inspection.textRuns || []) {
      tick();
      if(!run.owners.some(r=>content.has(r)))continue;
      pageValid &&= link.pageNumber===run.pageNumber;
      for(let g=run.glyphStart;g<run.glyphEnd;g++){tick();actual.push(g);}
    }
    verify('NATIVE_LINK_PAGE',true,pageValid);
    verify('NATIVE_LINK_EXACT_GLYPHS',true,expected.length===actual.length&&expected.every((v,i)=>v===actual[i]));
    let meaningful=0,complete=true,unambiguous=true;
    for(const run of sourceRunsByPage.get(link.pageNumber)||[])for(let g=0;g<run.glyphs.length;g++) {
      tick();
      if(!run.glyphs[g][1].trim()||!contains(original,run.positions?.[g]))continue;
      meaningful++;complete &&= known.has(run.glyphStart+g);
      const overlapping=(sourceLinksByPage.get(link.pageNumber)||[]).filter(v=>v.visible&&contains(v,run.positions?.[g]));
      unambiguous &&= overlapping.length===1;
    }
    verify('NATIVE_LINK_COMPLETE_ANCHOR',true,complete);
    verify('NATIVE_LINK_UNAMBIGUOUS_GEOMETRY',true,unambiguous);
    verify('NATIVE_LINK_MEANINGFUL_ANCHOR',true,meaningful>0);
    if(local){transparent.add(node.objectRef);if(groupIds)grouped.add(node.objectRef);if(link.suppressedRedundantActualText)redundantActualText.add(owner.identifier);}
  }
  if (ownership.nativeLinks) for(const original of Object.values(source.links || {}))check('NATIVE_LINK_DECLARATION_COMPLETE',`${original.page}:${original.annotationIndex}`,true,used.has(`${original.page}:${original.annotationIndex}`));
  return {valid,transparent,grouped,redundantActualText};
}
