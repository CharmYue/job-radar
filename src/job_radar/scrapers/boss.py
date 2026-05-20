"""Boss直聘 scraper using Playwright with a saved storage_state.

One-time login (see scripts/boss_login.py) writes the session cookies to
`data/boss_state.json`. Subsequent daily runs reuse that state to scrape
search results headlessly.
"""
from __future__ import annotations

import asyncio
import logging
import re
from pathlib import Path
from urllib.parse import quote

from playwright.async_api import (
    Browser,
    BrowserContext,
    TimeoutError as PWTimeout,
    async_playwright,
)

from ..models import Job

log = logging.getLogger(__name__)


class SessionExpired(RuntimeError):
    """Raised when Boss redirects to the login wall — cookies are stale."""


CITY_CODES = {
    "上海": "101020100",
    "杭州": "101210100",
    "北京": "101010100",
}

DEFAULT_QUERIES = [
    "解决方案工程师",
    "AI 解决方案",
    "Solution Engineer",
    "Customer Engineer",
    "AI 英语",
    "AI 出海",
]

SEARCH_URL = "https://www.zhipin.com/web/geek/job?query={q}&city={c}"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"
)


_EXTRACT_JS = r"""
(() => {
  const out = [];
  const seen = new Set();
  for (const a of document.querySelectorAll('a[href*="/job_detail/"]')) {
    const href = a.href;
    if (!href || seen.has(href)) continue;
    seen.add(href);
    // Walk up to the card container.
    let card = a;
    for (let i = 0; i < 6 && card && card.parentElement; i++) {
      card = card.parentElement;
      if (card.tagName === 'LI' || /job-card/i.test(card.className || '')) break;
    }
    const title = (a.textContent || '').trim();
    if (!title || title.length > 80) continue;
    // Walk visible text only (Boss injects hidden chars for salary).
    const txt = (node) => {
      if (!node) return '';
      if (node.nodeType === 3) return node.textContent;
      if (node.nodeType !== 1) return '';
      const s = getComputedStyle(node);
      if (s.display === 'none' || s.visibility === 'hidden') return '';
      let out = '';
      for (const c of node.childNodes) out += txt(c);
      return out;
    };
    const cardText = txt(card).trim().replace(/\s+/g, ' ');
    out.push({ title, href, cardText });
  }
  return out;
})();
"""


_EXP_VALUES = ("经验不限", "在校生", "应届生", "1年以内",
               "1-3年", "3-5年", "5-10年", "10年以上")
_EDU_VALUES = ("学历不限", "初中及以下", "中专/中技", "高中",
               "大专", "本科", "硕士", "博士")
_SALARY_PREFIX_RE = re.compile(r"^[‐\-]K(?:·薪)?")


def _split_card(title: str, card_text: str) -> tuple[str, str, str, str]:
    """Return (company, city_full, experience, education) parsed from Boss card text.

    Boss list cards have the pattern:
       <title><salary placeholder><experience><education><company> <city>
    Example: "AI MaaS解决方案工程师-K经验不限本科某大型知名互联网公司 上海"
    Salary digits are obfuscated via webfont, so the visible-text leaves "-K" or
    "-K·薪" placeholders.
    """
    body = card_text
    if body.startswith(title):
        body = body[len(title):]
    m = _SALARY_PREFIX_RE.match(body)
    if m:
        body = body[m.end():]
    exp = ""
    for v in _EXP_VALUES:
        if body.startswith(v):
            exp = v
            body = body[len(v):]
            break
    edu = ""
    for v in _EDU_VALUES:
        if body.startswith(v):
            edu = v
            body = body[len(v):]
            break
    body = body.strip()
    # Company is everything up to the last space (which separates from city).
    if " " in body:
        company, city_full = body.rsplit(" ", 1)
    else:
        company, city_full = body, ""
    return company.strip(), city_full.strip(), exp, edu


def _parse_card(title: str, href: str, card_text: str, query: str, city: str) -> Job:
    company, city_full, exp, edu = _split_card(title, card_text)
    return Job(
        title=title,
        company=company or "(未知)",
        city=city_full or city,
        salary="待议",
        jd=(
            f"经验: {exp or '未注明'} | 学历: {edu or '未注明'} | "
            f"[Boss 列表页摘要,query={query}] {card_text}"
        ),
        url=href,
        source="boss",
    )


async def _scrape_one(
    context: BrowserContext, query: str, city: str, limit: int
) -> list[Job]:
    code = CITY_CODES[city]
    url = SEARCH_URL.format(q=quote(query), c=code)
    page = await context.new_page()
    try:
        await page.goto(url, wait_until="domcontentloaded", timeout=30_000)
        # Wait for at least one job link to appear; if redirected to login, surface it.
        try:
            await page.wait_for_selector(
                'a[href*="/job_detail/"]', timeout=15_000
            )
        except PWTimeout:
            current = page.url
            if "/web/user/" in current or "/login" in current:
                raise SessionExpired(f"redirected to login wall: {current}")
            log.warning("no job links for q=%r c=%s (url=%s)", query, city, current)
            return []

        # Settle a bit so JS-rendered cards stabilize.
        await page.wait_for_timeout(1500)

        raw = await page.evaluate(_EXTRACT_JS)
        out: list[Job] = []
        for item in raw[:limit]:
            out.append(_parse_card(item["title"], item["href"], item["cardText"], query, city))
        log.info("boss[%s|%s]: %d cards", query, city, len(out))
        return out
    finally:
        await page.close()


async def scrape_boss(
    storage_state: str | Path,
    *,
    queries: list[str] | None = None,
    cities: list[str] | None = None,
    limit_per_query: int = 20,
    headless: bool = True,
) -> list[Job]:
    """Scrape Boss直聘 for jobs matching queries × cities.

    Raises SessionExpired when cookies have expired (caller should push a
    notice asking the user to re-run boss_login.py).
    """
    queries = queries or DEFAULT_QUERIES
    cities = cities or ["上海", "杭州", "北京"]
    storage_state = Path(storage_state)
    if not storage_state.exists():
        raise FileNotFoundError(
            f"Boss session file missing: {storage_state}. "
            f"Run `uv run python scripts/boss_login.py` first."
        )

    async with async_playwright() as pw:
        browser: Browser = await pw.chromium.launch(headless=headless)
        context = await browser.new_context(
            storage_state=str(storage_state),
            user_agent=USER_AGENT,
            viewport={"width": 1440, "height": 900},
            locale="zh-CN",
        )
        # Hide navigator.webdriver — basic anti-detection.
        await context.add_init_script(
            "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});"
        )

        all_jobs: list[Job] = []
        try:
            for q in queries:
                for city in cities:
                    try:
                        jobs = await _scrape_one(context, q, city, limit_per_query)
                        all_jobs.extend(jobs)
                    except SessionExpired:
                        raise
                    except Exception as e:
                        log.warning("boss[%s|%s] failed: %s", q, city, e)
                    # Small jitter between queries to avoid burst patterns.
                    await asyncio.sleep(1.5)
        finally:
            await context.close()
            await browser.close()

    # Dedup by URL (same posting may surface across queries).
    seen, dedup = set(), []
    for j in all_jobs:
        if j.url in seen:
            continue
        seen.add(j.url)
        dedup.append(j)
    log.info("boss total: %d cards (%d after dedup)", len(all_jobs), len(dedup))
    return dedup
