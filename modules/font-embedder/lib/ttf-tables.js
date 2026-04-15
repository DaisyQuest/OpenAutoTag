// Tiny TrueType / OpenType table reader. We only implement the bits needed by
// the embedder: the table directory, the cmap (subtables 4 and 12) for glyph
// id -> unicode mapping, and the OS/2 fsType field for license hints.
//
// Inputs are Uint8Array / Buffer. Returns null when the buffer cannot be
// parsed — callers are expected to fall back to other strategies.

function readUInt16(view, offset) {
  return (view[offset] << 8) | view[offset + 1];
}

function readInt16(view, offset) {
  const value = readUInt16(view, offset);
  return value & 0x8000 ? value - 0x10000 : value;
}

function readUInt32(view, offset) {
  return (
    (view[offset] * 0x1000000) +
    ((view[offset + 1] << 16) | (view[offset + 2] << 8) | view[offset + 3])
  );
}

function readTag(view, offset) {
  return String.fromCharCode(view[offset], view[offset + 1], view[offset + 2], view[offset + 3]);
}

export function readTableDirectory(buffer) {
  if (!buffer || buffer.length < 12) {
    return null;
  }

  const view = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const scaler = readUInt32(view, 0);
  // Accept TrueType (0x00010000), OpenType-CFF ("OTTO"), and TrueType collections.
  const isTrueType = scaler === 0x00010000;
  const isOpenType = scaler === 0x4f54544f; // "OTTO"
  const isCollection = scaler === 0x74746366; // "ttcf" — not handled
  if (isCollection || (!isTrueType && !isOpenType)) {
    return null;
  }

  const numTables = readUInt16(view, 4);
  const tables = new Map();
  let offset = 12;
  for (let index = 0; index < numTables; index += 1) {
    if (offset + 16 > view.length) {
      return null;
    }

    const tag = readTag(view, offset);
    const tableOffset = readUInt32(view, offset + 8);
    const length = readUInt32(view, offset + 12);
    if (tableOffset + length > view.length) {
      // Skip clearly truncated tables rather than fail outright.
      offset += 16;
      continue;
    }
    tables.set(tag, { offset: tableOffset, length });
    offset += 16;
  }

  return { view, tables, scaler };
}

function parseCmapFormat4(view, offset) {
  const segCountX2 = readUInt16(view, offset + 6);
  const segCount = segCountX2 / 2;
  const endCodesOffset = offset + 14;
  const startCodesOffset = endCodesOffset + segCountX2 + 2;
  const idDeltaOffset = startCodesOffset + segCountX2;
  const idRangeOffset = idDeltaOffset + segCountX2;

  const map = new Map();
  for (let segment = 0; segment < segCount; segment += 1) {
    const endCode = readUInt16(view, endCodesOffset + segment * 2);
    const startCode = readUInt16(view, startCodesOffset + segment * 2);
    const idDelta = readInt16(view, idDeltaOffset + segment * 2);
    const idRangeOffsetValue = readUInt16(view, idRangeOffset + segment * 2);

    for (let charCode = startCode; charCode <= endCode; charCode += 1) {
      if (charCode === 0xffff) {
        continue;
      }

      let glyphId;
      if (idRangeOffsetValue === 0) {
        glyphId = (charCode + idDelta) & 0xffff;
      } else {
        const glyphIdOffset =
          idRangeOffset + segment * 2 + idRangeOffsetValue + (charCode - startCode) * 2;
        if (glyphIdOffset + 2 > view.length) {
          continue;
        }
        const rawGlyphId = readUInt16(view, glyphIdOffset);
        glyphId = rawGlyphId === 0 ? 0 : (rawGlyphId + idDelta) & 0xffff;
      }

      if (glyphId !== 0) {
        if (!map.has(glyphId)) {
          map.set(glyphId, charCode);
        }
      }
    }
  }

  return map;
}

