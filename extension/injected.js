// ============================================================
// injected.js — 运行在 zhipin.com 页面【主世界】
// ------------------------------------------------------------
// 在 document_start 时刻猴补丁 window.fetch 和 XMLHttpRequest,
// 抓取 Boss 自己页面 JS 发出的 joblist.json 响应,经 postMessage
// 转给同源的 content.js (隔离世界)。
//
// 关键: 我们【不发任何请求】,只观察 Boss 自家 JS 发的请求。
//      所有 token / 签名 / 行为信号都是真实用户级别的。
// ============================================================

(function () {
  'use strict';

  if (window.__bossFinalInjected) return;
  window.__bossFinalInjected = true;

  const FLAG = '__BOSS_FINAL_DATA__';
  const READY = '__BOSS_FINAL_READY__';
  const TARGETS = ['/joblist.json', '/search/joblist'];

  function isTarget(url) {
    if (!url) return false;
    return TARGETS.some((t) => url.indexOf(t) !== -1);
  }

  // 通知 content.js: 钩子已挂好
  try {
    window.postMessage({ type: READY, t: Date.now() }, '*');
  } catch (e) {}

  // ---------- patch fetch ----------
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const promise = origFetch.call(this, input, init);

    try {
      const url =
        typeof input === 'string'
          ? input
          : (input && (input.url || input.toString())) || '';

      if (isTarget(url)) {
        promise
          .then((resp) => {
            // clone 后 .json(),不消费原 response
            resp
              .clone()
              .json()
              .then((json) => {
                window.postMessage(
                  { type: FLAG, url, data: json },
                  '*'
                );
              })
              .catch(() => {});
          })
          .catch(() => {});
      }
    } catch (e) {
      // 钩子本身不能影响业务
    }
    return promise;
  };

  // ---------- patch XMLHttpRequest (兜底) ----------
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this.__bossUrl = url;
    } catch (e) {}
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    try {
      const url = this.__bossUrl;
      if (isTarget(url)) {
        this.addEventListener('load', function () {
          try {
            const json = JSON.parse(this.responseText);
            window.postMessage({ type: FLAG, url, data: json }, '*');
          } catch (e) {}
        });
      }
    } catch (e) {}
    return origSend.apply(this, arguments);
  };
})();
