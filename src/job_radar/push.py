from __future__ import annotations

import logging
import os

import httpx

log = logging.getLogger(__name__)

API_URL = "https://wxpusher.zjiecode.com/api/send/message"
MAX_CONTENT = 10000


async def push_markdown(markdown: str, summary: str) -> dict:
    token = os.getenv("WXPUSHER_APP_TOKEN")
    uid = os.getenv("WXPUSHER_UID")
    if not token or not uid:
        raise RuntimeError("WxPusher 未配置: 缺少 WXPUSHER_APP_TOKEN 或 WXPUSHER_UID")

    content = markdown if len(markdown) <= MAX_CONTENT else markdown[: MAX_CONTENT - 20] + "\n\n…(已截断)"

    payload = {
        "appToken": token,
        "content": content,
        "contentType": 3,
        "summary": summary[:100],
        "uids": [uid],
    }

    async with httpx.AsyncClient(timeout=15.0) as cx:
        resp = await cx.post(API_URL, json=payload)
        resp.raise_for_status()
        data = resp.json()

    if not data.get("success"):
        raise RuntimeError(f"WxPusher 推送失败: {data}")
    log.info("WxPusher push ok: %s", summary[:60])
    return data
