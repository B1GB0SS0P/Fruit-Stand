// The projector: lobby, market, results, secret reveal and final standings.
// Read-only: it never sends anything but "watch this room".

import {
  $, h, toast, connect, call, watchConnection, Countdown, clockText,
  fruitLookup, makeStand, loadContent, prefersReducedMotion, plural,
} from './common.js';

const app = $('#app');
const fx = $('#fx');
const socket = connect();
watchConnection(socket);

const code = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
let config = null;
let fruitOf = () => null;
let state = null;
let sceneKey = null;
let secretIntro = { title: '🙈 Secret Market!', text: "These fruits' prices stay hidden until the end — even from their sellers." };
let introPlayedFor = null; // round whose secret intro has been shown
let revealTimers = [];
const shownPeople = new Set();

loadContent().then((content) => { secretIntro = content.secretIntro; }).catch(() => {});

// Stand proportions in em, used to fit the market on the screen.
const STAND_W = 11.4;
const STAND_H = 12.4;

// ---------- connection ----------

socket.on('connect', watch);
socket.on('room:restored', watch);
socket.on('config', (value) => {
  config = value;
  fruitOf = fruitLookup(config);
});
socket.on('state', (value) => {
  state = value;
  render();
});
socket.on('announcement', (a) => toast(`🔄 ${a.text}`, 'info', 7000));
socket.on('left', (info) => showNotice('Room closed', info.message));

async function watch() {
  if (!code) return showCodeForm();
  const reply = await call(socket, 'screen:watch', { code });
  if (!reply.ok && !state) showCodeForm(reply.message);
  // If the room vanished mid-game (server restart), keep the last picture up
  // and try again until the host restores it.
  if (!reply.ok && state) setTimeout(() => { if (socket.connected) watch(); }, 4000);
}

function showNotice(title, text) {
  sceneKey = null;
  app.replaceChildren(h('section', { class: 'notice' }, h('h1', null, title), h('p', null, text)));
}

function showCodeForm(problem = '') {
  sceneKey = null;
  const input = h('input', { class: 'input input--code', maxlength: '4', placeholder: 'CODE', 'aria-label': 'Room code', autocapitalize: 'characters' });
  app.replaceChildren(h('section', { class: 'notice' },
    h('h1', null, '🍎 Fruit Stand'),
    h('p', null, problem || 'Enter the room code to show the big screen.'),
    h('form', {
      onsubmit: (event) => {
        event.preventDefault();
        location.href = `/screen?room=${encodeURIComponent(input.value.trim().toUpperCase())}`;
      },
    }, input, h('button', { class: 'btn btn--big', type: 'submit' }, 'Show')),
  ));
}

// ---------- countdown ----------

const countdown = new Countdown((seconds, running) => {
  const el = $('#timer');
  if (!el || !state || state.status !== 'bidding') return;
  el.textContent = running ? clockText(seconds) : `⏸ ${clockText(seconds)}`;
  const low = running && seconds <= 30;
  el.classList.toggle('is-low', low);
  el.classList.toggle('anim-pulse', low);
  el.classList.toggle('is-paused', !running);
});

// ---------- rendering ----------

// A scene is rebuilt only when the game moves on; in between, only the
// numbers change. That keeps the animations from replaying.
function render() {
  if (!state || !config) return;
  const key = `${state.status}:${state.round}`;
  if (key !== sceneKey) {
    sceneKey = key;
    revealTimers.forEach(clearTimeout);
    revealTimers = [];
    fx.replaceChildren();
    if (state.status === 'lobby') buildLobby();
    else if (state.status === 'bidding') buildRound();
    else if (state.status === 'results') buildResults();
    else if (state.status === 'reveal') buildReveal();
    else buildFinal();
  }
  update();
}

function update() {
  if (state.status === 'lobby') updateLobby();
  if (state.status === 'bidding') {
    $('#bids').textContent = `${state.bidsIn} / ${state.playerCount}`;
    countdown.set(state.timer);
  }
}

