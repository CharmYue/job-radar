// ============================================================
// background.js — Service Worker 编排器 (Final)
// ------------------------------------------------------------
// 改进:
//   - tab.id 严格过滤,避免跨 tab 数据污染
//   - windows.onRemoved 监听,用户手动关窗口时优雅退出
//   - alarms 保活,防 SW 休眠中断长 sleep
//   - 登录态 / 验证码 / 风控页 检测,异常立即停
//   - 风控响应 code != 0 即停当前关键词,触发 backoff
//   - 多字段兜底取发布时间
//   - 按总条数停止 (maxTotal)
//   - URL 加 sortType 参数支持"按发布时间倒序"
//   - 详细进度日志
// ============================================================

const CITY_CODES = {
  '全国': '100010000', '北京': '101010100', '上海': '101020100',
  '广州': '101280100', '深圳': '101280600', '杭州': '101210100',
  '成都': '101270100', '南京': '101190100', '武汉': '101200100',
  '西安': '101110100', '苏州': '101190400', '天津': '101030100',
  '重庆': '101040100', '长沙': '101250100', '郑州': '101180100',
  '合肥': '101220100',
};

// Boss URL 排序参数:
//   不带 sortType = 综合排序 (默认)
//   sortType=1   = 最新发布
//   sortType=2   = 距离最近
const SORT_MAP = {
  comprehensive: '',
  newest: '&sortType=1',
};

// ============================================================
// 状态
// ============================================================
const state = {
  running: false,
  shouldStop: false,
  added: 0,
  reachedMaxTotal: false,
  currentTabId: null,
  currentWindowId: null,    // 独立窗口模式下用
  persistentTabId: null,    // 可见模式下复用的 tab
  currentKeywordIdx: 0,
  currentKeywordTotal: 0,
  currentPage: 0,
  config: null,
};

let pendingContext = null;     // { keyword, city }
let riskFlag = false;          // 当前关键词内 fetch 拦截到风控信号
let pageResponseCounter = 0;   // 当前关键词收到的有效响应数(用于"首页确认数据到达")

// ============================================================
// 工具
// ============================================================
const rand = (lo, hi) => lo + Math.random() * (hi - lo);

// 分块 sleep: 每块最多 8 秒,块间调一次 chrome API 保活 SW
async function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const chunk = Math.min(8000, end - Date.now());
    await new Promise((r) => setTimeout(r, chunk));
    // noop chrome API,触发 SW 活跃
    try { await chrome.runtime.getPlatformInfo(); } catch (e) {}
    // sleep 期间允许 stop 中断
    if (state.shouldStop) return;
  }
}

function log(msg) {
  console.log('[boss-final]', msg);
  chrome.runtime.sendMessage({ type: 'progress', msg }).catch(() => {});
}

function progressLine() {
  const c = state.currentKeywordIdx;
  const t = state.currentKeywordTotal;
  const p = state.currentPage;
  return `[${c}/${t} | R${p}]`;
}

async function getJobsMap() {
  return (await chrome.storage.local.get('jobs')).jobs || {};
}
async function setJobsMap(m) {
  await chrome.storage.local.set({ jobs: m });
}

// SW 保活: 30 秒周期的 alarm(Chrome 最小合规周期),仅在运行中起意义
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    // noop,触发 SW 保持唤醒
  }
});

// 窗口被手动关闭时优雅清理 (独立窗口模式)
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === state.currentWindowId) {
    log(`  ⚠ 采集窗口被关闭`);
    state.currentWindowId = null;
    state.currentTabId = null;
  }
});

// tab 被关闭时清理 (可见模式)
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === state.persistentTabId) {
    log(`  ⚠ 采集标签页被关闭`);
    state.persistentTabId = null;
    state.currentTabId = null;
  }
});

// ============================================================
// 数据归一化
// ============================================================
function pickPublishTime(j) {
  const candidates = [
    j.lastModifyTime, j.gmtModified, j.pubTime,
    j.publishTime, j.gmtPublish, j.modifyTime,
  ];
  for (const v of candidates) {
    if (!v) continue;
    if (typeof v === 'number') {
      const d = new Date(v);
      if (!isNaN(d)) return d.toISOString().slice(0, 19).replace('T', ' ');
    }
    if (typeof v === 'string' && v.length > 4) return v;
  }
  return '';
}

function normalize(j, ctx) {
  return {
    crawl_time:   new Date().toISOString().replace('T', ' ').slice(0, 19),
    position_code: ctx.positionCode || '',
    position_name: ctx.keyword || '',
    search_city:  ctx.city || '',
    city_code:    ctx.cityCode || '',
    filter_exp:   ctx.experience || '',
    filter_deg:   ctx.degree || '',
    job_id:       j.encryptJobId || j.jobId || '',
    job_name:     j.jobName || '',
    salary:       j.salaryDesc || j.salary || '',
    city:         j.cityName || '',
    area:         [j.areaDistrict, j.businessDistrict].filter(Boolean).join('·'),
    experience:   j.jobExperience || '',
    education:    j.jobDegree || '',
    skills:       Array.isArray(j.skills) ? j.skills.join(',')
                 : Array.isArray(j.jobLabels) ? j.jobLabels.join(',') : '',
    welfare:      Array.isArray(j.welfareList) ? j.welfareList.join(',') : '',
    company_id:   j.encryptBrandId || j.brandId || '',
    company_name: j.brandName || '',
    industry:     j.brandIndustry || '',
    financing:    j.brandStageName || '',
    company_size: j.brandScaleName || '',
    hr_name:      j.bossName || '',
    hr_title:     j.bossTitle || '',
    hr_active:    j.bossActiveTimeDesc || (j.bossCert ? '已认证' : ''),
    publish_time: pickPublishTime(j),
    job_url:      j.encryptJobId
                    ? `https://www.zhipin.com/job_detail/${j.encryptJobId}.html`
                    : '',
    lid:          j.lid || '',
    security_id:  j.securityId || '',
  };
}

