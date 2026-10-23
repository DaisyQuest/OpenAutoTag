const normal=value=>String(value||'').normalize('NFKC').replace(/[\s:]+$/u,'').replace(/\s+/gu,' ').trim().toLowerCase();
// A radio TU describes the group, not each individual choice. Keep it intact;
// bind distinct visible labels to their exact source widgets for logical order.
export function radioChoiceLabel(widget,nodes) {
  const control=widget.choiceControl;if(control?.kind!=='radio'||control.stateIssues.length)return null;
  const candidates=nodes.filter(n=>n.role!=='Artifact'&&!n.tableId&&n.pageNumber===widget.pageNumber&&n.formFieldIds?.includes(widget.id)&&normal(n.text));
  const exact=candidates.filter(n=>[control.exportValue,control.onState].some(v=>normal(v)===normal(n.text)));
  const selected=exact.length===1?exact:candidates.length===1&&candidates[0].formFieldIds.length===1?candidates:[];
  return selected.length?{labels:selected,label:selected.map(n=>n.text.trim()).join(' '),association:{kind:'radio-choice',evidence:exact.length===1?'native-radio-choice-and-visible-label':'unique-radio-widget-label'}}:null;
}