function topBar(center, right) {
  return h('header', { class: 'top' },
    h('div', { class: 'top__left' },
      h('h1', null, `Round ${state.round} of ${state.totalRounds}`),
      h('p', null, `Phase ${state.phase} · Room ${state.code}`),
    ),
    center,
    h('div', { class: 'top__right' }, right),
  );
}

// Picks the column count that makes the stands as large as possible.
function fitMarket(market, count) {
  const width = market.clientWidth;
  const height = market.clientHeight;
  let best = { size: 0, cols: 1 };
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const size = Math.min(width / cols / STAND_W, height / rows / STAND_H);
    if (size > best.size) best = { size, cols };
  }
  market.style.setProperty('--cols', best.cols);
  market.style.fontSize = `${best.size}px`;
}

function buildMarket(stands) {
  const market = h('section', { class: 'market', id: 'market' }, stands);
  const refit = () => fitMarket(market, Math.max(1, stands.length));
  requestAnimationFrame(refit);
  market.refit = refit;
  return market;
}

window.addEventListener('resize', () => {
  const market = $('#market');
  if (market && market.refit) market.refit();
});

// ----- lobby -----

function buildLobby() {
  shownPeople.clear();
  const joinUrl = `${location.host}`;
  app.replaceChildren(
    h('section', { class: 'lobby' },
      h('div', { class: 'lobby__join' },
        h('h1', null, '🍎 Fruit Stand'),
        h('p', { class: 'lobby__url' }, 'Join at ', h('strong', null, joinUrl)),
        h('div', { class: 'lobby__code' }, state.code),
        h('img', { class: 'lobby__qr', src: `/qr.svg?room=${state.code}`, alt: 'QR code to join' }),
        h('a', { class: 'btn btn--sun btn--big', href: `/how-to-play?back=${encodeURIComponent(`/screen?room=${state.code}`)}` }, '📖 How to play'),
      ),
      h('div', { class: 'lobby__people' },
        h('div', { class: 'lobby__count', id: 'count' }),
        h('div', { class: 'crowd', id: 'crowd' }),
      ),
    ),
  );
}

function updateLobby() {
  const crowd = $('#crowd');
  const names = new Set(state.players.map((p) => p.name));
  for (const chip of [...crowd.children]) {
    if (!names.has(chip.dataset.name)) {
      shownPeople.delete(chip.dataset.name);
      chip.remove();
    }
  }
  for (const player of state.players) {
    if (shownPeople.has(player.name)) continue;
    shownPeople.add(player.name);
    crowd.append(h('div', { class: 'person anim-pop', 'data-name': player.name },
      h('span', null, player.avatar), h('span', null, player.name)));
  }
  const n = state.players.length;
  crowd.style.setProperty('--crowd-size', n > 44 ? '2vh' : n > 28 ? '2.6vh' : n > 14 ? '3.3vh' : '4.2vh');
  $('#count').replaceChildren(String(n), h('small', null, ` ${n === 1 ? 'player' : 'players'} in the market`));
}

// ----- a round -----

function buildRound() {
  const secret = new Set(state.secretFruits);
  const playIntro = secret.size > 0 && introPlayedFor !== state.round && state.bidsIn === 0;
  introPlayedFor = secret.size > 0 ? state.round : introPlayedFor;

  const stands = state.activeFruits.map((id) =>
    makeStand(fruitOf(id), { covered: secret.has(id) && !playIntro }));
  const market = buildMarket(stands);

  app.replaceChildren(
    topBar(
      h('div', { class: 'bigtimer', id: 'timer', role: 'timer' }),
      [h('span', { id: 'bids' }), h('small', null, 'prices locked in')],
    ),
    market,
  );
  if (playIntro) requestAnimationFrame(() => requestAnimationFrame(() => playSecretIntro(market, [...secret])));
}

