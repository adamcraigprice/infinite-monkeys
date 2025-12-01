// Client-side logic (updated for server-enforced global DISPLAY_LIMIT)
// - fetch /config to learn displayLimit
// - fetch /recent (server uses displayLimit) to populate initial string
// - open EventSource /events to receive new characters in real time
// - show only the last displayLimit characters (global)

const streamArea = document.getElementById('streamArea');
const connStatus = document.getElementById('connStatus');
const displayLimitEl = document.getElementById('displayLimit');

let displayLimit = 200;
let buffer = []; // array of {id, char, ts}

function render() {
  const s = buffer.map(r => r.char).join('');
  streamArea.textContent = s;
  streamArea.scrollTop = streamArea.scrollHeight;
}

async function loadConfigAndRecent() {
  try {
    const cfgRes = await fetch('/config');
    const cfg = await cfgRes.json();
    if (cfg && cfg.displayLimit) displayLimit = cfg.displayLimit;
    displayLimitEl.textContent = displayLimit;

    // Load recent (server will apply the same displayLimit)
    const res = await fetch('/recent');
    const rows = await res.json();
    buffer = rows.slice(-displayLimit);
    render();
  } catch (err) {
    console.error('Failed to load config/recent:', err);
  }
}

let es;
function connectEvents() {
  if (es && es.readyState !== EventSource.CLOSED) {
    try { es.close(); } catch (e) {}
  }
  es = new EventSource('/events');
  connStatus.textContent = 'connecting...';

  es.onopen = () => {
    connStatus.textContent = 'connected';
  };

  es.onmessage = (ev) => {
    try {
      const row = JSON.parse(ev.data);
      buffer.push(row);
      if (buffer.length > displayLimit) buffer = buffer.slice(buffer.length - displayLimit);
      render();
    } catch (err) {
      console.error('bad message', err);
    }
  };

  es.onerror = (e) => {
    connStatus.textContent = 'disconnected';
    // EventSource will auto-reconnect; we keep the status updated
  };
}

// startup
loadConfigAndRecent();
connectEvents();

// Reconnect monitor (ensure we keep trying)
setInterval(() => {
  if (!es || es.readyState === EventSource.CLOSED) {
    connectEvents();
  }
}, 3000);
