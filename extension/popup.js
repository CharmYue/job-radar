// ============================================================
// popup.js — Boss 求职雷达 (采集 + 打分 + 推送)
// ============================================================

const $ = (id) => document.getElementById(id);

// 全局: 字典 + 当前选择
let DICT = null;
const sel = {
  positions: new Set(),
  cities: new Set(),
};

// ============================================================
// 字典
// ============================================================
async function loadDict() {
  const url = chrome.runtime.getURL('dict.json');
  const r = await fetch(url);
  DICT = await r.json();
}

// ============================================================
// Tabs
// ============================================================
document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    $('panel-' + t.dataset.panel).classList.add('active');
    if (t.dataset.panel === 'queue') refreshQueue();
    if (t.dataset.panel === 'run') { refreshStatus(); refreshScored(); }
    if (t.dataset.panel === 'profile') loadProfileIntoUI();
  });
});

// ============================================================
// 渲染职位树
// ============================================================
function renderPositionTree(filter = '') {
  const root = $('positionTree');
  root.innerHTML = '';
  const flo = filter.toLowerCase();

  for (const l1 of DICT.positions) {
    const l1Wrap = document.createElement('div');
    const l1Header = document.createElement('div');
    l1Header.className = 'tree-l1';
    const arrow1 = document.createElement('span');
    arrow1.className = 'toggle-arrow';
    arrow1.textContent = '▶';
    l1Header.appendChild(arrow1);

    const cb1 = document.createElement('input');
    cb1.type = 'checkbox';
    cb1.dataset.role = 'l1';
    cb1.dataset.code = l1.code;
    l1Header.appendChild(cb1);

    const lbl1 = document.createElement('span');
    lbl1.textContent = l1.name;
    l1Header.appendChild(lbl1);

    const cnt1 = document.createElement('span');
    cnt1.className = 'count';
    let l3TotalInL1 = 0;
    for (const l2 of l1.children) l3TotalInL1 += l2.children.length;
    cnt1.textContent = `${l3TotalInL1} 个`;
    l1Header.appendChild(cnt1);

    const l2Wrap = document.createElement('div');
    l2Wrap.className = 'tree-l2-wrap';

    let l1HasMatch = false;
    for (const l2 of l1.children) {
      const l2NodeWrap = document.createElement('div');
      const l2Header = document.createElement('div');
      l2Header.className = 'tree-l2';
      const arrow2 = document.createElement('span');
      arrow2.className = 'toggle-arrow';
      arrow2.textContent = '▶';
      l2Header.appendChild(arrow2);
      const cb2 = document.createElement('input');
      cb2.type = 'checkbox';
      cb2.dataset.role = 'l2';
      cb2.dataset.code = l2.code;
      l2Header.appendChild(cb2);
      const lbl2 = document.createElement('span');
      lbl2.textContent = `${l2.name} (${l2.children.length})`;
      l2Header.appendChild(lbl2);

      const l3Wrap = document.createElement('div');
      l3Wrap.className = 'tree-l3-wrap';

      let l2HasMatch = false;
      for (const l3 of l2.children) {
        if (flo && l3.name.toLowerCase().indexOf(flo) === -1) continue;
        l2HasMatch = true;
        const l3Node = document.createElement('div');
        l3Node.className = 'tree-l3';
        const cb3 = document.createElement('input');
        cb3.type = 'checkbox';
        cb3.dataset.role = 'l3';
        cb3.dataset.code = l3.code;
        cb3.dataset.name = l3.name;
        cb3.checked = sel.positions.has(l3.code);
        cb3.addEventListener('change', () => {
          if (cb3.checked) sel.positions.add(l3.code);
          else sel.positions.delete(l3.code);
          updateSelCounts();
          syncParentChecks();
        });
        const lab = document.createElement('label');
        lab.appendChild(cb3);
        lab.appendChild(document.createTextNode(' ' + l3.name));
        l3Node.appendChild(lab);
        l3Wrap.appendChild(l3Node);
      }

      if (l2HasMatch) {
        l2Header.addEventListener('click', (e) => {
          if (e.target.tagName === 'INPUT') return;
          arrow2.classList.toggle('open');
          l3Wrap.classList.toggle('open');
        });
        cb2.addEventListener('change', () => {
          l3Wrap.querySelectorAll('input[data-role="l3"]').forEach((cb) => {
            cb.checked = cb2.checked;
            if (cb2.checked) sel.positions.add(cb.dataset.code);
            else sel.positions.delete(cb.dataset.code);
          });
          updateSelCounts();
          syncParentChecks();
        });
        l2NodeWrap.appendChild(l2Header);
        l2NodeWrap.appendChild(l3Wrap);
        l2Wrap.appendChild(l2NodeWrap);
        if (flo) { arrow2.classList.add('open'); l3Wrap.classList.add('open'); }
        l1HasMatch = true;
      }
    }

    if (l1HasMatch) {
      l1Header.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT') return;
        arrow1.classList.toggle('open');
        l2Wrap.classList.toggle('open');
      });
      cb1.addEventListener('change', () => {
        l2Wrap.querySelectorAll('input[data-role="l3"]').forEach((cb) => {
          cb.checked = cb1.checked;
          if (cb1.checked) sel.positions.add(cb.dataset.code);
          else sel.positions.delete(cb.dataset.code);
        });
        l2Wrap.querySelectorAll('input[data-role="l2"]').forEach((cb) => {
          cb.checked = cb1.checked;
        });
        updateSelCounts();
      });
      l1Wrap.appendChild(l1Header);
      l1Wrap.appendChild(l2Wrap);
      root.appendChild(l1Wrap);
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
    let checked = 0;
    l3s.forEach((c) => { if (c.checked) checked++; });
    cb.checked = total > 0 && checked === total;
    cb.indeterminate = checked > 0 && checked < total;
  });
  document.querySelectorAll('input[data-role="l1"]').forEach((cb) => {
    const wrap = cb.closest('.tree-l1').parentElement.querySelector('.tree-l2-wrap');
    if (!wrap) return;
    const l3s = wrap.querySelectorAll('input[data-role="l3"]');
    const total = l3s.length;
    let checked = 0;
    l3s.forEach((c) => { if (c.checked) checked++; });
    cb.checked = total > 0 && checked === total;
    cb.indeterminate = checked > 0 && checked < total;
  });
}

