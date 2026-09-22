#!/bin/bash
# Contract tests for the HARD threshold of scripts/memory-index-gate.sh
# (MEMHARD922).
#
# WHY THIS FILE EXISTS
# --------------------
# The gate carries two size thresholds and they mean different things:
#
#   WARN = 20000 B -- cut soon, nothing is lost yet
#   HARD = 24400 B -- the end of the index is ALREADY not being loaded
#
# Both wake the runner, so the wake alone cannot tell them apart; the only place
# the difference survives is the `over_hard` field in the state file. Measured
# 2026-09-22: before this file, `over_hard` appeared in the suites three times
# and every one of them asserted `false`, and no fixture anywhere was larger
# than HARD. The verdict that means "data is already gone" -- the whole reason
# the card exists -- was the one verdict nothing exercised.
#
# That is the same shape as the defect the gate was built for: the failure is
# silent, so the absence of a complaint proves nothing. A threshold nobody
# crosses in a test is a number in a comment.
#
# WHAT IS PINNED HERE
#   1. Over HARD: over_hard is true, and the run wakes.
#   2. Just under HARD but over WARN: over_hard is false, and it STILL wakes --
#      so a later change cannot buy a quiet `false` by moving the wake.
#   3. The boundary is `>`, not `>=`: exactly HARD bytes is not yet over.
#   4. The running maximum keeps the peak's over-HARD size after the index is
#      cut back, so a cut cannot hide that the limit was crossed.
#
# Every case runs on fixtures through MEMORY_INDEX_PATH / MEMORY_INDEX_STATE, so
# the live index and the live state file are never touched.
# Run: bash scripts/__tests__/memory-index-gate-hard-threshold.test.sh

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- got: $2"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
# Overridable so the suite can be pointed at a deliberately-broken copy to
# confirm it actually fails on the bug (a green test that cannot go red is
# worse than no test -- it certifies health it never checked).
GATE="${GATE_BIN:-$INSTALL_DIR/scripts/memory-index-gate.sh}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ ! -f "$GATE" ]; then
  echo "FAIL: gate not found at $GATE"
  exit 1
fi
command -v jq >/dev/null 2>&1 || { echo "FAIL: jq is required by the gate and by this suite"; exit 1; }