// ============================================================
// 消息路由
// ============================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      // 数据拦截消息 — 必须来自当前正在采集的 tab
      if (msg.type === 'jobs_intercepted') {
        if (sender.tab && sender.tab.id !== state.currentTabId) {
          sendResponse({ ok: true, ignored: true });
          return;
        }
        await handleIntercepted(msg.data);
        sendResponse({ ok: true });
        return;
      }

      switch (msg.type) {
        case 'start':
          if (state.running) {
            sendResponse({ ok: false, error: '已在运行' });
            return;
          }
          startCrawl(msg.config);
          sendResponse({ ok: true });
          break;
        case 'stop':
          state.shouldStop = true;
          sendResponse({ ok: true });
          break;
        case 'status': {
          const jobs = await getJobsMap();
          sendResponse({
            ok: true,
            running: state.running,
            total: Object.keys(jobs).length,
            progress: {
              ki: state.currentKeywordIdx,
              kt: state.currentKeywordTotal,
              p: state.currentPage,
              added: state.added,
            },
          });
          break;
        }
        case 'export':
          try {
            const n = await exportCsv();
            sendResponse({ ok: true, count: n });
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          }
          break;
        case 'export_jobradar':
          try {
            const r = await exportJobRadarJson();
            sendResponse({ ok: true, count: r.count, filename: r.filename });
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          }
          break;
        case 'clear':
          await chrome.storage.local.remove('jobs');
          sendResponse({ ok: true });
          break;
        case 'get_queue': {
          const q = await getTaskQueue();
          sendResponse({ ok: true, queue: q });
          break;
        }
        case 'clear_queue':
          await chrome.storage.local.remove('taskQueue');
          sendResponse({ ok: true });
          break;
        case 'get_profile':
          sendResponse({ ok: true, profile: await getProfile() });
          break;
        case 'save_profile':
          await setProfile(msg.profile || {});
          sendResponse({ ok: true });
          break;
        case 'get_api':
          sendResponse({ ok: true, api: await getApiConfig() });
          break;
        case 'save_api':
          await setApiConfig(msg.api || {});
          sendResponse({ ok: true });
          break;
        case 'score_all':
          try {
            const r = await scoreAllUnscored();
            sendResponse({ ok: true, ...r });
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          }
          break;
        case 'push_now':
          try {
            const r = await pushNow();
            sendResponse({ ok: true, ...r });
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          }
          break;
        case 'list_jobs': {
          const jobsMap = await getJobsMap();
          const items = Object.values(jobsMap);
          // 按 score 倒序 + 未打分排最后
          items.sort((a, b) => {
            const sa = a.score_priority ? (a.score || 0) : -1;
            const sb = b.score_priority ? (b.score || 0) : -1;
            return sb - sa;
          });
          sendResponse({ ok: true, items });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'unknown' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;
});

async function handleIntercepted(payload) {
  if (!pendingContext) return;
  if (!payload) return;

  pageResponseCounter++;

  // 风控信号: code != 0
  if (payload.code !== 0) {
    riskFlag = true;
    log(`  ⚠ ${progressLine()} 拦到风控响应 code=${payload.code} msg=${payload.message || ''}`);
    return;
  }

  const list = (payload.zpData && payload.zpData.jobList) || [];
  if (list.length === 0) return;

  // 公司过滤(逗号或空格分隔,子串匹配,大小写不敏感)
  const companyFilter = (state.config && state.config.companyFilter || '').trim();
  const companyTokens = companyFilter
    ? companyFilter.split(/[,\s]+/).filter(Boolean).map((s) => s.toLowerCase())
    : [];

  const jobs = await getJobsMap();
  let added = 0;
  let filtered = 0;
  for (const raw of list) {
    const item = normalize(raw, pendingContext);
    if (!item.job_id || jobs[item.job_id]) continue;
    if (companyTokens.length > 0) {
      const brand = (item.company_name || '').toLowerCase();
      const matched = companyTokens.some((t) => brand.indexOf(t) !== -1);
      if (!matched) { filtered++; continue; }
    }
    jobs[item.job_id] = item;
    added++;
    if (state.config && state.config.maxTotal > 0 &&
        state.added + added >= state.config.maxTotal) {
      break;
    }
  }
  await setJobsMap(jobs);
  state.added += added;

  const flt = filtered > 0 ? ` 公司过滤 -${filtered}` : '';
  log(`  ✓ ${progressLine()} 捕获 ${list.length} 条,新增 ${added}${flt} (累计 ${state.added})`);

  if (state.config.maxTotal > 0 && state.added >= state.config.maxTotal) {
    state.reachedMaxTotal = true;
    log(`  ★ 达到总条数上限 ${state.config.maxTotal},准备结束`);
  }
}