function parseCmapFormat12(view, offset) {
  const numGroups = readUInt32(view, offset + 12);
  const map = new Map();

  for (let group = 0; group < numGroups; group += 1) {
    const groupOffset = offset + 16 + group * 12;
    const startCharCode = readUInt32(view, groupOffset);
    const endCharCode = readUInt32(view, groupOffset + 4);
    const startGlyphId = readUInt32(view, groupOffset + 8);

    for (let charCode = startCharCode; charCode <= endCharCode; charCode += 1) {
      const glyphId = startGlyphId + (charCode - startCharCode);
      if (!map.has(glyphId)) {
        map.set(glyphId, charCode);
      }
    }
  }

  return map;
}

export function buildGidToUnicodeMap(buffer) {
  const directory = readTableDirectory(buffer);
  if (!directory) {
    return null;
  }

  const cmap = directory.tables.get("cmap");
  if (!cmap) {
    return null;
  }

  const view = directory.view;
  const numSubtables = readUInt16(view, cmap.offset + 2);
  const subtables = [];
  for (let index = 0; index < numSubtables; index += 1) {
    const recordOffset = cmap.offset + 4 + index * 8;
    const platformId = readUInt16(view, recordOffset);
    const encodingId = readUInt16(view, recordOffset + 2);
    const subtableOffset = cmap.offset + readUInt32(view, recordOffset + 4);
    if (subtableOffset + 2 > view.length) {
      continue;
    }
    const format = readUInt16(view, subtableOffset);
    subtables.push({ platformId, encodingId, format, subtableOffset });
  }

  // Preference order: Unicode platform (0) format 12, then Microsoft (3,10)
  // format 12, then Unicode format 4, then Microsoft Unicode BMP (3,1).
  function rank(subtable) {
    const { platformId, encodingId, format } = subtable;
    if (platformId === 0 && format === 12) return 0;
    if (platformId === 3 && encodingId === 10 && format === 12) return 1;
    if (platformId === 0 && format === 4) return 2;
    if (platformId === 3 && encodingId === 1 && format === 4) return 3;
    if (format === 4) return 4;
    if (format === 12) return 5;
    return 99;
  }

  subtables.sort((left, right) => rank(left) - rank(right));

  for (const subtable of subtables) {
    if (subtable.format === 4) {
      const map = parseCmapFormat4(view, subtable.subtableOffset);
      if (map.size > 0) {
        return map;
      }
    } else if (subtable.format === 12) {
      const map = parseCmapFormat12(view, subtable.subtableOffset);
      if (map.size > 0) {
        return map;
      }
    }
  }

  return null;
}

export function readOs2FsType(buffer) {
  const directory = readTableDirectory(buffer);
  if (!directory) {
    return null;
  }

  const os2 = directory.tables.get("OS/2");
  if (!os2 || os2.length < 10) {
    return null;
  }

  // fsType is the 4th uint16 in the OS/2 table (offset 8).
  return readUInt16(directory.view, os2.offset + 8);
}

// Map an fsType bitmask to a coarse license flag using the bits called out by
// the assignment (1 = restricted, 2 = preview-print, 8 = editable embedding,
// 9 = no-subsetting, plus bit-only / installable handling).
export function classifyFsType(fsType) {
  if (typeof fsType !== "number" || fsType < 0) {
    return "unknown";
  }

  // Bit 1 (value 0x0002) — restricted license embedding.
  if (fsType & 0x0002) {
    return "restricted";
  }

  // Bit 9 (value 0x0200) — no subsetting allowed.
  if (fsType & 0x0200) {
    return "no-subsetting";
  }

  // Bit 8 (value 0x0100) — bitmap embedding only.
  if (fsType & 0x0100) {
    return "bitmap-only";
  }

  // Bit 3 (value 0x0008) — editable embedding.
  if (fsType & 0x0008) {
    return "editable";
  }

  // Bit 2 (value 0x0004) — preview & print embedding.
  if (fsType & 0x0004) {
    return "preview-print";
  }

  if (fsType === 0) {
    return "installable";
  }

  return "unknown";
}
