import { createHash } from "node:crypto";
import { inspectOcrLayer } from "./ocr-layer.js";
import { inspectNativeLinks } from "./native-links.js";

const address = r => `${r.pageNumber}:${r.streamOrigin}:${r.operatorIndex}`;
const glyphKey = (page, index) => `${page}:${index}`;
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const canonicalText = text => String(text || "").normalize("NFKC").replace(/\p{White_Space}/gu, "");

export function inspectSourceOwnership({ inspection, source, ownership, intendedNodes, add }) {
  const result = { sourceVerified: false };
  if (!source || !ownership) return result;
  add("SOURCE_OWNERSHIP_HASH", "document", source.sourceHash, ownership.sourceHash);
  add("SOURCE_TEXT_INSPECTED", "document", true, Array.isArray(source.textRuns));
  add("SAVED_TEXT_INSPECTED", "document", true, Array.isArray(inspection.textRuns));
  const ocr = inspectOcrLayer({inspection,source,intendedNodes,add});
  const sourceRuns = new Map(), sourcePages = new Map(), actualPages = new Map(), sourcePositions = new Map(), actualPositions = new Map();
  const group = (runs, pages) => {
    for (const run of runs || []) {
      const page = pages.get(run.pageNumber) || [];
      add("GLYPH_RUN_CONTIGUOUS", `${pages === sourcePages ? "source" : "candidate"}:${address(run)}`, page.length, run.glyphStart);
      add("GLYPH_RUN_LENGTH", address(run), run.glyphEnd - run.glyphStart, run.glyphs.length);
      for (const g of run.glyphs) page.push([run.fontName, g[0]]); pages.set(run.pageNumber, page);
      const positions = pages === sourcePages ? sourcePositions : actualPositions, points = positions.get(run.pageNumber) || [];
      for (const point of run.positions || []) points.push(point); positions.set(run.pageNumber, points);
    }
  };
  group(source.textRuns, sourcePages); group(ocr.nativeRuns, actualPages);
  for (const run of source.textRuns || []) {
    if (sourceRuns.has(address(run))) add("DUPLICATE_SOURCE_ADDRESS", address(run), false, true);
    sourceRuns.set(address(run), run);
  }
  let sequenceMatches = Boolean(source.textRuns && inspection.textRuns && source.sourceHash === ownership.sourceHash);
  for (const page of new Set([...sourcePages.keys(), ...actualPages.keys()])) {
    const expected = digest(sourcePages.get(page) || []), actual = digest(actualPages.get(page) || []);
    add("SOURCE_GLYPH_SEQUENCE", `page:${page}`, expected, actual); sequenceMatches &&= expected === actual;
    const a = sourcePositions.get(page) || [], b = actualPositions.get(page) || [];
    const positionsMatch = a.length === (sourcePages.get(page) || []).length && a.length === b.length &&
      a.every((point, i) => point.length === 8 && b[i]?.length === 8 && point.every((v, j) => Math.abs(v - b[i][j]) <= 0.001));
    add("SOURCE_GLYPH_POSITIONS", `page:${page}`, true, positionsMatch); sequenceMatches &&= positionsMatch;
  }
  const expectedOwners = new Map(ocr.owners), byTag = new Map(intendedNodes.map(v => [v.n.id, v.id]));
  for (const range of ownership.ranges) {
    const run = sourceRuns.get(address(range)), owner = byTag.get(range.tagNodeId);
    const valid = Boolean(run && owner && range.glyphStart >= 0 && range.glyphEnd > range.glyphStart && range.glyphEnd <= run.glyphs.length);
    add("SOURCE_RANGE_RESOLVES", `${address(range)}:${range.glyphStart}:${range.glyphEnd}`, true, valid);
    if (!valid) { sequenceMatches = false; continue; }
    for (let g = range.glyphStart; g < range.glyphEnd; g++) {
      const key = glyphKey(range.pageNumber, run.glyphStart + g);
      if (expectedOwners.has(key)) { add("DUPLICATE_SOURCE_GLYPH_OWNER", key, false, true); sequenceMatches = false; }
      expectedOwners.set(key, owner);
    }
  }
  const contentOwners = new Map();
  const links = inspectNativeLinks({ source, inspection, ownership, sourceRuns, intendedNodes, add });
  result.redundantActualText = links.redundantActualText;
  result.linkGroups = links.grouped;
  const elements = new Map(inspection.structure.map(n => [n.objectRef, n])), intended = new Set(byTag.values());
  const intendedOwner = node => {
    const seen = new Set();
    while (node && !seen.has(node.objectRef) && seen.size <= 128) {
      if (intended.has(node.identifier)) return node.identifier;
      if (node.role !== "Span" && !(node.role === "Link" && links.transparent.has(node.objectRef))) return null;
      seen.add(node.objectRef); node = elements.get(node.parentRef);
    }
    return null;
  };
  for (const node of inspection.structure) for (const ref of node.contentRefs) {
    const owners = contentOwners.get(ref) || []; owners.push(intendedOwner(node) || node.identifier || node.objectRef); contentOwners.set(ref, owners);
  }
  // Even identical words at different source occurrences retain distinct page
  // glyph ordinals; text similarity cannot conceal an ownership swap.
  let allOwnersMatch = true;
  for (const run of inspection.textRuns || []) {
    if (!run.glyphs.length) continue;
    const actual = run.owners.flatMap(ref => contentOwners.get(ref) || [`unresolved:${ref}`]);
    const expected = new Set();
    for (let g = run.glyphStart; g < run.glyphEnd; g++) expected.add(expectedOwners.get(glyphKey(run.pageNumber, g)) || null);
    const valid = sequenceMatches && (expected.size === 1 && expected.has(null) ? actual.length === 0 : expected.size === 1 && actual.length === 1 && expected.has(actual[0]));
    add("SOURCE_PAINT_OWNER", `${address(run)}:glyphs:${run.glyphStart}-${run.glyphEnd}`, true, valid);
    if (!valid) allOwnersMatch = false;
  }
  result.sourceVerified = sequenceMatches && allOwnersMatch && ocr.valid && links.valid;
  return result;
}

