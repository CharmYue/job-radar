---
description: 用 claude-in-chrome 扫一遍 Boss直聘 SE 岗,DeepSeek 打分,WxPusher 推送
---

# /boss — Boss直聘求职雷达(单次手动触发)

Manual Boss workflow for Claude Code. Place at `~/.claude/commands/boss.md` so
typing `/boss` triggers this. Drives claude-in-chrome MCP to scrape today's
listings → decodes salaries → filters by your range → DeepSeek scores → WxPusher
pushes the daily report.

## 必读上下文

- 求职画像:`<repo>/config/profile.yaml`(score.py 自动读 `data/resume.md` 拼到 LLM)
- 入口脚本:`<repo>/scripts/run_daily.py`(--import 模式打分 + 推送)
- 浏览器:用户的日常 Chrome 已登录 Boss
- **不要绕过用户的 Chrome 直接抓** — 会被 Boss 反爬封号。走 claude-in-chrome session。

## 工具加载

claude-in-chrome 是延迟加载的 MCP。第一次用前必须 `ToolSearch` 加载:

```
select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__javascript_tool,mcp__claude-in-chrome__read_console_messages
```

## 工作流

### 步骤 1 · 拿 tab

调 `tabs_context_mcp` createIfEmpty=true,记下 tabId。清空累计缓冲:

```js
localStorage.removeItem('__bossAll__')
```

### 步骤 2 · 六个 query × 三个城市 = 18 次搜索

城市码:上海 101020100 / 杭州 101210100 / 北京 101010100

Queries(按自己求职方向改):
1. `解决方案工程师`
2. `AI 解决方案`
3. `Solution Engineer` *(英文 query Boss 命中通常 0-1 条)*
4. `Customer Engineer` *(同上)*
5. `AI 英语`
6. `AI 出海`

每次:
- `navigate` 到 `https://www.zhipin.com/web/geek/jobs?query={encodeURIComponent(q)}&city={city_code}`
- 等 SPA 渲染(~1s),`javascript_tool` 跑下方提取脚本

如果 navigate 后 URL 跳 `/web/user/?ka=header-login`,告诉用户"Boss 要重新扫码登录",停止。

### 步骤 3 · JS 提取(含 webfont 薪资解码 + 过滤)

Boss 把薪资数字藏在 PUA 码点(U+E031-E03A,57393-57402),由 `kanzhun-mix` 字体渲染。
**映射极简**:`digit = codepoint - 57393`。

把这段 JS 嵌进每次搜索后(替换 q / cn / minK 三个变量):

```js
(() => {
  const q='解决方案工程师', cn='上海', minK=32;  // 改成本次 query/city/最低月薪上限(K)
  const decode = s => Array.from(s).map(c => {
    const cp = c.charCodeAt(0);
    return (cp>=57393 && cp<=57402) ? String(cp-57393) : c;
  }).join('');
  const out = [];
  document.querySelectorAll('.job-card-box').forEach(card => {
    const a = card.querySelector('a.job-name'); if (!a) return;
    const sal = card.querySelector('.job-salary');
    const salStr = decode(sal ? sal.textContent : '');
    const m = salStr.match(/(\d+)\s*-\s*(\d+)\s*K/i);
    let lo=null, hi=null;
    if (m) { lo = parseInt(m[1]); hi = parseInt(m[2]); }
    const exp = Array.from(card.querySelectorAll('.tag-list li'))
      .map(x => x.textContent.trim()).join('/');
    const company = card.querySelector('.boss-name')?.textContent.trim() || '';
    const inRange = (hi && hi >= minK) || (lo && lo >= minK);
    if (!salStr || (salStr.includes('K') && !inRange)) return;
    out.push({
      title: a.textContent.trim(),
      url: 'https://www.zhipin.com' + a.getAttribute('href'),
      salary: salStr, salaryLow: lo, salaryHigh: hi,
      tags: exp, company, city: cn, query: q, source: 'boss'
    });
  });
  const buf = JSON.parse(localStorage.getItem('__bossAll__') || '[]');
  buf.push(...out);
  localStorage.setItem('__bossAll__', JSON.stringify(buf));
  return { total: document.querySelectorAll('.job-card-box').length,
           kept: out.length, buf_size: buf.length };
})()
```

`total` 是页面卡片数(Boss 默认 ~15),`kept` 是过滤后保留数,`buf_size` 是 localStorage 累计。

### 步骤 4 · 导出 JSON

18 次搜完后,用 chunked log 把 localStorage 数据搬出来(规避 JS 输出截断):

```js
const data = localStorage.getItem('__bossAll__');
const cs = 1500;
for (let i = 0; i*cs < data.length; i++) {
  console.log('BOSS_' + String(i).padStart(3,'0') + '|' + data.slice(i*cs, (i+1)*cs));
}
console.log('BOSS_END|' + data.length);
```

然后 `read_console_messages` pattern=`BOSS_`,把 chunks 拼回 JSON,转成 `run_daily.py` 期望的 schema 后写到 `<repo>/data/boss_<YYYY-MM-DD>.json`:

```json
[
  {"title":"...","company":"...","city":"...","salary":"30-60K·15薪",
   "jd":"<tags> | [Boss 列表页]", "url":"...","source":"boss"},
  ...
]
```

按 URL 去重。

### 步骤 5 · 打分 + 推送

```bash
cd <repo> && uv run python scripts/run_daily.py --import data/boss_<YYYY-MM-DD>.json
```

DeepSeek 自动读 profile + resume.md 打分,WxPusher 推 compact 报告到微信,完整版写 `data/report_<date>.md`。

### 步骤 6 · 汇报

- 抓取多少条 raw / 薪资过滤后多少 / 30天去重后多少 / 进入打分多少
- 几个 S 几个 A
- WxPusher 是否成功(看日志末行 `WxPusher push ok`)

## 用时预算

整轮 5-10 分钟。某步超 30 秒卡住先问用户是否中止。

## 不要做

- 不要钻 Boss 详情页(`/job_detail/<id>.html`)— 反爬触发更易封号
- 不要跑 launchd 把 /boss 装定时 — 必须 Chrome 前台手动触发,只装 17:00 微信提醒
- 不要安装新依赖

## 已知限制

- **Webfont 映射可能换**:目前 `codepoint - 57393` 是 kanzhun-mix 字体的硬编码。
  Boss 若换字体,需重新解码(下载 woff2 用 fonttools 看 cmap)。
- **Boss session 会过期**:Chrome 端要保持登录,过期会跳扫码页。
