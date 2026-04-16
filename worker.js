importScripts('templates.js?v=20260416-cff-fix');
importScripts('opentype.min.js');

function readU16(dv, o) { return dv.getUint16(o, false); }
function readU32(dv, o) { return dv.getUint32(o, false); }
function writeU16(dv, o, v) { dv.setUint16(o, v, false); }
function writeU32(dv, o, v) { dv.setUint32(o, v, false); }
function writeS16(dv, o, v) { dv.setInt16(o, v, false); }
function readTag(dv, o) {
  return String.fromCharCode(dv.getUint8(o), dv.getUint8(o+1), dv.getUint8(o+2), dv.getUint8(o+3));
}
function writeTag(dv, o, tag) {
  for (let i = 0; i < 4; i++) dv.setUint8(o + i, tag.charCodeAt(i));
}
function align4(n) { return (n + 3) & ~3; }

function calcChecksum(data) {
  const padLen = align4(data.length);
  const padded = new Uint8Array(padLen);
  padded.set(data);
  const dv = new DataView(padded.buffer);
  let sum = 0;
  for (let i = 0; i < padLen; i += 4) sum = (sum + dv.getUint32(i, false)) >>> 0;
  return sum;
}

function hashData(data) {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i];
    h = Math.imul(h, 0x01000193);
  }
  return `${data.length}:${(h >>> 0).toString(16)}`;
}

function dataEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) return false; }
  return true;
}

function base64ToUint8Array(b64) {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function getEmbeddedSfuiTemplateBuffer() {
  if (typeof SFUI_TEMPLATE_UNIFIED_B64 !== 'string' || !SFUI_TEMPLATE_UNIFIED_B64) {
    throw new Error('缺少内置 SFUI 模板数据。');
  }
  return base64ToUint8Array(SFUI_TEMPLATE_UNIFIED_B64).buffer;
}

function isTTC(buf) {
  const dv = new DataView(buf);
  return readTag(dv, 0) === 'ttcf';
}

function parseTTC(buf) {
  const dv = new DataView(buf);
  const numFonts = readU32(dv, 8);
  const offsets = [];
  for (let i = 0; i < numFonts; i++) offsets.push(readU32(dv, 12 + i * 4));
  return { numFonts, offsets };
}

function parseSFNT(buf, offset) {
  const dv = new DataView(buf);
  const sfVersion = readU32(dv, offset);
  const numTables = readU16(dv, offset + 4);
  const tables = [];
  for (let i = 0; i < numTables; i++) {
    const r = offset + 12 + i * 16;
    tables.push({
      tag: readTag(dv, r),
      checksum: readU32(dv, r + 4),
      offset: readU32(dv, r + 8),
      length: readU32(dv, r + 12),
    });
  }
  return { sfVersion, numTables, tables };
}

function sliceTable(buf, rec) {
  return new Uint8Array(buf.slice(rec.offset, rec.offset + rec.length));
}

function decodeUTF16BE(data, off, len) {
  let s = '';
  for (let i = 0; i < len; i += 2)
    s += String.fromCharCode((data[off + i] << 8) | data[off + i + 1]);
  return s;
}

function decodeMacRoman(data, off, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(data[off + i]);
  return s;
}

function encodeUTF16BE(str) {
  const out = new Uint8Array(str.length * 2);
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    out[i * 2] = (code >> 8) & 0xff;
    out[i * 2 + 1] = code & 0xff;
  }
  return out;
}

function getNameStr(nameData, nameID, platformID, langID) {
  const dv = new DataView(nameData.buffer, nameData.byteOffset, nameData.byteLength);
  const count = readU16(dv, 2);
  const strOff = readU16(dv, 4);
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    if (readU16(dv, r + 6) !== nameID) continue;
    if (readU16(dv, r) !== platformID) continue;
    if (readU16(dv, r + 4) !== langID) continue;
    const len = readU16(dv, r + 8);
    const off = readU16(dv, r + 10);
    if (platformID === 3) return decodeUTF16BE(nameData, strOff + off, len);
    if (platformID === 1) return decodeMacRoman(nameData, strOff + off, len);
  }
  return null;
}

function getSubfamily(nd) {
  return getNameStr(nd, 2, 3, 0x0409) || getNameStr(nd, 2, 1, 0) || 'Regular';
}
function getFamily(nd) {
  return getNameStr(nd, 1, 3, 0x0409) || getNameStr(nd, 1, 1, 0) || '?';
}

function readFontMetrics(tables) {
  const m = { usWeightClass: 400, unitsPerEm: 1000, sTypoAscender: 800, sTypoDescender: -200, sTypoLineGap: 0 };
  const os2 = tables.find(t => t.tag === 'OS/2');
  if (os2 && os2.data.length >= 78) {
    const dv = new DataView(os2.data.buffer, os2.data.byteOffset, os2.data.byteLength);
    m.usWeightClass = dv.getUint16(4, false);
    m.sTypoAscender = dv.getInt16(68, false);
    m.sTypoDescender = dv.getInt16(70, false);
    m.sTypoLineGap = dv.getInt16(72, false);
  }
  const head = tables.find(t => t.tag === 'head');
  if (head && head.data.length >= 20) {
    const dv = new DataView(head.data.buffer, head.data.byteOffset, head.data.byteLength);
    m.unitsPerEm = dv.getUint16(18, false);
  }
  return m;
}

function modifyOS2(d, weight, fsType, lineHeightOffset) {
  const c = new Uint8Array(d.length);
  c.set(d);
  const dv = new DataView(c.buffer);
  writeU16(dv, 4, weight);
  writeU16(dv, 8, fsType);
  if (lineHeightOffset && d.length >= 78) {
    dv.setInt16(68, dv.getInt16(68, false) + lineHeightOffset, false);
    dv.setInt16(70, dv.getInt16(70, false) - lineHeightOffset, false);
    dv.setInt16(72, dv.getInt16(72, false) + lineHeightOffset, false);
    dv.setUint16(74, Math.max(0, dv.getUint16(74, false) + lineHeightOffset), false);
    dv.setUint16(76, Math.max(0, dv.getUint16(76, false) + lineHeightOffset), false);
  }
  return c;
}

function modifyHhea(d, lineHeightOffset) {
  if (!lineHeightOffset || !d || d.length < 10) return d;
  const c = new Uint8Array(d.length);
  c.set(d);
  const dv = new DataView(c.buffer);
  dv.setInt16(4, dv.getInt16(4, false) + lineHeightOffset, false);
  dv.setInt16(6, dv.getInt16(6, false) - lineHeightOffset, false);
  dv.setInt16(8, dv.getInt16(8, false) + lineHeightOffset, false);
  return c;
}

function modifyHead(d, sizeOffset) {
  if (!sizeOffset || !d || d.length < 20) return d;
  const c = new Uint8Array(d.length);
  c.set(d);
  const dv = new DataView(c.buffer);
  const cur = dv.getUint16(18, false);
  const next = Math.max(16, cur - sizeOffset);
  dv.setUint16(18, next, false);
  dv.setUint32(8, 0, false);
  return c;
}

const WEIGHT_KW = {
  ultralight:'ultralight', extralight:'ultralight',
  thin:'thin', light:'light',
  regular:'regular', 'default':'regular',
  medium:'medium',
  semibold:'semibold', demibold:'semibold',
  bold:'bold',
  heavy:'heavy', extrabold:'heavy', ultrabold:'heavy', black:'heavy',
};
const FALLBACK = {
  ultralight:['thin','light','regular'],
  thin:['ultralight','light','regular'],
  light:['thin','regular','ultralight'],
  regular:['medium','light','thin'],
  medium:['regular','semibold','light'],
  semibold:['bold','medium','heavy','regular'],
  bold:['semibold','heavy','medium','regular'],
  heavy:['bold','semibold','medium','regular'],
};

function classifyWeight(sub) {
  const s = sub.toLowerCase();
  for (const [kw, cat] of Object.entries(WEIGHT_KW)) {
    if (s.includes(kw)) return cat;
  }
  return 'regular';
}

function pickSource(sources, targetWeight, mode) {
  let mappedWeight = 'regular';
  if (mode === 'single') {
    mappedWeight = 'regular';
  } else if (mode === 'dual') {
    if (['medium', 'semibold', 'bold', 'heavy'].includes(targetWeight)) {
      mappedWeight = 'medium';
    } else {
      mappedWeight = 'regular';
    }
  } else if (mode === 'triple') {
    if (['medium', 'semibold', 'bold', 'heavy'].includes(targetWeight)) {
      mappedWeight = 'bold';
    } else if (['ultralight', 'thin', 'light'].includes(targetWeight)) {
      mappedWeight = 'light';
    } else {
      mappedWeight = 'regular';
    }
  }
  if (sources.has(mappedWeight)) return sources.get(mappedWeight);
  if (sources.has('regular')) return sources.get('regular');
  return sources.values().next().value;
}

