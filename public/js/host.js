// The host's control panel. It never shows a price, an earning or a total
// before the final standings: the host may be playing too.

import { $, h, toast, store, connect, call, watchConnection, Countdown, clockText, plural, fruitLookup, avatarEl, rankLabel, replaceKeeping } from './common.js';
import { createPredictionForm, predictionBoard } from './predict.js';

const PASSWORD_KEY = 'fruitstand:host-password';
const ROOM_KEY = 'fruitstand:host-room';
const AUTOSAVE_KEY = 'fruitstand:autosave';
const SEAT_KEY = 'fruitstand:seat'; // the player page's seat, if this browser also plays
const PLAYING_ASKED_KEY = 'fruitstand:host-playing-asked';

const app = $('#app');
const socket = connect();
watchConnection(socket);

let loggedIn = false;
let state = null;
let roomCode = store.get(ROOM_KEY);

const sessionPassword = {
  get() { try { return sessionStorage.getItem(PASSWORD_KEY); } catch { return null; } },
  set(value) { try { sessionStorage.setItem(PASSWORD_KEY, value); } catch { /* stays in memory only */ } },
  clear() { try { sessionStorage.removeItem(PASSWORD_KEY); } catch { /* nothing stored */ } },
};
let password = sessionPassword.get();

// ---------- connection ----------

socket.on('connect', async () => {
  loggedIn = false;
  if (!password) return showLogin();
  const reply = await call(socket, 'host:login', { password });
  if (!reply.ok) {
    password = null;
    sessionPassword.clear();
    return showLogin(reply.message);
  }
  loggedIn = true;
  if (roomCode) {
    const watching = await call(socket, 'host:watch', { code: roomCode });
    if (watching.ok) return;
  }
  state = null;
  showRooms();
});

let fruitOf = () => null;
socket.on('config', (config) => {
  fruitOf = fruitLookup(config);
});

socket.on('state', (value) => {
  state = value;
  roomCode = value.code;
  store.set(ROOM_KEY, roomCode);
  render();
});

// Keep the newest sealed snapshot in this browser, ready for a restart.
socket.on('autosave', ({ code, file }) => {
  store.set(AUTOSAVE_KEY, { code, file, savedAt: Date.now() });
});

socket.on('announcement', (a) => toast(`🔄 ${a.text}`));

socket.on('left', (info) => {
  state = null;
  toast(info.message, 'warn');
  showRooms();
});

// Sends a host action and always reports a failure.
async function act(event, payload = {}, success = null) {
  const reply = await call(socket, event, payload);
  if (!reply.ok) toast(reply.message || 'That did not work.', 'error', 6000);
  else if (success) toast(success, 'good', 2500);
  return reply;
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = h('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------- login and room choice ----------

function showLogin(problem = '') {
  const input = h('input', { class: 'input', type: 'password', placeholder: 'Host password', 'aria-label': 'Host password', autocomplete: 'current-password' });
  const error = h('p', { class: 'error', hidden: !problem }, problem);
  app.replaceChildren(h('section', { class: 'login' },
    h('h1', null, '🍎 Fruit Stand host'),
    error,
    h('form', {
      onsubmit: async (event) => {
        event.preventDefault();
        const reply = await call(socket, 'host:login', { password: input.value });
        if (!reply.ok) {
          error.textContent = reply.message;
          error.hidden = false;
          return;
        }
        password = input.value;
        sessionPassword.set(password);
        loggedIn = true;
        showRooms();
      },
    }, input, h('button', { class: 'btn btn--big', type: 'submit' }, 'Log in')),
  ));
  input.focus();
}

async function restore(file) {
  const reply = await act('host:import', { file }, 'Game restored. The timer is paused: press Resume when everyone is back.');
  return reply.ok;
}

function uploadButton(label, className = 'btn btn--plain') {
  return h('label', { class: `${className} filebtn` }, label,
    h('input', {
      type: 'file', accept: '.json,application/json',
      onchange: async (event) => {
        const [picked] = event.target.files;
        event.target.value = '';
        if (!picked) return;
        if (state && !window.confirm('Replace the current game with this snapshot?')) return;
        restore(await picked.text());
      },
    }));
}

function autosaveCard() {
  const saved = store.get(AUTOSAVE_KEY);
  if (!saved) return null;
  const when = new Date(saved.savedAt).toLocaleTimeString();
  return h('section', { class: 'banner' },
    h('div', null, `An autosave of room ${saved.code} is stored in this browser (saved ${when}).`),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => restore(saved.file) }, `Restore room ${saved.code}`),
    ),
  );
}

