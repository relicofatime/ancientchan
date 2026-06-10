#!/usr/bin/env bash
set -euo pipefail

# ─── ancientchan /mlp/ image archive uploader ───────────────────────────
# Run on a cloud VM (Azure/GCP/etc) with ≥1.5TB disk.
#
# Downloads the /mlp/ image torrent, sorts files into year-month buckets,
# computes MD5 hashes, builds a JSON index, and uploads everything to
# archive.org as separate items (≤10k files each).
#
# Fully resumable — checkpoint files track progress so you can re-run
# after any interruption. Run inside tmux so SSH drops don't kill it:
#
#   tmux new -s upload
#   export IA_ACCESS=your_key  IA_SECRET=your_secret
#   bash archive-org-upload.sh
#
# Get API keys from https://archive.org/account/s3.php

MAGNET='magnet:?xt=urn:btih:9671fb0855c7931fe98f03f7612c18010fb10121&dn=4chan-mlp&tr=udp%3a%2f%2fopen.stealth.si%3a80%2fannounce&tr=udp%3a%2f%2ftracker1.bt.moack.co.kr%3a80%2fannounce&tr=udp%3a%2f%2ftracker.theoks.net%3a6969%2fannounce&tr=udp%3a%2f%2ftracker.4.babico.name.tr%3a3131%2fannounce&tr=udp%3a%2f%2ftracker.openbittorrent.com%3a6969%2fannounce&tr=http%3a%2f%2ftracker.openbittorrent.com%3a80%2fannounce&tr=https%3a%2f%2ftracker1.520.jp%3a443%2fannounce&tr=udp%3a%2f%2fopen.demonii.com%3a1337%2fannounce&tr=udp%3a%2f%2ftracker.tiny-vps.com%3a6969%2fannounce&tr=udp%3a%2f%2fsanincode.com%3a6969%2fannounce&tr=udp%3a%2f%2ftracker.opentrackr.org%3a1337%2fannounce&tr=udp%3a%2f%2fuploads.gamecoast.net%3a6969%2fannounce&tr=udp%3a%2f%2fexodus.desync.com%3a6969%2fannounce&tr=udp%3a%2f%2fexplodie.org%3a6969%2fannounce&tr=udp%3a%2f%2fmovies.zsw.ca%3a6969%2fannounce'

WORK=${WORK:-/root/data}
TORRENT_DIR="$WORK/torrent"
SORTED_DIR="$WORK/sorted"
HASH_FILE="$WORK/all-md5.txt"
INDEX_FILE="$WORK/md5-index.json"
COLLECTION="4chan-mlp-archive"
UPLOAD_LOG="$WORK/upload.log"
MAX_PER_ITEM=10000
PARALLEL_UPLOADS=${PARALLEL_UPLOADS:-3}   # concurrent archive.org item uploads

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# ─── Step 0: Install dependencies ───────────────────────────────────
log "=== Step 0: Dependencies ==="
# systemd-run / cron start with no HOME; pip --user and the ia CLI both need
# it. Default to root's home so the script works outside a login shell.
export HOME="${HOME:-/root}"
mkdir -p "$WORK"
sudo apt-get update -qq
sudo apt-get install -y -qq aria2 python3-pip jq zip
pip3 install --quiet --break-system-packages internetarchive
export PATH="$HOME/.local/bin:$PATH"

# ─── Step 1: Configure archive.org ──────────────────────────────────
log "=== Step 1: Configure archive.org ==="
if [ -z "${IA_ACCESS:-}" ] || [ -z "${IA_SECRET:-}" ]; then
  echo "ERROR: Set IA_ACCESS and IA_SECRET before running."
  echo "  Get keys from https://archive.org/account/s3.php"
  echo "  export IA_ACCESS=your_access_key"
  echo "  export IA_SECRET=your_secret_key"
  exit 1
fi
mkdir -p ~/.config/internetarchive
cat > ~/.config/internetarchive/ia.ini <<IAEOF
[s3]
access = $IA_ACCESS
secret = $IA_SECRET
IAEOF
log "archive.org configured."