export function savedTextIndex(inspection) {
  const byContent = new Map();
  for (const run of inspection.textRuns || []) for (const ref of run.owners) {
    const runs = byContent.get(ref) || []; runs.push(run); byContent.set(ref, runs);
  }
  const byRef = new Map(inspection.structure.map(n => [n.objectRef, n]));
  const order = new Map((inspection.contentOrder || []).map((ref,i) => [ref,i]));
  function collectRefs(node, seen = new Set()) {
    if (!node || seen.has(node.objectRef)) return [];
    seen.add(node.objectRef);
    return [...node.contentRefs, ...node.children.flatMap(ref => collectRefs(byRef.get(ref), seen))];
  }
  const collect = node => collectRefs(node).sort((a,b) => (order.get(a) ?? Infinity)-(order.get(b) ?? Infinity)).flatMap(ref => byContent.get(ref) || []);
  return { collect, byRef };
}

export function authoredReplacementIndex(source, candidate, verified, add, intendedIds = new Set()) {
  if (!verified) return new Map();
  const sourceScopes = effectiveReplacements(source), candidateScopes = effectiveReplacements(candidate, true);
  const sourceKeys = new Set(sourceScopes.map(s => JSON.stringify([s.pageNumber, s.glyphStart, s.glyphEnd, s.text]))), allowed = new Map();
  for (const scope of candidateScopes) {
    const key = JSON.stringify([scope.pageNumber, scope.glyphStart, scope.glyphEnd, scope.text]);
    const exact = sourceKeys.has(key);
    add("INLINE_REPLACEMENT_AUTHORIZED", `${scope.pageNumber}:${scope.glyphStart}-${scope.glyphEnd}`, true, exact);
    if (exact) allowed.set(glyphKey(scope.pageNumber, scope.glyphStart), scope);
  }
  const index = savedTextIndex(candidate);
  for (const node of candidate.structure) if ((node.actualTextPresent || node.actualText) && !intendedIds.has(node.identifier)) {
    const scope = structureReplacement(node, index);
    const exact = Boolean(scope && sourceKeys.has(JSON.stringify([scope.pageNumber, scope.glyphStart, scope.glyphEnd, scope.text])));
    add("DESCENDANT_REPLACEMENT_AUTHORIZED", node.objectRef, true, exact);
  }
  return allowed;
}

