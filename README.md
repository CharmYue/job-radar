# job-radar

个人求职雷达 —— 自动抓 ATS 岗位 + Boss直聘,用 LLM 按你的简历打分,每天一份 Markdown 摘要推到微信。

> 私人项目,假设你是 AI Solution Engineer / Customer Engineer 方向。`/boss` 命令依赖 Claude Code + claude-in-chrome 浏览器扩展。

## 它做什么

1. **早 6:30(launchd 定时)**:抓取配置好的 Greenhouse / Lever / SmartRecruiters / Workday 接口 + 一轮 Brave Search → 城市/角色预筛 → DeepSeek V4 拿你的 `data/resume.md` + `config/profile.yaml` 打分 → 推送精简报告到微信。
2. **下午 17:00(launchd 定时)**:微信推送提醒你跑 `/boss`。
3. **手动 `/boss`(Claude Code)**:让 claude-in-chrome 驱动你已登录的 Chrome 跑 18 次 Boss 搜索(6 query × 3 城市),解码 webfont 混淆的薪资,按你的 `target_monthly_min` 过滤,打分,推送。

每跑一次会在 SQLite 留一条 30 天去重记录,完整报告写到 `data/report_<日期>.md`。

## 前置条件

- **macOS**(Linux 也行,把 launchd 换成 cron / systemd)
- **Python 3.11+** 加 [uv](https://docs.astral.sh/uv/)
- API 账号(部分免费部分付费):
  - **DeepSeek V4** —— 主打分模型([deepseek.com](https://platform.deepseek.com))
  - **Azure OpenAI** —— 可选的 fallback
  - **WxPusher** —— 免费,微信推送通道([wxpusher.zjiecode.com](https://wxpusher.zjiecode.com))
  - **Brave Search** —— 免费 tier([brave.com/search/api](https://brave.com/search/api/))
- 仅 `/boss` 流程需要:**Claude Code** + **claude-in-chrome** 浏览器扩展 + 一个已登录 Boss直聘 的 Chrome

## 安装

```bash
git clone https://github.com/CharmYue/job-radar.git ~/job-radar
cd ~/job-radar

# 1. 装依赖
uv sync

# 2. 配置 API key
cp .env.example .env
$EDITOR .env                            # 填入各家 API key

# 3. 配置个人画像和简历
cp config/profile.example.yaml config/profile.yaml
$EDITOR config/profile.yaml             # 设置目标薪资、岗位关键词、hard reject
$EDITOR data/resume.md                  # 粘贴完整简历(Markdown 即可)

# 4. (可选)ATS 目标公司
$EDITOR config/ats_targets.yaml         # Greenhouse / Lever 等的公司 slug

# 5. Dry-run 验证 — 用仓库自带的 sample
uv run python scripts/run_daily.py --import data/sample_jobs.json --dry-run
```

## 每日自动跑(早 6:30)

```bash
# 把示例 plist 里的 __HOME__ 替换成你的 $HOME,再 load:
sed "s|__HOME__|$HOME|g" launchd/com.jobradar.daily.example.plist \
  > ~/Library/LaunchAgents/com.jobradar.daily.plist
launchctl load -w ~/Library/LaunchAgents/com.jobradar.daily.plist

# 17:00 的 Boss 提醒同理:
sed "s|__HOME__|$HOME|g" launchd/com.jobradar.bossreminder.example.plist \
  > ~/Library/LaunchAgents/com.jobradar.bossreminder.plist
launchctl load -w ~/Library/LaunchAgents/com.jobradar.bossreminder.plist
```

跑完看 `data/daily_out.log` / `data/jobradar.log`。完整报告在 `data/report_<日期>.md`,SQLite 去重库是 `data/jobs.db`。

## Boss直聘 流程(手动,经由 Claude Code)

早 6:30 的自动任务**故意跳过 Boss** —— 无人值守抓 Boss 几乎必封号。Boss 必须走你已登录的 Chrome,通过 claude-in-chrome:

1. 复制 `docs/boss-command.md` → `~/.claude/commands/boss.md`
2. 在 Claude Code 里,Chrome 打开任一 Boss 搜索页,输入 `/boss`
3. Claude 跑 18 次 navigate + 提取,解码 `kanzhun-mix` webfont 还原薪资,按 `target_monthly_min` 过滤,写 JSON,跑 `run_daily.py --import`,推送报告

整轮 5-10 分钟。Boss 弹验证码的时候别跑。

## 仓库结构

```
src/job_radar/
  models.py        # Job、ScoredJob 数据类
  score.py         # DeepSeek 主 + AsyncAzureOpenAI fallback,Semaphore(3)
  push.py          # WxPusher REST(httpx,content 上限 10000 字)
  storage.py       # SQLite jobs + daily_reports
  report.py        # build_report() 完整版 + build_compact_report() 推送版
  brave_searcher.py
  scrapers/        # Greenhouse / Lever / SmartRecruiters / Workday + runner

scripts/
  run_daily.py     # 主入口:--import | --ats-only | --dry-run | --no-dedup
  push_reminder.py # 17:00 微信戳一下提醒跑 /boss
  import_chrome_cookies.py  # (旧)Playwright 抓 Boss 时的 cookie 导入,已弃用

config/
  profile.example.yaml      # 模板 — copy 成 profile.yaml 再填
  ats_targets.yaml          # 要查的公司 slug 清单

launchd/                    # macOS 定时任务模板(load 前替换 __HOME__)
docs/
  boss-command.md           # /boss slash command 定义
data/
  sample_jobs.json          # demo 输入 — 可以 commit
  resume.md                 # 你的简历(gitignored)
  jobs.db                   # SQLite 去重 + 报告归档(gitignored)
  report_<日期>.md          # 每日完整报告(gitignored)
```

## 已知限制

- **Boss webfont 映射**:`codepoint - 57393 = 数字` 这条规则对应当前 `kanzhun-mix` 字体。如果 Boss 换字体,需要下载新的 woff2 用 fonttools 看 `cmap` 重建映射。
- **英文 Boss query**(Solution Engineer / Customer Engineer)命中量非常少,主要靠中文 query(解决方案工程师 / AI 解决方案)出量。
- **Boss session 会过期**:Chrome 里定期重新扫码登录一次。
- **launchd 不展开 `$HOME`**:示例 plist 用 `__HOME__` 占位,load 前必须替换。
- **个人数据**:`config/profile.yaml`、`data/resume.md`、`data/*.json`、`data/*.md`、`data/boss_state.json`、`data/jobs.db` 都在 `.gitignore` 里。第一次 commit 前再 `git status` 过一眼最稳。

## License

MIT —— 见 [LICENSE](LICENSE)。
