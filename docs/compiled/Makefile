EMCC ?= emcc
CFLAGS ?= -O3

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
	["_malloc","_free","_wf_next_smooth","_wf_gen_gvecs","_wf_scatter","_wf_ifft3","_wf_reduce_scalar"]

# HEAP32/HEAPF32 are needed on top of HEAPF64: G-vectors are int32 and the
# reduced field is float32 (what model/Field.js stores).
WAVE_EXPORTED_RUNTIME := \
	["ccall","cwrap","HEAPF64","HEAPF32","HEAP32"]

.PHONY: all wasm wasm-wave clean

all: wasm wasm-wave

wasm: $(JS_OUT)

wasm-wave: $(WAVE_JS_OUT)

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

# MAXIMUM_MEMORY matches external/marching_cubes_wasm: a large FFT box plus its
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

clean:
	rm -f $(JS_OUT) $(WASM_OUT) $(WAVE_JS_OUT) $(WAVE_WASM_OUT)