function loadSource(buf) {
  const sources = new Map();
  if (isTTC(buf)) {
    const ttc = parseTTC(buf);
    const hasPub = ttc.offsets.some(off => {
      const s = parseSFNT(buf, off);
      const nr = s.tables.find(t => t.tag === 'name');
      if (!nr) return false;
      return !getFamily(sliceTable(buf, nr)).startsWith('.');
    });
    for (const offset of ttc.offsets) {
      const sfnt = parseSFNT(buf, offset);
      const nameRec = sfnt.tables.find(t => t.tag === 'name');
      if (!nameRec) continue;
      const nd = sliceTable(buf, nameRec);
      const fam = getFamily(nd);
      if (hasPub && fam.startsWith('.')) continue;
      const cat = classifyWeight(getSubfamily(nd));
      if (!sources.has(cat)) {
        sources.set(cat, {
          sfVersion: sfnt.sfVersion,
          tables: sfnt.tables.map(t => ({ tag: t.tag, data: sliceTable(buf, t) })),
        });
      }
    }
  } else {
    const sfnt = parseSFNT(buf, 0);
    const fontData = {
      sfVersion: sfnt.sfVersion,
      tables: sfnt.tables.map(t => ({ tag: t.tag, data: sliceTable(buf, t) })),
    };
    for (const w of ['ultralight','thin','light','regular','medium','semibold','bold','heavy'])
      sources.set(w, fontData);
  }
  return sources;
}

function pickPrimaryFont(buf) {
  if (isTTC(buf)) {
    const ttc = parseTTC(buf);
    let fallback = null;
    for (const offset of ttc.offsets) {
      const sfnt = parseSFNT(buf, offset);
      const fontData = {
        sfVersion: sfnt.sfVersion,
        tables: sfnt.tables.map(t => ({ tag: t.tag, data: sliceTable(buf, t) })),
      };
      const nameRec = sfnt.tables.find(t => t.tag === 'name');
      if (!fallback) fallback = fontData;
      if (!nameRec) continue;
      const family = getFamily(sliceTable(buf, nameRec));
      if (!family.startsWith('.')) return fontData;
    }
    return fallback;
  }
  const sfnt = parseSFNT(buf, 0);
  return {
    sfVersion: sfnt.sfVersion,
    tables: sfnt.tables.map(t => ({ tag: t.tag, data: sliceTable(buf, t) })),
  };
}

function makeTableMap(fontData) {
  const map = new Map();
  for (const table of fontData.tables) map.set(table.tag, table.data);
  return map;
}

