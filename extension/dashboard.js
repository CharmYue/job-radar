// dashboard.js — 全屏数据看板,跑在一个独立 tab 里
// 通过 chrome.runtime.sendMessage 跟 SW 通信拿 jobs

const $ = (id) => document.getElementById(id);
const PRIORITY_ORDER = { S: 5, A: 4, B: 3, C: 2, Reject: 1, '': 0 };

let ALL = [];
let filter = 'all';
let search = '';
let sortKey = 'priority';
let sortDir = 'desc';  // desc | asc

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function formatRelativeTime(s) {
  if (!s) return '';
  const t = Date.parse(String(s).replace(' ', 'T'));
  if (isNaN(t)) return s;
  const diff = Date.now() - t;
  const d = Math.floor(diff / 86400000);
  if (d <= 0) {
    const h = Math.floor(diff / 3600000);
    return h <= 0 ? '刚发' : `${h}小时前`;
  }
  if (d < 7) return `${d}天前`;
  if (d < 30) return `${Math.floor(d / 7)}周前`;
  return `${Math.floor(d / 30)}月前`;
}

function hrActiveClass(s) {
  if (!s) return 'hr-old';
  if (/刚刚|分钟|小时|今日|今天|在线/.test(s)) return 'hr-fresh';
  if (/天前/.test(s)) {
    const m = s.match(/(\d+)\s*天前/);
    if (m && +m[1] <= 3) return 'hr-recent';
    return 'hr-old';
  }
  if (/周前|月前/.test(s)) return 'hr-stale';
  return 'hr-old';
}

async function loadJobs() {
  const r = await chrome.runtime.sendMessage({ type: 'list_jobs' });
  ALL = (r && r.ok && r.items) ? r.items : [];
  $('meta').textContent = `共 ${ALL.length} 条 · 数据来自 IndexedDB`;
  render();
}

function applyFilters() {
  const q = search.trim().toLowerCase();
  return ALL.filter((it) => {
    if (filter === 'all') return it.marked !== 'not_interested';
    if (filter === 'S') return it.score_priority === 'S';
    if (filter === 'A') return it.score_priority === 'A';
    if (filter === 'B') return it.score_priority === 'B';
    if (filter === 'C') return it.score_priority === 'C';
    if (filter === 'Reject') return it.score_priority === 'Reject';
    if (filter === 'unscored') return !it.score_priority;
    if (filter === 'applied') return it.marked === 'applied';
    return true;
  }).filter((it) => {
    if (!q) return true;
    const hay = [
      it.job_name, it.company_name, it.score_reason,
      (it.score_concerns || []).join(' '), it.industry,
    ].join(' ').toLowerCase();
    return hay.includes(q);
  });
}

function sortRows(rows) {
  const mul = sortDir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    let av, bv;
    if (sortKey === 'priority') {
      av = PRIORITY_ORDER[a.score_priority] || 0;
      bv = PRIORITY_ORDER[b.score_priority] || 0;
    } else if (sortKey === 'score') {
      av = a.score || 0;
      bv = b.score || 0;
    } else if (sortKey === 'publish_time') {
      av = Date.parse((a.publish_time || '').replace(' ', 'T')) || 0;
      bv = Date.parse((b.publish_time || '').replace(' ', 'T')) || 0;
    } else if (sortKey === 'hr_active') {
      // 把 "刚刚活跃" 类排前面
      const score = (s) => {
        if (!s) return 999;
        if (/刚刚|分钟|小时|今日|今天|在线/.test(s)) return 0;
        const m = String(s).match(/(\d+)\s*天前/);
        if (m) return +m[1];
        if (/周前/.test(s)) return 30;
        if (/月前/.test(s)) return 100;
        return 500;
      };
      av = -score(a.hr_active);  // 越新越大
      bv = -score(b.hr_active);
    } else {
      av = String(a[sortKey] || '').toLowerCase();
      bv = String(b[sortKey] || '').toLowerCase();
    }
    if (av < bv) return -1 * mul;
    if (av > bv) return 1 * mul;
    return 0;
  });
}

