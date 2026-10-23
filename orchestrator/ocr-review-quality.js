import { createHash } from "node:crypto";

/** The complete word evidence stays in the saved-semantics artifact. Keep an
 * explicit open task in the production quality report so structural success
 * cannot silently hide pending transcription work. */
export function appendOcrReviewTask(report, saved, savedPath) {
  if (saved.candidateHash !== report.candidateHash) throw new Error("OCR review candidate hash mismatch");
  if (!saved.ocrReview?.pending) return;
  const code = "OCR_TRANSCRIPTION_REVIEW_REQUIRED", target = "document:ocr";
  const evidence = `${saved.ocrReview.pending} OCR segments require transcription review; word evidence and exact targets: ${savedPath}`;
  report.findings.push({ code, description: evidence });
  report.reviewTasks ||= [];
  report.reviewTasks.push({ id: createHash("sha256").update(`${report.candidateHash}:${code}:${target}`).digest("hex").slice(0, 24),
    candidateHash: report.candidateHash, status: "open", code, target, evidence,
    action: "Compare every pending segment with the source page. Supply explicit hash-bound confirmations or corrections, regenerate the candidate, and repeat saved-output and reader checks." });
}
