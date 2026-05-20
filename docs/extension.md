# Boss 采集扩展使用说明

## 它怎么工作

Chrome 扩展(Manifest V3),三段式架构:

- **`injected.js`**:在 zhipin.com 主世界(MAIN world)`document_start` 时刻猴补丁 `window.fetch` + `XMLHttpRequest`。**自己不发任何请求**,只拦截 Boss 自家前端调 `/joblist.json` 的返回 JSON。所有 token / 签名 / 浏览器指纹都是真实用户级别 — 风控基本认不出来。
- **`content.js`**:隔离世界,接收主世界拦截到的 JSON 转发给 background;模拟滚动 / hover / 翻页;检测登录态、风控页、验证码。
- **`background.js`**:Service Worker 编排器。任务队列 + 断点续跑 + SW 保活(`alarms` API)+ 风控感知(收到 `code != 0` 自动停)+ CSV/JSON 导出。

拿到的是 raw JSON,所以 `salaryDesc`、`brandName`、`bossActiveTimeDesc`、福利、技能等 22 字段全部清晰,**不需要解码 Boss 的 `kanzhun-mix` webfont**。

## 安装

1. `chrome://extensions/` 打开,右上角开**开发者模式**
2. 点**加载已解压的扩展程序**,选 `~/job-radar/extension/` 文件夹
3. 工具栏 pin 一下图标
4. 浏览器里登录 zhipin.com(扫码)

## 每日使用

1. 点扩展图标打开控制台
2. **配置标签页**:
   - 职位树勾选目标(我们方向:售前技术支持 `101201` / 售后技术支持 `101202` / 销售技术支持 `101299` / 客户成功 `160303`,以及人工智能下的相关方向)
   - 城市勾选上海 / 杭州 / 北京(或全国)
   - 经验、学历按需选,留空 = 不限
   - 排序选**最新发布**(`sortType=1`)
   - 运行模式选**独立窗口(最小化)**
   - 点**生成任务队列**
3. **运行标签页**:
   - 点**开始**
   - 弹窗保持打开(降低 SW 被休眠的概率)
   - 等进度 `[N/M | R<round> | +<added>]` 跑完
4. 跑完点 **导出 job-radar JSON**
   - 弹出保存对话框,直接保存到 `~/job-radar/data/`(文件名 `boss_<日期>.json`)
5. 终端跑打分 + 推送:
   ```
   cd ~/job-radar && uv run python scripts/run_daily.py --import data/boss_<日期>.json
   ```

## 风控触发了怎么办

控制台看到 `⚠ 拦到风控响应 code=37` 或 `操作过于频繁`:

- 当前关键词扔到失败队列,继续跑下一个
- 连续 3 次风控 → 自动冷却 30 分钟
- 跑完后第二轮会重试 failed 任务

要是整轮都风控,人工冷却 2-4 小时,期间用浏览器正常逛 Boss(产生真实用户信号),然后再试。账号被打过标记后用**保守模式**:单关键词 / 滚动 2 次 / 页内停留 6-12 秒。

## 字段对照

扩展导出的 JSON 是 `run_daily.py --import` 期望的格式 — 7 字段拍扁版:

| job-radar 字段 | 来自 Boss 原始字段 |
|---|---|
| `title` | `jobName` |
| `company` | `brandName` |
| `city` | `cityName`(兜底 `search_city`) |
| `salary` | `salaryDesc` (`30-60K·15薪` 直接拿到) |
| `jd` | 经验 / 学历 / 区域 / 公司(行业·融资·规模)/ 技能 / 福利 / HR 拼起来 |
| `url` | `https://www.zhipin.com/job_detail/<encryptJobId>.html` |
| `source` | `"boss"` |

如果想要原始 22 字段(给 Excel 分析用),点**导出 CSV** 拿另一份。

## 已知坑

- **DOM 选择器漂移**:Boss 改前端时 `.job-card-wrapper` 这种可能失效,需要在 `content.js` 改 `SELECTORS`
- **API 字段重命名**:Boss 偶尔会把 `salaryDesc` 改成 `salary` 之类,需要看 Network 实际 JSON 然后改 `background.js normalize()`
- **登录态过期**:Chrome 里偶尔重新扫码即可
- **Service Worker 休眠**:扩展用了 `chrome.alarms` 每 30 秒触发,加上弹窗保持打开,基本不会被休眠
