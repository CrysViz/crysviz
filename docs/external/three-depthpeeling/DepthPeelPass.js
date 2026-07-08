// @ts-nocheck -- vendored third-party; not type-checked
/**
 * Depth-peeling render pass.
 *
 * Adapted from gkjohnson/three-depthpeeling-demo (depthPeelRender() and
 * onWindowResize() in index.js) — MIT, Copyright (c) 2025 Garrett Johnson.
 * This is an ADAPTATION, not a verbatim copy; see README.md in this directory
 * for the divergences.
 *
 * Frame structure (replaces one renderer.render() call):
 *   1. opaque set  -> opaque target (depth captured to a DepthTexture),
 *      blitted to the screen (NoBlending full replace);
 *   2. N peel passes over the transparent "peel" set: each peel keeps only
 *      the nearest fragments strictly behind the previous peel's depth
 *      (ping-ponged DepthTextures) and in front of the opaque depth;
 *   3. peels composited back-to-front over the screen with normal alpha
 *      blending — exact order-independent transparency up to N layers;
 *   4. all mesh/material/renderer state restored.
 *
 * Materials in the peel set must be patched with DepthPeelUtils.patch();
 * unpatched transparent meshes render normally on top as a best-effort tail.
 */

import {
	AddEquation,
	Color,
	CustomBlending,
	DepthTexture,
	FloatType,
	HalfFloatType,
	NearestFilter,
	NoBlending,
	NormalBlending,
	OneFactor,
	RGBAFormat,
	ShaderMaterial,
	Vector2,
	WebGLRenderTarget,
	ZeroFactor,
} from '../three/three.module.js';
import { FullScreenQuad } from '../three/Pass.js';

const _clearColorZero = new Color( 0, 0, 0 );

// LOCAL ADAPTATION: the demo blits with a MeshBasicMaterial; rendered to the
// screen that would re-apply the renderer's tone mapping and output color
// space to content that is already display-encoded (see the target setup
// below). A bare ShaderMaterial passes the values through untouched.
const CopyShader = {
	uniforms: {
		tDiffuse: { value: null },
	},
	vertexShader: /* glsl */`
		varying vec2 vUv;
		void main() {
			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
		}`,
	fragmentShader: /* glsl */`
		uniform sampler2D tDiffuse;
		varying vec2 vUv;
		void main() {
			gl_FragColor = texture2D( tDiffuse, vUv );
		}`,
};

class DepthPeelPass {

	constructor( renderer, scene, camera ) {

		this.scene = scene;
		this.camera = camera;
		this.layerCount = 5;

		this._oldClearColor = new Color();
		this._visibilityCache = new Map();
		this._materialCache = new Map();

		const size = renderer.getDrawingBufferSize( new Vector2() );
		this._width = size.width;
		this._height = size.height;
		this._colorSpace = renderer.outputColorSpace;

		this._depthTextureA = this._makeDepthTexture();
		this._depthTextureB = this._makeDepthTexture();
		this._opaqueDepthTexture = this._makeDepthTexture();

		this._opaqueTarget = this._makeColorTarget();
		/** Peel color targets, grown/trimmed lazily to layerCount. */
		this._layers = [];

		this._quad = new FullScreenQuad( new ShaderMaterial( {
			uniforms: { tDiffuse: { value: null } },
			vertexShader: CopyShader.vertexShader,
			fragmentShader: CopyShader.fragmentShader,
			depthTest: false,
			depthWrite: false,
		} ) );

	}

	_makeDepthTexture() {

		return new DepthTexture( this._width, this._height, FloatType );

	}

	_makeColorTarget() {

		const target = new WebGLRenderTarget( this._width, this._height, {
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			type: HalfFloatType,
			format: RGBAFormat,
			stencilBuffer: false,
			depthBuffer: true,
		} );

		// LOCAL ADAPTATION (same treatment as the vendored three-wboit): three
		// r152+ forces NoToneMapping and linear output into offscreen targets,
		// washing out scenes tuned for ACES tone mapping. XR-flagging the
		// target makes scene renders into it tone-map/encode exactly like the
		// default framebuffer (HalfFloat type avoids the hardware-sRGB internal
		// format path); the copy quad then blits the values through raw.
		target.isXRRenderTarget = true;
		target.texture.colorSpace = this._colorSpace;
		return target;

	}

	setLayerCount( count ) {

		this.layerCount = Math.max( 1, Math.floor( count ) || 1 );

	}

