#!/usr/bin/env python3
"""Collect public Hub metadata. No token, credential file, or model file is read."""
from __future__ import annotations

import argparse
import csv
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import re
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
HUB = "https://huggingface.co"
MODELSCOPE = "https://www.modelscope.cn"
FIELDS = ("downloads", "downloadsAllTime", "likes", "createdAt", "lastModified")
MODEL_ID = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def get_json(url, attempts=3):
    if not any(url.startswith(host + "/api/") for host in (HUB, MODELSCOPE)):
        raise ValueError("Only public Hugging Face and ModelScope metadata API URLs are allowed")
    # urllib does not load environment tokens, login credentials, .netrc or cookies.
    request = urllib.request.Request(url, headers={
        "Accept": "application/json",
        "User-Agent": "ncp-archpreview-downloads/1.0 (anonymous metadata monitor)",
    })
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            error.close()
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
        "authentication": "anonymous", "complete": True, "provider": "huggingface",
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


def totals(models, fields=("downloadsAllTime", "downloads30d", "likes")):
    return {key: count(sum(m[key] for m in models), key, "collection total") for key in fields}


def modelscope_data(response):
    if response.get("Code") != 200 or response.get("Success") is not True or not isinstance(response.get("Data"), dict):
        raise ValueError("ModelScope API did not return a successful data response")
    return response["Data"]


def modelscope_collection(slug, fetch):
    """Discover current members on every run, following the public site's pagination."""
    if not MODEL_ID.fullmatch(slug):
        raise ValueError("Invalid ModelScope collection path")
    query = urllib.parse.urlencode({"Fid": slug})
    info = modelscope_data(fetch(MODELSCOPE + "/api/v1/collections/info?" + query))
    if info.get("Path") != slug or info.get("Private") != 0:
        raise ValueError("ModelScope collection identity or visibility changed")
    expected = count(info.get("ElementCount"), "ElementCount", slug)
    expected_models = count(info.get("ElementTypeCount", {}).get("model"), "model count", slug)
    members, elements = {}, set()
    for page in range(1, 101):
        params = urllib.parse.urlencode({"Fid": slug, "PageNumber": page, "PageSize": 100})
        data = modelscope_data(fetch(MODELSCOPE + "/api/v1/collections?" + params))
        if data.get("Path") != slug or data.get("Fid") != info.get("Fid"):
            raise ValueError("ModelScope collection identity changed during pagination")
        result = data.get("CollectionElements", {})
        if count(result.get("Total"), "Total", slug) != expected:
            raise ValueError("ModelScope collection changed during pagination; retry next run")
        entries = result.get("CollectionElementVoList")
        if not isinstance(entries, list) or not entries:
            raise ValueError("ModelScope returned an empty or incomplete collection page")
        for entry in entries:
            fid = entry.get("Fid")
            if not isinstance(fid, str) or not fid or fid in elements:
                raise ValueError("ModelScope returned duplicate or invalid collection elements")
            elements.add(fid)
            if entry.get("ElementType") != "model":
                continue
            model_id = f"{entry.get('ElementPath', '')}/{entry.get('ElementName', '')}"
            if not MODEL_ID.fullmatch(model_id):
                raise ValueError("ModelScope collection contains an invalid model ID")
            members.setdefault(model_id, {"id": model_id})
        if len(elements) >= expected:
            break
    if len(elements) != expected or len(members) != expected_models or not members:
        raise ValueError("ModelScope collection coverage is incomplete; keeping the last good snapshot")
    return info, list(members.values())


