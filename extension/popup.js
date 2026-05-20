// ============================================================
// popup.js — Boss 求职雷达 (重构版)
// ============================================================

const $ = (id) => document.getElementById(id);

let DICT = null;
const sel = { positions: new Set(), cities: new Set() };
let keywords = [];
let resultFilter = 'all';

// ============================================================
// 入口
// ============================================================
async function init() {
  await loadDict();
  renderPositionTree();
  renderCityGrid();
  fillFilters();
  bindEvents();
  // 默认 tab 是 profile,需显式初始化一次内容
  await loadProfileIntoUI();
  await loadAutoDaily();
  await refreshAll();
  setInterval(refreshAll, 2500);
}
async function loadDict() {
  const r = await fetch(chrome.runtime.getURL('dict.json'));
  DICT = await r.json();
}

// ============================================================
// 通用刷新(顶部 + 当前 tab)
// ============================================================
async function refreshAll() {
  // 轻量级:仅 banner + pipeline + 当前 tab 的非破坏性内容
  await refreshOnboardingBanner();
  await refreshPipelineState();
  const active = document.querySelector('.tab.active');
  if (!active) return;
  const panel = active.dataset.panel;
  // profile tab 不在 poll 时刷新(避免覆盖用户正在输入的字段)
  if (panel === 'run') { await refreshPool(); await refreshScored(); await refreshQueue(); }
  if (panel === 'history') { await refreshHistory(); await refreshBlocked(); }
}

// ============================================================
// 引导 banner — 检查画像 + API 完整度
// ============================================================
async function refreshOnboardingBanner() {
  const r = await chrome.runtime.sendMessage({ type: 'get_profile' });
  const p = (r && r.ok) ? r.profile : {};
  const ar = await chrome.runtime.sendMessage({ type: 'get_api' });
  const a = (ar && ar.ok) ? ar.api : {};

  const banner = $('banner');
  const missing = [];
  if (!p.summary) missing.push('summary');
  if (!p.resume_md || p.resume_md.length < 100) missing.push('简历');
  const active = a.provider || 'deepseek';
  const cfg = (a.providers && a.providers[active]) || {};
  if (!cfg.api_key) missing.push('LLM API key');
  if (!a.wxpusher_token || !a.wxpusher_uid) missing.push('WxPusher');

  if (missing.length > 0) {
    banner.className = 'show';
    banner.innerHTML = `⚠️ 第一步先到「画像」配置 — 还缺: <b>${missing.join(' / ')}</b>。 <a id="bannerJumpProfile">去填 →</a>`;
    $('bannerJumpProfile').addEventListener('click', () => switchTab('profile'));
    // 锁住其他 tab
    document.querySelectorAll('.tab').forEach((t) => {
      if (t.dataset.panel !== 'profile') t.classList.add('locked');
    });
  } else {
    banner.className = 'show ok';
    banner.innerHTML = '✅ 画像就绪。<a id="bannerJumpRun">直接去跑一轮 →</a>';
    $('bannerJumpRun').addEventListener('click', () => switchTab('run'));
    document.querySelectorAll('.tab.locked').forEach((t) => t.classList.remove('locked'));
  }
}

// ============================================================
// Pipeline 状态(顶部 + 阶段条)
// ============================================================
async function refreshPipelineState() {
  const r = await chrome.runtime.sendMessage({ type: 'pipeline_status' });
  const p = (r && r.ok) ? r.pipeline : { stage: 'idle' };
  const s = (r && r.ok) ? r.crawl : { running: false };

  // 顶部状态徽章
  $('state').textContent =
    p.stage === 'crawling' ? '采集中' :
    p.stage === 'scoring'  ? '打分中' :
    p.stage === 'pushing'  ? '推送中' :
    p.stage === 'done'     ? '已完成' :
    p.stage === 'error'    ? '出错' :
    s.running              ? '采集中' : '空闲';
  $('state').className = (p.stage !== 'idle' && p.stage !== 'done') || s.running ? 'state running' : 'state';

  // 阶段条
  const setStage = (id, st) => {
    const el = $(id);
    if (el) el.className = 'stage' + (st ? ' ' + st : '');
  };
  setStage('stageCrawl',
    p.stage === 'crawling' ? 'active' :
    ['scoring', 'pushing', 'done'].includes(p.stage) ? 'done' : '');
  setStage('stageScore',
    p.stage === 'scoring' ? 'active' :
    ['pushing', 'done'].includes(p.stage) ? 'done' : '');
  setStage('stagePush',
    p.stage === 'pushing' ? 'active' :
    p.stage === 'done' ? 'done' : '');

  // 主按钮
  const piRunning = p.stage === 'crawling' || p.stage === 'scoring' || p.stage === 'pushing';
  $('runPipeline').style.display = piRunning ? 'none' : 'block';
  $('stopPipeline').style.display = piRunning ? 'block' : 'none';

  // 分步按钮
  $('startCrawl').disabled = piRunning || s.running;
  $('resumeCrawl').disabled = piRunning || s.running;
  $('stopCrawl').disabled = !s.running;
  $('scoreAll').disabled = piRunning;
  $('pushNow').disabled = piRunning;

  // 进度
  const prog = p.progress || (s.progress ? `[${s.progress.ki}/${s.progress.kt} | R${s.progress.p} | +${s.progress.added}]` : '');
  $('progress').textContent = prog;
}

// ============================================================
// Tabs
// ============================================================
async function switchTab(panel) {
  document.querySelectorAll('.tab').forEach((t) => {
    if (t.classList.contains('locked')) return;
    t.classList.toggle('active', t.dataset.panel === panel);
  });
  document.querySelectorAll('.panel').forEach((x) => {
    x.classList.toggle('active', x.id === 'panel-' + panel);
  });
  // 切到 profile 或 search 时,显式加载该 tab 一次
  if (panel === 'profile') await loadProfileIntoUI();
  if (panel === 'search') await refreshPresetDropdown();
  await refreshAll();
}