function sanitizePostScriptName(name) {
  return name.replace(/[^A-Za-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'SFUI-Regular';
}

function buildSubsetUnicodeList() {
  const ranges = [
    [0x0020, 0x007e], [0x00a0, 0x00ac], [0x00ae, 0x0148], [0x014b, 0x017f],
    [0x018e, 0x018f], [0x0192, 0x0192], [0x01a0, 0x01a1], [0x01af, 0x01b0],
    [0x01c0, 0x01e3], [0x01e6, 0x01ed], [0x01f1, 0x01f5], [0x01f8, 0x021b],
    [0x021e, 0x021f], [0x0226, 0x0233], [0x0237, 0x0237], [0x0250, 0x02b2],
    [0x02b4, 0x02b4], [0x02b7, 0x02b7], [0x02b9, 0x02bc], [0x02be, 0x02be],
    [0x02c6, 0x02c8], [0x02cc, 0x02cc], [0x02d0, 0x02d1], [0x02d8, 0x02de],
    [0x02e0, 0x02e0], [0x02e4, 0x02e4], [0x0300, 0x0304], [0x0306, 0x030c],
    [0x030f, 0x030f], [0x0311, 0x0311], [0x0318, 0x0320], [0x0323, 0x032a],
    [0x032c, 0x0332], [0x0334, 0x0334], [0x0339, 0x033d], [0x035c, 0x035f],
    [0x0361, 0x0361], [0x037e, 0x037e], [0x0384, 0x038a], [0x038c, 0x038c],
    [0x038e, 0x03a1], [0x03a3, 0x03ce], [0x03dc, 0x03dd], [0x0400, 0x045f],
    [0x0462, 0x0463], [0x0472, 0x0475], [0x048a, 0x04ff], [0x0510, 0x0513],
    [0x051c, 0x051d], [0x0524, 0x0527], [0x052e, 0x052f], [0x0e3f, 0x0e3f],
    [0x16ab, 0x16ab], [0x1d7b, 0x1d7b], [0x1e00, 0x1e99], [0x1e9e, 0x1e9e],
    [0x1ea0, 0x1ef9], [0x1fbf, 0x1fbf], [0x1ffe, 0x1ffe], [0x2000, 0x200d],
    [0x2011, 0x2014], [0x2016, 0x2016], [0x2018, 0x201a], [0x201c, 0x201e],
    [0x2020, 0x2023], [0x2026, 0x2026], [0x2028, 0x2029], [0x202f, 0x2030],
    [0x2032, 0x2034], [0x2038, 0x203a], [0x203d, 0x203d], [0x203f, 0x203f],
    [0x2041, 0x2044], [0x2053, 0x2053], [0x205f, 0x2060], [0x2070, 0x2071],
    [0x2074, 0x208e], [0x20a1, 0x20ae], [0x20b1, 0x20b5], [0x20b8, 0x20ba],
    [0x20bc, 0x20bf], [0x20dd, 0x20de], [0x2100, 0x2101], [0x2103, 0x2106],
    [0x2109, 0x2109], [0x2116, 0x2117], [0x2120, 0x2120], [0x2122, 0x2122],
    [0x2126, 0x2126], [0x212a, 0x212b], [0x2150, 0x215e], [0x2190, 0x2194],
    [0x2196, 0x2199], [0x21ba, 0x21bb], [0x21c5, 0x21c5], [0x21e7, 0x21e7],
    [0x21ea, 0x21ea], [0x2202, 0x2202], [0x2206, 0x2207], [0x220f, 0x220f],
    [0x2211, 0x2212], [0x2219, 0x221b], [0x221e, 0x221e], [0x222b, 0x222b],
    [0x223c, 0x223c], [0x2248, 0x2248], [0x2260, 0x2261], [0x2264, 0x2265],
    [0x2295, 0x2297], [0x229c, 0x229c], [0x2300, 0x2300], [0x2303, 0x2303],
    [0x2305, 0x2305], [0x2318, 0x2318], [0x2325, 0x2327], [0x232b, 0x232b],
    [0x2387, 0x2387], [0x238b, 0x238b], [0x23ce, 0x23cf], [0x2460, 0x2468],
    [0x2472, 0x2472], [0x24b6, 0x24cf], [0x24ea, 0x24ea], [0x24f3, 0x24f3],
    [0x24ff, 0x24ff], [0x2502, 0x2502], [0x25a0, 0x25a1], [0x25b2, 0x25b4],
    [0x25b6, 0x25b8], [0x25bc, 0x25be], [0x25c0, 0x25c2], [0x25ca, 0x25cb],
    [0x25cf, 0x25cf], [0x25e6, 0x25e6], [0x2605, 0x2606], [0x2611, 0x2612],
    [0x263e, 0x263e], [0x2660, 0x2667], [0x266d, 0x266f], [0x26a0, 0x26a0],
    [0x26ac, 0x26ac], [0x2708, 0x2708], [0x2713, 0x2713], [0x2717, 0x2717],
    [0x275b, 0x275e], [0x2776, 0x277e], [0x2780, 0x2788], [0x278a, 0x2792],
    [0x27a4, 0x27a4], [0x2912, 0x2913], [0x2934, 0x2937], [0x2981, 0x2981],
    [0x2c71, 0x2c71], [0x3003, 0x3003], [0xf6d5, 0xf6d8], [0xf765, 0xf765],
    [0xf79e, 0xf79e], [0xf860, 0xf861], [0xf8ff, 0xf8ff], [0xfb01, 0xfb02],
    [0xfffd, 0xfffd], [0x1f10b, 0x1f10c], [0x1f130, 0x1f149], [0x1f150, 0x1f16b],
    [0x1f170, 0x1f189]
  ];
  const cps = [];
  for (const [start, end] of ranges) {
    for (let cp = start; cp <= end; cp++) cps.push(cp);
  }
  return cps;
}

const SUBSET_CODEPOINTS = buildSubsetUnicodeList();

function shouldReplaceFromSource(cp) {
  return cp !== 0;
}

function parseUnicodeCmap(cmapData) {
  const dv = new DataView(cmapData.buffer, cmapData.byteOffset, cmapData.byteLength);
  const numTables = readU16(dv, 2);
  const records = [];
  for (let i = 0; i < numTables; i++) {
    const off = 4 + i * 8;
    records.push({
      platformID: readU16(dv, off),
      encodingID: readU16(dv, off + 2),
      offset: readU32(dv, off + 4)
    });
  }
  records.sort((a, b) => {
    const rank = rec => (rec.platformID === 3 && rec.encodingID === 10 ? 0 :
      rec.platformID === 0 ? 1 :
      rec.platformID === 3 && rec.encodingID === 1 ? 2 : 3);
    return rank(a) - rank(b);
  });
  const map = new Map();

  for (const record of records) {
    const base = record.offset;
    if (base + 2 > cmapData.byteLength) continue;
    const format = readU16(dv, base);
    if (format === 4) {
      const segCount = readU16(dv, base + 6) / 2;
      const endCountOff = base + 14;
      const startCountOff = endCountOff + segCount * 2 + 2;
      const idDeltaOff = startCountOff + segCount * 2;
      const idRangeOffOff = idDeltaOff + segCount * 2;
      for (let i = 0; i < segCount; i++) {
        const start = readU16(dv, startCountOff + i * 2);
        const end = readU16(dv, endCountOff + i * 2);
        const delta = readU16(dv, idDeltaOff + i * 2);
        const range = readU16(dv, idRangeOffOff + i * 2);
        if (start === 0xffff && end === 0xffff) continue;
        for (let cp = start; cp <= end; cp++) {
          let gid = 0;
          if (range === 0) {
            gid = (cp + delta) & 0xffff;
          } else {
            const glyphOffset = idRangeOffOff + i * 2 + range + (cp - start) * 2;
            if (glyphOffset + 2 > cmapData.byteLength) continue;
            gid = readU16(dv, glyphOffset);
            if (gid !== 0) gid = (gid + delta) & 0xffff;
          }
          if (gid !== 0 && !map.has(cp)) map.set(cp, gid);
        }
      }
    } else if (format === 12) {
      const nGroups = readU32(dv, base + 12);
      let off = base + 16;
      for (let i = 0; i < nGroups; i++) {
        const start = readU32(dv, off);
        const end = readU32(dv, off + 4);
        const startGlyph = readU32(dv, off + 8);
        for (let cp = start; cp <= end; cp++) {
          if (!map.has(cp)) map.set(cp, startGlyph + (cp - start));
        }
        off += 12;
      }
    }
  }
  return map;
}

function parseHmtx(hmtxData, numGlyphs, numberOfHMetrics) {
  const dv = new DataView(hmtxData.buffer, hmtxData.byteOffset, hmtxData.byteLength);
  const metrics = [];
  let advance = 0;
  for (let i = 0; i < numGlyphs; i++) {
    if (i < numberOfHMetrics) {
      advance = readU16(dv, i * 4);
      const lsb = dv.getInt16(i * 4 + 2, false);
      metrics.push([advance, lsb]);
    } else {
      const lsbOff = numberOfHMetrics * 4 + (i - numberOfHMetrics) * 2;
      metrics.push([advance, dv.getInt16(lsbOff, false)]);
    }
  }
  return metrics;
}

function parseLoca(locaData, numGlyphs, indexToLocFormat) {
  const dv = new DataView(locaData.buffer, locaData.byteOffset, locaData.byteLength);
  const offsets = [];
  if (indexToLocFormat === 0) {
    for (let i = 0; i <= numGlyphs; i++) offsets.push(readU16(dv, i * 2) * 2);
  } else {
    for (let i = 0; i <= numGlyphs; i++) offsets.push(readU32(dv, i * 4));
  }
  return offsets;
}

function glyphDataSlice(glyfData, locaOffsets, glyphId) {
  const start = locaOffsets[glyphId];
  const end = locaOffsets[glyphId + 1];
  return new Uint8Array(glyfData.slice(start, end));
}

function isCompositeGlyphBytes(bytes) {
  if (!bytes || bytes.length < 10) return false;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return dv.getInt16(0, false) < 0;
}

function scaleMetricValue(value, scale) {
  return Math.round(value * scale);
}

function parseSimpleGlyph(bytes) {
  if (!bytes || bytes.length < 10) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numContours = dv.getInt16(0, false);
  if (numContours < 0) return null;

  const endPts = [];
  let off = 10;
  for (let i = 0; i < numContours; i++) {
    endPts.push(readU16(dv, off));
    off += 2;
  }
  const instructionLength = readU16(dv, off);
  off += 2;
  const instructions = bytes.slice(off, off + instructionLength);
  off += instructionLength;
  const pointCount = endPts.length ? (endPts[endPts.length - 1] + 1) : 0;
  const flags = [];
  while (flags.length < pointCount && off < bytes.length) {
    const flag = bytes[off++];
    flags.push(flag);
    if (flag & 0x08) {
      const repeat = bytes[off++];
      for (let i = 0; i < repeat; i++) flags.push(flag);
    }
  }

  const xs = new Array(pointCount);
  let x = 0;
  for (let i = 0; i < pointCount; i++) {
    const flag = flags[i];
    let dx = 0;
    if (flag & 0x02) {
      const b = bytes[off++];
      dx = (flag & 0x10) ? b : -b;
    } else if (!(flag & 0x10)) {
      dx = dv.getInt16(off, false);
      off += 2;
    }
    x += dx;
    xs[i] = x;
  }

  const ys = new Array(pointCount);
  let y = 0;
  for (let i = 0; i < pointCount; i++) {
    const flag = flags[i];
    let dy = 0;
    if (flag & 0x04) {
      const b = bytes[off++];
      dy = (flag & 0x20) ? b : -b;
    } else if (!(flag & 0x20)) {
      dy = dv.getInt16(off, false);
      off += 2;
    }
    y += dy;
    ys[i] = y;
  }

  const points = [];
  for (let i = 0; i < pointCount; i++) {
    points.push({
      x: xs[i],
      y: ys[i],
      onCurve: !!(flags[i] & 0x01)
    });
  }
  return { numContours, endPts, instructions, points };
}

function flattenGlyph(glyfData, locaOffsets, glyphId, seen) {
  if (!seen) seen = new Set();
  if (seen.has(glyphId)) return null;
  seen.add(glyphId);
  const bytes = glyphDataSlice(glyfData, locaOffsets, glyphId);
  if (!bytes || bytes.length < 10) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nc = dv.getInt16(0, false);
  if (nc >= 0) return parseSimpleGlyph(bytes);
  const allPts = [], allEndPts = [];
  let off = 10;
  while (off + 4 <= bytes.length) {
    const flags = readU16(dv, off);
    const compGid = readU16(dv, off + 2);
    off += 4;
    let dx = 0, dy = 0;
    if (flags & 0x0001) {
      if (flags & 0x0002) { dx = dv.getInt16(off, false); dy = dv.getInt16(off + 2, false); }
      off += 4;
    } else {
      if (flags & 0x0002) { dx = dv.getInt8(off); dy = dv.getInt8(off + 1); }
      off += 2;
    }
    let a = 1, b = 0, c = 0, d = 1;
    if (flags & 0x0008) { a = d = dv.getInt16(off, false) / 16384; off += 2; }
    else if (flags & 0x0040) { a = dv.getInt16(off, false) / 16384; d = dv.getInt16(off + 2, false) / 16384; off += 4; }
    else if (flags & 0x0080) { a = dv.getInt16(off, false) / 16384; b = dv.getInt16(off + 2, false) / 16384; c = dv.getInt16(off + 4, false) / 16384; d = dv.getInt16(off + 6, false) / 16384; off += 8; }
    const comp = flattenGlyph(glyfData, locaOffsets, compGid, new Set(seen));
    if (comp && comp.points && comp.points.length > 0) {
      const base = allPts.length;
      for (const pt of comp.points) {
        allPts.push({ x: Math.round(pt.x * a + pt.y * b + dx), y: Math.round(pt.x * c + pt.y * d + dy), onCurve: pt.onCurve });
      }
      for (const ep of comp.endPts) allEndPts.push(ep + base);
    }
    if (!(flags & 0x0020)) break;
  }
  if (allPts.length === 0) return null;
  return { numContours: allEndPts.length, endPts: allEndPts, instructions: new Uint8Array(0), points: allPts };
}

function isCffFont(fontData) {
  const tables = makeTableMap(fontData);
  return tables.has('CFF ') || tables.has('CFF2') || fontData.sfVersion === 0x4f54544f;
}

function pointAlmostEqual(a, b) {
  return Math.abs(a.x - b.x) < 0.001 && Math.abs(a.y - b.y) < 0.001;
}

function lerpPoint(a, b, t) {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t
  };
}

function splitCubic(p0, p1, p2, p3, t) {
  const p01 = lerpPoint(p0, p1, t);
  const p12 = lerpPoint(p1, p2, t);
  const p23 = lerpPoint(p2, p3, t);
  const p012 = lerpPoint(p01, p12, t);
  const p123 = lerpPoint(p12, p23, t);
  const p0123 = lerpPoint(p012, p123, t);
  return [
    [p0, p01, p012, p0123],
    [p0123, p123, p23, p3]
  ];
}

function fontCoordPoint(pt) {
  return {
    x: pt.x,
    y: -pt.y
  };
}

function lineIntersection(p0, p1, p2, p3) {
  const x1 = p0.x, y1 = p0.y, x2 = p1.x, y2 = p1.y;
  const x3 = p2.x, y3 = p2.y, x4 = p3.x, y4 = p3.y;
  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denom) < 1e-6) {
    return {
      x: (-0.25 * x1 + 0.75 * x2 + 0.75 * x3 - 0.25 * x4),
      y: (-0.25 * y1 + 0.75 * y2 + 0.75 * y3 - 0.25 * y4)
    };
  }
  const det1 = x1 * y2 - y1 * x2;
  const det2 = x3 * y4 - y3 * x4;
  return {
    x: (det1 * (x3 - x4) - (x1 - x2) * det2) / denom,
    y: (det1 * (y3 - y4) - (y1 - y2) * det2) / denom
  };
}

function cubicPointAt(p0, p1, p2, p3, t) {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const t2 = t * t;
  return {
    x: mt2 * mt * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t2 * t * p3.x,
    y: mt2 * mt * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t2 * t * p3.y
  };
}

function quadPointAt(p0, p1, p2, t) {
  const mt = 1 - t;
  return {
    x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
    y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y
  };
}

