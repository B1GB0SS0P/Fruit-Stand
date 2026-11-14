// The projector: lobby, market, results, the reveal and final standings.
// Read-only: it never sends anything but "watch this room".

import {
  $, h, toast, connect, call, watchConnection, Countdown, clockText,
  fruitLookup, makeStand, loadContent, prefersReducedMotion, plural, avatarEl, rankLabel,
} from './common.js';
import { mountScene, sceneFor } from './scene.js';
import { byPlace, placeText } from './predict.js';

const app = $('#app');
const fx = $('#fx');
const socket = connect();
watchConnection(socket);

const code = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
let config = null;
let fruitOf = () => null;
let state = null;
let sceneKey = null;
let teaser = 'Some stands might close up shop… 👀';
let closedNote = 'Some stands stayed closed. Their prices stay hidden until the end — even from their sellers.';
let teaserPlayedFor = null; // round whose teaser card has been shown
let revealTimers = [];
const shownPeople = new Set();
let ambientItems = null; // round 2 background sequence
const scene = mountScene('projector');

loadContent().then((content) => {
  teaser = content.secretTeaser || teaser;
  closedNote = content.secretResults || closedNote;
}).catch(() => {});

const later = (fn, ms) => revealTimers.push(setTimeout(fn, ms));

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
  scene.set(sceneFor(state), config.skyTheme);
  // The sequence arrives once, with the first update of the round.
  if (state.ambient) ambientItems = state.ambient;
  else if (!state.curtained) ambientItems = null;
  if (ambientItems) {
    scene.ambient.start(ambientItems, config.ambientCountProjector, config.bidSeconds * 1000 - state.timer.remainingMs);
  } else scene.ambient.stop();
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
    else if (state.status === 'predictions') buildPredictions();
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
      h('p', { class: 'top__note' }, state.predicting.locked
        ? '🔮 Predictions locked'
        : `🔮 Predictions lock at round ${state.predicting.lockRound}`),
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
        h('div', { class: 'lobby__head' },
          h('div', { class: 'lobby__count', id: 'count' }),
          h('div', { class: 'chalk-sign' }, 'Opening soon'),
        ),
        h('div', { class: 'crowd', id: 'crowd' }),
      ),
    ),
  );
}

function updateLobby() {
  const crowd = $('#crowd');
  // Predictors stay in the crowd, marked with a crystal ball. A chip is
  // redrawn when someone switches between player and predictor.
  const people = [
    ...state.players.map((p) => ({ ...p, key: `player:${p.name}` })),
    ...state.predictors.map((p) => ({ ...p, key: `predictor:${p.name}`, predictor: true })),
  ];
  const keys = new Set(people.map((p) => p.key));
  for (const chip of [...crowd.children]) {
    if (!keys.has(chip.dataset.key)) {
      shownPeople.delete(chip.dataset.key);
      chip.remove();
    }
  }
  for (const person of people) {
    if (shownPeople.has(person.key)) continue;
    shownPeople.add(person.key);
    crowd.append(h('div', { class: `person anim-pop${person.predictor ? ' person--predictor' : ''}`, 'data-key': person.key },
      avatarEl(person.avatar, person.ring), h('span', null, person.name), person.predictor ? h('b', null, '🔮') : null));
  }
  const n = state.players.length;
  const total = people.length;
  crowd.style.setProperty('--crowd-size', total > 44 ? '2vh' : total > 40 ? '2.3vh' : total > 28 ? '2.6vh' : total > 14 ? '3.3vh' : '4.2vh');
  $('#count').replaceChildren(String(n), h('small', null,
    ` ${n === 1 ? 'player' : 'players'} in the market${state.predictors.length ? ` · ${plural(state.predictors.length, 'predictor')}` : ''}`));
}

// ----- a round -----

function buildRound() {
  // In the secret round every stand is curtained, so nothing is given away.
  const playTeaser = state.curtained && teaserPlayedFor !== state.round && state.bidsIn === 0;
  if (state.curtained) teaserPlayedFor = state.round;

  const stands = state.activeFruits.map((id) =>
    makeStand(fruitOf(id), { covered: state.curtained && !playTeaser }));
  const market = buildMarket(stands);

  app.replaceChildren(
    topBar(
      h('div', { class: 'bigtimer', id: 'timer', role: 'timer' }),
      [h('span', { id: 'bids' }), h('small', null, 'prices locked in')],
    ),
    market,
  );
  if (playTeaser) playTeaserCard(stands);
}

// A short teaser card, then a curtain drops over every stand.
function playTeaserCard(stands) {
  const card = h('div', { class: 'intro-card anim-pop' }, h('h1', null, teaser));
  fx.append(card);
  const CARD_MS = 3600;
  later(() => card.classList.add('is-leaving'), CARD_MS);
  later(() => card.remove(), CARD_MS + 700);
  stands.forEach((stand, i) => later(() => stand.classList.add('is-covered'), CARD_MS + 200 + i * 90));
}

