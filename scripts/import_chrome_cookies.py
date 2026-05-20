#!/usr/bin/env python3
"""Import zhipin.com (Boss直聘) cookies from the user's logged-in Chrome and
save them as a Playwright storage_state JSON. Run this once whenever Boss
session has expired — much easier than logging into a fresh Playwright window
because Boss treats your real Chrome as a trusted browser.

Usage:
  uv run python scripts/import_chrome_cookies.py

macOS will prompt for Keychain access the first time (needed to decrypt
Chrome's encrypted cookies). Approve it once.

If Chrome is currently running it may hold a lock on the cookie DB; the
script will retry by copying the DB to a temp location.
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
from pathlib import Path

import browser_cookie3

ROOT = Path(__file__).resolve().parents[1]
STATE_PATH = ROOT / "data" / "boss_state.json"
CHROME_COOKIES = (
    Path.home() / "Library/Application Support/Google/Chrome/Default/Cookies"
)
TARGET_DOMAINS = ("zhipin.com", ".zhipin.com", "www.zhipin.com")


def _read_chrome_cookies():
    """Try direct read; if locked (Chrome running), copy DB to a temp file."""
    try:
        return browser_cookie3.chrome(domain_name="zhipin.com")
    except Exception as e:
        print(f"[import] direct chrome cookie read failed ({e}); trying copy…")
        with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as tmp:
            shutil.copy2(CHROME_COOKIES, tmp.name)
            return browser_cookie3.chrome(
                cookie_file=tmp.name, domain_name="zhipin.com"
            )


def main() -> int:
    if not CHROME_COOKIES.exists():
        print(f"[import] ❌ Chrome cookies DB not found at {CHROME_COOKIES}")
        return 1

    print("[import] 读取 Chrome 里的 zhipin.com cookies …")
    try:
        jar = _read_chrome_cookies()
    except Exception as e:
        print(f"[import] ❌ 读取失败: {e}")
        print("[import] 提示:可能需要授权 macOS Keychain 访问,或先关掉 Chrome 再重试。")
        return 2

    cookies = []
    for c in jar:
        if not any(d in (c.domain or "") for d in TARGET_DOMAINS):
            continue
        cookies.append({
            "name": c.name,
            "value": c.value,
            "domain": c.domain,
            "path": c.path or "/",
            "expires": int(c.expires) if c.expires else -1,
            "httpOnly": bool(getattr(c, "_rest", {}).get("HttpOnly", False)),
            "secure": bool(c.secure),
            "sameSite": "Lax",
        })

    if not cookies:
        print("[import] ❌ 没找到任何 zhipin.com 的 cookie。你日常 Chrome 没登 Boss?")
        return 3

    print(f"[import] 找到 {len(cookies)} 条 zhipin.com cookies。")
    storage_state = {"cookies": cookies, "origins": []}
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(
        json.dumps(storage_state, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    # Probe for the canonical Boss session cookie name to confirm it looks valid.
    has_geek = any(c["name"] in ("__zp_geek_token__", "geek_zp_token", "wt2") for c in cookies)
    print(f"[import] ✅ 已写到 {STATE_PATH}")
    print(f"[import] {'看到核心会话 cookie ✓' if has_geek else '⚠️ 未识别核心 session cookie,跑一次看看结果'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
