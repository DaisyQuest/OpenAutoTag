import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ML_CLASSIFIER_ID,
  DEFAULT_ML_CLASSIFIER_MODE,
  buildMlClassifierOptionsPatch,
  describeMlClassifierState,
  normalizeMlClassifierOptions
} from "../../orchestrator/ml-tuning.js";

test("ML classifier options are deterministic and default off", () => {
  const defaults = normalizeMlClassifierOptions();

  assert.equal(defaults.enabled, false);
  assert.equal(defaults.mode, DEFAULT_ML_CLASSIFIER_MODE);
  assert.equal(defaults.classifierId, DEFAULT_ML_CLASSIFIER_ID);
  assert.equal(defaults.modelPath, null);

  const enabled = normalizeMlClassifierOptions({
    mlClassifier: {
      enabled: "true",
      mode: "assistive",
      classifierId: "candidate-v1",
      modelPath: "models/candidate.json",
      tuningVersion: "0.2.0"
    }
  });
  assert.deepEqual(enabled, {
    enabled: true,
    mode: "assistive",
    classifierId: "candidate-v1",
    modelPath: "models/candidate.json",
    tuningVersion: "0.2.0"
  });

  const invalidMode = normalizeMlClassifierOptions({
    machineLearning: {
      enabled: true,
      mode: "experimental"
    }
  });
  assert.equal(invalidMode.enabled, true);
  assert.equal(invalidMode.mode, DEFAULT_ML_CLASSIFIER_MODE);
});

test("ML classifier option helpers preserve current classifier identity", () => {
  const patch = buildMlClassifierOptionsPatch(true, {
    mlClassifier: {
      mode: "assistive",
      classifierId: "candidate-v2",
      modelPath: "models/candidate-v2.json"
    }
  });

  assert.deepEqual(patch, {
    enabled: true,
    mode: "assistive",
    classifierId: "candidate-v2",
    modelPath: "models/candidate-v2.json",
    tuningVersion: "0.1.0"
  });

  const state = describeMlClassifierState({ mlClassifier: patch });
  assert.equal(state.enabled, true);
  assert.match(state.label, /enabled/i);
  assert.match(state.summary, /prediction evidence/i);
});