document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    if (t.classList.contains('locked')) {
      alert('请先完成画像配置');
      return;
    }
    switchTab(t.dataset.panel);
  });
});

// ============================================================
// 画像:完成度 checklist + load/save + yaml/resume 导入
// ============================================================
// 偏好维度 - 用于 star UI 渲染(role_fit 系统默认满档,不暴露)
const PRIORITY_DIMS = [
  { key: 'salary',      label: '薪资',          hint: '高于目标月薪权重' },
  { key: 'brand',       label: '大厂背景',      hint: 'BAT/字节/外资' },
  { key: 'no_overtime', label: '不加班',        hint: 'work-life balance' },
  { key: 'stability',   label: '公司稳定',      hint: '已上市/D 轮+' },
  { key: 'commute',     label: '通勤距离',      hint: '配合住址使用' },
  { key: 'tech_fit',    label: '技术栈契合',    hint: '匹配简历技术栈' },
];

let CURRENT_PROVIDERS_META = null; // { key: { name, default_model, base_url } }
let CURRENT_PRIORITIES = {};

function renderPriorityStars() {
  const root = $('priorityStars');
  if (!root) return;
  root.innerHTML = '';
  for (const dim of PRIORITY_DIMS) {
    const cur = CURRENT_PRIORITIES[dim.key] || (dim.key === 'role_fit' ? 5 : 3);
    const row = document.createElement('div');
    row.className = 'prio-row';
    const label = document.createElement('span');
    label.className = 'label';
    label.innerHTML = `${dim.label} <span class="hint">${dim.hint}</span>`;
    row.appendChild(label);
    const stars = document.createElement('span');
    stars.className = 'prio-stars';
    stars.dataset.key = dim.key;
    for (let i = 1; i <= 5; i++) {
      const s = document.createElement('span');
      s.dataset.n = i;
      s.textContent = '★';
      if (i <= cur) s.classList.add('filled');
      s.addEventListener('click', () => {
        CURRENT_PRIORITIES[dim.key] = i;
        renderPriorityStars();
      });
      stars.appendChild(s);
    }
    row.appendChild(stars);
    root.appendChild(row);
  }
}

function setSlider(id, valueK) {
  $(id).value = valueK;
  $(id + 'Val').textContent = valueK >= 1000 ? `${valueK / 1000}M` : `${valueK}K`;
}

async function loadProfileIntoUI() {
  const r = await chrome.runtime.sendMessage({ type: 'get_profile' });
  const p = (r && r.ok) ? r.profile : {};
  $('pfSummary').value = p.summary || '';
  $('pfResume').value = p.resume_md || '';
  // sliders 存 K (千元)
  setSlider('pfMonthlyMin', Math.round((p.target_monthly_min || 30000) / 1000));
  setSlider('pfMonthlyMax', Math.round((p.target_monthly_max || p.target_monthly_ideal || 50000) / 1000));
  setSlider('pfAnnual', Math.round((p.target_annual || 500000) / 1000));
  $('pfHardReject').value = (p.hard_reject || []).join('\n');
  $('pfHomeDistrict').value = p.home_district || '';
  $('pfOtherPrefs').value = p.other_prefs || '';
  CURRENT_PRIORITIES = { ...(p.priorities || {}) };
  renderPriorityStars();

  // 加载 provider 元数据(只取一次)
  if (!CURRENT_PROVIDERS_META) {
    const pr = await chrome.runtime.sendMessage({ type: 'list_providers' });
    if (pr && pr.ok) CURRENT_PROVIDERS_META = pr.providers;
  }

  const ar = await chrome.runtime.sendMessage({ type: 'get_api' });
  const a = (ar && ar.ok) ? ar.api : {};
  const active = a.provider || 'deepseek';
  $('apiProvider').value = active;
  const cfg = (a.providers && a.providers[active]) || {};
  $('apiProviderKey').value = cfg.api_key || '';
  $('apiProviderModel').value = cfg.model || '';
  $('apiProviderBaseUrl').value = cfg.base_url || '';
  $('apiWxToken').value = a.wxpusher_token || '';
  $('apiWxUid').value = a.wxpusher_uid || '';
  refreshProviderHint();
  CURRENT_ACTIVE_PROVIDER = active;

  renderChecklist(p, a);
}

function refreshProviderHint() {
  const meta = CURRENT_PROVIDERS_META && CURRENT_PROVIDERS_META[$('apiProvider').value];
  if (!meta) return;
  $('apiProviderModel').placeholder = meta.default_model;
  $('apiProviderBaseUrl').placeholder = meta.base_url;
  $('providerDefaultHint').textContent =
    `默认 model: ${meta.default_model} · 默认 base url: ${meta.base_url}`;
}

// 切换 provider 时,先 save 当前的(避免丢) → 然后载入新 provider 的配置
let CURRENT_ACTIVE_PROVIDER = null;
async function onProviderSwitch() {
  const next = $('apiProvider').value;
  // 先保存当前 active 的 key/model 到 storage
  if (CURRENT_ACTIVE_PROVIDER && CURRENT_ACTIVE_PROVIDER !== next) {
    await saveActiveProviderFields(CURRENT_ACTIVE_PROVIDER);
  }
  CURRENT_ACTIVE_PROVIDER = next;
  // 载入新 provider 的字段
  const ar = await chrome.runtime.sendMessage({ type: 'get_api' });
  const a = (ar && ar.ok) ? ar.api : {};
  const cfg = (a.providers && a.providers[next]) || {};
  $('apiProviderKey').value = cfg.api_key || '';
  $('apiProviderModel').value = cfg.model || '';
  $('apiProviderBaseUrl').value = cfg.base_url || '';
  refreshProviderHint();
}