// ============================================================
// 渲染城市
// ============================================================
function renderCityGrid(filter = '') {
  const root = $('cityGrid');
  root.innerHTML = '';
  const flo = filter.toLowerCase();

  const all = [];
  for (const c of DICT.cities.hot) all.push(c);
  for (const g of DICT.cities.byLetter) {
    for (const c of g.cities) all.push(c);
  }
  const seen = new Set();
  const uniq = [];
  for (const c of all) {
    if (seen.has(c.code)) continue;
    seen.add(c.code);
    uniq.push(c);
  }
  for (const c of uniq) {
    if (flo && c.name.indexOf(filter) === -1) continue;
    const lbl = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.code = c.code;
    cb.dataset.name = c.name;
    cb.checked = sel.cities.has(c.code);
    cb.addEventListener('change', () => {
      if (cb.checked) sel.cities.add(c.code);
      else sel.cities.delete(c.code);
      updateSelCounts();
    });
    lbl.appendChild(cb);
    lbl.appendChild(document.createTextNode(' ' + c.name));
    root.appendChild(lbl);
  }
}

// ============================================================
// 填充筛选下拉 (经验 / 学历 / 薪资)
// ============================================================
function fillFilters() {
  const exp = $('filterExp');
  for (const e of DICT.filters.experiences) {
    if (e.code === 0) continue;
    const opt = document.createElement('option');
    opt.value = e.code;
    opt.textContent = e.name;
    exp.appendChild(opt);
  }
  const deg = $('filterDeg');
  for (const d of DICT.filters.degrees) {
    if (d.code === 0) continue;
    const opt = document.createElement('option');
    opt.value = d.code;
    opt.textContent = d.name;
    deg.appendChild(opt);
  }
  const sal = $('filterSalary');
  for (const s of DICT.filters.salaries) {
    if (s.code === 0) continue;
    const opt = document.createElement('option');
    opt.value = s.code;
    opt.textContent = s.name;
    sal.appendChild(opt);
  }
}

