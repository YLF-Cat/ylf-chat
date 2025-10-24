(() => {
  const storageKey = 'chat-theme';
  const root = document.documentElement;

  function getPreferred() {
    const stored = localStorage.getItem(storageKey);
    if (stored === 'light' || stored === 'dark') return stored;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    return media.matches ? 'dark' : 'light';
  }

  function apply(theme) {
    root.dataset.theme = theme;
  }

  function set(theme) {
    if (theme !== 'light' && theme !== 'dark') return;
    localStorage.setItem(storageKey, theme);
    apply(theme);
    window.dispatchEvent(new CustomEvent('themechange', { detail: theme }));
  }

  function init() {
    apply(getPreferred());
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      const stored = localStorage.getItem(storageKey);
      if (!stored) {
        apply(media.matches ? 'dark' : 'light');
      }
    };
    if (media.addEventListener) {
      media.addEventListener('change', handler);
    } else {
      media.addListener(handler);
    }
  }

  window.Theme = {
    init,
    get: getPreferred,
    set
  };
})();
