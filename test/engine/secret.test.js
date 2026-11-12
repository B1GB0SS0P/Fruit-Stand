import { describe, it, expect } from 'vitest';
import {
  submit, select, change, expire, deadline, nextRound, revealSecrets, showStandings, currentRound,
} from '../../game/engine.js';
import { playerView, screenView, hostView, publicResults, publicConfig } from '../../game/views.js';
import { scoreRound } from '../../game/scoring.js';
import { resultsCsv } from '../../game/csv.js';
import { started, submitAll, advanceTo, sellers, allKeys, testRandom, T0 } from './helpers.js';

const NOW = T0 + 1000;

const everyView = (game) => [
  ...game.players.map((p) => playerView(game, p.id, NOW)),
  screenView(game, NOW),
  hostView(game, NOW),
];

// Keys that must never appear in anything sent to a client mid-game.
const INTERNAL_KEYS = ['selections', 'earnings', 'bidType', 'fruitOf', 'lowest', 'winners', 'units', 'token', 'revokedTokens', 'rngState', 'teams', 'rounds'];

function expectNoLeaks(game) {
  for (const view of everyView(game)) {
    const keys = allKeys(view);
    for (const key of INTERNAL_KEYS) expect(keys.has(key), `${view.role} view has "${key}"`).toBe(false);
    if (view.role === 'host') {
      for (const key of ['price', 'selection', 'results', 'total']) {
        expect(keys.has(key), `host view has "${key}"`).toBe(false);
      }
    } else {
      expect(keys.has('rejoinCode')).toBe(false);
      expect(view.standings).toBeNull();
      for (const round of view.results) {
        for (const entry of round.fruits) {
          if (entry.secret) expect(entry.price).toBeNull();
        }
      }
    }
  }
}

