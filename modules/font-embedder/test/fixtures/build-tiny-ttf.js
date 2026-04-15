// Builds an absolutely minimal (and intentionally non-renderable) TrueType
// font file whose only purpose is to exercise the embedder's TTF cmap
// reader and OS/2 fsType reader. The byte layout follows the OpenType spec
// closely enough to satisfy the embedder's parser; it is not a usable font
// outside this test harness.
//
// Tables included:
//   - cmap (format 4, mapping 'A'..'D' to glyph ids 1..4)
//   - OS/2 (with a configurable fsType value)
//
// All other tables required by a real font (head, hhea, glyf, ...) are
// omitted because the embedder never reads them. The table directory only
// advertises cmap + OS/2.

function pad4(buffer) {
  const padding = (4 - (buffer.length % 4)) % 4;
  if (padding === 0) return buffer;
  return Buffer.concat([buffer, Buffer.alloc(padding)]);
}

function checksum(buffer) {
  // OpenType checksum: sum 32-bit big-endian words modulo 2^32.
  let total = 0;
  const padded = pad4(buffer);
  for (let offset = 0; offset < padded.length; offset += 4) {
    total = (total + padded.readUInt32BE(offset)) >>> 0;
  }
  return total;
}

function buildCmapTable(codeToGlyph) {
  // Build a single format-4 subtable with one segment per contiguous run.
  const codes = [...codeToGlyph.keys()].sort((left, right) => left - right);
  const segments = [];
  let runStart = codes[0];
  let runEnd = codes[0];
  let runDelta = codeToGlyph.get(codes[0]) - codes[0];

  for (let index = 1; index < codes.length; index += 1) {
    const code = codes[index];
    const delta = codeToGlyph.get(code) - code;
    if (code === runEnd + 1 && delta === runDelta) {
      runEnd = code;
    } else {
      segments.push({ startCode: runStart, endCode: runEnd, idDelta: runDelta });
      runStart = code;
      runEnd = code;
      runDelta = delta;
    }
  }
  segments.push({ startCode: runStart, endCode: runEnd, idDelta: runDelta });
  // Mandatory final segment for 0xFFFF.
  segments.push({ startCode: 0xffff, endCode: 0xffff, idDelta: 1 });

  const segCount = segments.length;
  const segCountX2 = segCount * 2;
  let searchRange = 2;
  let entrySelector = 0;
  while (searchRange * 2 <= segCount) {
    searchRange *= 2;
    entrySelector += 1;
  }
  searchRange *= 2;
  const rangeShift = segCountX2 - searchRange;

  const subtableLength = 16 + segCountX2 * 4 + 2; // header + 4 arrays + reservedPad
  const subtable = Buffer.alloc(subtableLength);
  let offset = 0;
  subtable.writeUInt16BE(4, offset); offset += 2; // format
  subtable.writeUInt16BE(subtableLength, offset); offset += 2; // length
  subtable.writeUInt16BE(0, offset); offset += 2; // language
  subtable.writeUInt16BE(segCountX2, offset); offset += 2;
  subtable.writeUInt16BE(searchRange, offset); offset += 2;
  subtable.writeUInt16BE(entrySelector, offset); offset += 2;
  subtable.writeUInt16BE(rangeShift, offset); offset += 2;
  for (const segment of segments) {
    subtable.writeUInt16BE(segment.endCode, offset); offset += 2;
  }
  subtable.writeUInt16BE(0, offset); offset += 2; // reservedPad
  for (const segment of segments) {
    subtable.writeUInt16BE(segment.startCode, offset); offset += 2;
  }
  for (const segment of segments) {
    subtable.writeInt16BE(((segment.idDelta % 0x10000) + 0x10000) % 0x10000 - (segment.idDelta < 0 ? 0x10000 : 0), offset);
    offset += 2;
  }
  for (let index = 0; index < segCount; index += 1) {
    subtable.writeUInt16BE(0, offset); offset += 2; // idRangeOffset
  }

  const headerLength = 4 + 8; // version+numTables + 1 record
  const header = Buffer.alloc(headerLength);
  header.writeUInt16BE(0, 0); // version
  header.writeUInt16BE(1, 2); // numTables
  header.writeUInt16BE(3, 4); // platformId Microsoft
  header.writeUInt16BE(1, 6); // encodingId Unicode BMP
  header.writeUInt32BE(headerLength, 8); // offset to subtable

  return Buffer.concat([header, subtable]);
}

function buildOs2Table(fsType) {
  const length = 96; // OS/2 v4 short layout, far more than we need
  const buffer = Buffer.alloc(length);
  buffer.writeUInt16BE(4, 0); // version
  buffer.writeInt16BE(500, 2); // xAvgCharWidth
  buffer.writeUInt16BE(400, 4); // usWeightClass
  buffer.writeUInt16BE(5, 6); // usWidthClass
  buffer.writeUInt16BE(fsType & 0xffff, 8); // fsType
  return buffer;
}

export function buildTinyTtf({ codeToGlyph, fsType = 0 } = {}) {
  const cmap = pad4(buildCmapTable(codeToGlyph));
  const os2 = pad4(buildOs2Table(fsType));

  const tables = [
    { tag: "OS/2", data: os2 },
    { tag: "cmap", data: cmap }
  ];
  // Tables must be listed in alphabetical order by tag.
  tables.sort((left, right) => (left.tag < right.tag ? -1 : 1));

  const numTables = tables.length;
  const headerLength = 12 + numTables * 16;

  let runningOffset = headerLength;
  const records = tables.map((table) => {
    const record = {
      tag: table.tag,
      data: table.data,
      offset: runningOffset,
      length: table.data.length,
      checksum: checksum(table.data)
    };
    runningOffset += table.data.length;
    return record;
  });

  let searchRange = 16;
  let entrySelector = 0;
  while (searchRange * 2 <= numTables * 16) {
    searchRange *= 2;
    entrySelector += 1;
  }
  const rangeShift = numTables * 16 - searchRange;

  const header = Buffer.alloc(headerLength);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(numTables, 4);
  header.writeUInt16BE(searchRange, 6);
  header.writeUInt16BE(entrySelector, 8);
  header.writeUInt16BE(rangeShift, 10);
  let offset = 12;
  for (const record of records) {
    header.write(record.tag, offset, 4, "ascii");
    header.writeUInt32BE(record.checksum, offset + 4);
    header.writeUInt32BE(record.offset, offset + 8);
    header.writeUInt32BE(record.length, offset + 12);
    offset += 16;
  }

  return Buffer.concat([header, ...records.map((record) => record.data)]);
}
