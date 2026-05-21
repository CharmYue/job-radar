# 🎯 求职雷达 · Job Radar

> **AI 帮你扫 Boss直聘 — 一键采集、智能打分、按你的简历挑出最对路的岗位。**
>
> 一个 Chrome 扩展。**不发请求、不爬接口**,只观察你浏览器里 Boss 自家 JS 的返回数据 → 风控难度直接降一档。
>
> 配你的简历 + 偏好 → 跑一轮 → S/A 级岗位一目了然 → 可选微信推送。

![version](https://img.shields.io/badge/version-6.2.1-brightgreen) ![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-blue) ![license](https://img.shields.io/badge/license-MIT-lightgrey)

---

## 它解决什么

Boss直聘上一天几百个岗位,**人肉筛选 2-3 小时**,还容易漏:

- 标题党("AI 算法工程师"实际上是 Python 后端)
- 薪资字段经常残缺(列表里看到 `-K·薪` 这种乱码)
- HR 已经几周没活跃了你还在投
- 大厂 / 创业公司 / 加班程度 / 通勤距离 / 技术栈匹配 — 全靠人脑权衡

**求职雷达**:你把简历 + 偏好(薪资 / 大厂 / 不加班 / 稳定 / 通勤 / 技术栈 6 维权重)告诉它,它扫一遍给每个岗位打分(S→A→B→C→Reject),按分级排好,带评分理由 + 担忧点 + 招呼语建议。

---

## ✨ 功能亮点

| | |
|---|---|
| 🛡 **零接口爬取** | 注入主世界 monkey-patch `fetch`/XHR,**只观察** Boss 自家 JS 返回的 `/joblist.json` + `/job/detail.json`,自己不发请求 — 风控几乎拿你没办法 |
| 🤖 **7 个 AI 模型可选** | DeepSeek / 通义 / 豆包 / MiniMax / 智谱 / OpenAI / Claude — 用你自己的 API key |
| 🎯 **多维度打分** | 不是简单关键词匹配。简历 + 7 维星级权重(薪资/大厂/不加班/稳定/通勤/技术栈契合 + 住址)综合打 S→A→B→C→Reject 5 档 |
| ⚡ **可靠性** | MV3 SW 死掉能自动续跑、IndexedDB 抗 race / 抗 quota、增量保存、指纹去重避免重打分 |
| 📊 **看板** | popup 卡片视图 / 表格视图 + **🖥 全屏看板**(独立 tab,排序/搜索/筛选)+ **📥 CSV 一键导出** |
| 📨 **可选微信推送** | WxPusher 集成,跑完推 S/A 级到微信。**纯 PC 党可不填,在看板查结果** |
| 🌐 **HR 活跃度** | 每条岗位带 HR 上次活跃时间 — 一眼看出"是死岗还是真招" |
| ⏰ **定时自动跑** | chrome.alarms 每天指定时间自动 fire,Chrome 开着就行 |

---

## 🚀 5 分钟跑起来

### 1. 装扩展

```bash
git clone https://github.com/CharmYue/job-radar.git
```

打开 `chrome://extensions/` → 右上角开**开发者模式** → 点**加载已解压的扩展程序** → 选 `extension/` 目录。

(看不到图标就在工具栏右边点拼图,把"Boss 求职雷达"钉住。)

### 2. 配画像 + AI key

点扩展图标 → **画像** tab:

- **你的需求**:一句话,例 "找 AI 解决方案岗位,年包 45-55,大厂优先,稳定不加班"
- **完整简历**:粘贴你的 Markdown 简历(技术栈、年限、项目经验)
- **薪资期望**:拖滑块(月薪下限 / 上限 / 年包目标)
- **偏好权重**:6 维星级(薪资 / 大厂 / 不加班 / 稳定 / 通勤 / 技术栈契合)
- **AI 模型**:选 provider(推荐 DeepSeek,便宜快),填 API key,点 🧪 **测试模型连通**
- **WxPusher**(可选):想微信收推送就填,不填只用 PC 看

填完自动保存。

### 3. 在 Boss 上扫码登录

打开 `https://www.zhipin.com/`,正常扫码登录 — 扩展用你这个会话工作。

### 4. 配搜索

回扩展 → **搜索** tab:

- **关键词** chips:输入想搜的岗位(例 "AI 解决方案" / "Solution Engineer"),回车加 chip
- **城市**:勾上海/杭州/北京/...
- **每个关键词最多抓**:下拉选 约 30 / 60(推荐)/ 120 / 300
- **筛选**:经验 / 学历 / 发布时间(薪资建议留空,LLM 按你画像精确评)
- 点 ✓ **生成任务队列**

### 5. 跑一轮

切到 **运行** tab → 点 **🚀 跑一轮**。

扩展会:
1. **采集**:打开 Boss 列表页(可最小化),滚动抓数据,每个任务之间用 alarm 接力(SW 死了自动续跑)
2. **打分**:LLM 并发 6 路给每个岗位评分,带理由 + 担忧 + 招呼语
3. **推送**(可选):WxPusher 拆 S 级和 A 级两次推送到微信

跑完点 **🖥 全屏** 看完整看板,按公司/分数/HR 活跃度排序,标记已投或屏蔽烂公司,**📥 CSV** 一键导 Excel。

---

## 📂 目录

```
extension/
  manifest.json           Chrome MV3 配置
  injected.js             主世界:monkey-patch fetch/XHR 观察 Boss 数据
  content.js              隔离世界:消息转发 + 滚动/点击操控
  background.js           SW 状态机:采集 → IndexedDB → 打分 → 推送
  popup.html / popup.js   主 UI (画像 / 搜索 / 运行 / 历史 4 tab)
  dashboard.html / dashboard.js   🖥 全屏看板(独立 tab)
  dict.json               Boss 职位/城市/行业三级 taxonomy
```

`scripts/` + `src/job_radar/` + `launchd/` 是早期 Python ATS 爬取的 pipeline(Greenhouse / Lever / Workday 直接调 API),独立于 Chrome 扩展。新用户只装扩展就够。

---

## 🛠 技术细节

- **MV3 状态机**:`runPipeline` 是 alarm 驱动的 state machine。每个采集任务 / 打分批次都是独立"单元",写完 IDB 用 `chrome.alarms` 调度下一步。SW 被 Chrome 杀掉照样从 storage 续跑。
- **数据层**:IndexedDB store `jobs` 主键 `job_id`,索引 `score_priority / crawl_time_ts / user_marked / company_name`。所有写都是单条 atomic,告别"全图读 → 改 → 写"的 race。
- **打分指纹**:`PROMPT_VERSION + provider + model + djb2(profile) + djb2(job content)`。改简历 / 换 model / 拿到 full_jd 自动触发重打,不变就直接跳过。
- **风控感知**:连续 3 次拿到 Boss `code=37` 自动冷却 30 分钟。

详见 [`docs/extension.md`](docs/extension.md)。

---

## 🤝 贡献 / Issue

代码量 ~5000 行,主要在 `extension/background.js`(SW)+ `popup.js`(UI)+ `dashboard.js`(看板)。欢迎:

- 🐛 Bug 反馈(SW 续跑异常 / IDB 数据丢失 / 风控触发 / 打分明显跑偏)
- 🎨 新功能 PR(其他求职平台?其他 LLM?数据可视化?)
- 📝 文档改进

---

## License

MIT — 见 [LICENSE](LICENSE)。