# ─── Step 2: Download torrent ────────────────────────────────────────
log "=== Step 2: Download torrent ==="
mkdir -p "$TORRENT_DIR"
if [ -n "${SKIP_TORRENT:-}" ]; then
  log "SKIP_TORRENT set — skipping torrent download (using whatever is in $WORK/extracted)."
elif [ -f "$WORK/.torrent-done" ]; then
  log "Torrent already downloaded, skipping."
else
  log "Starting torrent download (this will take hours)..."
  aria2c --seed-time=0 --max-concurrent-downloads=5 --split=5 \
    --dir="$TORRENT_DIR" --continue=true \
    --bt-save-metadata=true --bt-stop-timeout=0 --summary-interval=30 \
    "$MAGNET"
  touch "$WORK/.torrent-done"
  log "Torrent download complete."
fi

# ─── Step 3: Extract .car archives if present ───────────────────────
log "=== Step 3: Extract .car archives ==="
EXTRACT_DIR="$WORK/extracted"
CAR_COUNT=$(find "$TORRENT_DIR" -name "*.car" -type f 2>/dev/null | wc -l)

if [ -n "${SKIP_TORRENT:-}" ]; then
  log "SKIP_TORRENT set — skipping .car extraction (torrent files may be incomplete)."
elif [ "$CAR_COUNT" -gt 0 ]; then
  if [ -f "$WORK/.extract-done" ]; then
    log "Already extracted, skipping."
  else
    log "Found $CAR_COUNT .car files. Installing extractor..."
    sudo apt-get install -y -qq golang-go
    GOBIN="$WORK/gobin" go install github.com/ipld/go-car/cmd/car@latest 2>/dev/null || \
    GOBIN="$WORK/gobin" go install github.com/ipld/go-car/v2/cmd/car@latest 2>/dev/null || true
    CAR_BIN="$WORK/gobin/car"

    if [ ! -x "$CAR_BIN" ]; then
      log "go-car install failed, trying npm ipfs-car..."
      sudo apt-get install -y -qq nodejs npm
      npm install -g ipfs-car 2>/dev/null || true
      CAR_BIN=""
    fi

    mkdir -p "$EXTRACT_DIR"

    # Print the real CLI of whatever extractor we installed so any failure is
    # debuggable from the log (the old version hid all errors in /dev/null).
    if [ -n "$CAR_BIN" ] && [ -x "$CAR_BIN" ]; then
      log "go-car version + extract usage:"
      "$CAR_BIN" version 2>&1 | sed 's/^/    /' || true
      "$CAR_BIN" extract --help 2>&1 | sed 's/^/    /' || true
    fi

    # Try the known invocations in order; stderr stays visible so we can see
    # exactly why a file fails instead of silently ending up with 0 results.
    extract_one() {
      local carfile="$1"
      if [ -n "$CAR_BIN" ] && [ -x "$CAR_BIN" ]; then
        "$CAR_BIN" extract -f "$carfile" "$EXTRACT_DIR"    2>&1 && return 0
        "$CAR_BIN" extract -f "$carfile" -o "$EXTRACT_DIR" 2>&1 && return 0
        "$CAR_BIN" extract "$carfile" "$EXTRACT_DIR"       2>&1 && return 0
      else
        ipfs-car unpack "$carfile" --output "$EXTRACT_DIR" 2>&1 && return 0
      fi
      return 1
    }

    # Validate on ONE file before committing to all of them — fail loudly.
    first_car=$(find "$TORRENT_DIR" -name "*.car" -type f | sort | head -1)
    before=$(find "$EXTRACT_DIR" -type f | wc -l)
    log "Test-extracting first file: $first_car"
    if extract_one "$first_car"; then
      after=$(find "$EXTRACT_DIR" -type f | wc -l)
      if [ "$after" -le "$before" ]; then
        log "WARNING: extractor exited 0 but produced no files. These .car files may"
        log "         not be UnixFS-encoded, or this one is incomplete. Stopping."
        exit 1
      fi
      log "Test extraction OK ($((after - before)) files from first .car)."
    else
      log "ERROR: could not extract $first_car (see go-car error above)."
      log "       Fix the extractor invocation, then re-run. Not bulk-extracting."
      exit 1
    fi

    EXTRACTED=0
    while IFS= read -r -d '' carfile; do
      extract_one "$carfile" >/dev/null || log "  WARN: failed to extract $carfile"
      EXTRACTED=$((EXTRACTED + 1))
      [ $((EXTRACTED % 25)) -eq 0 ] && log "  extracted $EXTRACTED / $CAR_COUNT .car files..."
    done < <(find "$TORRENT_DIR" -name "*.car" -type f -print0 | sort -z)

    EXTRACTED_COUNT=$(find "$EXTRACT_DIR" -type f 2>/dev/null | wc -l)
    log "Extraction complete: $EXTRACTED .car processed → $EXTRACTED_COUNT output files."
    touch "$WORK/.extract-done"
  fi
