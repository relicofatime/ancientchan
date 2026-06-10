#!/usr/bin/env bash
# Estimate remaining time for the archive.org upload (tools/archive-org-upload.sh).
# Samples network egress for 20s and compares it against how many files are left.
#
#   curl -sL https://raw.githubusercontent.com/relicofatime/ancientchan/master/tools/upload-eta.sh | sudo bash

WORK="${WORK:-/root/data}"
LOG="$WORK/upload.log"
TOTAL_FILES=635770
TOTAL_BYTES=238256291840   # heinessen image payload, ~222 GiB

if [ ! -f "$LOG" ]; then
  echo "No $LOG yet — has the upload reached Step 8 (uploading)?"
  exit 1
fi

# Files in buckets that have fully finished (each OK line carries its file count).
DONE_FILES=$(awk '$2=="OK" && $3 ~ /^[0-9]+$/ {s+=$3} END{print s+0}' "$LOG")
DONE_ITEMS=$(grep -c ' OK ' "$LOG" 2>/dev/null || echo 0)
FAILED=$(grep -c ' FAILED$' "$LOG" 2>/dev/null || echo 0)

# Primary network interface, then sample its transmit counter over 20s.
IFACE=$(ip -o -4 route show to default 2>/dev/null | awk '{print $5; exit}')
[ -n "$IFACE" ] || IFACE=eth0
TXP="/sys/class/net/$IFACE/statistics/tx_bytes"
tx1=$(cat "$TXP" 2>/dev/null || echo 0)
sleep 20
tx2=$(cat "$TXP" 2>/dev/null || echo 0)
RATE=$(( (tx2 - tx1) / 20 ))   # bytes/sec out

awk -v df="$DONE_FILES" -v tf="$TOTAL_FILES" -v tb="$TOTAL_BYTES" \
    -v r="$RATE" -v iface="$IFACE" -v items="$DONE_ITEMS" -v failed="$FAILED" 'BEGIN{
  frac   = (tf>0) ? df/tf : 0;
  done_b = tb*frac;
  rem_b  = tb - done_b;
  printf "=== archive.org upload status ===\n";
  printf "items done: %d   (failed so far: %d)\n", items, failed;
  printf "files done: %d / %d   (%.1f%%)\n", df, tf, 100*frac;
  printf "data  done: %.1f / %.1f GB   (estimated)\n", done_b/1e9, tb/1e9;
  printf "egress now: %.2f MB/s on %s\n", r/1e6, iface;
  if (r > 50000) {
    eta = rem_b / r;
    printf "ETA:        ~%dh %02dm   (%.1f GB to go)\n", eta/3600, (eta%3600)/60, rem_b/1e9;
  } else {
    printf "ETA:        looks idle (%.0f KB/s) — either finished or between buckets\n", r/1000;
  }
  printf "(rough: counts only fully-finished buckets, so real progress is a bit ahead)\n";
}'
