from __future__ import annotations

import asyncio
import logging
import os
import random
import re
from datetime import date
from urllib.parse import urlparse

import httpx

from .models import Job

log = logging.getLogger(__name__)

API_URL = "https://api.search.brave.com/res/v1/web/search"
UA = "JobRadar/0.1 (+https://github.com/local/job-radar)"

# Queries use `site:` to force individual-job URLs (LinkedIn /jobs/view/<id>
# or ATS-hosted boards). Generic queries against zhipin/liepin return SEO
# landing pages, not real postings.
QUERIES: list[str] = [
    'site:linkedin.com/jobs/view "Solution Engineer" 上海 OR Shanghai',
    'site:linkedin.com/jobs/view "Customer Engineer" 上海 OR Shanghai AI',
    'site:linkedin.com/jobs/view "AI 解决方案工程师"',
    'site:linkedin.com/jobs/view "Solutions Architect" 上海 OR 杭州 AI',
    'site:linkedin.com/jobs/view "售前工程师" AI 上海',
    '(site:boards.greenhouse.io OR site:jobs.lever.co OR site:jobs.smartrecruiters.com) "Solution Engineer" Shanghai',
]

# Strict: URL must look like an individual job posting, not a search/category/landing page.
INDIVIDUAL_JOB_URL = re.compile(
    r"linkedin\.com/jobs/view/\d+"
    r"|liepin\.com/(?:[a-z]+/)?job/\d+\.shtml"
    r"|zhipin\.com/job_detail/[\w]+\.html"
    r"|lagou\.com/(?:wn/)?jobs/\d+"
    r"|job-boards\.greenhouse\.io/[\w-]+/jobs/\d+"
    r"|boards\.greenhouse\.io/[\w-]+/jobs/\d+"
    r"|jobs\.lever\.co/[\w-]+/[a-f0-9-]{20,}"
    r"|jobs\.smartrecruiters\.com/.+/\d+"
    r"|myworkdayjobs\.com/.+/job/[^/]+/[^/]+_R-?\d+",
    re.IGNORECASE,
)

# Titles containing these tokens are SEO landing pages, not specific jobs.
SEO_LANDING_TITLE = re.compile(
    r"招聘网|招聘信息】|招聘频道|招聘\s*$|招聘\s*-|招聘信息_|招聘大全|"
    r"jobs?\s+(?:in|at|hiring)|hiring\s+now|career\s+page",
    re.IGNORECASE,
)


def _is_individual_job(url: str, title: str) -> bool:
    if not url or not INDIVIDUAL_JOB_URL.search(url):
        return False
    if title and SEO_LANDING_TITLE.search(title):
        return False
    return True


_SMARTREC_CANON = re.compile(r"^(https?://jobs\.smartrecruiters\.com/[^/]+/\d+)")


def _canonicalize(url: str) -> str:
    """Brave sometimes truncates the slug in SmartRecruiters URLs (leaving a
    trailing dash → HTTP 400). The slug is optional — drop it to the numeric
    job-id form, which redirects to the canonical page."""
    m = _SMARTREC_CANON.match(url)
    if m:
        return m.group(1)
    return url


# Statuses that mean the URL is genuinely dead (not antibot).
# 400 included because SmartRecruiters returns 400 for expired job IDs even
# on the canonical /<company>/<id> URL form.
_DEAD_STATUSES = {400, 404, 410, 500, 502, 503, 504}


async def _is_alive(client: httpx.AsyncClient, url: str) -> bool:
    try:
        r = await client.get(url, follow_redirects=True, timeout=8.0)
    except httpx.HTTPError as e:
        log.warning("validation fetch failed %s: %s", url, e)
        return True  # network flake — don't reject preemptively
    if r.status_code in _DEAD_STATUSES:
        log.info("dropping dead url (%d): %s", r.status_code, url)
        return False
    return True


async def _filter_alive(jobs: list[Job]) -> list[Job]:
    if not jobs:
        return jobs
    headers = {"User-Agent": UA}
    async with httpx.AsyncClient(timeout=8.0, headers=headers) as cx:
        flags = await asyncio.gather(*(_is_alive(cx, j.url) for j in jobs))
    alive = [j for j, ok in zip(jobs, flags) if ok]
    log.info("brave validation: %d -> %d alive", len(jobs), len(alive))
    return alive


def _company_from_url(url: str, fallback_title: str) -> str:
    try:
        host = urlparse(url).hostname or ""
    except Exception:
        host = ""
    host = host.lower().lstrip("www.")
    if "boards.greenhouse.io" in host or host.endswith("greenhouse.io"):
        parts = urlparse(url).path.strip("/").split("/")
        return parts[0] if parts else host
    if "jobs.lever.co" in host or host.endswith("lever.co"):
        parts = urlparse(url).path.strip("/").split("/")
        return parts[0] if parts else host
    if "myworkdayjobs.com" in host:
        return host.split(".")[0]
    if "linkedin.com" in host:
        m = re.search(r"\bat\s+([A-Z][\w&. \-]{1,40})", fallback_title or "")
        return (m.group(1).strip() if m else "LinkedIn")
    if host:
        return host.split(".")[0]
    return "(未知来源)"


def _pick_daily_queries(n: int = 2) -> list[str]:
    seed = int(date.today().strftime("%Y%m%d"))
    rng = random.Random(seed)
    return rng.sample(QUERIES, min(n, len(QUERIES)))


async def search(per_query_count: int = 10, query_count: int = 2) -> list[Job]:
    api_key = os.getenv("BRAVE_API_KEY") or os.getenv("Brave")
    if not api_key:
        log.warning("Brave key not set, skipping brave search")
        return []

    queries = _pick_daily_queries(query_count)
    log.info("brave: today's queries = %s", queries)

    headers = {
        "Accept": "application/json",
        "X-Subscription-Token": api_key.strip(),
    }

    jobs: list[Job] = []
    seen_urls: set[str] = set()
    async with httpx.AsyncClient(timeout=20, headers=headers) as cx:
        for q in queries:
            try:
                resp = await cx.get(
                    API_URL, params={"q": q, "count": per_query_count, "country": "CN"}
                )
                resp.raise_for_status()
                data = resp.json()
            except httpx.HTTPError as e:
                log.warning("brave query failed %s: %s", q, e)
                continue

            results = (data.get("web") or {}).get("results", [])
            kept = 0
            for r in results:
                url = r.get("url", "")
                title = r.get("title", "")
                if not url or not _is_individual_job(url, title):
                    continue
                url = _canonicalize(url)
                if url in seen_urls:
                    continue
                seen_urls.add(url)
                desc = r.get("description", "") or ""
                jobs.append(
                    Job(
                        title=title,
                        company=_company_from_url(url, title),
                        city="",
                        salary="待议",
                        jd=desc,
                        url=url,
                        source="brave",
                    )
                )
                kept += 1
            log.info("brave[%s]: kept %d / %d results", q[:32], kept, len(results))

    log.info("brave raw: %d jobs", len(jobs))
    jobs = await _filter_alive(jobs)
    log.info("brave total: %d jobs (alive)", len(jobs))
    return jobs
