from __future__ import annotations

import logging

from ..models import Job
from .base import fetch_json, matches_keywords

log = logging.getLogger(__name__)

# Workday CXS endpoint pattern:
#   POST {host}/wday/cxs/{tenant}/{site}/jobs
# Many tenants restrict this endpoint and respond 401/403 for anonymous callers;
# per spec we silently skip those rather than crashing the daily run.


async def fetch(
    host: str,
    tenant: str,
    site: str,
    keywords: list[str] | None = None,
    limit: int = 20,
) -> list[Job]:
    url = f"{host.rstrip('/')}/wday/cxs/{tenant}/{site}/jobs"
    payload = {"limit": limit, "offset": 0, "searchText": " ".join(keywords or [])}

    data = await fetch_json(
        url,
        method="POST",
        json=payload,
        silent_status=(401, 403),
    )
    if not data:
        return []

    out: list[Job] = []
    for p in data.get("jobPostings", []):
        title = p.get("title", "")
        locations_text = p.get("locationsText", "") or ""
        if not matches_keywords(f"{title} {locations_text}", keywords):
            continue
        ext = p.get("externalPath", "")
        out.append(
            Job(
                title=title,
                company=tenant,
                city=locations_text,
                salary="",
                jd="",
                url=f"{host.rstrip('/')}/{site}{ext}" if ext else "",
                source="workday",
            )
        )
    log.info("workday[%s/%s]: %d/%d match", tenant, site, len(out), len(data.get("jobPostings", [])))
    return out
