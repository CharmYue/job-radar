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

// ============================================================
// IndexedDB jobs store (#3 完整版)
// ------------------------------------------------------------
// 取代 chrome.storage.local.jobs 单 key 巨型对象,解决:
//   (1) 全图 race — 并发 intercept/score 互相覆盖
//   (2) Quota — 10MB 限制,3-5K/条 → 几千条就爆
//   (3) 查询慢 — O(n) JSON 反序列化
// 设计:
//   - 主键 job_id;索引 score_priority / crawl_time_ts / user_marked / company_name
//   - 单条 atomic 更新(IDB 事务保证)
//   - 兼容层 getJobsMap()/setJobsMap() 保留旧 API,新代码用 jobsPut/jobsGet 等
// ============================================================
const IDB_NAME = 'boss_radar';
const IDB_VERSION = 1;
const STORE_JOBS = 'jobs';

let _idbPromise = null;
function openIdb() {
  if (_idbPromise) return _idbPromise;
  _idbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_JOBS)) {
        const store = db.createObjectStore(STORE_JOBS, { keyPath: 'job_id' });
        store.createIndex('score_priority', 'score_priority', { unique: false });
        store.createIndex('crawl_time_ts', 'crawl_time_ts', { unique: false });
        store.createIndex('user_marked', 'user_marked', { unique: false });
        store.createIndex('company_name', 'company_name', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _idbPromise;
}

function idbReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// 在 put 之前算 crawl_time_ts 用于索引(crawl_time 是 "YYYY-MM-DD HH:MM:SS" 字符串)
function normalizeForIdb(job) {
  if (!job.crawl_time_ts && job.crawl_time) {
    const ts = Date.parse(job.crawl_time.replace(' ', 'T'));
    if (!isNaN(ts)) job.crawl_time_ts = ts;
  }
  // 索引字段不能是 undefined,补默认值
  if (job.score_priority === undefined) job.score_priority = '';
  if (job.user_marked === undefined) job.user_marked = '';
  if (job.company_name === undefined) job.company_name = '';
  return job;
}

async function jobsPut(job) {
  if (!job || !job.job_id) throw new Error('jobsPut: 需要 job_id');
  const db = await openIdb();
  const tx = db.transaction(STORE_JOBS, 'readwrite');
  await idbReq(tx.objectStore(STORE_JOBS).put(normalizeForIdb(job)));
  await new Promise((r) => { tx.oncomplete = r; });
}

async function jobsGet(jobId) {
  const db = await openIdb();
  return idbReq(db.transaction(STORE_JOBS, 'readonly').objectStore(STORE_JOBS).get(jobId));
}

async function jobsDelete(jobId) {
  const db = await openIdb();
  const tx = db.transaction(STORE_JOBS, 'readwrite');
  await idbReq(tx.objectStore(STORE_JOBS).delete(jobId));
  await new Promise((r) => { tx.oncomplete = r; });
}

async function jobsBulkPut(jobs) {
  if (!Array.isArray(jobs) || jobs.length === 0) return 0;
  const db = await openIdb();
  const tx = db.transaction(STORE_JOBS, 'readwrite');
  const store = tx.objectStore(STORE_JOBS);
  for (const j of jobs) {
    if (j && j.job_id) store.put(normalizeForIdb(j));
  }
  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return jobs.length;
}

async function jobsListAll() {
  const db = await openIdb();
  return idbReq(db.transaction(STORE_JOBS, 'readonly').objectStore(STORE_JOBS).getAll());
}

async function jobsCount() {
  const db = await openIdb();
  return idbReq(db.transaction(STORE_JOBS, 'readonly').objectStore(STORE_JOBS).count());
}

async function jobsClear() {
  const db = await openIdb();
  const tx = db.transaction(STORE_JOBS, 'readwrite');
  await idbReq(tx.objectStore(STORE_JOBS).clear());
  await new Promise((r) => { tx.oncomplete = r; });
}

// 原子 read-modify-write — 防 race
async function jobsUpdate(jobId, mutator) {
  const db = await openIdb();
  const tx = db.transaction(STORE_JOBS, 'readwrite');
  const store = tx.objectStore(STORE_JOBS);
  const cur = await idbReq(store.get(jobId));
  if (!cur) {
    await new Promise((r) => { tx.oncomplete = r; });
    return null;
  }
  const next = mutator(cur);
  if (next) await idbReq(store.put(normalizeForIdb(next)));
  await new Promise((r) => { tx.oncomplete = r; });
  return next;
}

// ============================================================
// 兼容层:旧代码用 map,新代码可以用 jobsPut 直接落单条
// ============================================================
async function getJobsMap() {
  const arr = await jobsListAll();
  const map = {};
  for (const j of arr) map[j.job_id] = j;
  return map;
}
// ⚠ 不再做"删除 map 外的条目"语义 — codex round 3 指出这是 race 源头:
// 读 → diff → 删 期间,其他单条原子 put 进来的会被误删。
// 现在 setJobsMap 只做 merge(upsert),想删请用 jobsDelete / jobsClear。
async function setJobsMap(m) {
  const arr = Object.values(m || {});
  if (arr.length === 0) return;
  await jobsBulkPut(arr);
}

// ============================================================
// 旧 chrome.storage.local.jobs → IDB 一次性迁移
// ============================================================
async function migrateChromeStorageToIdb() {
  const flag = (await chrome.storage.local.get('idb_migrated_v1')).idb_migrated_v1;
  if (flag) return;
  const oldJobs = (await chrome.storage.local.get('jobs')).jobs;
  if (oldJobs && typeof oldJobs === 'object') {
    const arr = Object.values(oldJobs);
    if (arr.length > 0) {
      await jobsBulkPut(arr);
      log(`✓ 迁移 ${arr.length} 条 jobs 到 IndexedDB`);
    }
    // 删除旧 key 释放 chrome.storage quota
    await chrome.storage.local.remove('jobs');
  }
  await chrome.storage.local.set({ idb_migrated_v1: true });
}

// 留存修剪
const JOBS_KEEP_DAYS = 30;
async function pruneOldJobs(opts = {}) {
  const keepDays = opts.keepDays || JOBS_KEEP_DAYS;
  const cutoff = Date.now() - keepDays * 24 * 3600 * 1000;
  const all = await jobsListAll();
  let pruned = 0;
  const db = await openIdb();
  const tx = db.transaction(STORE_JOBS, 'readwrite');
  const store = tx.objectStore(STORE_JOBS);
  for (const item of all) {
    // 兼容两种字段:老 `marked`(写者用)+ 新 `user_marked`(IDB index)
    const m = item.marked || item.user_marked;
    if (m === 'applied') continue;
    const ts = item.crawl_time_ts || Date.parse((item.crawl_time || '').replace(' ', 'T')) || 0;
    if (ts && ts < cutoff) {
      store.delete(item.job_id);
      pruned++;
    }
  }
  await new Promise((resolve) => { tx.oncomplete = resolve; });
  if (pruned > 0) log(`✓ 修剪 ${pruned} 条 ${keepDays}+ 天前的旧岗位`);
  const remaining = await jobsCount();
  return { pruned, remaining };
}

// #1 lite: pipelineState 持久化 — SW 被 Chrome 杀掉后,
// popup 重开能识别"上次跑到 X 阶段、超过 N 分钟无心跳 = SW 已死"
async function persistPipelineState() {
  try {
    await chrome.storage.local.set({
      pipelineRun: {
        stage: pipelineState.stage,
        startedAt: pipelineState.startedAt,
        stageStartedAt: pipelineState.stageStartedAt,
        substep: pipelineState.substep,
        crawl: pipelineState.crawl,
        score: pipelineState.score,
        push: pipelineState.push,
        error: pipelineState.error,
        heartbeat: Date.now(),
      }
    });
  } catch (e) {}
}
async function loadPersistedPipelineState() {
  return (await chrome.storage.local.get('pipelineRun')).pipelineRun || null;
}
// SW 启动时:如果 storage 里有"活跃"状态 但很久没心跳 → 认定 SW 死过 → 复位
async function reconcileStaleRunOnBoot() {
  const persisted = await loadPersistedPipelineState();
  if (!persisted) return;
  const isActiveStage = ['crawling', 'scoring', 'pushing'].includes(persisted.stage);
  if (!isActiveStage) return;
  const sinceHeartbeat = Date.now() - (persisted.heartbeat || 0);
  // 超过 3 分钟没心跳 + 当前内存里 stage 是 idle(我们刚启动)→ 上次跑被 SW 杀了
  if (sinceHeartbeat > 3 * 60 * 1000) {
    log(`⚠ 检测到上次跑被中断 (stage=${persisted.stage}, ${Math.round(sinceHeartbeat/60000)} 分钟前无心跳) — 标记为 error 状态`);
    pipelineState.stage = 'error';
    pipelineState.error = `SW 中断 (上次 stage: ${persisted.stage}, ${Math.round(sinceHeartbeat/60000)} 分钟前)`;
    await persistPipelineState();
    // 同时清理 crawl 内存状态(它本来就 reset 了,但保险)
    if (state.running) state.running = false;
  }
}

// SW 保活: 30 秒周期 + 每日定时检查
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.create('daily-auto-pipeline', { periodInMinutes: 30 });

// SW boot 时关闸:任何 alarm 触发都先等 boot 结束
// (alarm 可能跨 SW 重启遗留,会在 boot 中途意外推进还没 reconcile 的 run)
let _bootRecovering = true;
let _bootDone = null;  // 等 boot 的 Promise(给 advancePipelineRun 用)
const _bootDonePromise = new Promise((r) => { _bootDone = r; });

(async () => {
  // 顺序:迁 IDB → 立刻把 running 标 pending 不让任何人误读 → prune → 完整 reconcile
  try { await migrateChromeStorageToIdb(); } catch (e) { console.warn('[boot] idb migrate', e); }
  try { await earlyResetRunningTasks(); } catch (e) { console.warn('[boot] early reset', e); }
  try { await pruneOldJobs(); } catch (e) { console.warn('[boot] prune', e); }
  try { await reconcileStaleRunOnBoot(); } catch (e) { console.warn('[boot] stale reconcile', e); }
  try { await reconcileActiveRunOnBoot(); } catch (e) { console.warn('[boot] resume', e); }
  _bootRecovering = false;
  _bootDone();
})();

// 启动时立刻把任何 'running' 任务标回 'pending',
// 不留 boot 期间 stale 'running' 暴露给推进逻辑的窗口
async function earlyResetRunningTasks() {
  const run = (await chrome.storage.local.get('pipelineRun')).pipelineRun;
  if (!run || ['done','error','stopped'].includes(run.stage)) return;
  const q = (await chrome.storage.local.get('taskQueue')).taskQueue;
  if (!q || !q.tasks) return;
  let n = 0;
  for (const t of q.tasks) if (t.status === 'running') { t.status = 'pending'; n++; }
  if (n > 0) {
    await chrome.storage.local.set({ taskQueue: q });
    console.log(`[boot] early reset ${n} stuck running tasks`);
  }
}
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'keepalive') return; // noop,只为保活
  if (alarm.name === 'daily-auto-pipeline') {
    try { await maybeAutoFire(); } catch (e) { console.warn('[daily auto]', e); }
    return;
  }
  if (alarm.name === ALARM_ADVANCE) {
    try { await advancePipelineRun(); } catch (e) { console.warn('[advance]', e); }
    return;
  }
  if (alarm.name === ALARM_CLEANUP) {
    try { await handleCleanupAlarm(); } catch (e) { console.warn('[cleanup]', e); }
    return;
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
          await jobsClear();
          await chrome.storage.local.remove('jobs');  // 顺手清掉旧迁移残留
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
        case 'prune_old_jobs': {
          const r = await pruneOldJobs({ keepDays: msg.keepDays });
          sendResponse({ ok: true, ...r });
          break;
        }
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
          // 写持久 run 标志,让 alarm 推进 to finalize
          await stopPipelineRun();
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
          // 单条原子更新,不走 setJobsMap 全图替换(避免 race)
          await jobsUpdate(msg.job_id, (cur) => {
            if (msg.mark === null) {
              delete cur.marked; cur.user_marked = '';
            } else {
              cur.marked = msg.mark; cur.user_marked = msg.mark;
            }
            return cur;
          });
          if (msg.block_company) {
            const target = await jobsGet(msg.job_id);
            if (target && target.company_id) {
              const blk = await getBlocked();
              blk[target.company_id] = { company_name: target.company_name, ts: Date.now() };
              await chrome.storage.local.set({ blockedCompanies: blk });
              // 这家公司其他岗位也标 not_interested — 用 IDB 全扫,但单条原子写
              const all = await jobsListAll();
              for (const j of all) {
                if (j.company_id === target.company_id && j.marked !== 'not_interested') {
                  await jobsUpdate(j.job_id, (c) => {
                    c.marked = 'not_interested'; c.user_marked = 'not_interested';
                    return c;
                  });
                }
              }
            }
          }
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
          // 单条原子清掉这家公司岗位的 not_interested 标记
          const all = await jobsListAll();
          for (const j of all) {
            if (j.company_id === msg.company_id && (j.marked === 'not_interested' || j.user_marked === 'not_interested')) {
              await jobsUpdate(j.job_id, (c) => {
                delete c.marked; c.user_marked = '';
                return c;
              });
            }
          }
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
          // 单条原子更新,避免全图替换 race
          const all = await jobsListAll();
          for (const j of all) {
            await jobsUpdate(j.job_id, (c) => {
              delete c.score; delete c.score_priority; delete c.score_reason;
              delete c.score_concerns; delete c.score_pitch; delete c.score_resume_version;
              delete c.score_fingerprint; delete c.score_at;
              c.score_priority = '';  // 索引字段不能 undefined
              return c;
            });
          }
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: `unknown message type: ${msg && msg.type}` });
      }
    } catch (e) {
      // 之前是静默 — 错误被 popup 接到但 background 这边看不到,debug 困难
      console.warn(`[boss-final] handler error for ${msg && msg.type}:`, e);
      log(`✗ handler [${msg && msg.type}] 异常: ${e.message}`);
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

  // 不读全图:每条单独 jobsGet 检查是否存在,然后 bulkPut 新加的
  let added = 0;
  let filtered = 0;
  let blockedCount = 0;
  const toAdd = [];
  for (const raw of list) {
    const item = normalize(raw, pendingContext);
    if (!item.job_id) continue;
    const existing = await jobsGet(item.job_id);
    if (existing) continue;  // 已存在,跳过(避免覆盖 score 字段)
    if (item.company_id && blocked[item.company_id]) { blockedCount++; continue; }
    if (companyTokens.length > 0) {
      const brand = (item.company_name || '').toLowerCase();
      const matched = companyTokens.some((t) => brand.indexOf(t) !== -1);
      if (!matched) { filtered++; continue; }
    }
    toAdd.push(item);
    added++;
    if (state.config && state.config.maxTotal > 0 &&
        state.added + added >= state.config.maxTotal) {
      break;
    }
  }
  if (toAdd.length > 0) await jobsBulkPut(toAdd);
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
  // 原子 read-modify-write 单条,避免并发详情互相覆盖
  if (jid) {
    await jobsUpdate(jid, (cur) => {
      mergeDetailIntoJob(cur, info);
      return cur;
    });
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
    const m = item.marked || item.user_marked;
    if (m === 'not_interested' || m === 'applied') continue;
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

  const tasks = targetKeys.map((k) => async () => {
    if (pipelineState.shouldStop) {
      stoppedAt++;
      return { stopped: true };
    }
    const item = jobsMap[k];
    const job = jobToScoreInput(item);
    let scored = null;
    try {
      const raw = await callLLM(buildScoringMessages(job, profile), activeProvider, providerConfig);
      scored = parseScoreReply(raw);
      progress++;
    } catch (e) {
      failed++;
      log(`  ✗ 打分失败 [${item.job_name || k}]: ${e.message}`);
      return { error: e.message };
    }
    // 单条原子写 IDB(无 race) — 比批量整图写省事 + 抗 crash
    await jobsUpdate(k, (cur) => {
      cur.score = scored.score;
      cur.score_priority = scored.priority;
      cur.score_reason = scored.reason;
      cur.score_concerns = scored.concerns;
      cur.score_pitch = scored.pitch || '';
      cur.score_resume_version = scored.resume_version || '';
      cur.score_fingerprint = makeScoreFingerprint(profile, activeProvider, providerConfig.model, cur);
      cur.score_at = Date.now();
      return cur;
    });
    pipelineState.score = { done: progress, total: targetKeys.length, failed };
    pipelineState.substep = `打分 ${progress}/${targetKeys.length}${failed ? ` (失败 ${failed})` : ''} · ${item.job_name || ''}`.slice(0, 80);
    chrome.runtime.sendMessage({
      type: 'score_progress',
      done: progress,
      total: targetKeys.length,
      failed,
    }).catch(() => {});
    persistPipelineState().catch(() => {});
    return true;
  });

  await withConcurrency(tasks, 3);
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
// ============================================================
// Alarm 驱动的流水线状态机 (#1 完整版)
// ------------------------------------------------------------
// 旧版本是一根 long Promise 链(runPipeline → runCrawlAndWait → startCrawl
// 内的 for-loop with sleeps)。MV3 SW 在 5 分钟总寿命/30s idle 上限下经常被
// 干掉,run 中断,popup 看到假"采集中"或卡死状态。
//
// 新版本:
//   1. chrome.storage.local.pipelineRun 持久化整 run 游标
//   2. 每个 "step" 是 ONE 单元(一个 crawl task / 一次 score 调度 / 一次 push)
//      跑完就写 storage + 通过 chrome.alarms 调度下一步 — SW 可以被杀,
//      alarm 时间到了 SW 自动唤醒继续
//   3. SW 启动时检测有 active run → 自动 schedule 下一步推进
//   4. 单个 step 自身要在 SW 寿命内完成 — 通常 < 90s,SW 在活跃事件
//      处理期间不会被杀
// ============================================================
const TERMINAL_STAGES = new Set(['done', 'error', 'stopped']);
const ALARM_ADVANCE = 'advance-pipeline-run';

async function getPipelineRun() {
  return (await chrome.storage.local.get('pipelineRun')).pipelineRun || null;
}
async function setPipelineRun(run) {
  await chrome.storage.local.set({ pipelineRun: run });
}
async function clearPipelineRun() {
  await chrome.storage.local.remove('pipelineRun');
}
// Chrome MV3 production 强制 alarm 最小 30s。
// 为了支持 10-25s 的 task-间冷却,用双轨 + 重入 lock:
//   - setTimeout fast-path:SW 活着就靠它推进
//   - 30s+buffer alarm backstop:SW 死了靠它兜底唤醒
//   - _stepInProgress:防止 timer 触发后 step 跑得慢 + backstop 同时触发导致重入
let _advanceTimer = null;
let _advanceFireAt = 0;
let _stepInProgress = false;
async function scheduleAdvance(delayMs) {
  const d = Math.max(50, delayMs);
  const fireAt = Date.now() + d;
  _advanceFireAt = fireAt;

  // 清掉上次的 timer
  if (_advanceTimer) { clearTimeout(_advanceTimer); _advanceTimer = null; }

  // 短延迟 → setTimeout 推进
  if (d < 28 * 1000) {
    _advanceTimer = setTimeout(async () => {
      _advanceTimer = null;
      if (Date.now() >= _advanceFireAt - 200) {
        _advanceFireAt = 0;
        // 关键:timer 触发时立刻把 backstop alarm 清掉,
        // 不让它在 stepCrawl 跑得慢(>30s)时也触发一次,造成重入
        try { await chrome.alarms.clear(ALARM_ADVANCE); } catch (e) {}
        try { await advancePipelineRun(); } catch (e) { console.warn('[advance st]', e); }
      }
    }, d);
    // 兜底 alarm: max(30s, d + 5s) 保证 SW 即使死了,30+s 后能被唤醒
    chrome.alarms.create(ALARM_ADVANCE, { when: Math.max(Date.now() + 30 * 1000, fireAt + 5 * 1000) });
  } else {
    chrome.alarms.create(ALARM_ADVANCE, { when: fireAt });
  }
}

async function startPipelineRun(config) {
  // 检查是否已有 active run
  const existing = await getPipelineRun();
  if (existing && !TERMINAL_STAGES.has(existing.stage)) {
    throw new Error(`流水线已在跑 (stage=${existing.stage}),先停止再启动`);
  }
  // 清掉前一次 run 排着的 cleanup alarm — 否则它 30s 后触发会把当前新 run 的终态记录擦了
  try { await chrome.alarms.clear(ALARM_CLEANUP); } catch (e) {}
  await chrome.storage.local.remove('pendingCleanupRunId');

  const tasks = (config && config.tasks) || [];
  // 建 taskQueue
  const queue = {
    tasks: tasks.map((t, idx) => ({
      ...t, id: idx, status: 'pending', captured: 0, attempts: 0, lastError: '',
    })),
    createdAt: Date.now(),
  };
  await setTaskQueue(queue);
  if (tasks.length > 0) log(`▶ 新队列: ${tasks.length} 个组合`);

  const run = {
    id: `run-${Date.now()}`,
    config: { ...config },
    stage: tasks.length > 0 ? 'crawl' : 'score',
    startedAt: Date.now(),
    stageStartedAt: Date.now(),
    heartbeat: Date.now(),
    taskIdx: 0,
    consecutiveRiskCount: 0,
    shouldStop: false,
    error: '',
    pass: 1,  // 1=主轮 / 2=补抓 failed-attempts<2
  };
  await setPipelineRun(run);

  // 同步内存 pipelineState(popup 显示)
  pipelineState.shouldStop = false;
  pipelineState.error = '';
  pipelineState.startedAt = Date.now();
  pipelineState.crawl = { tasksDone: 0, tasksTotal: tasks.length, jobsAdded: 0, currentTask: '' };
  pipelineState.score = { done: 0, total: 0 };
  pipelineState.push = { tier: '', sent: 0 };
  pipelineState.stage = run.stage === 'crawl' ? 'crawling' : 'scoring';
  pipelineState.stageStartedAt = Date.now();
  pipelineState.substep = run.stage === 'crawl' ? `采集 — ${tasks.length} 任务` : '打分';
  await persistPipelineState();

  await scheduleAdvance(200);
  log(`▶ 流水线启动 ${run.id} (alarm-driven)`);
}

async function stopPipelineRun() {
  const run = await getPipelineRun();
  if (!run || TERMINAL_STAGES.has(run.stage)) return;
  run.shouldStop = true;
  await setPipelineRun(run);
  // 同时设内存标志,让正在跑的 step 自己注意
  pipelineState.shouldStop = true;
  state.shouldStop = true;
  // 戳 alarm 让 advance 尽快走入 finalize
  await scheduleAdvance(100);
}

async function advancePipelineRun() {
  // 等 boot 完成
  if (_bootRecovering) {
    try { await _bootDonePromise; } catch (e) {}
  }
  // 重入保护:timer + backstop alarm 可能同时进来,只让一个跑
  if (_stepInProgress) {
    console.log('[advance] skip — step in progress');
    return;
  }
  _stepInProgress = true;
  try {
    await _advancePipelineRunInner();
  } finally {
    _stepInProgress = false;
  }
}

async function _advancePipelineRunInner() {
  const run = await getPipelineRun();
  if (!run) return;
  if (TERMINAL_STAGES.has(run.stage)) return;

  run.heartbeat = Date.now();
  await setPipelineRun(run);

  if (run.shouldStop) return await finalizePipelineRun(run, 'stopped');

  // 同步 stage 到内存
  const stageMap = { crawl: 'crawling', score: 'scoring', push: 'pushing' };
  pipelineState.stage = stageMap[run.stage] || run.stage;

  try {
    if (run.stage === 'crawl') return await stepCrawl(run);
    if (run.stage === 'score') return await stepScore(run);
    if (run.stage === 'push') return await stepPush(run);
  } catch (e) {
    log(`✗ 流水线 [${run.stage}] 异常: ${e.message}`);
    run.stage = 'error';
    run.error = e.message;
    await setPipelineRun(run);
    pipelineState.stage = 'error';
    pipelineState.error = e.message;
    await persistPipelineState();
  }
}

async function stepCrawl(run) {
  const q = await getTaskQueue();
  if (!q || !q.tasks || q.tasks.length === 0) {
    // 没任务,直接跳到 score
    return await transitionTo(run, 'score');
  }

  // 找下一个能跑的任务:
  // - 主轮(pass=1):pending 或 failed 但 attempts<2
  // - 补轮(pass=2):仅 failed 且 attempts<2
  let nextIdx = -1;
  for (let i = 0; i < q.tasks.length; i++) {
    const t = q.tasks[i];
    if (run.pass === 1) {
      if (t.status === 'pending') { nextIdx = i; break; }
      if (t.status === 'failed' && (t.attempts || 0) < 2) { nextIdx = i; break; }
    } else {
      if (t.status === 'failed' && (t.attempts || 0) < 2) { nextIdx = i; break; }
    }
  }

  if (nextIdx === -1) {
    // 没了
    if (run.pass === 1) {
      // 准备进补轮:看有没有 failed 待补
      const hasFailed = q.tasks.some((t) => t.status === 'failed' && (t.attempts || 0) < 2);
      if (hasFailed) {
        run.pass = 2;
        await setPipelineRun(run);
        log(`▶ 第二轮:补抓 failed 任务`);
        return await scheduleAdvance(60 * 1000);  // 第二轮前等 60s
      }
    }
    // 真完了
    const doneN = q.tasks.filter((t) => t.status === 'done').length;
    const failN = q.tasks.filter((t) => t.status === 'failed' || t.status === 'failed_skipped').length;
    log(`=== 队列完成 完成 ${doneN}/${q.tasks.length}, 失败 ${failN} ===`);
    log(`✓ 本次新增 ${state.added} 条`);
    await cleanupTarget();
    pendingContext = null;
    state.running = false;
    state.currentTabId = null;
    state.currentWindowId = null;
    state.persistentTabId = null;
    return await transitionTo(run, 'score');
  }

  // 跑这个任务
  const t = q.tasks[nextIdx];
  state.config = run.config;
  if (!state.running) {
    state.running = true;
    state.shouldStop = false;
    // SW 重启时从 pipelineRun 恢复 added 计数 — 不要丢之前已抓的
    state.added = (run.crawl && typeof run.crawl.jobsAdded === 'number') ? run.crawl.jobsAdded : 0;
    state.currentKeywordTotal = q.tasks.length;
  }
  state.currentKeywordIdx = nextIdx + 1;
  state.currentPage = 0;

  pipelineState.crawl.tasksDone = nextIdx;
  pipelineState.crawl.tasksTotal = q.tasks.length;
  pipelineState.crawl.currentTask = `${t.positionName} @ ${t.cityName}`;
  pipelineState.substep = `${run.pass === 2 ? '补抓 ' : '采集'} [${nextIdx + 1}/${q.tasks.length}] ${t.positionName} @ ${t.cityName}`;
  await persistPipelineState();

  const tag = t.experience ? ` exp=${t.experience}` : '';
  log(`[${run.pass === 2 ? '补抓 ' : ''}${nextIdx + 1}/${q.tasks.length}] ${t.positionName} @ ${t.cityName}${tag}`);

  t.status = 'running';
  t.attempts = (t.attempts || 0) + 1;
  const beforeAdded = state.added;
  await setTaskQueue(q);

  try {
    await runOneTask(t, run.config);
  } catch (e) {
    log(`  ✗ 任务异常: ${e.message}`);
  }

  t.captured = state.added - beforeAdded;
  pipelineState.crawl.jobsAdded = state.added;
  // 同步到持久 run — SW 死了恢复时不会归零
  run.crawl = { ...(run.crawl || {}), jobsAdded: state.added, tasksDone: nextIdx + 1, tasksTotal: q.tasks.length };

  let cooldown = rand((run.config.gapMin || 10) * 1000, (run.config.gapMax || 25) * 1000);
  if (riskFlag) {
    t.status = run.pass === 1 ? 'failed' : 'failed_skipped';
    t.lastError = 'risk';
    run.consecutiveRiskCount = (run.consecutiveRiskCount || 0) + 1;
    log(`  ⚠ 风控,记 ${t.status}`);
    if (run.consecutiveRiskCount >= 3) {
      log(`  ⏸ 连续 3 次风控,冷却 30 分钟`);
      run.consecutiveRiskCount = 0;
      cooldown = 30 * 60 * 1000;
    }
  } else {
    t.status = 'done';
    run.consecutiveRiskCount = 0;
  }
  await setTaskQueue(q);

  // 重读 run — task 跑期间可能用户点了 Stop 把 shouldStop 写到 storage
  // 不能用我们手头的 stale run 对象覆盖掉
  const fresh = await getPipelineRun();
  if (fresh) {
    // merge:我们 task 跑出的本地变化(consecutiveRiskCount)写回,但保留 fresh 的 shouldStop / error
    fresh.consecutiveRiskCount = run.consecutiveRiskCount;
    fresh.heartbeat = Date.now();
    await setPipelineRun(fresh);
    if (fresh.shouldStop) return await finalizePipelineRun(fresh, 'stopped');
  } else {
    // run 被清掉了(罕见)— 啥都不干
    return;
  }

  log(`  ⏸ 任务间冷却 ${(cooldown/1000).toFixed(0)}s (alarm 接力)`);
  return await scheduleAdvance(cooldown);
}

async function stepScore(run) {
  pipelineState.stage = 'scoring';
  pipelineState.substep = '打分';
  pipelineState.stageStartedAt = Date.now();
  await persistPipelineState();
  const r = await scoreAllUnscored();
  log(`  · 打分阶段: 成功 ${r.scored}${r.failed?' 失败 '+r.failed:''} 跳过 ${r.skipped}`);
  if (pipelineState.shouldStop) return await finalizePipelineRun(run, 'stopped');
  return await transitionTo(run, 'push');
}

async function stepPush(run) {
  pipelineState.stage = 'pushing';
  pipelineState.substep = '推送 WxPusher';
  pipelineState.stageStartedAt = Date.now();
  await persistPipelineState();
  try {
    const r = await pushNow();
    log(`  · 推送成功: ${r.total} 条`);
  } catch (e) {
    // 推送失败不致命 — 打分已存,可以手动重推
    log(`  ⚠ 推送失败: ${e.message}`);
  }
  return await finalizePipelineRun(run, 'done');
}

async function transitionTo(run, nextStage) {
  run.stage = nextStage;
  run.stageStartedAt = Date.now();
  await setPipelineRun(run);
  return await scheduleAdvance(500);
}

const ALARM_CLEANUP = 'finalize-cleanup-pipeline-run';

async function finalizePipelineRun(run, finalStage) {
  run.stage = finalStage;
  run.finishedAt = Date.now();
  await setPipelineRun(run);
  pipelineState.stage = finalStage === 'done' ? 'done' : (finalStage === 'stopped' ? 'idle' : finalStage);
  pipelineState.substep = finalStage === 'done' ? '完成' : (finalStage === 'stopped' ? '已停止' : '出错');
  await persistPipelineState();
  log(`✓ 流水线 ${finalStage}`);
  chrome.runtime.sendMessage({ type: 'pipeline_progress', stage: finalStage }).catch(() => {});

  // 清掉任何遗留的推进 alarm 和 setTimeout
  if (_advanceTimer) { clearTimeout(_advanceTimer); _advanceTimer = null; }
  _advanceFireAt = 0;
  try { await chrome.alarms.clear(ALARM_ADVANCE); } catch (e) {}

  // 记下当前 run.id,30 秒后清理 alarm 触发时拿这个 id 校验 — 不会误清后续 run
  await chrome.storage.local.set({ pendingCleanupRunId: run.id });
  chrome.alarms.create(ALARM_CLEANUP, { when: Date.now() + 30 * 1000 });
}

async function handleCleanupAlarm() {
  const expected = (await chrome.storage.local.get('pendingCleanupRunId')).pendingCleanupRunId;
  const cur = await getPipelineRun();
  // 校验 run.id — 若 storage 里已是另一个 run(用户开了新 run),老 cleanup 不动它
  if (cur && cur.id === expected && TERMINAL_STAGES.has(cur.stage)) {
    await clearPipelineRun();
  }
  await chrome.storage.local.remove('pendingCleanupRunId');
  if (pipelineState.stage === 'done' || pipelineState.stage === 'error') {
    pipelineState.stage = 'idle';
    await persistPipelineState();
  }
}

// SW boot 恢复
async function reconcileActiveRunOnBoot() {
  const run = await getPipelineRun();
  if (!run) return;
  if (TERMINAL_STAGES.has(run.stage)) return;
  const sinceHeartbeat = Date.now() - (run.heartbeat || 0);
  log(`⏯ 检测到未完成 run ${run.id} stage=${run.stage}, 上次心跳 ${Math.round(sinceHeartbeat/1000)}s 前`);

  // 清理 stuck 'running' 任务 — SW 死时正在跑的任务会卡在 running,标回 pending
  if (run.stage === 'crawl') {
    const q = await getTaskQueue();
    if (q && q.tasks) {
      let recovered = 0;
      for (const t of q.tasks) {
        if (t.status === 'running') { t.status = 'pending'; recovered++; }
      }
      if (recovered > 0) {
        await setTaskQueue(q);
        log(`  ⏯ 重置 ${recovered} 个卡在 running 的任务`);
      }
    }
  }

  // 同步到内存 pipelineState
  const stageMap = { crawl: 'crawling', score: 'scoring', push: 'pushing' };
  pipelineState.stage = stageMap[run.stage] || 'idle';
  pipelineState.startedAt = run.startedAt;
  pipelineState.stageStartedAt = run.stageStartedAt;
  pipelineState.crawl = pipelineState.crawl || { tasksDone: 0, tasksTotal: 0, jobsAdded: 0, currentTask: '' };
  pipelineState.score = pipelineState.score || { done: 0, total: 0 };

  // 直接 schedule 推进(不要 await — 让 SW boot 路径快速返回)
  scheduleAdvance(1000).catch(() => {});
}

// 旧 API 保留,内部转给新状态机
async function runPipeline(config) {
  await startPipelineRun(config);
}