fi

# ─── Step 4: Find image root ────────────────────────────────────────
log "=== Step 4: Locate image files ==="
# Prefer extracted .car contents, fall back to raw torrent files
if [ -d "$EXTRACT_DIR" ] && [ "$(find "$EXTRACT_DIR" -type f | head -1)" ]; then
  IMG_ROOT="$EXTRACT_DIR"
  log "Using extracted .car contents."
else
  IMG_ROOT=$(find "$TORRENT_DIR" -type d -name "image" 2>/dev/null | head -1 || true)
  [ -z "$IMG_ROOT" ] && IMG_ROOT=$(find "$TORRENT_DIR" -maxdepth 2 -type d 2>/dev/null | head -1)
fi
log "Image root: $IMG_ROOT"

TOTAL=$(find "$IMG_ROOT" -type f \( -name "*.jpg" -o -name "*.jpeg" -o -name "*.png" -o -name "*.gif" -o -name "*.webm" -o -name "*.webp" \) | wc -l)
log "Found $TOTAL image files."

# ─── Step 5: Sort into year-month buckets ────────────────────────────
log "=== Step 5: Sort into year-month buckets ==="
if [ -f "$WORK/.sort-done" ]; then
  log "Already sorted, skipping."
else
  mkdir -p "$SORTED_DIR"
  COUNT=0
  while IFS= read -r -d '' filepath; do
    filename=$(basename "$filepath")
    # Filenames are Unix timestamps: 1371234567890.png
    ts=$(echo "$filename" | grep -oP '^\d{10,13}' || true)
    if [ -n "$ts" ]; then
      [ "${#ts}" -gt 10 ] && ts="${ts:0:10}"
      ym=$(date -d "@$ts" +%Y-%m 2>/dev/null || echo "unknown")
    else
      ym="unknown"
    fi
    mkdir -p "$SORTED_DIR/$ym"
    ln "$filepath" "$SORTED_DIR/$ym/$filename" 2>/dev/null || true
    COUNT=$((COUNT + 1))
    if [ $((COUNT % 25000)) -eq 0 ]; then
      log "  sorted $COUNT / $TOTAL ..."
    fi
  done < <(find "$IMG_ROOT" -type f \( -name "*.jpg" -o -name "*.jpeg" -o -name "*.png" -o -name "*.gif" -o -name "*.webm" -o -name "*.webp" \) -print0)
  touch "$WORK/.sort-done"
  log "Sorting complete: $COUNT files into $(find "$SORTED_DIR" -mindepth 1 -maxdepth 1 -type d | wc -l) buckets."
fi

# ─── Step 6: Compute MD5 hashes ─────────────────────────────────────
log "=== Step 6: Compute MD5 hashes ==="
if [ -f "$WORK/.hash-done" ]; then
  log "Hashes already computed, skipping."