async function saveActiveProviderFields(providerKey) {
  const ar = await chrome.runtime.sendMessage({ type: 'get_api' });
  const a = (ar && ar.ok) ? ar.api : {};
  const providers = { ...(a.providers || {}) };
  providers[providerKey] = {
    api_key: $('apiProviderKey').value.trim(),
    model: $('apiProviderModel').value.trim(),
    base_url: $('apiProviderBaseUrl').value.trim(),
  };
  await chrome.runtime.sendMessage({
    type: 'save_api',
    api: { ...a, provider: providerKey, providers },
  });
}

function renderChecklist(p, a) {
  const active = a.provider || 'deepseek';
  const providerCfg = (a.providers && a.providers[active]) || {};
  const providerName = (CURRENT_PROVIDERS_META && CURRENT_PROVIDERS_META[active]?.name) || active;
  const items = [
    { label: 'summary', ok: !!p.summary },
    { label: '完整简历', ok: !!p.resume_md && p.resume_md.length > 100 },
    { label: '薪资期望', ok: !!(p.target_monthly_min && p.target_monthly_max) },
    { label: '硬拒关键词', ok: (p.hard_reject || []).length > 0 },
    { label: `${providerName} API key`, ok: !!providerCfg.api_key },
    { label: 'WxPusher Token', ok: !!a.wxpusher_token },
    { label: 'WxPusher UID', ok: !!a.wxpusher_uid },
  ];
  const done = items.filter((x) => x.ok).length;
  $('completionChecklist').innerHTML = items.map((x) => `
    <div class="checklist-item ${x.ok ? 'done' : 'todo'}">
      <span>${x.ok ? '✓' : '○'} ${x.label}</span>
      <span class="status">${x.ok ? '已填' : '缺'}</span>
    </div>
  `).join('') + `
    <div class="checklist-item" style="border-top:1px solid #e5e7eb;margin-top:4px;padding-top:6px;font-weight:600">
      <span>总完成度</span>
      <span class="status" style="color:${done === items.length ? '#2a9d4a' : '#c33'}">${done}/${items.length}</span>
    </div>
  `;
}

function profileFromUI() {
  const linesToArray = (t) => t.split('\n').map((s) => s.trim()).filter(Boolean);
  return {
    summary: $('pfSummary').value.trim(),
    resume_md: $('pfResume').value,
    target_monthly_min: (parseInt($('pfMonthlyMin').value) || 30) * 1000,
    target_monthly_max: (parseInt($('pfMonthlyMax').value) || 50) * 1000,
    target_annual: (parseInt($('pfAnnual').value) || 500) * 1000,
    hard_reject: linesToArray($('pfHardReject').value),
    priorities: { ...CURRENT_PRIORITIES },
    home_district: $('pfHomeDistrict').value.trim(),
    other_prefs: $('pfOtherPrefs').value.trim(),
  };
}

async function saveProfileFromUI() {
  // Profile
  await chrome.runtime.sendMessage({ type: 'save_profile', profile: profileFromUI() });

  // API: 保存当前 provider 的字段 + wxpusher
  const active = $('apiProvider').value;
  const ar = await chrome.runtime.sendMessage({ type: 'get_api' });
  const a = (ar && ar.ok) ? ar.api : {};
  const providers = { ...(a.providers || {}) };
  providers[active] = {
    api_key: $('apiProviderKey').value.trim(),
    model: $('apiProviderModel').value.trim(),
    base_url: $('apiProviderBaseUrl').value.trim(),
  };
  await chrome.runtime.sendMessage({
    type: 'save_api',
    api: {
      ...a,
      provider: active,
      providers,
      wxpusher_token: $('apiWxToken').value.trim(),
      wxpusher_uid: $('apiWxUid').value.trim(),
    },
  });
  CURRENT_ACTIVE_PROVIDER = active;
  appendLog('✓ 画像 + API + 偏好 已保存');
  await refreshAll();
}

// API config from UI (just the API part, used by 测试推送)
function apiFromUI() {
  return {
    wxpusher_token: $('apiWxToken').value.trim(),
    wxpusher_uid: $('apiWxUid').value.trim(),
  };
}

// ─────────────────────── Slider 实时值显示 ───────────────────────
function bindSlider(id) {
  const el = $(id);
  const out = $(id + 'Val');
  if (!el || !out) return;
  el.addEventListener('input', () => {
    const v = parseInt(el.value);
    out.textContent = v >= 1000 ? `${v / 1000}M` : `${v}K`;
  });
}
bindSlider('pfMonthlyMin');
bindSlider('pfMonthlyMax');
bindSlider('pfAnnual');

// 月薪上下限联动:Min 不能超过 Max
$('pfMonthlyMin').addEventListener('input', () => {
  const mn = parseInt($('pfMonthlyMin').value);
  const mx = parseInt($('pfMonthlyMax').value);
  if (mn > mx) {
    $('pfMonthlyMax').value = mn;
    $('pfMonthlyMaxVal').textContent = `${mn}K`;
  }
});
$('pfMonthlyMax').addEventListener('input', () => {
  const mn = parseInt($('pfMonthlyMin').value);
  const mx = parseInt($('pfMonthlyMax').value);
  if (mx < mn) {
    $('pfMonthlyMin').value = mx;
    $('pfMonthlyMinVal').textContent = `${mx}K`;
  }
});

$('apiProvider').addEventListener('change', onProviderSwitch);

