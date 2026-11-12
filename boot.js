// Classic script (not a module) so it still runs when the module graph fails to load.
(function () {
  function show(message) {
    let banner = document.getElementById('kb-fatal');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'kb-fatal';
      banner.style.cssText = 'margin:10px 14px;padding:8px 10px;border-radius:6px;background:#fdecea;color:#b3261e;font:13px "Segoe UI",Arial,sans-serif;white-space:pre-wrap';
      document.body.prepend(banner);
    }
    banner.textContent = message;
  }

  window.addEventListener('error', (event) => show(`Script error: ${event.message}`));
  window.addEventListener('unhandledrejection', (event) => show(`Error: ${event.reason?.message ?? event.reason}`));
  window.addEventListener('load', () => {
    setTimeout(() => {
      if (!window.__kbReady) {
        show('The extension script did not start. Open DevTools (F12) > Console for the cause, and reload the extension at edge://extensions.');
      }
    }, 1500);
  });
})();
