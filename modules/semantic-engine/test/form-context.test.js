import test from "node:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import schema from "../../../contracts/semantic.schema.json" with { type: "json" };
import { enrichDocumentRelations } from "../document-relations.js";
import { refineHeadingMembership } from "../semantic-quality.js";
const node = (id, text, bbox, extra = {}) => ({ id, text, bbox, pageNumber: 1, role: "P", fontSize: 12, ...extra });
const run = (nodes, formFields) => enrichDocumentRelations(nodes, [{ pageNumber: 1, height: 800, formFields }]);
const widgets = result => result.formRelationships.flatMap(f => f.widgets);

test("button captions belong to appearances, without invented page text or tooltip changes", () => {
  const source = { id: "button", bbox: [450, 10, 80, 20], fieldType: "Btn", pushButton: true,
    tooltip: "Clear the entered answers.", appearanceText: "Reset form", appearanceTextSource: "normal-widget-appearance" };
  const r = run([], [source]), w = widgets(r)[0];
  assert.equal(w.labelStatus, "associated-appearance"); assert.equal(w.tooltip, source.tooltip);
  assert.equal(w.accessibleNameSource, "authored-tooltip"); assert.equal(w.labelNodeIds, undefined);
  assert.deepEqual(r.formNavigation.unresolvedWidgetIds, []); assert.equal(source.labelStatus, undefined);
  const nearby = run([node("other", source.tooltip, [400, 12, 40, 12])], [source]);
  assert.equal(widgets(nearby)[0].labelNodeIds, undefined);
  const unnamed = run([], [{ ...source, tooltip: "" }]);
  assert.equal(widgets(unnamed)[0].accessibleNameSource, "widget-appearance-proposal");
  assert.equal(unnamed.semanticReviewTasks[0].code, "FORM_ACCESSIBLE_NAME_REVIEW");
  for (const patch of [{ pushButton: false }, { appearanceText: "" }, { appearanceTextSource: undefined }]) {
    assert.deepEqual(run([], [{ ...source, ...patch }]).formNavigation.unresolvedWidgetIds, ["button"]);
  }
});

test("a unique short inline prompt may be expanded by its authored tooltip", () => {
  const n = node("prompt", "County of", [35, 100, 55, 12]);
  const w = { id: "county", bbox: [94, 99, 100, 14], fieldType: "Ch", tooltip: "Select the county the court is located in." };
  const r = run([n], [w]);
  assert.deepEqual(widgets(r)[0].labelNodeIds, ["prompt"]);
  assert.equal(widgets(r)[0].labelAssociation.kind, "expanded-tooltip");
  assert.equal(widgets(r)[0].accessibleNameSource, "authored-tooltip");
});

test("authored push-button captions supply names while tooltip precedence and mismatches remain explicit", () => {
  const source = { id: "button", bbox: [450, 10, 80, 20], fieldType: "Btn", pushButton: true,
    appearanceText: "Reset form", appearanceTextSource: "normal-widget-appearance",
    authoredCaption: "  Reset form ", authoredCaptionSource: "widget-MK-CA" };
  const named = run([], [source]);
  assert.equal(widgets(named)[0].accessibleNameSource, "authored-button-caption");
  assert.deepEqual(named.semanticReviewTasks, []);
  assert.equal(source.labelStatus, undefined); assert.equal(source.tooltip, undefined);
  const tooltip = run([], [{ ...source, tooltip: "Clear the entered answers." }]);
  assert.equal(widgets(tooltip)[0].accessibleNameSource, "authored-tooltip");
  assert.deepEqual(tooltip.semanticReviewTasks, []);
  const mismatch = run([], [{ ...source, authoredCaption: "Print form" }]);
  assert.deepEqual(mismatch.semanticReviewTasks.map(r => r.code), ["FORM_BUTTON_CAPTION_MISMATCH"]);
  assert.equal(widgets(mismatch)[0].authoredCaption, "Print form");
  assert.equal(widgets(mismatch)[0].appearanceText, "Reset form");
  for (const patch of [{ authoredCaption: "" }, { authoredCaptionSource: undefined }]) {
    const r = run([], [{ ...source, ...patch }]);
    assert.equal(widgets(r)[0].accessibleNameSource, "widget-appearance-proposal");
    assert.equal(r.semanticReviewTasks[0].code, "FORM_ACCESSIBLE_NAME_REVIEW");
  }
  assert.equal(widgets(run([], [{ ...source, pushButton: false }]))[0].accessibleNameSource, "unresolved");
});

