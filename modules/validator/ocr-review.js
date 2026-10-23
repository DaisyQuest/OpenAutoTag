import { createHash } from "node:crypto";

const hash = value => createHash("sha256").update(value).digest("hex");
const key = (id, index) => JSON.stringify([id, index]);
const compact = text => text.replace(/\s/gu, "");

function recognitionValid(r) {
  if (!r) return true; // Older artifacts have unknown evidence, not acceptance.
  const [start, end] = r.range;
  if (start < 0 || end <= start || end > r.originalText.length) return false;
  if (r.alignment !== "complete") return r.words.every(w => w.start === undefined && w.end === undefined);
  let cursor = 0;
  for (const word of r.words) {
    if (!Number.isInteger(word.start) || !Number.isInteger(word.end) || word.start < cursor || word.end <= word.start ||
        word.end > r.originalText.length || r.originalText.slice(word.start, word.end) !== word.text ||
        compact(r.originalText.slice(cursor, word.start))) return false;
    cursor = word.end;
  }
  return r.words.length > 0 && !compact(r.originalText.slice(cursor));
}

/** Transcription review is deliberately separate from glyph attachment. A
 * score—even 100—cannot close a task. Recorded decisions are supplied evidence,
 * not authenticated human identity or overall accessibility certification. */
export function inspectOcrReview({ tagging, sourceHash, ownershipStatus, add }) {
  const segments = [], byTarget = new Map();
  const stack = [tagging.root];
  while (stack.length) {
    const node = stack.pop();
    for (const [segmentIndex, entry] of (node.ocrSegments || []).entries()) {
      const target = { tagId: node.id, segmentIndex, pageNumber: entry.pageNumber, sourceBlockId: entry.sourceBlockId,
        text: entry.text, status: "review_required", reasons: [],
        ...(entry.confidence !== undefined ? { confidence: entry.confidence } : {}),
        ...(entry.recognition ? { recognition: entry.recognition } : {}) };
      segments.push(target); byTarget.set(key(node.id, segmentIndex), target);
    }
    stack.push(...(node.children || []).toReversed());
  }
  const audit = tagging.ocrReview, decisions = new Map();
  let qualified = Boolean(audit && ownershipStatus === "verified");
  if (audit) {
    const { ocrReview, ...document } = tagging;
    const bound = audit.documentHash === hash(JSON.stringify(document)) && audit.reviewHash === hash(JSON.stringify(audit.review)) &&
      audit.review.sourceHash === sourceHash && Boolean(audit.review.reviewer.trim() && audit.review.evidence.trim());
    add("OCR_REVIEW_HASH_BINDING", "document", true, bound);
    qualified &&= bound;
    for (const decision of audit.review.decisions) {
      const id = key(decision.tagId, decision.segmentIndex), target = byTarget.get(id);
      const matches = Boolean(target && !decisions.has(id) && target.pageNumber === decision.pageNumber &&
        target.sourceBlockId === decision.sourceBlockId && target.text === decision.text &&
        (decision.decision === "confirm") === (decision.expectedText === decision.text) &&
        (!target.recognition || target.recognition.originalText.slice(...target.recognition.range) === decision.expectedText));
      add("OCR_REVIEW_TARGET", id, true, matches);
      qualified &&= matches;
      decisions.set(id, decision);
    }
  }
  for (const segment of segments) {
    const id = key(segment.tagId, segment.segmentIndex), r = segment.recognition;
    const decision = decisions.get(id), valid = recognitionValid(r) && (!r || r.originalText.slice(...r.range) === (decision?.expectedText ?? segment.text));
    add("OCR_RECOGNITION_EVIDENCE", id, true, valid);
    if (!valid) segment.reasons.push("invalid_word_evidence");
    if (!r || r.alignment !== "complete") segment.reasons.push("word_alignment_unavailable");
    const words = r?.words.filter(w => w.start === undefined || w.end > r.range[0] && w.start < r.range[1]) || [];
    if (!words.length || words.some(w => w.confidence === undefined)) segment.reasons.push("word_confidence_unknown");
    if (words.some(w => w.confidence < 85)) segment.reasons.push("word_confidence_below_85");
    if (!words.length || words.some(w => w.geometryStatus !== "mapped" || !w.quad)) segment.reasons.push("word_geometry_unqualified");
    if (segment.confidence === undefined) segment.reasons.push("line_confidence_unknown");
    else if (segment.confidence < 85) segment.reasons.push("line_confidence_below_85");
    if (qualified && valid && decision) segment.status = "recorded";
    else segment.reasons.push("transcription_review_required");
  }
  const pending = segments.filter(s => s.status !== "recorded").length;
  return { status: !segments.length ? "none" : pending ? "review_required" : "recorded", pending, recorded: segments.length - pending, segments };
}