function render() {
  const filtered = applyFilters();
  const sorted = sortRows(filtered);

  // summary
  const counts = { S: 0, A: 0, B: 0, C: 0, Reject: 0, none: 0 };
  for (const it of ALL) {
    if (it.marked === 'not_interested') continue;
    const p = it.score_priority || 'none';
    counts[p] = (counts[p] || 0) + 1;
  }
  $('summary').textContent = `S ${counts.S} · A ${counts.A} · B ${counts.B} · C ${counts.C} · Reject ${counts.Reject} · 未打分 ${counts.none} · 显示 ${sorted.length}`;

  // sort arrows
  document.querySelectorAll('th').forEach((th) => {
    th.classList.remove('sorted');
    const sa = th.querySelector('.sort-arrow');
    if (sa) sa.textContent = th.dataset.sort ? '' : '';
  });
  const activeTh = document.querySelector(`th[data-sort="${sortKey}"]`);
  if (activeTh) {
    activeTh.classList.add('sorted');
    activeTh.querySelector('.sort-arrow').textContent = sortDir === 'asc' ? '▴' : '▾';
  }

  // rows
  const tbody = $('tbody');
  if (sorted.length === 0) {
    tbody.innerHTML = '<tr><td colspan="13" class="empty">没有匹配的岗位</td></tr>';
    return;
  }
  tbody.innerHTML = sorted.map((it) => {
    const prio = it.score_priority || 'none';
    const score = it.score != null && it.score !== '' ? it.score : '';
    const concerns = Array.isArray(it.score_concerns) ? it.score_concerns.join(' / ') : '';
    return `
      <tr class="${it.marked === 'applied' ? 'applied' : ''}" data-jobid="${escapeHtml(it.job_id)}">
        <td><span class="badge sb-${prio}">${prio === 'none' ? '—' : prio}</span></td>
        <td>${escapeHtml(score)}</td>
        <td>${escapeHtml(it.job_name || '')}</td>
        <td>${escapeHtml(it.company_name || '')}${it.industry ? `<br><span style="color:#9ca3af;font-size:11px">${escapeHtml(it.industry)}${it.company_size ? ' · ' + escapeHtml(it.company_size) : ''}</span>` : ''}</td>
        <td style="white-space:nowrap">${escapeHtml(it.salary || '')}</td>
        <td style="white-space:nowrap">${escapeHtml(it.city || '')}${it.area ? `<br><span style="color:#9ca3af;font-size:11px">${escapeHtml(it.area)}</span>` : ''}</td>
        <td style="white-space:nowrap">${escapeHtml(it.experience || '')}</td>
        <td class="${hrActiveClass(it.hr_active)}" style="white-space:nowrap">${escapeHtml(it.hr_active || '')}</td>
        <td style="white-space:nowrap;color:#6b7280">${escapeHtml(formatRelativeTime(it.publish_time))}</td>
        <td class="reason">${escapeHtml((it.score_reason || '').slice(0, 200))}</td>
        <td class="reason" style="color:#c87b3a">${escapeHtml(concerns.slice(0, 120))}</td>
        <td>${it.job_url ? `<a href="${escapeHtml(it.job_url)}" target="_blank">打开</a>` : ''}</td>
        <td class="action-cell">
          <button class="btn act-apply">${it.marked === 'applied' ? '✓已投' : '标记已投'}</button>
          <button class="btn act-block" style="color:#9b1c1c">屏蔽</button>
        </td>
      </tr>
    `;
  }).join('');

  // 行内按钮事件
  tbody.querySelectorAll('tr').forEach((tr) => {
    const jobId = tr.dataset.jobid;
    const it = sorted.find((x) => x.job_id === jobId);
    if (!it) return;
    tr.querySelector('.act-apply').addEventListener('click', async () => {
      await chrome.runtime.sendMessage({
        type: 'mark_job', job_id: jobId, mark: it.marked === 'applied' ? null : 'applied',
      });
      loadJobs();
    });
    tr.querySelector('.act-block').addEventListener('click', async () => {
      if (!confirm(`确认屏蔽「${it.company_name}」?这家公司所有岗位都会被标 not_interested`)) return;
      await chrome.runtime.sendMessage({
        type: 'mark_job', job_id: jobId, mark: 'not_interested', block_company: true,
      });
      loadJobs();
    });
  });
}

// 事件绑定
document.querySelectorAll('.fchip').forEach((c) => {
  c.addEventListener('click', () => {
    document.querySelectorAll('.fchip').forEach((x) => x.classList.remove('active'));
    c.classList.add('active');
    filter = c.dataset.filter;
    render();
  });
});
$('search').addEventListener('input', (e) => {
  search = e.target.value;
  render();
});
document.querySelectorAll('th[data-sort]').forEach((th) => {
  th.addEventListener('click', () => {
    const k = th.dataset.sort;
    if (sortKey === k) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sortKey = k;
      sortDir = (k === 'priority' || k === 'score' || k === 'publish_time' || k === 'hr_active') ? 'desc' : 'asc';
    }
    render();
  });
});
$('refreshBtn').addEventListener('click', loadJobs);
$('csvBtn').addEventListener('click', () => {
  const sorted = sortRows(applyFilters());
  const headers = [
    '分级', '分数', '岗位', '公司', '薪资', '城市', '区域',
    '经验', '学历', '行业', '公司规模', '融资',
    '发布时间', 'HR 活跃度', 'HR 姓名', 'HR 职位',
    '评分理由', '担忧', '招呼语', '简历版本',
    '链接', '标记', '抓取时间',
  ];
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r'))
      ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = sorted.map((it) => [
    it.score_priority || '', it.score != null ? it.score : '',
    it.job_name || '', it.company_name || '', it.salary || '',
    it.city || '', it.area || '', it.experience || '', it.education || '',
    it.industry || '', it.company_size || '', it.financing || '',
    it.publish_time || '', it.hr_active || '', it.hr_name || '', it.hr_title || '',
    it.score_reason || '',
    Array.isArray(it.score_concerns) ? it.score_concerns.join(' / ') : '',
    it.score_pitch || '', it.score_resume_version || '',
    it.job_url || '', it.marked || '', it.crawl_time || '',
  ].map(esc).join(','));
  const csv = '﻿' + headers.join(',') + '\n' + rows.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const today = new Date().toISOString().slice(0, 10);
  const a = document.createElement('a');
  a.href = url;
  a.download = `boss-${today}-${filter}-${sorted.length}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

loadJobs();
