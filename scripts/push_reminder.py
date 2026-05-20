#!/usr/bin/env python3
"""17:00 reminder: WxPusher poke to fire up the Boss extension."""
from __future__ import annotations

import asyncio
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from dotenv import load_dotenv  # noqa: E402

load_dotenv(ROOT / ".env")

from job_radar import push  # noqa: E402


async def main() -> int:
    today = date.today().isoformat()
    md = (
        f"## ⏰ Boss 雷达提醒 {today}\n\n"
        "现在是 17:00 — 打开 Chrome,点 **Boss 采集** 扩展图标 → 开始。\n\n"
        "跑完点 **导出 job-radar JSON**,存到 `~/job-radar/data/`,然后:\n\n"
        "```\n"
        "cd ~/job-radar && uv run python scripts/run_daily.py --import data/boss_<日期>.json\n"
        "```\n\n"
        "等 1-2 分钟会收到打分日报推送。"
    )
    await push.push_markdown(md, f"⏰ Boss 采集时间到了 ({today})")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