# The thresholds are read back OUT of the state file rather than written here a
# second time: a copy would keep passing after someone moved the real ones.
IDX="$TMP/MEMORY.md"
# $1 = target size in bytes. Builds a well-formed index of exactly that size:
# the hot-section boundary is present and every line stays under LINEWARN, so
# the only reason this fixture can wake is its SIZE. The filler is ASCII on
# purpose -- the gate measures bytes, and accented padding would make the
# fixture's size depend on the encoding rather than on the line count.
build_index() {
  local want="$1"
  {
    echo "# Forro bejegyzesek"
    echo "- egy rovid sor"
    echo "# Téma-hubok"
    echo "- [hub](hub.md)"
  } > "$IDX"
  local line="- filler line kept well under the hot-line warning threshold."
  # The filler is emitted in ONE pass: a loop that re-measured the file after
  # every appended line cost ~350 `wc` subprocesses per fixture and made this
  # suite eight times slower than its neighbours in CI.
  local have need
  have="$(wc -c < "$IDX" | tr -d ' ')"
  need=$(( (want - have) / (${#line} + 1) + 1 ))
  if [ "$need" -gt 0 ]; then
    awk -v n="$need" -v l="$line" 'BEGIN { for (i = 0; i < n; i++) print l }' >> "$IDX"
  fi
  # Trim to the exact byte count so boundary cases are exact, not approximate.
  local cur
  cur="$(wc -c < "$IDX" | tr -d ' ')"
  if [ "$cur" -gt "$want" ]; then
    dd if="$IDX" of="$IDX.cut" bs="$want" count=1 2>/dev/null
    mv "$IDX.cut" "$IDX"
  fi
  wc -c < "$IDX" | tr -d ' '
}
# The hub the fixture index points at has to EXIST on disk: the gate also counts
# dangling `](...md)` targets, and a pointer to nowhere would wake on that --
# turning a size case red for a reason that has nothing to do with size.
echo "hub tartalom" > "$TMP/hub.md"

# The link checker is pinned to the INSTALL, not to wherever $GATE happens to
# live. Without this, a GATE_BIN copy in a temp directory resolves its checker
# relative to that directory, does not find it, and fail-opens into a wake --
# so every mutation run would also fail the two SKIP cases, for a reason that
# has nothing to do with the mutation. Measured while mutation-proving this
# file: three mutants each showed two such extra failures.
LINKCHECK="$INSTALL_DIR/scripts/memory-index-linkcheck.py"
run_gate() {
  MEMORY_INDEX_PATH="$IDX" MEMORY_INDEX_STATE="$1" MEMORY_LINKCHECK_BIN="$LINKCHECK" bash "$GATE" 2>/dev/null
}
jqv() { jq -r "$2" "$1" 2>/dev/null; }

echo "memory-index-gate HARD threshold tests"
echo "======================================"
echo ""

# Read the live thresholds once, from a run the gate itself performed.
S="$TMP/probe.json"; rm -f "$S"
build_index 100 > /dev/null
run_gate "$S" > /dev/null
HARD="$(jqv "$S" .hard)"
WARN="$(jqv "$S" .warn)"
case "$HARD" in ''|null|*[!0-9]*) echo "FAIL: the gate did not report a numeric hard threshold"; exit 1 ;; esac
case "$WARN" in ''|null|*[!0-9]*) echo "FAIL: the gate did not report a numeric warn threshold"; exit 1 ;; esac
echo "  thresholds read from the gate: WARN=$WARN HARD=$HARD"
if [ "$HARD" -gt "$WARN" ]; then
  pass "HARD is above WARN (otherwise the two cases below would not be distinguishable)"
else
  fail "HARD is above WARN" "warn=$WARN hard=$HARD"
fi
echo ""

# ---------------------------------------------------------------------------
# (a) EMPTY CHECK FIRST: a small index must NOT report over_hard, and must not
#     wake on size. Without this, every assertion below could pass on a gate
#     that reports `true` unconditionally.
# ---------------------------------------------------------------------------
echo "(a) Well under WARN: no over_hard, no wake"
S="$TMP/a.json"; rm -f "$S"
SIZE="$(build_index 500)"
OUT="$(run_gate "$S")"
if [ "$(jqv "$S" .over_hard)" = false ]; then pass "over_hard is false, size=$SIZE"; else fail "over_hard is false" "$(cat "$S")"; fi
if [ "$OUT" = "SKIP" ]; then pass "the run does not wake (stdout SKIP)"; else fail "the run does not wake" "stdout='$OUT'"; fi
echo ""

# ---------------------------------------------------------------------------
# (b) OVER WARN, UNDER HARD: wakes, but over_hard stays false. This is the case
#     the suites already had; it is repeated here as the control that gives (c)
#     its meaning -- "wakes" alone does not distinguish the two thresholds.
# ---------------------------------------------------------------------------
echo "(b) Over WARN, under HARD: wakes, over_hard still false"
S="$TMP/b.json"; rm -f "$S"
SIZE="$(build_index $((WARN + 200)))"
OUT="$(run_gate "$S")"
if [ -z "$OUT" ]; then pass "the run wakes (empty stdout), size=$SIZE"; else fail "the run wakes" "stdout='$OUT'"; fi
if [ "$(jqv "$S" .over_hard)" = false ] && [ "$SIZE" -lt "$HARD" ]; then
  pass "over_hard is false below the hard limit"
else
  fail "over_hard is false below the hard limit" "$(cat "$S")"
fi
echo ""

# ---------------------------------------------------------------------------
# (c) THE DIRECTION NOTHING EXERCISED: over HARD, the state says so.
# ---------------------------------------------------------------------------
echo "(c) Over HARD: over_hard is true, and the run wakes"
S="$TMP/c.json"; rm -f "$S"
SIZE="$(build_index $((HARD + 600)))"
OUT="$(run_gate "$S")"
if [ "$(jqv "$S" .over_hard)" = true ]; then
  pass "over_hard is true, size=$SIZE (hard=$HARD)"
else
  fail "over_hard is true above the hard limit" "$(cat "$S")"
fi
if [ -z "$OUT" ]; then pass "the run wakes (empty stdout)"; else fail "the run wakes" "stdout='$OUT'"; fi
if [ "$(jqv "$S" .size)" = "$SIZE" ]; then pass "the reported size is the measured one"; else fail "the reported size is the measured one" "$(cat "$S")"; fi
echo ""

# ---------------------------------------------------------------------------
# (d) THE BOUNDARY IS `>`, NOT `>=`. Exactly HARD bytes is the last size that is
#     still not over. Pinned because an off-by-one here is invisible in use: it
#     would only ever show up as one report that says the wrong thing.
# ---------------------------------------------------------------------------
echo "(d) Exactly HARD bytes is not yet over; one byte more is"
S="$TMP/d1.json"; rm -f "$S"
SIZE="$(build_index "$HARD")"
run_gate "$S" > /dev/null
if [ "$SIZE" = "$HARD" ] && [ "$(jqv "$S" .over_hard)" = false ]; then
  pass "exactly $HARD B: over_hard is false"
else
  fail "exactly the hard limit is not over" "size=$SIZE $(cat "$S")"
fi
S="$TMP/d2.json"; rm -f "$S"
SIZE="$(build_index $((HARD + 1)))"
run_gate "$S" > /dev/null
if [ "$SIZE" = $((HARD + 1)) ] && [ "$(jqv "$S" .over_hard)" = true ]; then
  pass "$((HARD + 1)) B: over_hard is true"
else
  fail "one byte over the hard limit is over" "size=$SIZE $(cat "$S")"
fi
echo ""

# ---------------------------------------------------------------------------
# (e) A CUT MUST NOT ERASE THE EVIDENCE. The running maximum exists so that a
#     crossing stays visible after someone trims the file -- which is exactly
#     what happens minutes after the wake. If the peak were lost, the only
#     record that the limit was ever crossed would be gone with it.
# ---------------------------------------------------------------------------
echo "(e) After a cut back under WARN, the peak still shows the crossing"
S="$TMP/e.json"; rm -f "$S"
PEAK="$(build_index $((HARD + 900)))"
run_gate "$S" > /dev/null
SMALL="$(build_index 800)"
OUT="$(run_gate "$S")"
if [ "$(jqv "$S" .size)" = "$SMALL" ] && [ "$(jqv "$S" .max_seen)" = "$PEAK" ]; then
  pass "size follows the cut ($SMALL), max_seen keeps the peak ($PEAK)"
else
  fail "the peak survives the cut" "$(cat "$S")"
fi
# The CURRENT verdict is about the current size, so it goes back to false --
# stated explicitly, because "the peak is remembered" could otherwise be read
# as "the alarm stays on".
if [ "$(jqv "$S" .over_hard)" = false ] && [ "$OUT" = "SKIP" ]; then
  pass "the current verdict follows the current size (over_hard false, SKIP)"
else
  fail "the current verdict follows the current size" "over_hard=$(jqv "$S" .over_hard) stdout='$OUT'"
fi
echo ""

echo "======================================"
echo "PASS: $PASS  FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