$('saveProfile').addEventListener('click', saveProfileFromUI);
$('testPush').addEventListener('click', async () => {
  const api = apiFromUI();
  if (!api.wxpusher_token || !api.wxpusher_uid) {
    alert('请先填 WxPusher token + uid'); return;
  }
  // 先保存一次,确保 background 拿到最新值
  await chrome.runtime.sendMessage({ type: 'save_api', api });
  const today = new Date().toISOString().slice(0, 10);
  const md = `## ✅ Boss 雷达 — 推送测试 ${today}\n\n收到这条说明 WxPusher 配通了。`;
  try {
    const resp = await fetch('https://wxpusher.zjiecode.com/api/send/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appToken: api.wxpusher_token,
        content: md, contentType: 3,
        summary: '测试推送',
        uids: [api.wxpusher_uid],
      }),
    });
    const data = await resp.json();
    if (data.success) { appendLog('✓ 测试推送成功'); alert('成功,微信看看'); }
    else { appendLog(`✗ ${JSON.stringify(data)}`); alert(`失败: ${data.msg || JSON.stringify(data)}`); }
  } catch (e) {
    alert('网络错误: ' + e.message);
  }
});

// ============================================================
// 搜索:keywords chips + position tree + cities + filters + 预设
// ============================================================
function renderKeywordChips() {
  const wrap = $('keywordChips');
  // 移除现有 chip 节点(保留 input)
  wrap.querySelectorAll('.chip').forEach((c) => c.remove());
  // 插入 chip
  for (let i = keywords.length - 1; i >= 0; i--) {
    const kw = keywords[i];
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `${kw}<span class="x" data-i="${i}">×</span>`;
    chip.querySelector('.x').addEventListener('click', () => {
      keywords.splice(i, 1);
      renderKeywordChips();
      updateSelCounts();
    });
    wrap.insertBefore(chip, $('keywordInput'));
  }
}
$('keywordInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const v = e.target.value.trim();
    if (v && !keywords.includes(v)) {
      keywords.push(v);
      renderKeywordChips();
      updateSelCounts();
    }
    e.target.value = '';
  } else if (e.key === 'Backspace' && e.target.value === '' && keywords.length > 0) {
    keywords.pop();
    renderKeywordChips();
    updateSelCounts();
  }
});

function renderPositionTree(filter = '') {
  const root = $('positionTree');
  root.innerHTML = '';
  const flo = filter.toLowerCase();
  for (const l1 of DICT.positions) {
    const l1Wrap = document.createElement('div');
    const l1Header = document.createElement('div');
    l1Header.className = 'tree-l1';
    const arrow1 = Object.assign(document.createElement('span'), { className: 'toggle-arrow', textContent: '▶' });
    const cb1 = Object.assign(document.createElement('input'), { type: 'checkbox' });
    cb1.dataset.role = 'l1';
    const lbl1 = Object.assign(document.createElement('span'), { textContent: l1.name });
    const cnt1 = Object.assign(document.createElement('span'), { className: 'count' });
    let l3Total = 0;
    for (const l2 of l1.children) l3Total += l2.children.length;
    cnt1.textContent = `${l3Total} 个`;
    l1Header.append(arrow1, cb1, lbl1, cnt1);

    const l2Wrap = Object.assign(document.createElement('div'), { className: 'tree-l2-wrap' });
    let l1HasMatch = false;
    for (const l2 of l1.children) {
      const l2NodeWrap = document.createElement('div');
      const l2Header = document.createElement('div');
      l2Header.className = 'tree-l2';
      const arrow2 = Object.assign(document.createElement('span'), { className: 'toggle-arrow', textContent: '▶' });
      const cb2 = Object.assign(document.createElement('input'), { type: 'checkbox' });
      cb2.dataset.role = 'l2';
      const lbl2 = Object.assign(document.createElement('span'), { textContent: `${l2.name} (${l2.children.length})` });
      l2Header.append(arrow2, cb2, lbl2);

      const l3Wrap = Object.assign(document.createElement('div'), { className: 'tree-l3-wrap' });
      let l2HasMatch = false;
      for (const l3 of l2.children) {
        if (flo && l3.name.toLowerCase().indexOf(flo) === -1) continue;
        l2HasMatch = true;
        const l3Node = document.createElement('div'); l3Node.className = 'tree-l3';
        const cb3 = Object.assign(document.createElement('input'), { type: 'checkbox' });
        cb3.dataset.role = 'l3';
        cb3.dataset.code = l3.code;
        cb3.checked = sel.positions.has(l3.code);
        cb3.addEventListener('change', () => {
          if (cb3.checked) sel.positions.add(l3.code);
          else sel.positions.delete(l3.code);
          updateSelCounts(); syncParentChecks();
        });
        const lab = document.createElement('label');
        lab.append(cb3, document.createTextNode(' ' + l3.name));
        l3Node.append(lab);
        l3Wrap.append(l3Node);
      }
      if (l2HasMatch) {
        l2Header.addEventListener('click', (e) => {
          if (e.target.tagName === 'INPUT') return;
          arrow2.classList.toggle('open'); l3Wrap.classList.toggle('open');
        });
        cb2.addEventListener('change', () => {
          l3Wrap.querySelectorAll('input[data-role="l3"]').forEach((cb) => {
            cb.checked = cb2.checked;
            if (cb2.checked) sel.positions.add(cb.dataset.code);
            else sel.positions.delete(cb.dataset.code);
          });
          updateSelCounts(); syncParentChecks();
        });
        l2NodeWrap.append(l2Header, l3Wrap);
        l2Wrap.append(l2NodeWrap);
        if (flo) { arrow2.classList.add('open'); l3Wrap.classList.add('open'); }
        l1HasMatch = true;
      }
    }
    if (l1HasMatch) {
      l1Header.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT') return;
        arrow1.classList.toggle('open'); l2Wrap.classList.toggle('open');
      });
      cb1.addEventListener('change', () => {
        l2Wrap.querySelectorAll('input[data-role="l3"]').forEach((cb) => {
          cb.checked = cb1.checked;
          if (cb1.checked) sel.positions.add(cb.dataset.code);
          else sel.positions.delete(cb.dataset.code);
        });
        l2Wrap.querySelectorAll('input[data-role="l2"]').forEach((cb) => cb.checked = cb1.checked);
        updateSelCounts();
      });
      l1Wrap.append(l1Header, l2Wrap);
      root.append(l1Wrap);
      if (flo) { arrow1.classList.add('open'); l2Wrap.classList.add('open'); }
    }
  }
  syncParentChecks();
}
function syncParentChecks() {
  document.querySelectorAll('input[data-role="l2"]').forEach((cb) => {
    const wrap = cb.closest('.tree-l2').parentElement.querySelector('.tree-l3-wrap');
    if (!wrap) return;
    const l3s = wrap.querySelectorAll('input[data-role="l3"]');
    const total = l3s.length;
    let n = 0; l3s.forEach((c) => { if (c.checked) n++; });
    cb.checked = total > 0 && n === total;
    cb.indeterminate = n > 0 && n < total;
  });
  document.querySelectorAll('input[data-role="l1"]').forEach((cb) => {
    const wrap = cb.closest('.tree-l1').parentElement.querySelector('.tree-l2-wrap');
    if (!wrap) return;
    const l3s = wrap.querySelectorAll('input[data-role="l3"]');
    const total = l3s.length;
    let n = 0; l3s.forEach((c) => { if (c.checked) n++; });
    cb.checked = total > 0 && n === total;
    cb.indeterminate = n > 0 && n < total;
  });
}

