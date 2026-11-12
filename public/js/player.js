// The phone: join flow, then the player's own fruit stand.

import {
  $, h, toast, store, connect, call, watchConnection, Countdown, clockText,
  fruitLookup, makeStand, loadContent, plural, avatarEl, rankLabel,
} from './common.js';
import { mountScene, sceneFor } from './scene.js';

const SEAT_KEY = 'fruitstand:seat';
const app = $('#app');
const sheet = $('#sheet');
const socket = connect();
watchConnection(socket);

let config = null;
let fruitOf = () => null;
let state = null;
let seat = loadSeat(); // { code, token }
let teaser = 'Some stands might close up shop… 👀';
let closedNote = 'Some stands stayed closed. Their prices stay hidden until the end — even from their sellers.';
let skyTheme = null;
let ambientItems = null; // round 2 background sequence
const scene = mountScene('phone');
let retryTimer = null;
let lastSelection = null;
let lastSubmitted = false;
let seenAnnouncements = new Set();

loadContent().then((content) => {
  teaser = content.secretTeaser || teaser;
  closedNote = content.secretResults || closedNote;
}).catch(() => {});

// ---------- seat storage ----------

function loadSeat() {
  const saved = store.get(SEAT_KEY);
  if (saved && saved.code && saved.token) return saved;
  // Fallback for phones that refuse localStorage: the seat lives in the URL.
  const hash = new URLSearchParams(location.hash.slice(1));
  const room = new URLSearchParams(location.search).get('room');
  if (hash.get('t') && room) return { code: room.toUpperCase(), token: hash.get('t') };
  return null;
}

function saveSeat(code, token) {
  seat = { code, token };
  if (!store.set(SEAT_KEY, seat)) history.replaceState(null, '', `/?room=${code}#t=${token}`);
}

function clearSeat() {
  seat = null;
  state = null;
  store.remove(SEAT_KEY);
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}

// ---------- connection ----------

let opened = false;
socket.on('connect', () => {
  if (seat) resume();
  else if (!opened) showCodeStep(new URLSearchParams(location.search).get('room') || '');
  opened = true;
});

socket.on('config', (value) => {
  config = value;
  skyTheme = config.skyTheme;
  fruitOf = fruitLookup(config);
});

socket.on('state', (value) => {
  clearTimeout(retryTimer);
  state = value;
  render();
});

socket.on('announcement', (a) => {
  seenAnnouncements.add(a.id);
  toast(`🔄 ${a.text}`);
});

socket.on('nudge', (n) => {
  toast(`⏰ ${n.message}`, 'warn', 6000);
  if (navigator.vibrate) navigator.vibrate(200);
});

socket.on('room:restored', () => {
  if (seat) resume();
});

socket.on('left', (info) => {
  const code = seat ? seat.code : '';
  clearSeat();
  closeSheet();
  if (info.reason === 'removed') showMessage('👋', 'Please see the host', info.message);
  else {
    toast(info.message, 'warn', 7000);
    showCodeStep(info.reason === 'closed' ? '' : code);
  }
});

async function resume() {
  const reply = await call(socket, 'player:resume', seat || {});
  if (reply.ok || !seat) return; // the state event draws the screen
  if (reply.error === 'removed') {
    clearSeat();
    showMessage('👋', 'Please see the host', reply.message);
  } else if (reply.error === 'unknown_token') {
    const code = seat.code;
    clearSeat();
    toast(reply.message, 'warn');
    showCodeStep(code);
  } else {
    // The room is missing (server restart) or the network is down. Keep the
    // seat and keep trying; the host may be restoring the game.
    showPaused();
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { if (seat && socket.connected) resume(); }, 4000);
  }
}

// ---------- join flow ----------

function screen(...kids) {
  // Outside a game (joining, paused) the market is back to early morning.
  if (!state) {
    ambientItems = null;
    scene.ambient.stop();
    if (skyTheme) scene.set('lobby', skyTheme);
  }
  app.replaceChildren(...kids);
  window.scrollTo(0, 0);
}

