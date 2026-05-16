#!/usr/bin/env bash
# Catch MDX patterns that crash Mintlify's parser. Run locally before
# committing docs, and from CI on every PR + main push.
#
# Why: Mintlify uses an MDX parser that reads `<` followed by a digit as
# the start of a malformed JSX tag and refuses to publish the page. The
# /ai-providers page was silently 404 for a week because of a single
# "<500 ms" in body text.
#
# Run: bash scripts/lint-docs.sh

set -euo pipefail

docs_root="docs-site"
exit_code=0

if [ ! -d "$docs_root" ]; then
  echo "lint-docs: $docs_root not found — skipping"
  exit 0
fi

# 1) `<` followed by a digit — MDX reads as a malformed JSX tag.
#    Use `<digit` only inside fenced code blocks, or rewrite ("under 500", "less than 5").
while IFS=: read -r file line text; do
  echo "::error file=$file,line=$line::MDX parse hazard: '<' followed by digit will be read as JSX. Use 'under N' or fenced code. Found: $text"
  exit_code=1
done < <(grep -rnE '<[0-9]' "$docs_root" --include='*.mdx' --include='*.md' || true)

if [ $exit_code -eq 0 ]; then
  echo "lint-docs: ok"
fi

exit $exit_code