// ============================================================
// 选择数 + 组合估算
// ============================================================
function customQueryList() {
  return $('customQueries').value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function updateSelCounts() {
  $('selPosCount').textContent = sel.positions.size;
  $('selCityCount').textContent = sel.cities.size;
  const customs = customQueryList().length;
  const combo = (sel.positions.size + customs) * sel.cities.size;
  $('comboCount').textContent = combo;
  const minutes = combo * 4;
  let est;
  if (minutes < 60) est = `≈ ${minutes} 分钟`;
  else if (minutes < 60 * 24) est = `≈ ${(minutes/60).toFixed(1)} 小时`;
  else est = `≈ ${(minutes/60/24).toFixed(1)} 天`;
  $('comboEst').textContent = combo > 0 ? `(预计 ${est})` : '';
}

// ============================================================
// 生成任务队列
// ============================================================
async function buildTasksAndSave() {
  const customs = customQueryList();
  if (sel.positions.size === 0 && customs.length === 0) {
    alert('请至少选 1 个职位 或 填 1 行关键词');
    return;
  }
  if (sel.cities.size === 0) {
    alert('请至少选 1 个城市');
    return;
  }

  const posMap = new Map();
  for (const l1 of DICT.positions) {
    for (const l2 of l1.children) {
      for (const l3 of l2.children) {
        posMap.set(l3.code, l3.name);
      }
    }
  }
  const cityMap = new Map();
  for (const c of DICT.cities.hot) cityMap.set(c.code, c.name);
  for (const g of DICT.cities.byLetter) {
    for (const c of g.cities) cityMap.set(c.code, c.name);
  }

  const filterExp = $('filterExp').value;
  const filterDeg = $('filterDeg').value;
  const filterSalary = $('filterSalary').value;
  const filterDate = $('filterDate').value;

  const tasks = [];
  // 1. 职位树任务
  for (const p of sel.positions) {
    for (const c of sel.cities) {
      tasks.push({
        positionCode: p,
        positionName: posMap.get(p) || String(p),
        cityCode: c,
        cityName: cityMap.get(c) || String(c),
        experience: filterExp || '',
        degree: filterDeg || '',
        salary: filterSalary || '',
        dateType: filterDate || '',
      });
    }
  }
  // 2. 自由关键词任务
  for (const q of customs) {
    for (const c of sel.cities) {
      tasks.push({
        query: q,
        positionName: `[关键词] ${q}`,
        cityCode: c,
        cityName: cityMap.get(c) || String(c),
        experience: filterExp || '',
        degree: filterDeg || '',
        salary: filterSalary || '',
        dateType: filterDate || '',
      });
    }
  }

  await chrome.storage.local.set({
    pendingConfig: {
      tasks,
      sortMode:   $('sortMode').value,
      runMode:    $('runMode').value,
      maxScrolls: parseInt($('maxScrolls').value) || 15,
      maxTotal:   parseInt($('maxTotal').value) || 0,
      dwellMin:   parseFloat($('dwellMin').value) || 2,
      dwellMax:   parseFloat($('dwellMax').value) || 5,
      gapMin:     parseFloat($('gapMin').value)   || 10,
      gapMax:     parseFloat($('gapMax').value)   || 25,
      companyFilter: $('filterCompany').value.trim(),
    },
  });

  alert(`已生成 ${tasks.length} 个任务,切到"运行"标签点开始`);
  document.querySelector('.tab[data-panel="queue"]').click();
  await chrome.runtime.sendMessage({ type: 'clear_queue' });
}

// ============================================================
// 队列面板
// ============================================================
async function refreshQueue() {
  const r = await chrome.runtime.sendMessage({ type: 'get_queue' });
  const list = $('queueList');
  let q = r && r.ok ? r.queue : null;

  if (!q) {
    const pc = (await chrome.storage.local.get('pendingConfig')).pendingConfig;
    if (pc && pc.tasks && pc.tasks.length) {
      q = {
        tasks: pc.tasks.map((t, i) => ({
          ...t, id: i, status: 'pending', captured: 0,
        })),
      };
    }
  }

  if (!q || !q.tasks || q.tasks.length === 0) {
    list.textContent = '(尚未生成队列)';
    $('qTotal').textContent = '0';
    $('qDone').textContent = '0';
    $('qFail').textContent = '0';
    $('qPending').textContent = '0';
    return;
  }

  list.innerHTML = '';
  let nDone = 0, nFail = 0, nPending = 0;
  for (const t of q.tasks) {
    const row = document.createElement('div');
    row.className = 'queue-row';
    const left = document.createElement('span');
    left.textContent = `${t.positionName} @ ${t.cityName}` +
      (t.experience ? ` exp=${t.experience}` : '') +
      (t.captured > 0 ? `  +${t.captured}` : '');
    const right = document.createElement('span');
    right.className = 'queue-status qs-' + t.status;
    right.textContent = t.status;
    row.appendChild(left);
    row.appendChild(right);
    list.appendChild(row);

    if (t.status === 'done') nDone++;
    else if (t.status === 'failed' || t.status === 'failed_skipped') nFail++;
    else if (t.status === 'pending') nPending++;
  }
  $('qTotal').textContent = q.tasks.length;
  $('qDone').textContent = nDone;
  $('qFail').textContent = nFail;
  $('qPending').textContent = nPending;
}

// ============================================================
// 运行面板
// ============================================================
function appendLog(msg) {
  const t = new Date().toTimeString().slice(0, 8);
  $('log').textContent += `[${t}] ${msg}\n`;
  $('log').scrollTop = $('log').scrollHeight;
}

function setRunning(running) {
  $('state').textContent = running ? '运行中' : '空闲';
  $('state').style.background = running ? '#2a9d4a' : '#1d3557';
  $('start').disabled = running;
  $('resume').disabled = running;
  $('stop').disabled = !running;
}

async function refreshStatus() {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'status' });
    if (r && r.ok) {
      $('total').textContent = `${r.total} 条`;
      setRunning(r.running);
      if (r.running && r.progress) {
        const p = r.progress;
        $('progress').textContent = `[${p.ki}/${p.kt} | R${p.p} | +${p.added}]`;
      } else {
        $('progress').textContent = '';
      }
    }
  } catch (e) {}
}

