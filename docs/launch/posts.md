# 📝 发布文案

为不同平台准备的文案。**小红书**主打"我自己用"+"省时间"+"截图视觉",**即刻**主打"技术亮点"+"开源"+"工程思路"。

---

## 小红书 — 主推贴

**封面**:Hero shot(全屏看板,S/A 满屏) + 大字标题 "**Boss 直聘上 300 个岗位,AI 帮我 3 分钟挑出最对路的**"

**标题(可选 3 版,A/B 测)**:
- 💼 找工作的姐妹必看!我做了个 Chrome 插件帮我筛 Boss 岗位,AI 打分 5 分钟出结果
- 🤖 投简历投到怀疑人生?我用 AI 扫了 Boss 一遍,把 300 个岗位筛成 20 个 S 级
- 😭 Boss 直聘上看花眼?这个 AI 插件帮我自动打分排序,只投 HR 还活跃的

---

### 正文(800-1000 字版)

```
找工作两个月,在 Boss 直聘上每天刷 300+ 个岗位刷到眼瞎,投出去不是石沉大海就是 HR 已读不回。

——直到我发现是岗位池没筛对。

很多坑是肉眼看不出来的:
- 标题写"AI 算法工程师",JD 里都是 Python 后端
- HR 三周没活跃了你还在投
- 创业公司一看大厂背景就 pass,但我其实就想躲 996
- 大厂高 base 但通勤 2 小时 你愿意去吗

我让自己每天花 3 小时筛,还是会漏。于是花了一个周末搓了一个 Chrome 扩展,把这些活儿全塞给 AI。

【它怎么工作】
1️⃣ 我把简历 + 偏好告诉它一次
   - 一句话需求("年包 45-55,大厂稳定,不加班")
   - 完整简历 Markdown 直接粘进去
   - 6 维偏好星级(薪资/大厂/不加班/稳定/通勤/技术栈)

2️⃣ 配搜索:关键词 chip + 城市 + 想抓多少
   - 例如 "AI 解决方案" × 3 个城市 × 每词抓 60 = 180 个岗位池

3️⃣ 一键 🚀 跑一轮
   - 扩展开个最小化窗口,几分钟抓完所有岗位
   - 然后 AI 并发给每个打分,S→A→B→C→Reject 5 档
   - 评分理由 / 担忧点 / 招呼语建议 全有

【最实用的点】
✅ 每条岗位带 HR 上次活跃时间 — 几天前活跃绿色,几周前橘色
✅ 全屏看板(独立 tab),按分数 / HR 活跃度 / 公司排序
✅ 一键导 CSV,在 Excel 里二次筛(我自己只投 HR 今日活跃 + A 级以上)
✅ 可选微信推送,跑完手机收一条 S/A 级清单
✅ 用我自己的 DeepSeek API,一次扫 100 个岗位成本 < ¥1

【技术上有意思的点】
- 没爬 Boss 接口(很容易封号),只观察浏览器里 Boss 自家 JS 的返回 → 风控几乎拿你没办法
- 7 个 AI 模型可选(DeepSeek/通义/豆包/MiniMax/智谱/OpenAI/Claude)用谁的都行
- Chrome 杀掉 SW 也能从断点续跑

开源免费,自己的数据完全本地,不上传任何东西。

📦 GitHub:CharmYue/job-radar
🛠 一句话装:chrome://extensions/ 加载已解压 → 选 extension/ 文件夹

#求职 #boss直聘 #ai工具 #程序员 #chrome插件 #找工作 #开源
```

---

### 短版(400-500 字)

```
做了个 Chrome 扩展用 AI 帮我筛 Boss 岗位,5 分钟把 300 个筛到 20 个 S 级 🎯

实际工作流:
1. 简历 + 偏好告诉它一次(月薪/年包滑块 + 大厂/不加班/通勤等 6 维星级)
2. 关键词 + 城市,生成搜索任务
3. 一键 🚀 — 自动抓 + DeepSeek 打分 + 推微信

亮点:
🟢 每条岗位标 HR 上次活跃时间(绿=今日活跃,橘=几周前) — 不投死岗
📊 全屏看板独立 tab + CSV 导 Excel,自己二次筛
🛡️ 不爬接口只观察浏览器数据 — Boss 风控拿不到
💰 用自己的 API key,扫 100 个岗位 < ¥1

开源 MIT,本地数据不上传。GitHub: CharmYue/job-radar

#求职 #boss直聘 #ai工具 #chrome插件 #开源
```

