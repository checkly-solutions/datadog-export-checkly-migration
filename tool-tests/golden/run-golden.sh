#!/usr/bin/env bash
#
# run-golden.sh — build a real, testable migrated project from the committed
# golden fixture exports, so you can point `npx checkly test` at known-good
# synthetic data without any live Datadog access.
#
# It seeds tool-tests/fixtures/exports-seed/ into
# checkly-migrated/golden-test/exports/ and runs every OFFLINE pipeline step,
# producing a fully self-contained Checkly CLI project (configs, groups,
# checks, specs, report) at checkly-migrated/golden-test/.
#
# Skipped steps (and why):
#   01  initial-datadog-export     needs live Datadog network access
#   03  filter-multi-step          fixtures are pre-split (api-tests has no
#                                  multi subtype; multi-step-tests.json is seeded)
#   10a check-datadog-test-status  needs live Datadog network access
#   10b deactivate-missing-secrets optional; no live secret data to validate
#
# Usage (from the repo root):
#   ./tool-tests/golden/run-golden.sh
#   cd checkly-migrated/golden-test && npx checkly test        # public checks
#   cd checkly-migrated/golden-test && npm run test:private    # private checks
#
# Output is git-ignored (checkly-migrated/) and safe to delete/regenerate.

set -euo pipefail

# Resolve the repo root from this script's location, so it works no matter
# where it's invoked from (though the intended cwd is the repo root).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

# Fixed account name → output lands at checkly-migrated/golden-test/ only.
export CHECKLY_ACCOUNT_NAME="golden-test"
OUT_DIR="checkly-migrated/${CHECKLY_ACCOUNT_NAME}"
SEED_DIR="tool-tests/fixtures/exports-seed"

echo "▶ Rebuilding ${OUT_DIR} from ${SEED_DIR}"
rm -rf "${OUT_DIR}"
mkdir -p "${OUT_DIR}/exports"
cp "${SEED_DIR}"/* "${OUT_DIR}/exports/"

# The seed intentionally omits global-variables.json (step 01 output). Provide
# an empty stub so step 09 produces valid (empty) variable files offline.
if [ ! -f "${OUT_DIR}/exports/global-variables.json" ]; then
  printf '{"variables":[]}\n' > "${OUT_DIR}/exports/global-variables.json"
fi

# Offline pipeline steps, in strict order. Groups (11) before defaults (10),
# matching migrate:all.
STEPS=(
  "02-convert-datadog-api-to-json"
  "04-generate-api-check-constructs-from-json"
  "04b-generate-tcp-monitor-constructs"
  "04c-generate-dns-monitor-constructs"
  "05-generate-multi-step-specs"
  "06-generate-multi-step-constructs"
  "07-generate-browser-specs"
  "08-generate-browser-constructs"
  "09-convert-global-variables"
  "11-generate-groups"
  "10-add-default-resources"
  "12-generate-migration-report"
)

for step in "${STEPS[@]}"; do
  echo "▶ ${step}"
  node --import jiti/register "src/${step}.ts" > /dev/null
done

echo ""
echo "✅ Golden project ready at ${OUT_DIR}"
echo "   Verify it live yourself:"
echo "     cd ${OUT_DIR} && npm run test:public     # 6 public checks (works as-is)"
echo "     cd ${OUT_DIR} && npm run test:private    # needs a private location"
echo "                                              named 'example-private' in your account"