async function refreshScored() {
  const r = await chrome.runtime.sendMessage({ type: 'list_jobs' });
  const list = $('scoredList');
  list.innerHTML = '';
  if (!r || !r.ok || !r.items || r.items.length === 0) {
    list.innerHTML = '<div style="padding:8px;color:#999">(数据池为空)</div>';
    $('scoreSummary').textContent = '';
    return;
  }
  const counts = { S: 0, A: 0, B: 0, C: 0, Reject: 0, none: 0 };
  for (const item of r.items) {
    const prio = item.score_priority || 'none';
    counts[prio] = (counts[prio] || 0) + 1;
    const row = document.createElement('div');
    row.className = 'scored-row';
    const badge = document.createElement('span');
    badge.className = 'score-badge sb-' + prio;
    badge.textContent = prio === 'none' ? '--' :
      prio === 'Reject' ? 'X' :
      `${prio}${item.score ? ' ' + item.score : ''}`;
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = `${item.job_name} — ${item.company_name}`;
    title.title = `${item.job_name}\n${item.company_name}\n${(item.score_reason || '')}`;
    if (item.job_url) {
      title.style.cursor = 'pointer';
      title.style.textDecoration = 'underline dotted';
      title.addEventListener('click', () => {
        chrome.tabs.create({ url: item.job_url });
      });
    }
    const salary = document.createElement('span');
    salary.className = 'salary';
    salary.textContent = item.salary || '';
    row.appendChild(badge);
    row.appendChild(title);
    row.appendChild(salary);
    list.appendChild(row);
  }
  const summaryParts = [];
  if (counts.S) summaryParts.push(`S=${counts.S}`);
  if (counts.A) summaryParts.push(`A=${counts.A}`);
  if (counts.B) summaryParts.push(`B=${counts.B}`);
  if (counts.C) summaryParts.push(`C=${counts.C}`);
  if (counts.Reject) summaryParts.push(`R=${counts.Reject}`);
  if (counts.none) summaryParts.push(`未打分=${counts.none}`);
  $('scoreSummary').textContent = `共 ${r.items.length} 条 · ` + summaryParts.join(' / ');
}