async function showRooms() {
  if (!loggedIn) return;
  const reply = await call(socket, 'host:rooms');
  const rooms = reply.ok ? reply.rooms : [];
  if (state) return; // a room opened while we were asking
  const parts = [
    h('h1', null, '🍎 Fruit Stand host'),
    autosaveCard(),
    h('section', { class: 'card' },
      h('h2', null, 'Start'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn--big', type: 'button', onclick: () => act('host:create') }, 'Create a room'),
        uploadButton('Upload a snapshot'),
      ),
    ),
    rooms.length ? h('section', { class: 'card' },
      h('h2', null, 'Open rooms'),
      h('div', { class: 'actions' }, rooms.map((room) =>
        h('button', { class: 'btn btn--plain', type: 'button', onclick: () => act('host:watch', { code: room.code }) },
          `${room.code} · ${plural(room.players, 'player')} · ${room.status}`))),
    ) : null,
  ];
  app.replaceChildren(...parts.filter(Boolean));
}

// ---------- the panel ----------

const countdown = new Countdown((seconds, running) => {
  const el = $('#timer');
  if (!el || !state || state.status !== 'bidding') return;
  el.textContent = running ? clockText(seconds) : `⏸ ${clockText(seconds)}`;
  el.classList.toggle('is-low', running && seconds <= 30);
  el.classList.toggle('is-paused', !running);
});

const STATUS_TEXT = {
  lobby: 'Lobby',
  bidding: 'Bidding is open',
  results: 'Round finished',
  reveal: 'Hidden prices on screen',
  predictions: 'Predictors vs Host on screen',
  final: 'Final standings',
};

// The host's own predictions. Built once so typing is never interrupted.
const predictionForm = createPredictionForm({
  title: '🔮 Your predictions (host)',
  save: (answers) => call(socket, 'host:predict', answers),
});

// If this browser also holds a player seat in the room, tick "I'm also
// playing" once. The host can untick it.
function noticeOwnSeat(s) {
  const seat = store.get(SEAT_KEY);
  if (s.hostPlaying || !seat || seat.code !== s.code || store.get(PLAYING_ASKED_KEY) === s.code) return;
  store.set(PLAYING_ASKED_KEY, s.code);
  call(socket, 'host:playing', { playing: true });
}

function predictionCard(s) {
  const above = [
    h('label', { class: 'toggle' },
      h('input', { type: 'checkbox', checked: s.hostPlaying, onchange: (event) => act('host:playing', { playing: event.target.checked }) }),
      "I'm also playing in this game"),
    s.hostPlaying
      ? h('p', { class: 'predict__warning' }, "⚠️ You're also playing. Your predictions may influence your play.")
      : null,
  ].filter(Boolean);
  const below = [
    h('div', { class: 'predict__who' },
      h('h3', null, 'Who has submitted all three'),
      h('ul', { class: 'chips' }, s.predictionStatus.map((p) =>
        h('li', { class: p.done ? 'is-done' : '' }, `${p.done ? '✅' : '⏳'} ${p.name}`))),
      h('p', { class: 'note' }, 'Names only. Nobody sees any answers, yours included, until the reveal.'),
    ),
  ];
  predictionForm.update({
    players: s.players,
    prediction: s.prediction,
    locked: s.predicting.locked,
    lockRound: s.predicting.lockRound,
    above,
    below,
  });
  return predictionForm.el;
}