	setSize( width, height ) {

		if ( width === this._width && height === this._height ) return;
		this._width = width;
		this._height = height;

		this._opaqueTarget.setSize( width, height );
		this._layers.forEach( ( target ) => target.setSize( width, height ) );

		// Demo resize pattern: depth textures resize via image + dispose.
		for ( const texture of [ this._depthTextureA, this._depthTextureB, this._opaqueDepthTexture ] ) {

			texture.image.width = width;
			texture.image.height = height;
			texture.dispose();

		}

	}

	dispose() {

		this._opaqueTarget.dispose();
		this._layers.forEach( ( target ) => target.dispose() );
		this._layers.length = 0;
		this._depthTextureA.dispose();
		this._depthTextureB.dispose();
		this._opaqueDepthTexture.dispose();
		this._quad.material.dispose();
		this._quad.dispose();

	}

	_blit( renderer, texture, blending ) {

		const material = this._quad.material;
		material.uniforms.tDiffuse.value = texture;
		material.blending = blending;
		material.transparent = ( blending === NormalBlending );
		this._quad.render( renderer );

	}

	render( renderer ) {

		const scene = this.scene;
		const camera = this.camera;
		if ( ! scene || ! scene.isScene ) return;

		// ---- Save state ----
		const oldAutoClear = renderer.autoClear;
		const oldClearAlpha = renderer.getClearAlpha();
		const oldRenderTarget = renderer.getRenderTarget();
		const oldOverrideMaterial = scene.overrideMaterial;
		renderer.getClearColor( this._oldClearColor );
		renderer.autoClear = false;
		scene.overrideMaterial = null;

		// LOCAL ADAPTATION (same as the vendored three-wboit): a scene
		// background would repaint in every stage render; deliver it through
		// the opaque stage's clear color instead (null = transparent capture).
		const oldBackground = scene.background;
		scene.background = null;
		const hasBackground = !! ( oldBackground && oldBackground.isColor );

		// ---- Gather meshes ----
		const visibilityCache = this._visibilityCache;
		const materialCache = this._materialCache;
		const opaqueMeshes = [];
		const peelMeshes = [];
		const otherTransparentMeshes = [];

		scene.traverse( ( object ) => {

			if ( ! object.material || ! object.visible ) return;

			const materials = Array.isArray( object.material ) ? object.material : [ object.material ];
			let isTransparent = true;
			let isPeel = true;
			for ( const material of materials ) {

				isTransparent = isTransparent && material.transparent;
				isPeel = isPeel && isTransparent && material.depthPeelEnabled === true;

			}

			if ( isPeel ) {

				peelMeshes.push( object );
				for ( const material of materials ) {

					materialCache.set( material, {
						blending: material.blending,
						blendEquation: material.blendEquation,
						blendSrc: material.blendSrc,
						blendDst: material.blendDst,
						depthTest: material.depthTest,
						depthWrite: material.depthWrite,
						forceSinglePass: material.forceSinglePass,
					} );

				}

			} else if ( isTransparent ) {

				otherTransparentMeshes.push( object );

			} else {

				opaqueMeshes.push( object );

			}

			// Stage gating uses layer masks instead of `visible` (the cache
			// stores the mask): hiding a mesh via `visible` also hides its
			// CHILDREN, so an opaque child of a transparent mesh (e.g. a
			// cel-shading hull-outline shell on a transparent polyhedron)
			// could never render in any stage. A zeroed layer mask skips the
			// object itself but still traverses its children.
			visibilityCache.set( object, object.layers.mask );

		} );

		// LOCAL ADAPTATION (CrysViz): FAST PATH — when the scene contains no
		// transparent material at all there is nothing to peel, so render one
		// plain direct pass (identical cost and pixels to the forward
		// pipeline) and skip the opaque-target/peel/composite machinery.
		// This makes 'depthpeel' safe as the app default: all-opaque scenes
		// pay a forward frame; transparency re-engages peeling next frame.
		// (Nothing was mutated yet at this point — the caches were only
		// filled with saved state, and no layer mask was touched.)
		this.lastFrameFastPath = peelMeshes.length === 0 && otherTransparentMeshes.length === 0;
		if ( this.lastFrameFastPath ) {

			renderer.setRenderTarget( oldRenderTarget );
			renderer.setClearColor( this._oldClearColor, oldClearAlpha );
			scene.overrideMaterial = oldOverrideMaterial;
			scene.background = oldBackground;
			renderer.autoClear = oldAutoClear;
			visibilityCache.clear();
			materialCache.clear();

			renderer.clear();
			renderer.render( scene, camera );
			return;

		}

		const setVisible = ( opaqueVisible, transparentVisible, peelVisible ) => {

			opaqueMeshes.forEach( ( mesh ) => mesh.layers.mask = opaqueVisible ? visibilityCache.get( mesh ) : 0 );
			otherTransparentMeshes.forEach( ( mesh ) => mesh.layers.mask = transparentVisible ? visibilityCache.get( mesh ) : 0 );
			peelMeshes.forEach( ( mesh ) => mesh.layers.mask = peelVisible ? visibilityCache.get( mesh ) : 0 );

		};

		// ---- Targets ----
		const size = renderer.getDrawingBufferSize( new Vector2() );
		this.setSize( size.width, size.height );
		while ( this._layers.length < this.layerCount ) this._layers.push( this._makeColorTarget() );
		while ( this._layers.length > this.layerCount ) this._layers.pop().dispose();

		// ---- 1) Opaque stage (captures the opaque depth) ----
		setVisible( true, false, false );
		this._opaqueTarget.depthTexture = this._opaqueDepthTexture;
		renderer.setRenderTarget( this._opaqueTarget );
		renderer.setClearColor( hasBackground ? oldBackground : _clearColorZero, hasBackground ? 1.0 : 0.0 );
		renderer.clear();
		renderer.render( scene, camera );
		this._opaqueTarget.depthTexture = null;

		renderer.setRenderTarget( null );
		this._blit( renderer, this._opaqueTarget.texture, NoBlending );

		// ---- 2) Peel passes ----
		const depthTextures = [ this._depthTextureA, this._depthTextureB ];
		setVisible( false, false, true );
		for ( let i = 0; i < this.layerCount; i ++ ) {

			const writeDepthTexture = depthTextures[ ( i + 1 ) % 2 ];
			const nearDepthTexture = depthTextures[ i % 2 ];

			for ( const material of materialCache.keys() ) {

				const uniforms = material.userData.depthPeel;
				if ( ! uniforms ) continue;
				uniforms.uPeelEnabled.value = 1;
				uniforms.uFirstPass.value = ( i === 0 ) ? 1 : 0;
				uniforms.opaqueDepth.value = this._opaqueDepthTexture;
				uniforms.nearDepth.value = ( i === 0 ) ? null : nearDepthTexture;
				uniforms.resolution.value.set( size.width, size.height );

				// Each peel layer keeps exactly the nearest surviving fragment
				// per pixel: replace-blending + depth writes.
				material.blending = CustomBlending;
				material.blendEquation = AddEquation;
				material.blendSrc = OneFactor;
				material.blendDst = ZeroFactor;
				material.depthWrite = true;
				material.depthTest = true;
				material.forceSinglePass = true;

			}

			const target = this._layers[ i ];
			target.depthTexture = writeDepthTexture;
			renderer.setRenderTarget( target );
			renderer.setClearColor( _clearColorZero, 0.0 );
			renderer.clear();
			renderer.render( scene, camera );

		}

		// ---- 3) Composite peels back-to-front over the screen ----
		renderer.setRenderTarget( null );
		for ( let i = this.layerCount - 1; i >= 0; i -- ) {

			this._layers[ i ].depthTexture = null;
			this._blit( renderer, this._layers[ i ].texture, NormalBlending );

		}

		// Best-effort tail: transparent meshes that are not peel-patched
		// render normally on top (empty in practice — the pipeline patches
		// every transparent material kind).
		if ( otherTransparentMeshes.length ) {

			setVisible( false, true, false );
			renderer.render( scene, camera );

		}

		// ---- 4) Restore ----
		for ( const [ material, saved ] of materialCache ) {

			Object.assign( material, saved );
			const uniforms = material.userData.depthPeel;
			if ( uniforms ) {

				uniforms.uPeelEnabled.value = 0;
				uniforms.nearDepth.value = null;
				uniforms.opaqueDepth.value = null;

			}

		}

		for ( const [ object, layersMask ] of visibilityCache ) object.layers.mask = layersMask;

		renderer.setRenderTarget( oldRenderTarget );
		renderer.setClearColor( this._oldClearColor, oldClearAlpha );
		scene.overrideMaterial = oldOverrideMaterial;
		scene.background = oldBackground;
		renderer.autoClear = oldAutoClear;

		visibilityCache.clear();
		materialCache.clear();

	}

}

export { DepthPeelPass };
