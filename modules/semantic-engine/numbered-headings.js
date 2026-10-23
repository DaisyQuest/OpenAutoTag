// Numeric prefixes do not by themselves establish a section hierarchy.
const datePrefix=/^(?:\d{4}[./-]\d{1,2}[./-]\d{1,2}|\d{1,2}[./-]\d{1,2}[./-](?:\d{4}|\d{2}))(?=\s|$)/;
const measurementPrefix=/^[+-]?\d+(?:[.,]\d+)?\s*(?:%|°[CF]|(?:mm|cm|km|m|mg|kg|g|ms|s|Hz|kHz|MHz|GHz|W|kW|MW|V|kV|Pa|kPa|MPa|miles?|met(?:er|re)s?|lit(?:er|re)s?|seconds?|hours?)(?:[²³]|\^[23])?)(?=\s|$|[.,;:])/;
export function numericContentKind(text) {
 const value=String(text||"").trim();
 if(datePrefix.test(value)&&!value.replace(datePrefix,"").trim())return "date";
 return measurementPrefix.test(value)?"measurement":null;
}
export function numberedSectionLevel(text) {
 const value=String(text||"").trim();
 if(datePrefix.test(value)||measurementPrefix.test(value))return null;
 const match=/^(\d{1,3}(?:\.\d{1,3}){1,5})[.)]?\s+(\S.*)$/.exec(value);
 if(!match||/^(?:version|release|build)\b/i.test(match[2]))return null;
 const parts=match[1].split(".");
 if(parts.some(p=>p.length>1&&p[0]==="0"))return null;
 return parts.length;
}
