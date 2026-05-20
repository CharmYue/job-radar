"""One-shot push debugger — prints the full WxPusher response so we can see
per-uid delivery status (the top-level `success` only means the request was
accepted, not that the user actually received it)."""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

import httpx
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")

API = "https://wxpusher.zjiecode.com/api/send/message"


async def main() -> int:
    token = os.getenv("WXPUSHER_APP_TOKEN")
    uid = os.getenv("WXPUSHER_UID")

    print(f"APP_TOKEN: {'set, len=' + str(len(token)) if token else 'MISSING'}")
    print(f"UID:       {'set, len=' + str(len(uid)) if uid else 'MISSING'}")
    if token:
        print(f"APP_TOKEN prefix: {token[:6]}…{token[-4:]}")
    if uid:
        print(f"UID prefix:       {uid[:6]}…{uid[-4:]}  (whitespace? {repr(uid)[:25]})")

    if not token or not uid:
        return 1

    payload = {
        "appToken": token.strip(),
        "content": "🧪 Job Radar 推送测试 — 如果看到这条说明配置正确",
        "contentType": 1,
        "summary": "Job Radar 测试",
        "uids": [uid.strip()],
    }

    async with httpx.AsyncClient(timeout=15) as cx:
        resp = await cx.post(API, json=payload)
    print(f"\nHTTP {resp.status_code}")
    print("Response body:")
    print(json.dumps(resp.json(), indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