async function doStart(resume) {
  const pc = (await chrome.storage.local.get('pendingConfig')).pendingConfig;
  if (!pc || !pc.tasks || pc.tasks.length === 0) {
    if (!resume) {
      alert('请先在"配置"标签生成任务队列');
      return;
    }
  }
  const cfg = { ...(pc || {}), resume };
  const r = await chrome.runtime.sendMessage({ type: 'start', config: cfg });
  if (!r.ok) appendLog(`✗ ${r.error}`);
  else setRunning(true);
}

// ============================================================
// 个人画像 + API key
// ============================================================
function linesToArray(text) {
  return text.split('\n').map((s) => s.trim()).filter(Boolean);
}
function arrayToLines(arr) {
  return (arr || []).join('\n');
}

async function loadProfileIntoUI() {
  const r = await chrome.runtime.sendMessage({ type: 'get_profile' });
  const p = (r && r.ok) ? r.profile : {};
  $('pfSummary').value = p.summary || '';
  $('pfResume').value = p.resume_md || '';
  $('pfMonthlyMin').value = p.target_monthly_min || 30000;
  $('pfMonthlyIdeal').value = p.target_monthly_ideal || 40000;
  $('pfSTier').value = arrayToLines(p.s_tier_roles);
  $('pfATier').value = arrayToLines(p.a_tier_roles);
  $('pfHardReject').value = arrayToLines(p.hard_reject);

  const ar = await chrome.runtime.sendMessage({ type: 'get_api' });
  const a = (ar && ar.ok) ? ar.api : {};
  $('apiDeepseek').value = a.deepseek_key || '';
  $('apiWxToken').value = a.wxpusher_token || '';
  $('apiWxUid').value = a.wxpusher_uid || '';
}

async function saveProfileFromUI() {
  const profile = {
    summary: $('pfSummary').value.trim(),
    resume_md: $('pfResume').value,
    target_monthly_min: parseInt($('pfMonthlyMin').value) || 30000,
    target_monthly_ideal: parseInt($('pfMonthlyIdeal').value) || 40000,
    s_tier_roles: linesToArray($('pfSTier').value),
    a_tier_roles: linesToArray($('pfATier').value),
    hard_reject: linesToArray($('pfHardReject').value),
  };
  const api = {
    deepseek_key: $('apiDeepseek').value.trim(),
    wxpusher_token: $('apiWxToken').value.trim(),
    wxpusher_uid: $('apiWxUid').value.trim(),
  };
  await chrome.runtime.sendMessage({ type: 'save_profile', profile });
  await chrome.runtime.sendMessage({ type: 'save_api', api });
  appendLog('✓ 个人画像 + API key 已保存');
  alert('已保存');
}

// ============================================================
// 启动
// ============================================================
async function init() {
  await loadDict();
  renderPositionTree();
  renderCityGrid();
  fillFilters();
  await refreshStatus();
}
init();

// 接收 background 主动推的 progress 消息
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'progress') {
    appendLog(msg.msg);
  } else if (msg.type === 'score_progress') {
    $('progress').textContent = `打分中 ${msg.done}/${msg.total}`;
  } else if (msg.type === 'done') {
    setRunning(false);
    refreshStatus();
    refreshScored();
  }
});

setInterval(refreshStatus, 2000);

// ============================================================
// 按钮事件
// ============================================================
$('qfPos').addEventListener('input', (e) => renderPositionTree(e.target.value));
$('qfCity').addEventListener('input', (e) => renderCityGrid(e.target.value));
$('customQueries').addEventListener('input', updateSelCounts);

$('clearPos').addEventListener('click', () => {
  sel.positions.clear();
  document.querySelectorAll('#positionTree input[type=checkbox]').forEach((cb) => {
    cb.checked = false;
    cb.indeterminate = false;
  });
  updateSelCounts();
});
$('clearCity').addEventListener('click', () => {
  sel.cities.clear();
  document.querySelectorAll('#cityGrid input[type=checkbox]').forEach((cb) => cb.checked = false);
  updateSelCounts();
});

