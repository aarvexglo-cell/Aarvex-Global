/* Shared browser polyfills — portal.html & index.html */
(function (global) {
  'use strict';

  if (typeof AbortSignal !== 'undefined' && !AbortSignal.timeout) {
    AbortSignal.timeout = function (ms) {
      var ctrl = new AbortController();
      setTimeout(function () {
        try {
          ctrl.abort(new DOMException('Timeout', 'TimeoutError'));
        } catch (e) {
          ctrl.abort();
        }
      }, ms);
      return ctrl.signal;
    };
  }

  global.safeFetchJson = async function safeFetchJson(res) {
    var text = await res.text();
    if (!text || text.trim().charAt(0) !== '{') {
      return {
        error: 'Server returned invalid response (HTTP ' + res.status + '). Deploy latest Lambda code.',
        status: res.status,
        _raw: text.slice(0, 200)
      };
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      return { error: 'Invalid JSON from server', status: res.status };
    }
  };

  global.getTurnstileToken = function getTurnstileToken(containerId) {
    try {
      if (typeof turnstile !== 'undefined' && containerId) {
        var widgetId = turnstile.getWidgetId && turnstile.getWidgetId('#' + containerId);
        if (widgetId != null) {
          var t = turnstile.getResponse(widgetId);
          if (t) return t;
        }
        var byContainer = turnstile.getResponse && turnstile.getResponse('#' + containerId);
        if (byContainer) return byContainer;
      }
      if (containerId) {
        var el = document.querySelector('#' + containerId + ' input[name=cf-turnstile-response], #' + containerId + ' textarea[name=cf-turnstile-response]');
        if (el && el.value) return el.value;
      }
      var ids = ['orderRecaptcha', 'sellRecaptcha', 'kycRecaptcha'];
      for (var i = 0; i < ids.length; i++) {
        var inp = document.querySelector('#' + ids[i] + ' input[name=cf-turnstile-response], #' + ids[i] + ' textarea[name=cf-turnstile-response]');
        if (inp && inp.value) return inp.value;
      }
    } catch (e) { /* ignore */ }
    return '';
  };
})(typeof window !== 'undefined' ? window : this);
