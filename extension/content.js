// ============================================================
// content.js — 运行在 zhipin.com 页面【隔离世界】
// ------------------------------------------------------------
// 1. 接收主世界 injected.js 通过 postMessage 转过来的数据,
//    转给 background service worker
// 2. 接收 background 的指令,在页面上模拟行为(滚动 / hover / 翻页)
// 3. 检测登录状态、风控拦截页等异常
// ============================================================

const FLAG = '__BOSS_FINAL_DATA__';
const READY = '__BOSS_FINAL_READY__';

let injectedReady = false;

// ---------- 接转主世界数据 + 准备信号 ----------
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const m = event.data;
  if (!m || typeof m !== 'object') return;

  if (m.type === READY) {
    injectedReady = true;
    return;
  }

  if (m.type === FLAG) {
    try {
      chrome.runtime
        .sendMessage({
          type: 'jobs_intercepted',
          url: m.url,
          data: m.data,
          pageUrl: location.href,
        })
        .catch(() => {});
    } catch (e) {}
  }
});

// ---------- 工具 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (lo, hi) => lo + Math.random() * (hi - lo);

async function waitFor(sel, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const el = document.querySelector(sel);
    if (el) return el;
    await sleep(250);
  }
  return null;
}

async function waitForCards(timeout = 15000) {
  const SELECTORS = [
    '.job-card-wrapper',
    '.job-list-box li',
    '.search-job-result li',
    'li.job-card-box',
  ];
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const s of SELECTORS) {
      if (document.querySelector(s)) {
        // 卡片出现后,再等接口数据填充
        await sleep(rand(700, 1300));
        return true;
      }
    }
    await sleep(300);
  }
  return false;
}

// ---------- 异常状态识别 ----------
function detectPageState() {
  const url = location.href;
  const body = (document.body && document.body.innerText) || '';

  if (url.indexOf('/login') !== -1 || url.indexOf('/user/login') !== -1) {
    return { state: 'need_login', reason: '页面被重定向到登录页' };
  }
  if (url.indexOf('verify') !== -1 || document.querySelector('.geetest_panel,#captcha,.captcha-box')) {
    return { state: 'captcha', reason: '触发验证码' };
  }
  if (
    body.indexOf('环境存在异常') !== -1 ||
    body.indexOf('访问受限') !== -1 ||
    body.indexOf('操作过于频繁') !== -1
  ) {
    return { state: 'blocked', reason: '页面提示风控' };
  }
  // 登录入口存在但没登录? 看右上角是否有 "登录/注册"
  const loginEntry = document.querySelector('.btn-sign-up, .nav-figure .login');
  if (loginEntry && !document.querySelector('.figure, .user-nav .name')) {
    // 不一定准,仅作弱信号
  }
  return { state: 'ok' };
}

// ---------- 行为模拟 ----------
async function simulateBehavior() {
  const docH = Math.max(
    document.body.scrollHeight,
    document.documentElement.scrollHeight
  );

  const steps = Math.floor(rand(2, 4));
  for (let i = 0; i < steps; i++) {
    const target = rand(100, Math.min(docH, 1200));
    window.scrollTo({ top: target, behavior: 'smooth' });
    await sleep(rand(500, 1100));
  }

  const cards = document.querySelectorAll('.job-card-wrapper, .job-card-box');
  if (cards.length > 0) {
    const n = Math.min(cards.length, Math.floor(rand(1, 3)));
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(rand(0, cards.length));
      const t = cards[idx];
      try {
        t.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await sleep(rand(300, 700));
        ['mouseenter', 'mouseover', 'mousemove'].forEach((e) =>
          t.dispatchEvent(new MouseEvent(e, { bubbles: true, cancelable: true }))
        );
        await sleep(rand(600, 1400));
        t.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
      } catch (e) {}
    }
  }

  window.scrollTo({ top: rand(0, 200), behavior: 'smooth' });
  await sleep(rand(400, 900));
}

// ---------- 滚动加载更多 (Boss 新版改为无限滚动) ----------
function getCardCount() {
  return document.querySelectorAll(
    '.job-card-wrapper, .job-card-box, .job-list-box li, .search-job-result li'
  ).length;
}

async function scrollToLoadMore() {
  const before = getCardCount();
  const doc = document.documentElement;
  const startScroll = window.scrollY;
  const targetScroll = Math.max(doc.scrollHeight, document.body.scrollHeight);

  // 分段平滑滚动,模拟真实滚动而不是瞬移
  const steps = 5;
  for (let i = 1; i <= steps; i++) {
    const y = startScroll + ((targetScroll - startScroll) * i) / steps;
    window.scrollTo({ top: y, behavior: 'smooth' });
    await sleep(rand(280, 500));
  }
  // 触发额外 scroll 事件,Boss 有些懒加载靠 scroll 监听
  window.dispatchEvent(new Event('scroll'));
  await sleep(rand(400, 800));

  // 再贴底滚一次,确保到底
  window.scrollTo({ top: doc.scrollHeight + 200, behavior: 'smooth' });
  await sleep(rand(800, 1400));

  const after = getCardCount();

  // 检测"没有更多"提示
  const bodyText = (document.body && document.body.innerText) || '';
  const reachedEnd =
    bodyText.indexOf('没有更多') !== -1 ||
    bodyText.indexOf('到底啦') !== -1 ||
    bodyText.indexOf('暂无更多') !== -1 ||
    bodyText.indexOf('已经到底') !== -1;

  return {
    ok: true,
    before,
    after,
    increased: after > before,
    reachedEnd,
  };
}

// ---------- 接 background 指令 ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'ping':
          sendResponse({
            ok: true,
            ready: true,
            injected: injectedReady,
            url: location.href,
          });
          break;
        case 'detect_state':
          sendResponse({ ok: true, ...detectPageState() });
          break;
        case 'wait_for_cards':
          sendResponse({ ok: await waitForCards(msg.timeout || 15000) });
          break;
        case 'simulate':
          await simulateBehavior();
          sendResponse({ ok: true });
          break;
        case 'scroll_load':
          sendResponse(await scrollToLoadMore());
          break;
        case 'card_count':
          sendResponse({ ok: true, count: getCardCount() });
          break;
        case 'list_card_ids': {
          // 列出所有职位卡 + 对应 encryptJobId(从 a[href*=/job_detail/] 提取)
          const out = [];
          const cards = document.querySelectorAll(
            '.job-card-wrapper, li.job-card-box, .search-job-result li, .job-list-box li'
          );
          cards.forEach((card, idx) => {
            const a = card.querySelector('a[href*="/job_detail/"]');
            const m = a && a.getAttribute('href').match(/\/job_detail\/([^.]+)\.html/);
            out.push({ index: idx, job_id: m ? m[1] : '' });
          });
          sendResponse({ ok: true, cards: out });
          break;
        }
        case 'click_card': {
          const cards = document.querySelectorAll(
            '.job-card-wrapper, li.job-card-box, .search-job-result li, .job-list-box li'
          );
          const card = cards[msg.index];
          if (!card) { sendResponse({ ok: false, error: 'card not at index ' + msg.index }); break; }
          try {
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await sleep(rand(250, 550));
            const link = card.querySelector('a[href*="/job_detail/"]');
            if (link) link.click(); else card.click();
            sendResponse({ ok: true });
          } catch (e) {
            sendResponse({ ok: false, error: e.message });
          }
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
