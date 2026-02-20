#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

if [[ -z "${VULTR_API_KEY:-}" ]]; then
  echo "error: VULTR_API_KEY is required"
  echo "example: VULTR_API_KEY=... ./scripts/run-delegation-harness.sh"
  exit 1
fi

RUNS="${DELEGATION_HARNESS_RUNS:-2}"
MIN_OPINION_RATE="${DELEGATION_HARNESS_MIN_OPINION_RATE:-0.80}"
MIN_OPINION_PROMPT_RATE="${DELEGATION_HARNESS_MIN_OPINION_PROMPT_RATE:-0.50}"
MAX_SIMPLE_RATE="${DELEGATION_HARNESS_MAX_SIMPLE_RATE:-0.20}"
BASE_URL="${VULTR_BASE_URL:-https://api.vultrinference.com/v1}"

echo "Delegation Regression Harness"
echo "repo: ${REPO_ROOT}"
echo "base_url: ${BASE_URL}"
echo "runs_per_prompt: ${RUNS}"
echo "min_opinion_rate: ${MIN_OPINION_RATE}"
echo "min_opinion_prompt_rate: ${MIN_OPINION_PROMPT_RATE}"
echo "max_simple_rate: ${MAX_SIMPLE_RATE}"
echo
echo "Running go test harness..."

set +e
output="$(
  RUN_DELEGATION_HARNESS=1 \
  DELEGATION_HARNESS_RUNS="${RUNS}" \
  DELEGATION_HARNESS_MIN_OPINION_RATE="${MIN_OPINION_RATE}" \
  DELEGATION_HARNESS_MIN_OPINION_PROMPT_RATE="${MIN_OPINION_PROMPT_RATE}" \
  DELEGATION_HARNESS_MAX_SIMPLE_RATE="${MAX_SIMPLE_RATE}" \
  go test -v -run TestDelegationPolicyHarness_E2E ./... 2>&1
)"
status=$?
set -e

echo "${output}"
echo

summary="$(printf '%s\n' "${output}" | rg -n "delegation harness:" -S || true)"
if [[ -n "${summary}" ]]; then
  echo "Summary:"
  printf '%s\n' "${summary}"
  echo
fi

if [[ ${status} -ne 0 ]]; then
  echo "Result: FAIL"
  exit ${status}
fi

echo "Result: PASS"