def modelscope_time(value):
    if value is None:
        return None
    return datetime.fromtimestamp(count(value, "timestamp", "ModelScope"), timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def collect_modelscope(slug, fetch=get_json, candidates=(), previous_ids=()):
    started_at = utc_now()
    collection, items = modelscope_collection(slug, fetch)
    required_ids = {item["id"] for item in items} | set(previous_ids)
    targets = {item["id"] for item in items} | set(candidates) | set(previous_ids)
    if any(not isinstance(model_id, str) or not MODEL_ID.fullmatch(model_id) for model_id in targets):
        raise ValueError("Invalid preconfigured ModelScope model ID")

    def fetch_model(model_id):
        group, label, step = classify(model_id)
        identity = {"id": model_id, "url": MODELSCOPE + "/models/" + model_id, "label": label, "group": group, "step": step}
        pending = {**identity, "status": "pending", "reason": "not_public", "observedAt": utc_now()}
        try:
            response = fetch(MODELSCOPE + "/api/v1/models/" + urllib.parse.quote(model_id, safe="/"))
        except urllib.error.HTTPError as error:
            error.close()
            if error.code in (403, 404) and model_id not in required_ids:
                return pending
            raise
        if response.get("Code") in (403, 404) and model_id not in required_ids:
            return pending
        data = modelscope_data(response)
        if f"{data.get('Path')}/{data.get('Name')}" != model_id:
            raise ValueError(f"ModelScope model identity changed for {model_id}")
        return {
            **identity, "status": "available",
            # The public API does not declare a time window. Do not label this all-time.
            "platformDownloads": count(data.get("Downloads"), "Downloads", model_id),
            "likes": count(data.get("Stars"), "Stars", model_id),
            "createdAt": modelscope_time(data.get("CreatedTime")),
            "lastModified": modelscope_time(data.get("LastUpdatedTime")),
            "observedAt": utc_now(),
        }

    with ThreadPoolExecutor(max_workers=3) as executor:
        results = list(executor.map(fetch_model, sorted(targets)))
    models = [m for m in results if m["status"] == "available"]
    pending_models = [m for m in results if m["status"] == "pending"]
    fields = ("platformDownloads", "likes")
    fingerprint = hashlib.sha256("\n".join(sorted(m["id"] for m in models)).encode()).hexdigest()
    groups = []
    for group in dict.fromkeys(m["group"] for m in models):
        members = [m for m in models if m["group"] == group]
        groups.append({"name": group, "modelCount": len(members), **totals(members, fields)})
    return {
        "schemaVersion": 1, "startedAt": started_at, "generatedAt": utc_now(),
        "authentication": "anonymous", "complete": True, "provider": "modelscope",
        "collection": {
            "slug": slug, "title": collection.get("Name", slug),
            "url": MODELSCOPE + "/collections/" + slug,
            "lastUpdated": collection.get("GmtModified"),
            "modelCount": len(models), "membershipHash": fingerprint,
            "targetCount": len(targets), "pendingCount": len(pending_models),
        },
        "totals": totals(models, fields), "groups": groups, "models": models, "pendingModels": pending_models,
        "methodology": {
            "platformDownloads": "ModelScope model metadata Downloads, as reported; the public API does not specify its time window or counting rules.",
            "likes": "ModelScope model metadata Stars.",
            "scope": "Preconfigured same-name Hugging Face mirrors plus current ModelScope collection models. Direct model APIs are checked every run, even before collection membership. First-time 403/404 targets are pending, never zero; previously readable models must all succeed.",
            "history": "Daily observed platform counts from the first successful collection. Differences are counter changes, not verified daily downloads. No backfill.",
            "sources": [MODELSCOPE + "/api/v1/collections/info?" + urllib.parse.urlencode({"Fid": slug}), "https://github.com/modelscope/modelscope_hub"],
        },
    }


def atomic_json(path, data):
    atomic_text(path, json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def atomic_text(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(text, encoding="utf-8", newline="")
    temporary.replace(path)


def model_csv(models, provider="huggingface"):
    metrics = ("platformDownloads",) if provider == "modelscope" else ("downloadsAllTime", "downloads30d")
    status = ("status",) if provider == "modelscope" else ()
    fields = ("id", "group", *status, *metrics, "likes", "createdAt", "lastModified", "observedAt", "url")
    output = io.StringIO(newline="")
    output.write("\ufeff")
    writer = csv.writer(output)
    writer.writerow(fields)
    for model in models:
        values = [str(model.get(field) if model.get(field) is not None else "") for field in fields]
        writer.writerow(["'" + v if v.startswith(("=", "+", "-", "@", "\t", "\r")) else v for v in values])
    return output.getvalue()


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
    atomic_text(output / "models.csv", model_csv(snapshot["models"] + snapshot.get("pendingModels", []), snapshot.get("provider", "huggingface")))
    atomic_json(output / "latest.json", snapshot)


def refresh(config, output, provider="all", fetch=get_json):
    """Failure in one source never discards successful data from the other source."""
    sources = {
        "huggingface": (collect, config["collection"], Path(output)),
        "modelscope": (collect_modelscope, config["modelscopeCollection"], Path(output) / "modelscope"),
    }
    success = True
    for name, (collector, slug, destination) in sources.items():
        if provider not in ("all", name):
            continue
        status = {"provider": name, "attemptedAt": utc_now(), "ok": False}
        try:
            if name == "modelscope":
                namespace = config.get("modelscopeNamespace", slug.split("/")[0])
                names = set(config.get("modelscopeModelNames", []))
                hf_latest = Path(output) / "latest.json"
                if hf_latest.exists():
                    names.update(m["id"].split("/")[1] for m in json.loads(hf_latest.read_text())["models"])
                candidates = [namespace + "/" + model_name for model_name in names]
                ms_latest = destination / "latest.json"
                previous_ids = [m["id"] for m in json.loads(ms_latest.read_text())["models"]] if ms_latest.exists() else []
                snapshot = collector(slug, fetch, candidates=candidates, previous_ids=previous_ids)
            else:
                snapshot = collector(slug, fetch)
            publish(snapshot, destination)
            status.update(ok=True, generatedAt=snapshot["generatedAt"])
            print(json.dumps({"provider": name, "models": len(snapshot["models"]), **snapshot["totals"], "authentication": "anonymous"}))
        except Exception as error:
            success = False
            status["error"] = f"{type(error).__name__}: {error}"
            print(json.dumps(status))
        atomic_json(destination / "status.json", status)
    return success


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=ROOT / "config.json")
    parser.add_argument("--output", type=Path, default=ROOT / "docs" / "data")
    parser.add_argument("--provider", choices=("all", "huggingface", "modelscope"), default="all")
    args = parser.parse_args()
    config = json.loads(args.config.read_text(encoding="utf-8"))
    if not refresh(config, args.output, args.provider):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