// ============================================================
// 主流程
// ============================================================
function buildSearchUrl(task, sortMode) {
  // task = { positionCode?, query?, positionName, cityCode, cityName,
  //         experience?, degree?, salary?, scale?, stage?, dateType? }
  // positionCode 和 query 二选一(关键词搜索 vs 职位类目搜索)。
  const sort = SORT_MAP[sortMode] || '';
  const p = new URLSearchParams();
  p.set('city', task.cityCode);
  if (task.positionCode) p.set('position', task.positionCode);
  if (task.query)        p.set('query', task.query);
  if (task.experience)   p.set('experience', task.experience);
  if (task.degree)       p.set('degree', task.degree);
  if (task.salary)       p.set('salary', task.salary);
  if (task.scale)        p.set('scale', task.scale);
  if (task.stage)        p.set('stage', task.stage);
  if (task.dateType)     p.set('dateType', task.dateType);
  let url = `https://www.zhipin.com/web/geek/job?${p.toString()}`;
  if (sort) url += sort;
  return url;
}

// 任务队列存在 chrome.storage.local 的 'taskQueue' 下,持久化
async function getTaskQueue() {
  return (await chrome.storage.local.get('taskQueue')).taskQueue || null;
}
async function setTaskQueue(q) {
  await chrome.storage.local.set({ taskQueue: q });
}

async function startCrawl(config) {
  // 配置默认值
  config.maxScrolls = Math.min(50, Math.max(1, parseInt(config.maxScrolls) || 10));
  config.maxTotal   = Math.max(0, parseInt(config.maxTotal) || 0);
  config.dwellMin   = Math.max(1, parseFloat(config.dwellMin) || 2);
  config.dwellMax   = Math.max(config.dwellMin + 0.5, parseFloat(config.dwellMax) || 5);
  config.gapMin     = Math.max(3, parseFloat(config.gapMin) || 10);
  config.gapMax     = Math.max(config.gapMin + 1, parseFloat(config.gapMax) || 25);
  config.sortMode   = config.sortMode || 'comprehensive';

  // 加载/初始化任务队列
  let q = await getTaskQueue();
  if (config.resume && q && q.tasks && q.tasks.length > 0) {
    log(`▶ 续跑: 上次队列共 ${q.tasks.length} 任务,继续未完成的`);
  } else {
    q = {
      tasks: (config.tasks || []).map((t, idx) => ({
        ...t,
        id: idx,
        status: 'pending',
        captured: 0,
        attempts: 0,
        lastError: '',
      })),
      createdAt: Date.now(),
    };
    await setTaskQueue(q);
    log(`▶ 新队列: ${q.tasks.length} 个组合`);
  }
  if (!q.tasks || q.tasks.length === 0) {
    log(`✗ 任务队列为空,请勾选职位 × 城市后再开始`);
    state.running = false;
    return;
  }

  state.running = true;
  state.shouldStop = false;
  state.reachedMaxTotal = false;
  state.added = 0;
  state.currentKeywordTotal = q.tasks.length;
  state.config = config;

  log(`  排序=${config.sortMode}${config.maxTotal ? ' · 总上限 ' + config.maxTotal : ''} · 每词最多滚 ${config.maxScrolls} 次`);

  try {
    let consecutiveRiskCount = 0;

    for (let ti = 0; ti < q.tasks.length; ti++) {
      if (state.shouldStop || state.reachedMaxTotal) break;

      const t = q.tasks[ti];
      if (t.status === 'done' || t.status === 'failed_skipped') continue;

      state.currentKeywordIdx = ti + 1;
      state.currentPage = 0;

      const tag = t.experience ? ` exp=${t.experience}` : '';
      log(`[${ti + 1}/${q.tasks.length}] ${t.positionName} @ ${t.cityName}${tag}`);

      t.status = 'running';
      t.attempts = (t.attempts || 0) + 1;
      const beforeAdded = state.added;
      await setTaskQueue(q);

      try {
        await runOneTask(t, config);
      } catch (e) {
        log(`  ✗ 任务异常: ${e.message}`);
      }

      t.captured = state.added - beforeAdded;

      if (riskFlag) {
        t.status = 'failed';
        t.lastError = 'risk';
        consecutiveRiskCount++;
        log(`  ⚠ 风控,记 failed 待重试`);
        if (consecutiveRiskCount >= 3) {
          log(`  ⏸ 连续 3 次风控,冷却 30 分钟`);
          await setTaskQueue(q);
          await sleep(30 * 60 * 1000);
          consecutiveRiskCount = 0;
        }
      } else {
        t.status = 'done';
        consecutiveRiskCount = 0;
      }
      await setTaskQueue(q);

      const hasMore = q.tasks.slice(ti + 1).some(
        (x) => x.status !== 'done' && x.status !== 'failed_skipped'
      );
      if (hasMore && !state.shouldStop && !state.reachedMaxTotal) {
        const gap = rand(config.gapMin * 1000, config.gapMax * 1000);
        log(`  ⏸ 任务间等待 ${(gap / 1000).toFixed(0)}s`);
        await sleep(gap);
      }
    }

    // 第二轮: 补抓上一轮 failed 的
    if (!state.shouldStop && !state.reachedMaxTotal) {
      const failed = q.tasks.filter((t) => t.status === 'failed' && t.attempts < 2);
      if (failed.length > 0) {
        log(`\n▶ 第二轮: 补抓 ${failed.length} 个失败任务`);
        await sleep(60 * 1000);
        for (let i = 0; i < failed.length; i++) {
          if (state.shouldStop || state.reachedMaxTotal) break;
          const t = failed[i];
          state.currentKeywordIdx = q.tasks.indexOf(t) + 1;
          log(`[补抓 ${i + 1}/${failed.length}] ${t.positionName} @ ${t.cityName}`);
          t.status = 'running';
          t.attempts++;
          const before = state.added;
          await setTaskQueue(q);
          try { await runOneTask(t, config); } catch (e) {}
          t.captured = state.added - before;
          if (riskFlag) {
            t.status = 'failed_skipped';
            log(`  ⚠ 补抓仍风控,放弃`);
          } else {
            t.status = 'done';
          }
          await setTaskQueue(q);
          if (i < failed.length - 1 && !state.shouldStop) {
            await sleep(rand(config.gapMin * 1000, config.gapMax * 1000));
          }
        }
      }
    }

    const doneN = q.tasks.filter((t) => t.status === 'done').length;
    const failN = q.tasks.filter((t) => t.status === 'failed' || t.status === 'failed_skipped').length;
    log(`\n=== 队列完成 完成 ${doneN}/${q.tasks.length}, 失败 ${failN} ===`);

  } catch (e) {
    log(`✗ 主流程异常: ${e.message}`);
  } finally {
    await cleanupTarget();
    pendingContext = null;
    state.running = false;
    state.currentTabId = null;
    state.currentWindowId = null;
    state.persistentTabId = null;

    chrome.runtime.sendMessage({
      type: 'done',
      added: state.added,
      reachedMax: state.reachedMaxTotal,
    }).catch(() => {});

    log(`✓ 本次新增 ${state.added} 条`);
  }
}

