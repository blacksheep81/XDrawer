/* 테마 부트스트랩. <head>에서 동기 실행해 첫 페인트 전에 data-theme을 확정한다. */
var XTheme = (function () {
  var KEY = 'x-drawer-theme';
  var MODES = ['system', 'light', 'dark'];
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function read() {
    try {
      var saved = localStorage.getItem(KEY);
      return MODES.indexOf(saved) >= 0 ? saved : 'dark';
    } catch (error) { return 'dark'; }
  }

  function resolve(mode) {
    if (mode === 'light' || mode === 'dark') return mode;
    return media && media.matches ? 'dark' : 'light';
  }

  function paint(mode) {
    document.documentElement.setAttribute('data-theme', resolve(mode));
    document.documentElement.setAttribute('data-theme-mode', mode);
  }

  function set(mode) {
    var next = MODES.indexOf(mode) >= 0 ? mode : 'system';
    try { localStorage.setItem(KEY, next); } catch (error) { /* 저장소를 못 써도 화면은 바뀐다 */ }
    paint(next);
    return next;
  }

  paint(read());
  if (media && media.addEventListener) {
    media.addEventListener('change', function () { if (read() === 'system') paint('system'); });
  }
  window.addEventListener('storage', function (event) { if (event.key === KEY) paint(read()); });

  return {
    MODES: MODES,
    get: read,
    set: set,
    resolved: function () { return resolve(read()); },
    /* 모드 버튼 묶음을 현재 설정에 맞춰 표시하고 클릭을 연결한다. */
    bind: function (root, onChange) {
      if (!root) return;
      var buttons = root.querySelectorAll('[data-theme-set]');
      function sync() {
        var mode = read();
        for (var i = 0; i < buttons.length; i++) {
          var on = buttons[i].getAttribute('data-theme-set') === mode;
          buttons[i].classList.toggle('active', on);
          buttons[i].setAttribute('aria-pressed', String(on));
        }
      }
      root.addEventListener('click', function (event) {
        var button = event.target.closest('[data-theme-set]');
        if (!button) return;
        set(button.getAttribute('data-theme-set'));
        sync();
        if (typeof onChange === 'function') onChange(read());
      });
      window.addEventListener('storage', sync);
      sync();
    }
  };
})();
