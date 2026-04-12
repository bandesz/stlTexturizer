import { zipSync, strToU8 } from 'fflate';

/**
 * Trigger a browser download for a binary buffer.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {string} filename
 * @param {string} [mime]
 */
function triggerDownload(buffer, filename, mime = 'application/octet-stream') {
  const blob = new Blob([buffer], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * Fast binary STL exporter — writes directly from BufferGeometry arrays.
 *
 * Eliminates Three.js STLExporter overhead:
 * - No Mesh/Material creation
 * - No identity matrix multiplication per vertex
 * - No redundant normal recomputation
 * - Bulk Uint8Array.set() instead of per-float DataView calls
 *
 * @param {THREE.BufferGeometry} geometry  – non-indexed with position + normal
 * @param {string} [filename]
 */
export function exportSTL(geometry, filename = 'textured.stl') {
  const posArr = geometry.attributes.position.array;
  const norArr = geometry.attributes.normal
    ? geometry.attributes.normal.array
    : null;
  const triCount = (posArr.length / 9) | 0;

  // Binary STL: 80-byte header + 4-byte tri count + 50 bytes per triangle
  const bufLen = 84 + 50 * triCount;
  const buffer = new ArrayBuffer(bufLen);
  const bytes  = new Uint8Array(buffer);
  const view   = new DataView(buffer);

  // Header: 80 bytes (already zero-filled)
  view.setUint32(80, triCount, true);

  // Reinterpret source arrays as raw bytes for bulk copy
  const posSrc = new Uint8Array(posArr.buffer, posArr.byteOffset, posArr.byteLength);
  const norSrc = norArr
    ? new Uint8Array(norArr.buffer, norArr.byteOffset, norArr.byteLength)
    : null;

  for (let i = 0; i < triCount; i++) {
    const dst    = 84 + i * 50;
    const srcOff = i * 36; // 9 floats * 4 bytes

    if (norSrc) {
      // Normal: copy first vertex normal (12 bytes) — flat shading, all 3 identical
      bytes.set(norSrc.subarray(srcOff, srcOff + 12), dst);
    } else {
      // Compute face normal from cross product
      const b = i * 9;
      const ux = posArr[b+3]-posArr[b], uy = posArr[b+4]-posArr[b+1], uz = posArr[b+5]-posArr[b+2];
      const vx = posArr[b+6]-posArr[b], vy = posArr[b+7]-posArr[b+1], vz = posArr[b+8]-posArr[b+2];
      const nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
      const len = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
      view.setFloat32(dst,     nx/len, true);
      view.setFloat32(dst + 4, ny/len, true);
      view.setFloat32(dst + 8, nz/len, true);
    }

    // Vertices: 36 bytes (3 vertices * 3 floats * 4 bytes)
    bytes.set(posSrc.subarray(srcOff, srcOff + 36), dst + 12);

    // Attribute byte count: 0 (already zero-filled)
  }

  triggerDownload(buffer, filename);
}

// Trim trailing zeros from a fixed-4-decimal number string.
const fmt = (n) => {
  let s = n.toFixed(4);
  if (s.indexOf('.') !== -1) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
};

// Escape special XML characters in an attribute value or text node.
function xmlEscape(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Deduplicates vertices of a non-indexed geometry and returns
 * { uniqueXYZ: number[], triIdx: Uint32Array }.
 */
function deduplicateGeometry(geometry) {
  const posArr   = geometry.attributes.position.array;
  const triCount = (posArr.length / 9) | 0;
  const indexMap  = new Map();
  const uniqueXYZ = [];
  const triIdx    = new Uint32Array(triCount * 3);
  for (let i = 0; i < triCount; i++) {
    for (let j = 0; j < 3; j++) {
      const b = i * 9 + j * 3;
      const x = posArr[b], y = posArr[b + 1], z = posArr[b + 2];
      const key = x.toFixed(4) + ',' + y.toFixed(4) + ',' + z.toFixed(4);
      let idx = indexMap.get(key);
      if (idx === undefined) {
        idx = uniqueXYZ.length / 3;
        uniqueXYZ.push(x, y, z);
        indexMap.set(key, idx);
      }
      triIdx[i * 3 + j] = idx;
    }
  }
  return { uniqueXYZ, triIdx, triCount };
}

/**
 * 3MF exporter — builds a ZIP-packaged XML mesh in the Microsoft 3D
 * Manufacturing core format (2015/02).
 *
 * Vertices are deduplicated (positions quantized to 4 decimals, i.e. 0.0001 mm
 * tolerance) so the output is both smaller than binary STL and round-trippable
 * by this project's own 3MF loader.
 *
 * @param {THREE.BufferGeometry} geometry  – non-indexed with position attribute
 * @param {string} [filename]
 */
export function export3MF(geometry, filename = 'textured.3mf') {
  const { uniqueXYZ, triIdx, triCount } = deduplicateGeometry(geometry);
  const vertCount = uniqueXYZ.length / 3;

  // ── Build 3dmodel.model XML ──────────────────────────────────────────────
  // Stream into an array of string chunks then join once — much faster than
  // repeated concatenation for large meshes.
  const chunks = [];
  chunks.push(
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    '<model unit="millimeter" xml:lang="en-US" ',
    'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n',
    '<resources>\n',
    '<object id="1" type="model">\n',
    '<mesh>\n',
    '<vertices>\n'
  );

  for (let i = 0; i < vertCount; i++) {
    const b = i * 3;
    chunks.push(
      '<vertex x="', fmt(uniqueXYZ[b]),
      '" y="', fmt(uniqueXYZ[b + 1]),
      '" z="', fmt(uniqueXYZ[b + 2]),
      '"/>\n'
    );
  }

  chunks.push('</vertices>\n<triangles>\n');

  for (let i = 0; i < triCount; i++) {
    const b = i * 3;
    chunks.push(
      '<triangle v1="', triIdx[b],
      '" v2="', triIdx[b + 1],
      '" v3="', triIdx[b + 2],
      '"/>\n'
    );
  }

  chunks.push(
    '</triangles>\n',
    '</mesh>\n',
    '</object>\n',
    '</resources>\n',
    '<build>\n<item objectid="1"/>\n</build>\n',
    '</model>\n'
  );

  const modelXml = chunks.join('');

  // ── Static package files ─────────────────────────────────────────────────
  const contentTypesXml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n' +
    '</Types>\n';

  const relsXml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
    '<Relationship Id="rel-1" Target="/3D/3dmodel.model" ' +
    'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n' +
    '</Relationships>\n';

  // ── Zip and download ─────────────────────────────────────────────────────
  const zipped = zipSync({
    '[Content_Types].xml': strToU8(contentTypesXml),
    '_rels/.rels':         strToU8(relsXml),
    '3D/3dmodel.model':    strToU8(modelXml),
  }, { level: 6 });

  triggerDownload(
    zipped,
    filename,
    'application/vnd.ms-package.3dmanufacturing-3dmodel+xml'
  );
}

/**
 * Multi-part 3MF exporter — writes one <object> per part so the geometry
 * bodies remain separate in downstream slicers.
 *
 * @param {Array<{ geometry: THREE.BufferGeometry, name: string }>} parts
 * @param {string} [filename]
 */
export function export3MFMultiPart(parts, filename = 'textured.3mf') {
  const chunks = [];
  chunks.push(
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    '<model unit="millimeter" xml:lang="en-US" ',
    'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n',
    '<resources>\n'
  );

  const objectIds = [];
  for (let p = 0; p < parts.length; p++) {
    const { geometry, name } = parts[p];
    const id = p + 1;
    objectIds.push(id);

    const { uniqueXYZ, triIdx, triCount } = deduplicateGeometry(geometry);
    const vertCount = uniqueXYZ.length / 3;

    chunks.push(
      '<object id="', id, '" name="', xmlEscape(name), '" type="model">\n',
      '<mesh>\n',
      '<vertices>\n'
    );

    for (let i = 0; i < vertCount; i++) {
      const b = i * 3;
      chunks.push(
        '<vertex x="', fmt(uniqueXYZ[b]),
        '" y="', fmt(uniqueXYZ[b + 1]),
        '" z="', fmt(uniqueXYZ[b + 2]),
        '"/>\n'
      );
    }

    chunks.push('</vertices>\n<triangles>\n');

    for (let i = 0; i < triCount; i++) {
      const b = i * 3;
      chunks.push(
        '<triangle v1="', triIdx[b],
        '" v2="', triIdx[b + 1],
        '" v3="', triIdx[b + 2],
        '"/>\n'
      );
    }

    chunks.push('</triangles>\n</mesh>\n</object>\n');
  }

  chunks.push('</resources>\n<build>\n');
  for (const id of objectIds) {
    chunks.push('<item objectid="', id, '"/>\n');
  }
  chunks.push('</build>\n</model>\n');

  const modelXml = chunks.join('');

  const contentTypesXml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n' +
    '</Types>\n';

  const relsXml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
    '<Relationship Id="rel-1" Target="/3D/3dmodel.model" ' +
    'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n' +
    '</Relationships>\n';

  const zipped = zipSync({
    '[Content_Types].xml': strToU8(contentTypesXml),
    '_rels/.rels':         strToU8(relsXml),
    '3D/3dmodel.model':    strToU8(modelXml),
  }, { level: 6 });

  triggerDownload(
    zipped,
    filename,
    'application/vnd.ms-package.3dmanufacturing-3dmodel+xml'
  );
}