test("a caption without appearance evidence supplies a name but cannot certify an unrelated visual label", () => {
  const source = { id: "button", bbox: [100, 10, 80, 20], fieldType: "Btn", pushButton: true,
    authoredCaption: "Print form", authoredCaptionSource: "widget-MK-CA" };
  const unrelated = node("other", "Account", [20, 10, 60, 12], { formFieldIds: ["button"] });
  const r = run([unrelated], [source]), w = widgets(r)[0];
  assert.equal(w.accessibleNameSource, "authored-button-caption");
  assert.equal(w.labelStatus, "authored-name-visual-association-unresolved");
  assert.equal(w.labelNodeIds, undefined); assert.deepEqual(r.formNavigation.unresolvedWidgetIds, ["button"]);
  const exact = run([node("label", "Print form", [20, 10, 60, 12])], [source]);
  assert.deepEqual(widgets(exact)[0].labelNodeIds, ["label"]);
  assert.equal(exact.relations[0].evidence, "authored-button-caption-and-proximity");
  const wrapped = run([node("first", "Print", [20, 10, 60, 12]), node("second", "form", [20, 24, 60, 12])], [source]);
  assert.deepEqual(widgets(wrapped)[0].labelNodeIds, ["first", "second"]);
  assert.equal(wrapped.relations[0].evidence, "authored-button-caption-and-adjacent-label-fragments");
});

test("expanded prompts reject mismatches, duplicate labels, shared targets and distant rows", () => {
  const n = () => node("prompt", "County of", [35, 100, 55, 12]);
  const w = { id: "county", bbox: [94, 99, 100, 14], fieldType: "Ch", tooltip: "Select the county the court is located in." };
  for (const [ns, ws] of [
    [[n()], [{ ...w, tooltip: "Select the court's name." }]],
    [[{ ...n(), text: "District 2" }], [{ ...w, tooltip: "Select District 3." }]],
    [[n(), { ...n(), id: "duplicate" }], [w]],
    [[n()], [w, { ...w, id: "other" }]],
    [[n()], [{ ...w, bbox: [94, 115, 100, 14] }]],
    [[{ ...n(), textRotation: 90 }], [w]]
  ]) assert.ok(run(ns, ws).formNavigation.unresolvedWidgetIds.includes("county"));
});

const section = () => ({
  nodes: [node("heading", "EXPLANATION:", [36, 300, 100, 12], { role: "H2" }),
    node("instructions", "Explain your answers below. Attach additional pages if necessary.", [36, 317, 480, 12]),
    node("proof", "You may attach other written proof supporting your answers.", [36, 331, 460, 12])],
  field: { id: "notes", fieldType: "Tx", multiLine: true, bbox: [36, 350, 540, 200],
    tooltip: "Explain your answers and attach additional pages or other written proof if necessary." }
});
test("a single multiline field keeps section heading and instructions as separate associations", () => {
  const { nodes, field } = section(), r = run(nodes, [field]), w = widgets(r)[0];
  assert.deepEqual(w.labelNodeIds, ["heading"]); assert.deepEqual(w.instructionNodeIds, ["instructions", "proof"]);
  assert.equal(w.labelAssociation.kind, "section-prompt");
  refineHeadingMembership(nodes, []); assert.equal(nodes[0].role, "H2");
  assert.equal(r.relations.filter(r => r.type === "describes").length, 2);
});

