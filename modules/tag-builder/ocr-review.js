import { readFile, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import taggingSchema from "../../contracts/tagging.schema.json" with { type: "json" };
import reviewSchema from "../../contracts/ocr-review.schema.json" with { type: "json" };

const ajv = new Ajv2020({ allErrors: true });
const validTags = ajv.compile(taggingSchema), validReview = ajv.compile(reviewSchema);
const hash = value => createHash("sha256").update(value).digest("hex");
const compact = value => value.replace(/\s/gu, "");

function indexTags(root) {
  const nodes = new Map(), stack = [[root, 0]];
  while (stack.length) {
    const [node, depth] = stack.pop();
    if (!node || depth > 128 || nodes.size >= 100000 || nodes.has(node.id))
      throw new Error("Invalid or excessive OCR review tree");
    nodes.set(node.id, node);
    for (const child of node.children || []) stack.push([child, depth + 1]);
  }
  return nodes;
}

/** Map only an entire, exactly corresponding text sequence. Character offsets
 * resolve repeated words without global replacement; whitespace is retained
 * outside each corrected line. Ambiguous replacement metadata is rejected. */
function rewriteMetadata(value, entries) {
  const before = entries.map(e => e.before).join("");
  if (compact(value) !== compact(before)) return null;
  const positions = [];
  for (let i = 0; i < value.length; i++) if (!/\s/u.test(value[i])) positions.push(i);
  let cursor = 0;
  const edits = [];
  for (const entry of entries) {
    const length = compact(entry.before).length;
    if (entry.before !== entry.after) {
      if (!length || !entry.after.trim()) throw new Error("OCR corrections must retain nonempty line content");
      edits.push({ start: positions[cursor], end: positions[cursor + length - 1] + 1, text: entry.after.trim() });
    }
    cursor += length;
  }
  for (const edit of edits.reverse()) value = value.slice(0, edit.start) + edit.text + value.slice(edit.end);
  return value;
}

export function applyOcrReview({ tagsBytes, reviewBytes, sourceHash }) {
  const tagging = JSON.parse(tagsBytes), review = JSON.parse(reviewBytes);
  indexTags(tagging.root);
  if (!validTags(tagging) || !validReview(review)) throw new Error("Invalid OCR review input contract");
  if (tagging.ocrReview) throw new Error("Apply the complete review to the original tagging intent; a review is already attached");
  if (review.sourceHash !== sourceHash || review.intentHash !== hash(tagsBytes))
    throw new Error("OCR review does not match the exact source PDF and original tagging hashes");
  if (!review.reviewer.trim() || !review.evidence.trim()) throw new Error("OCR review requires reviewer and evidence");
  const nodes = indexTags(tagging.root), changes = new Map();
  for (const decision of review.decisions) {
    const entry = nodes.get(decision.tagId)?.ocrSegments?.[decision.segmentIndex];
    if (!entry || entry.sourceBlockId !== decision.sourceBlockId || entry.pageNumber !== decision.pageNumber || entry.text !== decision.expectedText)
      throw new Error("OCR review target or expected text is stale");
    if (changes.has(entry)) throw new Error("Duplicate OCR review decision");
    if ((decision.decision === "confirm") !== (decision.text === decision.expectedText))
      throw new Error("OCR review decision disagrees with its replacement text");
    if (!decision.text.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(decision.text))
      throw new Error("Invalid OCR correction text");
    changes.set(entry, decision.text);
  }
  function update(node) {
    const direct = (node.ocrSegments || []).map(entry => ({ before: entry.text, after: changes.get(entry) ?? entry.text }));
    const entries = [...direct];
    for (const child of node.children || []) for (const entry of update(child)) entries.push(entry);
    if (entries.some(e => e.before !== e.after)) {
      for (const key of ["actualText", "label", "alt"]) if (typeof node[key] === "string" && node[key]) {
        const replacement = rewriteMetadata(node[key], entries);
        // Labels on larger sections may describe only their title. They are
        // informational intent metadata; ActualText/Alt replace saved content.
        if (replacement === null && (key !== "label" || direct.length))
          throw new Error(`OCR correction cannot safely map ${key} at ${node.id}`);
        if (replacement !== null) node[key] = replacement;
      }
    }
    for (const entry of node.ocrSegments || []) if (changes.has(entry)) entry.text = changes.get(entry);
    return entries;
  }
  update(tagging.root);
  tagging.ocrReview = { review, reviewHash: hash(JSON.stringify(review)), documentHash: hash(JSON.stringify(tagging)) };
  if (!validTags(tagging)) throw new Error("Reviewed OCR tagging violates its contract");
  return tagging;
}

async function main() {
  const args = new Map();
  for (let i = 2; i < process.argv.length; i += 2) {
    if (!["--pdf", "--tags", "--review", "--output"].includes(process.argv[i]) || !process.argv[i + 1] || args.has(process.argv[i]))
      throw new Error("Usage: ocr-review.js --pdf source.pdf --tags original.json --review decisions.json --output reviewed.json");
    args.set(process.argv[i], process.argv[i + 1]);
  }
  if (args.size !== 4) throw new Error("OCR review requires --pdf, --tags, --review and --output");
  for (const key of ["--tags", "--review"]) if ((await stat(args.get(key))).size > 64 * 1024 * 1024) throw new Error("OCR review input exceeds size limit");
  const sourceBytes = await readFile(args.get("--pdf")), tagsBytes = await readFile(args.get("--tags")), reviewBytes = await readFile(args.get("--review"));
  const tagging = applyOcrReview({ tagsBytes, reviewBytes, sourceHash: hash(sourceBytes) });
  const bytes = JSON.stringify(tagging, null, 2) + "\n";
  await writeFile(args.get("--output"), bytes, { flag: "wx" });
  process.stdout.write(JSON.stringify({ outputPath: args.get("--output"), intentHash: hash(bytes), sourceHash: hash(sourceBytes), decisions: tagging.ocrReview.review.decisions.length }) + "\n");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  process.stderr.write(error.message + "\n"); process.exitCode = 1;
});
