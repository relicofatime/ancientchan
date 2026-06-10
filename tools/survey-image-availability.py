#!/usr/bin/env python3
"""Survey how many /mlp/ images are actually still alive on desuarchive's CDN.

For each quarter from 2012 to 2016 (plus recent control windows), pulls a
sample of posts via desuarchive's search API, takes each post's full-image
URL, and HEAD-checks it. Dead-rate per quarter tells us which eras need
recovery (heinessen / torrent) and which are fine served live.

Run anywhere with python3 (no deps):
  curl -sL https://raw.githubusercontent.com/relicofatime/ancientchan/master/tools/survey-image-availability.py | python3 -u -
"""

import json
import time
import urllib.request
import urllib.error

API = "https://desuarchive.org/_/api/chan/search/"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
API_SPACING = 2.0     # seconds between API calls — be polite, avoid 429s
HEAD_SPACING = 0.25   # seconds between CDN checks
MAX_IMAGES_PER_WINDOW = 12
MAX_PAGES_PER_WINDOW = 3

_last_api_call = 0.0


def http(url, method="GET", timeout=20):
    req = urllib.request.Request(url, method=method, headers={"User-Agent": UA})
    return urllib.request.urlopen(req, timeout=timeout)


def api_get(url):
    """GET a desuarchive API URL with spacing and 429 backoff."""
    global _last_api_call
    for attempt in range(6):
        wait = API_SPACING - (time.time() - _last_api_call)
        if wait > 0:
            time.sleep(wait)
        _last_api_call = time.time()
        try:
            with http(url) as r:
                return json.loads(r.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as e:
            if e.code in (429, 503):
                delay = 30 * (attempt + 1)
                print(f"    rate limited ({e.code}), sleeping {delay}s...")
                time.sleep(delay)
                continue
            raise
    raise RuntimeError("rate limited too many times: " + url)


def find_posts(payload):
    """Search API wraps results differently across versions — find the list."""
    if isinstance(payload, dict):
        if isinstance(payload.get("posts"), list):
            return payload["posts"]
        for v in payload.values():
            found = find_posts(v)
            if found:
                return found
    return []


def check_image(url):
    """HEAD the CDN URL; fall back to a 1-byte ranged GET if HEAD is refused."""
    time.sleep(HEAD_SPACING)
    try:
        with http(url, method="HEAD") as r:
            return "alive" if r.status in (200, 206) else f"http{r.status}"
    except urllib.error.HTTPError as e:
        if e.code == 405:  # HEAD not allowed — try a ranged GET
            try:
                req = urllib.request.Request(
                    url, headers={"User-Agent": UA, "Range": "bytes=0-0"})
                with urllib.request.urlopen(req, timeout=20) as r:
                    return "alive" if r.status in (200, 206) else f"http{r.status}"
            except urllib.error.HTTPError as e2:
                return "dead" if e2.code in (403, 404, 410) else f"http{e2.code}"
        return "dead" if e.code in (403, 404, 410) else f"http{e.code}"
    except Exception as e:
        return "error:" + type(e).__name__


def quarter_windows():
    for year in range(2012, 2017):
        for q, (m1, m2) in enumerate(
                [("01", "03"), ("04", "06"), ("07", "09"), ("10", "12")], 1):
            yield (f"{year}-Q{q}", f"{year}-{m1}-01", f"{year}-{m2}-28")
    # Controls: eras the user says are fine — if these show dead, the
    # method is broken (CDN blocking us), not the images.
    yield ("2019-ctrl", "2019-06-01", "2019-06-28")
    yield ("2024-ctrl", "2024-06-01", "2024-06-28")


def survey_window(label, start, end):
    images, banned, nolink = [], 0, 0
    for page in range(1, MAX_PAGES_PER_WINDOW + 1):
        url = (f"{API}?board=mlp&start={start}&end={end}"
               f"&order=asc&page={page}")
        try:
            posts = find_posts(api_get(url))
        except Exception as e:
            print(f"  {label}: search failed: {e}")
            return None
        if not posts:
            break
        for p in posts:
            m = p.get("media") or {}
            if not isinstance(m, dict) or not m:
                continue
            if str(m.get("banned", "0")) in ("1", "true"):
                banned += 1
                continue
            link = m.get("media_link") or ""
            if not link:
                nolink += 1
                continue
            images.append(link)
            if len(images) >= MAX_IMAGES_PER_WINDOW:
                break
        if len(images) >= MAX_IMAGES_PER_WINDOW:
            break

    alive = dead = other = 0
    for link in images:
        result = check_image(link)
        if result == "alive":
            alive += 1
        elif result == "dead":
            dead = dead + 1
        else:
            other += 1
    total_bad = dead + nolink
    total = len(images) + nolink
    pct = (100 * total_bad / total) if total else 0
    print(f"  {label}:  checked {total:3d}  alive {alive:3d}  dead {dead:3d}  "
          f"no-link {nolink:3d}  banned {banned:2d}  other {other:2d}"
          f"   → {pct:.0f}% dead")
    return (label, total, alive, total_bad)


def main():
    print("desuarchive /mlp/ image availability survey")
    print("(one API call every %.0fs — takes ~5 minutes, be patient)\n"
          % API_SPACING)
    results = []
    for label, start, end in quarter_windows():
        r = survey_window(label, start, end)
        if r:
            results.append(r)

    print("\n──── verdict ────")
    ctrl = [r for r in results if "ctrl" in r[0]]
    if ctrl and all(r[2] == 0 and r[1] > 0 for r in ctrl):
        print("WARNING: control windows show 0 alive — the CDN is blocking "
              "these checks; results above are NOT trustworthy.")
        return
    for label, total, alive, bad in results:
        if total and bad / total > 0.2:
            print(f"  {label}: {100*bad/total:.0f}% dead — needs recovery")
    print("Eras not listed above are mostly intact on desuarchive.")


if __name__ == "__main__":
    main()
