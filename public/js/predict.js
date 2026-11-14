// The predictions side game, shared by the predictor's phone and the host
// page: the three-question form, its locked summary, the predictor's
// receipt and the small scoreboard.

import { h, toast, avatarEl } from './common.js';

const MONEY = /^\$?\d{1,7}(\.\d{1,2})?$/;
const SAVE_DELAY_MS = 700;

const ordinal = (n) => {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
  return `${n}${suffix}`;
};

const person = (p, extraClass = '') =>
  h('span', { class: `who ${extraClass}`.trim() }, avatarEl(p.avatar, p.ring), h('span', { class: 'who__name' }, p.name));

export const placeText = (pick) => `${pick.tied ? 'T-' : '#'}${pick.rank}`;

// ---------- the form ----------

// Builds the form once. Call update() with every new state: the page around
// it can redraw freely while a half-typed answer and the keyboard stay put.
//   save(answers) sends { median, winner, middle } and resolves with the reply.
export function createPredictionForm({ save, title = '🔮 Your predictions' }) {
  const el = h('section', { class: 'card predict' });
  let players = [];
  let serverJson = null;
  let server = { median: null, winner: null, middle: null };
  const draft = { median: null, winner: null, middle: null };
  let locked = null;
  let lockRound = 0;
  let open = null; // which picker is open: 'winner' | 'middle' | null
  let timer = null;
  let justSaved = false;

  const lockChip = h('span', { class: 'predict__chip' });
  const top = h('div', { class: 'predict__slot' });
  const bottom = h('div', { class: 'predict__slot' });
  const status = h('p', { class: 'predict__status', 'aria-live': 'polite' });

  // Question 1: a dollar amount.
  const medianInput = h('input', {
    class: 'input predict__money', type: 'text', inputmode: 'decimal', autocomplete: 'off',
    maxlength: '10', placeholder: '0.00', 'aria-label': 'Median total in dollars',
  });
  const medianError = h('p', { class: 'error', hidden: true }, 'Use dollars and cents, like 14.50.');
  const medianHint = h('p', { class: 'predict__hint' });

  function readMedian() {
    const text = medianInput.value.trim();
    if (!text) return { ok: true, value: null };
    return MONEY.test(text) ? { ok: true, value: text.replace('$', '') } : { ok: false };
  }

  function medianChanged(now) {
    clearTimeout(timer);
    const read = readMedian();
    medianError.hidden = read.ok;
    if (!read.ok) return;
    draft.median = read.value;
    if (now) commit();
    else timer = setTimeout(commit, SAVE_DELAY_MS);
  }
  medianInput.addEventListener('input', () => medianChanged(false));
  medianInput.addEventListener('change', () => medianChanged(true));
  medianInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') medianInput.blur();
  });

  // Questions 2 and 3: pick a player, with search.
  function makePicker(key, empty) {
    const chosen = h('button', { class: 'pick__chosen', type: 'button', 'aria-expanded': 'false' });
    const search = h('input', {
      class: 'input pick__search', type: 'search', placeholder: 'Search by name', autocomplete: 'off', 'aria-label': 'Search players',
    });
    const list = h('div', { class: 'pick__list' });
    const panel = h('div', { class: 'pick__panel', hidden: true }, search, list);

    function paintList() {
      const wanted = search.value.trim().toLowerCase();
      const shown = players.filter((p) => p.name.toLowerCase().includes(wanted));
      list.replaceChildren(...(shown.length
        ? shown.map((p) => h('button', {
          class: `pick__option${draft[key] === p.id ? ' is-picked' : ''}`, type: 'button',
          onclick: () => {
            draft[key] = p.id;
            open = null;
            search.value = '';
            paint();
            commit();
          },
        }, person(p)))
        : [h('p', { class: 'muted pick__none' }, 'Nobody by that name.')]));
    }

    function paintPicker() {
      const picked = players.find((p) => p.id === draft[key]);
      chosen.replaceChildren(
        picked ? person(picked) : h('span', { class: 'pick__empty' }, empty),
        h('span', { class: 'pick__more' }, open === key ? 'Close' : picked ? 'Change' : 'Pick'),
      );
      chosen.classList.toggle('is-set', Boolean(picked));
      chosen.setAttribute('aria-expanded', String(open === key));
      panel.hidden = open !== key;
      if (open === key) paintList();
    }

    chosen.addEventListener('click', () => {
      open = open === key ? null : key;
      paint();
      if (open === key && window.matchMedia('(hover: hover)').matches) search.focus();
    });
    search.addEventListener('input', paintList);
    return { el: h('div', { class: 'pick' }, chosen, panel), paint: paintPicker };
  }

  const winnerPicker = makePicker('winner', 'Nobody picked yet');
  const middlePicker = makePicker('middle', 'Nobody picked yet');
  const middleHint = h('p', { class: 'predict__hint' });

  const question = (n, name, hint, ...body) => h('div', { class: 'predict__q' },
    h('div', { class: 'predict__label' }, h('b', null, String(n)), name), hint, body);

  const openBody = [
    top,
    question(1, 'Median total', medianHint,
      h('label', { class: 'predict__dollar' }, h('span', null, '$'), medianInput), medianError),
    question(2, 'Winner', h('p', { class: 'predict__hint' }, 'Who finishes 1st?'), winnerPicker.el),
    question(3, 'Middle player', middleHint, middlePicker.el),
    status,
    bottom,
  ];

  const answered = () => [server.median, server.winner, server.middle].filter((v) => v !== null).length;

  function paintStatus(text = null) {
    const n = answered();
    status.className = `predict__status${n === 3 ? ' is-done' : ''}`;
    status.replaceChildren(text || (n === 3
      ? `✅ All 3 saved. You can change them until round ${lockRound} starts.`
      : `${n} of 3 answered. Each answer saves by itself. A missing one scores 0.`));
    if (justSaved) {
      status.classList.remove('anim-pop');
      void status.offsetWidth;
      status.classList.add('anim-pop');
      justSaved = false;
    }
  }

  async function commit() {
    clearTimeout(timer);
    if (locked) return;
    paintStatus('Saving…');
    const reply = await save({ median: draft.median, winner: draft.winner, middle: draft.middle });
    if (reply.ok) justSaved = true;
    else {
      toast(reply.message || 'That did not save.', 'error', 6000);
      paintStatus(`⚠️ Not saved: ${reply.message || 'try again'}`);
    }
  }

  function lockedBody() {
    const pick = (id) => players.find((p) => p.id === id);
    const line = (name, value) => h('div', { class: 'predict__locked-line' },
      h('span', { class: 'predict__locked-label' }, name),
      value ?? h('span', { class: 'predict__missing' }, 'No answer · 0 points'));
    return [
      top,
      h('div', { class: 'predict__locked' },
        line('Median total', server.median !== null ? h('b', null, `$${server.median}`) : null),
        line('Winner', pick(server.winner) ? person(pick(server.winner)) : null),
        line('Middle player', pick(server.middle) ? person(pick(server.middle)) : null),
      ),
      h('p', { class: 'predict__status' }, 'Nobody else can see these. They are revealed on the big screen at the end.'),
      bottom,
    ];
  }

  function paint() {
    const n = players.length;
    lockChip.textContent = locked ? '🔒 Locked' : `Locks when round ${lockRound} starts`;
    lockChip.classList.toggle('is-locked', Boolean(locked));
    const head = h('div', { class: 'predict__head' }, h('h2', null, locked ? '🔒 Predictions locked' : title), lockChip);
    if (locked) {
      el.replaceChildren(head, ...lockedBody());
      return;
    }
    medianHint.textContent = `The average of the two middle totals: places ${n / 2} and ${n / 2 + 1} of ${n}.`;
    middleHint.textContent = `Who finishes ${ordinal(n / 2)} or ${ordinal(n / 2 + 1)} of ${n}?`;
    winnerPicker.paint();
    middlePicker.paint();
    paintStatus();
    if (el.firstChild !== head && !el.contains(top)) el.replaceChildren(head, ...openBody);
    else el.firstChild.replaceWith(head);
  }

  return {
    el,
    // slots: extra nodes above and below the questions (the host's tick box
    // and the list of who has answered).
    update({ players: list, prediction, locked: isLocked, lockRound: round, above = [], below = [] }) {
      const wasLocked = locked;
      players = list;
      lockRound = round;
      locked = isLocked;
      const json = JSON.stringify(prediction);
      if (json !== serverJson) {
        serverJson = json;
        server = prediction || { median: null, winner: null, middle: null };
        draft.winner = server.winner;
        draft.middle = server.middle;
        if (document.activeElement !== medianInput) {
          draft.median = server.median;
          medianInput.value = server.median ?? '';
          medianError.hidden = true;
        }
      }
      if (locked && !wasLocked) {
        clearTimeout(timer);
        open = null;
      }
      if (wasLocked !== locked && wasLocked !== null) el.replaceChildren();
      top.replaceChildren(...above);
      bottom.replaceChildren(...below);
      paint();
    },
  };
}