// The secret fruits drift in on gentle arcs, land on their stands, and the
// stands get covered. Projector only.
function playSecretIntro(market, secretIds) {
  const card = h('div', { class: 'intro-card anim-pop' }, h('h1', null, secretIntro.title), h('p', null, secretIntro.text));
  fx.append(card);
  const cover = (id) => {
    const stand = market.querySelector(`[data-fruit="${id}"]`);
    if (stand) stand.classList.add('is-covered');
  };
  const later = (fn, ms) => revealTimers.push(setTimeout(fn, ms));

  if (prefersReducedMotion() || !document.body.animate) {
    later(() => secretIds.forEach(cover), 1500);
    later(() => card.classList.add('is-leaving'), 6000);
    later(() => card.remove(), 6700);
    return;
  }

  const CARD_MS = 3200;
  const GAP_MS = 700;
  const FLIGHT_MS = 2600;
  later(() => card.classList.add('is-leaving'), CARD_MS);
  later(() => card.remove(), CARD_MS + 700);

  secretIds.forEach((id, i) => {
    later(() => {
      const stand = market.querySelector(`[data-fruit="${id}"]`);
      if (!stand) return;
      const target = stand.querySelector('.stand__fruit').getBoundingClientRect();
      const size = target.height * 0.92;
      const fromLeft = i % 2 === 0;
      const startX = fromLeft ? -size * 1.5 : window.innerWidth + size * 0.5;
      const startY = window.innerHeight * (0.55 + 0.1 * (i % 3));
      const endX = target.left + (target.width - size) / 2;
      const endY = target.top;
      const peakY = Math.min(startY, endY) - window.innerHeight * 0.28;

      const inner = h('span', { style: `font-size:${size}px` }, fruitOf(id).emoji);
      const flyer = h('div', { class: 'flyer' }, inner);
      fx.append(flyer);
      // Sideways at a steady pace, up and down on a curve: together, an arc.
      flyer.animate(
        [{ transform: `translateX(${startX}px)` }, { transform: `translateX(${endX}px)` }],
        { duration: FLIGHT_MS, easing: 'linear', fill: 'forwards' },
      );
      const fall = inner.animate(
        [
          { transform: `translateY(${startY}px) rotate(${fromLeft ? -200 : 200}deg)`, easing: 'cubic-bezier(0.2, 0.6, 0.4, 1)' },
          { transform: `translateY(${peakY}px) rotate(${fromLeft ? -80 : 80}deg)`, easing: 'cubic-bezier(0.6, 0, 0.8, 0.4)', offset: 0.5 },
          { transform: `translateY(${endY}px) rotate(0deg)` },
        ],
        { duration: FLIGHT_MS, fill: 'forwards' },
      );
      fall.onfinish = () => {
        cover(id);
        revealTimers.push(setTimeout(() => flyer.remove(), 350));
      };
    }, CARD_MS + 300 + i * GAP_MS);
  });
}

// ----- results -----

function buildResults() {
  const round = state.results.find((r) => r.round === state.round);
  const sold = new Map(round.fruits.map((entry) => [entry.fruit, entry]));
  const ids = [...state.activeFruits, ...round.fruits.map((f) => f.fruit).filter((id) => !state.activeFruits.includes(id))];

  const stands = ids.map((id, i) => {
    const entry = sold.get(id);
    if (!entry) return makeStand(fruitOf(id), { dim: true, note: 'No sellers' });
    if (entry.price === null) return makeStand(fruitOf(id), { covered: true, tag: '🙈 Secret', tagClass: 'stand__tag--secret anim-drop' });
    const stand = makeStand(fruitOf(id), { tag: `$${entry.price}`, tagClass: 'anim-drop' });
    stand.querySelector('.stand__tag').style.animationDelay = `${300 + i * 140}ms`;
    return stand;
  });

  const hasSecret = round.fruits.some((f) => f.price === null);
  app.replaceChildren(
    topBar(h('div', { class: 'bigtimer bigtimer--label' }, 'Lowest prices'), [`Round ${state.round}`, h('small', null, 'results')]),
    buildMarket(stands),
  );
  if (hasSecret) app.append(h('p', { class: 'subtitle anim-fade' }, `${secretIntro.title} ${secretIntro.text}`));
}

