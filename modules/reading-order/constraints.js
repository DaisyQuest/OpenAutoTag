// Stable Kahn ordering: geometry supplies tie-breaking, explicit relationships supply constraints.
export function applyPrecedence(nodes, relations = []) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (byId.size !== nodes.length) throw new Error("Duplicate semantic node identity");
  const edges = new Map(nodes.map((n) => [n.id, new Set()])), indegree = new Map(nodes.map((n) => [n.id, 0]));
  const rank = new Map(nodes.map((n, i) => [n.id, i]));
  for (const r of relations) {
    if (!["precedes", "continues"].includes(r.type)) continue;
    if (!byId.has(r.from) || !byId.has(r.to) || r.from === r.to) throw new Error("Invalid reading-order relationship");
    if (!edges.get(r.from).has(r.to)) { edges.get(r.from).add(r.to); indegree.set(r.to, indegree.get(r.to) + 1); }
  }
  // A rank heap avoids repeatedly sorting the entire ready set on large documents.
  const ready = [], result = [];
  const push = (node) => {
    let i = ready.length; ready.push(node);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (rank.get(ready[parent].id) <= rank.get(node.id)) break;
      ready[i] = ready[parent]; i = parent;
    }
    ready[i] = node;
  };
  const pop = () => {
    const first = ready[0], tail = ready.pop();
    if (ready.length) {
      let i = 0;
      while (i * 2 + 1 < ready.length) {
        let child = i * 2 + 1;
        if (child + 1 < ready.length && rank.get(ready[child + 1].id) < rank.get(ready[child].id)) child++;
        if (rank.get(tail.id) <= rank.get(ready[child].id)) break;
        ready[i] = ready[child]; i = child;
      }
      ready[i] = tail;
    }
    return first;
  };
  for (const node of nodes) if (!indegree.get(node.id)) push(node);
  while (ready.length) {
    const next = pop(); result.push(next);
    for (const id of edges.get(next.id)) { indegree.set(id, indegree.get(id) - 1); if (!indegree.get(id)) push(byId.get(id)); }
  }
  if (result.length !== nodes.length) throw new Error("Conflicting reading-order relationships: cycle requires review");
  return result;
}

export function assignStableLines(units, epsilon) {
  const groups = new Map();
  for (const unit of units) {
    const key = `${unit.pageNumber}:${unit.phase}:${unit.columnIndex ?? 0}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(unit);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.top - b.top || a.left - b.left || a.sortKey.localeCompare(b.sortKey));
    let anchor = -Infinity, line = -1;
    const lines = [];
    for (const unit of group) {
      if (unit.top - anchor >= epsilon) { anchor = unit.top; line++; lines.push([]); }
      unit.lineIndex = line;
      lines[line].push(unit);
    }
    for (const lineUnits of lines) {
      const rtl = lineUnits.every((u) => u.nodes?.every((n) => n.direction === "rtl"));
      for (const unit of lineUnits) unit.lineDirection = rtl ? "rtl" : "ltr";
    }
  }
}
