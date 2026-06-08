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

WORK=/mnt/data
TORRENT_DIR="$WORK/torrent"
SORTED_DIR="$WORK/sorted"
HASH_FILE="$WORK/all-md5.txt"
INDEX_FILE="$WORK/md5-index.json"
COLLECTION="4chan-mlp-archive"
UPLOAD_LOG="$WORK/upload.log"
MAX_PER_ITEM=10000

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# ─── Step 0: Install dependencies ───────────────────────────────────
log "=== Step 0: Dependencies ==="
mkdir -p "$WORK"
sudo apt-get update -qq
sudo apt-get install -y -qq aria2 python3-pip jq
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
if [ -f "$WORK/.torrent-done" ]; then
  log "Torrent already downloaded, skipping."
else
  log "Starting torrent download (this will take hours)..."
  aria2c --seed-time=0 --max-concurrent-downloads=5 --split=5 \
    --dir="$TORRENT_DIR" --continue=true \
    --bt-save-metadata=true --bt-stop-timeout=600 \
    "$MAGNET"
  touch "$WORK/.torrent-done"
  log "Torrent download complete."
fi

# ─── Step 3: Find image root ────────────────────────────────────────
log "=== Step 3: Locate image files ==="
IMG_ROOT=$(find "$TORRENT_DIR" -type d -name "image" 2>/dev/null | head -1 || true)
if [ -z "$IMG_ROOT" ]; then
  IMG_ROOT=$(find "$TORRENT_DIR" -maxdepth 2 -type d 2>/dev/null | head -1)
fi
log "Image root: $IMG_ROOT"

TOTAL=$(find "$IMG_ROOT" -type f \( -name "*.jpg" -o -name "*.jpeg" -o -name "*.png" -o -name "*.gif" -o -name "*.webm" -o -name "*.webp" \) | wc -l)
log "Found $TOTAL image files."

# ─── Step 4: Sort into year-month buckets ────────────────────────────
log "=== Step 4: Sort into year-month buckets ==="
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

# ─── Step 5: Compute MD5 hashes ─────────────────────────────────────
log "=== Step 5: Compute MD5 hashes ==="
if [ -f "$WORK/.hash-done" ]; then
  log "Hashes already computed, skipping."
else
  log "Hashing all files (parallel across $(nproc) cores)..."
  find "$SORTED_DIR" -type f -print0 | xargs -0 -P"$(nproc)" md5sum > "$HASH_FILE"
  HASH_COUNT=$(wc -l < "$HASH_FILE")
  log "Hashing complete: $HASH_COUNT files."
  touch "$WORK/.hash-done"
fi

# ─── Step 6: Build JSON index ───────────────────────────────────────
log "=== Step 6: Build MD5 JSON index ==="
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

# ─── Step 7: Upload buckets to archive.org ───────────────────────────
log "=== Step 7: Upload image buckets ==="
touch "$UPLOAD_LOG"

BUCKET_TOTAL=$(find "$SORTED_DIR" -mindepth 1 -maxdepth 1 -type d | wc -l)
BUCKET_NUM=0

upload_item() {
  local item_id="$1"
  local dir="$2"
  local bucket_label="$3"

  if grep -q "^${item_id} OK$" "$UPLOAD_LOG" 2>/dev/null; then
    log "  $item_id already uploaded, skipping."
    return 0
  fi

  local fcount
  fcount=$(find "$dir" -maxdepth 1 -type f | wc -l)
  log "  Uploading $item_id ($fcount files)..."

  # Upload from inside the directory so remote paths are just filenames.
  # Use find+xargs to avoid ARG_MAX with large directories.
  if (cd "$dir" && find . -maxdepth 1 -type f -printf '%f\0' | \
      xargs -0 -n 2000 ia upload "$item_id" \
        --metadata="collection:opensource" \
        --metadata="mediatype:image" \
        --metadata="title:4chan /mlp/ archived images ($bucket_label)" \
        --metadata="description:Archived full-size images from 4chan /mlp/, $bucket_label. Part of the $COLLECTION collection." \
        --metadata="subject:4chan;mlp;archive;imageboard" \
        --metadata="creator:anonymous" \
        --retries=5 \
        --no-derive); then
    echo "$item_id OK" >> "$UPLOAD_LOG"
    log "  $item_id done."
    return 0
  else
    echo "$item_id FAILED" >> "$UPLOAD_LOG"
    log "  $item_id FAILED — will retry on next run."
    return 1
  fi
}