// ----- results -----

function buildResults() {
  const round = state.results.find((r) => r.round === state.round);
  const sold = new Map(round.fruits.map((entry) => [entry.fruit, entry]));
  const ids = [...state.activeFruits, ...round.fruits.map((f) => f.fruit).filter((id) => !state.activeFruits.includes(id))];
  // After the secret round the curtains lift, but only where a price is shown.
  const someClosed = round.fruits.some((f) => f.price === null);
  const LIFT_MS = someClosed ? 900 : 0;

  const stands = ids.map((id, i) => {
    const entry = sold.get(id);
    if (!entry) return makeStand(fruitOf(id), { dim: true, note: 'No sellers' });
    if (entry.price === null) return makeStand(fruitOf(id), { covered: true });
    const stand = makeStand(fruitOf(id), { tag: `$${entry.price}`, tagClass: 'anim-drop', covered: someClosed });
    stand.querySelector('.stand__tag').style.animationDelay = `${LIFT_MS + 300 + i * 140}ms`;
    if (someClosed) later(() => stand.classList.remove('is-covered'), 500 + i * 90);
    return stand;
  });

  app.replaceChildren(
    topBar(h('div', { class: 'bigtimer bigtimer--label' }, 'Lowest prices'), [`Round ${state.round}`, h('small', null, 'results')]),
    buildMarket(stands),
  );
  if (someClosed) app.append(h('p', { class: 'subtitle anim-fade' }, closedNote));
}

// ----- the end: secret prices, then standings -----

