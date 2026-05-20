from __future__ import annotations

import logging
from typing import Any

import httpx

log = logging.getLogger(__name__)

UA = "JobRadar/0.1 (+https://github.com/local/job-radar)"
DEFAULT_TIMEOUT = httpx.Timeout(15.0, connect=8.0)


async def fetch_json(
    url: str,
    *,
    method: str = "GET",
    json: dict | None = None,
    params: dict | None = None,
    silent_status: tuple[int, ...] = (),
) -> Any | None:
    """Fetch JSON; on status codes in `silent_status` return None without raising."""
    headers = {"User-Agent": UA, "Accept": "application/json"}
    async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT, headers=headers) as cx:
        resp = await cx.request(method, url, json=json, params=params)
    if resp.status_code in silent_status:
        log.warning("%s -> %s (silently skipped)", url, resp.status_code)
        return None
    resp.raise_for_status()
    return resp.json()


def matches_keywords(text: str, keywords: list[str] | None) -> bool:
    if not keywords:
        return True
    blob = text.lower()
    return any(k.lower() in blob for k in keywords)