---

## 即刻 — 技术向

**适合配置:** Hero shot + 一张 popup 卡片展开。

```
新做了个 Chrome 扩展叫"求职雷达",自己用了两周 Boss 直聘的实战版。

思路:不爬 Boss 接口(直接调 /joblist.json 两次就 code=37 风控了),改成注入主世界 monkey-patch window.fetch — 只观察 Boss 自家 JS 的返回 JSON。等于让 Boss 给我"主动喂数据"。

技术栈:
- Chrome MV3,manifest_version=3,全程不发 outbound request
- SW 状态机用 chrome.alarms 接力,死了从 chrome.storage.local 续跑
- IndexedDB 存岗位,atomic 单条 update,告别"全图读改写"的 race
- LLM 打分指纹:PROMPT_VERSION + provider + model + djb2(profile) + djb2(job) — 简历改了 / 换模型 / 拿到 full_jd 自动重打,不变就跳过
- 7 个 provider 兼容(OpenAI 协议 + Anthropic 协议两套调度器)

打了 13 个 issue 修了 9 个 commit,有几个坑很 MV3 specific,比如 alarm 30s 最小 delay / SW 杀掉前没 finalize / 两个 storage 写者同 key 不同 schema 互相覆盖...

开源 MIT:github.com/CharmYue/job-radar

发现一个 takeaway:同一个 storage key 给两个写者用 + schema 还不一样 = 静默 corruption + 单元测试也测不出来(单个函数都没毛病,联合起来才出 bug)。下次设计存储层先列清楚 "每个 key 谁拥有 / 什么 schema"。
```

---

## 即刻 — 用户向(替代版)

```
找工作两个月,Boss 直聘上每天 300+ 岗位刷到眼瞎。做了个 Chrome 扩展让 AI 替我筛。

📦 工作流:
- 简历 + 你想要什么(月薪 / 大厂 / 不加班权重) — 告诉它一次
- 关键词 + 城市 + "每词抓多少"(预设 30/60/120/300)
- 🚀 一键跑:扩展开最小化窗口扫 Boss,扫完 AI 打分,S→A→B→C→Reject 5 档

🎯 实战发现 3 个最有用的点:
1. 评分理由 + 担忧点 — AI 会告诉你"这岗位看着不错但福利里写'弹性工作'实际加班概率高"
2. HR 活跃度 — 一眼看出"这岗是真招还是挂着不撤" — 投 HR 三周没动的就是浪费时间
3. 全屏看板独立 tab — popup 太挤,看板里能按 HR 活跃度排序 + 全文搜索 + 一键导 CSV 二次筛

不爬 Boss 接口(只观察 JS 数据),用自己的 AI key,本地数据。

GitHub: CharmYue/job-radar
```

---

## V2EX / 二级技术社区

直接搬即刻技术向版本,加一段"为什么不直接 Playwright":

```
试过 Playwright 直调 /joblist.json — 1-2 次就 code=37 风控拉黑。Boss 反爬很严,headless 也容易识别。
现在的方案是注入到主世界 monkey-patch fetch,只观察 Boss 自家 JS 发的请求 — 所有签名/token/指纹都是真实用户级别,风控难度降一个数量级。
列表页里薪资还会被 kanzhun-mix webfont 混淆成 -K·薪 这种乱码,接口返回的 salaryDesc 是原始的。
```

---

## 推文 / X(英文)

```
Built a Chrome extension that uses AI to filter Boss直聘 (China's #1 job board) for me.

Instead of crawling their API (auto-banned), it monkey-patches window.fetch and *observes* Boss's own JS responses → near-zero detection.

Scores each job on 7 dimensions from my resume + preferences, ranks S→A→B→C, shows HR activity / publish time so I don't waste time on dead listings.

13 bugs fixed across 3 rounds of self-review w/ Codex. Some MV3-specific gotchas:
- chrome.alarms silently bumps <30s delays to 30s in prod
- Two writers to same chrome.storage key with different schemas = silent corruption
- SW death during long pipelines = state needs to live in storage, not memory

Open source MIT: github.com/CharmYue/job-radar
```

---

## 通用 CTA 模板

每篇结尾留这个:

```
📦 GitHub: https://github.com/CharmYue/job-radar
🔧 Chrome MV3 扩展,本地运行,用你自己的 AI API key
📜 MIT 开源

如果你在求职 / 校招 / 跳槽,可以试试。
评论区交流。
```
