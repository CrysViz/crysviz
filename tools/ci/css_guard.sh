#!/usr/bin/env bash
# css_guard.sh — keeps the CSS consolidation (see CSSPlan.md, docs/styles/TOKENS.md)
# from rotting back into per-panel colours, fonts and breakpoints. Four invariants:
#
#   1. no colour literal (hex / rgb(a) / hsl(a) / named keyword) outside docs/themes/
#   2. no literal font-family stack outside docs/themes/ (var(--font-*) or `inherit` is fine)
#   3. no @media rule outside docs/styles/responsive.css
#   4. no CSS-in-JS (element.style.cssText =, createElement('style'),
#      adoptedStyleSheets, insertRule) under docs/
#
# Scope:
#   - docs/styles/*.css and docs/themes/*/theme.css are what invariants 1-3 scan.
#     Colour/font-family are only *exempt* inside docs/themes/ — that's the one
#     place the vocabulary is allowed to be defined. @media is checked in both
#     (a theme file has no business declaring a breakpoint either), just not
#     required to move anywhere since there's only one place it's allowed.
#   - docs/external/ and docs/compiled/ are vendored. Never scanned.
#   - docs/addons/ is out of scope entirely. The Energy Landscape addon is
#     deliberately shelved and self-contained — it injects its own <style>
#     because addons load dynamically outside the docs/styles/ pipeline. Don't
#     "fix" it into this guard; that's a deliberate exception, not debt.
#   - docs/ui/DiscoBallModule.js's createElement('style') is a named exception
#     in tools/ci/css_guard_allow.txt, not hardcoded here, so it stays greppable.
#
# Exceptions live in tools/ci/css_guard_allow.txt: one per line, "path:pattern
# # reason". `path` is repo-root-relative, `pattern` is a plain substring
# (not a regex) matched against "<selector> :: <line text>" for CSS hits, or
# "<line text>" for JS hits — see is_allowed() below. Keep patterns specific
# enough to key on the rule/selector, not just the raw value: several literals
# repeat byte-for-byte at more than one call site (e.g. the grey slider-track
# background rgba(150,150,150,0.5) appears both in the allowed .blh-range-bg
# and the NOT-allowed .bond-range-slider .background-track), so a bare value
# would silently amnesty a site nobody reviewed.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$repo_root"

allow_file="tools/ci/css_guard_allow.txt"
violations=0

# ---------------------------------------------------------------------------
# Allowlist
# ---------------------------------------------------------------------------

allow_paths=()
allow_patterns=()

