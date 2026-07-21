.PHONY: serve install_devtools lint lint-fix typecheck check-imports check periodic-wasm browsertest browsertest-setup

# Local dev server for docs/. Two things python3 -m http.server won't do on
# its own:
#   - bind loopback only. Its default is 0.0.0.0, which publishes the working
#     tree (including anything else under docs/) to every machine on the LAN
#     or cafe wifi. Override with SERVE_HOST= if you actually want that.
#   - pick a free port. The default 8000 is a popular squat, and the failure
#     mode is a bare "Address already in use". Probe upward instead.
SERVE_HOST ?= 127.0.0.1
SERVE_PORT ?= 8000
SERVE_TRIES ?= 20

serve:
	@host='$(SERVE_HOST)'; port=$(SERVE_PORT); max=$$(( $(SERVE_PORT) + $(SERVE_TRIES) )); \
	while [ $$port -lt $$max ] && ! python3 -c "import socket, sys; s = socket.socket(); s.settimeout(0.2); busy = s.connect_ex(('$$host', $$port)) == 0; s.close(); sys.exit(1 if busy else 0)"; do \
		echo "port $$port is taken, trying $$(( port + 1 ))"; \
		port=$$(( port + 1 )); \
	done; \
	if [ $$port -ge $$max ]; then \
		echo "no free port in $(SERVE_PORT)..$$(( max - 1 ))" >&2; exit 1; \
	fi; \
	echo "Open:"; \
	echo "* http://$$host:$$port/index.html"; \
	cd docs && exec python3 -m http.server $$port --bind "$$host"

# One-time: install dev-only tooling (eslint, typescript). Writes node_modules/
# (gitignored, never served). Run this before lint/typecheck.
install_devtools:
	npm install

# Lint app sources (docs/), focused on real-bug rules. See eslint.config.js.
lint:
	npx eslint docs

lint-fix:
	npx eslint docs --fix

# Type-check plain JS via tsc --checkJs (lenient config; kept at zero errors).
typecheck:
	npx tsc --noEmit -p tsconfig.json

# Static ES-module import check (resolver + named-import-vs-export validator).
# Dependency-free; catches the load-time import errors a bundler would catch.
check-imports:
	python3 tools/check_imports.py

# The CI gate: lint + typecheck + import checks. Run on pull requests
# (see .github/workflows/check.yml). Any failure fails the build.
check: lint typecheck check-imports

# Browser end-to-end tests: real app in playwright-Firefox under a private
# Xvfb (works headless-less and root-less, incl. sandboxed agent
# environments). See tools/browsertest/README.md. Setup downloads ~180 MB
# into tools/browsertest/env/ (gitignored). Run one test with:
#   tools/browsertest/run.sh tests/<name>.test.js
browsertest-setup:
	tools/browsertest/setup.sh

browsertest:
	tools/browsertest/run.sh

# Rebuild the periodic_wasm module from its Rust source
# (docs/compiled/periodic_wasm_src/). Requires wasm-pack and the
# wasm32-unknown-unknown target. The generated glue + binary are copied into
# docs/compiled/ (committed; loaded by docs/compiled/periodicWasm.js). The
# hand-written periodicWasm.js wrapper is NOT touched.
PERIODIC_WASM_SRC := docs/compiled/periodic_wasm_src
periodic-wasm:
	cd $(PERIODIC_WASM_SRC) && wasm-pack build --target web --release
	cp $(PERIODIC_WASM_SRC)/pkg/periodic_wasm.js            docs/compiled/periodic_wasm.js
	cp $(PERIODIC_WASM_SRC)/pkg/periodic_wasm_bg.wasm       docs/compiled/periodic_wasm_bg.wasm
	cp $(PERIODIC_WASM_SRC)/pkg/periodic_wasm.d.ts          docs/compiled/periodic_wasm.d.ts
	cp $(PERIODIC_WASM_SRC)/pkg/periodic_wasm_bg.wasm.d.ts  docs/compiled/periodic_wasm_bg.wasm.d.ts
