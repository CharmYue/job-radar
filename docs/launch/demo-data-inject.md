# 🎬 Demo 数据注入(给截图/录像准备的假数据)

**用途**:30 秒填一个看板满满的"已跑完"假数据,真实视觉效果,**全是假公司名不用打码**。

## 怎么用

### 方法 A:从 popup 注入(推荐)

1. 装好 6.2.x 扩展,在 `chrome://extensions/` 找到「Boss 求职雷达」
2. 点 **Service Worker** 蓝色链接(打开 SW DevTools)
3. 把 **下面这整段** paste 到 console 回车
4. 看到 `✓ 注入 38 条 demo 数据完成` 就 OK
5. 关掉 DevTools → 点扩展图标 → 运行 tab → 数据池 → 🖥 全屏看板 → 满屏假数据!

### 方法 B:截图完了清干净

```js
// 清 demo 数据(只清 demo-job- 开头的,不动你真实数据)
(async () => {
  const db = await new Promise((r, j) => { const q = indexedDB.open('boss_radar'); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); });
  const tx = db.transaction('jobs', 'readwrite');
  const store = tx.objectStore('jobs');
  const all = await new Promise((r, j) => { const q = store.getAll(); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); });
  for (const j of all) if (String(j.job_id).startsWith('demo-job-')) store.delete(j.job_id);
  await new Promise((r) => { tx.oncomplete = r; });
  console.log('✓ Demo 数据已清,你的真实数据不受影响');
})();
```

---

## 注入脚本(完整,paste 整段)