// ----- the end: secret prices, then standings -----

function buildReveal() {
  const secretRound = state.results.find((r) => r.fruits.some((f) => f.secret));
  const secrets = secretRound ? secretRound.fruits.filter((f) => f.secret) : [];
  const stands = secrets.map((entry) => makeStand(fruitOf(entry.fruit), { covered: true }));
  const market = buildMarket(stands);

  app.replaceChildren(
    h('header', { class: 'top' },
      h('div', { class: 'top__left' }, h('h1', null, '🙈 Secret Market'), h('p', null, secretRound ? `Round ${secretRound.round} · the hidden prices` : '')),
      h('div', { class: 'bigtimer bigtimer--label' }, 'The reveal'),
      h('div', { class: 'top__right' }, h('span', { id: 'revealed' }, `0 / ${secrets.length}`), h('small', null, 'uncovered')),
    ),
    market,
    h('p', { class: 'subtitle', id: 'reveal-note' }, secrets.length ? 'Here come the secret prices…' : 'No secret prices this game.'),
  );

  // Uncover one stand at a time.
  secrets.forEach((entry, i) => {
    revealTimers.push(setTimeout(() => {
      const stand = market.children[i];
      stand.classList.remove('is-covered');
      revealTimers.push(setTimeout(() => {
        stand.append(h('div', { class: 'stand__tag anim-drop' }, `$${entry.price}`));
        $('#revealed').textContent = `${i + 1} / ${secrets.length}`;
        if (i === secrets.length - 1) $('#reveal-note').textContent = 'Final standings coming up…';
      }, prefersReducedMotion() ? 100 : 750));
    }, 1800 + i * 2400));
  });
}

function buildFinal() {
  const rows = state.standings;

  // The podium holds the top three places. Tied players share a step. If a
  // tie makes a step too crowded, the podium stops there.
  const steps = [];
  let placed = 0;
  for (const rank of [...new Set(rows.map((r) => r.rank))].slice(0, 3)) {
    const group = rows.filter((r) => r.rank === rank);
    if (placed + group.length > 9 || group.length > 4) break;
    steps.push(group);
    placed += group.length;
  }
  const rest = rows.slice(placed);

  const podium = steps.length ? h('div', { class: 'podium' }, steps.map((group, i) =>
    h('div', { class: `step step--${i + 1} anim-pop`, style: `animation-delay:${(steps.length - 1 - i) * 900}ms` },
      h('div', { class: 'step__people' }, group.map((row) =>
        h('div', { class: 'winner' },
          h('div', { class: 'winner__avatar' }, row.avatar),
          h('div', { class: 'winner__name' }, row.name)))),
      h('div', { class: 'step__block' }, h('b', null, `#${group[0].rank}`), h('span', null, `$${group[0].total}`)),
    ))) : null;

  const columns = rest.length > 30 ? 4 : rest.length > 16 ? 3 : rest.length > 6 ? 2 : 1;
  const perColumn = Math.max(1, Math.ceil(rest.length / columns));
  const list = rest.length ? h('div', {
    class: 'rest anim-fade',
    style: `--rows:${perColumn}; --rest-size:${perColumn > 12 ? '1.9vh' : perColumn > 8 ? '2.5vh' : '3vh'}; animation-delay:${steps.length * 900}ms`,
  }, rest.map((row) =>
    h('div', { class: 'rest__row' },
      h('span', { class: 'n' }, `#${row.rank}`),
      h('span', { class: 'a' }, row.avatar),
      h('span', { class: 'name' }, row.name),
      h('span', null, `$${row.total}`)))) : null;

  app.replaceChildren(h('section', { class: 'finale' },
    h('h1', null, `🏆 Final standings · ${plural(rows.length, 'player')}`),
    podium,
    list,
  ));
}