function cubicToQuadraticSegments(p0, p1, p2, p3, tolerance, out, depth) {
  depth = depth || 0;
  const control = lineIntersection(p0, p1, p3, p2);
  const testTs = [0.25, 0.5, 0.75];
  let maxErr = 0;
  for (const t of testTs) {
    const c = cubicPointAt(p0, p1, p2, p3, t);
    const q = quadPointAt(p0, control, p3, t);
    const err = Math.max(Math.abs(c.x - q.x), Math.abs(c.y - q.y));
    if (err > maxErr) maxErr = err;
  }
  if (maxErr <= tolerance || depth >= 8) {
    out.push({ control, end: p3 });
    return;
  }
  const [left, right] = splitCubic(p0, p1, p2, p3, 0.5);
  cubicToQuadraticSegments(left[0], left[1], left[2], left[3], tolerance, out, depth + 1);
  cubicToQuadraticSegments(right[0], right[1], right[2], right[3], tolerance, out, depth + 1);
}

function opentypePathToParsedGlyph(pathCommands, tolerance) {
  const contours = [];
  let contour = null;
  let current = null;
  let start = null;

  function ensureContourAt(pt) {
    const fp = fontCoordPoint(pt);
    contour = [];
    start = { x: fp.x, y: fp.y };
    current = { x: fp.x, y: fp.y };
    contour.push({ x: Math.round(fp.x), y: Math.round(fp.y), onCurve: true });
    contours.push(contour);
  }

  function closeContour() {
    if (!contour || contour.length === 0) return;
    const first = contour[0];
    const last = contour[contour.length - 1];
    if (!pointAlmostEqual(first, last)) {
      contour.push({ x: first.x, y: first.y, onCurve: true });
    }
    contour = null;
    current = null;
    start = null;
  }

  for (const cmd of pathCommands) {
    if (cmd.type === 'M') {
      closeContour();
      ensureContourAt(cmd);
    } else if (cmd.type === 'L') {
      if (!contour) ensureContourAt(cmd);
      const end = fontCoordPoint(cmd);
      contour.push({ x: Math.round(end.x), y: Math.round(end.y), onCurve: true });
      current = end;
    } else if (cmd.type === 'Q') {
      if (!contour) ensureContourAt(current || cmd);
      const control = fontCoordPoint({ x: cmd.x1, y: cmd.y1 });
      const end = fontCoordPoint(cmd);
      contour.push({ x: Math.round(control.x), y: Math.round(control.y), onCurve: false });
      contour.push({ x: Math.round(end.x), y: Math.round(end.y), onCurve: true });
      current = end;
    } else if (cmd.type === 'C') {
      if (!contour) ensureContourAt(current || cmd);
      const segments = [];
      cubicToQuadraticSegments(
        current,
        fontCoordPoint({ x: cmd.x1, y: cmd.y1 }),
        fontCoordPoint({ x: cmd.x2, y: cmd.y2 }),
        fontCoordPoint(cmd),
        tolerance,
        segments,
        0
      );
      for (const seg of segments) {
        contour.push({ x: Math.round(seg.control.x), y: Math.round(seg.control.y), onCurve: false });
        contour.push({ x: Math.round(seg.end.x), y: Math.round(seg.end.y), onCurve: true });
      }
      current = fontCoordPoint(cmd);
    } else if (cmd.type === 'Z') {
      if (start && current && !pointAlmostEqual(start, current)) {
        contour.push({ x: Math.round(start.x), y: Math.round(start.y), onCurve: true });
      }
      closeContour();
    }
  }
  closeContour();

  const points = [];
  const endPts = [];
  let cursor = 0;
  for (const rawContour of contours) {
    const simplified = [];
    for (const pt of rawContour) {
      const prev = simplified[simplified.length - 1];
      if (!prev || prev.x !== pt.x || prev.y !== pt.y || prev.onCurve !== pt.onCurve) {
        simplified.push(pt);
      }
    }
    while (simplified.length > 1) {
      const first = simplified[0];
      const last = simplified[simplified.length - 1];
      if (first.x === last.x && first.y === last.y && first.onCurve === last.onCurve) {
        simplified.pop();
      } else {
        break;
      }
    }
    if (!simplified.length) continue;
    points.push(...simplified);
    cursor += simplified.length;
    endPts.push(cursor - 1);
  }

  if (!points.length) return null;
  return {
    numContours: endPts.length,
    endPts,
    instructions: new Uint8Array(0),
    points
  };
}

function buildGlyphFromOpenTypeGlyph(glyph, sourceUpm, scale) {
  if (!glyph) return null;
  const path = glyph.getPath(0, 0, sourceUpm);
  if (!path || !path.commands || !path.commands.length) return null;
  const tolerance = Math.max(1, sourceUpm / 200);
  const parsed = opentypePathToParsedGlyph(path.commands, tolerance);
  if (!parsed) return null;
  const encoded = encodeSimpleGlyphFromParsed(parsed, scale);
  return encoded && encoded.length ? encoded : null;
}

function encodeSimpleGlyphFromParsed(parsed, s) {
  if (!parsed || !parsed.points || parsed.points.length === 0) return new Uint8Array(0);
  const pts = s !== 1 ? parsed.points.map(p => ({ x: scaleMetricValue(p.x, s), y: scaleMetricValue(p.y, s), onCurve: p.onCurve })) : parsed.points;
  let xMin = pts[0].x, yMin = pts[0].y, xMax = pts[0].x, yMax = pts[0].y;
  for (const p of pts) { if (p.x < xMin) xMin = p.x; if (p.y < yMin) yMin = p.y; if (p.x > xMax) xMax = p.x; if (p.y > yMax) yMax = p.y; }
  const flagB = [], xB = [], yB = [];
  let px = 0, py = 0;
  for (const p of pts) {
    let f = p.onCurve ? 0x01 : 0;
    const dx = p.x - px, dy = p.y - py;
    if (dx === 0) f |= 0x10;
    else if (dx > 0 && dx < 256) { f |= 0x12; xB.push(dx); }
    else if (dx < 0 && dx > -256) { f |= 0x02; xB.push(-dx); }
    else encodeS16(xB, dx);
    if (dy === 0) f |= 0x20;
    else if (dy > 0 && dy < 256) { f |= 0x24; yB.push(dy); }
    else if (dy < 0 && dy > -256) { f |= 0x04; yB.push(-dy); }
    else encodeS16(yB, dy);
    flagB.push(f); px = p.x; py = p.y;
  }
  const inst = new Uint8Array(0);
  const len = 10 + parsed.endPts.length * 2 + 2 + inst.length + flagB.length + xB.length + yB.length;
  const out = new Uint8Array(len);
  const dv = new DataView(out.buffer);
  writeS16(dv, 0, parsed.numContours); writeS16(dv, 2, xMin); writeS16(dv, 4, yMin); writeS16(dv, 6, xMax); writeS16(dv, 8, yMax);
  let o = 10;
  for (const ep of parsed.endPts) { writeU16(dv, o, ep); o += 2; }
  writeU16(dv, o, inst.length); o += 2;
  out.set(inst, o); o += inst.length;
  out.set(flagB, o); o += flagB.length;
  out.set(xB, o); o += xB.length;
  out.set(yB, o);
  return out;
}

function encodeS16(bytes, value) {
  const normalized = ((value % 0x10000) + 0x10000) % 0x10000;
  bytes.push((normalized >> 8) & 0xff, normalized & 0xff);
}

function buildScaledSimpleGlyph(bytes, scale) {
  if (!bytes || bytes.length === 0) return bytes;
  const parsed = parseSimpleGlyph(bytes);
  if (!parsed) return null;

  const scaledPoints = parsed.points.map(point => ({
    x: scaleMetricValue(point.x, scale),
    y: scaleMetricValue(point.y, scale),
    onCurve: point.onCurve
  }));

  let xMin = 0;
  let yMin = 0;
  let xMax = 0;
  let yMax = 0;
  if (scaledPoints.length) {
    xMin = Math.min(...scaledPoints.map(point => point.x));
    yMin = Math.min(...scaledPoints.map(point => point.y));
    xMax = Math.max(...scaledPoints.map(point => point.x));
    yMax = Math.max(...scaledPoints.map(point => point.y));
  }

  const flagBytes = [];
  const xBytes = [];
  const yBytes = [];
  let prevX = 0;
  let prevY = 0;

  scaledPoints.forEach(point => {
    let flag = point.onCurve ? 0x01 : 0;
    const dx = point.x - prevX;
    const dy = point.y - prevY;

    if (dx === 0) {
      flag |= 0x10;
    } else if (dx > 0 && dx < 256) {
      flag |= 0x12;
      xBytes.push(dx);
    } else if (dx < 0 && dx > -256) {
      flag |= 0x02;
      xBytes.push(-dx);
    } else {
      encodeS16(xBytes, dx);
    }

    if (dy === 0) {
      flag |= 0x20;
    } else if (dy > 0 && dy < 256) {
      flag |= 0x24;
      yBytes.push(dy);
    } else if (dy < 0 && dy > -256) {
      flag |= 0x04;
      yBytes.push(-dy);
    } else {
      encodeS16(yBytes, dy);
    }

    flagBytes.push(flag);
    prevX = point.x;
    prevY = point.y;
  });

  const inst = new Uint8Array(0);
  const outLength = 10 + parsed.endPts.length * 2 + 2 + inst.length
    + flagBytes.length + xBytes.length + yBytes.length;
  const out = new Uint8Array(outLength);
  const dv = new DataView(out.buffer);
  writeS16(dv, 0, parsed.numContours);
  writeS16(dv, 2, xMin);
  writeS16(dv, 4, yMin);
  writeS16(dv, 6, xMax);
  writeS16(dv, 8, yMax);

  let off = 10;
  parsed.endPts.forEach(endPt => {
    writeU16(dv, off, endPt);
    off += 2;
  });
  writeU16(dv, off, inst.length);
  off += 2;
  out.set(inst, off);
  off += inst.length;
  out.set(flagBytes, off);
  off += flagBytes.length;
  out.set(xBytes, off);
  off += xBytes.length;
  out.set(yBytes, off);
  return out;
}