function renderCityGrid(filter = '') {
  const root = $('cityGrid'); root.innerHTML = '';
  const all = [];
  for (const c of DICT.cities.hot) all.push(c);
  for (const g of DICT.cities.byLetter) for (const c of g.cities) all.push(c);
  const seen = new Set();
  const uniq = [];
  for (const c of all) { if (seen.has(c.code)) continue; seen.add(c.code); uniq.push(c); }
  for (const c of uniq) {
    if (filter && c.name.indexOf(filter) === -1) continue;
    const lbl = document.createElement('label');
    const cb = Object.assign(document.createElement('input'), { type: 'checkbox' });
    cb.dataset.code = c.code;
    cb.dataset.name = c.name;
    cb.checked = sel.cities.has(c.code);
    cb.addEventListener('change', () => {
      if (cb.checked) sel.cities.add(c.code); else sel.cities.delete(c.code);
      updateSelCounts();
    });
    lbl.append(cb, document.createTextNode(' ' + c.name));
    root.append(lbl);
  }
}

function fillFilters() {
  const fill = (el, items, defaultCode) => {
    for (const x of items) {
      if (x.code === 0) continue;
      const opt = document.createElement('option');
      opt.value = x.code; opt.textContent = x.name;
      if (defaultCode && x.code === defaultCode) opt.selected = true;
      el.appendChild(opt);
    }
  };
  fill($('filterExp'), DICT.filters.experiences);
  fill($('filterDeg'), DICT.filters.degrees);
  fill($('filterSalary'), DICT.filters.salaries);
}

function updateSelCounts() {
  $('selPosCount').textContent = sel.positions.size;
  $('selCityCount').textContent = sel.cities.size;
  const combo = (sel.positions.size + keywords.length) * sel.cities.size;
  $('comboCount').textContent = combo;
  const m = combo * 4;
  $('comboEst').textContent = combo > 0
    ? `· 预计 ${m < 60 ? m + ' 分钟' : (m / 60).toFixed(1) + ' 小时'}`
    : '';
}

// ─────────────────────── 预设 ───────────────────────
async function refreshPresetDropdown() {
  const r = await chrome.runtime.sendMessage({ type: 'list_presets' });
  const presets = (r && r.ok) ? r.presets : {};
  const dd = $('presetSelect');
  // 清空保留第一项
  while (dd.options.length > 1) dd.remove(1);
  for (const name of Object.keys(presets)) {
    const opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    dd.appendChild(opt);
  }
}
function snapshotConfig() {
  return {
    keywords: [...keywords],
    positions: [...sel.positions],
    cities: [...sel.cities],
    filterExp: $('filterExp').value,
    filterDeg: $('filterDeg').value,
    filterSalary: $('filterSalary').value,
    filterDate: $('filterDate').value,
    filterCompany: $('filterCompany').value,
    sortMode: $('sortMode').value,
    runMode: $('runMode').value,
    maxScrolls: parseInt($('maxScrolls').value) || 15,
    maxTotal: parseInt($('maxTotal').value) || 0,
    dwellMin: parseFloat($('dwellMin').value) || 2,
    dwellMax: parseFloat($('dwellMax').value) || 5,
    gapMin: parseFloat($('gapMin').value) || 10,
    gapMax: parseFloat($('gapMax').value) || 25,
  };
}
function applySnapshot(s) {
  keywords = Array.isArray(s.keywords) ? s.keywords : [];
  sel.positions.clear(); (s.positions || []).forEach((p) => sel.positions.add(p));
  sel.cities.clear(); (s.cities || []).forEach((c) => sel.cities.add(c));
  $('filterExp').value = s.filterExp || '';
  $('filterDeg').value = s.filterDeg || '';
  $('filterSalary').value = s.filterSalary || '';
  $('filterDate').value = s.filterDate || '';
  $('filterCompany').value = s.filterCompany || '';
  $('sortMode').value = s.sortMode || 'newest';
  $('runMode').value = s.runMode || 'window_isolated';
  $('maxScrolls').value = s.maxScrolls || 15;
  $('maxTotal').value = s.maxTotal || 0;
  $('dwellMin').value = s.dwellMin || 2;
  $('dwellMax').value = s.dwellMax || 5;
  $('gapMin').value = s.gapMin || 10;
  $('gapMax').value = s.gapMax || 25;
  renderKeywordChips();
  renderPositionTree($('qfPos').value);
  renderCityGrid($('qfCity').value);
  updateSelCounts();
}

