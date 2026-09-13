#!/usr/bin/env python3
"""Collect public Hub metadata. No token, credential file, or model file is read."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
HUB = "https://huggingface.co"
FIELDS = ("downloads", "downloadsAllTime", "likes", "createdAt", "lastModified")
MODEL_ID = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def get_json(url, attempts=3):
    if not url.startswith(HUB + "/api/"):
        raise ValueError("Only public Hugging Face metadata API URLs are allowed")
    # urllib does not load HF_TOKEN, HF login credentials, .netrc or browser cookies.
    request = urllib.request.Request(url, headers={
        "Accept": "application/json",
        "User-Agent": "ncp-archpreview-downloads/1.0 (anonymous metadata monitor)",
    })
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if error.code != 429 and error.code < 500:
                raise
            if attempt == attempts - 1:
                raise
            retry_after = error.headers.get("Retry-After", "")
            wait = min(float(retry_after), 30) if retry_after.isdigit() else 2 ** (attempt + 1)
            time.sleep(wait)
        except (urllib.error.URLError, TimeoutError):
            if attempt == attempts - 1:
                raise
            time.sleep(2 ** (attempt + 1))


def count(value, field, model_id):
    # Missing statistics must never become zero, including bools (a Python int subtype).
    if type(value) is not int or value < 0 or value > 2**53 - 1:
        raise ValueError(f"{model_id}: invalid or missing {field}")
    return value


def classify(model_id):
    name = model_id.split("/")[-1]
    if "DFlash" in name or "NCPFlash" in name:
        return "DFlash", "DFlash2 · NCPFlash", None
    step = re.search(r"Stage1_Step(\d+)$", name)
    if step:
        value = int(step.group(1))
        return "Stage 1", f"Stage 1 · Step {value:,}", value
    version = re.search(r"Stage2_(v\d+)$", name)
    if version:
        return "Stage 2", f"Stage 2 · {version.group(1)}", None
    if name.endswith("Stage1"):
        return "Stage 1", "Stage 1 · Final", None
    return "Other", name, None


def model_items(collection):
    items = collection.get("items")
    if not isinstance(items, list):
        raise ValueError("Collection API did not return an items array")
    unique = {}
    for item in items:
        if item.get("type", item.get("repoType")) != "model":
            continue
        model_id = item.get("id")
        if not isinstance(model_id, str) or not MODEL_ID.fullmatch(model_id):
            raise ValueError("Collection contains a malformed model ID")
        unique.setdefault(model_id, item)
    if not unique:
        raise ValueError("Collection contains no models; refusing to replace the last good snapshot")
    return list(unique.values())


def collect(collection_slug, fetch=get_json):
    started_at = utc_now()
    url = HUB + "/api/collections/" + urllib.parse.quote(collection_slug, safe="/")
    collection = fetch(url)
    items = model_items(collection)

    def fetch_model(item):
        model_id = item["id"]
        query = urllib.parse.urlencode([("expand[]", key) for key in FIELDS])
        data = fetch(HUB + "/api/models/" + urllib.parse.quote(model_id, safe="/") + "?" + query)
        if data.get("id") != model_id:
            raise ValueError(f"Model identity changed for {model_id}; recheck collection membership")
        group, label, step = classify(model_id)
        return {
            "id": model_id, "url": HUB + "/" + model_id,
            "label": label, "group": group, "step": step,
            "downloadsAllTime": count(data.get("downloadsAllTime"), "downloadsAllTime", model_id),
            "downloads30d": count(data.get("downloads"), "downloads", model_id),
            "likes": count(data.get("likes"), "likes", model_id),
            "createdAt": data.get("createdAt"), "lastModified": data.get("lastModified"),
            "observedAt": utc_now(),
        }

    with ThreadPoolExecutor(max_workers=3) as executor:
        models = list(executor.map(fetch_model, items))
    fingerprint = hashlib.sha256("\n".join(sorted(m["id"] for m in models)).encode()).hexdigest()
    groups = []
    for group in dict.fromkeys(m["group"] for m in models):
        members = [m for m in models if m["group"] == group]
        groups.append({"name": group, "modelCount": len(members), **totals(members)})
    slug = collection.get("slug", collection_slug)
    return {
        "schemaVersion": 1, "startedAt": started_at, "generatedAt": utc_now(),
        "authentication": "anonymous", "complete": True,
        "collection": {
            "slug": slug, "title": collection.get("title", slug),
            "url": HUB + "/collections/" + slug,
            "lastUpdated": collection.get("lastUpdated"),
            "modelCount": len(models), "membershipHash": fingerprint,
        },
        "totals": totals(models), "groups": groups, "models": models,
        "methodology": {
            "downloads30d": "Hub downloads: rolling last 30 days; never summed across snapshots.",
            "downloadsAllTime": "Hub downloadsAllTime: cumulative count reported by the Hub.",
            "scope": "Unique model repository IDs in this collection at collection time; no branch-level counts.",
            "counting": "Hub query-file GET/HEAD counts; not unique people or verified full-weight downloads.",
            "history": "One last successful snapshot per UTC day, starting from the first collection. No backfill.",
            "sources": [HUB + "/docs/hub/models-download-stats", HUB + "/docs/huggingface_hub/en/package_reference/hf_api#huggingface_hub.ModelInfo"],
        },
    }


def totals(models):
    return {key: sum(m[key] for m in models) for key in ("downloadsAllTime", "downloads30d", "likes")}


def atomic_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def publish(snapshot, output):
    """Only called after every model succeeded. Validate stored history before any write."""
    output = Path(output)
    history_path = output / "history.json"
    history = json.loads(history_path.read_text(encoding="utf-8")) if history_path.exists() else {"schemaVersion": 1, "points": []}
    if history.get("schemaVersion") != 1 or not isinstance(history.get("points"), list):
        raise ValueError("Stored history is invalid; refusing to discard it")
    date = snapshot["generatedAt"][:10]
    point = {
        "date": date, "generatedAt": snapshot["generatedAt"],
        "membershipHash": snapshot["collection"]["membershipHash"],
        "modelCount": snapshot["collection"]["modelCount"],
        "totals": snapshot["totals"], "groups": snapshot["groups"],
        "snapshot": f"history/{date}.json",
    }
    history["points"] = sorted([p for p in history["points"] if p["date"] != date] + [point], key=lambda p: p["date"])
    history["updatedAt"] = snapshot["generatedAt"]
    baseline = output / "baseline.json"
    if not baseline.exists():
        atomic_json(baseline, snapshot)
    atomic_json(output / "history" / f"{date}.json", snapshot)
    atomic_json(history_path, history)
    atomic_json(output / "latest.json", snapshot)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=ROOT / "config.json")
    parser.add_argument("--output", type=Path, default=ROOT / "docs" / "data")
    args = parser.parse_args()
    config = json.loads(args.config.read_text(encoding="utf-8"))
    snapshot = collect(config["collection"])
    publish(snapshot, args.output)
    print(json.dumps({"generatedAt": snapshot["generatedAt"], "models": len(snapshot["models"]), **snapshot["totals"], "authentication": "anonymous"}))


if __name__ == "__main__":
    main()