function collectGlyphDependencies(glyfData, locaOffsets, glyphId, seen) {
  if (seen.has(glyphId)) return;
  seen.add(glyphId);
  const bytes = glyphDataSlice(glyfData, locaOffsets, glyphId);
  if (bytes.length < 10) return;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const contours = dv.getInt16(0, false);
  if (contours >= 0) return;

  let off = 10;
  while (off + 4 <= bytes.length) {
    const flags = readU16(dv, off);
    const componentGlyphId = readU16(dv, off + 2);
    collectGlyphDependencies(glyfData, locaOffsets, componentGlyphId, seen);
    off += 4;
    off += (flags & 0x0001) ? 4 : 2;
    if (flags & 0x0008) off += 2;
    else if (flags & 0x0040) off += 4;
    else if (flags & 0x0080) off += 8;
    if (!(flags & 0x0020)) {
      if (flags & 0x0100) off += 2 + readU16(dv, off);
      break;
    }
  }
}

function remapCompositeGlyph(bytes, glyphIdMap) {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  if (out.length < 10) return out;
  const dv = new DataView(out.buffer);
  const contours = dv.getInt16(0, false);
  if (contours >= 0) return out;

  let off = 10;
  while (off + 4 <= out.length) {
    const flags = readU16(dv, off);
    const oldGlyphId = readU16(dv, off + 2);
    const newGlyphId = glyphIdMap.get(oldGlyphId);
    writeU16(dv, off + 2, newGlyphId == null ? 0 : newGlyphId);
    off += 4;
    off += (flags & 0x0001) ? 4 : 2;
    if (flags & 0x0008) off += 2;
    else if (flags & 0x0040) off += 4;
    else if (flags & 0x0080) off += 8;
    if (!(flags & 0x0020)) {
      if (flags & 0x0100) {
        const instructionLength = readU16(dv, off);
        off += 2 + instructionLength;
      }
      break;
    }
  }
  return out;
}

function buildLoca(offsets) {
  const out = new Uint8Array(offsets.length * 4);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < offsets.length; i++) writeU32(dv, i * 4, offsets[i]);
  return out;
}

function buildHmtx(subsetGlyphIds, metrics) {
  const out = new Uint8Array(subsetGlyphIds.length * 4);
  const dv = new DataView(out.buffer);
  subsetGlyphIds.forEach((oldGlyphId, idx) => {
    const [adv, lsb] = metrics[oldGlyphId];
    writeU16(dv, idx * 4, adv);
    writeS16(dv, idx * 4 + 2, lsb);
  });
  return out;
}

function buildHmtxFromMetrics(metrics) {
  let numberOfHMetrics = metrics.length;
  while (
    numberOfHMetrics > 1 &&
    metrics[numberOfHMetrics - 1][0] === metrics[numberOfHMetrics - 2][0]
  ) {
    numberOfHMetrics--;
  }

  const out = new Uint8Array(numberOfHMetrics * 4 + (metrics.length - numberOfHMetrics) * 2);
  const dv = new DataView(out.buffer);
  metrics.slice(0, numberOfHMetrics).forEach(([advance, lsb], idx) => {
    writeU16(dv, idx * 4, advance);
    writeS16(dv, idx * 4 + 2, lsb);
  });
  for (let idx = numberOfHMetrics; idx < metrics.length; idx++) {
    writeS16(dv, numberOfHMetrics * 4 + (idx - numberOfHMetrics) * 2, metrics[idx][1]);
  }
  return { data: out, numberOfHMetrics };
}

function buildMaxp(maxpData, numGlyphs) {
  const out = new Uint8Array(maxpData.length);
  out.set(maxpData);
  const dv = new DataView(out.buffer);
  writeU16(dv, 4, numGlyphs);
  return out;
}

function buildMaxpWithStats(maxpData, numGlyphs, stats) {
  const out = buildMaxp(maxpData, numGlyphs);
  if (out.length < 32) return out;
  const dv = new DataView(out.buffer);
  writeU16(dv, 6, Math.max(readU16(dv, 6), stats.maxPoints));
  writeU16(dv, 8, Math.max(readU16(dv, 8), stats.maxContours));
  writeU16(dv, 10, Math.max(readU16(dv, 10), stats.maxCompositePoints));
  writeU16(dv, 12, Math.max(readU16(dv, 12), stats.maxCompositeContours));
  writeU16(dv, 24, 0);
  writeU16(dv, 26, 0);
  writeU16(dv, 28, Math.max(readU16(dv, 28), stats.maxComponentElements));
  writeU16(dv, 30, Math.max(readU16(dv, 30), stats.maxComponentDepth));
  return out;
}

function buildHhea(hheaData, numberOfHMetrics, metrics, bounds) {
  const out = new Uint8Array(hheaData.length);
  out.set(hheaData);
  const dv = new DataView(out.buffer);
  if (metrics && bounds) {
    let advanceWidthMax = 0;
    let minLSB = 0;
    let minRSB = 0;
    let xMaxExtent = 0;
    metrics.forEach(([advance, lsb], idx) => {
      const box = bounds[idx];
      if (advance > advanceWidthMax) advanceWidthMax = advance;
      if (!box) return;
      const rsb = advance - lsb - (box.xMax - box.xMin);
      if (idx === 0 || lsb < minLSB) minLSB = lsb;
      if (idx === 0 || rsb < minRSB) minRSB = rsb;
      if (idx === 0 || lsb + box.xMax - box.xMin > xMaxExtent) xMaxExtent = lsb + box.xMax - box.xMin;
    });
    writeU16(dv, 10, advanceWidthMax);
    writeS16(dv, 12, minLSB);
    writeS16(dv, 14, minRSB);
    writeS16(dv, 16, xMaxExtent);
  }
  writeU16(dv, 34, numberOfHMetrics);
  return out;
}

function buildHead(headData, indexToLocFormat, globalBounds) {
  const out = new Uint8Array(headData.length);
  out.set(headData);
  const dv = new DataView(out.buffer);
  writeU32(dv, 8, 0);
  writeU16(dv, 16, 1);
  if (globalBounds) {
    const mergedBounds = {
      xMin: Math.min(dv.getInt16(36, false), globalBounds.xMin),
      yMin: Math.min(dv.getInt16(38, false), globalBounds.yMin),
      xMax: Math.max(dv.getInt16(40, false), globalBounds.xMax),
      yMax: Math.max(dv.getInt16(42, false), globalBounds.yMax)
    };
    writeS16(dv, 36, mergedBounds.xMin);
    writeS16(dv, 38, mergedBounds.yMin);
    writeS16(dv, 40, mergedBounds.xMax);
    writeS16(dv, 42, mergedBounds.yMax);
  }
  writeS16(dv, 50, indexToLocFormat);
  return out;
}

