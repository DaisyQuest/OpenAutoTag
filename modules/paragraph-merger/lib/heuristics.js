export function isArtifactNode(node) {
  return node.role === "Artifact" || node.artifactType != null;
}

export function isHeaderFooterOverlap(node, pageNodes) {
  if (!node.bbox) return false;
  const top = node.bbox[1];
  const bottom = top + (node.bbox[3] || 0);
  for (const other of pageNodes) {
    if (other === node || other.role === "P") continue;
    if (!isArtifactNode(other)) continue;
    const oTop = other.bbox?.[1] ?? 0;
    const oBottom = oTop + (other.bbox?.[3] ?? 0);
    if (top < oBottom && bottom > oTop) return true;
  }
  return false;
}

export function detectHangingIndent(prev, curr, allParagraphs) {
  if (!prev.bbox || !curr.bbox) return false;
  const prevLeft = prev.bbox[0];
  const currLeft = curr.bbox[0];
  const indent = prevLeft - currLeft;
  if (indent > 8 && indent < 60) return true;
  if (currLeft - prevLeft > 8 && currLeft - prevLeft < 60) return true;
  return false;
}

export function isContinuationLine(prev, curr) {
  const prevText = (prev.text || "").trimEnd();
  if (prevText.length === 0) return false;
  const lastChar = prevText[prevText.length - 1];
  if (/[,;\-\u2014\u2013]/.test(lastChar)) return true;
  if (/[a-z]$/.test(prevText)) return true;
  const words = prevText.split(/\s+/);
  const lastWord = words[words.length - 1]?.toLowerCase() || "";
  if (["the", "a", "an", "of", "in", "to", "for", "and", "or", "but", "that", "which", "who", "with", "by", "from", "as", "at", "on", "is", "was", "be", "are", "were", "not"].includes(lastWord)) {
    return true;
  }
  return false;
}

export function isLegalCitation(text) {
  if (!text) return false;
  return /\b\d+\s+(N\.?Y\.?\s*\d|A\.?D\.?\d|Misc\.?\s*\d|S\.?\s*Ct\.?|U\.?S\.?\s*\d|F\.?\s*\d|L\.?\s*Ed\.?|NYLJ|Slip\s+Op)/i.test(text);
}

export function preFilterArtifacts(pageNodes) {
  return pageNodes.filter((node) => !isArtifactNode(node));
}