describe('Secret Market', () => {
  it('happens only in round 2', () => {
    const game = started(16);
    for (let r = 1; r <= 4; r++) {
      const round = currentRound(game);
      if (r === 2) expect(round.secret.length).toBeGreaterThan(0);
      else expect(round.secret).toEqual([]);
      // Curtains and ambience: only while round 2 is being played.
      for (const view of everyView(game)) {
        expect(view.curtained).toBe(r === 2);
        expect(Array.isArray(view.ambient)).toBe(r === 2);
      }
      submitAll(game);
      for (const view of everyView(game)) {
        expect(view.curtained).toBe(false);
        expect(view.ambient).toBeNull();
      }
      const hidden = publicResults(game)[r - 1].fruits.filter((entry) => entry.secret);
      expect(hidden).toHaveLength(r === 2 ? round.secret.length : 0);
      if (r < 4) nextRound(game, T0);
    }
  });

  it.each([4, 6, 8, 12, 20, 28, 40, 60])('%i players: the count matches the formula', (n) => {
    const game = started(n);
    advanceTo(game, 2);
    const k = game.activeFruits.length;
    const expected = Math.max(1, Math.floor(k * 0.25 + 0.5));
    const { secret } = currentRound(game);
    expect(secret).toHaveLength(expected);
    expect(new Set(secret).size).toBe(expected);
    for (const fruit of secret) expect(game.activeFruits).toContain(fruit);
  });

  it('gives 5 secret fruits with 40 players and at least 1 with 4', () => {
    const big = started(40);
    advanceTo(big, 2);
    expect(currentRound(big).secret).toHaveLength(5);
    const small = started(4);
    advanceTo(small, 2);
    expect(currentRound(small).secret).toHaveLength(1);
  });

  it('follows secretShare, and secretRound 0 turns it off', () => {
    const half = started(16, { config: { secretShare: 0.5 } });
    advanceTo(half, 2);
    expect(currentRound(half).secret).toHaveLength(4);
    const off = started(16, { config: { secretRound: 0 } });
    advanceTo(off, 4);
    expect(off.rounds.every((round) => round.secret.length === 0)).toBe(true);
  });

  it('never picks a fruit that nobody sells', () => {
    const game = started(4, { seed: 2 });
    // Both sellers of one fruit move to the other in round 1.
    const [emptied, crowded] = game.activeFruits;
    for (const p of sellers(game)[emptied]) expect(change(game, p.id, 1, crowded, NOW).ok).toBe(true);
    advanceTo(game, 2);
    expect(currentRound(game).secret).toEqual([crowded]);
  });

  // Nothing a client receives may say which fruits are secret, or how many,
  // until round 2 has resolved. The ambient sequence is the one exception,
  // and it holds only emojis and timing.
  function expectSecretsHidden(game) {
    for (const view of everyView(game)) {
      for (const key of allKeys(view)) expect(key, `${view.role} view has "${key}"`).not.toMatch(/secret/i);
      const { ambient, ...rest } = view;
      for (const item of ambient ?? []) expect(Object.keys(item).sort()).toEqual(['delay', 'duration', 'emoji']);
      if (view.role !== 'host') {
        for (const round of rest.results) expect(round.round).toBeLessThan(game.config.secretRound);
      }
      // Identical for every recipient: no view is shaped by the secret list.
      expect(view.curtained).toBe(everyView(game)[0].curtained);
    }
    const keys = allKeys(publicConfig(game));
    for (const key of keys) expect(key).not.toMatch(/secret|weight/i);
  }

  it('never sends the secret list to anyone before round 2 resolves', () => {
    const game = started(16, { seed: 9 });
    expectSecretsHidden(game); // round 1 bidding
    submitAll(game);
    expectSecretsHidden(game); // round 1 results
    nextRound(game, T0);

    const round = currentRound(game);
    expect(round.secret.length).toBeGreaterThan(0);
    expectSecretsHidden(game); // round 2 opens
    const [a, b] = game.players;
    select(game, a.id, 2, 3, NOW);
    change(game, b.id, 2, round.secret.find((fruit) => fruit !== b.fruit), NOW);
    submit(game, b.id, 2, 4, NOW);
    expectSecretsHidden(game); // mid round 2, after a Change into a secret fruit

    // A view never differs by whether the recipient's own fruit is secret.
    const shapes = game.players.map((p) => Object.keys(playerView(game, p.id, NOW)).sort().join());
    expect(new Set(shapes).size).toBe(1);
    const flat = (view) => JSON.stringify({ ...view, me: null, teammate: null, rivals: null, changeTargets: null });
    expect(new Set(game.players.map((p) => flat(playerView(game, p.id, NOW)))).size).toBe(1);
  });

  it('curtains every stand in round 2, then keeps only the secret fruits hidden', () => {
    const game = started(12, { seed: 3 });
    advanceTo(game, 2);
    for (const view of everyView(game)) {
      expect(view.round).toBe(2);
      expect(view.curtained).toBe(true);
    }
    submitAll(game, () => 4);
    const { secret } = game.rounds[1];
    for (const view of [playerView(game, game.players[0].id, NOW), screenView(game, NOW)]) {
      expect(view.curtained).toBe(false);
      const shown = view.results.find((entry) => entry.round === 2);
      for (const entry of shown.fruits) {
        expect(entry.secret).toBe(secret.includes(entry.fruit));
        expect(entry.price).toBe(entry.secret ? null : 4);
      }
    }
    // The host still gets no results at all.
    expect(hostView(game, NOW).results).toBeUndefined();
  });

  it('is not hinted at before round 2', () => {
    const game = started(12);
    for (const view of everyView(game)) {
      expect(view.curtained).toBe(false);
      expect(view.ambient).toBeNull();
    }
    const keys = allKeys(publicConfig(game));
    expect(keys.has('secretRound')).toBe(false);
    expect(keys.has('secretShare')).toBe(false);
    expect(keys.has('ambientSecretWeight')).toBe(false);
  });

  it('scores secret fruits exactly like any other fruit', () => {
    const game = started(12, { seed: 4 });
    advanceTo(game, 2);
    const random = testRandom(11);
    const bids = {};
    for (const p of game.players) {
      bids[p.id] = 1 + Math.floor(random() * 5);
      submit(game, p.id, 2, bids[p.id], NOW);
    }
    const round = game.rounds[1];
    const fruitOf = Object.fromEntries(game.players.map((p) => [p.id, p.fruit]));
    const expected = scoreRound(fruitOf, bids);
    expect(round.results).toEqual(expected.results);
    expect(round.earnings).toEqual(expected.earnings);
    expect(round.secret.length).toBeGreaterThan(0);
  });

  it('keeps secret prices out of every payload until the end reveal', () => {
    const game = started(16, { seed: 6 });
    const random = testRandom(21);
    expectNoLeaks(game);
    for (let r = 1; r <= 4; r++) {
      for (const p of game.players) {
        select(game, p.id, r, 1 + Math.floor(random() * 5), NOW);
        expectNoLeaks(game);
      }
      for (const p of [...game.players]) submit(game, p.id, r, undefined, NOW);
      expect(game.status).toBe('results');
      expectNoLeaks(game);

      if (r >= 2) {
        const shown = publicResults(game).find((entry) => entry.round === 2);
        const hidden = shown.fruits.filter((entry) => entry.secret);
        expect(hidden.map((entry) => entry.fruit).sort()).toEqual([...game.rounds[1].secret].sort());
        expect(hidden.every((entry) => entry.price === null)).toBe(true);
        // Fruits that are not secret still show their price.
        for (const entry of shown.fruits.filter((e) => !e.secret)) {
          expect(entry.price).toBe(game.rounds[1].results[entry.fruit].lowest);
        }
      }
      if (r < 4) {
        nextRound(game, T0);
        expectNoLeaks(game);
      }
    }
  });

  it('reveals the correct prices at the end, then the standings', () => {
    const game = started(16, { seed: 6 });
    const random = testRandom(5);
    for (let r = 1; r <= 4; r++) {
      for (const p of [...game.players]) submit(game, p.id, r, 1 + Math.floor(random() * 5), NOW);
      if (r < 4) nextRound(game, T0);
    }
    expect(showStandings(game).error).toBe('not_revealed');
    expect(revealSecrets(game).ok).toBe(true);
    expect(game.status).toBe('reveal');

    const round2 = game.rounds[1];
    for (const view of [playerView(game, game.players[0].id, NOW), screenView(game, NOW)]) {
      const shown = view.results.find((entry) => entry.round === 2);
      const secrets = shown.fruits.filter((entry) => entry.secret);
      expect(secrets).toHaveLength(round2.secret.length);
      for (const entry of secrets) {
        const bids = game.players.filter((p) => round2.fruitOf[p.id] === entry.fruit).map((p) => round2.selections[p.id]);
        expect(entry.price).toBe(Math.min(...bids));
      }
      expect(view.standings).toBeNull(); // not until the host shows them
    }

    expect(showStandings(game).ok).toBe(true);
    for (const view of everyView(game)) {
      expect(view.status).toBe('final');
      expect(view.standings).toHaveLength(16);
      expect(Object.keys(view.standings[0]).sort()).toEqual(['avatar', 'id', 'name', 'rank', 'ring', 'total']);
      expect(view.standings[0].total).toMatch(/^\d+\.\d{2}$/);
    }
  });

  it('cannot be revealed before round 4 resolves', () => {
    const game = started(8);
    expect(revealSecrets(game).error).toBe('not_finished');
    advanceTo(game, 4);
    expect(revealSecrets(game).error).toBe('not_finished');
    submitAll(game);
    expect(revealSecrets(game).ok).toBe(true);
  });
});

