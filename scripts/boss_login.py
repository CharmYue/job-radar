#!/usr/bin/env python3
"""One-time Boss直聘 login. Opens a Chromium window, you scan the QR code in
your phone's WeChat, then we save your session cookies to data/boss_state.json.

Re-run this whenever the daily scraper says the session has expired
(typically every 14-30 days).
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
STATE_PATH = ROOT / "data" / "boss_state.json"
LOGIN_URL = "https://www.zhipin.com/web/user/?ka=header-login"
# Once login succeeds, Boss bounces the user back to a non-/user/ page.
LOGGED_IN_URL_PATTERN = "/web/geek/"


async def main() -> int:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)

    async with async_playwright() as pw:
        # Use the user's installed Chrome rather than Playwright's bundled
        # Chromium — Boss anti-bot fingerprints Chromium aggressively but lets
        # real Chrome through.
        try:
            browser = await pw.chromium.launch(headless=False, channel="chrome")
            print("[boss_login] using channel='chrome' (real Chrome binary)")
        except Exception as e:
            print(f"[boss_login] chrome channel failed ({e}), falling back to chromium")
            browser = await pw.chromium.launch(headless=False)
        context = await browser.new_context(
            viewport={"width": 1440, "height": 900},
            locale="zh-CN",
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"
            ),
        )
        page = await context.new_page()

        print(f"[boss_login] opening {LOGIN_URL}")
        try:
            await page.goto(LOGIN_URL, wait_until="networkidle", timeout=45000)
        except Exception as e:
            print(f"[boss_login] networkidle wait timed out ({e}), continuing anyway")
        await asyncio.sleep(2)  # extra settle time for Boss JS

        print("[boss_login] ============================================================")
        print("[boss_login] 请在弹出的 Chromium 窗口里登录 Boss直聘。")
        print("[boss_login] ")
        print("[boss_login] 注意:Boss 对 Playwright 关掉了微信扫码,你需要用:")
        print("[boss_login]   1) 「验证码登录/注册」tab → 输手机号 → 拖滑块 → 收 SMS → 输 6 位")
        print("[boss_login]   2) 也可能直接显示扫码 tab,优先用扫码")
        print("[boss_login] ")
        print("[boss_login] 登录成功后浏览器会自动跳走,本程序检测到后自动保存 cookie 并关闭。")
        print("[boss_login] 如果想取消,关浏览器窗口或终端 Ctrl+C。")
        print("[boss_login] ============================================================")

        # Wait up to 5 minutes for the user to log in.
        deadline = 60 * 5
        elapsed = 0
        while elapsed < deadline:
            await asyncio.sleep(2)
            elapsed += 2
            url = page.url
            if LOGGED_IN_URL_PATTERN in url and "/user/" not in url:
                print(f"[boss_login] 检测到登录成功(url={url})")
                break
        else:
            print("[boss_login] ❌ 5 分钟内未登录,放弃。")
            await context.close()
            await browser.close()
            return 1

        # Save the session cookies + localStorage.
        await context.storage_state(path=str(STATE_PATH))
        print(f"[boss_login] ✅ session 已保存到 {STATE_PATH}")

        await context.close()
        await browser.close()
        return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
