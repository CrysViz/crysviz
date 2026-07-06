// @ts-nocheck -- vendored third-party; not type-checked
/**
 * Helper utilities for WboitPass
 */

import { WboitStages } from './materials/MeshWboitMaterial.js';

let _materialCounter = 0;
const _stage = { value: 0.5 };

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

				shader.fragmentShader = `
					uniform float renderStage;
					uniform float weight;
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

						float z = gl_FragCoord.z;

						float scaleWeight = 0.7 + ( 0.3 * weight );
						float w = clamp( pow( ( accum.a * 8.0 + 0.001 ) * ( - z * scaleWeight + 1.0 ), 3.0 ) * 1000.0, 0.001, 300.0 );

						gl_FragColor = accum * w;

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

}

export { WboitUtils };
