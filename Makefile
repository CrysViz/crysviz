.PHONY: serve install_devtools lint lint-fix typecheck check-imports css-guard checks ci tests_full periodic-wasm browsertest browsertest-setup bump

PYTHON ?= python3

# Local dev server for docs/. Two things python3 -m http.server won't do on
# its own:
#   - bind loopback only. Its default is 0.0.0.0, which publishes the working
#     tree (including anything else under docs/) to every machine on the LAN
#     or cafe wifi. Override with SERVE_HOST= if you actually want that.
#   - pick a free port. The default 8000 is a popular squat, and the failure
#     mode is a bare "Address already in use". Probe upward instead.
#   - send Cache-Control. Without it Firefox caches modules heuristically and
#     an edit resurfaces as a missing export from the previous version of a
#     file. tools/devserver.py does all three.
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
	exec python3 tools/devserver.py $$port --directory docs --bind "$$host"

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

# Enforce the CSS consolidation's invariants (CSSPlan.md, docs/styles/TOKENS.md):
# no colour/font-family literal outside docs/themes/, no @media outside
# docs/styles/responsive.css, no new CSS-in-JS under docs/. Reviewed exceptions
# live in tools/ci/css_guard_allow.txt.
css-guard:
	tools/ci/css_guard.sh

# Fast source validation: lint + typecheck + import checks.
checks: lint typecheck check-imports css-guard

# Reproduce the complete headless GitHub Actions gate locally: dependency
# setup, static and Python tests, package-content/install checks, and packaged
# browser smoke. The workflow itself calls this target.
ci:
	tools/ci/run.sh

# Everything in CI, followed by the complete non-benchmark browser suite and
# the native-window QtWebEngine integration smoke. The final test requires host
# facilities unavailable in some headless/container environments.
tests_full: ci
	$(MAKE) browsertest-setup
	$(MAKE) browsertest
	$(PYTHON) -m pip install -e '.[qt]'
	bash tests/qtwebengine_smoke.sh

# Browser end-to-end tests: real app in headed Playwright Firefox under a
# private Xvfb, so no physical display is required. Works root-less, including
# in sandboxed agent environments. See tools/browsertest/README.md. Setup downloads ~180 MB
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

# ── Releasing ────────────────────────────────────────────────────────────────
# The version lives in one place, src/crysviz/__init__.py; `make bump` rewrites
# it together with README.md, docs/ui/about.md (the About box) and a new
# CHANGELOG.md section. What the number means is your call:
#   major  incompatible change (file formats, Python API)    1.4.2 -> 2.0.0
#   minor  new features, backwards compatible                1.4.2 -> 1.5.0
#   fix    bug fixes only                                    1.4.2 -> 1.4.3
#
# 0. Along the way, any PR can add user-facing notes under "## Unreleased" in
#    CHANGELOG.md.
# 1. On a branch off main:
#      make bump PART=minor          # or PART=major|fix, or VERSION=X.Y.Z
#    The Unreleased notes move under the new "## X.Y.Z — date" heading (a fresh
#    Unreleased opens above it); review or complete them there. That text heads
#    the GitHub Release, above GitHub's list of merged PRs; a release with an
#    empty section is refused.
#    (The Actions tab's "Bump version" workflow does the bump and opens the PR
#    for you; edit the notes in that PR.)
# 2. Open a PR into main, review, merge.
# 3. On GitHub, open a PR from main into deploy and merge it with
#    "Create a merge commit" (not squash: deploy keeps commits of its own).
# 4. That push to deploy starts two workflows:
#      static.yml   deploys the website (live immediately)
#      release.yml  sees the untagged version, runs `make ci`, builds, and waits
#                   for a `pypi` environment reviewer: Actions -> the run ->
#                   "Review deployments" -> approve. It then publishes to PyPI
#                   and creates the vX.Y.Z tag + GitHub Release.
#    A deploy without a new version only updates the website.
# If publishing fails nothing is tagged: re-run the workflow (or deploy again).
# Dry run to TestPyPI: Actions -> "Publish package" -> Run workflow.
# `tools/release/bump_version.py --check` (run by CI) fails whenever the
# version places or the CHANGELOG heading disagree.
bump:
	@if [ -n "$(VERSION)" ]; then $(PYTHON) tools/release/bump_version.py $(VERSION); \
	elif [ -n "$(PART)" ]; then $(PYTHON) tools/release/bump_version.py $(PART); \
	else echo "usage: make bump PART=major|minor|fix  or  make bump VERSION=X.Y.Z" >&2; exit 2; fi