async function runOneTask(task, config) {
  pendingContext = {
    keyword: task.positionName,
    city: task.cityName,
    positionCode: task.positionCode,
    cityCode: task.cityCode,
    experience: task.experience || '',
    degree: task.degree || '',
  };
  riskFlag = false;
  pageResponseCounter = 0;

  const url = buildSearchUrl(task, config.sortMode);

  // -------- 根据 runMode 打开目标 --------
  if (config.runMode === 'tab_visible') {
    try {
      if (state.persistentTabId == null) {
        // 第一次: 在用户主窗口里新建一个 tab
        const targetWin = await getTargetNormalWindow();
        const t = await chrome.tabs.create({
          windowId: targetWin ? targetWin.id : undefined,
          url,
          active: true,
        });
        state.persistentTabId = t.id;
        state.currentTabId = t.id;
        // 把那个窗口聚焦到前面,方便用户看
        if (targetWin) {
          try { await chrome.windows.update(targetWin.id, { focused: true }); } catch (e) {}
        }
      } else {
        // 后续关键词: 复用同一个 tab,改 URL
        await chrome.tabs.update(state.persistentTabId, { url, active: true });
        state.currentTabId = state.persistentTabId;
      }
    } catch (e) {
      log(`  ✗ 打开标签页失败: ${e.message}`);
      return;
    }
  } else {
    // 独立窗口模式 (默认)
    let win;
    try {
      win = await chrome.windows.create({
        url,
        type: 'normal',
        width: 1100,
        height: 760,
        left: 0,
        top: 0,
      });
      try {
        await chrome.windows.update(win.id, { state: 'minimized' });
      } catch (e) {
        log(`  ⚠ 最小化失败,窗口可见(不影响运行): ${e.message}`);
      }
    } catch (e) {
      log(`  ✗ 创建窗口失败: ${e.message}`);
      return;
    }
    state.currentWindowId = win.id;
    state.currentTabId = win.tabs[0].id;
  }

  state.currentPage = 1;

  // -------- 等 tab 加载完成 --------
  const loaded = await waitTabComplete(state.currentTabId, 25000);
  if (!loaded) {
    log(`  ✗ 页面加载超时`);
    await cleanupTarget();
    return;
  }

  // -------- content.js 启动延时 + 状态检测 --------
  await sleep(rand(1200, 2000));

  const stateRes = await sendToTab({ type: 'detect_state' });
  if (!stateRes || !stateRes.ok) {
    log(`  ✗ content.js 无响应,可能未匹配到 URL`);
    await cleanupTarget();
    return;
  }
  if (stateRes.state === 'need_login') {
    log(`  ✗ 未登录,请先在 zhipin.com 完成登录后重试`);
    state.shouldStop = true;
    await cleanupTarget();
    return;
  }
  if (stateRes.state === 'captcha' || stateRes.state === 'blocked') {
    log(`  ✗ 检测到 ${stateRes.state}: ${stateRes.reason},暂停本关键词`);
    await cleanupTarget();
    return;
  }

  // -------- 等首页卡片渲染 --------
  const cardsRes = await sendToTab({ type: 'wait_for_cards', timeout: 15000 });
  if (!cardsRes || !cardsRes.ok) {
    // 卡片没出来 — 可能跳到了登录页 / 风控页 / 网络异常
    // 再次确认 tab URL 是否还在搜索页
    let actualUrl = '';
    try {
      const t = await chrome.tabs.get(state.currentTabId);
      actualUrl = t.url || '';
    } catch (e) {}
    if (actualUrl && actualUrl.indexOf('/web/geek/job') === -1) {
      log(`  ✗ 页面跳转到了非搜索页 (${actualUrl.slice(0, 60)}...),可能未登录`);
      state.shouldStop = true;
    } else {
      log(`  ✗ 第 1 页卡片未渲染`);
    }
    await cleanupTarget();
    return;
  }

  // 等首页接口响应到达 (最多 8 秒)
  {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && pageResponseCounter === 0 && !riskFlag) {
      await sleep(500);
    }
    if (pageResponseCounter === 0) {
      log(`  ✗ 首页未拦截到任何接口响应,可能被风控或登录态异常`);
      await cleanupTarget();
      return;
    }
  }

  // -------- 滚动加载循环 (Boss 新版无限滚动) --------
  await sendToTab({ type: 'simulate' });
  await sleep(rand(config.dwellMin * 1000, config.dwellMax * 1000));

  let noProgressCount = 0;
  const MAX_NO_PROGRESS = 3;  // 连续 3 次滚动无新增即视为到底

  for (let round = 1; round <= config.maxScrolls; round++) {
    if (state.shouldStop || state.reachedMaxTotal) break;
    if (riskFlag) {
      log(`  ⏸ 风控触发,本关键词跳过余下滚动`);
      break;
    }
    if (!state.currentTabId) {
      log(`  ⚠ tab 已不存在,提前结束`);
      break;
    }

    state.currentPage = round + 1;
    const expectedResponses = pageResponseCounter + 1;
    const cntBefore = state.added;

    const scrollRes = await sendToTab({ type: 'scroll_load' });
    if (!scrollRes || !scrollRes.ok) {
      log(`  ⚠ ${progressLine()} 滚动失败,中止`);
      break;
    }
    log(`  ↓ ${progressLine()} 滚动加载 (卡片 ${scrollRes.before} → ${scrollRes.after})`);

    if (scrollRes.reachedEnd) {
      log(`  ✓ 页面提示已到底,结束此词`);
      break;
    }

    // 等接口响应到达
    {
      const dl = Date.now() + 8000;
      while (Date.now() < dl && pageResponseCounter < expectedResponses && !riskFlag) {
        await sleep(500);
      }
    }

    // 判断本轮是否有进展
    const newResp = pageResponseCounter >= expectedResponses;
    const newAdd  = state.added > cntBefore;
    const newCards = scrollRes.after > scrollRes.before;

    if (!newResp && !newAdd && !newCards) {
      noProgressCount++;
      log(`  · 本轮无进展 (${noProgressCount}/${MAX_NO_PROGRESS})`);
      if (noProgressCount >= MAX_NO_PROGRESS) {
        log(`  ✓ 连续 ${MAX_NO_PROGRESS} 轮无新数据,判定列表到底`);
        break;
      }
    } else {
      noProgressCount = 0;
    }

    if (riskFlag) {
      log(`  ⏸ 风控触发,停`);
      break;
    }

    // 偶尔模拟一下"阅读"行为
    if (round % 2 === 0) {
      await sendToTab({ type: 'simulate' });
    }
    await sleep(rand(config.dwellMin * 1000, config.dwellMax * 1000));
  }

  await cleanupTarget();
}

