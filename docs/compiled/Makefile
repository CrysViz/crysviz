EMCC ?= emcc
CFLAGS ?= -O3

# tsc follows the imports in docs/ into this directory's generated glue and
# type-checks it, even though tsconfig.json excludes docs/compiled: `exclude`
# only governs the root file set, not what the root files import. Emscripten's
# Node branch references node:module, node:fs and process, none of which this
# project has types for, so an unbannered module is ~10 errors in `make
# typecheck` — which is a zero-error CI gate.
#
# Stamping the banner here rather than adding it by hand is the point: it was
# added by hand once, and a later rebuild silently dropped it. wave_backend.js
# is the exception and carries no banner — wave_backend.d.ts shadows it with
# real signatures, which is better than switching the checking off.
TS_NOCHECK := // @ts-nocheck -- Emscripten-generated; not type-checked

define stamp_nocheck
@printf '%s\n' '$(TS_NOCHECK)' | cat - $(1) > $(1).stamped && mv $(1).stamped $(1)
endef

SRC := math_backend.c
JS_OUT := math_backend.js
WASM_OUT := math_backend.wasm

EXPORTED_FUNCTIONS := \
	["_malloc","_free","_invert3x3","_frac_to_cart_batch","_cart_to_frac_batch","_cart_to_frac_batch_wrapped","_normalize_fractional_batch","_lattice_volume","_lattice_parameters"]

EXPORTED_RUNTIME := \
	["ccall","cwrap","HEAPF64"]

# Plane-wave (WAVECAR) numerics: G-vector generation, scatter, mixed-radix 3D
# FFT and the scalar reduction. Built separately from math_backend so the field
# code only pays for the module when a wavefunction is actually opened.
WAVE_SRC := wave_backend.c
WAVE_JS_OUT := wave_backend.js
WAVE_WASM_OUT := wave_backend.wasm

WAVE_EXPORTED_FUNCTIONS := \
	["_malloc","_free","_wf_next_smooth","_wf_gen_gvecs","_wf_scatter","_wf_ifft3","_wf_reduce_scalar","_wf_reduce_spinor"]

# HEAP32/HEAPF32 are needed on top of HEAPF64: G-vectors are int32 and the
# reduced field is float32 (what model/Field.js stores).
WAVE_EXPORTED_RUNTIME := \
	["ccall","cwrap","HEAPF64","HEAPF32","HEAP32"]

# Marching-cubes isosurface extraction (Paul Bourke's polygonisation) plus the
# default-isovalue histogram the field panel starts from. Uses embind rather
# than plain exported functions -- it hands JS a class, not a function table --
# so its flags look different from the two C modules above.
MC_SRC := marching_cubes.cpp
MC_JS_OUT := MarchCubes.js
MC_WASM_OUT := MarchCubes.wasm

.PHONY: all wasm wasm-wave wasm-marching-cubes clean

all: wasm wasm-wave wasm-marching-cubes

wasm: $(JS_OUT)

wasm-wave: $(WAVE_JS_OUT)

wasm-marching-cubes: $(MC_JS_OUT)

$(JS_OUT): $(SRC)
	$(EMCC) $(CFLAGS) $(SRC) \
		-s WASM=1 \
		-s MODULARIZE=1 \
		-s EXPORT_ES6=1 \
		-s ENVIRONMENT=web,worker \
		-s ALLOW_MEMORY_GROWTH=1 \
		-s EXPORTED_FUNCTIONS='$(EXPORTED_FUNCTIONS)' \
		-s EXPORTED_RUNTIME_METHODS='$(EXPORTED_RUNTIME)' \
		-o $(JS_OUT)
	$(call stamp_nocheck,$(JS_OUT))

# MAXIMUM_MEMORY matches the marching-cubes build below: a large FFT box plus its
# reduced field can run to a few hundred MB, and the default 2GB cap is the
# first thing a big cell would hit.
$(WAVE_JS_OUT): $(WAVE_SRC)
	$(EMCC) $(CFLAGS) $(WAVE_SRC) \
		-s WASM=1 \
		-s MODULARIZE=1 \
		-s EXPORT_ES6=1 \
		-s EXPORT_NAME=WaveBackend \
		-s ENVIRONMENT=web,worker,node \
		-s ALLOW_MEMORY_GROWTH=1 \
		-s MAXIMUM_MEMORY=4294967296 \
		-s EXPORTED_FUNCTIONS='$(WAVE_EXPORTED_FUNCTIONS)' \
		-s EXPORTED_RUNTIME_METHODS='$(WAVE_EXPORTED_RUNTIME)' \
		-o $(WAVE_JS_OUT)

# -Os and --closure 1, unlike the -O3 above: this module is loaded on every
# page view (model/MarchingCubesWrapper.js imports it at module scope), so its
# glue size is worth more than the last few percent of speed.
$(MC_JS_OUT): $(MC_SRC)
	$(EMCC) -Os $(MC_SRC) \
		-lembind \
		-s FILESYSTEM=0 \
		--closure 1 \
		-s ALLOW_MEMORY_GROWTH=1 \
		-s MODULARIZE=1 \
		-s EXPORT_ES6=1 \
		-s EXPORT_NAME=MarchCubes \
		-s EXPORTED_RUNTIME_METHODS=HEAPF32 \
		-s MAXIMUM_MEMORY=4294967296 \
		-o $(MC_JS_OUT)
	$(call stamp_nocheck,$(MC_JS_OUT))

clean:
	rm -f $(JS_OUT) $(WASM_OUT) $(WAVE_JS_OUT) $(WAVE_WASM_OUT) $(MC_JS_OUT) $(MC_WASM_OUT)
	rm -f $(JS_OUT).stamped $(MC_JS_OUT).stamped
