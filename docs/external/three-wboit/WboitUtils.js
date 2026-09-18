// @ts-nocheck -- vendored third-party; not type-checked
/**
 * Helper utilities for WboitPass
 */

import { WboitStages } from './materials/MeshWboitMaterial.js';

let _materialCounter = 0;
const _stage = { value: 0.5 };

// LOCAL MODIFICATION (CrysViz): textures the accumulation stage reads back
// (both rendered earlier in the same WboitPass.render): the revealage buffer
// (r = product of (1 - alpha) over every transparent fragment of the pixel)
// and the depth-range buffer (r = 1 - nearest, a = farthest transparent
// fragment depth). Shared uniform objects, bound into every patched shader — the pass
// assigns .value once per frame.
const _revealage = { value: null };
const _depthRange = { value: null };

class WboitUtils {

	static patch( existingMaterial ) {

		let materials = Array.isArray( existingMaterial ) ? existingMaterial : [ existingMaterial ];

		for ( let i = 0; i < materials.length; i ++ ) {

			const material = materials[i];
			if ( ! material.isMaterial ) continue;
			if ( material.wboitEnabled ) continue;

			// LOCAL MODIFICATION (CrysViz): mark the material immediately (upstream
			// set this lazily inside onBeforeCompile, so WboitPass misclassified the
			// mesh until the first shader compile).
			material.wboitEnabled = true;

			// LOCAL MODIFICATION (CrysViz): define the renderStage property
			// immediately too. Upstream defined it inside onBeforeCompile, so on
			// the FIRST frame after patching, WboitPass.prepareWboitBlending
			// could not set the stage: the accumulation pass then rendered with
			// the stage uniform at its 0.5 default — plain colors under additive
			// blending — producing one garbage frame (visible on always-
			// transparent content like polyhedra, and sticky under
			// render-on-demand). The shared _stage uniform is bound at first
			// compile mid-frame and already carries the correct value.
			Object.defineProperty( material, 'renderStage', {

				get: function() {

					return _stage;

				},

				set: function( stage ) {

					_stage.value = parseFloat( stage );

				}

			} );

			const existingOnBeforeCompile = material.onBeforeCompile;

			material.onBeforeCompile = function( shader, renderer ) {

				// LOCAL MODIFICATION (CrysViz): upstream ran this body only once
				// (guarded by wboitEnabled), so a later program rebuild silently
				// dropped both the chained onBeforeCompile (the app's instanced
				// atom/bond shader patches) and the WBOIT outputs. The body is
				// idempotent per compile, so run it every time instead.
				if (typeof existingOnBeforeCompile === 'function') existingOnBeforeCompile( shader, renderer );

				shader.uniforms.renderStage = _stage;
				shader.uniforms.weight = { value: 1.0 };
				shader.uniforms.tWboitRevealage = _revealage;
				shader.uniforms.tWboitDepthRange = _depthRange;

				shader.fragmentShader = `
					uniform float renderStage;
					uniform float weight;
					uniform sampler2D tWboitRevealage;
					uniform sampler2D tWboitDepthRange;
				` + shader.fragmentShader;

				// shader.fragmentShader = shader.fragmentShader.replace('#include <tonemapping_fragment>', '');
				// shader.fragmentShader = shader.fragmentShader.replace('#include <colorspace_fragment>', '');

				// LOCAL MODIFICATION (CrysViz): upstream appended the stage outputs
				// with shader.fragmentShader.replace( /}$/gm, ... ), which injects at
				// EVERY line-final '}' — corrupting shaders whose (chained)
				// onBeforeCompile already added braced GLSL blocks. Append before the
				// last closing brace of main() instead.
				const wboitOutput = `

					if ( renderStage == ${ WboitStages.Acummulation.toFixed( 1 ) } ) {

						vec4 accum = gl_FragColor.rgba;

						#ifndef PREMULTIPLIED_ALPHA
							accum.rgb *= accum.a;
						#endif

						// LOCAL MODIFICATION (CrysViz): transmittance-interpolated
						// weight instead of upstream's alpha/depth heuristic. Upstream's
						// alpha term saturated at its clamp for any alpha above ~0.07 and
						// its depth term used gl_FragCoord.z, which sits near 0.03 for
						// this app's orthographic camera — every fragment got the same
						// weight, so the stage was a plain average: two stacked
						// alpha-0.99 atoms mixed 50/50 and looked half transparent next
						// to an alpha-1 (opaque-pass) neighbour.
						//
						// Exact over-compositing weights a fragment by the transmittance
						// of everything in front of it. The revealage buffer holds the
						// pixel's total transmittance T = prod(1 - a_j); dividing out
						// this fragment's own (1 - a) leaves the transmittance of the
						// OTHER fragments, and raising it to the fragment's normalised
						// depth within the pixel's transparent depth range estimates
						// how much of that lies in front. Exact for any two fragments
						// and for equally spaced stacks of any alpha mix; as alpha
						// approaches 1 the front fragment dominates and the result
						// converges continuously on the opaque rendering.
						ivec2 wboitPx = ivec2( gl_FragCoord.xy );
						float wboitReveal = texelFetch( tWboitRevealage, wboitPx, 0 ).r;
						vec4 wboitRange = texelFetch( tWboitDepthRange, wboitPx, 0 );
						float wboitNear = 1.0 - wboitRange.r;
						float wboitSpan = wboitRange.a - wboitNear;
						float wboitT = wboitSpan > 1e-7
							? clamp( ( gl_FragCoord.z - wboitNear ) / wboitSpan, 0.0, 1.0 )
							: 0.0;
						float wboitOthers = clamp( wboitReveal / max( 1.0 - accum.a, 1e-4 ), 1e-4, 1.0 );
						float w = pow( wboitOthers, wboitT );

						gl_FragColor = accum * w;

					} else if ( renderStage == ${ WboitStages.DepthRange.toFixed( 1 ) } ) {

						// LOCAL MODIFICATION (CrysViz): both channels use MAX blend:
						// rgb encodes the nearest depth as 1-z; alpha stores farthest z.
						gl_FragColor = vec4( vec3( 1.0 - gl_FragCoord.z ), gl_FragCoord.z );

					} else if ( renderStage == ${ WboitStages.Revealage.toFixed( 1 ) } ) {

						// LOCAL MODIFICATION (CrysViz): upstream multiplied by
						// gl_FragCoord.z here, but the paper's revealage is the plain
						// product of (1 - alpha). With this app's orthographic camera
						// and far plane, gl_FragCoord.z is ~0.02-0.04, which collapsed
						// transparent coverage to ~1% (content nearly invisible).
					 	gl_FragColor = vec4( gl_FragColor.a );

					}

				`;
				const mainEnd = shader.fragmentShader.lastIndexOf( '}' );
				shader.fragmentShader =
					shader.fragmentShader.slice( 0, mainEnd ) + wboitOutput + '\n}';

			}

			const materialID = _materialCounter;
			_materialCounter ++;

			material.customProgramCacheKey = function () {

				return materialID;

			};

			material.needsUpdate = true;

		}

	}

	/** LOCAL MODIFICATION (CrysViz): bind the read-back textures for the
	 *  accumulation stage (WboitPass sets these each frame). */
	static setStageTextures( revealageTexture, depthRangeTexture ) {

		_revealage.value = revealageTexture;
		_depthRange.value = depthRangeTexture;

	}

}

export { WboitUtils };
