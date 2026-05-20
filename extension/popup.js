// ============================================================
// popup.js - Boss采集 v2 矩阵版
// ============================================================

const $ = (id) => document.getElementById(id);

// 全局: 字典 + 当前选择状态
let DICT = null;
const sel = {
  positions: new Set(),    // 选中的三级 position code
  cities: new Set(),       // 选中的 city code
};

// ============================================================
// 加载字典
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
    if (t.dataset.panel === 'run') refreshStatus();
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
    // 收集本大类下所有 L3 叶子,看搜索是否命中
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

        const l3Row = document.createElement('div');
        l3Row.className = 'tree-l3';
        const lblL3 = document.createElement('label');
        const cb3 = document.createElement('input');
        cb3.type = 'checkbox';
        cb3.dataset.role = 'l3';
        cb3.dataset.code = l3.code;
        cb3.dataset.name = l3.name;
        cb3.checked = sel.positions.has(l3.code);
        cb3.addEventListener('change', () => {
          if (cb3.checked) sel.positions.add(l3.code);
          else sel.positions.delete(l3.code);
          updatePositionParents();
          updateSelCounts();
        });
        lblL3.appendChild(cb3);
        lblL3.appendChild(document.createTextNode(' ' + l3.name));
        l3Row.appendChild(lblL3);
        l3Wrap.appendChild(l3Row);
      }

      if (!l2HasMatch && flo) continue;
      if (l2HasMatch && flo) {
        // 搜索命中,自动展开
        l3Wrap.classList.add('open');
        arrow2.classList.add('open');
        l1HasMatch = true;
      }

      // L2 checkbox 联动:勾 L2 = 勾下面所有 L3
      cb2.addEventListener('change', () => {
        const checked = cb2.checked;
        l3Wrap.querySelectorAll('input[data-role="l3"]').forEach((b) => {
          b.checked = checked;
          const c = parseInt(b.dataset.code);
          if (checked) sel.positions.add(c); else sel.positions.delete(c);
        });
        updatePositionParents();
        updateSelCounts();
      });

      // L2 展开/收起
      l2Header.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT') return;
        l3Wrap.classList.toggle('open');
        arrow2.classList.toggle('open');
      });

      l2NodeWrap.appendChild(l2Header);
      l2NodeWrap.appendChild(l3Wrap);
      l2Wrap.appendChild(l2NodeWrap);
    }

    if (flo && !l1HasMatch) continue;
    if (flo) {
      l2Wrap.classList.add('open');
      arrow1.classList.add('open');
    }

    // L1 checkbox 联动:勾 L1 = 勾下面所有 L3
    cb1.addEventListener('change', () => {
      const checked = cb1.checked;
      l2Wrap.querySelectorAll('input[data-role="l3"]').forEach((b) => {
        b.checked = checked;
        const c = parseInt(b.dataset.code);
        if (checked) sel.positions.add(c); else sel.positions.delete(c);
      });
      l2Wrap.querySelectorAll('input[data-role="l2"]').forEach((b) => {
        b.checked = checked;
      });
      updateSelCounts();
    });

    // L1 展开/收起
    l1Header.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT') return;
      l2Wrap.classList.toggle('open');
      arrow1.classList.toggle('open');
    });

    l1Wrap.appendChild(l1Header);
    l1Wrap.appendChild(l2Wrap);
    root.appendChild(l1Wrap);
  }

  // 反查父级 checkbox 状态(全部选中→父级勾,部分→中间状态)
  updatePositionParents();
}

function updatePositionParents() {
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
// 渲染城市选择
// ============================================================
function renderCityGrid(filter = '') {
  const root = $('cityGrid');
  root.innerHTML = '';
  const flo = filter.toLowerCase();

  // 热门城市优先 + 全国字母分组
  const all = [];
  for (const c of DICT.cities.hot) all.push(c);
  for (const g of DICT.cities.byLetter) {
    for (const c of g.cities) all.push(c);
  }
  // 去重
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
// 过滤项 (经验 / 学历) 下拉
// ============================================================
function fillFilters() {
  const exp = $('filterExp');
  for (const e of DICT.filters.experiences) {
    if (e.code === 0) continue;  // "不限" 已经在 HTML 里写了
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
}

// ============================================================
// 选择数统计
// ============================================================
function updateSelCounts() {
  $('selPosCount').textContent = sel.positions.size;
  $('selCityCount').textContent = sel.cities.size;
  const combo = sel.positions.size * sel.cities.size;
  $('comboCount').textContent = combo;
  // 估算: 单任务 4 分钟(含间隔),粗略
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
  if (sel.positions.size === 0 || sel.cities.size === 0) {
    alert('请至少选择 1 个职位和 1 个城市');
    return;
  }
  // 找出每个 position code 对应的 name
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

  const tasks = [];
  for (const p of sel.positions) {
    for (const c of sel.cities) {
      tasks.push({
        positionCode: p,
        positionName: posMap.get(p) || String(p),
        cityCode: c,
        cityName: cityMap.get(c) || String(c),
        experience: filterExp || '',
        degree: filterDeg || '',
      });
    }
  }

  // 存入 storage 的 pendingConfig
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
    },
  });

  alert(`已生成 ${tasks.length} 个任务,切到"运行"标签点开始`);
  // 切到任务队列
  document.querySelector('.tab[data-panel="queue"]').click();

  // 同时把队列预存到 background(还是 pending 状态)
  await chrome.runtime.sendMessage({ type: 'clear_queue' });
  // 让 background 一接到 start 命令就以 pendingConfig 启动
}

// ============================================================
// 任务队列面板
// ============================================================
async function refreshQueue() {
  const r = await chrome.runtime.sendMessage({ type: 'get_queue' });
  const list = $('queueList');
  let q = r && r.ok ? r.queue : null;

  // 如果 background 还没有 taskQueue,但 popup 这边有 pendingConfig
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
// 按钮事件
// ============================================================
$('qfPos').addEventListener('input', (e) => renderPositionTree(e.target.value));
$('qfCity').addEventListener('input', (e) => renderCityGrid(e.target.value));

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
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'progress') {
    if (msg.msg) appendLog(msg.msg);
    refreshStatus();
    refreshQueue();
  } else if (msg.type === 'done') {
    setRunning(false);
    appendLog(`✓ 完成,本次新增 ${msg.added}`);
    refreshStatus();
    refreshQueue();
  }
});

setInterval(() => {
  if (document.querySelector('.tab[data-panel="run"]').classList.contains('active')) {
    refreshStatus();
  }
  if (document.querySelector('.tab[data-panel="queue"]').classList.contains('active')) {
    refreshQueue();
  }
}, 1500);

// ============================================================
// 启动
// ============================================================
(async () => {
  try {
    await loadDict();
    renderPositionTree();
    renderCityGrid();
    fillFilters();
    updateSelCounts();
    await refreshStatus();
  } catch (e) {
    document.body.innerHTML = `<div style="color:#c33;padding:20px">字典加载失败: ${e.message}</div>`;
  }
})();