load_allowlist() {
    [[ -f "$allow_file" ]] || return 0
    local raw entry path pattern
    while IFS= read -r raw || [[ -n "$raw" ]]; do
        # A row is "path:pattern  # reason". Only whitespace-preceded '#'
        # opens the comment: patterns are selectors, and an ID selector
        # (#someButton) is the whole point of several rows. Cutting at the
        # first '#' truncated those to empty, so they silently never matched.
        case "$raw" in
            ''|[[:space:]]*'#'*|'#'*) [[ "$raw" =~ ^[[:space:]]*# ]] && continue ;;
        esac
        entry="$(printf '%s' "$raw" | sed -e 's/[[:space:]][[:space:]]*#.*$//' -e 's/[[:space:]]*$//')"
        [[ -z "$entry" ]] && continue
        path="${entry%%:*}"
        pattern="${entry#*:}"
        [[ -z "$path" || -z "$pattern" || "$pattern" == "$entry" ]] && continue
        allow_paths+=("$path")
        allow_patterns+=("$pattern")
    done < "$allow_file"
}

# is_allowed <path> <text>  — true if some allowlist row's path matches and
# its pattern is a literal substring of <text>.
is_allowed() {
    local path="$1" text="$2" i
    for ((i = 0; i < ${#allow_paths[@]}; i++)); do
        if [[ "${allow_paths[$i]}" == "$path" && "$text" == *"${allow_patterns[$i]}"* ]]; then
            return 0
        fi
    done
    return 1
}

load_allowlist

# ---------------------------------------------------------------------------
# report <invariant> <path> <lineno> <selector> <text>
# ---------------------------------------------------------------------------

report() {
    local invariant="$1" path="$2" lineno="$3" selector="$4" text="$5"
    local match_text="$selector :: $text"
    if is_allowed "$path" "$match_text"; then
        return 0
    fi
    if [[ -n "$selector" ]]; then
        printf '%s:%s: [%s] in %s\n    %s\n' "$path" "$lineno" "$invariant" "$selector" "$text"
    else
        printf '%s:%s: [%s]\n    %s\n' "$path" "$lineno" "$invariant" "$text"
    fi
    violations=$((violations + 1))
}

# ---------------------------------------------------------------------------
# annotate <file>  — one TSV line per input line: "lineno<TAB>selector<TAB>content"
#
# `content` has CSS comments blanked out (state machine over /* */, so a
# multi-line comment — the pointer comments like "moved to responsive.css per
# Wave 4's single-file @media rule" — never reaches the pattern checks below).
# `selector` is the most recently seen line containing "{", trimmed: cheap
# context for reports and for allowlist patterns, not a real CSS parser (a
# selector list spread over several comma-continued lines collapses to just
# its last line — good enough to identify which rule a hit belongs to).
# ---------------------------------------------------------------------------

annotate() {
    awk '
        function trim(s) { gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
        {
            line = $0
            out = ""
            i = 1
            n = length(line)
            while (i <= n) {
                if (!incomment) {
                    idx = index(substr(line, i), "/*")
                    if (idx == 0) { out = out substr(line, i); i = n + 1 }
                    else { out = out substr(line, i, idx - 1); i = i + idx - 1; incomment = 1 }
                } else {
                    idx = index(substr(line, i), "*/")
                    if (idx == 0) { i = n + 1 }
                    else { i = i + idx + 1; incomment = 0 }
                }
            }
            if (index(out, "{") > 0) {
                sel = out
                sub(/{.*/, "", sel)
                sel = trim(sel)
                if (sel != "") cur_selector = sel
            }
            gsub(/\t/, " ", out)
            printf "%d\t%s\t%s\n", NR, cur_selector, out
        }
    ' "$1"
}

# ---------------------------------------------------------------------------
# check_css_file <path> — invariants 1-3 against one stylesheet
# ---------------------------------------------------------------------------

# Full CSS Color Module named-colour list, used as keyword literals. Excludes
# transparent/currentcolor/inherit/initial/unset/revert/none — those aren't
# colour literals and must never be flagged.
color_keywords='aliceblue|antiquewhite|aqua|aquamarine|azure|beige|bisque|black|blanchedalmond|blue|blueviolet|brown|burlywood|cadetblue|chartreuse|chocolate|coral|cornflowerblue|cornsilk|crimson|cyan|darkblue|darkcyan|darkgoldenrod|darkgray|darkgreen|darkgrey|darkkhaki|darkmagenta|darkolivegreen|darkorange|darkorchid|darkred|darksalmon|darkseagreen|darkslateblue|darkslategray|darkslategrey|darkturquoise|darkviolet|deeppink|deepskyblue|dimgray|dimgrey|dodgerblue|firebrick|floralwhite|forestgreen|fuchsia|gainsboro|ghostwhite|gold|goldenrod|gray|green|greenyellow|grey|honeydew|hotpink|indianred|indigo|ivory|khaki|lavender|lavenderblush|lawngreen|lemonchiffon|lightblue|lightcoral|lightcyan|lightgoldenrodyellow|lightgray|lightgreen|lightgrey|lightpink|lightsalmon|lightseagreen|lightskyblue|lightslategray|lightslategrey|lightsteelblue|lightyellow|lime|limegreen|linen|magenta|maroon|mediumaquamarine|mediumblue|mediumorchid|mediumpurple|mediumseagreen|mediumslateblue|mediumspringgreen|mediumturquoise|mediumvioletred|midnightblue|mintcream|mistyrose|moccasin|navajowhite|navy|oldlace|olive|olivedrab|orange|orangered|orchid|palegoldenrod|palegreen|paleturquoise|palevioletred|papayawhip|peachpuff|peru|pink|plum|powderblue|purple|rebeccapurple|red|rosybrown|royalblue|saddlebrown|salmon|sandybrown|seagreen|seashell|sienna|silver|skyblue|slateblue|slategray|slategrey|snow|springgreen|steelblue|tan|teal|thistle|tomato|turquoise|violet|wheat|white|whitesmoke|yellow|yellowgreen'

check_css_file() {
    local file="$1" is_theme="$2"
    local rel="${file#"$repo_root"/}"
    local tsv
    tsv="$(annotate "$file")"

    if [[ "$is_theme" == "no" ]]; then
        # --- invariant 1: colour literals ---
        # hex
        while IFS=$'\t' read -r lineno selector content; do
            [[ -z "$lineno" ]] && continue
            report "color-literal" "$rel" "$lineno" "$selector" "$(printf '%s' "$content" | sed -e 's/^[[:space:]]*//')"
        done < <(printf '%s\n' "$tsv" | rg -e '#[0-9a-fA-F]{3,8}\b')

        # rgb()/rgba()/hsl()/hsla() with a literal (non-var()) first component
        while IFS=$'\t' read -r lineno selector content; do
            [[ -z "$lineno" ]] && continue
            report "color-literal" "$rel" "$lineno" "$selector" "$(printf '%s' "$content" | sed -e 's/^[[:space:]]*//')"
        done < <(printf '%s\n' "$tsv" | rg -e '\b(rgba?|hsla?)\(\s*[0-9]')

        # named colour keywords used as a value (":" ... keyword ... before ";"/"{"/"}")
        while IFS=$'\t' read -r lineno selector content; do
            [[ -z "$lineno" ]] && continue
            report "color-literal" "$rel" "$lineno" "$selector" "$(printf '%s' "$content" | sed -e 's/^[[:space:]]*//')"
        done < <(printf '%s\n' "$tsv" | rg -i -e ":[^;{}]*\\b(${color_keywords})\\b[^;{}]*;")

        # --- invariant 2: font-family literals ---
        while IFS=$'\t' read -r lineno selector content; do
            [[ -z "$lineno" ]] && continue
            report "font-family" "$rel" "$lineno" "$selector" "$(printf '%s' "$content" | sed -e 's/^[[:space:]]*//')"
        done < <(printf '%s\n' "$tsv" | rg -e 'font-family\s*:' | rg -v -e 'font-family\s*:\s*var\(' -e 'font-family\s*:\s*inherit\b')
    fi

    # --- invariant 3: @media outside responsive.css (checked in every file,
    # including theme.css — there's only one file allowed to have it) ---
    if [[ "$rel" != "docs/styles/responsive.css" ]]; then
        while IFS=$'\t' read -r lineno selector content; do
            [[ -z "$lineno" ]] && continue
            report "media" "$rel" "$lineno" "$selector" "$(printf '%s' "$content" | sed -e 's/^[[:space:]]*//')"
        done < <(printf '%s\n' "$tsv" | rg -e '@media')
    fi
}

# ---------------------------------------------------------------------------
# Run invariants 1-3 over every stylesheet
# ---------------------------------------------------------------------------

while IFS= read -r f; do
    check_css_file "$f" "no"
done < <(find docs/styles -name '*.css' | sort)

while IFS= read -r f; do
    check_css_file "$f" "yes"
done < <(find docs/themes -name 'theme.css' | sort)

# ---------------------------------------------------------------------------
# Invariant 4: no CSS-in-JS under docs/ (excluding vendored/addons dirs)
# ---------------------------------------------------------------------------

js_glob_args=(--glob '*.js' --glob '!docs/external/**' --glob '!docs/compiled/**' --glob '!docs/addons/**')

check_js_pattern() {
    local label="$1" pattern="$2"
    while IFS=: read -r path lineno content; do
        [[ -z "$path" ]] && continue
        local rel="$path"
        local trimmed
        trimmed="$(printf '%s' "$content" | sed -e 's/^[[:space:]]*//')"
        if is_allowed "$rel" "$trimmed"; then
            continue
        fi
        printf '%s:%s: [%s]\n    %s\n' "$rel" "$lineno" "$label" "$trimmed"
        violations=$((violations + 1))
    done < <(rg -n --no-heading "${js_glob_args[@]}" -e "$pattern" docs || true)
}

check_js_pattern "css-in-js" '\.style\.cssText\s*='
check_js_pattern "css-in-js" "createElement\\(['\"]style['\"]\\)"
check_js_pattern "css-in-js" 'adoptedStyleSheets'
check_js_pattern "css-in-js" '\.insertRule\('

# ---------------------------------------------------------------------------

if [[ "$violations" -gt 0 ]]; then
    echo
    echo "css_guard: $violations violation(s) — see tools/ci/css_guard_allow.txt to allowlist a reviewed exception" >&2
    exit 1
fi

echo "css_guard: clean"
exit 0
