import { resolveProfile } from "./profile-registry.js";

/**
 * Create a frozen profile context from a profile ID and optional overrides.
 * The returned object exposes `.get(stageName)` to retrieve per-stage config
 * and `.resolved` to access the full resolved profile.
 */
export async function createProfileContext(profileId = "default", overrides = {}) {
  const resolved = await resolveProfile(profileId, overrides);
  Object.freeze(resolved);

  return Object.freeze({
    profileId: resolved.profileId,
    resolved,
    get(stageName) {
      return resolved[stageName] || {};
    }
  });
}

/**
 * Translate profile fields into the environment variables that downstream
 * modules currently read for backward compatibility.
 *
 * Returns a plain object of { ENV_VAR: string } suitable for merging into
 * a child process env.
 */
export function injectProfileEnv(ctx) {
  const env = {};

  const parser = ctx.get("parser");
  if (parser.ocrMode != null) {
    env.PARSER_OCR_MODE = String(parser.ocrMode);
  }
  if (parser.ocrLanguages != null) {
    env.PARSER_OCR_LANGS = String(parser.ocrLanguages);
  }
  if (parser.ocrMaxAttempts != null) {
    env.PARSER_OCR_MAX_ATTEMPTS = String(parser.ocrMaxAttempts);
  }
  if (parser.sparseTextBlockThreshold != null) {
    env.PARSER_SPARSE_TEXT_BLOCK_THRESHOLD = String(parser.sparseTextBlockThreshold);
  }
  if (parser.sparseCharacterThreshold != null) {
    env.PARSER_SPARSE_CHARACTER_THRESHOLD = String(parser.sparseCharacterThreshold);
  }
  if (parser.sparseCoverageThreshold != null) {
    env.PARSER_SPARSE_COVERAGE_THRESHOLD = String(parser.sparseCoverageThreshold);
  }
  if (parser.minAcceptedOcrScore != null) {
    env.PARSER_MIN_ACCEPTED_OCR_SCORE = String(parser.minAcceptedOcrScore);
  }

  const layout = ctx.get("layoutAnalyzer");
  if (layout.columnGapThresholdPercent != null) {
    env.LAYOUT_COLUMN_GAP_THRESHOLD_PERCENT = String(layout.columnGapThresholdPercent);
  }
  if (layout.headingScoreThreshold != null) {
    env.LAYOUT_HEADING_SCORE_THRESHOLD = String(layout.headingScoreThreshold);
  }

  const semantic = ctx.get("semanticEngine");
  if (semantic.tableContinuationDistanceY != null) {
    env.SEMANTIC_TABLE_CONTINUATION_DISTANCE_Y = String(semantic.tableContinuationDistanceY);
  }

  const validator = ctx.get("validator");
  if (validator.targetStandard != null) {
    env.VALIDATOR_TARGET_STANDARD = String(validator.targetStandard);
  }

  const pdfWriter = ctx.get("pdfWriter");
  if (pdfWriter.forceEmbedFonts != null) {
    env.PDF_WRITER_FORCE_EMBED_FONTS = String(pdfWriter.forceEmbedFonts);
  }

  return env;
}
