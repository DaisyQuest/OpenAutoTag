const normal = value => String(value).normalize('NFKC').replace(/^\s*[☐☑☒]\s*/, '').replace(/[\s.:]+$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
const reference = id => { const m = /^([1-9]\d*)R(\d+)?$/.exec(id);return m ? `${m[1]} ${Number(m[2] || 0)} R` : null; };
const require = (ok, why) => { if (!ok) throw new Error(why); };

// Review controls the decision. Intent proves which source labels and widgets
// were reviewed, rather than allowing a field-name string to select a control.
export function validateFieldNameIntent(review, semantic) {
  const nodes = new Map(semantic.nodes.map(n => [n.id, n]));
  require(nodes.size === semantic.nodes.length, 'Duplicate semantic node identity');
  const fields = new Map(), widgets = new Set(), selected = new Set();
  for (const field of semantic.formRelationships || []) for (const widget of field.widgets) {
    require(!widgets.has(widget.id), 'Duplicate semantic widget identity');widgets.add(widget.id);
    if (!widget.fieldRef) continue;
    const list = fields.get(widget.fieldRef) || [];list.push(widget);fields.set(widget.fieldRef, list);
  }
  for (const entry of review.fields) {
    require(!selected.has(entry.fieldRef), 'Duplicate reviewed field identity');selected.add(entry.fieldRef);
    const group = fields.get(entry.fieldRef);
    require(group?.length && group.every(w => w.fieldName === entry.fieldName), 'Reviewed field does not resolve in semantic intent');
    require(JSON.stringify(group.map(w => reference(w.id)).sort()) === JSON.stringify([...entry.widgetRefs].sort()), 'Review must identify every field widget exactly once');
    require(entry.label.trim() === entry.label && entry.label.isWellFormed() && !/[\x00-\x1f\x7f-\x9f\ufffd]/u.test(entry.label), 'Invalid reviewed accessible name');
    const name = normal(entry.label);require(Boolean(name), 'Empty reviewed accessible name');
    const selectedLabels = new Set(entry.labelNodeIds), available = new Set();
    for (const widget of group) {
      const labels = widget.labelStatus === 'associated' ? widget.labelNodeIds || [] : widget.labelStatus === 'associated-context' ? widget.contextNodeIds || [] : [];
      const appearance = widget.pushButton && widget.labelStatus === 'associated-appearance' && widget.appearanceTextSource === 'normal-widget-appearance' && normal(widget.appearanceText || '');
      require(labels.length && labels.every(id => selectedLabels.has(id)) || appearance && name.includes(appearance), 'Every widget needs a complete accepted label association or its own visible button text');
      for (const id of labels) {
        const node = nodes.get(id);
        require(node && node.pageNumber === widget.pageNumber && node.role !== 'Artifact' && normal(node.text), 'Widget label does not resolve on its source page');available.add(id);
      }
      if (labels.length) require(name.includes(labels.map(id => normal(nodes.get(id).text)).join(' ')), 'Accessible name must contain the complete visible label in order');
    }
    for (const id of entry.labelNodeIds) require(available.has(id) && name.includes(normal(nodes.get(id).text)), 'Accessible name must contain its selected visible labels');
  }
}
