# job-radar

个人求职雷达 —— 自动抓 ATS 岗位 + Boss直聘,用 LLM 按你的简历打分,每天一份 Markdown 摘要推到微信。

> 私人项目,假设你是 AI Solution Engineer / Customer Engineer 方向。Boss 部分依赖随仓库附带的 Chrome 扩展(`extension/`)。

## 它做什么

1. **早 6:30(launchd 定时)**:抓取配置好的 Greenhouse / Lever / SmartRecruiters / Workday 接口 + 一轮 Brave Search → 城市/角色预筛 → DeepSeek V4 拿你的 `data/resume.md` + `config/profile.yaml` 打分 → 推送精简报告到微信。
2. **下午 17:00(launchd 定时)**:微信推送提醒你打开 Boss 采集扩展。
3. **Boss 采集(手动 + Chrome 扩展)**:浏览器扩展猴补丁 `window.fetch`,**只观察 Boss 自家 JS 发的 `/joblist.json` 返回 JSON**,拿原始 22 字段(包括未混淆的 `salaryDesc`、公司规模、福利、HR 活跃度);跑完一键导出 `boss_<日期>.json`,喂给 `run_daily.py --import` 走和 ATS 一样的打分 / 推送链路。

每跑一次会在 SQLite 留一条 30 天去重记录,完整报告写到 `data/report_<日期>.md`。

## 为什么不直接 Playwright + 模拟抓 API

试过,Boss 风控很严:
- Headless Playwright 几乎当场被识别
- 即使带真实 cookie,直接调 `/joblist.json` 一两次就 `code=37` 风控拉黑
- 列表页 DOM 里薪资被 `kanzhun-mix` webfont 混淆,看到的是 `-K·薪` 这种鬼东西

现在的扩展方案:**注入到主世界,只拦截 Boss 前端自己发的请求**,所有签名 / token / 浏览器指纹是真实用户级别,风控难度直接降一个数量级,而且能拿原始 JSON。

## 前置条件

- **macOS**(Linux 也行,把 launchd 换成 cron / systemd)
- **Python 3.11+** 加 [uv](https://docs.astral.sh/uv/)
- **Chrome** + 仓库里的 `extension/` 加载为开发者模式扩展
- API 账号:
  - **DeepSeek V4** —— 主打分模型([deepseek.com](https://platform.deepseek.com))
  - **Azure OpenAI** —— 可选 fallback
  - **WxPusher** —— 免费,微信推送通道([wxpusher.zjiecode.com](https://wxpusher.zjiecode.com))
  - **Brave Search** —— 免费 tier([brave.com/search/api](https://brave.com/search/api/))

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

# 5. 安装 Chrome 扩展(详见 docs/extension.md)
#    chrome://extensions/ → 开发者模式 → 加载已解压扩展 → 选 extension/ 目录

# 6. Dry-run 验证 — 用仓库自带 sample
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

## Boss 采集(手动)

详见 [docs/extension.md](docs/extension.md)。简化版流程:

1. Chrome 里登录 zhipin.com
2. 点工具栏的 **Boss 采集** 扩展图标
3. 勾职位 + 城市,生成任务队列,点**开始**
4. 跑完点 **导出 job-radar JSON** → 保存到 `~/job-radar/data/`
5. 终端:`uv run python scripts/run_daily.py --import data/boss_<日期>.json`

整个流程 10-15 分钟(取决于多少关键词)。Boss 弹验证码或风控时扩展会自动停,2-4 小时后再试。

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
  push_reminder.py # 17:00 微信戳一下提醒打开 Boss 采集扩展
  debug_push.py    # WxPusher 推送测试

config/
  profile.example.yaml      # 模板 — copy 成 profile.yaml 再填
  ats_targets.yaml          # 要查的公司 slug 清单

extension/                  # Boss 采集 Chrome 扩展(MV3)
  manifest.json
  injected.js               # 主世界,猴补丁 fetch / XHR
  content.js                # 隔离世界,转发数据 + 行为模拟
  background.js             # SW 编排器,任务队列 + 风控感知 + 导出
  popup.html / popup.js     # UI
  dict.json                 # Boss 职位 / 城市 / 行业 三级 taxonomy

launchd/                    # macOS 定时任务模板(load 前替换 __HOME__)
docs/
  extension.md              # 扩展安装 + 使用细节
data/
  sample_jobs.json          # demo 输入 — 可以 commit
  resume.md                 # 你的简历(gitignored)
  jobs.db                   # SQLite 去重 + 报告归档(gitignored)
  report_<日期>.md          # 每日完整报告(gitignored)
```

## 已知限制

- **扩展依赖 DOM 选择器**:Boss 改前端时 `.job-card-wrapper` 这种可能失效,需要在 `extension/content.js` 改 `SELECTORS` 数组。
- **API 字段重命名**:Boss 偶尔改字段名(如 `salaryDesc` → `salary`),看 Network 实际 JSON 然后改 `extension/background.js normalize()`。
- **Boss session 会过期**:Chrome 里定期重新扫码登录。
- **launchd 不展开 `$HOME`**:示例 plist 用 `__HOME__` 占位,load 前必须替换。
- **个人数据**:`config/profile.yaml`、`data/resume.md`、`data/*.json`、`data/*.md`、`data/boss_state.json`、`data/jobs.db` 都在 `.gitignore` 里。第一次 commit 前再 `git status` 过一眼最稳。

## License

MIT —— 见 [LICENSE](LICENSE)。