function buildReveal() {
  const secretRound = state.results.find((r) => r.fruits.some((f) => f.secret));
  const secrets = secretRound ? secretRound.fruits.filter((f) => f.secret) : [];
  const stands = secrets.map((entry) => makeStand(fruitOf(entry.fruit), { covered: true }));
  const market = buildMarket(stands);

  app.replaceChildren(
    h('header', { class: 'top' },
      h('div', { class: 'top__left' }, h('h1', null, '🙈 The closed stands'), h('p', null, secretRound ? `Round ${secretRound.round} · the hidden prices` : '')),
      h('div', { class: 'bigtimer bigtimer--label' }, 'The reveal'),
      h('div', { class: 'top__right' }, h('span', { id: 'revealed' }, `0 / ${secrets.length}`), h('small', null, 'uncovered')),
    ),
    market,
    h('p', { class: 'subtitle', id: 'reveal-note' }, secrets.length ? 'Here come the hidden prices…' : 'No hidden prices this game.'),
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

// ----- Predictors vs Host: one question at a time, then the scoreboard -----

const MAX_FACES = 4;

const faceEl = (p) => h('span', { class: 'pvh-face' }, avatarEl(p.avatar, p.ring), h('span', null, p.name));

function faces(list) {
  const shown = list.slice(0, MAX_FACES);
  return [shown.map(faceEl), list.length > shown.length ? h('span', { class: 'pvh-face' }, `+${list.length - shown.length} more`) : null];
}

// Counts up from 0 to n by sliding a strip of digits: a transform, no script.
function countUp(n) {
  return h('span', { class: 'countup', style: `--n:${n}` },
    h('span', { class: 'countup__strip' }, Array.from({ length: n + 1 }, (_, i) => h('span', null, String(i)))));
}

function predictionQuestions(reveal) {
  const { actual, playerCount } = reveal;
  const [upper, lower] = actual.middlePositions;
  const pickAnswer = (answer) => (answer.pick
    ? [faceEl(answer.pick), h('small', null, `finished ${placeText(answer.pick)} of ${playerCount}`)]
    : [h('span', { class: 'pvh-none' }, 'No answer')]);
  return [
    {
      key: 'median',
      title: 'Median total',
      sub: `The average of places ${upper} and ${lower} of ${playerCount}`,
      actual: () => h('div', { class: 'pvh-money' }, `$${actual.median}`),
      answer: (entry) => (entry.median.guess === null
        ? [h('span', { class: 'pvh-none' }, 'No answer')]
        : [h('span', { class: 'pvh-guess' }, `$${entry.median.guess}`), h('small', null, `off by $${entry.median.off}`)]),
    },
    {
      key: 'winner',
      title: 'Winner',
      sub: actual.first.length > 1 ? 'Tied for 1st place' : '1st place',
      actual: () => h('div', { class: 'pvh-faces' }, faces(actual.first)),
      answer: (entry) => pickAnswer(entry.winner),
    },
    {
      key: 'middle',
      title: 'Middle player',
      sub: `Places ${upper} and ${lower} of ${playerCount}`,
      actual: () => h('div', { class: 'pvh-faces' }, faces(actual.middle)),
      answer: (entry) => pickAnswer(entry.middle),
    },
  ];
}

function buildPredictions() {
  const reveal = state.predictionReveal;
  const entries = reveal.entries;
  const questions = predictionQuestions(reveal);
  const running = new Map(entries.map((entry) => [entry.id, 0]));

  const step = h('p', { id: 'pvh-step' }, 'Three questions. Fifteen points.');
  const stage = h('div', { class: 'pvh__stage' });
  const totals = h('footer', { class: 'pvh__totals' }, entries.map((entry) =>
    h('div', { class: 'pvh-total', 'data-id': entry.id },
      avatarEl(entry.avatar, entry.ring),
      h('span', { class: 'pvh-total__name' }, entry.name),
      h('b', null, '0'))));

  app.replaceChildren(h('section', { class: `pvh pvh--${Math.min(4, entries.length)}` },
    h('header', { class: 'pvh__head' }, h('h1', null, '🔮 Predictors vs Host'), step),
    stage,
    totals,
  ));

  const quick = prefersReducedMotion();
  const ACTUAL_MS = 1500;
  const ANSWERS_MS = 3200;
  const ANSWER_GAP_MS = 450;
  const POINTS_MS = ANSWERS_MS + entries.length * ANSWER_GAP_MS + 1100;
  const QUESTION_MS = POINTS_MS + 4200;

  function ask(question, index) {
    step.textContent = `Question ${index + 1} of ${questions.length}`;
    const actualBox = h('div', { class: 'pvh-actual__value is-waiting' }, question.actual());
    const rows = entries.map((entry) => ({
      entry,
      answer: h('div', { class: 'pvh-row__answer is-waiting' }, question.answer(entry)),
      points: h('div', { class: 'pvh-row__points is-waiting' }),
    }));
    stage.replaceChildren(h('div', { class: 'pvh__q anim-fade' },
      h('div', { class: 'pvh-actual' },
        h('div', { class: 'pvh-actual__label' }, `${index + 1} · ${question.title}`),
        h('div', { class: 'pvh-actual__sub' }, question.sub),
        actualBox,
        h('div', { class: 'pvh-actual__tag' }, 'The actual answer'),
      ),
      h('div', { class: 'pvh-rows' }, rows.map((row) => h('div', { class: 'pvh-row' },
        h('div', { class: 'pvh-row__who' }, avatarEl(row.entry.avatar, row.entry.ring), h('span', null, row.entry.name)),
        row.answer,
        row.points))),
    ));

    const show = (el, anim) => {
      el.classList.remove('is-waiting');
      el.classList.add(anim);
    };
    // 1. the actual answer, 2. everyone's answer beside it, 3. the points.
    later(() => show(actualBox, 'anim-pop'), ACTUAL_MS);
    rows.forEach((row, i) => later(() => show(row.answer, 'anim-slide'), ANSWERS_MS + i * ANSWER_GAP_MS));
    later(() => {
      for (const row of rows) {
        const got = row.entry[question.key].points;
        row.points.replaceChildren(h('span', { class: 'pvh-plus' }, '+'), quick ? String(got) : countUp(got), h('small', null, got === 1 ? 'pt' : 'pts'));
        row.points.classList.toggle('is-zero', got === 0);
        show(row.points, 'anim-pop');
        running.set(row.entry.id, running.get(row.entry.id) + got);
        const chip = totals.querySelector(`[data-id="${row.entry.id}"] b`);
        chip.textContent = String(running.get(row.entry.id));
        chip.classList.remove('anim-pop');
        void chip.offsetWidth;
        chip.classList.add('anim-pop');
      }
    }, POINTS_MS);
  }

  function scoreboard() {
    const ordered = byPlace(reveal);
    const champions = ordered.filter((entry) => entry.won);
    step.textContent = reveal.draw
      ? `🤝 It's a draw: ${champions.map((entry) => entry.name).join(' and ')}`
      : `🏆 ${champions[0].name} read the market best${reveal.tieBroken ? ' (closer on the median)' : ''}`;
    totals.classList.add('is-waiting');
    stage.replaceChildren(h('div', { class: 'pvh-board anim-fade' }, ordered.map((entry, i) =>
      h('div', { class: `pvh-board__row anim-slide${entry.won ? ' is-won' : ''}`, style: `animation-delay:${i * 180}ms` },
        h('span', { class: 'pvh-board__place' }, entry.won ? (reveal.draw ? '🤝' : '🏆') : `#${entry.place}`),
        avatarEl(entry.avatar, entry.ring),
        h('span', { class: 'pvh-board__name' }, entry.name),
        h('span', { class: 'pvh-board__parts' },
          h('span', null, 'Median ', h('b', null, String(entry.median.points))),
          h('span', null, 'Winner ', h('b', null, String(entry.winner.points))),
          h('span', null, 'Middle ', h('b', null, String(entry.middle.points)))),
        h('span', { class: 'pvh-board__score' }, String(entry.score), h('small', null, ` / ${reveal.maxScore}`))))));
    confetti();
  }

  questions.forEach((question, i) => later(() => ask(question, i), 1600 + i * QUESTION_MS));
  later(scoreboard, 1600 + questions.length * QUESTION_MS);
}

// ----- final standings: a podium of market stalls, then the full board -----

const PLACE = ['1st', '2nd', '3rd'];
const STEP_GAP_MS = 2400;
const MAX_ON_STEP = 6;

// A podium step drawn as a stall: winners on top, striped awning, a
// chalkboard with the place and total, and crates underneath.
function stall(rank, group) {
  const shown = group.slice(0, MAX_ON_STEP);
  const extra = group.length - shown.length;
  return h('div', { class: `stall stall--${rank} is-waiting${group.length > 3 ? ' stall--crowded' : ''}`, 'data-rank': rank },
    h('div', { class: 'stall__people' },
      shown.map((row) => h('div', { class: 'winner' },
        avatarEl(row.avatar, row.ring, 'winner__avatar'),
        h('div', { class: 'winner__name' }, row.name))),
      extra > 0 ? h('div', { class: 'winner winner--more' }, `+${extra}`) : null,
    ),
    h('div', { class: 'stall__awning' }),
    h('div', { class: 'stall__body' },
      h('div', { class: 'stall__sign' },
        h('b', null, group.length > 1 ? `T-${rank}` : PLACE[rank - 1]),
        h('span', null, `$${group[0].total}`)),
      h('div', { class: 'stall__crates' }, h('i'), h('i'), h('i')),
    ),
  );
}

function confetti() {
  if (prefersReducedMotion()) return;
  const colors = ['#e2552d', '#f7bb3d', '#2ba39b', '#d9527f', '#fff4dd', '#8e5bd0'];
  const pieces = Array.from({ length: 90 }, (_, i) => h('i', {
    class: 'confetti',
    style: `left:${Math.random() * 100}vw; background:${colors[i % colors.length]}; --spin:${Math.round(Math.random() * 900 - 450)}deg; --slide:${Math.round(Math.random() * 16 - 8)}vw; animation-duration:${(3.2 + Math.random() * 2.8).toFixed(2)}s; animation-delay:${(Math.random() * 1.6).toFixed(2)}s`,
  }));
  fx.append(...pieces);
  later(() => pieces.forEach((piece) => piece.remove()), 8500);
}

function buildFinal() {
  const rows = state.standings;

  // A step is picked by the rank number itself. Two players tied for 1st
  // share the top stall; the next player is 3rd and stands on the 3rd one.
  const stalls = [1, 2, 3]
    .map((rank) => ({ rank, group: rows.filter((row) => row.rank === rank) }))
    .filter((step) => step.group.length)
    .map((step) => stall(step.rank, step.group));
  const podium = h('div', { class: 'podium' }, stalls);

  // Everyone, in 2-3 columns (4 only for very large rooms).
  const columns = rows.length > 45 ? 4 : rows.length > 24 ? 3 : 2;
  const perColumn = Math.max(1, Math.ceil(rows.length / columns));
  const board = h('div', {
    class: 'rest is-waiting',
    style: `--rows:${perColumn}; --cols:${columns}; --rest-size:${Math.min(3, (38 / perColumn) * 0.72).toFixed(2)}vh`,
  }, rows.map((row) =>
    h('div', { class: `rest__row${row.rank <= 3 ? ' is-top' : ''}` },
      h('span', { class: 'n' }, rankLabel(row, rows)),
      avatarEl(row.avatar, row.ring),
      h('span', { class: 'name' }, row.name),
      h('span', { class: 't' }, `$${row.total}`))));

  app.replaceChildren(h('section', { class: 'finale' },
    h('h1', null, `🏆 Final standings · ${plural(rows.length, 'player')}`),
    podium,
    board,
  ));

  // 3rd, then 2nd, then 1st, with a pause between each. Then the board.
  const order = [...stalls].sort((a, b) => b.dataset.rank - a.dataset.rank);
  const show = (el) => {
    el.classList.remove('is-waiting');
    el.classList.add(el === board ? 'anim-fade' : 'anim-pop');
  };
  order.forEach((el, i) => later(() => {
    show(el);
    if (el.dataset.rank === '1') confetti();
  }, 900 + i * STEP_GAP_MS));
  later(() => show(board), 900 + order.length * STEP_GAP_MS - 600);
}