function joinHeader(step) {
  return [
    h('div', { class: 'join__logo' }, '🍎'),
    h('h1', { class: 'join__title' }, 'Fruit Stand'),
    h('p', { class: 'join__step' }, step),
  ];
}

function showCodeStep(prefill = '', problem = '') {
  const input = h('input', {
    class: 'input input--code', id: 'code', inputmode: 'text', autocomplete: 'off', autocapitalize: 'characters',
    maxlength: '4', placeholder: 'CODE', 'aria-label': 'Room code', value: prefill.toUpperCase().slice(0, 4),
  });
  const error = h('p', { class: 'error', hidden: !problem }, problem);
  const button = h('button', { class: 'btn btn--big btn--wide', type: 'submit' }, 'Enter');
  const extra = h('div', null);

  const form = h('form', {
    onsubmit: async (event) => {
      event.preventDefault();
      const code = input.value.trim().toUpperCase();
      if (!code) return fail('Type the room code from the big screen.');
      button.disabled = true;
      const reply = await call(socket, 'room:check', { code });
      button.disabled = false;
      if (reply.ok) {
        skyTheme = reply.skyTheme || skyTheme;
        if (skyTheme) scene.set('lobby', skyTheme);
        return showNameStep(reply.code, reply.avatars);
      }
      fail(reply.message);
      if (reply.error === 'in_progress') showRejoin(code);
    },
  }, input, button);

  function fail(message) {
    error.textContent = message;
    error.hidden = false;
  }

  // A player whose browser lost its seat can get back in with a code from the host.
  function showRejoin(code) {
    const rejoinInput = h('input', {
      class: 'input', autocomplete: 'off', autocapitalize: 'characters', maxlength: '4', placeholder: 'Rejoin code', 'aria-label': 'Rejoin code',
    });
    extra.replaceChildren(h('form', {
      class: 'card',
      onsubmit: async (event) => {
        event.preventDefault();
        const reply = await call(socket, 'player:rejoin', { code, rejoinCode: rejoinInput.value });
        if (reply.ok) {
          saveSeat(reply.code, reply.token);
          toast('Welcome back!', 'good');
        } else fail(reply.message);
      },
    },
      h('p', { class: 'join__step' }, 'Already playing?'),
      h('p', { class: 'muted' }, 'Ask the host for your rejoin code.'),
      rejoinInput,
      h('button', { class: 'btn btn--sun btn--wide', type: 'submit' }, 'Rejoin my seat'),
    ));
  }

  screen(h('section', { class: 'join' }, joinHeader('Enter the room code'), error, form, extra));
  if (prefill && !problem) form.requestSubmit ? form.requestSubmit() : button.click();
}

function showNameStep(code, avatars, keep = '') {
  const input = h('input', {
    class: 'input', id: 'name', autocomplete: 'off', maxlength: '20', placeholder: 'Your name', 'aria-label': 'Your name', value: keep,
  });
  const error = h('p', { class: 'error', hidden: true });
  const button = h('button', { class: 'btn btn--big btn--wide', type: 'submit' }, 'Next');
  const form = h('form', {
    onsubmit: async (event) => {
      event.preventDefault();
      button.disabled = true;
      const reply = await call(socket, 'room:checkName', { code, name: input.value });
      button.disabled = false;
      if (reply.ok) return showAvatarStep(code, avatars, reply.name);
      if (reply.error === 'no_room' || reply.error === 'locked' || reply.error === 'in_progress') return showCodeStep(code, reply.message);
      error.textContent = reply.message;
      error.hidden = false;
      input.focus();
    },
  }, input, button);
  screen(h('section', { class: 'join' },
    joinHeader("What's your name?"), error, form,
    h('button', { class: 'join__back', type: 'button', onclick: () => showCodeStep('') }, 'Different room'),
  ));
  input.focus();
}