async function cleanupTarget() {
  // 可见模式: 不关 tab,让用户看到结果;只清空当前 tab 引用让下一关键词复用
  if (state.config && state.config.runMode === 'tab_visible') {
    state.currentTabId = null;
    return;
  }
  // 独立窗口模式: 关掉窗口
  if (state.currentWindowId != null) {
    const id = state.currentWindowId;
    state.currentWindowId = null;
    state.currentTabId = null;
    try {
      await chrome.windows.remove(id);
    } catch (e) {
      // 窗口可能已被手动关闭,忽略
    }
  }
}

// 拿用户当前主窗口 (普通类型,排除 popup / devtools 等)
async function getTargetNormalWindow() {
  try {
    const w = await chrome.windows.getLastFocused({
      populate: false,
      windowTypes: ['normal'],
    });
    if (w && w.id) return w;
  } catch (e) {}
  try {
    const all = await chrome.windows.getAll({
      populate: false,
      windowTypes: ['normal'],
    });
    if (all && all.length > 0) return all[0];
  } catch (e) {}
  return null;
}

async function waitTabComplete(tabId, timeout = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') return true;
    } catch (e) {
      return false;  // tab 已不存在
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function sendToTab(msg) {
  if (!state.currentTabId) return null;
  try {
    return await chrome.tabs.sendMessage(state.currentTabId, msg);
  } catch (e) {
    return null;
  }
}

// ============================================================
// 导出 CSV
// ============================================================
async function exportCsv() {
  const jobs = await getJobsMap();
  const list = Object.values(jobs);
  if (list.length === 0) throw new Error('数据池为空');

  // 按发布时间倒序导出 (没发布时间的排后面)
  list.sort((a, b) => {
    if (!a.publish_time && !b.publish_time) return 0;
    if (!a.publish_time) return 1;
    if (!b.publish_time) return -1;
    return b.publish_time.localeCompare(a.publish_time);
  });

  const cols = Object.keys(list[0]);
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [cols.join(',')];
  for (const r of list) rows.push(cols.map((c) => esc(r[c])).join(','));
  const csv = '\uFEFF' + rows.join('\n');
  const dataUrl =
    'data:text/csv;charset=utf-8;base64,' +
    btoa(unescape(encodeURIComponent(csv)));

  await chrome.downloads.download({
    url: dataUrl,
    filename: `boss_jobs_${Date.now()}.csv`,
    saveAs: true,
  });
  return list.length;
}

// ============================================================
// 导出 job-radar JSON
// ------------------------------------------------------------
// 把 Boss 的 28 字段拍扁成 run_daily.py --import 期望的 7 字段。
// jd 字段塞入经验/学历/福利/技能/HR/区域/行业/规模 等所有有信号的内容,
// LLM 打分时能拿到尽量多的上下文。
// ============================================================
async function exportJobRadarJson() {
  const jobs = await getJobsMap();
  const list = Object.values(jobs);
  if (list.length === 0) throw new Error('数据池为空');

  // 发布时间倒序 (没发布时间的排后面)
  list.sort((a, b) => {
    if (!a.publish_time && !b.publish_time) return 0;
    if (!a.publish_time) return 1;
    if (!b.publish_time) return -1;
    return b.publish_time.localeCompare(a.publish_time);
  });

  const records = list.map((r) => {
    const parts = [];
    if (r.experience) parts.push(`经验: ${r.experience}`);
    if (r.education) parts.push(`学历: ${r.education}`);
    if (r.area) parts.push(`区域: ${r.area}`);
    if (r.industry || r.financing || r.company_size) {
      const co = [r.industry, r.financing, r.company_size].filter(Boolean).join(' · ');
      parts.push(`公司: ${co}`);
    }
    if (r.skills) parts.push(`技能: ${r.skills}`);
    if (r.welfare) parts.push(`福利: ${r.welfare}`);
    if (r.hr_name) {
      const hr = [r.hr_name, r.hr_title, r.hr_active].filter(Boolean).join(' / ');
      parts.push(`HR: ${hr}`);
    }
    if (r.position_name) parts.push(`Boss 类目: ${r.position_name}`);

    return {
      title: r.job_name || '',
      company: r.company_name || '',
      city: r.city || r.search_city || '',
      salary: r.salary || '待议',
      jd: parts.join(' | '),
      url: r.job_url || '',
      source: 'boss',
    };
  });

  const today = new Date().toISOString().slice(0, 10);
  const filename = `boss_${today}.json`;
  const json = JSON.stringify(records, null, 2);
  const dataUrl =
    'data:application/json;charset=utf-8;base64,' +
    btoa(unescape(encodeURIComponent(json)));

  await chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: true,    // 让用户直接存到 ~/job-radar/data/
  });

  return { count: records.length, filename };
}

