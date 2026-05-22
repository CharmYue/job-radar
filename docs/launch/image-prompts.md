# 🎨 封面图 AI 生成提示词

给 Image2 / 即梦 / 通义万相 / Midjourney / ChatGPT 用的提示词,4 套场景全覆盖。

> 用法:
> - **文字叠加型**(推荐):上传现有截图 + 提示词,让 AI 加大字 + 红圈 + 箭头
> - **全新生成型**:让 AI 完全画一张海报,不用截图(适合不想暴露真实数据)

---

## 1️⃣ 小红书主推贴封面(最重要)

### 风格目标
- 9:16 或 3:4 竖屏
- 顶部 30% 大字标题(白底黑字 / 渐变红 / 黄底黑字 都可)
- 下方 70% 放产品截图(模糊真实公司名)
- 整体类似"找工作干货博主"那种排版

### 文字叠加型(基于 `dashboard-hero.png`)

**中文提示词**:

```
在这张电脑端 SaaS 数据看板截图上,顶部叠加大标题文字:
"找工作 2 个月 0 面试
装这个第 3 天约面 5 家 😭"

设计要求:
- 整体竖版 3:4 比例,顶部留 35% 空间给标题
- 标题用粗体黑色中文字,带白色描边或半透明白色色块衬底
- 标题字号要大,从顶部能直接看清,**手机缩略图上也能读**
- 关键词"0 面试"和"5 家"用红色或黄色高亮
- 在底部截图的"公司"列加红框标注"AI 自动分级"
- 截图整体保留,只对真实公司名做马赛克/模糊处理
- 右下角加个小标签:"GitHub: CharmYue/job-radar"
- 整体色调:小红书博主风,温暖白底 + 一抹粉红/橘色点缀

不要做:
- 不要 AI 风渐变背景(显得假)
- 不要科技感蓝紫色(不符合小红书调性)
- 不要英文标题
- 不要把截图整张换掉,要保留真实感
```

**English prompt** (for Midjourney / DALL-E 3):

```
Overlay a Chinese title at the top of this SaaS dashboard screenshot:
"找工作 2 个月 0 面试  装这个第 3 天约面 5 家 😭"

Design:
- Vertical 3:4 portrait, top 35% reserved for title
- Bold black Chinese characters with white stroke outline
- "0 面试" and "5 家" highlighted in red
- Add a red rectangle around the company column with annotation "AI 自动分级"
- Blur out real company names in the screenshot
- Small bottom-right label: "GitHub: CharmYue/job-radar"
- Xiaohongshu (小红书) blogger aesthetic: warm white background, hint of pink/orange accent
- Style: clean, magazine-like, mobile-thumbnail-readable

Avoid: AI gradient backgrounds, tech-blue-purple palettes, English titles
```

### 全新生成型(不用截图,从头画)

```
设计一张小红书爆款封面,主题:AI 帮找工作。

构图(竖版 3:4):
- 上半部分:大字标题"找工作 2 个月 0 面试  装这个第 3 天约面 5 家 😭"
  - 中文粗体,字大、可读、带阴影
  - "0 面试"红色,"5 家"黄色高亮
- 中部:简化的笔记本电脑插画,屏幕上显示一个数据列表
  - 列表里有彩色徽章 S(红) A(蓝) B(绿) C(灰)
  - 屏幕反光有一根光线表示"突破"
- 下半部分:一只手伸过来点屏幕,旁边浮起一条手机推送通知"Boss 雷达 · A 级 126 条"
- 整体色调:温暖米白底 + 粉红/橘色点缀 + 黑色字
- 风格:小红书博主笔记封面、扁平插画、不要写实
- 右下角小水印:GitHub: CharmYue/job-radar
- 不要 logo,不要 watermark 太大

不要:
- 不要写实照片
- 不要赛博朋克 / 黑色科技风
- 不要英文为主
```

---

## 2️⃣ 小红书短版封面

简化版,只要"5 张图收藏"那种朴素美感。

```
基于这张 dashboard 截图,顶部叠加 2 行大字:
"AI 5 分钟筛 300 个 Boss 岗位
回复率 5% → 50%"

要求:
- 竖版 3:4
- 字号超大,"50%"用绿色高亮
- 截图保留可读但虚化 30%,让文字突出
- 右下角红色小印章效果:"姐妹必看"
- 整体温暖暖色调,小红书风格
```

---

## 3️⃣ 即刻技术向封面(克制版)