function showAvatarStep(code, avatars, name) {
  let picked = null;
  const error = h('p', { class: 'error', hidden: true });
  const button = h('button', { class: 'btn btn--big btn--wide', disabled: true, type: 'button' }, 'Join the market');
  const grid = h('div', { class: 'avatars' }, avatars.map((avatar) =>
    h('button', {
      class: 'avatar-pick', type: 'button', 'aria-label': `Avatar ${avatar}`,
      onclick: (event) => {
        picked = avatar;
        for (const other of grid.children) other.classList.remove('is-picked');
        event.currentTarget.classList.add('is-picked');
        button.disabled = false;
      },
    }, avatar)));

  button.addEventListener('click', async () => {
    button.disabled = true;
    const reply = await call(socket, 'player:join', { code, name, avatar: picked });
    if (reply.ok) return saveSeat(reply.code, reply.token);
    button.disabled = false;
    if (reply.error === 'name_taken' || reply.error === 'bad_name') {
      toast(reply.message, 'warn');
      return showNameStep(code, avatars, name);
    }
    if (reply.error === 'no_room' || reply.error === 'locked' || reply.error === 'in_progress') return showCodeStep(code, reply.message);
    error.textContent = reply.message;
    error.hidden = false;
  });

  screen(h('section', { class: 'join' },
    joinHeader(`Pick your avatar, ${name}`), error, grid, button,
    h('button', { class: 'join__back', type: 'button', onclick: () => showNameStep(code, avatars, name) }, 'Change name'),
  ));
}

function showMessage(icon, title, text, action = null) {
  screen(h('section', { class: 'bigmsg' },
    h('div', { class: 'bigmsg__icon' }, icon),
    h('h1', null, title),
    h('p', null, text),
    action,
  ));
}

function showPaused() {
  showMessage('⏸️', 'Game paused', 'Hang on — reconnecting you to the game. Keep this page open.',
    h('button', {
      class: 'btn btn--plain', type: 'button',
      onclick: () => {
        if (!window.confirm('Leave this game? You will lose your seat.')) return;
        clearTimeout(retryTimer);
        clearSeat();
        showCodeStep('');
      },
    }, 'Leave and join another room'));
}

// ---------- the game ----------

const countdown = new Countdown((seconds, running) => {
  const el = $('#timer');
  if (!el || !state || state.status !== 'bidding') return;
  el.textContent = running ? clockText(seconds) : `⏸ ${clockText(seconds)}`;
  const low = running && seconds <= 30;
  el.classList.toggle('is-low', low);
  el.classList.toggle('anim-pulse', low);
  el.classList.toggle('is-paused', !running);
  const hint = $('#timer-hint');
  if (hint) hint.hidden = !low;
});

function render() {
  if (!state || !config) return;
  scene.set(sceneFor(state), config.skyTheme);
  // The sequence arrives once, with the first update of the round.
  if (state.ambient) ambientItems = state.ambient;
  else if (!state.curtained) ambientItems = null;
  if (ambientItems) {
    scene.ambient.start(ambientItems, config.ambientCountPhone, config.bidSeconds * 1000 - state.timer.remainingMs);
  } else scene.ambient.stop();
  for (const a of state.announcements) seenAnnouncements.add(a.id);
  if (state.status !== 'bidding') closeSheet();

  if (state.status !== 'final') finalShown = false;
  if (state.status === 'lobby') renderWaiting();
  else if (state.status === 'reveal') {
    showMessage('👀', 'All eyes on the big screen', 'The closed stands are opening up…');
  } else if (state.status === 'final') renderFinal();
  else renderRound();

  countdown.set(state.timer);
  lastSelection = state.me.selection;
  lastSubmitted = state.me.submitted;
}

function renderWaiting() {
  const { me } = state;
  app.replaceChildren(h('section', { class: 'waiting' },
    h('div', { class: 'chalk-sign' }, 'Opening soon'),
    h('h1', null, "You're in!"),
    avatarEl(me.avatar, me.ring, 'waiting__avatar anim-pop'),
    h('div', { class: 'waiting__name' }, me.name),
    h('p', { class: 'waiting__count' }, `${plural(state.playerCount, 'player')} joined`),
    h('p', { class: 'muted' }, 'Waiting for the host to start. Keep this page open.'),
    h('a', { class: 'btn btn--sun', href: '/how-to-play?back=/' }, '📖 How to play'),
  ));
}