describe('privacy', () => {
  it('results payloads contain only fruit and lowest price, plus the secret flag for round 2', () => {
    const game = started(10);
    advanceTo(game, 3);
    const results = publicResults(game);
    expect(results).toHaveLength(2);
    for (const round of results) {
      expect(Object.keys(round).sort()).toEqual(['fruits', 'phase', 'round']);
      expect(round.fruits).toHaveLength(game.activeFruits.length);
      const keys = round.round === 2 ? ['fruit', 'price', 'secret'] : ['fruit', 'price'];
      for (const entry of round.fruits) expect(Object.keys(entry).sort()).toEqual(keys);
    }
    const names = game.players.map((p) => p.name);
    const text = JSON.stringify(results);
    for (const name of names) expect(text).not.toContain(name);
  });

  it('lists only fruits that had at least one seller', () => {
    const game = started(4, { seed: 2 });
    const [emptied, crowded] = game.activeFruits;
    for (const p of sellers(game)[emptied]) change(game, p.id, 1, crowded, NOW);
    submitAll(game, () => 3);
    expect(publicResults(game)[0].fruits).toEqual([{ fruit: crowded, price: 3 }]);
  });

  it("a player's view holds only their own selection", () => {
    const game = started(8);
    const [a, b] = game.players;
    select(game, a.id, 1, 2, NOW);
    submit(game, b.id, 1, 4, NOW);
    expect(playerView(game, a.id, NOW).me).toMatchObject({ selection: 2, submitted: false });
    expect(playerView(game, b.id, NOW).me).toMatchObject({ selection: 4, submitted: true });
    const other = playerView(game, game.players[2].id, NOW);
    expect(other.me).toMatchObject({ selection: null, submitted: false });
    expect(other.bidsIn).toBe(1);
    expect(other.players).toBeUndefined();
  });

  it("the host's status view shows who has submitted, never a price", () => {
    const game = started(8);
    const [a, b] = game.players;
    select(game, a.id, 1, 2, NOW);
    submit(game, b.id, 1, 4, NOW);
    const view = hostView(game, NOW);
    expect(view.players.find((p) => p.id === a.id).submitted).toBe(false);
    expect(view.players.find((p) => p.id === b.id).submitted).toBe(true);
    for (const player of view.players) {
      expect(Object.keys(player).sort()).toEqual(['avatar', 'fruit', 'id', 'name', 'rejoinCode', 'ring', 'submitted']);
    }
    advanceTo(game, 4);
    submitAll(game);
    expectNoLeaks(game);
    expect(hostView(game, NOW).standings).toBeNull();
  });

  it('shows the lobby player list to the screen and host only', () => {
    const game = started(4);
    expect(screenView(game, NOW).players).toEqual([]);
  });
});