```
基于这张 dashboard 截图,只做轻度处理:
- 顶部加一行小字标题(不要太大):"求职雷达 · Chrome MV3 扩展"
- 右上角加一个小标签:"v6.3 · MIT 开源"
- 截图整体保留,真实公司名稍微模糊
- 风格:工程师审美 — 简洁、克制、不要装饰、不要 emoji 堆砌
- 配色:GitHub 的 #0d1117 深色或 #ffffff 纯白,取一种就好
- 不要小红书那种粉红点缀
```

---

## 4️⃣ X / Twitter 封面(英文,国际化)

```
Create a Twitter/X header overlay on this SaaS dashboard screenshot:

Text overlay (centered, big):
"5 minutes to filter 300 Boss直聘 jobs.
AI ranks them by your resume.
Zero ban risk."

Sub-text (bottom):
"github.com/CharmYue/job-radar · MIT"

Design:
- 16:9 landscape
- White or off-white background
- Bold black sans-serif title (Inter / SF Pro / similar)
- One word in red accent: "AI"
- Small "🛡 Zero ban" badge top-right
- Mobile-readable thumbnail
- Clean, indie-hacker aesthetic — not AI-generated-looking

Avoid: Chinese characters in main title (keep English), corporate stock-photo vibe
```

---

## 5️⃣ 大字标题候选(挑一个用)

如果你不用上面的标题,这里有 12 个备选,A/B 测哪个出效果:

**痛点钩**(适合不上不下的求职者)
- "投简历 80 份 0 回音?装这个第 3 天约面 5 家"
- "Boss 上 300 岗位看花眼?AI 5 分钟筛完"
- "HR 已读不回的真正原因 — 你投了死岗"

**对比钩**(适合理性派)
- "人肉刷 Boss vs AI 帮你筛:回复率 5% → 50%"
- "找工作 2 个月 0 面试 → 第 3 天约面 5 家"
- "投 100 份杳无音讯?试试这个 0 封号 AI 插件"

**身份钩**(适合 niche 群体)
- "码农面试季救命神器 — AI 帮我筛 Boss 岗"
- "找工作姐妹必看!AI 帮我锁定神仙工作"
- "面 5 家中 3 家 — 我的求职 SOP 公开"

**好奇钩**(适合追新求异)
- "我用 AI 把 Boss 玩出花了 — 一键 5 档分级"
- "Chrome 装这个,Boss 直接给我跪了"
- "Boss 风控拿不到的 AI 插件,我自己用了一个月"

---

## 6️⃣ 工具推荐

| 需求 | 工具 | 备注 |
|---|---|---|
| 截图加大字 + 红框 | **CleanShot X** (macOS) | 标注模式最快 |
| 中文小红书风模板 | **稿定设计** / **创客贴** | 有现成模板套 |
| AI 文字叠加 / 修改 | **即梦** / **通义万相** / **腾讯 ARC** | 中文图编辑友好 |
| 海报全新生成 | **Midjourney** / **DALL-E 3** | 不要让它处理真实截图 |
| 视频缩略图 | **稿定设计 · B 站封面模板** | 直接套 |
| 免费手撸 | **Figma** | 自由度最高,要会用 |

---

## 7️⃣ 工作流推荐

**5 分钟产出小红书 9 张图**:

1. 先把 9 张原图按清单准备好(`docs/img/` 已有)
2. 用 CleanShot X 给每张图上的真实公司名打码(框选 → 像素化)
3. 第 1 张(封面)单独处理:
   - 上传到即梦 / 通义万相
   - 粘贴 **第 1 节 文字叠加型** 提示词
   - 微调 1-2 次直到满意
4. 剩下 8 张不用动,直接发(已经够好了)
5. 小红书发图时按编号顺序拖

**5 分钟产出 B 站封面**:

1. 用 `dashboard-hero.png` 当底图
2. 即梦 / 稿定设计 套 B 站封面模板(1280×720)
3. 加大字"5 分钟筛 300 个 Boss 岗位 · AI 帮你锁定神仙工作"
4. 右上角小标签:"开源 · MIT · 5000 行 MV3"
5. 上传 B 站作为视频封面

---

## ⚠️ 注意

- **不要让 AI 重画 dashboard 内容** — AI 会瞎编 "AI 工程师" "字节" 这种不真实的内容,反而显得 fake
- **真实截图 + AI 叠字**才是黄金组合
- 大字标题要**手机缩略图能看清** — 字号宁大勿小
- 别堆 emoji,1-2 个点睛足够