else
  log "Hashing all files (parallel across $(nproc) cores)..."
  find "$SORTED_DIR" -type f -print0 | xargs -0 -P"$(nproc)" md5sum > "$HASH_FILE"
  HASH_COUNT=$(wc -l < "$HASH_FILE")
  log "Hashing complete: $HASH_COUNT files."
  touch "$WORK/.hash-done"
fi

# ─── Step 7: Build JSON index ───────────────────────────────────────
log "=== Step 7: Build MD5 JSON index ==="
if [ -f "$WORK/.index-done" ]; then
  log "Index already built, skipping."
else
  log "Converting hashes to JSON index..."
  python3 - "$HASH_FILE" "$INDEX_FILE" "$SORTED_DIR" <<'PYEOF'
import sys, base64, json, os

hash_file, index_file, sorted_dir = sys.argv[1], sys.argv[2], sys.argv[3]
index = {}
count = 0

with open(hash_file) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        # md5sum output: "hexhash  /path/to/file"
        parts = line.split("  ", 1)
        if len(parts) != 2:
            continue
        md5hex, path = parts
        basename = os.path.basename(path)
        bucket = os.path.basename(os.path.dirname(path))
        # Convert hex MD5 to base64 (matches desuarchive media_hash)
        md5bytes = bytes.fromhex(md5hex)
        md5b64 = base64.b64encode(md5bytes).decode()
        index[md5b64] = f"{bucket}/{basename}"
        count += 1
        if count % 100000 == 0:
            print(f"  indexed {count} files...")

with open(index_file, "w") as f:
    json.dump(index, f, separators=(",", ":"))

size_mb = os.path.getsize(index_file) / (1024 * 1024)
print(f"Index complete: {count} entries, {size_mb:.1f} MB")
PYEOF
  touch "$WORK/.index-done"
  log "Index written to $INDEX_FILE"
fi

# ─── Step 8: Upload buckets to archive.org ───────────────────────────
log "=== Step 8: Upload image buckets ==="
touch "$UPLOAD_LOG"

BUCKET_TOTAL=$(find "$SORTED_DIR" -mindepth 1 -maxdepth 1 -type d | wc -l)
BUCKET_NUM=0

# archive.org throttles per REQUEST, not per byte. Uploading 635k loose
# files = 635k throttled requests (we measured hundreds of SlowDowns). So we
# bundle each month into ONE stored (uncompressed) zip and upload that —
# ~31 requests instead of 635k. archive.org indexes the zip and serves each
# image individually at:
#   https://archive.org/download/<item>/<YYYY-MM>.zip/<filename>
# which is exactly what the userscript builds from the md5 index.
ZIP_DIR="$WORK/zips"
mkdir -p "$ZIP_DIR"

process_bucket() {
  local bucket_dir="$1" bucket_num="$2"
  local bucket file_count item_id zipfile
  bucket=$(basename "$bucket_dir")
  file_count=$(find "$bucket_dir" -maxdepth 1 -type f | wc -l)
  item_id="${COLLECTION}-${bucket}"
  zipfile="$ZIP_DIR/${bucket}.zip"
  log "[$bucket_num/$BUCKET_TOTAL] Bucket $bucket: $file_count files"

  # Skip if this exact month (by file count) already uploaded.
  if grep -q "^${item_id} OK ${file_count}$" "$UPLOAD_LOG" 2>/dev/null; then
    log "  $item_id already uploaded ($file_count files), skipping."
    return 0
  fi

  # Build a stored (-0, no compression) zip of just the filenames. -@ reads
  # the file list on stdin to avoid ARG_MAX on 10k+ file months. Rebuild from
  # scratch so a half-written zip from a previous crash can't corrupt it.
  rm -f "$zipfile"
  log "  Zipping $bucket ($file_count files, stored)..."
  if ! (cd "$bucket_dir" && find . -maxdepth 1 -type f -printf '%P\n' | \
        zip -0 -q "$zipfile" -@); then
    log "  $item_id FAILED (zip) — will retry on next run."
    echo "$item_id FAILED" >> "$UPLOAD_LOG"
    rm -f "$zipfile"
    return 1
  fi

  log "  Uploading $item_id ($(du -h "$zipfile" | cut -f1) zip)..."
  if ia upload "$item_id" "$zipfile" \
        --metadata="collection:opensource" \
        --metadata="mediatype:image" \
        --metadata="title:4chan /mlp/ archived images ($bucket)" \
        --metadata="description:Archived full-size images from 4chan /mlp/, $bucket. Stored zip; archive.org serves each image at /download/$item_id/${bucket}.zip/<filename>. Part of the $COLLECTION collection." \
        --metadata="subject:4chan;mlp;archive;imageboard" \
        --metadata="creator:anonymous" \
        --retries=8 --no-derive; then
    echo "$item_id OK $file_count" >> "$UPLOAD_LOG"
    log "  $item_id done."
    rm -f "$zipfile"   # reclaim disk as we go
    return 0
  else
    echo "$item_id FAILED" >> "$UPLOAD_LOG"
    log "  $item_id FAILED (upload) — will retry on next run."
    rm -f "$zipfile"
    return 1
  fi
}