describe('results CSV', () => {
  function finishedGame() {
    const game = started(8, { seed: 3 });
    const random = testRandom(3);
    for (let r = 1; r <= 4; r++) {
      const [, picker, ...rest] = game.players;
      select(game, picker.id, r, 2, NOW);
      for (const p of rest) submit(game, p.id, r, 1 + Math.floor(random() * 5), NOW);
      // Two players never submit, so the timer closes the round.
      expect(game.status).toBe('bidding');
      expect(expire(game, r, deadline(game)).ok).toBe(true);
      if (r < 4) nextRound(game, T0);
    }
    return game;
  }

  it('is refused before the game ends', () => {
    const game = finishedGame();
    expect(() => resultsCsv(game)).toThrow();
    revealSecrets(game);
    expect(() => resultsCsv(game)).toThrow();
  });

  it('lists every bid with earnings, marks secret fruits and auto-bids, and gives totals', () => {
    const game = finishedGame();
    revealSecrets(game);
    showStandings(game);
    const csv = resultsCsv(game);
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('Round,Phase,Player,Teammate,Fruit,Secret fruit,Bid,Bid type,Fruit lowest price,Earnings');

    const bidRows = lines.slice(1, 1 + 8 * 4).map((line) => line.split(','));
    expect(bidRows).toHaveLength(32);

    const fruitNameOf = (id) => game.config.fruits.find((f) => f.id === id).name;
    const secretNames = game.rounds[1].secret.map(fruitNameOf);
    for (const row of bidRows) {
      const [round, phase, , , fruit, secret, bid, , lowest, earned] = row;
      expect(phase).toBe(Number(round) <= 2 ? '1' : '2');
      expect(secret).toBe(round === '2' && secretNames.includes(fruit) ? 'yes' : 'no');
      expect(Number(bid)).toBeGreaterThanOrEqual(Number(lowest));
      expect(earned).toMatch(/^\d+\.\d{2}$/);
    }
    expect(bidRows.filter((row) => row[5] === 'yes').length).toBeGreaterThan(0);

    const [lazy, picker] = game.players;
    const lazyRows = bidRows.filter((row) => row[2] === lazy.name);
    expect(lazyRows.every((row) => row[6] === '5' && row[7] === 'auto (no bid so max price)')).toBe(true);
    const pickerRows = bidRows.filter((row) => row[2] === picker.name);
    expect(pickerRows.every((row) => row[6] === '2' && row[7] === 'auto (selected but not submitted)')).toBe(true);
    expect(bidRows.some((row) => row[7] === 'submitted')).toBe(true);

    expect(csv).toContain('Secret fruits');
    for (const name of secretNames) expect(csv).toContain(`2,${name},`);

    const standingsStart = lines.indexOf('Final standings');
    expect(standingsStart).toBeGreaterThan(0);
    const standingRows = lines.slice(standingsStart + 2);
    expect(standingRows).toHaveLength(8);
    expect(standingRows[0].startsWith('1,')).toBe(true);
    for (const row of standingRows) expect(row.split(',')[6]).toMatch(/^\d+\.\d{2}$/);
  });

  it('escapes awkward names', async () => {
    const { createGame, addPlayer, startGame } = await import('../../game/engine.js');
    const game = createGame({ code: 'CSV', seed: 1 });
    ['Lee, Jr', '=SUM(A1)', 'Say "hi"', 'Dana'].forEach((name, i) => {
      addPlayer(game, { name, avatar: '🐶', token: `t${i}` });
    });
    startGame(game, T0);
    for (let r = 1; r <= 4; r++) {
      submitAll(game);
      if (r < 4) nextRound(game, T0);
    }
    revealSecrets(game);
    showStandings(game);
    const csv = resultsCsv(game);
    expect(csv).toContain('"Lee, Jr"');
    expect(csv).toContain("'=SUM(A1)");
    expect(csv).toContain('"Say ""hi"""');
  });
});