```js
(async () => {
  const COMPANIES = [
    // 大厂(给 S/A 加亮点)
    { name: 'CloudCore 科技', industry: '云计算', size: '10000人以上', stage: '已上市' },
    { name: 'NeuralFlow', industry: '人工智能', size: '1000-9999人', stage: 'D轮及以上' },
    { name: 'PixelByte 互娱', industry: '互联网/游戏', size: '5000人', stage: '已上市' },
    { name: 'GlobeSync', industry: 'SaaS', size: '500-999人', stage: 'C轮' },
    { name: 'QuantumLink', industry: '企业服务', size: '1000-9999人', stage: 'C轮' },
    { name: 'OmniData 解决方案', industry: 'IT服务', size: '1000-9999人', stage: '已上市' },
    // 中型
    { name: 'SmartWave AI', industry: '人工智能', size: '100-499人', stage: 'B轮' },
    { name: 'BridgeOne', industry: '出海服务', size: '100-499人', stage: 'B轮' },
    { name: 'FlowGate', industry: '云计算', size: '500-999人', stage: 'C轮' },
    { name: 'Pulsar AI', industry: '人工智能', size: '100-499人', stage: 'A轮' },
    // 小厂
    { name: '元启智能', industry: '人工智能', size: '20-99人', stage: '天使轮' },
    { name: 'Drift Lab', industry: 'SaaS', size: '20-99人', stage: '天使轮' },
    { name: 'Echo 智数', industry: '大数据', size: '20-99人', stage: 'A轮' },
    // 外资 / 外包(给 Reject 反例)
    { name: 'BlueRiver Consulting', industry: 'IT外包', size: '5000-9999人', stage: '已上市' },
    { name: 'GreyMatter Outsource', industry: '人力外包', size: '1000-4999人', stage: '已上市' },
  ];
  const CITIES = ['上海', '杭州', '北京', '深圳'];
  const AREAS_BY_CITY = {
    '上海': ['浦东·张江·张江高科', '徐汇·漕河泾', '黄浦·人民广场', '长宁·中山公园'],
    '杭州': ['余杭·未来科技城', '滨江·长河', '西湖·黄龙', '萧山·钱江世纪城'],
    '北京': ['海淀·中关村·西二旗', '朝阳·望京', '海淀·上地', '朝阳·国贸'],
    '深圳': ['南山·科技园', '南山·后海', '福田·CBD', '南山·西丽'],
  };
  const TITLES = [
    'AI 解决方案工程师', 'AI Solution Engineer', '高级解决方案架构师',
    'Customer Engineer', 'AI 客户工程师', 'Solutions Architect',
    'AI 出海方案经理', '高级售前工程师', 'AI 产品技术专家',
    'AI 应用工程师 (LLM)', 'AI 平台解决方案', '客户成功 - AI 方向',
    'GenAI 解决方案专家', 'AI Infra 工程师',
  ];
  const TITLES_REJECT = ['Python 后端开发', '前端工程师 (Vue/React)', 'Java 中间件', '运维工程师'];

  const HR_ACTIVE_FRESH = ['刚刚活跃', '今日活跃', '在线', '2 小时前活跃', '4 小时前活跃'];
  const HR_ACTIVE_RECENT = ['1 天前活跃', '2 天前活跃', '3 天前活跃'];
  const HR_ACTIVE_OLD = ['5 天前活跃', '7 天前活跃', '2 周前活跃', '3 周前活跃'];

  const HR_NAMES = ['张倩', '王浩', '李娜', '陈思', '刘洋', '杨阳', '赵宁'];
  const HR_TITLES = ['HRBP', '技术招聘', '招聘经理', 'HR Director', '高级招聘专家'];

  const REASONS_S = [
    '简历核心技术栈(LLM/RAG/Agent)与岗位 JD 高度契合,3-5 年经验恰好匹配,大厂背景符合候选人偏好',
    '岗位职责包含完整 AI 方案落地链路,与候选人项目经验完全对口,公司已上市且不需融资,稳定性高',
    'GenAI 出海方向 + 大厂背景 + 5-10 年经验区间,薪资范围 50-80K 显著高于候选人目标月薪',
  ];
  const REASONS_A = [
    '技术栈与候选人简历相关度高,经验区间略松(1-3 年),薪资符合预期,公司 C 轮稳定',
    '岗位方向相邻(售前架构),简历的 Solution Engineer 经验完全可迁移,通勤距离合适',
    'AI 客户工程师方向对口,公司 D 轮 + 1000+ 规模,经验要求 3-5 年与候选人吻合',
  ];
  const REASONS_B = [
    '岗位与简历有交集但需 1-2 项技能 stretch (要求 K8s 实战经验略浅),薪资略低于期望',
    '方向相关但偏小厂 (天使轮),稳定性维度扣分',
  ];
  const REASONS_C = [
    '岗位偏纯技术架构,与候选人的客户对接方向 mismatch 较大',
  ];
  const REASONS_REJECT = [
    '岗位为外包性质,与候选人「不投外包」明确冲突',
    '纯 Python 后端方向,与候选人 AI 解决方案目标完全不沾边',
  ];

  const CONCERNS_BANK = [
    '加班风险较高(行业典型 996)',
    '通勤超过 1 小时(跨区)',
    'B 轮稳定性中等',
    '薪资上限不明确(谈薪空间未知)',
    '需要英语日常沟通',
    '组内技术栈以 Go 为主,Python 可能边缘化',
  ];
  const PITCH_BANK = [
    '老师您好,我有 3 年 AI 解决方案落地经验,主导过 RAG 和 Agent 项目,简历附上,期待沟通。',
    '您好,我对贵司的 AI 平台方向很感兴趣,我有大厂出海经验和 5+ 年技术对接背景,期待交流。',
    '您好,我看到岗位要求与我的 LLM 应用经验高度契合,期待您的回复。',
  ];

  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const makeJobId = (i) => `demo-job-${String(i).padStart(4, '0')}`;
  const today = new Date();
  const fmt = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
  const daysAgo = (n) => { const d = new Date(today); d.setDate(d.getDate() - n); return d; };

  // 设计 38 条:8 S / 12 A / 10 B / 5 C / 3 Reject — 一个还原真实分布的样本
  const distribution = [
    ...Array(8).fill('S'), ...Array(12).fill('A'), ...Array(10).fill('B'),
    ...Array(5).fill('C'), ...Array(3).fill('Reject'),
  ];

  const jobs = distribution.map((priority, i) => {
    const isReject = priority === 'Reject';
    const company = isReject ? pick(COMPANIES.slice(-2)) : pick(COMPANIES);
    const title = isReject ? pick(TITLES_REJECT) : pick(TITLES);
    const city = pick(CITIES);
    const area = pick(AREAS_BY_CITY[city]);
    const score = priority === 'S' ? 88 + Math.floor(Math.random() * 11)
                : priority === 'A' ? 72 + Math.floor(Math.random() * 16)
                : priority === 'B' ? 55 + Math.floor(Math.random() * 14)
                : priority === 'C' ? 40 + Math.floor(Math.random() * 14)
                : 15 + Math.floor(Math.random() * 24);
    const reason = priority === 'S' ? pick(REASONS_S)
                 : priority === 'A' ? pick(REASONS_A)
                 : priority === 'B' ? pick(REASONS_B)
                 : priority === 'C' ? pick(REASONS_C)
                 : pick(REASONS_REJECT);
    const concerns = priority === 'S' || priority === 'A'
      ? (Math.random() > 0.6 ? [pick(CONCERNS_BANK)] : [])
      : [pick(CONCERNS_BANK)];

    // 月薪生成
    const baseLow = priority === 'S' ? 40 : priority === 'A' ? 35 : priority === 'B' ? 28 : 20;
    const lo = baseLow + Math.floor(Math.random() * 8);
    const hi = lo + 10 + Math.floor(Math.random() * 15);
    const months = pick(['13薪', '14薪', '15薪', '16薪', '']);
    const salary = `${lo}-${hi}K${months ? '·' + months : ''}`;

    // HR 活跃度(S 偏多绿色,Reject 偏多老的)
    const hrActiveBank = priority === 'S' || priority === 'A'
      ? (Math.random() > 0.3 ? HR_ACTIVE_FRESH : HR_ACTIVE_RECENT)
      : (Math.random() > 0.5 ? HR_ACTIVE_OLD : HR_ACTIVE_RECENT);

    // 发布时间:1-21 天前
    const pubDays = Math.floor(Math.random() * 21) + 1;
    const crawlTime = fmt(today);
    const ts = Date.parse(crawlTime.replace(' ', 'T'));

    return {
      crawl_time: crawlTime,
      crawl_time_ts: ts,
      job_id: makeJobId(i),
      job_name: title,
      salary,
      city,
      area,
      experience: pick(['1-3年', '3-5年', '5-10年', '经验不限']),
      education: pick(['本科', '硕士', '本科', '本科', '学历不限']),
      skills: pick(['LLM,RAG,Agent', 'Python,FastAPI,Azure', 'Kubernetes,Go,gRPC', 'Java,Spring,微服务']),
      welfare: pick(['五险一金,弹性工作,免费三餐', '股票期权,带薪年假,免费班车', '五险一金,补充医疗,定期团建', '六险一金,股票期权,弹性工作']),
      company_id: 'demo-company-' + (company.name.length),
      company_name: company.name,
      industry: company.industry,
      financing: company.stage,
      company_size: company.size,
      hr_name: pick(HR_NAMES),
      hr_title: pick(HR_TITLES),
      hr_active: pick(hrActiveBank),
      publish_time: fmt(daysAgo(pubDays)),
      job_url: `https://www.zhipin.com/job_detail/${makeJobId(i)}.html`,
      position_name: pick(['AI 解决方案', 'AI 出海', 'Solution Engineer']),
      score,
      score_priority: priority,
      score_reason: reason,
      score_concerns: concerns,
      score_pitch: pick(PITCH_BANK),
      score_resume_version: 'AI_SOLUTION',
      score_fingerprint: 'demo-fp-' + i,
      score_at: Date.now(),
      user_marked: '',
      marked: '',
    };
  });

  // 写入 IDB
  const db = await new Promise((r, j) => {
    const q = indexedDB.open('boss_radar');
    q.onsuccess = () => r(q.result);
    q.onerror = () => j(q.error);
  });
  const tx = db.transaction('jobs', 'readwrite');
  const store = tx.objectStore('jobs');
  for (const j of jobs) store.put(j);
  await new Promise((r) => { tx.oncomplete = r; });
  console.log(`✓ 注入 ${jobs.length} 条 demo 数据完成。分布: S 8 / A 12 / B 10 / C 5 / Reject 3`);
  console.log('打开 popup → 运行 tab → 数据池 → 🖥 全屏 看效果');
})();
```

---

## 小贴士

- 假数据有 38 条,分级分布跟真实长尾很像(S 少 A 多 B 中)
- HR 活跃度 S/A 偏绿,Reject 偏老 — 颜色看板会很有层次
- 公司名都是英文 + 拼凑的,**完全可以直接出镜**不用打码
- 用完截图后跑「方法 B」清掉,你真实数据不动