function resultList(round, mine) {
  return h('ul', { class: 'results' }, round.fruits.map((entry) => {
    const fruit = fruitOf(entry.fruit);
    return h('li', { class: entry.fruit === mine ? 'is-mine' : '' },
      h('span', { class: 'r-emoji' }, fruit.emoji),
      h('span', { class: 'r-name' }, fruit.name),
      entry.price === null
        ? h('span', { class: 'r-price is-closed' }, 'Closed')
        : h('span', { class: 'r-price' }, `$${entry.price}`),
    );
  }));
}

function renderRound() {
  const { me } = state;
  const bidding = state.status === 'bidding';
  const fruit = fruitOf(me.fruit);
  // In the secret round every stand is curtained, mine included, so the
  // curtain says nothing about which fruits are secret.
  const curtained = state.curtained;
  const parts = [];

  // Round, phase and the countdown.
  parts.push(h('header', { class: 'bar' },
    h('div', null,
      h('div', { class: 'bar__round' }, `Round ${state.round} of ${state.totalRounds}`),
      h('div', { class: 'bar__phase' }, `Phase ${state.phase}`),
    ),
    bidding ? h('div', { class: 'timer', id: 'timer', role: 'timer' }, '') : h('div', { class: 'timer is-paused' }, 'Done'),
  ));
  if (bidding) parts.push(h('p', { class: 'timer-hint', id: 'timer-hint', hidden: true }, `No price picked = $${config.maxPrice}`));

  // The teaser, while the secret round is being played.
  if (curtained) parts.push(h('section', { class: 'teaser anim-slide' }, teaser));

  // My stand, with the current price stuck on it.
  let tag = null;
  let tagClass = '';
  if (me.selection !== null) {
    tag = `$${me.selection}`;
    if (me.submitted) tagClass = 'stand__tag--locked';
    const justPicked = me.selection !== lastSelection || me.submitted !== lastSubmitted;
    if (justPicked) tagClass += ' anim-slap';
  }
  parts.push(h('div', { class: 'mystand' }, makeStand(fruit, { tag, tagClass, covered: curtained })));

  // Teammate and rivals.
  const mate = state.teammate;
  const mateFruit = mate ? fruitOf(mate.fruit) : null;
  parts.push(h('div', { class: 'facts' },
    h('div', { class: 'card fact' },
      h('div', { class: 'fact__label' }, 'Your partner'),
      h('div', { class: 'fact__main' }, mate ? [avatarEl(mate.avatar, mate.ring), ` ${mate.name}`] : '—'),
      h('div', { class: 'fact__sub' }, mate ? `sells ${mateFruit.emoji} ${mateFruit.name}` : ''),
    ),
    h('div', { class: 'card fact' },
      h('div', { class: 'fact__label' }, `Also selling ${fruit.name}`),
      h('div', { class: 'fact__main' }, state.rivals === 0 ? 'Nobody else' : plural(state.rivals, 'other player')),
      h('div', { class: 'fact__sub' }, state.rivals === 0 ? 'You are the only seller' : 'Lowest price takes all'),
    ),
  ));

  if (bidding) {
    // Price stickers and Submit.
    const locked = me.submitted;
    parts.push(h('p', { class: `status${locked ? ' status--locked' : ''}` },
      locked
        ? `✅ Locked in at $${me.selection}. Waiting for others (${state.bidsIn}/${state.playerCount}).`
        : me.selection === null ? 'Pick your price, then press Submit.' : `$${me.selection} picked. Press Submit to lock it in.`));

    const prices = [];
    for (let price = config.minPrice; price <= config.maxPrice; price++) {
      prices.push(h('button', {
        class: `sticker${me.selection === price ? ' is-picked' : ''}`,
        type: 'button', disabled: locked, 'aria-pressed': String(me.selection === price),
        onclick: (event) => pick(price, event.currentTarget),
      }, `$${price}`));
    }
    parts.push(h('div', { class: 'prices', id: 'prices' }, prices));
    if (!locked) {
      parts.push(h('button', {
        class: 'btn btn--big btn--wide', type: 'button', id: 'submit', disabled: me.selection === null, onclick: submit,
      }, me.selection === null ? 'Submit' : `Submit $${me.selection}`));
    }

    // Change token.
    const canChange = me.changeTokens > 0 && !locked;
    parts.push(h('div', { class: 'card token' },
      h('div', { class: 'token__text' },
        me.changeTokens > 0 ? '🔄 Change token ready' : '🔄 Change token used',
        h('small', null, me.changeTokens > 0
          ? (locked ? 'Not this round: your price is locked in.' : 'Switch to another fruit. Once per game.')
          : 'You keep this fruit for the rest of the game.'),
      ),
      me.changeTokens > 0
        ? h('button', { class: 'btn btn--sun btn--small', type: 'button', disabled: !canChange, onclick: openChangeSheet }, 'Use')
        : null,
    ));
  } else {
    // This round's results.
    const latest = state.results.find((r) => r.round === state.round);
    parts.push(h('p', { class: 'status' }, 'Round over. Waiting for the host…'));
    if (latest) {
      parts.push(h('section', { class: 'card panel anim-slide' },
        h('h3', null, `Round ${latest.round}: lowest prices`),
        resultList(latest, me.fruit),
        latest.fruits.some((f) => f.price === null)
          ? h('p', { class: 'muted', style: 'margin-top:8px' }, closedNote) : null,
      ));
    }
  }

  // Public Change announcements.
  if (state.announcements.length) {
    parts.push(h('section', { class: 'card panel' },
      h('h3', null, 'Market news'),
      h('ul', { class: 'news' }, [...state.announcements].reverse().map((a) =>
        h('li', null, `🔄 ${a.text} `, h('small', null, `(round ${a.round})`)))),
    ));
  }

  // Earlier rounds.
  const past = state.results.filter((r) => bidding || r.round !== state.round).reverse();
  if (past.length) {
    parts.push(h('section', { class: 'card panel' },
      h('h3', null, 'Past rounds'),
      h('div', { class: 'history' }, past.map((round) =>
        h('div', null, h('h4', null, `Round ${round.round}`), resultList(round, null)))),
    ));
  }

  app.replaceChildren(...parts);
}

