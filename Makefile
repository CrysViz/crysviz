.PHONY: serve install lint lint-fix typecheck check-imports check

serve:
	echo "Open:"
	echo "* http://localhost:8000/index.html"
	cd docs && python3 -m http.server

# One-time: install dev-only tooling (eslint, typescript). Writes node_modules/
# (gitignored, never served). Run this before lint/typecheck.
install_devtools:
	npm install

# Lint app sources (docs/), focused on real-bug rules. See eslint.config.js.
lint:
	npx eslint docs

lint-fix:
	npx eslint docs --fix

# Type-check plain JS via tsc --checkJs (informational; lenient, not a gate).
typecheck:
	npx tsc --noEmit -p tsconfig.json

# Static ES-module import check (resolver + named-import-vs-export validator).
# Dependency-free; catches the load-time import errors a bundler would catch.
check-imports:
	python3 tools/check_imports.py

# The reliable gate: lint + import checks (typecheck is separate/informational).
check: lint check-imports