for bucket_dir in "$SORTED_DIR"/*/; do
  [ -d "$bucket_dir" ] || continue
  bucket=$(basename "$bucket_dir")
  BUCKET_NUM=$((BUCKET_NUM + 1))
  file_count=$(find "$bucket_dir" -maxdepth 1 -type f | wc -l)
  log "[$BUCKET_NUM/$BUCKET_TOTAL] Bucket $bucket: $file_count files"

  if [ "$file_count" -le "$MAX_PER_ITEM" ]; then
    # Small enough for a single item
    upload_item "${COLLECTION}-${bucket}" "$bucket_dir" "$bucket"
  else
    # Split into parts — archive.org works best with ≤10k files per item
    parts=$(( (file_count + MAX_PER_ITEM - 1) / MAX_PER_ITEM ))
    log "  Splitting into $parts parts ($MAX_PER_ITEM files each)..."

    SPLIT_DIR="$WORK/splits"
    rm -rf "$SPLIT_DIR"
    mkdir -p "$SPLIT_DIR"

    # Write file lists, one per part
    find "$bucket_dir" -maxdepth 1 -type f -printf '%f\n' | sort | \
      split -l "$MAX_PER_ITEM" -d --additional-suffix=".list" - "$SPLIT_DIR/part-"

    part_num=0
    for filelist in "$SPLIT_DIR"/part-*.list; do
      [ -f "$filelist" ] || continue
      part_num=$((part_num + 1))
      part_id="${COLLECTION}-${bucket}-part${part_num}"

      if grep -q "^${part_id} OK$" "$UPLOAD_LOG" 2>/dev/null; then
        log "  $part_id already uploaded, skipping."
        continue
      fi

      local_count=$(wc -l < "$filelist")
      log "  Uploading $part_id ($local_count files)..."

      # Upload files listed in the manifest
      if (cd "$bucket_dir" && xargs -a "$filelist" -d '\n' -n 2000 ia upload "$part_id" \
          --metadata="collection:opensource" \
          --metadata="mediatype:image" \
          --metadata="title:4chan /mlp/ archived images ($bucket, part $part_num)" \
          --metadata="description:Archived full-size images from 4chan /mlp/, $bucket part $part_num of $parts. Part of the $COLLECTION collection." \
          --metadata="subject:4chan;mlp;archive;imageboard" \
          --metadata="creator:anonymous" \
          --retries=5 \
          --no-derive); then
        echo "$part_id OK" >> "$UPLOAD_LOG"
        log "  $part_id done."
      else
        echo "$part_id FAILED" >> "$UPLOAD_LOG"
        log "  $part_id FAILED — will retry on next run."
      fi
    done

    rm -rf "$SPLIT_DIR"
  fi
done

# ─── Step 8: Upload MD5 index ───────────────────────────────────────
log "=== Step 8: Upload MD5 index ==="
if grep -q "^${COLLECTION}-index OK$" "$UPLOAD_LOG" 2>/dev/null; then
  log "Index already uploaded, skipping."
else
  ia upload "${COLLECTION}-index" "$INDEX_FILE" \
    --metadata="collection:opensource" \
    --metadata="mediatype:data" \
    --metadata="title:4chan /mlp/ archive - MD5 index" \
    --metadata="description:JSON mapping of base64 MD5 hashes to archive.org file paths. Keys are base64-encoded MD5 hashes (matching desuarchive media_hash). Values are 'YYYY-MM/filename' paths. Used by ancientchan userscript to resolve dead images." \
    --metadata="subject:4chan;mlp;archive;index" \
    --retries=5 \
    && echo "${COLLECTION}-index OK" >> "$UPLOAD_LOG"
  log "Index uploaded."
fi

# ─── Done ────────────────────────────────────────────────────────────
echo ""
log "════════════════════════════════════════════════════"
log "  UPLOAD COMPLETE"
log "════════════════════════════════════════════════════"
echo ""

OK_COUNT=$(grep -c " OK$" "$UPLOAD_LOG" 2>/dev/null || echo 0)
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
