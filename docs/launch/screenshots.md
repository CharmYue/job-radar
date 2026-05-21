# 📸 截图清单

为发布(GitHub README / 小红书 / 即刻)准备的截图。**每张都标了用途 + 怎么拍 + 后期建议**。

## 截图工具

- macOS:`Cmd + Shift + 4` 拖框,或 `Cmd + Shift + 5` 全屏。
- Chrome popup 不能 Cmd+Shift+4 直接圈 — 改用 `Cmd + Shift + 4` 然后按 `Space` 切到窗口模式,但 popup 关闭就丢了。**推荐做法:在 popup 上右键 → 检查 → DevTools 弹出来后 popup 会粘住,然后正常截图。**
- 全屏看板用 `chrome.tabs.create({ url: chrome-extension://.../dashboard.html })` 开新 tab,直接全屏截图。
- 后期统一标注用 [CleanShot X](https://cleanshot.com/) 或 [Skitch](https://evernote.com/products/skitch)。

## 命名规范

`docs/launch/img/01-hero.png`、`02-profile-tab.png` ... 数字开头便于排序。

---

## 1. Hero shot — 一张能在 README 顶部撑场面的

**用途**:GitHub README 顶图 / 小红书封面 / 即刻配图

**拍什么**:**🖥 全屏看板**(`dashboard.html`)已经跑完一轮,30+ 条带 S/A/B 分级的真实岗位,顶部 toolbar 看得到 filter chips。

**步骤**:
1. 准备:跑过一轮真实数据,至少有 10 条 S/A,20 条 B
2. popup → 运行 → 数据池 → 点 🖥 **全屏**
3. 浏览器最大化窗口,顶部地址栏可见(显得真实)
4. 截全屏 1920x1080 或更大
5. 后期:**马赛克掉公司名**(防止侵权),保留分级 / 薪资 / 城市 / HR 列

**文件名**:`docs/launch/img/01-hero-dashboard.png`

---

## 2. 画像 tab — 展示"AI 怎么了解你"

**用途**:README "如何使用" / 小红书第 2 张

**拍什么**:popup 画像 tab,展示:
- 一句话需求("找 AI 解决方案岗位,年包 45-55,大厂优先")
- 简历前几行(可以用马赛克盖中间)
- 月薪/年包滑块(显示具体数字)
- 6 维星级权重(填了 4-5-3-5-4-5 这种)
- 模型选 DeepSeek + API key 隐藏

**步骤**:
1. popup 打开,默认就是画像 tab
2. 滚到能看到完整偏好星级
3. **API key 字段记得马赛克或者用样例值替代**(超敏感)
4. 截 popup 整窗口

**文件名**:`docs/launch/img/02-profile-tab.png`

---

## 3. 搜索 tab — 展示"搜什么、怎么搜"

**用途**:README "搜索配置"

**拍什么**:popup 搜索 tab,展示:
- 关键词 chips("AI 解决方案" / "Solution Engineer" / "AI 出海")
- 城市勾选(上海/杭州/北京 高亮)
- "每个关键词最多抓" 下拉显示约 60
- "将生成 9 个搜索任务,最多尝试抓取 540 个岗位" 提示
- ✓ 生成任务队列绿按钮

**文件名**:`docs/launch/img/03-search-tab.png`

---

## 4. 运行中的 pipeline — 状态机视觉证据

**用途**:README "技术亮点" / 即刻技术贴

**拍什么**:popup 运行 tab,流水线正在跑,**阶段条** 显示采集→AI 打分→推送,**substep** 显示具体当前在做什么("采集 [3/9] AI 解决方案 @ 上海" 或 "打分 12/47 · xxx")。

**步骤**:
1. 跑一轮真实任务,中途截图
2. 截到 substep 是有内容的瞬间

**文件名**:`docs/launch/img/04-pipeline-running.png`

---

## 5. 打分结果卡片视图 — 单条详情

**用途**:README "AI 怎么打分"

**拍什么**:popup 数据池,**卡片视图**,展开一条 S 级岗位,展示:
- S 90 红色 badge
- 岗位标题 — 公司名 — 薪资 — HR 活跃度 — 发布时间
- 💡 评分理由
- ⚠️ 担忧(加班风险 / 通勤等)
- 💬 招呼语建议
- 📍 城市/区域 / 🕒 发布 / 🟢 HR 活跃

**步骤**:点一张 S 级卡展开,截整张卡。**公司名马赛克**。

**文件名**:`docs/launch/img/05-card-expanded.png`

---

## 6. 表格视图 + CSV 下载

**用途**:README "数据查看"

**拍什么**:popup 数据池切到**表格**视图,显示 6-8 行,带 HR 颜色 + 发布相对时间,右上角 📥 CSV 按钮明显。

**文件名**:`docs/launch/img/06-table-view.png`

---

## 7. 全屏看板的搜索 + 排序

**用途**:小红书 / 即刻 高级用法

**拍什么**:dashboard.html,搜索框搜了 "AI",表格按 HR 活跃度排序(绿色集中在顶部),侧重展示 sort + filter + 全文搜索三件套。

**文件名**:`docs/launch/img/07-dashboard-search.png`

---

## 8. CSV 在 Excel 里打开 — 二次分析

**用途**:小红书 "导出后能干什么"

**拍什么**:导出的 CSV 在 Excel/Numbers 里打开,中文不乱码,所有列展开,**按 HR 活跃度过滤 + 分数倒序** 选中前几行。

**文件名**:`docs/launch/img/08-csv-in-excel.png`

---

## 9. WxPusher 微信推送结果

**用途**:微信流的"诱惑"

**拍什么**:手机 WxPusher App 里收到的推送,Markdown 渲染后的岗位列表(S 级 + A 级两条)。

**步骤**:跑一轮带 WxPusher 配置 → 截图手机 → 投屏或拍照。

**文件名**:`docs/launch/img/09-wxpusher-mobile.png`

---

## 10. 安装过程 — `chrome://extensions/` 加载已解压扩展

**用途**:README 安装步骤

**拍什么**:`chrome://extensions/` 页面,开发者模式开启,扩展卡片显示"Boss 求职雷达 6.2.1",**ID 用红框圈出来**。

**文件名**:`docs/launch/img/10-install.png`

---

## 后期处理建议

| 类型 | 工具 | 处理 |
|---|---|---|
| 敏感打码 | CleanShot 模糊 / Photoshop | API key / UID / 真实公司名 / 手机号 / 邮箱 |
| 红框标注 | CleanShot / Skitch | 引导视线到关键按钮 |
| 阴影 + 圆角 | macOS 自带阴影 + Preview 裁剪 | 显得专业 |
| 拼接 | Pixelmator / Figma | 多步流程合一张图 |

---

## 优先级

如果时间紧,按这个顺序拍:

1. **01 Hero**(必须)— 第一眼吸引力
2. **05 卡片展开**(必须)— 解释"AI 怎么打分"
3. **07 全屏看板**(必须)— 高级感来源
4. 02 画像 + 03 搜索 + 06 表格(套餐)
5. 04 运行中 + 09 WxPusher + 10 安装(锦上添花)
6. 08 CSV(可选)