function render() {
  const s = state;
  const inLobby = s.status === 'lobby';
  const bidding = s.status === 'bidding';
  const lastRound = s.round >= s.totalRounds;
  const parts = [];

  parts.push(h('header', { class: 'head' },
    h('div', { class: 'actions' }, h('h1', null, 'Room'), h('span', { class: 'head__code' }, s.code)),
    h('div', { class: 'head__links' },
      h('a', { class: 'btn btn--plain btn--small', href: `/screen?room=${s.code}`, target: '_blank', rel: 'noopener' }, '📺 Open big screen'),
      h('a', { class: 'btn btn--plain btn--small', href: '/how-to-play', target: '_blank', rel: 'noopener' }, '📖 How to play'),
    ),
  ));

  // Status and the main next step.
  const status = h('section', { class: 'card' });
  status.append(h('div', { class: 'statusline' },
    h('div', { class: 'count' }, String(s.playerCount), h('small', null, ` ${s.playerCount === 1 ? 'player' : 'players'}`)),
    h('div', { class: 'statusline__main' },
      inLobby ? STATUS_TEXT.lobby : `Round ${s.round} of ${s.totalRounds} · ${STATUS_TEXT[s.status]}`),
    bidding ? h('div', { class: 'htimer', id: 'timer' }) : null,
    bidding ? h('div', { class: 'hint' }, `${s.bidsIn} / ${s.playerCount} locked in`) : null,
  ));

  const main = h('div', { class: 'actions', style: 'margin-top:12px' });
  if (inLobby) {
    main.append(
      h('button', { class: 'btn btn--big', type: 'button', disabled: !s.canStart, onclick: () => act('host:start') }, 'Start game'),
      h('span', { class: `hint${s.canStart ? '' : ' hint--warn'}` }, s.startHint),
      h('label', { class: 'toggle' },
        h('input', { type: 'checkbox', checked: s.locked, onchange: (event) => act('host:lock', { locked: event.target.checked }) }),
        'Lock lobby'),
    );
  } else if (bidding) {
    main.append(
      h('button', { class: 'btn btn--sun', type: 'button', onclick: () => act('host:addMinute', {}, '+1 minute') }, '+1 min'),
      s.timer.running
        ? h('button', { class: 'btn btn--plain', type: 'button', onclick: () => act('host:pause') }, '⏸ Pause')
        : h('button', { class: 'btn', type: 'button', onclick: () => act('host:resume') }, '▶ Resume'),
      h('button', {
        class: 'btn btn--plain', type: 'button',
        onclick: async () => {
          const reply = await act('host:remind');
          if (reply.ok) toast(reply.count ? `Nudged ${plural(reply.count, 'player')}` : 'Everyone has locked in', 'good');
        },
      }, '⏰ Remind'),
      h('span', { class: 'hint' }, 'The round ends when everyone locks in or the timer runs out.'),
    );
  } else if (s.status === 'results') {
    main.append(lastRound
      ? h('button', { class: 'btn btn--big', type: 'button', onclick: () => act('host:reveal') }, '🙈 Reveal hidden prices')
      : h('button', { class: 'btn btn--big', type: 'button', onclick: () => act('host:next') }, `Start round ${s.round + 1}`));
    main.append(h('span', { class: 'hint' }, lastRound ? 'Plays on the big screen, one stand at a time.' : 'The timer starts as soon as the round opens.'));
  } else if (s.status === 'reveal') {
    main.append(
      h('button', { class: 'btn btn--big', type: 'button', onclick: () => act('host:predictions') }, '🔮 Predictors vs Host'),
      h('span', { class: 'hint' }, 'Wait for the last stand to uncover on the big screen.'),
      h('button', {
        class: 'btn btn--plain btn--small', type: 'button',
        onclick: () => { if (window.confirm('Skip the predictions reveal and go straight to the final standings?')) act('host:standings'); },
      }, 'Skip to standings'),
    );
  } else if (s.status === 'predictions') {
    main.append(
      h('button', { class: 'btn btn--big', type: 'button', onclick: () => act('host:standings') }, '🏆 Show final standings'),
      h('span', { class: 'hint' }, 'Wait for the predictor scoreboard on the big screen (about 40 seconds).'),
    );
  } else {
    main.append(
      h('button', {
        class: 'btn btn--big', type: 'button',
        onclick: async () => {
          const reply = await act('host:csv');
          if (reply.ok) download(reply.filename, `﻿${reply.csv}`, 'text/csv;charset=utf-8');
        },
      }, '⬇ Download results CSV'),
    );
  }
  status.append(main);
  parts.push(status);

  // The host predicts too. The form opens when the game starts and turns
  // into a locked summary; after the reveal it becomes the scoreboard.
  let keep = null;
  if (s.predictionReveal) {
    parts.push(h('section', { class: 'card' },
      h('h2', null, '🔮 Predictors vs Host'),
      predictionBoard(s.predictionReveal),
      h('p', { class: 'note' }, `Actual median total $${s.predictionReveal.actual.median}. The CSV has every answer.`),
    ));
  } else if (!inLobby) {
    noticeOwnSeat(s);
    keep = predictionCard(s);
    parts.push(keep);
  }

  // Players: who has locked in. Names only, never prices.
  const playerList = h('ul', { class: 'people' }, s.players.map((p) => {
    const cls = bidding ? (p.submitted ? 'is-in' : 'is-waiting') : '';
    const sub = [];
    if (p.fruit) {
      const fruit = fruitOf(p.fruit);
      sub.push(`${fruit.emoji} ${fruit.name}`);
    }
    if (bidding) sub.push(p.submitted ? 'locked in' : 'not yet');
    if (!p.connected) sub.push(h('span', { class: 'p-off' }, 'offline'));
    return h('li', { class: cls },
      avatarEl(p.avatar, p.ring, 'p-avatar'),
      h('span', { class: 'p-name' }, p.name, h('small', null, sub.flatMap((item, i) => (i ? [' · ', item] : [item])))),
      inLobby && s.maxPredictors > 0 ? h('button', {
        class: 'btn btn--sun btn--small', type: 'button', disabled: s.predictors.length >= s.maxPredictors,
        title: s.predictors.length >= s.maxPredictors ? `At most ${plural(s.maxPredictors, 'predictor')}` : 'They watch and predict instead of playing',
        onclick: () => {
          if (window.confirm(`Make ${p.name} a predictor?\n\nThey won't get a fruit or bid. They predict how the game ends instead.`)) {
            act('host:makePredictor', { playerId: p.id }, `${p.name} is now a predictor`);
          }
        },
      }, 'Make Predictor') : null,
      inLobby ? h('button', {
        class: 'btn btn--warn btn--small', type: 'button',
        onclick: () => { if (window.confirm(`Remove ${p.name} from the room?`)) act('host:remove', { playerId: p.id }, `${p.name} removed`); },
      }, 'Remove') : null,
      bidding && !p.submitted ? h('button', {
        class: 'btn btn--plain btn--small', type: 'button', onclick: () => setBid(p),
      }, 'Set bid') : null,
      !inLobby ? h('button', {
        class: 'btn btn--plain btn--small', type: 'button', title: 'Rejoin code',
        onclick: () => window.alert(`${p.name}'s rejoin code is ${p.rejoinCode}\n\nOn their phone: enter the room code ${s.code}, then this rejoin code.`),
      }, '🔑') : null,
    );
  }));
  parts.push(h('section', { class: 'card' },
    h('h2', null, bidding ? `Players · ${s.playerCount - s.bidsIn} still to lock in` : 'Players'),
    s.players.length ? playerList : h('p', { class: 'muted' }, 'Nobody has joined yet. Open the big screen and share the code.'),
    !inLobby ? h('p', { class: 'note' }, '🔑 shows a rejoin code for a player whose browser lost their seat.') : null,
  ));

  // Predictors: not players, so not in the count above.
  if (s.predictors.length || (inLobby && s.maxPredictors > 0)) {
    parts.push(h('section', { class: 'card' },
      h('h2', null, `🔮 Predictors · ${s.predictors.length} of ${s.maxPredictors}`),
      s.predictors.length
        ? h('ul', { class: 'people' }, s.predictors.map((p) => h('li', null,
          avatarEl(p.avatar, p.ring, 'p-avatar'),
          h('span', { class: 'p-name' }, p.name,
            h('small', null, ['predictor', !p.connected ? h('span', { class: 'p-off' }, ' · offline') : null])),
          inLobby ? h('button', {
            class: 'btn btn--plain btn--small', type: 'button',
            onclick: () => act('host:makePlayer', { predictorId: p.id }, `${p.name} is a player again`),
          }, 'Make player') : null,
          inLobby ? h('button', {
            class: 'btn btn--warn btn--small', type: 'button',
            onclick: () => { if (window.confirm(`Remove ${p.name} from the room?`)) act('host:remove', { playerId: p.id }, `${p.name} removed`); },
          }, 'Remove') : null,
          !inLobby ? h('button', {
            class: 'btn btn--plain btn--small', type: 'button', title: 'Rejoin code',
            onclick: () => window.alert(`${p.name}'s rejoin code is ${p.rejoinCode}\n\nOn their phone: enter the room code ${s.code}, then this rejoin code.`),
          }, '🔑') : null,
        )))
        : h('p', { class: 'muted' }, 'Nobody yet. Use “Make Predictor” on a player. You always predict too, from this page.'),
      h('p', { class: 'note' }, "Predictors don't play: no fruit, no bids, and they don't count towards the even number of players. They watch the market and predict how it ends."),
    ));
  }

  if (s.status === 'final' && s.standings) {
    parts.push(h('section', { class: 'card' },
      h('h2', null, '🏆 Final standings'),
      h('ol', { class: 'board' }, s.standings.map((row) =>
        h('li', null, h('span', { class: 'b-rank' }, rankLabel(row, s.standings)), avatarEl(row.avatar, row.ring), h('span', { class: 'b-name' }, row.name), h('span', null, `$${row.total}`)))),
    ));
  }

  // Safety net and reset.
  parts.push(h('div', { class: 'two' },
    h('section', { class: 'card' },
      h('h2', null, 'Snapshot'),
      h('div', { class: 'actions' },
        h('button', {
          class: 'btn btn--plain', type: 'button',
          onclick: async () => {
            const reply = await act('host:export');
            if (reply.ok) download(reply.filename, reply.file, 'application/json');
          },
        }, '⬇ Download'),
        uploadButton('⬆ Upload'),
      ),
      h('p', { class: 'note' }, 'This browser also autosaves the game after every change. If the server restarts, reload this page and press Restore. Snapshots are encrypted with the host password.'),
    ),
    h('section', { class: 'card' },
      h('h2', null, 'Reset'),
      h('div', { class: 'actions' },
        h('button', {
          class: 'btn btn--warn', type: 'button',
          onclick: () => { if (window.confirm('Reset the game and keep the players? All bids and results will be erased.')) act('host:reset', { keepPlayers: true }, 'Game reset'); },
        }, 'Reset, keep players'),
        h('button', {
          class: 'btn btn--warn', type: 'button',
          onclick: () => { if (window.confirm('Reset the game and remove EVERY player? This cannot be undone.')) act('host:reset', { keepPlayers: false }, 'Room wiped'); },
        }, 'Reset, wipe players'),
      ),
    ),
  ));

  const scroll = window.scrollY;
  if (keep) replaceKeeping(app, parts, keep);
  else app.replaceChildren(...parts);
  window.scrollTo(0, scroll);
  countdown.set(s.timer);
}

// For a player who cannot use their phone. The host types the price the
// player tells them; nothing else about the round is shown.
function setBid(player) {
  const answer = window.prompt(`Price for ${player.name} ($${state.bidMin}–$${state.bidMax}). This locks it in for the round.`);
  if (answer === null) return;
  const price = Number(answer.trim().replace('$', ''));
  act('host:setBid', { playerId: player.id, round: state.round, price }, `Bid locked in for ${player.name}`);
}