// ---------- after the reveal ----------

const receiptLine = (label, value, cls = '') =>
  h('div', { class: `receipt__line ${cls}`.trim() },
    h('span', { class: 'receipt__label' }, label),
    h('span', { class: 'receipt__price' }, value));

const points = (n) => `${n} pt${n === 1 ? '' : 's'}`;

// A predictor's own results, printed like the players' receipts.
export function predictionReceipt(entry, reveal, code, animate) {
  const { actual, playerCount } = reveal;
  const rule = () => h('div', { class: 'receipt__rule' });
  const head = (text) => h('div', { class: 'receipt__section' }, text);
  const pickLines = (answer) => (answer.pick
    ? [receiptLine('Your pick', answer.pick.name), receiptLine('Finished', `${placeText(answer.pick)} of ${playerCount}`)]
    : [receiptLine('Your pick', 'no answer')]);
  const result = entry.won ? (reveal.draw ? '🤝 Draw' : '🏆 Winner') : `${ordinal(entry.place)} of ${reveal.entries.length}`;

  return h('section', { class: `receipt${animate ? ' anim-slide' : ''}` },
    h('div', { class: 'receipt__head' },
      avatarEl(entry.avatar, entry.ring, 'receipt__avatar'),
      h('div', { class: 'receipt__shop' }, `${entry.name}'s predictions`),
      h('div', { class: 'receipt__sub' }, `Predictors vs Host · Room ${code}`),
    ),
    rule(),
    head('1 · Median total'),
    receiptLine('Your guess', entry.median.guess === null ? 'no answer' : `$${entry.median.guess}`),
    receiptLine('Actual', `$${actual.median}`),
    receiptLine(entry.median.off === null ? 'Points' : `Off by $${entry.median.off}`, points(entry.median.points), 'receipt__line--points'),
    rule(),
    head('2 · Winner'),
    pickLines(entry.winner),
    receiptLine('Actual winner', actual.first.map((p) => p.name).join(', ')),
    receiptLine('Points', points(entry.winner.points), 'receipt__line--points'),
    rule(),
    head('3 · Middle player'),
    pickLines(entry.middle),
    receiptLine('Middle places', actual.middlePositions.join(' & ')),
    receiptLine('Points', points(entry.middle.points), 'receipt__line--points'),
    h('div', { class: 'receipt__rule receipt__rule--double' }),
    receiptLine('TOTAL', `${entry.score} / ${reveal.maxScore}`, 'receipt__line--total'),
    receiptLine('RESULT', result, 'receipt__line--total'),
    h('div', { class: 'receipt__thanks' }, '* thank you for predicting *'),
  );
}

// Entrants from best to worst.
export const byPlace = (reveal) => [...reveal.entries].sort((a, b) => a.place - b.place);

// A compact scoreboard: one row per entrant with points per question.
export function predictionBoard(reveal) {
  return h('table', { class: 'pboard' },
    h('thead', null, h('tr', null,
      h('th', null, ''), h('th', null, 'Median'), h('th', null, 'Winner'), h('th', null, 'Middle'), h('th', null, 'Total'))),
    h('tbody', null, byPlace(reveal).map((entry) => h('tr', { class: entry.won ? 'is-won' : '' },
      h('td', null, person(entry), entry.won ? (reveal.draw ? ' 🤝' : ' 🏆') : ''),
      h('td', null, String(entry.median.points)),
      h('td', null, String(entry.winner.points)),
      h('td', null, String(entry.middle.points)),
      h('td', { class: 'pboard__total' }, `${entry.score} / ${reveal.maxScore}`)))),
  );
}