function glyphStats(bytes) {
  if (!bytes || bytes.length < 10) {
    return {
      bounds: null,
      points: 0,
      contours: 0,
      compositePoints: 0,
      compositeContours: 0,
      componentElements: 0,
      componentDepth: 0
    };
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const contours = dv.getInt16(0, false);
  const bounds = {
    xMin: dv.getInt16(2, false),
    yMin: dv.getInt16(4, false),
    xMax: dv.getInt16(6, false),
    yMax: dv.getInt16(8, false)
  };
  if (contours >= 0) {
    let points = 0;
    if (contours > 0 && bytes.length >= 10 + contours * 2) {
      points = readU16(dv, 10 + (contours - 1) * 2) + 1;
    }
    return {
      bounds,
      points,
      contours,
      compositePoints: 0,
      compositeContours: 0,
      componentElements: 0,
      componentDepth: 0
    };
  }

  let componentElements = 0;
  let off = 10;
  while (off + 4 <= bytes.length) {
    const flags = readU16(dv, off);
    componentElements++;
    off += 4;
    off += (flags & 0x0001) ? 4 : 2;
    if (flags & 0x0008) off += 2;
    else if (flags & 0x0040) off += 4;
    else if (flags & 0x0080) off += 8;
    if (!(flags & 0x0020)) {
      if (flags & 0x0100 && off + 2 <= bytes.length) {
        const instructionLength = readU16(dv, off);
        off += 2 + instructionLength;
      }
      break;
    }
  }
  return {
    bounds,
    points: 0,
    contours: 0,
    compositePoints: 0,
    compositeContours: 0,
    componentElements,
    componentDepth: componentElements ? 1 : 0
  };
}

function buildPost(postData) {
  const out = new Uint8Array(32);
  const dv = new DataView(out.buffer);
  writeU32(dv, 0, 0x00030000);
  if (postData && postData.length >= 32) {
    out.set(postData.slice(4, 32), 4);
  }
  return out;
}

function buildNameTable(stem) {
  const family = `${stem}-SFUI`;
  const subfamily = 'Regular';
  const full = family;
  const postscript = sanitizePostScriptName(family);
  const records = [
    { nameID: 1, text: family },
    { nameID: 2, text: subfamily },
    { nameID: 4, text: full },
    { nameID: 6, text: postscript }
  ];
  const encoded = records.map(r => encodeUTF16BE(r.text));
  const count = records.length;
  const stringOffset = 6 + count * 12;
  let totalStrings = 0;
  encoded.forEach(e => { totalStrings += e.length; });
  const out = new Uint8Array(stringOffset + totalStrings);
  const dv = new DataView(out.buffer);
  writeU16(dv, 0, 0);
  writeU16(dv, 2, count);
  writeU16(dv, 4, stringOffset);
  let current = 0;
  records.forEach((record, idx) => {
    const off = 6 + idx * 12;
    writeU16(dv, off, 3);
    writeU16(dv, off + 2, 1);
    writeU16(dv, off + 4, 0x0409);
    writeU16(dv, off + 6, record.nameID);
    writeU16(dv, off + 8, encoded[idx].length);
    writeU16(dv, off + 10, current);
    out.set(encoded[idx], stringOffset + current);
    current += encoded[idx].length;
  });
  return out;
}

function buildCmapFormat4(codepointToGlyphId) {
  const entries = [...codepointToGlyphId.entries()].sort((a, b) => a[0] - b[0]);
  const segCount = entries.length + 1;
  const segCountX2 = segCount * 2;
  let power = 1;
  let entrySelector = 0;
  while (power * 2 <= segCount) {
    power *= 2;
    entrySelector++;
  }
  const searchRange = power * 2;
  const rangeShift = segCountX2 - searchRange;
  const length = 16 + segCount * 8;
  const out = new Uint8Array(length);
  const dv = new DataView(out.buffer);

  writeU16(dv, 0, 4);
  writeU16(dv, 2, length);
  writeU16(dv, 4, 0);
  writeU16(dv, 6, segCountX2);
  writeU16(dv, 8, searchRange);
  writeU16(dv, 10, entrySelector);
  writeU16(dv, 12, rangeShift);

  const endOff = 14;
  const startOff = endOff + segCount * 2 + 2;
  const deltaOff = startOff + segCount * 2;
  const rangeOff = deltaOff + segCount * 2;

  entries.forEach(([cp, gid], i) => {
    writeU16(dv, endOff + i * 2, cp);
    writeU16(dv, startOff + i * 2, cp);
    writeU16(dv, deltaOff + i * 2, (gid - cp + 0x10000) & 0xffff);
    writeU16(dv, rangeOff + i * 2, 0);
  });

  writeU16(dv, endOff + entries.length * 2, 0xffff);
  writeU16(dv, endOff + segCount * 2, 0);
  writeU16(dv, startOff + entries.length * 2, 0xffff);
  writeU16(dv, deltaOff + entries.length * 2, 1);
  writeU16(dv, rangeOff + entries.length * 2, 0);
  return out;
}

function buildCmap(codepointToGlyphId) {
  const subtable = buildCmapFormat4(codepointToGlyphId);
  const out = new Uint8Array(4 + 8 + subtable.length);
  const dv = new DataView(out.buffer);
  writeU16(dv, 0, 0);
  writeU16(dv, 2, 1);
  writeU16(dv, 4, 3);
  writeU16(dv, 6, 1);
  writeU32(dv, 8, 12);
  out.set(subtable, 12);
  return out;
}

function buildSFNT(font) {
  const tables = font.tables.slice().sort((a, b) => a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0);
  const numTables = tables.length;
  let power = 1;
  let entrySelector = 0;
  while (power * 2 <= numTables) {
    power *= 2;
    entrySelector++;
  }
  const searchRange = power * 16;
  const rangeShift = numTables * 16 - searchRange;
  const headerSize = 12 + numTables * 16;
  let offset = headerSize;
  const records = [];
  for (const table of tables) {
    records.push({
      tag: table.tag,
      offset,
      length: table.data.length,
      checksum: calcChecksum(table.data)
    });
    offset += align4(table.data.length);
  }

  const out = new Uint8Array(offset);
  const dv = new DataView(out.buffer);
  writeU32(dv, 0, font.sfVersion);
  writeU16(dv, 4, numTables);
  writeU16(dv, 6, searchRange);
  writeU16(dv, 8, entrySelector);
  writeU16(dv, 10, rangeShift);

  records.forEach((record, idx) => {
    const off = 12 + idx * 16;
    writeTag(dv, off, record.tag);
    writeU32(dv, off + 4, record.checksum);
    writeU32(dv, off + 8, record.offset);
    writeU32(dv, off + 12, record.length);
    out.set(tables[idx].data, record.offset);
  });

  const headRecord = records.find(r => r.tag === 'head');
  if (headRecord) {
    writeU32(dv, headRecord.offset + 8, 0);
    const adjustment = (0xB1B0AFBA - calcChecksum(out)) >>> 0;
    writeU32(dv, headRecord.offset + 8, adjustment);
  }

  return out.buffer;
}

function rebuildSfntWithOffsets(buffer, offsets) {
  const sizeOffset = offsets?.sizeOffset || 0;
  const weightOffset = offsets?.weightOffset || 0;
  const lineHeightOffset = offsets?.lineHeightOffset || 0;
  if (!sizeOffset && !weightOffset && !lineHeightOffset) return buffer;

  const sfnt = parseSFNT(buffer, 0);
  const tables = sfnt.tables.map(t => ({ tag: t.tag, data: sliceTable(buffer, t) }));
  const os2Rec = tables.find(t => t.tag === 'OS/2');
  const updatedTables = tables.map(t => {
    if (t.tag === 'OS/2') {
      let weight = 400;
      let fsType = 0;
      if (os2Rec && os2Rec.data.length >= 10) {
        const dv = new DataView(os2Rec.data.buffer, os2Rec.data.byteOffset, os2Rec.data.byteLength);
        weight = dv.getUint16(4, false);
        fsType = dv.getUint16(8, false);
      }
      return {
        tag: 'OS/2',
        data: modifyOS2(t.data, Math.max(1, weight + weightOffset), fsType, lineHeightOffset)
      };
    }
    if (t.tag === 'hhea') return { tag: 'hhea', data: modifyHhea(t.data, lineHeightOffset) };
    if (t.tag === 'head') return { tag: 'head', data: modifyHead(t.data, sizeOffset) };
    return t;
  });
  return buildSFNT({ sfVersion: sfnt.sfVersion, tables: updatedTables });
}

function extractSfuiFromSource(buffer, stem, referenceBuffer, options = {}) {
  if (!referenceBuffer) throw new Error('缺少参考 SFUI 字库，无法补齐缺失字符。');

  const sourceFont = pickPrimaryFont(buffer);
  const referenceFont = pickPrimaryFont(referenceBuffer);
  if (!sourceFont || !referenceFont) throw new Error('未找到可用字体面。');
  if (referenceFont.sfVersion !== 0x00010000) {
    throw new Error('参考 SFUI 模板必须是 TrueType 轮廓字体。');
  }

  log('info', `  已选中字体面，开始解析上传字体与参考 SFUI...`);
  const sourceTables = makeTableMap(sourceFont);
  const referenceTables = makeTableMap(referenceFont);
  const sourceIsCff = isCffFont(sourceFont);
  const required = sourceIsCff
    ? ['cmap', 'hmtx', 'head']
    : ['cmap', 'glyf', 'loca', 'hmtx', 'maxp', 'head', 'hhea'];
  for (const tag of required) {
    if (!sourceTables.has(tag)) throw new Error(`上传字体缺少必要表: ${tag}`);
  }
  for (const tag of ['cmap', 'glyf', 'loca', 'hmtx', 'maxp', 'head', 'hhea']) {
    if (!referenceTables.has(tag)) throw new Error(`参考 SFUI 缺少必要表: ${tag}`);
  }

  const sourceHead = sourceTables.get('head');
  const sourceCmap = parseUnicodeCmap(sourceTables.get('cmap'));
  const sourceUpm = readU16(new DataView(sourceHead.buffer, sourceHead.byteOffset, sourceHead.byteLength), 18);
  let sourceLocaOffsets = null;
  let sourceMetrics = null;
  let sourceHhea = null;
  let sourceOpenTypeFont = null;
  let sourceGlyphs = null;
  if (sourceIsCff) {
    if (typeof opentype === 'undefined' || typeof opentype.parse !== 'function') {
      throw new Error('缺少 OTF/CFF 解析能力，无法处理当前字体。');
    }
    log('info', '  检测到当前上传字体内部是 CFF/OTTO，已切换到兼容提取通道...');
    sourceOpenTypeFont = opentype.parse(buffer.slice(0));
    sourceGlyphs = sourceOpenTypeFont.glyphs && sourceOpenTypeFont.glyphs.glyphs
      ? sourceOpenTypeFont.glyphs.glyphs
      : sourceOpenTypeFont.glyphs;
  } else {
    const sourceMaxp = sourceTables.get('maxp');
    sourceHhea = sourceTables.get('hhea');
    const sourceNumGlyphs = readU16(new DataView(sourceMaxp.buffer, sourceMaxp.byteOffset, sourceMaxp.byteLength), 4);
    sourceLocaOffsets = parseLoca(
      sourceTables.get('loca'),
      sourceNumGlyphs,
      new DataView(sourceHead.buffer, sourceHead.byteOffset, sourceHead.byteLength).getInt16(50, false)
    );
    sourceMetrics = parseHmtx(
      sourceTables.get('hmtx'),
      sourceNumGlyphs,
      readU16(new DataView(sourceHhea.buffer, sourceHhea.byteOffset, sourceHhea.byteLength), 34)
    );
  }

  const referenceMaxp = referenceTables.get('maxp');
  const referenceHead = referenceTables.get('head');
  const referenceHhea = referenceTables.get('hhea');
  const referenceNumGlyphs = readU16(new DataView(referenceMaxp.buffer, referenceMaxp.byteOffset, referenceMaxp.byteLength), 4);
  const referenceLocaOffsets = parseLoca(
    referenceTables.get('loca'),
    referenceNumGlyphs,
    new DataView(referenceHead.buffer, referenceHead.byteOffset, referenceHead.byteLength).getInt16(50, false)
  );
  const referenceMetrics = parseHmtx(
    referenceTables.get('hmtx'),
    referenceNumGlyphs,
    readU16(new DataView(referenceHhea.buffer, referenceHhea.byteOffset, referenceHhea.byteLength), 34)
  );
  const referenceCmap = parseUnicodeCmap(referenceTables.get('cmap'));
  const referenceUpm = readU16(new DataView(referenceHead.buffer, referenceHead.byteOffset, referenceHead.byteLength), 18);
  const scale = referenceUpm / sourceUpm;

  log('info', `  正在比对字符，并按官方 SFUI 字库编码从上传字体替换同名字符...`);
  const replacements = new Map();
  let replacedChars = 0, flattenedSrc = 0, skippedTemplateComposite = 0;
  for (const [cp, refGlyphId] of referenceCmap.entries()) {
    if (!shouldReplaceFromSource(cp)) continue;
    const sourceGlyphId = sourceCmap.get(cp);
    if (sourceGlyphId == null || sourceGlyphId === 0 || refGlyphId === 0) continue;
    const refRaw = glyphDataSlice(referenceTables.get('glyf'), referenceLocaOffsets, refGlyphId);
    if (isCompositeGlyphBytes(refRaw)) {
      skippedTemplateComposite++;
      continue;
    }
    let encoded = null;
    let metric = null;
    if (sourceIsCff) {
      const glyph = sourceGlyphs && sourceGlyphs.get ? sourceGlyphs.get(sourceGlyphId) : sourceGlyphs[sourceGlyphId];
      encoded = buildGlyphFromOpenTypeGlyph(glyph, sourceUpm, scale);
      if (glyph) {
        metric = [
          scaleMetricValue(glyph.advanceWidth || 0, scale),
          scaleMetricValue(typeof glyph.leftSideBearing === 'number' ? glyph.leftSideBearing : 0, scale)
        ];
      }
    } else {
      const raw = glyphDataSlice(sourceTables.get('glyf'), sourceLocaOffsets, sourceGlyphId);
      if (!raw || raw.length === 0) continue;
      const parsed = flattenGlyph(sourceTables.get('glyf'), sourceLocaOffsets, sourceGlyphId);
      if (!parsed) continue;
      encoded = encodeSimpleGlyphFromParsed(parsed, scale);
      const [adv, lsb] = sourceMetrics[sourceGlyphId];
      metric = [scaleMetricValue(adv, scale), scaleMetricValue(lsb, scale)];
      if (raw.length >= 10 && new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getInt16(0, false) < 0) flattenedSrc++;
    }
    if (!encoded || encoded.length === 0) continue;
    replacements.set(refGlyphId, {
      glyph: encoded,
      metric: metric || [0, 0]
    });
    replacedChars++;
  }

  log('info', `  命中 ${replacedChars} 个字符 (含 ${flattenedSrc} 个源复合字形展开)，跳过 ${skippedTemplateComposite} 个模板复合字形。`);

  const totalGlyphs = referenceNumGlyphs;
  const newLoca = [0];
  const glyfChunks = [];
  const mergedMetrics = [];
  const glyphBounds = [];
  let globalBounds = null;
  const maxpStats = {
    maxPoints: 0,
    maxContours: 0,
    maxCompositePoints: 0,
    maxCompositeContours: 0,
    maxComponentElements: 0,
    maxComponentDepth: 0
  };
  log('info', `  开始重建完整 SFUI 结构 (${totalGlyphs} 个 glyph)...`);
  for (let glyphId = 0; glyphId < referenceNumGlyphs; glyphId++) {
    const replacement = replacements.get(glyphId);
    const chunk = replacement
      ? replacement.glyph
      : glyphDataSlice(referenceTables.get('glyf'), referenceLocaOffsets, glyphId);
    glyfChunks.push(chunk);
    mergedMetrics.push(replacement ? replacement.metric : referenceMetrics[glyphId]);
    const stats = glyphStats(chunk);
    glyphBounds.push(stats.bounds);
    if (stats.bounds) {
      if (!globalBounds) globalBounds = { ...stats.bounds };
      else {
        if (stats.bounds.xMin < globalBounds.xMin) globalBounds.xMin = stats.bounds.xMin;
        if (stats.bounds.yMin < globalBounds.yMin) globalBounds.yMin = stats.bounds.yMin;
        if (stats.bounds.xMax > globalBounds.xMax) globalBounds.xMax = stats.bounds.xMax;
        if (stats.bounds.yMax > globalBounds.yMax) globalBounds.yMax = stats.bounds.yMax;
      }
    }
    if (stats.points > maxpStats.maxPoints) maxpStats.maxPoints = stats.points;
    if (stats.contours > maxpStats.maxContours) maxpStats.maxContours = stats.contours;
    if (stats.compositePoints > maxpStats.maxCompositePoints) maxpStats.maxCompositePoints = stats.compositePoints;
    if (stats.compositeContours > maxpStats.maxCompositeContours) maxpStats.maxCompositeContours = stats.compositeContours;
    if (stats.componentElements > maxpStats.maxComponentElements) maxpStats.maxComponentElements = stats.componentElements;
    if (stats.componentDepth > maxpStats.maxComponentDepth) maxpStats.maxComponentDepth = stats.componentDepth;
    newLoca.push(newLoca[newLoca.length - 1] + chunk.length);
  }

  const glyfData = new Uint8Array(newLoca[newLoca.length - 1]);
  let cursor = 0;
  glyfChunks.forEach(chunk => {
    glyfData.set(chunk, cursor);
    cursor += chunk.length;
  });

  const rebuiltHmtx = buildHmtxFromMetrics(mergedMetrics);
  const rebuiltTables = [
    { tag: 'cmap', data: referenceTables.get('cmap') },
    { tag: 'glyf', data: glyfData },
    { tag: 'head', data: buildHead(referenceHead, 1, globalBounds) },
    { tag: 'hhea', data: buildHhea(referenceHhea, rebuiltHmtx.numberOfHMetrics, mergedMetrics, glyphBounds) },
    { tag: 'hmtx', data: rebuiltHmtx.data },
    { tag: 'loca', data: buildLoca(newLoca) },
    { tag: 'maxp', data: buildMaxpWithStats(referenceMaxp, totalGlyphs, maxpStats) },
    { tag: 'name', data: referenceTables.get('name') || buildNameTable(stem) },
    { tag: 'post', data: referenceTables.get('post') || buildPost(referenceTables.get('post')) }
  ];

  ['OS/2', 'fvar', 'gasp', 'cvt ', 'fpgm', 'prep'].forEach(tag => {
    if (referenceTables.has(tag)) rebuiltTables.push({ tag, data: referenceTables.get(tag) });
  });

  log('info', `  正在封装 ${stem}-SFUI.ttf ...`);
  const sfntBuffer = buildSFNT({
    sfVersion: referenceFont.sfVersion,
    tables: rebuiltTables
  });
  return rebuildSfntWithOffsets(sfntBuffer, options.offsets);
}

function buildTTC(fonts) {
  const pool = [];
  const refMap = new Map();

  function getPoolIdx(data) {
    if (refMap.has(data)) return refMap.get(data);
    const idx = pool.length;
    pool.push(data);
    refMap.set(data, idx);
    return idx;
  }

  const fontRefs = fonts.map(f => ({
    sfVersion: f.sfVersion,
    tables: f.tables.map(t => ({
      tag: t.tag, poolIdx: getPoolIdx(t.data), length: t.data.length,
    })).sort((a, b) => a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0),
  }));

  const numFonts = fonts.length;
  const ttcHdrSize = 12 + 4 * numFonts;
  let off = ttcHdrSize;
  const dirOffsets = [];
  for (const fr of fontRefs) {
    dirOffsets.push(off);
    off += 12 + 16 * fr.tables.length;
  }
  off = align4(off);
  const poolOffsets = [];
  for (const d of pool) {
    poolOffsets.push(off);
    off += align4(d.length);
  }
  const totalSize = off;

  const result = new ArrayBuffer(totalSize);
  const dv = new DataView(result);
  const bytes = new Uint8Array(result);

  writeTag(dv, 0, 'ttcf');
  writeU16(dv, 4, 2);
  writeU16(dv, 6, 0);
  writeU32(dv, 8, numFonts);
  for (let i = 0; i < numFonts; i++) writeU32(dv, 12 + i * 4, dirOffsets[i]);

  const poolChecksums = pool.map(d => calcChecksum(d));

  for (let fi = 0; fi < numFonts; fi++) {
    const fr = fontRefs[fi];
    const o = dirOffsets[fi];
    const nt = fr.tables.length;
    writeU32(dv, o, fr.sfVersion);
    writeU16(dv, o + 4, nt);
    let p2 = 1, lg = 0;
    while (p2 * 2 <= nt) { p2 *= 2; lg++; }
    writeU16(dv, o + 6, p2 * 16);
    writeU16(dv, o + 8, lg);
    writeU16(dv, o + 10, nt * 16 - p2 * 16);
    for (let ti = 0; ti < nt; ti++) {
      const t = fr.tables[ti];
      const r = o + 12 + ti * 16;
      writeTag(dv, r, t.tag);
      writeU32(dv, r + 4, poolChecksums[t.poolIdx]);
      writeU32(dv, r + 8, poolOffsets[t.poolIdx]);
      writeU32(dv, r + 12, t.length);
    }
  }

  for (let i = 0; i < pool.length; i++) bytes.set(pool[i], poolOffsets[i]);
  return result;
}

function convertOne(sources, mode, offsets) {
  log('info', `  映射配置: ${mode}, 开始组装数据结构...`);
  const fonts = [];
  const os2Cache = new Map();
  const hheaCache = new Map();
  const headCache = new Map();
  const wOff = offsets?.weightOffset || 0;
  const sOff = offsets?.sizeOffset || 0;
  const lOff = offsets?.lineHeightOffset || 0;
  for (let i = 0; i < TEMPLATES.length; i++) {
    const tpl = TEMPLATES[i];
    const nameData = base64ToUint8Array(tpl.nameB64);
    const src = pickSource(sources, tpl.subfamily.toLowerCase(), mode);
    const srcId = src.tables.length ? calcChecksum(src.tables[0].data) : i;
    const tables = [];
    for (const t of src.tables) {
      if (t.tag === 'name') {
        tables.push({ tag: 'name', data: nameData });
      } else if (t.tag === 'OS/2') {
        const key = `${srcId}:${tpl.weightClass + wOff}:${tpl.fsType}:${lOff}`;
        if (!os2Cache.has(key)) {
          os2Cache.set(key, modifyOS2(t.data, Math.max(1, tpl.weightClass + wOff), tpl.fsType, lOff));
        }
        tables.push({ tag: 'OS/2', data: os2Cache.get(key) });
      } else if (t.tag === 'hhea' && lOff) {
        const key = `${srcId}:hhea:${lOff}`;
        if (!hheaCache.has(key)) hheaCache.set(key, modifyHhea(t.data, lOff));
        tables.push({ tag: 'hhea', data: hheaCache.get(key) });
      } else if (t.tag === 'head' && sOff) {
        const key = `${srcId}:head:${sOff}`;
        if (!headCache.has(key)) headCache.set(key, modifyHead(t.data, sOff));
        tables.push({ tag: 'head', data: headCache.get(key) });
      } else {
        tables.push({ tag: t.tag, data: t.data });
      }
    }
    if (!src.tables.some(t => t.tag === 'name')) {
      tables.push({ tag: 'name', data: nameData });
    }
    fonts.push({ sfVersion: src.sfVersion, tables });
    if ((i + 1) % 50 === 0) log('info', `  构建变体进度: ${Math.floor((i + 1) / TEMPLATES.length * 100)}% ...`);
  }
  log('info', `  执行二进制打包 (引用级查重优化)...`);
  return buildTTC(fonts);
}

function convertToTTFs(sources, offsets) {
  const outputs = [];
  const seen = new Set();
  const uniqueSrcs = [];
  for (const [key, src] of sources) {
    if (!seen.has(src)) {
      seen.add(src);
      uniqueSrcs.push({ key, src });
    }
  }
  const wOff = offsets?.weightOffset || 0;
  const sOff = offsets?.sizeOffset || 0;
  const lOff = offsets?.lineHeightOffset || 0;
  for (let i = 0; i < uniqueSrcs.length; i++) {
    const { key, src } = uniqueSrcs[i];
    const tables = src.tables.map(t => {
      if (t.tag === 'OS/2') {
        const od = new DataView(t.data.buffer, t.data.byteOffset, t.data.byteLength);
        const ow = od.getUint16(4, false);
        const of2 = od.getUint16(8, false);
        return { tag: 'OS/2', data: modifyOS2(t.data, Math.max(1, ow + wOff), of2, lOff) };
      }
      if (t.tag === 'hhea') return { tag: 'hhea', data: modifyHhea(t.data, lOff) };
      if (t.tag === 'head' && sOff) return { tag: 'head', data: modifyHead(t.data, sOff) };
      return t;
    });
    outputs.push({
      key,
      buffer: buildSFNT({ sfVersion: src.sfVersion, tables })
    });
  }
  return outputs;
}

function applyTemplate(tpl, fontName) {
  return (tpl || '${fontName}UI').replace(/\$\{fontName\}/g, fontName);
}

self.onmessage = function(e) {
  const { type } = e.data;
  if (type === 'convert') {
    try {
      const { srcFiles, mode, compatLayer, outputFormat, outputTemplate, offsets } = e.data;
      const isLegacy = compatLayer === 'ios9';
      const isTTF = outputFormat === 'ttf';
      const fams = new Set();
      for (const t of TEMPLATES) fams.add(t.family);
      log('info', `环境就绪: 支持 iOS 18 协议, 覆盖 ${fams.size} 个字体族`);
      log('info', `更多设置: 兼容层=${isLegacy ? 'iOS 9-17' : 'iOS 18-26'}，输出=${isTTF ? 'TTF' : 'TTC'}`);

      const total = srcFiles.length;
      for (let si = 0; si < total; si++) {
        const { name, buffer } = srcFiles[si];
        const safeName = desensitize(name);
        log('step', `[${si + 1}/${total}] 正在处理: ${safeName}`);

        const sources = loadSource(buffer);
        log('info', `  检测到字重: ${[...sources.keys()].join(', ')}`);
        const stem = name.replace(/\.[^.]+$/, '');
        const outStem = applyTemplate(outputTemplate, stem);
        const firstSrc = sources.values().next().value;
        if (firstSrc && si === 0) {
          self.postMessage({ type: 'fontMetrics', metrics: readFontMetrics(firstSrc.tables) });
        }

        if (isTTF) {
          const outputs = convertToTTFs(sources, offsets);
          log('info', `  正在拆分独立 TTF (${outputs.length} 个)...`);
          for (let oi = 0; oi < outputs.length; oi++) {
            const item = outputs[oi];
            const suffix = outputs.length > 1 ? `_${item.key}` : '';
            const outName = `${outStem}${suffix}.ttf`;
            const sizeMB = (item.buffer.byteLength / 1048576).toFixed(1);
            log('ok', `  输出成功: ${desensitize(outName)} (${sizeMB} MB)`);
            self.postMessage({ type: 'result', name: outName, buffer: item.buffer }, [item.buffer]);
          }
        } else {
          const result = convertOne(sources, mode, offsets);
          const outName = `${outStem}.ttc`;
          const sizeMB = (result.byteLength / 1048576).toFixed(1);
          log('ok', `  封装成功: ${desensitize(outName)} (${sizeMB} MB)`);
          self.postMessage({ type: 'result', name: outName, buffer: result }, [result]);
        }
        self.postMessage({ type: 'progress', current: si + 1, total });
      }

      log('ok', `全部完成: ${total} 个字体已转换`);
      self.postMessage({ type: 'done' });
    } catch (err) {
      log('err', `错误: ${err.message}`);
      self.postMessage({ type: 'error', message: err.message });
    }
  } else if (type === 'extract-sfui') {
    try {
      const { srcFiles, outputTemplate, offsets } = e.data;
      const referenceBuffer = getEmbeddedSfuiTemplateBuffer();
      const total = srcFiles.length;
      log('info', `环境就绪: 准备生成完整 SFUI（提取 + 补齐）`);
      for (let si = 0; si < total; si++) {
        const { name, buffer } = srcFiles[si];
        const safeName = desensitize(name);
        log('step', `[${si + 1}/${total}] 正在生成: ${safeName}`);
        const stem = name.replace(/\.[^.]+$/, '');
        const result = extractSfuiFromSource(buffer, stem, referenceBuffer, { offsets });
        const outStem = applyTemplate(outputTemplate || '${fontName}-SFUI', stem);
        const outName = `${outStem}.ttf`;
        const sizeMB = (result.byteLength / 1048576).toFixed(2);
        log('ok', `  生成成功: ${desensitize(outName)} (${sizeMB} MB)`);
        self.postMessage({ type: 'result', name: outName, buffer: result }, [result]);
        self.postMessage({ type: 'progress', current: si + 1, total });
      }
      log('ok', `全部完成: ${total} 个完整 SFUI 已生成`);
      self.postMessage({ type: 'done' });
    } catch (err) {
      log('err', `错误: ${err.message}`);
      self.postMessage({ type: 'error', message: err.message });
    }
  }
};

function log(level, text) {
  self.postMessage({ type: 'log', level, text });
}

function desensitize(name) {
  const parts = name.split(/[/\\]/);
  return parts[parts.length - 1];
}
