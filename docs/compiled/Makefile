EMCC ?= emcc
CFLAGS ?= -O3

SRC := math_backend.c
JS_OUT := math_backend.js
WASM_OUT := math_backend.wasm

EXPORTED_FUNCTIONS := \
	["_malloc","_free","_invert3x3","_frac_to_cart_batch","_cart_to_frac_batch","_cart_to_frac_batch_wrapped","_normalize_fractional_batch","_lattice_volume","_lattice_parameters"]

EXPORTED_RUNTIME := \
	["ccall","cwrap","HEAPF64"]

.PHONY: all wasm clean

all: wasm

wasm: $(JS_OUT)

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

clean:
	rm -f $(JS_OUT) $(WASM_OUT)
