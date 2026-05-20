# job-radar

Personal job hunting radar for AI Solution Engineer / Customer Engineer roles in
China. Pulls postings from ATS endpoints + Brave Search + (manually) Boss直聘,
LLM-scores them against your resume, and pushes a daily Markdown digest to
WeChat via WxPusher.

> Built for personal use — config files contain your resume and salary
> targets. The slash command for Boss assumes Claude Code + claude-in-chrome.

## What it does

1. **6:30am (launchd):** auto-fetches Greenhouse/Lever/SmartRecruiters/Workday
   ATS endpoints + a Brave Search pass → city/role pre-filter → DeepSeek V4
   scores against `data/resume.md` + `config/profile.yaml` → pushes compact
   report to WeChat.
2. **5:00pm (launchd):** sends a WeChat reminder to run `/boss` in Claude Code.
3. **Manual `/boss`:** drives claude-in-chrome to scrape Boss直聘 search
   results (18 query × city combos), decodes the webfont-obfuscated salaries,
   filters by your `target_monthly_min`, scores, pushes.

Each run writes a 30-day dedup row to SQLite and a full Markdown report to
`data/report_<date>.md`.

## Prerequisites

- **macOS** (Linux works if you swap launchd → cron/systemd)
- **Python 3.11+** and [uv](https://docs.astral.sh/uv/)
- API access (paid + free mix):
  - **DeepSeek V4** API key — primary scorer ([deepseek.com](https://platform.deepseek.com))
  - **Azure OpenAI** — optional fallback scorer
  - **WxPusher** — free, for WeChat push ([wxpusher.zjiecode.com](https://wxpusher.zjiecode.com))
  - **Brave Search** API — free tier ([brave.com/search/api](https://brave.com/search/api/))
- For `/boss` flow only: **Claude Code** + **claude-in-chrome** browser extension + Chrome with active Boss直聘 session

## Setup

```bash
git clone <your-fork-url> ~/job-radar
cd ~/job-radar

# 1. Install deps
uv sync

# 2. Configure secrets
cp .env.example .env
$EDITOR .env                            # fill in API keys

# 3. Configure your profile & resume
cp config/profile.example.yaml config/profile.yaml
$EDITOR config/profile.yaml             # set target salary, roles, hard-rejects
$EDITOR data/resume.md                  # paste your full resume (markdown OK)

# 4. (Optional) ATS targets
$EDITOR config/ats_targets.yaml         # company slugs for Greenhouse / Lever / etc

# 5. Dry-run with the included sample
uv run python scripts/run_daily.py --import data/sample_jobs.json --dry-run
```

## Daily run (auto, 6:30am)

```bash
# Adjust the example plist paths to your $HOME, then load:
sed "s|__HOME__|$HOME|g" launchd/com.jobradar.daily.example.plist \
  > ~/Library/LaunchAgents/com.jobradar.daily.plist
launchctl load -w ~/Library/LaunchAgents/com.jobradar.daily.plist

# Same for the 17:00 Boss reminder:
sed "s|__HOME__|$HOME|g" launchd/com.jobradar.bossreminder.example.plist \
  > ~/Library/LaunchAgents/com.jobradar.bossreminder.plist
launchctl load -w ~/Library/LaunchAgents/com.jobradar.bossreminder.plist
```

Inspect runs in `data/daily_out.log` / `data/jobradar.log`. The full report lands
in `data/report_<date>.md`; the SQLite dedup DB is `data/jobs.db`.

## Boss直聘 flow (manual, via Claude Code)

The 6:30am auto-run intentionally **skips Boss** — autonomous scraping gets
accounts banned. Boss runs through your already-logged-in Chrome via
claude-in-chrome:

1. Copy `docs/boss-command.md` → `~/.claude/commands/boss.md`
2. In Claude Code, with Chrome open on a Boss search page, type `/boss`
3. Claude drives 18 navigate+extract cycles, decodes salaries from the
   `kanzhun-mix` webfont, filters by your `target_monthly_min`, writes JSON,
   runs `run_daily.py --import`, pushes report

Takes 5-10 minutes end-to-end. Don't run while Boss is doing CAPTCHA challenges.

## Repository layout

```
src/job_radar/
  models.py        # Job, ScoredJob dataclasses
  score.py         # DeepSeek primary + AsyncAzureOpenAI fallback, Semaphore(3)
  push.py          # WxPusher REST (httpx, content max 10000)
  storage.py       # SQLite jobs + daily_reports
  report.py        # build_report() full + build_compact_report() for push
  brave_searcher.py
  scrapers/        # Greenhouse / Lever / SmartRecruiters / Workday + runner

scripts/
  run_daily.py     # main entry: --import | --ats-only | --dry-run | --no-dedup
  push_reminder.py # 17:00 WeChat poke to trigger /boss
  import_chrome_cookies.py  # (legacy) cookie import for Playwright Boss attempt

config/
  profile.example.yaml      # template — copy to profile.yaml, fill in
  ats_targets.yaml          # company slugs to query

launchd/                    # macOS scheduling templates (replace __HOME__)
docs/
  boss-command.md           # the /boss slash command for Claude Code
data/
  sample_jobs.json          # demo input — safe to commit
  resume.md                 # your resume (gitignored)
  jobs.db                   # SQLite dedup + report archive (gitignored)
  report_<date>.md          # full daily report (gitignored)
```

## Known limitations

- **Boss webfont mapping**: the `codepoint - 57393 = digit` rule encodes the
  current `kanzhun-mix` font. If Boss rotates the font, you'll need to rebuild
  the mapping (download the woff2, inspect `cmap` with fonttools).
- **English Boss queries** (Solution Engineer / Customer Engineer) return very
  few hits — Chinese queries (解决方案工程师 / AI 解决方案) dominate yield.
- **Boss session expiry**: re-login in your Chrome periodically.
- **launchd path hardcode**: macOS launchd doesn't expand `$HOME`, so the
  example plists use `__HOME__` placeholder — substitute before loading.
- **Personal data**: `config/profile.yaml`, `data/resume.md`, `data/*.json`,
  `data/*.md`, `data/boss_state.json`, and `data/jobs.db` are gitignored.
  Double-check `git status` before your first commit.

## License

MIT — see [LICENSE](LICENSE).
