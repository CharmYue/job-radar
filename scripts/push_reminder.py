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
        "现在是 17:00 — 打开 Chrome,点 **Boss 求职雷达** 扩展图标:\n\n"
        "1. 配置 tab → 关键词 + 城市 → 生成任务队列\n"
        "2. 运行 tab → 开始采集\n"
        "3. 跑完 → AI 全部打分 → 一键推送 WxPusher\n\n"
        "全程不用终端,5-10 分钟。"
    )
    await push.push_markdown(md, f"⏰ Boss 采集时间到了 ({today})")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