async function pick(price, button) {
  if (!state || state.me.submitted) return;
  // Show the pick at once; the server's answer confirms or corrects it.
  for (const other of $('#prices').children) other.classList.remove('is-picked');
  button.classList.add('is-picked');
  const reply = await call(socket, 'player:select', { round: state.round, price });
  if (!reply.ok) {
    toast(reply.message, 'error');
    render();
  }
}

async function submit() {
  const button = $('#submit');
  if (button) button.disabled = true;
  const reply = await call(socket, 'player:submit', { round: state.round, price: state.me.selection });
  if (reply.ok) toast(`Locked in at $${reply.price}`, 'good', 2500);
  else {
    toast(reply.message, 'error');
    render();
  }
}

// ---------- Change token sheet ----------

function closeSheet() {
  sheet.hidden = true;
  sheet.replaceChildren();
}

function openChangeSheet() {
  const mine = fruitOf(state.me.fruit);
  const grid = h('div', { class: 'fruit-grid' }, state.changeTargets.map((id) => {
    const fruit = fruitOf(id);
    return h('button', {
      class: 'fruit-pick', type: 'button', onclick: () => confirmChange(mine, fruit),
    }, h('span', null, fruit.emoji), h('span', null, fruit.name));
  }));
  sheet.replaceChildren(h('div', { class: 'sheet__panel anim-slide' },
    h('h2', null, '🔄 Change your fruit'),
    h('p', null, `You sell ${mine.emoji} ${mine.name}. Pick a new fruit.`),
    grid,
    h('button', { class: 'btn btn--plain btn--wide', type: 'button', onclick: closeSheet }, 'Cancel'),
  ));
  sheet.hidden = false;
}

