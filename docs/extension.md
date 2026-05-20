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

打开扩展默认停在 **画像** tab。顶部 banner 会提示哪些字段还没填、引导到正确位置。

填以下字段:

| 字段 | 干啥 |
|---|---|
| **你的需求** | 自然语言描述求职意图,LLM 拿来理解你想要什么。比如:"帮我找适合的岗位,年包 45-55,大厂稳定的,沪杭京"。技术栈不用写这里,简历里有 |
| **完整简历** | Markdown 粘贴,LLM 全文读 — 技术栈/年限/项目经验全部从这里读,**S/A/B/C 等级由 LLM 根据简历自动判断**,不再手动配关键词 |
| **最低月薪 / 最高月薪 / 年包目标** | 3 个滑块,K = 千元;月薪范围用于 compensation_fit 权重;年包用于综合判断岗位 stock+bonus 是否够 |
| **LLM provider + API key** | 7 选 1:DeepSeek / 通义千问 / 豆包 / MiniMax / 智谱 / OpenAI / Claude — 各家 key 独立存,切换不丢 |
| **WxPusher App Token + UID** | wxpusher.zjiecode.com 注册拿,免费 |
| **🎚️ 偏好权重** | 6 个维度 1-5 颗星(salary / brand / no_overtime / stability / commute / tech_fit),决定各维度权重(role_fit 由系统默认满档) |
| **🏠 住址** | 用于通勤评估(如 `上海·浦东·张江`)— 配合 commute 星级 |
| **📝 其他偏好** | 自由文本,可写硬性规则:"不投朝阳区" / "讨厌外包" / "35K 以下不投" 等,LLM 会命中即降档 |

完成度 checklist 实时显示 9/9 时可以点 **📨 测试推送** 验证 WxPusher。

> 所有数据存在 `chrome.storage.local`,本机,不上网,不会进 git。换电脑要重新填一次。

## 每日跑流程

**① 搜索 tab**

两种方式可叠加(也可只用其中一种):

- **关键词 chips**:回车添加,× 移除 — 比如 `AI 解决方案工程师` / `Solution Engineer`
- **Boss 内部职位树**(在 collapsible 「+ 加 Boss 内部职位类目」展开):勾 `101201 售前技术支持` / `101202 售后技术支持` / `101299 销售技术支持` / `160303 客户成功`

**城市**:勾沪/杭/京(或其他)

**筛选**(默认从画像继承,可改):经验 / 学历 / **薪资区间** / **发布时间**(默认一周内)/ **公司过滤**

**高级**(可选,默认折叠):排序 / 运行模式 / 每词滚动数 / 任务间隔等

**📦 常用配置**:存预设(取个名字 → 保存)、之后下拉直接载入,改 1-2 个参数就能跑

点**生成任务队列,去运行**。

**② 运行 tab — 一键流水线**

点中间那个大绿色按钮 **🚀 跑一轮**:

```
① 采集 ─→ ② AI 打分 ─→ ③ 推送
```

阶段条会实时显示当前在哪一步,完成的变绿色。整轮 5-15 分钟(取决于关键词数 + DeepSeek API 速度),推送送达微信后阶段条全绿色「已完成」。

**🔁 每日自动跑(可选)**:大按钮下方有个 checkbox `每天 09:00 起,Chrome 开着就自动跑`。勾上之后:
- 只要 Chrome 进程在跑(不需要打开扩展弹窗),每 30 分钟检查一次
- 到了你设的时间(默认 9:00)且今天还没跑过 → 自动 fire 流水线
- 全程不用碰电脑,手机看推送
- **限制**:Chrome 完全退出(Cmd+Q)那天就不会跑

**WxPusher 推送策略**:为了避免单条 10K 字符上限被截断,改成**按等级分推** — S 级一条 + A 级一条,每条带完整 reason / 担忧 / 招呼话术 / 链接。B 级及以下不推,留在扩展数据池里看。S=0 且 A=0 的天会发一条「今天没好岗」让你知道流水线跑了。

**结果区**:
- 顶部 chips 过滤 — **全部 / S / A / B / 未打分 / 已投**
- 每条点击展开:LLM 理由 / 担忧 / 招呼话术
- 每条快捷操作:**🔗 打开**(Boss 详情页)/ **标记已投** / **🚫 屏蔽公司**(整公司加黑名单,以后采集自动剔除)/ **📋 复制话术**

**分步操作**(高级 details 抽屉):
- 只跑某一步(① 仅采集 / ② 仅打分 / ③ 仅推送)
- 续跑(从上次失败的任务继续)
- 导出 JSON / CSV / 清空数据池

**③ 📊 历史 tab**
- 近 30 天每日推送统计(S / A / B 数量)
- 屏蔽公司清单 + 取消屏蔽
- 🔁 全部重新打分(改画像后,清空所有打分重跑)

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
