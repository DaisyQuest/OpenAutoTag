export const DEFAULT_ML_CLASSIFIER_ID = "openautotag-ml-classifier";
export const DEFAULT_ML_CLASSIFIER_MODE = "shadow";

export function normalizeMlClassifierOptions(options = {}) {
  const raw = options?.mlClassifier || options?.machineLearning || {};
  const enabled = raw.enabled === true || raw.enabled === "true";
  const mode = String(raw.mode || DEFAULT_ML_CLASSIFIER_MODE).trim().toLowerCase();
  const classifierId = String(raw.classifierId || raw.modelId || DEFAULT_ML_CLASSIFIER_ID).trim() || DEFAULT_ML_CLASSIFIER_ID;
  const modelPath = raw.modelPath == null ? null : String(raw.modelPath).trim() || null;

  return {
    enabled,
    mode: ["shadow", "assistive", "disabled"].includes(mode) ? mode : DEFAULT_ML_CLASSIFIER_MODE,
    classifierId,
    modelPath,
    tuningVersion: String(raw.tuningVersion || "0.1.0").trim() || "0.1.0"
  };
}

export function buildMlClassifierOptionsPatch(enabled, current = {}) {
  const normalized = normalizeMlClassifierOptions(current);
  return {
    enabled: Boolean(enabled),
    mode: normalized.mode,
    classifierId: normalized.classifierId,
    ...(normalized.modelPath ? { modelPath: normalized.modelPath } : {}),
    tuningVersion: normalized.tuningVersion
  };
}

export function describeMlClassifierState(options = {}) {
  const config = normalizeMlClassifierOptions(options);
  return {
    ...config,
    label: config.enabled ? "ML classifier enabled" : "ML classifier off",
    summary: config.enabled
      ? "The pipeline will emit ML prediction evidence and use the ML-tuned semantic artifact for downstream tagging."
      : "The deterministic pipeline will run without ML prediction evidence."
  };
}
