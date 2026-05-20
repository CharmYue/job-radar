from __future__ import annotations

import logging

from ..models import Job
from .base import fetch_json, matches_keywords

log = logging.getLogger(__name__)

ENDPOINT = "https://api.lever.co/v0/postings/{slug}"


async def fetch(slug: str, keywords: list[str] | None = None) -> list[Job]:
    data = await fetch_json(ENDPOINT.format(slug=slug), params={"mode": "json"})
    if not data:
        return []
    out: list[Job] = []
    for p in data:
        title = p.get("text", "")
        categories = p.get("categories", {}) or {}
        location = categories.get("location", "")
        jd = (p.get("descriptionPlain") or p.get("description") or "")
        if not matches_keywords(f"{title} {location} {jd}", keywords):
            continue
        out.append(
            Job(
                title=title,
                company=slug,
                city=location,
                salary="",
                jd=jd,
                url=p.get("hostedUrl", ""),
                source="lever",
            )
        )
    log.info("lever[%s]: %d/%d match", slug, len(out), len(data))
    return out