$('genQueue').addEventListener('click', buildTasksAndSave);

$('start').addEventListener('click', () => doStart(false));
$('resume').addEventListener('click', () => doStart(true));
$('stop').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'stop' });
  appendLog('■ 停止信号已发送');
});

$('scoreAll').addEventListener('click', async () => {
  appendLog('▶ 开始 AI 打分...');
  $('scoreAll').disabled = true;
  const r = await chrome.runtime.sendMessage({ type: 'score_all' });
  $('scoreAll').disabled = false;
  if (r.ok) {
    appendLog(`✓ 打分完成: 新增 ${r.scored} 条 (跳过 ${r.skipped} 条已打分)`);
    refreshScored();
  } else {
    appendLog(`✗ ${r.error}`);
  }
});

$('pushNow').addEventListener('click', async () => {
  appendLog('▶ 准备推送 WxPusher...');
  $('pushNow').disabled = true;
  const r = await chrome.runtime.sendMessage({ type: 'push_now' });
  $('pushNow').disabled = false;
  if (r.ok) {
    appendLog(`✓ 推送成功: ${r.total} 条 (S=${r.counts.S} A=${r.counts.A} B=${r.counts.B})`);
  } else {
    appendLog(`✗ ${r.error}`);
  }
});

$('export').addEventListener('click', async () => {
  const r = await chrome.runtime.sendMessage({ type: 'export' });
  if (r.ok) appendLog(`✓ 已导出 ${r.count} 条`);
  else appendLog(`✗ ${r.error}`);
});

$('exportJobRadar').addEventListener('click', async () => {
  const r = await chrome.runtime.sendMessage({ type: 'export_jobradar' });
  if (r.ok) appendLog(`✓ 已导出 job-radar JSON: ${r.count} 条 → ${r.filename}`);
  else appendLog(`✗ ${r.error}`);
});

$('clear').addEventListener('click', async () => {
  if (!confirm('清空数据池?')) return;
  await chrome.runtime.sendMessage({ type: 'clear' });
  appendLog('✓ 数据池已清空');
  refreshStatus();
  refreshScored();
});

$('clearQueue').addEventListener('click', async () => {
  if (!confirm('清空任务队列?')) return;
  await chrome.runtime.sendMessage({ type: 'clear_queue' });
  await chrome.storage.local.remove('pendingConfig');
  refreshQueue();
});

$('exportQueueState').addEventListener('click', async () => {
  const r = await chrome.runtime.sendMessage({ type: 'get_queue' });
  if (!r.ok || !r.queue) { appendLog('队列为空'); return; }
  const blob = new Blob([JSON.stringify(r.queue, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `boss_queue_${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

$('saveProfile').addEventListener('click', saveProfileFromUI);
$('testPush').addEventListener('click', async () => {
  // 临时保存最新值后调用推送测试
  await saveProfileFromUI();
  const ar = await chrome.runtime.sendMessage({ type: 'get_api' });
  const a = (ar && ar.ok) ? ar.api : {};
  if (!a.wxpusher_token || !a.wxpusher_uid) {
    alert('请先填 WxPusher token + uid'); return;
  }
  // 简单测试推送
  const today = new Date().toISOString().slice(0, 10);
  const md = `## ✅ Boss 雷达 — 推送测试 ${today}\n\n这条来自扩展,如果你收到了说明 WxPusher 配通了。`;
  // 用 push_now 走的是已打分逻辑;这里需要专门的 test push,简化:
  // 临时塞一条假已打分 → 调 push_now 会失败 ("没有已打分"),所以直接走 fetch
  const resp = await fetch('https://wxpusher.zjiecode.com/api/send/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      appToken: a.wxpusher_token,
      content: md,
      contentType: 3,
      summary: '测试推送',
      uids: [a.wxpusher_uid],
    }),
  });
  const data = await resp.json();
  if (data.success) {
    appendLog('✓ 测试推送成功');
    alert('测试推送成功,微信看看');
  } else {
    appendLog(`✗ 测试推送失败: ${JSON.stringify(data)}`);
    alert(`失败: ${JSON.stringify(data)}`);
  }
});
