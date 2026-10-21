// Rule reports use independently adjudicated, hash-bound holdout decisions only.
// No heuristic confidence is interpreted as a probability.
const wilsonLower=(yes,total)=>{
  if(!total)return null;
  const z=1.959963984540054,p=yes/total,d=1+z*z/total;
  return (p+z*z/(2*total)-z*Math.sqrt(p*(1-p)/total+z*z/(4*total*total)))/d;
};
export function calibrateAccuracy(decisions) {
  const rules=new Map(),seen=new Set();
  for(const d of decisions) {
    if(!d.rule || !d.documentId || !d.lineage || ![true,false].includes(d.expected) || ![true,false,null].includes(d.predicted)) throw new Error("Invalid calibration decision");
    const key=JSON.stringify([d.documentId,d.rule,d.id]);if(seen.has(key))throw new Error("Duplicate calibration decision");seen.add(key);
    if(d.split!=="holdout" || d.reviewStatus!=="adjudicated")continue;
    const group=rules.get(d.rule)||[];group.push(d);rules.set(d.rule,group);
  }
  return [...rules].sort(([a],[b])=>a.localeCompare(b)).map(([rule,rows])=>{
    const proposed=rows.filter(d=>d.predicted===true),tp=proposed.filter(d=>d.expected).length;
    const positive=rows.filter(d=>d.expected).length,clusters=new Map();
    for(const d of proposed){const c=clusters.get(d.lineage)||[];c.push(d);clusters.set(d.lineage,c);}
    const perfect=[...clusters.values()].filter(c=>c.every(d=>d.expected)).length;
    // A deliberately conservative guard: a lineage counts as successful only if all
    // automatic positive decisions in that lineage are correct. This is NOT a CI
    // for decision-level precision and is labeled separately in the report.
    const lower=wilsonLower(perfect,clusters.size);
    const precision=proposed.length?tp/proposed.length:null;
    return {rule,decisions:rows.length,documents:new Set(rows.map(d=>d.documentId)).size,lineages:clusters.size,
      truePositives:tp,falsePositives:proposed.length-tp,falseNegatives:positive-tp,
      precision,recall:positive?tp/positive:null,coverage:rows.filter(d=>d.predicted!==null).length/rows.length,
      positiveDecisionCoverage:proposed.length/rows.length,abstentions:rows.filter(d=>d.predicted===null).length,
      decisionPrecisionLower95:wilsonLower(tp,proposed.length),perfectLineageLower95:lower,
      status:proposed.length>=200&&clusters.size>=12&&precision>=.99&&lower>=.97?"eligible-for-release-review":"review-only"};
  });
}
