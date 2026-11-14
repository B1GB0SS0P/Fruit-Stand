// Shared helpers for every page: DOM building, toasts, storage, the socket,
// the synced countdown and the fruit stand component.

/* global io */

export const $ = (selector, root = document) => root.querySelector(selector);

// Builds an element. Text always goes in as text, never as HTML.
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style') el.style.cssText = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// ---------- toasts ----------

export function toast(message, kind = 'info', ms = 4500) {
  let box = $('#toasts');
  if (!box) {
    box = h('div', { id: 'toasts', class: 'toasts', 'aria-live': 'polite' });
    document.body.append(box);
  }
  const item = h('div', { class: `toast toast--${kind} anim-slide` }, message);
  box.append(item);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => {
    item.classList.add('is-leaving');
    setTimeout(() => item.remove(), 400);
  }, ms);
}

// ---------- storage (phones in private mode can refuse it) ----------

export const store = {
  get(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* nothing to remove */
    }
  },
};

// ---------- socket ----------

export function connect() {
  return io({ transports: ['websocket', 'polling'] });
}

// Sends an event and always resolves with a reply, even if the server is
// unreachable, so nothing fails silently.
export function call(socket, event, payload = {}) {
  return new Promise((resolve) => {
    socket.timeout(8000).emit(event, payload, (err, reply) => {
      if (err) resolve({ ok: false, error: 'timeout', message: 'No answer from the server. Check your connection and try again.' });
      else resolve(reply);
    });
  });
}

// A small banner while the connection is down.
export function watchConnection(socket) {
  const banner = h('div', { class: 'offline', hidden: true }, 'Reconnecting…');
  document.body.append(banner);
  socket.on('disconnect', () => { banner.hidden = false; });
  socket.on('connect', () => { banner.hidden = true; });
}

// ---------- countdown ----------

// Counts down from the server's remaining time. It measures elapsed time
// locally, so a wrong clock on the phone makes no difference.
export class Countdown {
  constructor(onTick) {
    this.onTick = onTick;
    this.base = 0;
    this.running = false;
    this.at = performance.now();
    this.last = null;
    setInterval(() => this.tick(), 250);
    document.addEventListener('visibilitychange', () => this.tick(true));
  }

  set(timer) {
    this.base = timer.remainingMs;
    this.running = timer.running;
    this.at = performance.now();
    this.tick(true);
  }

  seconds() {
    const ms = this.running ? this.base - (performance.now() - this.at) : this.base;
    return Math.max(0, Math.ceil(ms / 1000));
  }

  tick(force = false) {
    const s = this.seconds();
    if (!force && s === this.last) return;
    this.last = s;
    this.onTick(s, this.running);
  }
}

export const clockText = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

// ---------- fruit ----------

export function fruitLookup(config) {
  const map = new Map(config.fruits.map((fruit, index) => [fruit.id, { ...fruit, index }]));
  return (id) => map.get(id) || { id, name: id, emoji: '❓', index: 0 };
}

// One little fruit stand. Sized in em, so the container's font-size scales it.
//   tag: text for the price tag, or null
//   covered: draw the curtain over the stand
export function makeStand(fruit, { tag = null, covered = false, tagClass = '', dim = false, note = null } = {}) {
  return h('div', {
    class: `stand${covered ? ' is-covered' : ''}${dim ? ' is-dim' : ''}`,
    style: `--awning: var(--awning-${(fruit.index % 5) + 1})`,
    'data-fruit': fruit.id,
  },
    h('div', { class: 'stand__awning' }),
    h('div', { class: 'stand__window' },
      h('div', { class: 'stand__fruit' }, fruit.emoji),
      h('div', { class: 'stand__cloth' }),
    ),
    h('div', { class: 'stand__counter' }, fruit.name),
    tag ? h('div', { class: `stand__tag ${tagClass}` }, tag) : null,
    note ? h('div', { class: 'stand__note' }, note) : null,
  );
}

// An animal in its colour ring. Sized by the container's font-size.
export function avatarEl(emoji, ring, extraClass = '') {
  return h('span', { class: `avatar ${extraClass}`.trim(), style: ring ? `--ring:${ring}` : null }, h('span', null, emoji));
}

// Rank as shown on the standings: tied players get "T-2".
export function rankLabel(row, rows) {
  const tied = rows.filter((other) => other.rank === row.rank).length > 1;
  return tied ? `T-${row.rank}` : `#${row.rank}`;
}

export const prefersReducedMotion = () =>
  window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let contentPromise = null;
export function loadContent() {
  contentPromise ||= fetch('/content/how-to-play.json').then((r) => r.json());
  return contentPromise;
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Like parent.replaceChildren(...nodes), but if `keep` is already in the
// parent it is left where it is, so a field inside it keeps its focus and
// the phone keyboard stays up while the rest of the page redraws.
export function replaceKeeping(parent, nodes, keep) {
  const at = nodes.indexOf(keep);
  if (at < 0 || keep.parentNode !== parent) {
    parent.replaceChildren(...nodes);
    return;
  }
  for (const child of [...parent.childNodes]) if (child !== keep) child.remove();
  keep.before(...nodes.slice(0, at));
  keep.after(...nodes.slice(at + 1));
}
