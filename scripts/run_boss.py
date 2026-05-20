#!/usr/bin/env python3
"""Boss直聘 daily run: scrape → score → push.

Wired up by launchd/com.jobradar.boss.plist for the 17:00 trigger.
Also works manually:  uv run python scripts/run_boss.py [--dry-run]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import traceback
from datetime import date
from pathlib import Path

import yaml
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

load_dotenv(ROOT / ".env")

from job_radar import push, report, score, storage  # noqa: E402
from job_radar.scrapers import boss  # noqa: E402

log = logging.getLogger("run_boss")
STATE_FILE = ROOT / "data" / "boss_state.json"


def load_profile() -> dict:
    with open(ROOT / "config" / "profile.yaml", encoding="utf-8") as f:
        return yaml.safe_load(f)


async def _emergency_push(summary: str, body: str) -> None:
    try:
        await push.push_markdown(body, summary)
    except Exception as e:
        log.error("emergency push failed: %s", e)


async def _run_inner(args) -> int:
    profile = load_profile()
    storage.init_db()

    try:
        jobs = await boss.scrape_boss(
            STATE_FILE,
            limit_per_query=args.limit,
            headless=not args.headed,
        )
    except boss.SessionExpired as e:
        log.warning("boss session expired: %s", e)
        if not args.dry_run:
            await _emergency_push(
                f"⚠️ Boss session 过期 {date.today().isoformat()}",
                f"## ⚠️ Boss session 已过期\n\n请在 Mac 终端运行:\n\n"
                f"```\ncd ~/job-radar && uv run python scripts/boss_login.py\n```\n\n"
                f"扫码后明天 17:00 自动跑回来。",
            )
        return 2

    if not jobs:
        log.warning("boss returned 0 jobs")
        if not args.dry_run:
            await _emergency_push(
                f"📭 Boss 今日 0 条 {date.today().isoformat()}",
                f"## 📭 {date.today().isoformat()} Boss 抓取 0 条\n\n"
                f"可能 Boss 改了页面结构,或反爬触发。看 `data/boss_daily.log`。",
            )
        return 0

    today = date.today().isoformat()

    # Snapshot raw jobs so user can audit what was scanned.
    raw_path = ROOT / "data" / f"boss_raw_{today}.json"
    raw_path.write_text(
        json.dumps([j.__dict__ for j in jobs], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    log.info("raw snapshot: %s (%d jobs)", raw_path, len(jobs))

    if not args.no_dedup:
        before = len(jobs)
        jobs = [j for j in jobs if not storage.is_duplicate(j.job_id)]
        log.info("boss dedup: %d -> %d", before, len(jobs))

    if not jobs:
        if not args.dry_run:
            await _emergency_push(
                f"📭 Boss {today} 全部去重",
                f"## 📭 {today} Boss 全部去重\n\n抓到 {len(jobs)} 条新岗位,全部 30 天内推送过。",
            )
        return 0

    log.info("scoring %d Boss jobs", len(jobs))
    scored = await score.score_all(jobs, profile)

    md, counts = report.build_report(scored, today)
    md = f"## 🎯 Boss 雷达 {today}\n\n_(从 {len(jobs)} 条新岗位中筛选,完整原始数据见 `data/boss_raw_{today}.json`)_\n\n" + md.split("\n", 2)[-1]

    if args.dry_run:
        print(md)
        print(f"\n统计: total={counts['total']} S={counts['s_count']} A={counts['a_count']}")
    else:
        await push.push_markdown(
            md,
            f"Boss 雷达 {today} | {counts['s_count']} 个 S 级 / {counts['a_count']} 个 A 级",
        )
        storage.mark_pushed(today)
        for s in scored:
            storage.save_job(s)
        storage.save_report(today, md, counts["total"], counts["s_count"], counts["a_count"])

    return 0


async def _run(args) -> int:
    try:
        return await _run_inner(args)
    except Exception as e:
        tb = traceback.format_exc()
        log.error("boss run failed:\n%s", tb)
        if not args.dry_run:
            await _emergency_push(
                f"⚠️ Boss 雷达失败 {date.today().isoformat()}",
                f"## ⚠️ Boss 雷达运行失败\n\n```\n{type(e).__name__}: {e}\n\n{tb[:1500]}\n```",
            )
        return 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="Print report, do not push")
    ap.add_argument("--no-dedup", action="store_true", help="Skip 30-day dedup")
    ap.add_argument("--limit", type=int, default=20, help="Jobs per query")
    ap.add_argument("--headed", action="store_true", help="Show browser (debug)")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s: %(message)s",
    )
    return asyncio.run(_run(args))


if __name__ == "__main__":
    raise SystemExit(main())