function confirmChange(from, to) {
  const yes = h('button', { class: 'btn btn--warn', type: 'button' }, 'Yes, change');
  yes.addEventListener('click', async () => {
    yes.disabled = true;
    const reply = await call(socket, 'player:change', { round: state.round, fruit: to.id });
    closeSheet();
    if (reply.ok) toast(`You now sell ${to.emoji} ${to.name}`, 'good');
    else toast(reply.message, 'error', 6000);
  });
  sheet.replaceChildren(h('div', { class: 'sheet__panel' },
    h('h2', null, 'Are you sure?'),
    h('div', { class: 'swap' }, from.emoji, h('small', null, '→'), to.emoji),
    h('p', { class: 'center' }, h('strong', null, `Change ${from.name} → ${to.name}?`)),
    h('p', { class: 'center muted' },
      "This uses your only Change token, it can't be undone, and everyone will be told."),
    h('div', { class: 'sheet__row' },
      h('button', { class: 'btn btn--plain', type: 'button', onclick: openChangeSheet }, 'Back'),
      yes,
    ),
  ));
}

sheet.addEventListener('click', (event) => {
  if (event.target === sheet) closeSheet();
});

// ---------- final standings ----------

let finalShown = false;

const money = (text) => h('span', { class: 'receipt__price' }, `$${text}`);
const receiptLine = (label, price, cls = '') =>
  h('div', { class: `receipt__line ${cls}`.trim() }, h('span', { class: 'receipt__label' }, label), price);

// A paper receipt from the player's own stand.
function receipt() {
  const { me, receipt: r } = state;
  const place = r.tied ? `T-${r.rank}` : `#${r.rank}`;
  return h('section', { class: `receipt${finalShown ? '' : ' anim-slide'}` },
    h('div', { class: 'receipt__head' },
      avatarEl(me.avatar, me.ring, 'receipt__avatar'),
      h('div', { class: 'receipt__shop' }, `${me.name}'s stand`),
      h('div', { class: 'receipt__sub' }, `Fruit Stand · Room ${state.code}`),
    ),
    h('div', { class: 'receipt__rule' }),
    r.lines.map((line) => receiptLine(`R${line.round} earnings`, money(line.earned))),
    h('div', { class: 'receipt__rule' }),
    r.shares.map((team) => receiptLine(
      [`Team ${team.phase} total ÷ 2`, h('small', null, `with ${team.partner} · $${team.teamTotal} ÷ 2`)],
      money(team.half))),
    h('div', { class: 'receipt__rule receipt__rule--double' }),
    receiptLine('TOTAL', money(r.total), 'receipt__line--total'),
    receiptLine('RANK', h('span', { class: 'receipt__price' }, `${place} of ${r.of}`), 'receipt__line--total'),
    h('div', { class: 'receipt__thanks' }, '* thank you for trading *'),
  );
}

function renderFinal() {
  const rows = state.standings;
  const list = h('ol', { class: 'board' }, rows.map((row) =>
    h('li', { class: row.id === state.me.id ? 'is-me' : '' },
      h('span', { class: 'b-rank' }, rankLabel(row, rows)),
      avatarEl(row.avatar, row.ring, 'b-avatar'),
      h('span', { class: 'b-name' }, row.name),
      h('span', { class: 'b-total' }, `$${row.total}`),
    )));
  const box = h('div', { class: 'board-box' }, list);

  app.replaceChildren(
    state.receipt ? receipt() : null,
    h('section', { class: 'card panel' }, h('h3', null, '🏆 Final standings'), box),
  );
  finalShown = true;

  // Bring the player's own row into view inside the list.
  const mine = list.querySelector('.is-me');
  if (mine) box.scrollTop = Math.max(0, mine.offsetTop - box.clientHeight / 2 + mine.offsetHeight / 2);
}
