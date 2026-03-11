function updatePolyhedra() {
  disposeGroup(polyhedraGroup);
  polyhedraGroup = new THREE.Group();

  if (!showPolyhedra) return;

  // --- 1) Wrap positions (same as in your bonds) ---
  const wrapped = periodicWrapped(structureData.positions, structureData.elements);
  const wrappedCart = fracToCart(wrapped.frac, structureData.lattice); // [[x,y,z], ...]

  // Prepare vector and metadata arrays
  const centers = wrappedCart.map(p => new THREE.Vector3(p[0], p[1], p[2]));
  const elems   = wrapped.elements;        // element symbol per wrapped atom
  const srcIdx  = wrapped.srcIndex;        // original atom index per wrapped atom

  // --- 2) Lattice vectors + max cutoff (same as in your bonds) ---
  const L = structureData.lattice;
  const a = new THREE.Vector3(L[0][0], L[0][1], L[0][2]);
  const b = new THREE.Vector3(L[1][0], L[1][1], L[1][2]);
  const c = new THREE.Vector3(L[2][0], L[2][1], L[2][2]);

  const maxCutoff = Math.max(0.0, ...Object.values(bondLengths || { dummy: 0.0 }));
  const ax = Math.max(1, Math.min(2, Math.ceil(maxCutoff / Math.max(a.length(), 1e-6))));
  const by = Math.max(1, Math.min(2, Math.ceil(maxCutoff / Math.max(b.length(), 1e-6))));
  const cz = Math.max(1, Math.min(2, Math.ceil(maxCutoff / Math.max(c.length(), 1e-6))));

  const shifts = [];
  for (let dx = -ax; dx <= ax; dx++)
    for (let dy = -by; dy <= by; dy++)
      for (let dz = -cz; dz <= cz; dz++)
        shifts.push([dx, dy, dz]);

  // --- 3) Build one polyhedron per primary center ---
  // We treat *every wrapped* atom as a center; if you only want primaries, filter here.
  const sharedEdgeMat = new THREE.LineBasicMaterial({
    color: polyStyle.edgeColor,
    transparent: true,
    opacity: Math.min(1, (polyStyle.opacity ?? 0.28) + 0.35),
  });

  for (let i = 0; i < centers.length; i++) {
    const center = centers[i];
    const ei = elems[i];
    const centerSrcIndex = srcIdx[i];

    // Collect nearest-image neighbor candidates by original source index.
    // nearestBySrc: srcJ -> { pos: Vector3, d: number, shift: [dx,dy,dz], ej }
    const nearestBySrc = new Map();

    for (let j = 0; j < centers.length; j++) {
      if (j === i) continue;

      const ej = elems[j];
      const cutoff = getBondCutoff(ei, ej);
      if (cutoff <= 0.01) continue;

      const pj = centers[j];
      const srcJ = srcIdx[j];

      for (const [dx, dy, dz] of shifts) {
        const shiftVec = new THREE.Vector3()
          .addScaledVector(a, dx)
          .addScaledVector(b, dy)
          .addScaledVector(c, dz);
        const candidate = pj.clone().add(shiftVec);
        const d = center.distanceTo(candidate);
        if (d > cutoff || d < 1e-4) continue;

        const existing = nearestBySrc.get(srcJ);
        if (!existing || d < existing.d - 1e-6) {
          nearestBySrc.set(srcJ, { pos: candidate, d, shift: [dx, dy, dz], ej });
        }
      }
    }

    // We need at least 3 non-collinear points for a polyhedron; 4+ is typical
    const neighbors = Array.from(nearestBySrc.values()).map(o => o.pos);
    if (!neighbors || neighbors.length < 3) continue;

    // --- 4) Make convex hull of neighbors ---
    let geom;
    try {
      geom = new ConvexGeometry(neighbors);
    } catch (e) {
      // Rare numerical/degenerate cases: skip
      continue;
    }
    geom.computeVertexNormals();

    // Color (you can replace this with your element color palette)
    const faceColor = (typeof getElementColor === 'function')
      ? getElementColor(ei)  // your palette hook, if available
      : (polyStyle.faceColor ?? 0x00aaff);

    const mat = new THREE.MeshStandardMaterial({
      color: faceColor,
      transparent: (polyStyle.opacity ?? 0.28) < 1.0,
      opacity: polyStyle.opacity ?? 0.28,
      metalness: polyStyle.metalness ?? 0.0,
      roughness: polyStyle.roughness ?? 1.0,
      side: (polyStyle.doubleSide ? THREE.DoubleSide : THREE.FrontSide),
      depthWrite: polyStyle.depthWrite ?? false,
      polygonOffset: polyStyle.polygonOffset ?? true,
      polygonOffsetFactor: polyStyle.polygonOffsetFactor ?? 1,
      polygonOffsetUnits: polyStyle.polygonOffsetUnits ?? 1,
    });

    const mesh = new THREE.Mesh(geom, mat);
    mesh.userData = {
      type: 'polyhedron',
      centerSrcIndex,
      centerElement: ei,
      neighborCount: neighbors.length,
    };

    // Edges overlay for crisp wireframe
    const edgeGeom = new THREE.EdgesGeometry(geom, polyStyle.edgeAngle ?? 18);
    const edgeLines = new THREE.LineSegments(edgeGeom, sharedEdgeMat);
    mesh.add(edgeLines);

    polyhedraGroup.add(mesh);

    // --- 5) OPTIONAL: replicate across periodic boundaries like "symmetric ghost" ---
    // This duplicates the polyhedron when its neighbor set uses non-zero shifts,
    // so you also see the counterpart on the opposite side. Off by default.
    if (polyStyle.replicateGhosts) {
      // Unique non-zero shifts used by chosen neighbors
      const usedShifts = new Set(
        Array.from(nearestBySrc.values())
             .map(o => o.shift.join(','))
             .filter(s => s !== '0,0,0')
      );

      for (const s of usedShifts) {
        const [dx, dy, dz] = s.split(',').map(Number);
        const shiftVec = new THREE.Vector3()
          .addScaledVector(a, -dx)     // mirror like your bonds symmetric ghost
          .addScaledVector(b, -dy)
          .addScaledVector(c, -dz);

        // Build mirrored neighbor positions
        const mirrored = Array.from(nearestBySrc.values()).map(o =>
          o.pos.clone().add(shiftVec)
        );
        if (mirrored.length < 3) continue;

        let g2;
        try { g2 = new ConvexGeometry(mirrored); } catch (_) { continue; }
        g2.computeVertexNormals();

        const m2 = new THREE.Mesh(g2, mat.clone());
        const e2 = new THREE.LineSegments(new THREE.EdgesGeometry(g2, polyStyle.edgeAngle ?? 18), sharedEdgeMat);
        m2.add(e2);
        m2.userData = { ...mesh.userData, replicatedFromShift: [dx, dy, dz] };
        polyhedraGroup.add(m2);
      }
    }
  }

  scene.add(polyhedraGroup);
}