// ============================================================
// 个人画像 + API key 持久化
// ============================================================
const DEFAULT_PROFILE = {
  summary: '',
  resume_md: '',
  target_monthly_min: 30000,
  target_monthly_ideal: 40000,
  s_tier_roles: [],
  a_tier_roles: [],
  hard_reject: [],
  cities: ['上海', '杭州', '北京'],
  beijing_salary_premium: 0.10,
};
const DEFAULT_API = {
  deepseek_key: '',
  wxpusher_token: '',
  wxpusher_uid: '',
};

async function getProfile() {
  const r = await chrome.storage.local.get('profile');
  return { ...DEFAULT_PROFILE, ...(r.profile || {}) };
}
async function setProfile(p) {
  await chrome.storage.local.set({ profile: { ...DEFAULT_PROFILE, ...p } });
}
async function getApiConfig() {
  const r = await chrome.storage.local.get('apiConfig');
  return { ...DEFAULT_API, ...(r.apiConfig || {}) };
}
async function setApiConfig(c) {
  await chrome.storage.local.set({ apiConfig: { ...DEFAULT_API, ...c } });
}

// ============================================================
// AI 打分 — DeepSeek (port from src/job_radar/score.py)
// ============================================================
const VALID_PRIORITIES = new Set(['S', 'A', 'B', 'C', 'Reject']);

