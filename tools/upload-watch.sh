#!/usr/bin/env bash
# Live dashboard for the archive.org upload. Refreshes every 30s.
# Ctrl-C exits the WATCHER only — the upload service is untouched.
#
#   curl -sL https://raw.githubusercontent.com/relicofatime/ancientchan/master/tools/upload-watch.sh | sudo bash

WORK="${WORK:-/root/data}"
LOG="$WORK/upload.log"
TOTAL_BYTES=238256291840   # heinessen payload, ~222 GiB
TOTAL_FILES=635770

TOTAL_ITEMS=$(find "$WORK/sorted" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
[ "$TOTAL_ITEMS" -gt 0 ] || TOTAL_ITEMS=31

IFACE=$(ip -o -4 route show to default 2>/dev/null | awk '{print $5; exit}')
[ -n "$IFACE" ] || IFACE=eth0
TXP="/sys/class/net/$IFACE/statistics/tx_bytes"

while true; do
  tx1=$(cat "$TXP" 2>/dev/null || echo 0)
  sleep 30   # doubles as the egress sampling window
  tx2=$(cat "$TXP" 2>/dev/null || echo 0)
  rate=$(( (tx2 - tx1) / 30 ))

  ok=$(grep -c ' OK ' "$LOG" 2>/dev/null); ok=${ok:-0}
  fail=$(grep -c ' FAILED$' "$LOG" 2>/dev/null); fail=${fail:-0}
  done_files=$(awk '$2=="OK" && $3 ~ /^[0-9]+$/ {s+=$3} END{print s+0}' "$LOG" 2>/dev/null)

  clear 2>/dev/null || printf '\n\n──────────────────────────────\n'
  echo "═══ /mlp/ → archive.org upload ═══  $(date '+%H:%M:%S')"
  svc=$(systemctl is-active mlp-upload 2>/dev/null)
  echo "service: $svc"
  echo "months:  $ok / $TOTAL_ITEMS done   ($fail failed)"
  awk -v df="$done_files" -v tf="$TOTAL_FILES" -v tb="$TOTAL_BYTES" -v r="$rate" 'BEGIN{
    frac = (tf>0) ? df/tf : 0;
    rem  = tb * (1 - frac);
    printf "files:   %d / %d   (%.1f%%)\n", df, tf, 100*frac;
    printf "egress:  %.2f MB/s\n", r/1e6;
    if (r > 50000) printf "ETA:     ~%dh %02dm   (%.1f GB to go)\n", rem/r/3600, int(rem/r)%3600/60, rem/1e9;
    else           printf "ETA:     (idle this sample — zipping, finished, or between months)\n";
  }'
  echo ""
  echo "── workers (latest activity) ──"
  journalctl -u mlp-upload --no-pager -n 300 -o cat 2>/dev/null | \
    grep -E '(Zipping|Uploading) [0-9]{4}-[0-9]{2}|done\.$|FAILED' | tail -6
  echo ""
  echo "── last finished months ──"
  grep ' OK ' "$LOG" 2>/dev/null | tail -3
  if [ "$svc" != "active" ]; then
    echo ""
    echo "Service is '$svc' — upload finished (or stopped). Ctrl-C to exit watcher."
  fi
done