# A few months in parallel. Each is now a single big object, so even 2-3
# concurrent uploads stay well under archive.org's request-rate limit.
for bucket_dir in "$SORTED_DIR"/*/; do
  [ -d "$bucket_dir" ] || continue
  BUCKET_NUM=$((BUCKET_NUM + 1))
  process_bucket "$bucket_dir" "$BUCKET_NUM" &
  while [ "$(jobs -rp | wc -l)" -ge "$PARALLEL_UPLOADS" ]; do
    wait -n || true   # a failed bucket is logged FAILED and retried next run
  done
done
wait
log "All bucket uploads finished."

# ─── Step 9: Upload MD5 index ───────────────────────────────────────
log "=== Step 9: Upload MD5 index ==="
# Keyed on the index file's own hash: re-uploads whenever the index changes.
INDEX_MD5=$(md5sum "$INDEX_FILE" | cut -d' ' -f1)
if grep -q "^${COLLECTION}-index OK ${INDEX_MD5}$" "$UPLOAD_LOG" 2>/dev/null; then
  log "Index already uploaded (unchanged), skipping."
else
  ia upload "${COLLECTION}-index" "$INDEX_FILE" \
    --metadata="collection:opensource" \
    --metadata="mediatype:data" \
    --metadata="title:4chan /mlp/ archive - MD5 index" \
    --metadata="description:JSON mapping of base64 MD5 hashes to archive.org file paths. Keys are base64-encoded MD5 hashes (matching desuarchive media_hash). Values are 'YYYY-MM/filename' paths. Used by ancientchan userscript to resolve dead images." \
    --metadata="subject:4chan;mlp;archive;index" \
    --retries=5 \
    && echo "${COLLECTION}-index OK ${INDEX_MD5}" >> "$UPLOAD_LOG"
  log "Index uploaded."
fi

# ─── Done ────────────────────────────────────────────────────────────
echo ""
log "════════════════════════════════════════════════════"
log "  UPLOAD COMPLETE"
log "════════════════════════════════════════════════════"
echo ""

OK_COUNT=$(grep -c " OK " "$UPLOAD_LOG" 2>/dev/null || echo 0)
FAIL_COUNT=$(grep -c " FAILED$" "$UPLOAD_LOG" 2>/dev/null || echo 0)
log "Results: $OK_COUNT succeeded, $FAIL_COUNT failed"
[ "$FAIL_COUNT" -gt 0 ] && log "Re-run this script to retry failed uploads."

echo ""
log "Index URL:"
log "  https://archive.org/download/${COLLECTION}-index/md5-index.json"
log ""
log "Image URL pattern:"
log "  https://archive.org/download/${COLLECTION}-YYYY-MM/TIMESTAMP.EXT"
log "  (or ${COLLECTION}-YYYY-MM-partN for split months)"
log ""
log "Upload log: $UPLOAD_LOG"
log "You can now delete this VM to stop charges."