test("section prompts abstain on competing fields, unrelated tooltips, long gaps and intervening headings", () => {
  for (const mutation of [
    s => { s.field.multiLine = false; },
    s => { s.field.tooltip = "Enter the delivery address for this shipment."; },
    s => { s.nodes[1].role = "H3"; },
    s => { s.nodes[1].bbox[0] += 15; },
    s => { s.field.bbox[1] += 50; },
    s => { s.other = { ...s.field, id: "other", bbox: [300, 348, 100, 50] }; }
  ]) {
    const s = section(); mutation(s);
    assert.ok(run(s.nodes, [s.field, ...(s.other ? [s.other] : [])]).formNavigation.unresolvedWidgetIds.includes("notes"));
  }
});

const date = () => ({
  nodes: [node("lead", "I affirm this", [36, 628, 58, 12]), node("separator", "day of", [145, 628, 32, 12]), node("comma", ",", [260.8, 628, 3.3, 12])],
  fields: [
    { id: "d", fieldType: "Ch", bbox: [98, 627, 43.5, 14], tooltip: "Select the day of the month you are signing the affirmation." },
    { id: "m", fieldType: "Ch", bbox: [181, 627, 80, 14], tooltip: "Select the month you are signing the affirmation." },
    { id: "y", fieldType: "Tx", bbox: [267, 627, 37, 14], tooltip: "Type the year you are signing the affirmation in YYYY format." }
  ]
});
test("compound dates preserve component names and share context without false label edges", () => {
  const s = date(), r = run(s.nodes, s.fields), ws = widgets(r);
  assert.deepEqual(r.formNavigation.unresolvedWidgetIds, []);
  assert.equal(r.relations.filter(r => r.type === "labels").length, 0);
  assert.deepEqual(ws.map(w => w.labelAssociation.component), ["day", "month", "year"]);
  assert.ok(ws.every(w => w.labelStatus === "associated-context" && w.accessibleNameSource === "authored-tooltip"));
  assert.ok(ws.every(w => w.contextNodeIds.join() === "lead,separator,comma"));
  assert.ok(ws.every(w => w.labelAssociation.groupWidgetIds.join() === "d,m,y"));
  assert.deepEqual(ws.map(w => w.tooltip), s.fields.map(w => w.tooltip));
  const validate = new Ajv2020({ strict: false }).compile(schema.properties.formRelationships.items.properties.widgets.items.properties.labelAssociation);
  assert.ok(ws.every(w => validate(w.labelAssociation)));
  assert.equal(validate({ ...ws[0].labelAssociation, component: "hour" }), false);
  assert.equal(validate({ kind: "compound-date", evidence: "incomplete" }), false);
});

test("date groups abstain without all components, common authored context, prompt or separators", () => {
  for (const mutation of [
    s => s.fields.pop(), s => { s.fields[2].tooltip = "Type the year of birth."; },
    s => { s.fields[2].bbox[1] += 20; }, s => { s.fields[1].bbox[0] += 100; },
    s => s.fields.push({ ...s.fields[2], id: "duplicate" }),
    s => s.fields.push({ id: "intervening", fieldType: "Tx", bbox: [150, 627, 10, 14] }),
    s => s.nodes.shift(), s => s.nodes.pop(),
    s => s.nodes.push({ ...s.nodes[0], id: "other-prompt" })
  ]) {
    const s = date(); mutation(s);
    assert.equal(widgets(run(s.nodes, s.fields)).some(w => w.labelAssociation?.kind === "compound-date"), false);
  }
});

test("a named choice without printed label remains unresolved instead of borrowing another field's label", () => {
  const r = run([node("county", "County of", [35, 134, 55, 12])], [
    { id: "court", fieldType: "Ch", bbox: [35, 116, 200, 14], tooltip: "Select the court's name." }
  ]);
  assert.deepEqual(r.formNavigation.unresolvedWidgetIds, ["court"]);
  assert.equal(widgets(r)[0].accessibleNameSource, "authored-tooltip");
  assert.equal(r.semanticReviewTasks[0].code, "FORM_LABEL_AMBIGUOUS");
});