function jobToScoreInput(item) {
  // 把数据池里的 normalize() 输出拍扁成 score.py 期望的 Job
  const parts = [];
  if (item.experience) parts.push(`经验: ${item.experience}`);
  if (item.education) parts.push(`学历: ${item.education}`);
  if (item.area) parts.push(`区域: ${item.area}`);
  if (item.industry || item.financing || item.company_size) {
    const co = [item.industry, item.financing, item.company_size].filter(Boolean).join(' · ');
    parts.push(`公司: ${co}`);
  }
  if (item.skills) parts.push(`技能: ${item.skills}`);
  if (item.welfare) parts.push(`福利: ${item.welfare}`);
  if (item.hr_name) {
    const hr = [item.hr_name, item.hr_title, item.hr_active].filter(Boolean).join(' / ');
    parts.push(`HR: ${hr}`);
  }
  if (item.position_name) parts.push(`Boss 类目: ${item.position_name}`);
  return {
    title: item.job_name || '',
    company: item.company_name || '',
    city: item.city || item.search_city || '',
    salary: item.salary || '待议',
    jd: parts.join(' | '),
    url: item.job_url || '',
  };
}

function hitsHardReject(job, profile) {
  const blob = `${job.title} ${job.jd}`.toLowerCase();
  for (const kw of profile.hard_reject || []) {
    if (kw && blob.indexOf(kw.toLowerCase()) !== -1) return kw;
  }
  return null;
}

function buildScoringMessages(job, profile) {
  const premium = parseFloat(profile.beijing_salary_premium || 0.10);
  const sys =
    '你是资深求职顾问,为候选人筛选岗位。严格输出 JSON,不要 markdown 代码块。' +
    '字段: score(0-100 整数), priority(S/A/B/C/Reject 之一), reason(一句中文), ' +
    'concerns(string 数组), resume_version(AI_SOLUTION/AI_CUSTOMER/IAM_AI/LLM_APP 之一或空字符串), ' +
    'pitch(一句招呼语)。';

  const resumeSection = profile.resume_md
    ? `\n\n## 候选人完整简历(权威信息源,以下与 summary 冲突时以此为准)\n${profile.resume_md}\n`
    : '';

  const user = `## 候选人 summary
${(profile.summary || '').trim()}
${resumeSection}
目标月薪:最低 ${profile.target_monthly_min},理想 ${profile.target_monthly_ideal}。
S 级目标岗位:${JSON.stringify(profile.s_tier_roles || [])}
A 级目标岗位:${JSON.stringify(profile.a_tier_roles || [])}

## 岗位
公司:${job.company}
标题:${job.title}
城市:${job.city}
薪资:${job.salary}
JD:
${job.jd}

## 评分规则
0-100 分,权重:
- role_fit 30%(命中 S 级 → 满档加分;A 级 → 加分;纯算法/外包/培训类 → 大扣分)
- compensation_fit 25%(月薪低于 ${Math.round((profile.target_monthly_min || 30000) * 0.93 / 1000)}K 大扣分;${Math.round((profile.target_monthly_ideal || 40000) / 1000)}K+ 满分)
- experience_fit 20%(1-3 年或 2-5 年加分;明确 5 年以上要求 → 扣分)
- tech_stack_fit 15%(LLM/RAG/Agent/Azure/Entra ID/FastAPI 加分)
- company_quality 10%(大厂/独角兽/外资加分;小公司无融资减分)

分档:S ≥ 90, A ≥ 70, B ≥ 55, C ≥ 40, Reject < 40。

## 北京软提示规则(重要)
若岗位城市是"北京",并且薪资相比上海/杭州同档同类岗位**高出比例不足 ${Math.round(premium * 100)}%**,
在 concerns 里追加一条:"北京无户口,薪资溢价不足(${Math.round(premium * 100)}%)"。
这只是软提示——**不要**因此把 priority 设为 Reject,也**不要**额外扣大分;仅在 concerns 里注明即可。

## 输出
仅输出严格 JSON 对象,不要任何解释、不要 markdown 包裹。`;

  return [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ];
}

function parseScoreReply(raw) {
  if (!raw) return { score: 0, priority: 'C', reason: 'LLM 返回为空', concerns: ['LLM 返回为空'] };
  let text = raw.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  }
  try {
    const data = JSON.parse(text);
    let priority = String(data.priority || 'C').trim();
    if (!VALID_PRIORITIES.has(priority)) priority = 'C';
    return {
      score: parseInt(data.score) || 0,
      priority,
      reason: String(data.reason || '').trim() || '(无理由)',
      concerns: Array.isArray(data.concerns) ? data.concerns.map(String).filter(Boolean) : [],
      resume_version: String(data.resume_version || '').trim(),
      pitch: String(data.pitch || '').trim(),
    };
  } catch (e) {
    return { score: 0, priority: 'C', reason: 'LLM JSON 解析失败', concerns: ['LLM JSON 解析失败'] };
  }
}

async function callDeepseek(messages, apiKey, retries = 2) {
  let lastErr = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const resp = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages,
          response_format: { type: 'json_object' },
          temperature: 0.2,
        }),
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      }
      const data = await resp.json();
      return data?.choices?.[0]?.message?.content || null;
    } catch (e) {
      lastErr = e;
      if (attempt < retries - 1) await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw lastErr;
}

