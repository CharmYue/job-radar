#!/usr/bin/env python3
"""Job Radar daily entry point.

Default (no args)              -> auto: ATS + Brave Search (no manual file needed)
--import path/to/jobs.json     -> use the given JSON file only
--ats-only                     -> auto ATS + Brave (explicit; same as no args)
--dry-run                      -> print report to stdout, do not push
--no-dedup                     -> skip the 30-day dedup
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
import traceback
from datetime import date
from pathlib import Path

import httpx
import yaml
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

load_dotenv(ROOT / ".env")

from job_radar import brave_searcher, push, report, score, storage  # noqa: E402
from job_radar.models import Job  # noqa: E402
from job_radar.scrapers import runner as ats_runner  # noqa: E402

log = logging.getLogger("run_daily")


def load_profile() -> dict:
    with open(ROOT / "config" / "profile.yaml", encoding="utf-8") as f:
        return yaml.safe_load(f)


def load_jobs(path: Path) -> list[Job]:
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    return [Job(**item) for item in raw]


async def _emergency_push(error_summary: str) -> None:
    """Best-effort error notification — never raises further."""
    try:
        await push.push_markdown(
            f"## ⚠️ 今日 Job Radar 运行失败\n\n```\n{error_summary[:1500]}\n```\n",
            f"⚠️ Job Radar 失败 {date.today().isoformat()}",
        )
    except Exception as e:
        log.error("emergency push also failed: %s", e)


async def _gather_jobs(args, profile) -> tuple[list[Job], list[Job], list[Job]]:
    """Returns (imported, ats, brave) — three independent buckets."""
    imported: list[Job] = []
    ats: list[Job] = []
    brave: list[Job] = []

    if args.import_path:
        path = Path(args.import_path)
        if not path.is_absolute():
            path = ROOT / path
        imported = load_jobs(path)
        log.info("imported %d jobs from %s", len(imported), path)
        return imported, ats, brave

    targets_path = ROOT / "config" / "ats_targets.yaml"
    ats, brave = await asyncio.gather(
        ats_runner.fetch_all(targets_path, profile),
        brave_searcher.search(),
    )
    return imported, ats, brave


async def _run_inner(args) -> int:
    profile = load_profile()
    storage.init_db()

    imported, ats, brave = await _gather_jobs(args, profile)
    all_jobs = imported + ats + brave

    if not all_jobs:
        log.warning("no jobs collected from any source")
        today = date.today().isoformat()
        empty_md = f"## 📭 {today} 今日无新岗位\n\n所有来源(导入/ATS/Brave)均为 0 条。\n"
        if not args.dry_run:
            await push.push_markdown(empty_md, f"📭 Job Radar {today} 今日无新岗位")
        else:
            print(empty_md)
        storage.save_report(today, empty_md, 0, 0, 0)
        return 0

    if not args.no_dedup:
        before = len(all_jobs)
        all_jobs = [j for j in all_jobs if not storage.is_duplicate(j.job_id)]
        if len(all_jobs) < before:
            log.info("dedup: %d -> %d (skipped %d already-seen)",
                     before, len(all_jobs), before - len(all_jobs))

    if not all_jobs:
        today = date.today().isoformat()
        empty_md = f"## 📭 {today} 今日无新岗位\n\n抓到的全部已在 30 天内推送过,被去重过滤。\n"
        if not args.dry_run:
            await push.push_markdown(empty_md, f"📭 Job Radar {today} 全部去重")
        else:
            print(empty_md)
        storage.save_report(today, empty_md, 0, 0, 0)
        return 0

    log.info("scoring %d jobs (imported=%d, ats=%d, brave=%d)",
             len(all_jobs), len(imported), len(ats), len(brave))
    scored = await score.score_all(all_jobs, profile)

    today = date.today().isoformat()
    full_md, counts = report.build_report(scored, today)

    ats_count = len(ats)
    brave_count = len(brave)
    if ats_count == 0 and brave_count > 0 and not args.import_path:
        prefix = (f"## 📭 {today} 今日 ATS 抓取 0 条\n"
                  f"下方为 Brave Search 补量结果 ({brave_count} 条):\n\n")
        full_md = prefix + full_md

    local_report_path = ROOT / "data" / f"report_{today}.md"
    if not args.dry_run:
        local_report_path.write_text(full_md, encoding="utf-8")
        log.info("wrote full report to %s", local_report_path)

    push_md, _ = report.build_compact_report(scored, today, local_path=str(local_report_path))

    if args.dry_run:
        print("\n" + "=" * 60)
        print(f"DRY RUN — imported={len(imported)} ats={ats_count} brave={brave_count}")
        print("=" * 60)
        print(push_md)
        print("=" * 60)
        print(f"统计: total={counts['total']} S={counts['s_count']} A={counts['a_count']}")
    else:
        await push.push_markdown(
            push_md,
            f"求职日报 {today} | {counts['s_count']} 个 S 级 / {counts['a_count']} 个 A 级",
        )
        storage.mark_pushed(today)

    if not args.dry_run:
        for s in scored:
            storage.save_job(s)
        storage.save_report(today, full_md, counts["total"], counts["s_count"], counts["a_count"])
    else:
        log.info("dry-run: skipping db writes to preserve dedup state")
    return 0


async def _run(args) -> int:
    try:
        return await _run_inner(args)
    except Exception as e:
        tb = traceback.format_exc()
        log.error("daily run failed:\n%s", tb)
        if not args.dry_run:
            err_text = f"{type(e).__name__}: {e}\n\n{tb}"
            await _emergency_push(err_text)
        return 1


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--import", dest="import_path", default=None,
                    help="JSON file containing jobs (skip ATS/Brave)")
    ap.add_argument("--ats-only", action="store_true",
                    help="Explicit ATS + Brave mode (same as no --import)")
    ap.add_argument("--dry-run", action="store_true",
                    help="Print report to stdout, do not push to WxPusher")
    ap.add_argument("--no-dedup", action="store_true",
                    help="Skip the 30-day dedup check")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s: %(message)s",
    )

    return asyncio.run(_run(args))


if __name__ == "__main__":
    raise SystemExit(main())
