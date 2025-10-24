(() => {
  if (!window.io) return;
  if (window.__presenceSocket) return;

  const socket = io({
    autoConnect: false,
    withCredentials: true,
    auth: { mode: 'presence' }
  });

  window.__presenceSocket = socket;

  socket.on('connect_error', err => {
    console.warn('[presence] connect_error', err);
  });

  socket.on('auth-required', () => {
    socket.disconnect();
    delete window.__presenceSocket;
  });

  socket.on('mention', payload => {
    if (!payload) return;
    showMentionNotification(payload);
  });

  socket.on('disconnect', () => {
    delete window.__presenceSocket;
  });

  socket.connect();

  function showMentionNotification({ from, text }) {
    const bodyText = text || '';
    if (!('Notification' in window)) return;

    const message = {
      body: bodyText,
      tag: 'chat-mention',
      icon: '/favicon.ico'
    };

    if (Notification.permission === 'granted') {
      new Notification(`${from} 提到了你`, message);
      return;
    }

    if (Notification.permission === 'default') {
      Notification.requestPermission().then(result => {
        if (result === 'granted') {
          new Notification(`${from} 提到了你`, message);
        }
      });
    }
  }
})();