// Semaphore=3 并发限流
async function withConcurrency(tasks, limit) {
  const results = new Array(tasks.length);
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= tasks.length) return;
      try {
        results[i] = await tasks[i]();
      } catch (e) {
        results[i] = { __err: e };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

async function scoreAllUnscored() {
  const profile = await getProfile();
  const api = await getApiConfig();
  if (!api.deepseek_key) throw new Error('未配置 DeepSeek API key,先去「个人画像」标签填');

  const jobsMap = await getJobsMap();
  const allKeys = Object.keys(jobsMap);
  const targetKeys = allKeys.filter((k) => !jobsMap[k].score_priority);
  if (targetKeys.length === 0) return { scored: 0, skipped: allKeys.length };

  let progress = 0;
  log(`▶ 开始打分: ${targetKeys.length} 条未打分(共 ${allKeys.length})`);

  const tasks = targetKeys.map((k) => async () => {
    const item = jobsMap[k];
    const job = jobToScoreInput(item);
    // hard reject 本地判断,不调 API
    const hit = hitsHardReject(job, profile);
    if (hit) {
      item.score = 0;
      item.score_priority = 'Reject';
      item.score_reason = `命中 hard_reject 关键词: ${hit}`;
      item.score_concerns = [`hard_reject: ${hit}`];
      item.score_pitch = '';
    } else {
      const raw = await callDeepseek(buildScoringMessages(job, profile), api.deepseek_key);
      const r = parseScoreReply(raw);
      item.score = r.score;
      item.score_priority = r.priority;
      item.score_reason = r.reason;
      item.score_concerns = r.concerns;
      item.score_pitch = r.pitch || '';
      item.score_resume_version = r.resume_version || '';
    }
    progress++;
    chrome.runtime.sendMessage({
      type: 'score_progress',
      done: progress,
      total: targetKeys.length,
    }).catch(() => {});
    return true;
  });

  await withConcurrency(tasks, 3);
  await setJobsMap(jobsMap);
  log(`✓ 打分完成: 新增 ${targetKeys.length} 条`);
  return { scored: targetKeys.length, skipped: allKeys.length - targetKeys.length };
}

// ============================================================
// 推送 — WxPusher (port from src/job_radar/{report,push}.py)
// ============================================================
function buildCompactReport(scoredItems, dateStr) {
  const byPrio = { S: [], A: [], B: [], C: [], Reject: [] };
  for (const it of scoredItems) {
    const p = it.score_priority || 'C';
    (byPrio[p] || byPrio.C).push(it);
  }
  for (const k of Object.keys(byPrio)) {
    byPrio[k].sort((a, b) => (b.score || 0) - (a.score || 0));
  }
  const total = scoredItems.length;
  const counts = {
    S: byPrio.S.length,
    A: byPrio.A.length,
    B: byPrio.B.length,
    C: byPrio.C.length,
    Reject: byPrio.Reject.length,
  };

  const lines = [
    `## 🎯 Boss 求职雷达 ${dateStr}`,
    `> 共 ${total} | S=${counts.S} | A=${counts.A} | B=${counts.B} | C=${counts.C} | R=${counts.Reject}`,
    '',
  ];

  const emit = (prio, label) => {
    const items = byPrio[prio] || [];
    if (items.length === 0) return;
    lines.push(`### ${label} (${items.length})`);
    for (const it of items) {
      lines.push(`[${it.score || 0}] ${it.job_name} — ${it.salary || '待议'} — ${it.city || it.search_city || ''}`);
      if (it.job_url) lines.push(it.job_url);
      lines.push('');
    }
  };
  emit('S', '🌟 S');
  emit('A', '🟢 A');
  emit('B', '🟡 B');

  return {
    md: lines.join('\n').replace(/\s+$/, '') + '\n',
    counts,
  };
}

async function pushWxPusher(md, summary, apiToken, uid) {
  const MAX_CONTENT = 10000;
  const content = md.length <= MAX_CONTENT
    ? md
    : md.slice(0, MAX_CONTENT - 20) + '\n\n…(已截断)';
  const resp = await fetch('https://wxpusher.zjiecode.com/api/send/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      appToken: apiToken,
      content,
      contentType: 3,  // markdown
      summary: summary.slice(0, 100),
      uids: [uid],
    }),
  });
  if (!resp.ok) {
    throw new Error(`WxPusher HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  const data = await resp.json();
  if (!data.success) {
    throw new Error(`WxPusher 失败: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data;
}

async function pushNow() {
  const api = await getApiConfig();
  if (!api.wxpusher_token || !api.wxpusher_uid) {
    throw new Error('未配置 WxPusher,先去「个人画像」标签填');
  }
  const jobsMap = await getJobsMap();
  const items = Object.values(jobsMap).filter((j) => j.score_priority);
  if (items.length === 0) throw new Error('没有已打分的岗位,请先点「全部打分」');

  const today = new Date().toISOString().slice(0, 10);
  const { md, counts } = buildCompactReport(items, today);
  const summary = `Boss 雷达 ${today} | ${counts.S} S / ${counts.A} A`;
  await pushWxPusher(md, summary, api.wxpusher_token, api.wxpusher_uid);
  log(`✓ WxPusher 推送成功: ${summary}`);
  return { total: items.length, counts };
}
