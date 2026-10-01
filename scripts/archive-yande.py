#!/usr/bin/env python3
"""Archive daily popular metadata, including posts hidden by the site's blacklist CSS."""
import concurrent.futures
import datetime as dt
import gzip
import json
from pathlib import Path
import time
import urllib.parse
import urllib.request

START = dt.date(2026, 1, 1)
END = dt.date(2026, 9, 30)
ROOT = Path(__file__).resolve().parents[1] / "yande" / "data"


def fetch_day(day):
    params = urllib.parse.urlencode({"day": day.day, "month": day.month, "year": day.year})
    url = "https://yande.re/post/popular_by_day.json?" + params
    for attempt in range(4):
        try:
            request = urllib.request.Request(url, headers={"Accept": "application/json"})
            with urllib.request.urlopen(request, timeout=30) as response:
                posts = json.load(response)
            if not isinstance(posts, list):
                raise ValueError("Expected a list of posts")
            items = []
            for post in posts:
                # API metadata includes posts regardless of source-page blacklist CSS.
                # Keep the rating so the gallery can show exactly what the daily page returned.
                if post.get("status") == "deleted":
                    continue
                original = post.get("file_url", "")
                preview = post.get("preview_url", "")
                if not original.startswith("https://files.yande.re/"):
                    continue
                if not preview.startswith("https://assets.yande.re/"):
                    preview = original
                items.append({"id": post["id"], "original": original, "preview": preview,
                              "width": post.get("width", 0), "height": post.get("height", 0),
                              "bytes": post.get("file_size", 0), "score": post.get("score", 0),
                              "rating": post.get("rating", "u")})
            time.sleep(0.15)
            return {"date": day.isoformat(), "posts": items}
        except Exception:
            if attempt == 3:
                raise
            time.sleep(1 + attempt * 2)


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    dates = [START + dt.timedelta(days=i) for i in range((END - START).days + 1)]
    days = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        futures = {pool.submit(fetch_day, day): day for day in dates}
        for future in concurrent.futures.as_completed(futures):
            days.append(future.result())
            if len(days) % 30 == 0:
                print(f"Archived {len(days)}/{len(dates)} days", flush=True)
    days.sort(key=lambda item: item["date"])
    months = []
    ids = set()
    for month in range(1, 10):
        name = f"2026-{month:02d}"
        records = [item for item in days if item["date"].startswith(name)]
        payload = {"month": name, "days": records}
        compressed = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode() + b"\n"
        (ROOT / (name + ".json.gz")).write_bytes(gzip.compress(compressed, compresslevel=9, mtime=0))
        month_ids = {post["id"] for day in records for post in day["posts"]}
        ids.update(month_ids)
        months.append({"month": name, "file": name + ".json.gz", "days": len(records), "count": len(month_ids)})
    manifest = {"start": START.isoformat(), "end": END.isoformat(),
                "fetchedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
                "source": "https://yande.re/post/popular_by_day", "includesHiddenPosts": True,
                "days": len(days), "count": len(ids), "months": months}
    (ROOT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(f"Complete: {len(days)} days, {len(ids)} unique works", flush=True)


if __name__ == "__main__":
    main()