function structureReplacement(node, index) {
  const runs = index.collect(node).filter(r => r.glyphs.length).sort((a,b) => a.pageNumber-b.pageNumber || a.glyphStart-b.glyphStart);
  if (!runs.length || runs.some((r,i) => r.pageNumber !== runs[0].pageNumber || i && r.glyphStart !== runs[i-1].glyphEnd)) return null;
  return { pageNumber: runs[0].pageNumber, glyphStart: runs[0].glyphStart, glyphEnd: runs.at(-1).glyphEnd, text: node.actualText };
}

function effectiveReplacements(inspection, inlineOnly = false) {
  const scopes = (inspection.replacementScopes || []).filter(s => s.outermost && s.glyphEnd > s.glyphStart).map(s => ({ ...s }));
  if (!inlineOnly) {
    const index = savedTextIndex(inspection);
    for (const node of inspection.structure) if (node.actualTextPresent || node.actualText) {
      let ancestor = index.byRef.get(node.parentRef), shadowed = false, depth = 0;
      while (ancestor && depth++ <= 128) { if (ancestor.actualTextPresent || ancestor.actualText) { shadowed = true; break; } ancestor = index.byRef.get(ancestor.parentRef); }
      if (shadowed || depth > 128) continue;
      const scope = structureReplacement(node, index); if (scope) scopes.push(scope);
    }
  }
  // Overlapping, contradictory replacement scopes cannot authorize an exception.
  scopes.sort((a,b) => a.pageNumber-b.pageNumber || a.glyphStart-b.glyphStart || b.glyphEnd-a.glyphEnd);
  const rejected = new Set();
  for (let i=0;i<scopes.length;i++) for (let j=i+1;j<scopes.length && scopes[j].pageNumber===scopes[i].pageNumber && scopes[j].glyphStart<scopes[i].glyphEnd;j++) {
    if (scopes[j].glyphStart!==scopes[i].glyphStart || scopes[j].glyphEnd!==scopes[i].glyphEnd || scopes[j].text!==scopes[i].text) { rejected.add(i); rejected.add(j); }
    if (j-i>128) throw new Error("Replacement overlap limit exceeded");
  }
  return scopes.filter((_,i) => !rejected.has(i));
}

export function textWithAuthoredReplacements(runs, allowed, expected) {
  const raw = runs.flatMap(r => r.glyphs.map(g => g[1])).join("");
  if (!allowed.size || canonicalText(raw) === canonicalText(expected)) return raw;
  // Only unchanged original inline ActualText over an exact, complete glyph
  // range can substitute for source glyphs. Generated replacement text cannot.
  const glyphs = runs.flatMap(r => r.glyphs.map((g, i) => ({ key: glyphKey(r.pageNumber, r.glyphStart + i), page: r.pageNumber, index: r.glyphStart + i, text: g[1] })));
  let text = "";
  for (let i = 0; i < glyphs.length; i++) {
    const g = glyphs[i], scope = allowed.get(glyphKey(g.page, g.index));
    if (scope && scope.glyphEnd - scope.glyphStart <= glyphs.length - i &&
      glyphs.slice(i, i + scope.glyphEnd - scope.glyphStart).every((item, offset) => item.page === scope.pageNumber && item.index === scope.glyphStart + offset)) {
      text += scope.text; i += scope.glyphEnd - scope.glyphStart - 1;
    }
    else text += g.text;
  }
  return text;
}

// Collapsing exact source overprints is allowed only after the caller proves
// every original glyph/code/position and the intended saved ActualText.
export function exactOverprintText(runs) {
  const seen = new Set(); let text = "", removed = 0;
  for (const run of runs) {
    if (run.positions?.length !== run.glyphs.length) return null;
    for (let i=0;i<run.glyphs.length;i++) {
      const glyph = run.glyphs[i], key = JSON.stringify([run.pageNumber, run.fontName, glyph, run.positions[i]]);
      if (seen.has(key)) removed++;
      else { seen.add(key); text += glyph[1]; }
    }
  }
  return removed ? { text, removed } : null;
}
