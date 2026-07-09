// @ts-nocheck -- vendored third-party; not type-checked
/**
 * Depth-peeling material patcher.
 *
 * Adapted from gkjohnson/three-depthpeeling-demo (DepthPeelMaterialMixin in
 * index.js) — MIT, Copyright (c) 2025 Garrett Johnson. This is an ADAPTATION,
 * not a verbatim copy; see README.md in this directory for the divergences.
 *
 * DepthPeelUtils.patch(material) retrofits an existing material instance with
 * the peel discard prologue (the upstream demo wraps material CLASSES via a
 * mixin, which cannot be applied to already-configured instances). The pass
 * (DepthPeelPass.js) drives the per-peel state through the uniforms stored at
 * material.userData.depthPeel.
 */

import { Vector2 } from '../three/three.module.js';

let _materialCounter = 0;

class DepthPeelUtils {

	static patch( existingMaterial ) {

		const materials = Array.isArray( existingMaterial ) ? existingMaterial : [ existingMaterial ];

		for ( let i = 0; i < materials.length; i ++ ) {

			const material = materials[ i ];
			if ( ! material.isMaterial ) continue;
			if ( material.depthPeelEnabled ) continue;

			// Classification flag for DepthPeelPass.gatherMeshes — set
			// immediately (not lazily at compile time).
			material.depthPeelEnabled = true;

			// LOCAL ADAPTATION: uniform-driven branching instead of the demo's
			// `#define DEPTH_PEELING` / `#define FIRST_PASS`, which force a
			// program rebuild on every peel-state change and require replacing
			// customProgramCacheKey (colliding with other shader patches, e.g.
			// the WBOIT pipeline's). One program serves all peel states.
			const uniforms = {
				uPeelEnabled: { value: 0 },
				uFirstPass: { value: 1 },
				nearDepth: { value: null },
				opaqueDepth: { value: null },
				resolution: { value: new Vector2() },
			};
			material.userData.depthPeel = uniforms;

			const existingOnBeforeCompile = material.onBeforeCompile;

			material.onBeforeCompile = function ( shader, renderer ) {

				// Chain any prior patch and run on EVERY compile so a program
				// rebuild never drops the app's own shader injections.
				if ( typeof existingOnBeforeCompile === 'function' ) existingOnBeforeCompile( shader, renderer );

				Object.assign( shader.uniforms, uniforms );

				shader.fragmentShader = /* glsl */`
					uniform int uPeelEnabled;
					uniform int uFirstPass;
					uniform sampler2D nearDepth;
					uniform sampler2D opaqueDepth;
					uniform vec2 resolution;
				` + shader.fragmentShader;

				// The demo's discard prologue, gated by uniforms (nested ifs —
				// GLSL need not short-circuit, and nearDepth is null on the
				// first peel).
				shader.fragmentShader = shader.fragmentShader.replace( 'void main() {', /* glsl */`
					void main() {

						if ( uPeelEnabled == 1 ) {

							vec2 dpScreenUV = gl_FragCoord.xy / resolution;

							if ( texture2D( opaqueDepth, dpScreenUV ).r < gl_FragCoord.z ) {

								discard;

							}

							if ( uFirstPass == 0 ) {

								if ( texture2D( nearDepth, dpScreenUV ).r >= gl_FragCoord.z - 1e-6 ) {

									discard;

								}

							}

						}
				` );

			};

			// Compose (don't replace) the program cache key: patched materials
			// share the wrapper function text, so without a per-material marker
			// materials with different chained injections would collide on the
			// same program.
			const materialID = _materialCounter;
			_materialCounter ++;
			const previousCacheKey = material.customProgramCacheKey
				? material.customProgramCacheKey.bind( material )
				: null;
			material.customProgramCacheKey = function () {

				return ( previousCacheKey ? previousCacheKey() : '' ) + '|dp' + materialID;

			};

			material.needsUpdate = true;

		}

	}

}

export { DepthPeelUtils };
