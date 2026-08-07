/* Legacy shim — full logic lives in ax-telemetry.js */
(function () {
  if (typeof window.axLogError === 'function') return;
  // If telemetry script failed to load, keep a minimal local logger.
  var KEY = 'ax_client_error_log_v1';
  function load() { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return []; } }
  function save(a) { try { localStorage.setItem(KEY, JSON.stringify(a.slice(0, 80))); } catch (e) {} }
  window.axLogError = function (err, meta) {
    var msg = (err && err.message) ? err.message : String(err || 'Error');
    var arr = load();
    arr.unshift({ ts: new Date().toISOString(), message: msg, type: (meta && meta.type) || 'shim', critical: true, needs_permission: true, auto_action: 'none' });
    save(arr);
  };
  window.axGetClientErrors = load;
  window.axClearClientErrors = function () { save([]); };
})();
