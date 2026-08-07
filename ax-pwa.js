/* Aarvex Portal — PWA registration + install prompt (Phase 2)
 * Registers the service worker and shows a subtle "Install app" chip when the
 * browser offers installation. Service workers only run over https/localhost,
 * so this is a safe no-op on file:// or unsupported browsers.
 */
'use strict';
(function () {
  // Register the SW (ignored silently where unsupported / not https).
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function (e) {
        console.warn('[PWA] SW registration failed:', e && e.message);
      });
    });
  }

  // Custom install prompt — capture the event and show our own chip so it's on
  // brand and dismissible, instead of relying on the browser's mini-infobar.
  let _deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    _deferredPrompt = e;
    showInstallChip();
  });
  window.addEventListener('appinstalled', function () {
    _deferredPrompt = null;
    const chip = document.getElementById('axInstallChip');
    if (chip) chip.remove();
  });

  function showInstallChip() {
    if (document.getElementById('axInstallChip')) return;
    try { if (localStorage.getItem('ax_install_dismissed') === '1') return; } catch (e) {}
    const chip = document.createElement('div');
    chip.id = 'axInstallChip';
    chip.className = 'ax-install-chip';
    const label = (typeof t === 'function') ? t('pwa.install', 'Install app') : 'Install app';
    chip.innerHTML =
      '<i class="fa-solid fa-circle-down"></i><span>' + label + '</span>' +
      '<button type="button" class="ax-install-go">' + ((typeof t === 'function') ? t('pwa.installGo', 'Install') : 'Install') + '</button>' +
      '<button type="button" class="ax-install-x" aria-label="Dismiss"><i class="fa-solid fa-xmark"></i></button>';
    document.body.appendChild(chip);
    chip.querySelector('.ax-install-go').addEventListener('click', doInstall);
    chip.querySelector('.ax-install-x').addEventListener('click', function () {
      try { localStorage.setItem('ax_install_dismissed', '1'); } catch (e) {}
      chip.remove();
    });
  }

  async function doInstall() {
    if (!_deferredPrompt) return;
    _deferredPrompt.prompt();
    try { await _deferredPrompt.userChoice; } catch (e) {}
    _deferredPrompt = null;
    const chip = document.getElementById('axInstallChip');
    if (chip) chip.remove();
  }
})();
