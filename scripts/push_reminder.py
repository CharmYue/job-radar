#!/usr/bin/env python3
"""17:00 reminder: ping the user via WxPusher to open Claude and run /boss."""
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
        "现在是 17:00 — 打开 Claude Code,输入 `/boss` 跑一次今天的 Boss 岗位扫描。\n\n"
        "5-10 分钟后会收到打分日报推送。"
    )
    await push.push_markdown(md, f"⏰ /boss 时间到了 ({today})")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
