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

// 一键流水线状态
const pipelineState = {
  stage: 'idle',     // idle | crawling | scoring | pushing | done | error
  startedAt: null,
  progress: '',
  error: '',
  shouldStop: false,
  // 细化进度(popup 拉取后可显示丰富的当前状态)
  substep: '',                              // 一句话当前在做什么
  stageStartedAt: null,                     // 当前 stage 开始时间(算 ETA)
  crawl: { tasksDone: 0, tasksTotal: 0, jobsAdded: 0, currentTask: '' },
  score: { done: 0, total: 0 },
  push: { tier: '', sent: 0 },
};

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
  // 持久化到 storage,popup 重开能 replay
  persistLog(msg).catch(() => {});
}

const LOG_KEEP = 200;
let _logBuffer = null;  // in-memory cache, lazy load
async function persistLog(msg) {
  if (_logBuffer === null) {
    _logBuffer = (await chrome.storage.local.get('runLog')).runLog || [];
  }
  const entry = { ts: Date.now(), msg };
  _logBuffer.push(entry);
  if (_logBuffer.length > LOG_KEEP) _logBuffer.splice(0, _logBuffer.length - LOG_KEEP);
  // 节流写入: 每 ~500ms 批量落盘
  if (!persistLog._flushScheduled) {
    persistLog._flushScheduled = true;
    setTimeout(async () => {
      persistLog._flushScheduled = false;
      try { await chrome.storage.local.set({ runLog: _logBuffer }); } catch (e) {}
    }, 500);
  }
}
async function getPersistedLog() {
  if (_logBuffer !== null) return _logBuffer;
  return (await chrome.storage.local.get('runLog')).runLog || [];
}
async function clearPersistedLog() {
  _logBuffer = [];
  await chrome.storage.local.remove('runLog');
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

// SW 保活: 30 秒周期 + 每日定时检查
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.create('daily-auto-pipeline', { periodInMinutes: 30 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'keepalive') return; // noop,只为保活
  if (alarm.name === 'daily-auto-pipeline') {
    try { await maybeAutoFire(); } catch (e) { console.warn('[daily auto]', e); }
  }
});

