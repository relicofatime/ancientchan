#!/usr/bin/env python3
"""Finish the /mlp/ archive.org upload without the dead Azure VM.

Streams the heinessen tar straight from archive.org and writes ONLY the
wanted months' files into per-month stored zips as they fly past — no full
extraction (the old pipeline needed ~450GB; this needs ~125GB: just the
zips), no hashing and no index step (md5-index.json is already uploaded and
covers every month). Months already present on archive.org are skipped, so
the script is safe to re-run.

Usage (any box with python3, ~130GB free disk, and decent bandwidth):

  pip install internetarchive
  ia configure                      # archive.org account login, once
  python3 finish-mlp-upload.py 2014-04 2014-06 2014-08 2014-09 2014-10 2014-11

With no arguments it asks archive.org which months are missing and does those.
"""
import io
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
import zipfile
from datetime import datetime, timezone

HEINESSEN_ITEM = "heinessen-mlp-images"
ITEM_PREFIX = "4chan-mlp-archive-"
ALL_MONTHS = [f"{y}-{m:02d}" for y in (2012, 2013, 2014) for m in range(1, 13)
              if "2012-05" <= f"{y}-{m:02d}" <= "2014-11"]
UA = "ancientchan-finish-upload/1.0"


def http_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def find_tar():
    meta = http_json(f"https://archive.org/metadata/{HEINESSEN_ITEM}")
    tars = [f for f in meta.get("files", []) if f["name"].endswith(".tar")]
    if not tars:
        sys.exit(f"no .tar found in item {HEINESSEN_ITEM}")
    tar = max(tars, key=lambda f: int(f.get("size", 0)))
    url = f"https://archive.org/download/{HEINESSEN_ITEM}/{tar['name']}"
    return url, int(tar["size"])


def month_on_ia(ym):
    try:
        meta = http_json(f"https://archive.org/metadata/{ITEM_PREFIX}{ym}")
        return any(f.get("name") == f"{ym}.zip" for f in meta.get("files", []))
    except Exception:
        return False


class RetryingStream(io.RawIOBase):
    """A read-only HTTP byte stream that survives connection drops by
    reopening with a Range header at the current offset. tarfile never
    notices: the bytes are identical."""

    def __init__(self, url, total):
        self.url, self.total, self.pos, self.resp = url, total, 0, None
        self._open()

    def _open(self):
        for attempt in range(10):
            try:
                req = urllib.request.Request(self.url, headers={
                    "User-Agent": UA, "Range": f"bytes={self.pos}-"})
                self.resp = urllib.request.urlopen(req, timeout=120)
                return
            except Exception as e:
                wait = min(120, 5 * 2 ** attempt)
                print(f"  stream reopen failed ({e}); retrying in {wait}s", flush=True)
                time.sleep(wait)
        sys.exit("could not reopen the tar stream after 10 attempts")

    def readable(self):
        return True

    def read(self, n=-1):
        if n is None or n < 0:
            n = 1 << 20
        while True:
            try:
                chunk = self.resp.read(n)
                self.pos += len(chunk)
                return chunk
            except Exception as e:
                print(f"  stream dropped at {self.pos / 1e9:.2f} GB ({e}); resuming", flush=True)
                self._open()


def month_of(name):
    m = re.match(r"(\d{10,13})\.[A-Za-z0-9]+$", os.path.basename(name))
    if not m:
        return None
    ts = int(m.group(1)[:10])
    d = datetime.fromtimestamp(ts, tz=timezone.utc)
    return f"{d.year}-{d.month:02d}"


def upload(ym, zpath):
    # NB: the zip path goes BEFORE the --metadata flags — ia's parser
    # rejects file arguments placed after them.
    cmd = [
        "ia", "upload", f"{ITEM_PREFIX}{ym}", zpath,
        f"--metadata=title:4chan /mlp/ archive - {ym}",
        "--metadata=mediatype:data",
        "--metadata=description:Full-size images posted to 4chan's /mlp/ board "
        f"in {ym}, recovered from the Heinessen archive. Individual files are "
        f"served at /download/{ITEM_PREFIX}{ym}/{ym}.zip/<filename>. "
        "MD5 lookup: see 4chan-mlp-archive-index.",
        "--metadata=subject:4chan;mlp;archive;images",
        "--retries=10",
    ]
    print(f"[{ym}] uploading {os.path.getsize(zpath) / 1e9:.2f} GB ...", flush=True)
    subprocess.run(cmd, check=True)


def main():
    months = sys.argv[1:] or [ym for ym in ALL_MONTHS if not month_on_ia(ym)]
    months = [ym for ym in months if re.match(r"^\d{4}-\d{2}$", ym)]
    if not months:
        print("archive.org already has every month - nothing to do.")
        return
    done = {ym for ym in months if month_on_ia(ym)}
    months = [ym for ym in months if ym not in done]
    if done:
        print(f"already on archive.org, skipping: {', '.join(sorted(done))}")
    if not months:
        return
    print(f"building: {', '.join(months)}")

    url, total = find_tar()
    print(f"streaming {total / 1e9:.1f} GB tar from {url}")
    zips, counts = {}, {}
    for ym in months:
        zips[ym] = zipfile.ZipFile(f"{ym}.zip", "w", zipfile.ZIP_STORED, allowZip64=True)
        counts[ym] = 0

    import tarfile
    stream = RetryingStream(url, total)
    t0 = time.time()
    with tarfile.open(fileobj=io.BufferedReader(stream, 1 << 22), mode="r|") as tar:
        for member in tar:
            if not member.isfile():
                continue
            ym = month_of(member.name)
            if ym not in zips:
                continue
            src = tar.extractfile(member)
            base = os.path.basename(member.name)
            with zips[ym].open(zipfile.ZipInfo(base), "w") as dst:
                while True:
                    chunk = src.read(1 << 20)
                    if not chunk:
                        break
                    dst.write(chunk)
            counts[ym] += 1
            n = sum(counts.values())
            if n % 5000 == 0:
                mb = stream.pos / 1e6 / max(1, time.time() - t0)
                print(f"  {n} files kept, {stream.pos / 1e9:.1f}/{total / 1e9:.1f} GB read ({mb:.1f} MB/s)", flush=True)

    for ym in months:
        zips[ym].close()
        print(f"[{ym}] {counts[ym]} files, {os.path.getsize(ym + '.zip') / 1e9:.2f} GB")

    for ym in months:
        upload(ym, f"{ym}.zip")
        os.remove(f"{ym}.zip")
        print(f"[{ym}] done, zip deleted", flush=True)

    print("All months uploaded.")


if __name__ == "__main__":
    main()
