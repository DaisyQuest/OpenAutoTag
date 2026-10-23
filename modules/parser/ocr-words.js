import { mapRecognitionBox } from "./ocr-geometry.js";

const normalized = value => String(value || "").replace(/\s+/gu, " ").trim();
const score = value => Number.isFinite(value) && value >= 0 && value <= 100;

/** Word offsets are UTF-16 offsets in the normalized original line, not glyph
 * indexes. Never search ahead past unexplained text or guess a word location. */
export function recognizeWords(line, variant, transform) {
  if (line.text.length > 32768 || (line.words?.length || 0) > 4096)
    throw new Error("OCR word evidence exceeds its bounded contract");
  const words = [];
  let cursor = 0, aligned = true;
  for (const input of line.words || []) {
    const text = normalized(input?.text);
    if (!text || text.length > 4096) { aligned = false; continue; }
    const word = { text };
    if (score(input.confidence)) word.confidence = Math.round(input.confidence * 1000) / 1000;
    while (/\s/u.test(line.text[cursor] || "") && cursor < line.text.length) cursor++;
    if (aligned && line.text.startsWith(text, cursor)) {
      word.start = cursor; word.end = cursor + text.length; cursor = word.end;
    } else aligned = false;
    try {
      const { evidence } = mapRecognitionBox(input.bbox, variant, transform);
      word.quad = evidence.quad;
      word.geometryStatus = evidence.clipped ? "clipped" : "mapped";
    } catch { word.geometryStatus = "unavailable"; }
    words.push(word);
  }
  const complete = words.length > 0 && aligned && !line.text.slice(cursor).trim();
  if (!complete) for (const word of words) { delete word.start; delete word.end; }
  return { originalText: line.text, range: [0, line.text.length],
    alignment: !words.length ? "unavailable" : complete ? "complete" : "unresolved", words };
}