// 每 30 分钟检查一次:今天 ≥ 09:00 且还没自动跑过 → 自动 fire 流水线
async function maybeAutoFire() {
  const settings = (await chrome.storage.local.get('autoDaily')).autoDaily;
  if (!settings || !settings.enabled) return;

  const now = new Date();
  const targetHour = typeof settings.hour === 'number' ? settings.hour : 9;
  if (now.getHours() < targetHour) return;

  const today = now.toISOString().slice(0, 10);
  const meta = (await chrome.storage.local.get('autoDailyMeta')).autoDailyMeta || {};
  if (meta.lastRunDate === today) return;

  if (pipelineState.stage === 'crawling' ||
      pipelineState.stage === 'scoring' ||
      pipelineState.stage === 'pushing') return;
  if (state.running) return;

  const pc = (await chrome.storage.local.get('pendingConfig')).pendingConfig;
  if (!pc || !pc.tasks || pc.tasks.length === 0) {
    log('⚠ 每日自动跑跳过:还没生成搜索队列,先到「搜索」tab 生成一次');
    // 不设 lastRunDate,避免锁住后续日子
    return;
  }

  log(`▶ 每日自动 fire (${today} ${now.toTimeString().slice(0, 5)})`);
  await chrome.storage.local.set({ autoDailyMeta: { ...meta, lastRunDate: today } });
  // 重置队列状态(让 startCrawl 从 pending 状态开始)
  await chrome.storage.local.remove('taskQueue');
  runPipeline({ ...pc, resume: false }).catch((e) => log(`✗ 自动跑失败: ${e.message}`));
}

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
        await handleIntercepted(msg.data, msg.url);
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
          items.sort((a, b) => {
            const sa = a.score_priority ? (a.score || 0) : -1;
            const sb = b.score_priority ? (b.score || 0) : -1;
            return sb - sa;
          });
          sendResponse({ ok: true, items });
          break;
        }
        case 'get_log':
          sendResponse({ ok: true, log: await getPersistedLog() });
          break;
        case 'clear_log':
          await clearPersistedLog();
          sendResponse({ ok: true });
          break;
        case 'pipeline_status': {
          sendResponse({
            ok: true,
            pipeline: pipelineState,
            crawl: {
              running: state.running,
              progress: state.running ? {
                ki: state.currentKeywordIdx,
                kt: state.currentKeywordTotal,
                p: state.currentPage,
                added: state.added,
              } : null,
            },
          });
          break;
        }
        case 'run_pipeline':
          try {
            await runPipeline(msg.config);
            sendResponse({ ok: true });
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          }
          break;
        case 'stop_pipeline':
          pipelineState.shouldStop = true;
          sendResponse({ ok: true });
          break;
        case 'list_presets':
          sendResponse({ ok: true, presets: await getPresets() });
          break;
        case 'save_preset': {
          const ps = await getPresets();
          ps[msg.name] = msg.config;
          await chrome.storage.local.set({ presets: ps });
          sendResponse({ ok: true });
          break;
        }
        case 'load_preset': {
          const ps = await getPresets();
          if (!ps[msg.name]) { sendResponse({ ok: false, error: '预设不存在' }); break; }
          sendResponse({ ok: true, config: ps[msg.name] });
          break;
        }
        case 'delete_preset': {
          const ps = await getPresets();
          delete ps[msg.name];
          await chrome.storage.local.set({ presets: ps });
          sendResponse({ ok: true });
          break;
        }
        case 'mark_job': {
          const jobsMap = await getJobsMap();
          const item = jobsMap[msg.job_id];
          if (!item) { sendResponse({ ok: false, error: '岗位不存在' }); break; }
          if (msg.mark === null) {
            delete item.marked;
          } else {
            item.marked = msg.mark;
          }
          if (msg.block_company && item.company_id) {
            const blk = await getBlocked();
            blk[item.company_id] = { company_name: item.company_name, ts: Date.now() };
            await chrome.storage.local.set({ blockedCompanies: blk });
            // 顺手把数据池里这家公司其他岗位也标 not_interested
            for (const k of Object.keys(jobsMap)) {
              if (jobsMap[k].company_id === item.company_id) jobsMap[k].marked = 'not_interested';
            }
          }
          await setJobsMap(jobsMap);
          sendResponse({ ok: true });
          break;
        }
        case 'list_blocked': {
          const blk = await getBlocked();
          const arr = Object.entries(blk).map(([cid, v]) => ({ company_id: cid, company_name: v.company_name }));
          sendResponse({ ok: true, blocked: arr });
          break;
        }
        case 'unblock_company': {
          const blk = await getBlocked();
          delete blk[msg.company_id];
          await chrome.storage.local.set({ blockedCompanies: blk });
          // 同时把数据池里该公司的 not_interested 标记清掉
          const jobsMap = await getJobsMap();
          for (const k of Object.keys(jobsMap)) {
            if (jobsMap[k].company_id === msg.company_id && jobsMap[k].marked === 'not_interested') {
              delete jobsMap[k].marked;
            }
          }
          await setJobsMap(jobsMap);
          sendResponse({ ok: true });
          break;
        }
        case 'list_history':
          sendResponse({ ok: true, history: await getHistory() });
          break;
        case 'clear_history':
          await chrome.storage.local.remove('history');
          sendResponse({ ok: true });
          break;
        case 'test_llm': {
          try {
            const providerKey = msg.provider;
            const providerConfig = msg.providerConfig || {};
            const messages = [
              { role: 'user', content: '请回复一个最简 JSON 对象: {"status":"ok"}' },
            ];
            const t0 = Date.now();
            const raw = await callLLM(messages, providerKey, providerConfig);
            const ms = Date.now() - t0;
            if (!raw) {
              sendResponse({ ok: false, error: 'LLM 返回为空' });
            } else {
              sendResponse({
                ok: true,
                latency_ms: ms,
                sample: raw.slice(0, 200),
              });
            }
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          }
          break;
        }
        case 'list_providers': {
          const out = {};
          for (const [k, v] of Object.entries(PROVIDERS)) {
            out[k] = {
              name: v.name,
              default_model: v.default_model,
              base_url: v.base_url,
              models: v.models || [],
              note: v.note || '',
            };
          }
          sendResponse({ ok: true, providers: out });
          break;
        }
        case 'get_auto_daily': {
          const s = (await chrome.storage.local.get('autoDaily')).autoDaily || { enabled: false, hour: 9 };
          sendResponse({ ok: true, autoDaily: s });
          break;
        }
        case 'save_auto_daily':
          await chrome.storage.local.set({ autoDaily: msg.autoDaily });
          sendResponse({ ok: true });
          break;
        case 'clear_scores': {
          const jobsMap = await getJobsMap();
          for (const k of Object.keys(jobsMap)) {
            delete jobsMap[k].score;
            delete jobsMap[k].score_priority;
            delete jobsMap[k].score_reason;
            delete jobsMap[k].score_concerns;
            delete jobsMap[k].score_pitch;
            delete jobsMap[k].score_resume_version;
          }
          await setJobsMap(jobsMap);
          sendResponse({ ok: true });
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

async function handleIntercepted(payload, url) {
  if (!payload) return;

  // 详情响应路由 ─ 走专门的 handler,不计入 pageResponseCounter
  if (url && url.indexOf('/job/detail.json') !== -1) {
    await handleDetailIntercepted(payload);
    return;
  }

  if (!pendingContext) return;
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
  // 屏蔽公司(company_id 黑名单)
  const blocked = await getBlocked();

  const jobs = await getJobsMap();
  let added = 0;
  let filtered = 0;
  let blockedCount = 0;
  for (const raw of list) {
    const item = normalize(raw, pendingContext);
    if (!item.job_id || jobs[item.job_id]) continue;
    if (item.company_id && blocked[item.company_id]) { blockedCount++; continue; }
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
  const blk = blockedCount > 0 ? ` 屏蔽 -${blockedCount}` : '';
  log(`  ✓ ${progressLine()} 捕获 ${list.length} 条,新增 ${added}${flt}${blk} (累计 ${state.added})`);

  if (state.config.maxTotal > 0 && state.added >= state.config.maxTotal) {
    state.reachedMaxTotal = true;
    log(`  ★ 达到总条数上限 ${state.config.maxTotal},准备结束`);
  }
}

// ============================================================
// 详情拦截 + waiter
// ============================================================
// 改为 by-job-id 的 resolver map,避免单 global 错配:
// 如果点了 A 卡晚到的 detail 在点 B 卡之后才到,以前会把 A 的数据填到 B 的 waiter。
const pendingDetailResolvers = new Map();  // job_id → { resolve, timer }
// 无 expected_id 时的兜底:用 fallback queue,先到先服务
const pendingDetailFallback = [];

function waitForNextDetail(timeoutMs = 12000, expectedJobId = '') {
  return new Promise((resolve) => {
    let done = false;
    const finish = (data) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (expectedJobId) pendingDetailResolvers.delete(expectedJobId);
      else {
        const idx = pendingDetailFallback.indexOf(entry);
        if (idx !== -1) pendingDetailFallback.splice(idx, 1);
      }
      resolve(data);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const entry = { resolve: finish };
    if (expectedJobId) {
      pendingDetailResolvers.set(expectedJobId, entry);
    } else {
      pendingDetailFallback.push(entry);
    }
  });
}

async function handleDetailIntercepted(payload) {
  if (!payload) return;
  // 风控信号
  if (payload.code !== 0) {
    // 风控对所有挂着的 waiter 都广播
    pendingDetailResolvers.forEach((e) => e.resolve({ __riskCode: payload.code }));
    pendingDetailResolvers.clear();
    pendingDetailFallback.forEach((e) => e.resolve({ __riskCode: payload.code }));
    pendingDetailFallback.length = 0;
    riskFlag = true;
    return;
  }
  const info = payload.zpData && payload.zpData.jobInfo;
  if (!info) return;
  const jid = info.encryptId || info.encryptJobId || info.jobId;
  // 优先匹配 by-id
  if (jid && pendingDetailResolvers.has(jid)) {
    pendingDetailResolvers.get(jid).resolve(info);
  } else if (pendingDetailFallback.length > 0) {
    // 兜底:先到先服务
    pendingDetailFallback.shift().resolve(info);
  }
  // 同时直接 merge 到 jobsMap(以防 waiter 没接到)
  const jobs = await getJobsMap();
  if (jid && jobs[jid]) {
    mergeDetailIntoJob(jobs[jid], info);
    await setJobsMap(jobs);
  }
}

function mergeDetailIntoJob(item, info) {
  // 详情字段拍扁,补到列表条目里
  if (info.postDescription) item.full_jd = info.postDescription;
  if (info.responsibility)  item.responsibility = info.responsibility;
  if (info.qualifications)  item.qualifications = info.qualifications;
  if (Array.isArray(info.skillsLabels)) item.skills = info.skillsLabels.join(',');
  if (Array.isArray(info.welfareList))  item.welfare = info.welfareList.join(',');
  if (info.brandInfo) {
    if (info.brandInfo.brandIndustry  && !item.industry)     item.industry = info.brandInfo.brandIndustry;
    if (info.brandInfo.brandScaleName && !item.company_size) item.company_size = info.brandInfo.brandScaleName;
    if (info.brandInfo.brandStageName && !item.financing)    item.financing = info.brandInfo.brandStageName;
  }
  if (info.bossInfo) {
    if (info.bossInfo.bossName  && !item.hr_name)  item.hr_name  = info.bossInfo.bossName;
    if (info.bossInfo.bossTitle && !item.hr_title) item.hr_title = info.bossInfo.bossTitle;
  }
  item.has_detail = true;
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

      // 更新 pipeline 细化进度
      pipelineState.crawl.tasksDone = ti;
      pipelineState.crawl.tasksTotal = q.tasks.length;
      pipelineState.crawl.currentTask = `${t.positionName} @ ${t.cityName}`;
      pipelineState.substep = `采集 [${ti + 1}/${q.tasks.length}] ${t.positionName} @ ${t.cityName}`;

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
      pipelineState.crawl.jobsAdded = state.added;

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

  // ─── 深度抓取阶段(点开每张卡拿完整 JD)
  if (config.deepCrawl && !riskFlag && !state.shouldStop && !state.reachedMaxTotal) {
    await fetchDetailsForCurrentList(config);
  }

  await cleanupTarget();
}

async function fetchDetailsForCurrentList(config) {
  if (!state.currentTabId) return;
  const r = await sendToTab({ type: 'list_card_ids' });
  if (!r || !r.ok || !r.cards) {
    log(`  ⚠ 详情:列不出卡片`);
    return;
  }
  const jobsMap = await getJobsMap();
  // 只对当前列表里、在我们数据池存在且还没 detail 的卡片做
  const toFetch = r.cards.filter((c) => c.job_id && jobsMap[c.job_id] && !jobsMap[c.job_id].has_detail);
  if (toFetch.length === 0) {
    log(`  · 详情:无需补抓(全已有)`);
    return;
  }
  log(`  ↓ 详情:点开 ${toFetch.length}/${r.cards.length} 张卡补抓完整 JD`);

  const detailDwellMin = (config.dwellMin || 2) * 0.7;
  const detailDwellMax = (config.dwellMax || 5) * 0.8;
  let ok = 0;
  let timeout = 0;
  let riskInDetail = 0;
  for (let i = 0; i < toFetch.length; i++) {
    if (state.shouldStop || riskFlag || state.reachedMaxTotal) break;
    if (!state.currentTabId) break;

    const c = toFetch[i];
    // 传 expected job_id 让 waiter 精确匹配,避免上一张卡的延迟响应错配到本卡
    const waiterPromise = waitForNextDetail(12000, c.job_id || '');
    const clickRes = await sendToTab({ type: 'click_card', index: c.index });
    if (!clickRes || !clickRes.ok) {
      // 卡可能因滚动被换位置 — 不致命,跳过
      continue;
    }
    const result = await waiterPromise;
    if (result === null) {
      timeout++;
      continue;
    }
    if (result && result.__riskCode !== undefined) {
      riskInDetail++;
      log(`  ⚠ 详情:风控 code=${result.__riskCode} 中断`);
      break;
    }
    ok++;
    // small pause between clicks(模拟阅读)
    await sleep(rand(detailDwellMin * 1000, detailDwellMax * 1000));

    // 每 10 条进度
    if ((i + 1) % 10 === 0) {
      log(`  · 详情进度 ${i + 1}/${toFetch.length}(成功 ${ok})`);
    }
  }
  const fail = toFetch.length - ok;
  log(`  ✓ 详情:成功 ${ok} / 超时 ${timeout} / 风控中断 ${riskInDetail} / 共 ${toFetch.length}`);
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
  target_monthly_max: 50000,
  target_annual: 500000,
  beijing_salary_premium: 0.10,
  // 偏好权重(1-5 颗星,5 = 最看重)
  // 注:role_fit 不在用户控制范围 — 系统默认按 LLM 判断的"对口度"满档加权
  priorities: {
    salary: 3,
    brand: 3,
    no_overtime: 3,
    stability: 3,
    commute: 3,
    tech_fit: 3,
  },
  home_district: '',
  other_prefs: '',
};

// LLM provider 配置表
// models: { id, label } — label 含「推荐」/「快」/「贵」等线索
const PROVIDERS = {
  deepseek: {
    name: 'DeepSeek',
    base_url: 'https://api.deepseek.com',
    protocol: 'openai',
    default_model: 'deepseek-chat',
    models: [
      { id: 'deepseek-chat',     label: 'deepseek-chat — 推荐 (最新 V3.x,性价比)' },
      { id: 'deepseek-reasoner', label: 'deepseek-reasoner — 推理增强 (慢 + 贵 3-8x)' },
    ],
  },
  qwen: {
    name: '通义千问',
    base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    protocol: 'openai',
    default_model: 'qwen3.6-plus',
    models: [
      { id: 'qwen3.6-plus',  label: 'qwen3.6-plus — 推荐 (2026 最新 plus)' },
      { id: 'qwen3-max',     label: 'qwen3-max — 旗舰' },
      { id: 'qwen3.6-flash', label: 'qwen3.6-flash — 极速,便宜' },
      { id: 'qwen-plus',     label: 'qwen-plus — 老牌稳定' },
      { id: 'qwen-turbo',    label: 'qwen-turbo — 最便宜' },
    ],
  },
  doubao: {
    name: '豆包 (火山方舟)',
    base_url: 'https://ark.cn-beijing.volces.com/api/v3',
    protocol: 'openai',
    default_model: 'doubao-1-5-pro-32k-250115',
    models: [
      { id: 'doubao-1-5-pro-32k-250115',     label: 'doubao-1.5-pro-32k — 推荐 (平衡)' },
      { id: 'doubao-1-5-pro-256k-250115',    label: 'doubao-1.5-pro-256k — 长上下文' },
      { id: 'doubao-1-5-thinking-pro',       label: 'doubao-1.5-thinking-pro — 推理增强' },
      { id: 'doubao-1-5-lite-32k-250115',    label: 'doubao-1.5-lite-32k — 轻量便宜' },
    ],
    note: '需要 endpoint id (ep-xxx) 时选「其他」手填',
  },
  minimax: {
    name: 'MiniMax',
    base_url: 'https://api.minimax.chat/v1',
    protocol: 'openai',
    default_model: 'MiniMax-M2.7',
    models: [
      { id: 'MiniMax-M2.7',            label: 'MiniMax-M2.7 — 推荐 (2026 SOTA)' },
      { id: 'MiniMax-M2.7-highspeed',  label: 'MiniMax-M2.7-highspeed — 加速版' },
      { id: 'MiniMax-M2.5',            label: 'MiniMax-M2.5 — 上一代' },
      { id: 'MiniMax-M1',              label: 'MiniMax-M1 — 长上下文 1M' },
      { id: 'abab6.5s-chat',           label: 'abab6.5s-chat — 老牌稳定' },
    ],
  },
  zhipu: {
    name: '智谱 GLM',
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    protocol: 'openai',
    default_model: 'glm-4.6',
    models: [
      { id: 'glm-4.6',      label: 'glm-4.6 — 推荐 (稳定生产)' },
      { id: 'glm-5',        label: 'glm-5 — 最新旗舰' },
      { id: 'glm-4.5',      label: 'glm-4.5 — 上一代' },
      { id: 'glm-4.5-air',  label: 'glm-4.5-air — 轻量' },
      { id: 'glm-4-flash',  label: 'glm-4-flash — 极速 (有免费额度)' },
    ],
  },
  openai: {
    name: 'OpenAI GPT',
    base_url: 'https://api.openai.com/v1',
    protocol: 'openai',
    default_model: 'gpt-5.4-mini',
    models: [
      { id: 'gpt-5.4-mini',  label: 'gpt-5.4-mini — 推荐 (性价比)' },
      { id: 'gpt-5.5',       label: 'gpt-5.5 — 2026 旗舰' },
      { id: 'gpt-5.4',       label: 'gpt-5.4 — 上一代旗舰' },
      { id: 'gpt-5.4-nano',  label: 'gpt-5.4-nano — 最便宜' },
    ],
  },
  anthropic: {
    name: 'Claude',
    base_url: 'https://api.anthropic.com/v1',
    protocol: 'anthropic',
    default_model: 'claude-sonnet-4-6',
    models: [
      { id: 'claude-sonnet-4-6',   label: 'claude-sonnet-4-6 — 推荐 (1M context)' },
      { id: 'claude-opus-4-7',     label: 'claude-opus-4-7 — 最强 (贵)' },
      { id: 'claude-haiku-4-5',    label: 'claude-haiku-4-5 — 快且便宜' },
      { id: 'claude-sonnet-4-5',   label: 'claude-sonnet-4-5 — 上一代 sonnet' },
    ],
  },
};

const DEFAULT_API = {
  provider: 'deepseek',
  providers: {
    deepseek:  { api_key: '', model: '', base_url: '' },
    qwen:      { api_key: '', model: '', base_url: '' },
    doubao:    { api_key: '', model: '', base_url: '' },
    minimax:   { api_key: '', model: '', base_url: '' },
    zhipu:     { api_key: '', model: '', base_url: '' },
    openai:    { api_key: '', model: '', base_url: '' },
    anthropic: { api_key: '', model: '', base_url: '' },
  },
  wxpusher_token: '',
  wxpusher_uid: '',
};

async function getProfile() {
  const r = await chrome.storage.local.get('profile');
  const raw = r.profile || {};

  // 迁移:target_monthly_ideal → target_monthly_max (旧字段名)
  if (raw.target_monthly_ideal && !raw.target_monthly_max) {
    raw.target_monthly_max = raw.target_monthly_ideal;
    delete raw.target_monthly_ideal;
  }
  // 旧 priorities 含 role_fit 的清掉(由系统默认满档,不暴露)
  if (raw.priorities && 'role_fit' in raw.priorities) {
    delete raw.priorities.role_fit;
  }
  // 旧 cities 字段不再用(画像里的城市无用,实际由搜索 tab 决定)
  if ('cities' in raw) delete raw.cities;
  // 旧 s_tier_roles / a_tier_roles 字段不再使用,但保留在 storage 不动(LLM prompt 不再读)
  return {
    ...DEFAULT_PROFILE,
    ...raw,
    priorities: { ...DEFAULT_PROFILE.priorities, ...(raw.priorities || {}) },
  };
}
async function setProfile(p) {
  await chrome.storage.local.set({
    profile: {
      ...DEFAULT_PROFILE,
      ...p,
      priorities: { ...DEFAULT_PROFILE.priorities, ...(p.priorities || {}) },
    },
  });
}

async function getApiConfig() {
  const r = await chrome.storage.local.get('apiConfig');
  const raw = r.apiConfig || {};

  // 旧版迁移:flat deepseek_key → providers.deepseek.api_key
  if (raw.deepseek_key && !raw.providers) {
    raw.providers = {
      deepseek: { api_key: raw.deepseek_key, model: '', base_url: '' },
    };
    raw.provider = raw.provider || 'deepseek';
    delete raw.deepseek_key;
  }

  return {
    ...DEFAULT_API,
    ...raw,
    providers: { ...DEFAULT_API.providers, ...(raw.providers || {}) },
  };
}
async function setApiConfig(c) {
  const next = {
    ...DEFAULT_API,
    ...c,
    providers: { ...DEFAULT_API.providers, ...(c.providers || {}) },
  };
  // 老字段抹掉
  delete next.deepseek_key;
  await chrome.storage.local.set({ apiConfig: next });
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
  // 拼上完整 JD(深度抓取的成果)
  let jdBody = parts.join(' | ');
  if (item.full_jd) {
    jdBody += `\n\n=== 完整 JD ===\n${item.full_jd}`;
    if (item.responsibility) jdBody += `\n\n岗位职责:\n${item.responsibility}`;
    if (item.qualifications) jdBody += `\n\n任职要求:\n${item.qualifications}`;
  }
  return {
    title: item.job_name || '',
    company: item.company_name || '',
    city: item.city || item.search_city || '',
    salary: item.salary || '待议',
    jd: jdBody,
    url: item.job_url || '',
    search_intent: item.position_name || '',  // 用户搜索这个岗位时用的关键词
  };
}

function buildScoringMessages(job, profile) {
  const premium = parseFloat(profile.beijing_salary_premium || 0.10);
  const prios = profile.priorities || {};
  const star = (k, def) => (typeof prios[k] === 'number' ? prios[k] : def);

  const sys =
    '你是资深求职顾问,综合用户偏好为候选人筛选岗位。严格输出 JSON,不要 markdown 代码块。' +
    '字段: score(0-100 整数), priority(S/A/B/C/Reject 之一), reason(一句中文,说明给这分的核心原因), ' +
    'concerns(string 数组,具体担忧如"加班风险高""通勤过远 1 小时+""薪资低于期望"), ' +
    'resume_version(AI_SOLUTION/AI_CUSTOMER/IAM_AI/LLM_APP 之一或空字符串), ' +
    'pitch(一句招呼语,用于投递时主动开口)。';

  const resumeSection = profile.resume_md
    ? `\n## 候选人完整简历(技术栈 / 年限 / 项目经验全部从这里读)\n${profile.resume_md}\n`
    : '';

  const homeLine = profile.home_district ? `候选人住址: ${profile.home_district}` : '候选人未填住址(通勤维度按默认权重处理)';

  const user = `## 候选人需求(用户自己说的话,综合体现意图和偏好)
${(profile.summary || '').trim() || '(候选人未明确说,按简历 + 偏好权重判断)'}
${resumeSection}
薪资期望:
- 月薪 ${Math.round(profile.target_monthly_min / 1000)}K - ${Math.round(profile.target_monthly_max / 1000)}K
- 年包目标 ${Math.round(profile.target_annual / 1000)}K (含底薪+奖金+股票/期权)

## 候选人偏好权重(1-5 颗星,5 = 最看重)
- 薪资 (compensation): ${star('salary', 3)}/5
- 大厂背景 (brand): ${star('brand', 3)}/5
- 不加班 / work-life: ${star('no_overtime', 3)}/5
- 公司稳定: ${star('stability', 3)}/5
- 通勤距离: ${star('commute', 3)}/5
- 技术栈契合: ${star('tech_fit', 3)}/5

${homeLine}
其他偏好(自由文本,可能含硬性规则): ${(profile.other_prefs || '').trim() || '(无)'}

## 岗位
公司:${job.company}
标题:${job.title}
城市:${job.city}
薪资:${job.salary}
${job.search_intent ? `用户搜索意图(本岗是用 "${job.search_intent}" 搜出来的): ${job.search_intent}` : ''}
JD/字段:
${job.jd}

## 评分规则
0-100 分。**你需要自己从「候选人需求」和「完整简历」推断哪类岗位是 S(完美对口)/ A(高度相关,可投)/ B(相关但有 stretch)/ C(勉强相关)/ Reject(基本不沾边或与候选人需求冲突)**。

S/A 判定指南:
- 简历技术栈 + 项目经验和岗位 JD 高度契合,且符合"候选人需求"中表达的方向 → S 级
- 技术栈相关、方向相关但有 1-2 个 mismatch(如年限差一档、技术栈差 1 项)→ A 级
- 相关但需要明显 stretch(简历做 AI 但岗位要纯前端)→ B 级
- 与简历方向完全不沾边、或与"候选人需求"明显冲突(候选人说"不投外包",这是外包岗) → Reject

打分维度(按用户偏好星级动态加权):
- role_fit (系统满档权重,基础维度):你判定的 S/A/B 等级直接驱动这维度
- compensation_fit (★${star('salary', 3)}): 月薪低于 ${Math.round(profile.target_monthly_min * 0.93 / 1000)}K 大扣分;${Math.round(profile.target_monthly_max / 1000)}K+ 满分;能算出年包接近 ${Math.round(profile.target_annual / 1000)}K 的加分
- experience_fit: 1-3 年或 2-5 年加分;明确要求 5 年以上 → 扣分
- tech_stack_fit (★${star('tech_fit', 3)}): 命中候选人技术栈(LLM/RAG/Agent/Azure/Entra ID/FastAPI 等)加分
- brand (★${star('brand', 3)}): 大厂(BAT/字节/华为/微软/Google)/独角兽/外资 → 加分;星级 4-5 时这维度权重显著提升
- stability (★${star('stability', 3)}): 已上市 / D 轮+ / 不需要融资 → 加分;天使-A 轮 → 减分
- work_life_balance (★${star('no_overtime', 3)}): 推断加班风险 — 大厂互联网+包晚餐+加班补助 = **高加班**;周末双休+弹性工作+不需要融资行业 = 低加班。星级 ≥4 时高加班岗位务必扣分 + concerns 写 "加班风险高"
- commute_fit (★${star('commute', 3)}): 拿 home_district 和岗位 area 粗判 — 同区 → 加分;跨江(浦东↔浦西)/ 跨主要分区 → 扣分;星级 ≥4 时 concerns 写 "通勤超过 X 分钟"

## 北京软提示规则
若岗位城市是"北京"且薪资相比沪/杭同档高出不足 ${Math.round(premium * 100)}%,concerns 追加 "北京无户口,薪资溢价不足"。**不**因此 Reject。

## 硬性偏好规则
"其他偏好"含硬性规则(如"不投朝阳区"、"35K 以下不投"等),命中即降档或 Reject,在 concerns 写明。

## 搜索意图偏离规则(若上方提供了"用户搜索意图")
若岗位标题/JD 跟搜索意图明显无关(如搜"AI 解决方案"返回纯运营 / 销售 / 行政),降档并在 concerns 写"与搜索意图偏离"。
**注意:** 不要把"搜索意图"当一票否决 — 若只是方向相邻(搜"AI 出海"返回"出海技术",或搜"解决方案"返回"售前架构师"),且简历技术栈仍高度契合,**保留原档**或仅微降。搜索关键词通常是粗略意图,简历 + 候选人需求 才是真实尺子。

## 分档
S ≥ 90, A ≥ 70, B ≥ 55, C ≥ 40, Reject < 40。

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

// ─────────────────────── LLM 调度器(7 个 provider) ───────────────────────
async function callLLM(messages, providerKey, providerConfig, retries = 2) {
  const meta = PROVIDERS[providerKey];
  if (!meta) throw new Error(`未知 provider: ${providerKey}`);
  if (!providerConfig.api_key) {
    throw new Error(`${meta.name} 未配置 API key`);
  }
  const baseUrl = (providerConfig.base_url || meta.base_url).replace(/\/$/, '');
  const model = providerConfig.model || meta.default_model;

  if (meta.protocol === 'openai') {
    return await callOpenAICompat(baseUrl, model, messages, providerConfig.api_key, retries);
  } else if (meta.protocol === 'anthropic') {
    return await callAnthropic(baseUrl, model, messages, providerConfig.api_key, retries);
  }
  throw new Error(`未支持的 protocol: ${meta.protocol}`);
}

async function callOpenAICompat(baseUrl, model, messages, apiKey, retries) {
  let lastErr = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const resp = await fetch(baseUrl + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model, messages,
          response_format: { type: 'json_object' },
          temperature: 0.2,
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      const data = await resp.json();
      return data?.choices?.[0]?.message?.content || null;
    } catch (e) {
      lastErr = e;
      if (attempt < retries - 1) await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw lastErr;
}

async function callAnthropic(baseUrl, model, messages, apiKey, retries) {
  // Anthropic 把 system 和 messages 分开,不支持 response_format
  let systemMsg = '';
  const userMessages = [];
  for (const m of messages) {
    if (m.role === 'system') systemMsg += m.content + '\n';
    else userMessages.push({ role: m.role, content: m.content });
  }
  systemMsg += '\n严格只输出一个 JSON 对象,不要 markdown 包裹,不要解释。';

  let lastErr = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const resp = await fetch(baseUrl + '/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          system: systemMsg,
          messages: userMessages,
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      const data = await resp.json();
      const text = (data.content || []).map((c) => c.text || '').join('');
      return text || null;
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

// 指纹 — 影响打分结果的输入若变,旧分数失效需重打
// (profile 关键字段 + provider/model + prompt 版本 + 是否有 full_jd)
const PROMPT_VERSION = 'v3.search-intent';
function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
function profileFingerprint(profile) {
  const parts = [
    profile.summary || '',
    profile.resume_md || '',
    profile.target_monthly_min, profile.target_monthly_max, profile.target_annual,
    profile.home_district || '',
    profile.other_prefs || '',
    JSON.stringify(profile.priorities || {}),
  ].join('|');
  return djb2(parts);
}
function jobFingerprint(item) {
  return djb2([
    item.job_name || '',
    item.salary || '',
    item.has_detail ? '1' : '0',  // full_jd 拿到后,分数应重算
    (item.full_jd || '').length,
  ].join('|'));
}
function makeScoreFingerprint(profile, providerKey, model, item) {
  return `${PROMPT_VERSION}|${providerKey}|${model || ''}|p:${profileFingerprint(profile)}|j:${jobFingerprint(item)}`;
}

async function scoreAllUnscored() {
  const profile = await getProfile();
  const api = await getApiConfig();
  const activeProvider = api.provider || 'deepseek';
  const providerConfig = (api.providers && api.providers[activeProvider]) || {};
  if (!providerConfig.api_key) {
    throw new Error(`未配置 ${PROVIDERS[activeProvider]?.name || activeProvider} 的 API key,先去画像 tab 填`);
  }

  const jobsMap = await getJobsMap();
  const allKeys = Object.keys(jobsMap);
  // 重打条件:
  //  (1) 未打分 (无 score_priority)
  //  (2) 已打分但指纹不匹配 (简历/偏好/provider/model/JD 变了)
  //  (3) 用户标记 not_interested 的不重打
  // 同时:black-listed company 直接 Reject,不送 LLM
  const targetKeys = [];
  for (const k of allKeys) {
    const item = jobsMap[k];
    if (item.user_marked === 'not_interested' || item.user_marked === 'applied') continue;
    const fp = makeScoreFingerprint(profile, activeProvider, providerConfig.model, item);
    if (!item.score_priority) {
      targetKeys.push(k);
    } else if (item.score_fingerprint !== fp) {
      targetKeys.push(k);  // 输入变了,重打
    }
  }
  if (targetKeys.length === 0) {
    log(`✓ 无需打分: 全部 ${allKeys.length} 条已是当前指纹`);
    return { scored: 0, skipped: allKeys.length };
  }

  let progress = 0;
  let failed = 0;
  let stoppedAt = 0;
  log(`▶ 开始打分: ${targetKeys.length} 条未打分(共 ${allKeys.length})`);

  // 每 N 条增量落盘,避免崩了全丢
  const PERSIST_EVERY = 10;
  let sinceLastPersist = 0;
  const persistMaybe = async (force = false) => {
    sinceLastPersist++;
    if (force || sinceLastPersist >= PERSIST_EVERY) {
      sinceLastPersist = 0;
      await setJobsMap(jobsMap);
    }
  };

  const tasks = targetKeys.map((k) => async () => {
    // 关键:每条进 LLM 前先检查 stop
    if (pipelineState.shouldStop) {
      stoppedAt++;
      return { stopped: true };
    }
    const item = jobsMap[k];
    const job = jobToScoreInput(item);
    try {
      const raw = await callLLM(buildScoringMessages(job, profile), activeProvider, providerConfig);
      const r = parseScoreReply(raw);
      item.score = r.score;
      item.score_priority = r.priority;
      item.score_reason = r.reason;
      item.score_concerns = r.concerns;
      item.score_pitch = r.pitch || '';
      item.score_resume_version = r.resume_version || '';
      item.score_fingerprint = makeScoreFingerprint(profile, activeProvider, providerConfig.model, item);
      item.score_at = Date.now();
      progress++;
    } catch (e) {
      failed++;
      log(`  ✗ 打分失败 [${item.job_name || k}]: ${e.message}`);
      return { error: e.message };
    }
    pipelineState.score = { done: progress, total: targetKeys.length, failed };
    pipelineState.substep = `打分 ${progress}/${targetKeys.length}${failed ? ` (失败 ${failed})` : ''} · ${item.job_name || ''}`.slice(0, 80);
    chrome.runtime.sendMessage({
      type: 'score_progress',
      done: progress,
      total: targetKeys.length,
      failed,
    }).catch(() => {});
    await persistMaybe();
    return true;
  });

  await withConcurrency(tasks, 3);
  await persistMaybe(true);  // 最后强制 flush
  const msg = `✓ 打分完成: 成功 ${progress} / 失败 ${failed}${stoppedAt ? ` / 中止 ${stoppedAt}` : ''}`;
  log(msg);
  return { scored: progress, failed, stopped: stoppedAt, skipped: allKeys.length - targetKeys.length };
}

// ============================================================
// 推送 — WxPusher (per-tier split to avoid 10K truncation)
// ============================================================

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

function buildTierReport(items, tier, label, dateStr, totalCounts) {
  if (items.length === 0) return null;
  const lines = [
    `## ${label} (${items.length}) — ${dateStr}`,
    `> 总览: S=${totalCounts.S} | A=${totalCounts.A} | B=${totalCounts.B} | C=${totalCounts.C} | R=${totalCounts.Reject}`,
    '',
  ];
  for (const it of items) {
    const city = it.city || it.search_city || '';
    lines.push(`**[${it.score || 0}] ${it.job_name}** — ${it.company_name || ''}`);
    lines.push(`💰 ${it.salary || '待议'} · 📍 ${city}${it.area ? '·' + it.area : ''}${it.experience ? ' · ' + it.experience : ''}`);
    if (it.score_reason) lines.push(`> ${it.score_reason}`);
    if (it.score_concerns && it.score_concerns.length) lines.push(`⚠️ ${it.score_concerns.join(' / ')}`);
    if (it.score_pitch) lines.push(`💬 ${it.score_pitch}`);
    if (it.job_url) lines.push(`🔗 ${it.job_url}`);
    lines.push('');
  }
  return lines.join('\n').replace(/\s+$/, '') + '\n';
}

async function pushNow() {
  const api = await getApiConfig();
  if (!api.wxpusher_token || !api.wxpusher_uid) {
    throw new Error('未配置 WxPusher,先去画像标签填');
  }
  const jobsMap = await getJobsMap();
  // 推送时排除已标记 not_interested
  const items = Object.values(jobsMap)
    .filter((j) => j.score_priority && j.marked !== 'not_interested');
  if (items.length === 0) throw new Error('没有已打分的岗位,请先点「AI 全部打分」');

  const today = new Date().toISOString().slice(0, 10);

  // 统计 + 分桶
  const byPrio = { S: [], A: [], B: [], C: [], Reject: [] };
  for (const it of items) (byPrio[it.score_priority] || byPrio.C).push(it);
  for (const k of Object.keys(byPrio)) {
    byPrio[k].sort((a, b) => (b.score || 0) - (a.score || 0));
  }
  const counts = {
    S: byPrio.S.length, A: byPrio.A.length, B: byPrio.B.length,
    C: byPrio.C.length, Reject: byPrio.Reject.length,
  };

  // 按等级分推:S 一条 + A 一条(只发有内容的)
  let pushed = 0;
  const sMd = buildTierReport(byPrio.S, 'S', '🌟 S 级 — 今天优先投', today, counts);
  if (sMd) {
    await pushWxPusher(sMd, `Boss 雷达 ${today} · S 级 ${counts.S} 条`, api.wxpusher_token, api.wxpusher_uid);
    log(`✓ WxPusher 推送 S 级 ${counts.S} 条`);
    pushed++;
  }
  const aMd = buildTierReport(byPrio.A, 'A', '🟢 A 级 — 值得投', today, counts);
  if (aMd) {
    await pushWxPusher(aMd, `Boss 雷达 ${today} · A 级 ${counts.A} 条`, api.wxpusher_token, api.wxpusher_uid);
    log(`✓ WxPusher 推送 A 级 ${counts.A} 条`);
    pushed++;
  }
  // S=0 且 A=0 时,发一条"今天没好岗"以让用户知道流水线跑了但没产出
  if (pushed === 0) {
    const md = `## 🎯 Boss 雷达 ${today}\n\n> 共 ${items.length} 个岗位,S=0 A=0\n\n今天没有 S/A 级岗位。B=${counts.B} C=${counts.C} 在扩展数据池里查看。`;
    await pushWxPusher(md, `Boss 雷达 ${today} · 无 S/A`, api.wxpusher_token, api.wxpusher_uid);
    log(`✓ WxPusher 推送(无 S/A)`);
  }

  const summary = `${counts.S} S / ${counts.A} A`;

  // 写入历史
  await appendHistory({
    date: today,
    ts: Date.now(),
    pushed_total: items.length,
    S: counts.S, A: counts.A, B: counts.B, C: counts.C, Reject: counts.Reject,
  });

  return { total: items.length, counts };
}

// ============================================================
// 预设 / 屏蔽公司 / 历史
// ============================================================
async function getPresets() {
  return (await chrome.storage.local.get('presets')).presets || {};
}
async function getBlocked() {
  return (await chrome.storage.local.get('blockedCompanies')).blockedCompanies || {};
}
async function getHistory() {
  return (await chrome.storage.local.get('history')).history || [];
}
async function appendHistory(entry) {
  const cur = await getHistory();
  // 同日覆盖
  const without = cur.filter((h) => h.date !== entry.date);
  without.push(entry);
  // 保留近 30 条
  const trimmed = without.slice(-30);
  await chrome.storage.local.set({ history: trimmed });
}

// ============================================================
// 一键流水线
// ============================================================
async function runPipeline(config) {
  if (pipelineState.stage === 'crawling' || pipelineState.stage === 'scoring' || pipelineState.stage === 'pushing') {
    throw new Error('流水线已在跑');
  }
  pipelineState.shouldStop = false;
  pipelineState.error = '';
  pipelineState.startedAt = Date.now();
  // 重置细化进度
  pipelineState.crawl = { tasksDone: 0, tasksTotal: 0, jobsAdded: 0, currentTask: '' };
  pipelineState.score = { done: 0, total: 0 };
  pipelineState.push = { tier: '', sent: 0 };
  const notifyStage = (stage, msg) => {
    pipelineState.stage = stage;
    pipelineState.progress = msg || '';
    pipelineState.substep = msg || '';
    pipelineState.stageStartedAt = Date.now();
    chrome.runtime.sendMessage({ type: 'pipeline_progress', stage: msg || stage }).catch(() => {});
  };

  try {
    // 阶段 1: 采集(如果有队列)
    if (config && config.tasks && config.tasks.length > 0) {
      notifyStage('crawling', `采集 — ${config.tasks.length} 任务`);
      // 直接调 startCrawl 并 await 它的内部完成事件
      // 我们用一个 promise 包一下:监听 state.running 转 false
      await runCrawlAndWait({ ...config, resume: false });
      if (pipelineState.shouldStop) {
        notifyStage('idle', '已停止');
        return;
      }
    } else {
      log('  · 跳过采集(没有待跑队列)');
    }

    // 阶段 2: 打分
    if (pipelineState.shouldStop) { notifyStage('idle', '已停止'); return; }
    notifyStage('scoring', '打分');
    const scoreRes = await scoreAllUnscored();
    log(`  · 打分阶段: 新增 ${scoreRes.scored} 跳过 ${scoreRes.skipped}`);

    // 阶段 3: 推送
    if (pipelineState.shouldStop) { notifyStage('idle', '已停止'); return; }
    notifyStage('pushing', '推送 WxPusher');
    const pushRes = await pushNow();
    log(`  · 推送成功: ${pushRes.total} 条`);

    notifyStage('done', '完成');
    log('✓ 一键流水线全部完成');
    // 30 秒后回到 idle
    setTimeout(() => {
      if (pipelineState.stage === 'done') notifyStage('idle', '');
    }, 30000);
  } catch (e) {
    pipelineState.stage = 'error';
    pipelineState.error = e.message;
    log(`✗ 流水线异常: ${e.message}`);
    chrome.runtime.sendMessage({ type: 'pipeline_progress', stage: '出错: ' + e.message }).catch(() => {});
    throw e;
  }
}

function runCrawlAndWait(config) {
  return new Promise((resolve, reject) => {
    if (state.running) { reject(new Error('采集已在跑')); return; }
    startCrawl(config).catch(() => {});
    const startTs = Date.now();
    let everRan = false;
    const poll = setInterval(() => {
      if (pipelineState.shouldStop && state.running) state.shouldStop = true;
      if (state.running) everRan = true;
      // 等 state.running 起来再等它落下来,或 5s 没起来就视为 startCrawl 已退出
      if (!state.running && (everRan || Date.now() - startTs > 5000)) {
        clearInterval(poll);
        resolve();
      }
    }, 500);
  });
}
