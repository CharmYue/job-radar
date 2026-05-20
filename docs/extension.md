# Boss 求职雷达扩展使用说明

## 它怎么工作

Chrome MV3 扩展,三段式架构 + AI 打分 + WxPusher 推送一体化:

- **`injected.js`**:zhipin.com **主世界**(MAIN world)`document_start` 注入。猴补丁 `window.fetch` + `XMLHttpRequest`,**只观察 Boss 自家前端调 `/joblist.json` 的返回 JSON**,自己不发任何请求。所有 token / 签名 / 浏览器指纹是真实用户级别,风控基本认不出来。
- **`content.js`**:隔离世界,转发拦截到的 JSON 给 background;模拟滚动 / hover;检测登录态、风控页、验证码。
- **`background.js`**:Service Worker 编排器。任务队列 + 断点续跑 + SW 保活(`alarms`)+ 风控感知 + **DeepSeek 打分**(Semaphore=3 并发)+ **WxPusher 推送** + CSV / job-radar JSON 导出。
- **`popup.html / popup.js`**:四个 tab UI(配置 / 个人画像 / 队列 / 运行)。

拿到的是 raw JSON,所以 `salaryDesc`、`brandName`、公司规模、福利、技能 等 22 字段全部清晰 — **不需要解码 Boss 的 `kanzhun-mix` webfont**。

## 安装

1. `chrome://extensions/` 打开,右上角开**开发者模式**
2. 点**加载已解压的扩展程序**,选 `~/job-radar/extension/` 文件夹
3. 工具栏 pin 一下图标
4. 浏览器里登录 zhipin.com(扫码)

## 首次配置(只做一次)

点扩展图标 → **个人画像** tab:

| 字段 | 干啥 |
|---|---|
| **summary** | 一句话技术栈 + 年限,LLM 第一眼读 |
| **完整简历** | Markdown 粘贴,LLM 全文读,会和 summary 冲突时以简历为准 |
| **最低月薪 / 理想月薪** | 用于打分时的 compensation_fit 权重 |
| **S 级目标岗位** | 每行一个,LLM 命中即满档加分(如 `AI Solution Engineer`、`AI 解决方案工程师`) |
| **A 级目标岗位** | 相关但非首选,LLM 加分 |
| **硬拒关键词** | 每行一个,命中即本地直接 Reject,**不调 API**(如 `算法研究员`、`大模型算法`、`外包驻场`、`培训讲师`) |
| **DeepSeek API key** | sk- 开头,deepseek.com 注册拿 |
| **WxPusher App Token + UID** | wxpusher.zjiecode.com 注册拿,免费 |

点**保存**。建议先点**测试推送**验证 WxPusher 通了。

> 所有数据存在 `chrome.storage.local`,本机,不上网,不会进 git。换电脑要重新填一次。

## 每日跑流程

**① 配置 tab — 搜索目标**

两种方式可以叠加:

- **职位树**:勾 Boss 内部的三级 taxonomy(如 互联网/AI → 销售技术支持 → 售前技术支持 `101201` / 售后技术支持 `101202` / 销售技术支持 `101299` / 客户成功 `160303`)
- **关键词自由输入**:每行一个,比如 `AI 解决方案工程师` / `Solution Engineer` / `Customer Engineer`。会用 Boss 的 `?query=` 搜索

**筛选条件**(全部可选,留空 = 不限):
- 工作经验、学历
- 薪资区间(Boss 内部 bucket:3K以下 / 3-5K / 5-10K / 10-20K / 20-50K / 50K+ — 我们方向选 `20-50K` 或 `50K+`)
- 发布时间(今日 / 3 日内 / 一周内 / 一月内)
- 公司过滤(自由输入,空格/逗号分隔,后端 brandName 子串匹配 — 比如填 `字节 阿里 SenseTime` 就只留这三家)

**运行参数**:每词最多滚动多少屏、总条数上限、页内停留时间、任务间隔。默认值适用「白天小批量」场景。

点**生成任务队列**。

**② 队列 tab** —— 看一眼任务列表确认

**③ 运行 tab — 跑完整流程**

- **开始采集** → 浏览器最小化窗口跑,扩展弹窗保持打开(降低 SW 休眠)
- 跑完(进度条 stops,数据池总数显示)
- **AI 全部打分** → DeepSeek 并发 3 跑,弹窗实时显示进度 `打分中 N/M`
- 打分完毕 → 数据池列表显示每条岗位的 **S/A/B/C/X** 标签,点击岗位标题在新 tab 打开
- **一键推送 WxPusher** → 拼 Markdown(只发 S+A+B,Reject 略),发到微信
- 完事

可选导出:
- **导出 job-radar JSON** — 给 6:30 ATS pipeline 一起统计 / 做归档
- **导出 CSV** — 给 Excel 做数据分析

## 风控触发了怎么办

控制台看到 `⚠ 拦到风控响应 code=37` 或 `操作过于频繁`:

- 当前关键词扔到失败队列,继续跑下一个
- 连续 3 次风控 → 自动冷却 30 分钟
- 跑完后第二轮会重试 failed 任务

整轮都风控,人工冷却 2-4 小时,期间用浏览器正常逛 Boss(产生真实用户信号),然后再试。**保守模式**:单关键词 / 滚动 2 次 / 页内停留 6-12 秒。

## 字段对照(技术细节)

扩展导出的 `boss_<日期>.json` 是 `run_daily.py --import` 期望的格式 — 7 字段拍扁版:

| job-radar 字段 | Boss 原始字段 |
|---|---|
| `title` | `jobName` |
| `company` | `brandName` |
| `city` | `cityName`(兜底 `search_city`) |
| `salary` | `salaryDesc` (`30-60K·15薪` 直接拿到) |
| `jd` | 经验 / 学历 / 区域 / 公司(行业·融资·规模)/ 技能 / 福利 / HR 拼起来 |
| `url` | `https://www.zhipin.com/job_detail/<encryptJobId>.html` |
| `source` | `"boss"` |

CSV 是原始 22 字段(给 Excel 分析用)。

## 已知坑

- **DOM 选择器漂移**:Boss 改前端时 `.job-card-wrapper` 这种可能失效,需要在 `content.js` 改 `SELECTORS`
- **API 字段重命名**:Boss 偶尔改字段名(如 `salaryDesc` → `salary`),看 Network 实际 JSON 然后改 `background.js normalize()`
- **登录态过期**:Chrome 里偶尔重新扫码即可
- **DeepSeek 限流**:免费账号每分钟有 RPM 上限。打分 50 条需要几十秒,正常。如果报 rate-limit,等 1-2 分钟再点