$('savePreset').addEventListener('click', async () => {
  const name = $('presetName').value.trim();
  if (!name) { alert('给配置起个名字'); return; }
  await chrome.runtime.sendMessage({ type: 'save_preset', name, config: snapshotConfig() });
  appendLog(`✓ 已保存预设「${name}」`);
  await refreshPresetDropdown();
  $('presetName').value = '';
});
$('loadPreset').addEventListener('click', async () => {
  const name = $('presetSelect').value;
  if (!name) { alert('选一个预设'); return; }
  const r = await chrome.runtime.sendMessage({ type: 'load_preset', name });
  if (r.ok) { applySnapshot(r.config); appendLog(`✓ 已载入「${name}」`); }
  else alert(r.error);
});
$('deletePreset').addEventListener('click', async () => {
  const name = $('presetSelect').value;
  if (!name) { alert('选一个预设再删'); return; }
  if (!confirm(`删除预设「${name}」?`)) return;
  await chrome.runtime.sendMessage({ type: 'delete_preset', name });
  await refreshPresetDropdown();
});

// ─────────────────────── 生成队列 ───────────────────────
async function buildTasksAndSave() {
  if (sel.positions.size === 0 && keywords.length === 0) {
    alert('请至少选 1 个职位 或 加 1 个关键词');
    return;
  }
  if (sel.cities.size === 0) {
    alert('请至少选 1 个城市');
    return;
  }
  const posMap = new Map();
  for (const l1 of DICT.positions) for (const l2 of l1.children) for (const l3 of l2.children) {
    posMap.set(l3.code, l3.name);
  }
  const cityMap = new Map();
  for (const c of DICT.cities.hot) cityMap.set(c.code, c.name);
  for (const g of DICT.cities.byLetter) for (const c of g.cities) cityMap.set(c.code, c.name);

  const filterExp = $('filterExp').value;
  const filterDeg = $('filterDeg').value;
  const filterSalary = $('filterSalary').value;
  const filterDate = $('filterDate').value;

  const tasks = [];
  for (const p of sel.positions) {
    for (const c of sel.cities) {
      tasks.push({
        positionCode: p, positionName: posMap.get(p) || String(p),
        cityCode: c, cityName: cityMap.get(c) || String(c),
        experience: filterExp, degree: filterDeg, salary: filterSalary, dateType: filterDate,
      });
    }
  }
  for (const q of keywords) {
    for (const c of sel.cities) {
      tasks.push({
        query: q, positionName: `[关键词] ${q}`,
        cityCode: c, cityName: cityMap.get(c) || String(c),
        experience: filterExp, degree: filterDeg, salary: filterSalary, dateType: filterDate,
      });
    }
  }
  const pc = {
    tasks,
    sortMode: $('sortMode').value,
    runMode: $('runMode').value,
    maxScrolls: parseInt($('maxScrolls').value) || 15,
    maxTotal: parseInt($('maxTotal').value) || 0,
    dwellMin: parseFloat($('dwellMin').value) || 2,
    dwellMax: parseFloat($('dwellMax').value) || 5,
    gapMin: parseFloat($('gapMin').value) || 10,
    gapMax: parseFloat($('gapMax').value) || 25,
    companyFilter: $('filterCompany').value.trim(),
  };
  await chrome.storage.local.set({ pendingConfig: pc });
  await chrome.runtime.sendMessage({ type: 'clear_queue' });
  appendLog(`✓ 生成 ${tasks.length} 个任务,切到运行 tab`);
  switchTab('run');
}

$('qfPos').addEventListener('input', (e) => renderPositionTree(e.target.value));
$('qfCity').addEventListener('input', (e) => renderCityGrid(e.target.value));
$('clearPos').addEventListener('click', () => {
  sel.positions.clear();
  document.querySelectorAll('#positionTree input[type=checkbox]').forEach((cb) => {
    cb.checked = false; cb.indeterminate = false;
  });
  updateSelCounts();
});
$('clearCity').addEventListener('click', () => {
  sel.cities.clear();
  document.querySelectorAll('#cityGrid input[type=checkbox]').forEach((cb) => cb.checked = false);
  updateSelCounts();
});
$('genQueue').addEventListener('click', buildTasksAndSave);

// ============================================================
// 运行 tab — pipeline / 分步 / 池 / 结果列表
// ============================================================
function appendLog(msg) {
  const t = new Date().toTimeString().slice(0, 8);
  $('log').textContent += `[${t}] ${msg}\n`;
  $('log').scrollTop = $('log').scrollHeight;
}

async function refreshPool() {
  const r = await chrome.runtime.sendMessage({ type: 'status' });
  if (r && r.ok) $('poolTotal').textContent = r.total;
}

async function refreshQueue() {
  const r = await chrome.runtime.sendMessage({ type: 'get_queue' });
  const list = $('queueMini');
  let q = (r && r.ok) ? r.queue : null;
  if (!q) {
    const pc = (await chrome.storage.local.get('pendingConfig')).pendingConfig;
    if (pc?.tasks?.length) q = { tasks: pc.tasks.map((t, i) => ({ ...t, status: 'pending' })) };
  }
  if (!q || !q.tasks || q.tasks.length === 0) {
    list.innerHTML = '<div style="padding:8px;color:#9ca3af">(尚未生成队列)</div>';
    return;
  }
  list.innerHTML = q.tasks.map((t) =>
    `<div class="queue-row"><span>${t.positionName} @ ${t.cityName}${t.captured ? ` +${t.captured}` : ''}</span>` +
    `<span class="queue-status qs-${t.status}">${t.status}</span></div>`
  ).join('');
}

