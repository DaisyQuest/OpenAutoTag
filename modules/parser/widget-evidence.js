// Read decoded text only inside a widget's normal appearance. Never execute actions
// or promote editable values into labels. Unsupported/hidden text fails closed.
export function widgetAppearanceText(operatorList, OPS) {
  const result = new Map();
  let active;
  for (let i = 0; i < operatorList.fnArray.length; i++) {
    const op = operatorList.fnArray[i], args = operatorList.argsArray[i] || [];
    if (op === OPS.beginAnnotation) {
      active = { id: args[0], text: "", mode: 0, stack: [], valid: true };
    } else if (op === OPS.endAnnotation) {
      const text = active?.text.replace(/\s+/g, " ").trim();
      if (active?.valid && text && text.length <= 160 && !/[\u0000-\u001f\ufffd]/u.test(text)) result.set(active.id, text);
      active = undefined;
    } else if (active?.valid) {
      if (op === OPS.save) active.stack.push(active.mode);
      else if (op === OPS.restore) active.mode = active.stack.pop() ?? 0;
      else if (op === OPS.setTextRenderingMode) active.mode = args[0];
      else if (op === OPS.showText || op === OPS.showSpacedText) {
        if (active.mode === 3 || active.mode === 7 || !Array.isArray(args[0])) { active.valid = false; continue; }
        for (const glyph of args[0]) {
          if (typeof glyph === "number") {
            // A large negative TJ adjustment introduces a word gap.
            if (glyph <= -200) active.text += " ";
          } else if (typeof glyph?.unicode === "string" && glyph.unicode) active.text += glyph.unicode;
          else active.valid = false;
          if (active.text.length > 320) { active.valid = false; break; }
        }
      } else if (op === OPS.nextLine || op === OPS.endText) active.text += " ";
      else if (op === OPS.nextLineShowText || op === OPS.nextLineSetSpacingShowText) active.valid = false;
    }
  }
  return result;
}
