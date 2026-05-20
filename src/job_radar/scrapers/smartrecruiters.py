from __future__ import annotations

import logging

from ..models import Job
from .base import fetch_json, matches_keywords

log = logging.getLogger(__name__)

ENDPOINT = "https://api.smartrecruiters.com/v1/companies/{slug}/postings"


async def fetch(slug: str, keywords: list[str] | None = None) -> list[Job]:
    data = await fetch_json(ENDPOINT.format(slug=slug), params={"limit": 100})
    if not data:
        return []
    out: list[Job] = []
    for p in data.get("content", []):
        title = p.get("name", "")
        loc = p.get("location") or {}
        city = " ".join(filter(None, [loc.get("city"), loc.get("country")]))
        url = (p.get("ref", "") or "").replace("/api/", "/") or p.get("applyUrl", "")
        if not matches_keywords(f"{title} {city}", keywords):
            continue
        out.append(
            Job(
                title=title,
                company=slug,
                city=city,
                salary="",
                jd="",
                url=url,
                source="smartrecruiters",
            )
        )
    log.info("smartrecruiters[%s]: %d/%d match", slug, len(out), len(data.get("content", [])))
    return out