async function refreshScored() {
  const r = await chrome.runtime.sendMessage({ type: 'list_jobs' });
  const items = (r && r.ok && r.items) ? r.items : [];
  const list = $('scoredList');

  // 按 filter 过滤
  const filtered = items.filter((it) => {
    if (resultFilter === 'all') return it.marked !== 'not_interested';
    if (resultFilter === 'S') return it.score_priority === 'S';
    if (resultFilter === 'A') return it.score_priority === 'A';
    if (resultFilter === 'B') return it.score_priority === 'B';
    if (resultFilter === '未打分') return !it.score_priority;
    if (resultFilter === '已投') return it.marked === 'applied';
    return true;
  });

  if (filtered.length === 0) {
    list.innerHTML = '<div style="padding:8px;color:#9ca3af">(无)</div>';
    $('scoreSummary').textContent = '';
    return;
  }

  list.innerHTML = '';
  const counts = { S: 0, A: 0, B: 0, C: 0, Reject: 0, none: 0 };
  for (const it of items) {
    if (it.marked === 'not_interested') continue;
    const p = it.score_priority || 'none';
    counts[p] = (counts[p] || 0) + 1;
  }
  for (const it of filtered) {
    const prio = it.score_priority || 'none';
    const row = document.createElement('div');
    row.className = 'scored-row' + (it.marked ? ' marked-' + it.marked : '');
    const head = document.createElement('div');
    head.className = 'head';
    head.innerHTML = `
      <span class="score-badge sb-${prio}">${prio === 'none' ? '—' : prio === 'Reject' ? '×' : prio + (it.score ? ' ' + it.score : '')}</span>
      <span class="title">${escapeHtml(it.job_name || '')} <span style="color:#9ca3af">— ${escapeHtml(it.company_name || '')}</span></span>
      <span class="meta">${escapeHtml(it.salary || '')}</span>
    `;
    head.addEventListener('click', () => row.classList.toggle('open'));
    row.appendChild(head);

    const exp = document.createElement('div');
    exp.className = 'expand';
    const reason = it.score_reason ? `<div class="reason">💡 ${escapeHtml(it.score_reason)}</div>` : '';
    const concerns = (it.score_concerns && it.score_concerns.length)
      ? `<div class="concerns">⚠️ ${it.score_concerns.map(escapeHtml).join(' / ')}</div>` : '';
    const pitch = it.score_pitch ? `<div class="pitch">💬 ${escapeHtml(it.score_pitch)}</div>` : '';
    const cityMeta = `<div style="color:#9ca3af;font-size:11px">📍 ${escapeHtml(it.city || '')} ${it.area ? '· ' + escapeHtml(it.area) : ''} ${it.experience ? '· ' + escapeHtml(it.experience) : ''}</div>`;
    exp.innerHTML = reason + concerns + pitch + cityMeta;

    const actions = document.createElement('div');
    actions.className = 'actions';
    const openBtn = document.createElement('button');
    openBtn.className = 'outline'; openBtn.textContent = '🔗 打开';
    openBtn.addEventListener('click', (e) => { e.stopPropagation(); if (it.job_url) chrome.tabs.create({ url: it.job_url }); });
    const applyBtn = document.createElement('button');
    applyBtn.className = it.marked === 'applied' ? 'green' : 'outline';
    applyBtn.textContent = it.marked === 'applied' ? '✓ 已投' : '标记已投';
    applyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await chrome.runtime.sendMessage({ type: 'mark_job', job_id: it.job_id, mark: it.marked === 'applied' ? null : 'applied' });
      refreshScored();
    });
    const skipBtn = document.createElement('button');
    skipBtn.className = 'red';
    skipBtn.textContent = '🚫 屏蔽公司';
    skipBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`屏蔽「${it.company_name}」的全部岗位?`)) return;
      await chrome.runtime.sendMessage({ type: 'mark_job', job_id: it.job_id, mark: 'not_interested', block_company: true });
      refreshScored();
    });
    if (it.score_pitch) {
      const copyBtn = document.createElement('button');
      copyBtn.className = 'outline';
      copyBtn.textContent = '📋 复制话术';
      copyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await navigator.clipboard.writeText(it.score_pitch);
        copyBtn.textContent = '✓ 已复制';
        setTimeout(() => { copyBtn.textContent = '📋 复制话术'; }, 1500);
      });
      actions.appendChild(copyBtn);
    }
    actions.append(openBtn, applyBtn, skipBtn);
    exp.appendChild(actions);
    row.appendChild(exp);
    list.appendChild(row);
  }
  const sum = [];
  if (counts.S) sum.push(`S=${counts.S}`);
  if (counts.A) sum.push(`A=${counts.A}`);
  if (counts.B) sum.push(`B=${counts.B}`);
  if (counts.C) sum.push(`C=${counts.C}`);
  if (counts.Reject) sum.push(`R=${counts.Reject}`);
  if (counts.none) sum.push(`未打分=${counts.none}`);
  $('scoreSummary').textContent = `池中 ${items.length} 条(已屏蔽不计) · ${sum.join(' / ')}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 结果过滤 chips
document.querySelectorAll('#resultFilters .fchip').forEach((c) => {
  c.addEventListener('click', () => {
    document.querySelectorAll('#resultFilters .fchip').forEach((x) => x.classList.remove('active'));
    c.classList.add('active');
    resultFilter = c.dataset.filter;
    refreshScored();
  });
});

// ─────────────────────── Pipeline 按钮 ───────────────────────
// 每日自动跑 toggle
async function loadAutoDaily() {
  const r = await chrome.runtime.sendMessage({ type: 'get_auto_daily' });
  const s = (r && r.ok) ? r.autoDaily : { enabled: false, hour: 9 };
  $('autoDaily').checked = !!s.enabled;
  $('autoDailyHour').value = typeof s.hour === 'number' ? s.hour : 9;
}
async function saveAutoDaily() {
  const enabled = $('autoDaily').checked;
  const hour = parseInt($('autoDailyHour').value) || 9;
  await chrome.runtime.sendMessage({ type: 'save_auto_daily', autoDaily: { enabled, hour } });
  appendLog(enabled ? `✓ 每日自动跑已开启 (${hour}:00 起检测)` : '✓ 已关闭每日自动跑');
}
$('autoDaily').addEventListener('change', saveAutoDaily);
$('autoDailyHour').addEventListener('change', saveAutoDaily);

$('runPipeline').addEventListener('click', async () => {
  const pc = (await chrome.storage.local.get('pendingConfig')).pendingConfig;
  if (!pc?.tasks?.length) {
    if (!confirm('当前没有待跑队列。继续会跳过采集,直接打分 + 推送数据池里已有的(可能空)。继续?')) return;
  }
  appendLog('🚀 一键流水线启动');
  const r = await chrome.runtime.sendMessage({ type: 'run_pipeline', config: pc || null });
  if (!r.ok) appendLog(`✗ ${r.error}`);
});
$('stopPipeline').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'stop' });
  await chrome.runtime.sendMessage({ type: 'stop_pipeline' });
  appendLog('■ 停止信号已发送');
});

// 分步按钮
$('startCrawl').addEventListener('click', async () => {
  const pc = (await chrome.storage.local.get('pendingConfig')).pendingConfig;
  if (!pc?.tasks?.length) { alert('先在「搜索」tab 生成队列'); return; }
  const r = await chrome.runtime.sendMessage({ type: 'start', config: { ...pc, resume: false } });
  if (!r.ok) appendLog(`✗ ${r.error}`);
});
$('resumeCrawl').addEventListener('click', async () => {
  const pc = (await chrome.storage.local.get('pendingConfig')).pendingConfig;
  const r = await chrome.runtime.sendMessage({ type: 'start', config: { ...(pc || {}), resume: true } });
  if (!r.ok) appendLog(`✗ ${r.error}`);
});
$('stopCrawl').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'stop' });
  appendLog('■ 停止信号已发送');
});
$('scoreAll').addEventListener('click', async () => {
  appendLog('▶ 开始打分...');
  const r = await chrome.runtime.sendMessage({ type: 'score_all' });
  if (r.ok) { appendLog(`✓ 打分: 新增 ${r.scored} 跳过 ${r.skipped}`); refreshScored(); }
  else appendLog(`✗ ${r.error}`);
});
$('pushNow').addEventListener('click', async () => {
  appendLog('▶ 准备推送...');
  const r = await chrome.runtime.sendMessage({ type: 'push_now' });
  if (r.ok) appendLog(`✓ 推送: ${r.total} 条 (S=${r.counts.S} A=${r.counts.A} B=${r.counts.B})`);
  else appendLog(`✗ ${r.error}`);
});
$('exportJobRadar').addEventListener('click', async () => {
  const r = await chrome.runtime.sendMessage({ type: 'export_jobradar' });
  if (r.ok) appendLog(`✓ 导出 ${r.count} 条 → ${r.filename}`);
  else appendLog(`✗ ${r.error}`);
});
$('exportCsv').addEventListener('click', async () => {
  const r = await chrome.runtime.sendMessage({ type: 'export' });
  if (r.ok) appendLog(`✓ 导出 ${r.count} 条`);
  else appendLog(`✗ ${r.error}`);
});
$('clearPool').addEventListener('click', async () => {
  if (!confirm('清空数据池?所有未投递的岗位会丢')) return;
  await chrome.runtime.sendMessage({ type: 'clear' });
  appendLog('✓ 数据池已清空');
  refreshAll();
});

// ============================================================
// 历史 tab
// ============================================================
async function refreshHistory() {
  const r = await chrome.runtime.sendMessage({ type: 'list_history' });
  const items = (r && r.ok) ? r.history : [];
  const list = $('historyList');
  if (items.length === 0) {
    list.textContent = '(暂无)'; list.className = 'muted';
    return;
  }
  list.className = '';
  list.innerHTML = items.slice().reverse().map((h) => `
    <div class="history-row">
      <span class="history-date">${h.date}</span>
      <span class="history-stats">推送 ${h.pushed_total} · S=${h.S} A=${h.A} B=${h.B}</span>
    </div>
  `).join('');
}

async function refreshBlocked() {
  const r = await chrome.runtime.sendMessage({ type: 'list_blocked' });
  const items = (r && r.ok) ? r.blocked : [];
  const list = $('blockedList');
  if (items.length === 0) {
    list.textContent = '(无)'; list.className = 'muted';
    return;
  }
  list.className = '';
  list.innerHTML = items.map((b) => `
    <div class="history-row">
      <span>${escapeHtml(b.company_name)}</span>
      <button class="outline small" data-cid="${escapeHtml(b.company_id)}">取消屏蔽</button>
    </div>
  `).join('');
  list.querySelectorAll('button[data-cid]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'unblock_company', company_id: btn.dataset.cid });
      refreshBlocked();
      refreshScored();
    });
  });
}

$('rescoreAll').addEventListener('click', async () => {
  if (!confirm('清空全部打分结果,重新打分?')) return;
  await chrome.runtime.sendMessage({ type: 'clear_scores' });
  const r = await chrome.runtime.sendMessage({ type: 'score_all' });
  if (r.ok) { appendLog(`✓ 重打分: ${r.scored} 条`); refreshScored(); }
  else appendLog(`✗ ${r.error}`);
});
$('clearHistory').addEventListener('click', async () => {
  if (!confirm('清空历史日报?')) return;
  await chrome.runtime.sendMessage({ type: 'clear_history' });
  refreshHistory();
});

// ============================================================
// background 推送的消息
// ============================================================
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'progress') appendLog(msg.msg);
  else if (msg.type === 'score_progress') $('progress').textContent = `打分中 ${msg.done}/${msg.total}`;
  else if (msg.type === 'pipeline_progress') {
    if (msg.stage) appendLog(`▶ ${msg.stage}`);
    refreshPipelineState();
  } else if (msg.type === 'done') {
    refreshAll();
  }
});

function bindEvents() {
  // no-op,事件已挂在 init 之外
}
init();
