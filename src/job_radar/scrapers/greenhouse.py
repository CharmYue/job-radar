from __future__ import annotations

import logging

from ..models import Job
from .base import fetch_json, matches_keywords

log = logging.getLogger(__name__)

ENDPOINT = "https://boards-api.greenhouse.io/v1/boards/{slug}/jobs"


async def fetch(slug: str, keywords: list[str] | None = None) -> list[Job]:
    data = await fetch_json(ENDPOINT.format(slug=slug), params={"content": "true"})
    if not data:
        return []
    out: list[Job] = []
    for j in data.get("jobs", []):
        title = j.get("title", "")
        location = (j.get("location") or {}).get("name", "")
        content = j.get("content", "") or ""
        if not matches_keywords(f"{title} {location} {content}", keywords):
            continue
        out.append(
            Job(
                title=title,
                company=slug,
                city=location,
                salary="",
                jd=content,
                url=j.get("absolute_url", ""),
                source="greenhouse",
            )
        )
    log.info("greenhouse[%s]: %d/%d match", slug, len(out), len(data.get("jobs", [])))
    return out
