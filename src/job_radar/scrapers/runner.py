from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

import yaml

from ..models import Job
from . import greenhouse, lever, smartrecruiters, workday

log = logging.getLogger(__name__)


def _load_targets(path: Path) -> dict[str, Any]:
    if not path.exists():
        log.warning("ats targets file not found: %s", path)
        return {}
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


_CITY_EN_MAP = {"上海": "shanghai", "杭州": "hangzhou", "北京": "beijing",
                "深圳": "shenzhen", "广州": "guangzhou", "成都": "chengdu"}
_GENERIC_CN_TOKENS = ["china", "greater china", "apac", "asia pacific",
                     "asia-pacific", "remote - china", "中国"]


def _city_tokens(cities: list[str]) -> list[str]:
    out: list[str] = []
    for c in cities or []:
        c = (c or "").strip().lower()
        if c:
            out.append(c)
        if c in _CITY_EN_MAP:
            out.append(_CITY_EN_MAP[c])
    out.extend(_GENERIC_CN_TOKENS)
    return out


def city_matches(job_city: str, tokens: list[str]) -> bool:
    """Keep job if city is empty OR contains any target token (substring, ci)."""
    if not job_city or not job_city.strip():
        return True
    blob = job_city.lower()
    return any(t in blob for t in tokens)


def _keywords_from_profile(profile: dict[str, Any]) -> list[str]:
    cand = profile.get("candidate") or {}
    kws = list(cand.get("s_tier_roles", [])) + list(cand.get("a_tier_roles", []))
    kws += ["Solution Engineer", "Customer Engineer", "Solutions Architect"]
    seen, out = set(), []
    for k in kws:
        kl = k.lower()
        if kl not in seen:
            seen.add(kl)
            out.append(k)
    return out


async def _safe(coro, label: str) -> list[Job]:
    try:
        return await coro
    except Exception as e:
        log.warning("scraper %s failed: %s", label, e)
        return []


async def fetch_all(targets_path: Path, profile: dict[str, Any]) -> list[Job]:
    targets = _load_targets(targets_path)
    keywords = _keywords_from_profile(profile)

    tasks = []
    labels = []
    for slug in targets.get("greenhouse", []) or []:
        tasks.append(_safe(greenhouse.fetch(slug, keywords), f"greenhouse/{slug}"))
        labels.append(f"greenhouse/{slug}")
    for slug in targets.get("lever", []) or []:
        tasks.append(_safe(lever.fetch(slug, keywords), f"lever/{slug}"))
        labels.append(f"lever/{slug}")
    for slug in targets.get("smartrecruiters", []) or []:
        tasks.append(_safe(smartrecruiters.fetch(slug, keywords), f"smartrecruiters/{slug}"))
        labels.append(f"smartrecruiters/{slug}")
    for entry in targets.get("workday", []) or []:
        tasks.append(
            _safe(
                workday.fetch(entry["host"], entry["tenant"], entry["site"], keywords),
                f"workday/{entry['tenant']}",
            )
        )
        labels.append(f"workday/{entry['tenant']}")

    if not tasks:
        log.warning("no ATS targets configured")
        return []

    results = await asyncio.gather(*tasks)
    all_jobs: list[Job] = []
    for label, jobs in zip(labels, results):
        log.info("ats result %s: %d jobs", label, len(jobs))
        all_jobs.extend(jobs)

    cand = profile.get("candidate") or {}
    tokens = _city_tokens(cand.get("cities", []))
    before = len(all_jobs)
    filtered = [j for j in all_jobs if city_matches(j.city, tokens)]
    log.info("ats city filter: %d -> %d (dropped %d non-target-city)",
             before, len(filtered), before - len(filtered))
    return filtered
