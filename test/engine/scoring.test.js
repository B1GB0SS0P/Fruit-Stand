import { describe, it, expect } from 'vitest';
import { scoreRound, computeStandings } from '../../game/scoring.js';
import { frac, add, ZERO, equal, toMoney } from '../../game/frac.js';
import { submit, change, nextRound, revealSecrets, showStandings, currentRound } from '../../game/engine.js';
import { started, submitAll, sellers, testRandom, T0 } from './helpers.js';

const NOW = T0 + 1000;

describe('scoring a fruit', () => {
  it('pays a single lowest bidder for every unit', () => {
    const { results, earnings } = scoreRound({ a: 'apple', b: 'apple' }, { a: 4, b: 3 });
    expect(results.apple).toEqual({ units: 2, lowest: 3, winners: 1 });
    expect(earnings.a).toEqual(frac(0));
    expect(earnings.b).toEqual(frac(6));
  });

  it('splits a two-way tie', () => {
    const { results, earnings } = scoreRound({ a: 'apple', b: 'apple' }, { a: 5, b: 5 });
    expect(results.apple).toEqual({ units: 2, lowest: 5, winners: 2 });
    expect(earnings.a).toEqual(frac(5));
    expect(earnings.b).toEqual(frac(5));
  });

  it('handles a lone seller', () => {
    const { earnings } = scoreRound({ a: 'apple' }, { a: 4 });
    expect(earnings.a).toEqual(frac(4));
  });

  it('handles three sellers, with and without ties', () => {
    const fruitOf = { a: 'kiwi', b: 'kiwi', c: 'kiwi' };
    expect(scoreRound(fruitOf, { a: 2, b: 3, c: 5 }).earnings).toEqual({ a: frac(6), b: ZERO, c: ZERO });
    expect(scoreRound(fruitOf, { a: 3, b: 3, c: 5 }).earnings).toEqual({ a: frac(9, 2), b: frac(9, 2), c: ZERO });
    expect(scoreRound(fruitOf, { a: 1, b: 1, c: 1 }).earnings).toEqual({ a: frac(1), b: frac(1), c: frac(1) });
  });

  it('keeps awkward splits exact', () => {
    const fruitOf = { a: 'kiwi', b: 'kiwi', c: 'kiwi', d: 'kiwi', e: 'kiwi' };
    const { earnings } = scoreRound(fruitOf, { a: 1, b: 1, c: 1, d: 4, e: 5 });
    expect(earnings.a).toEqual(frac(5, 3));
    expect(equal([earnings.a, earnings.b, earnings.c].reduce(add, ZERO), frac(5))).toBe(true);
  });

  it('scores each fruit separately', () => {
    const { earnings } = scoreRound(
      { a: 'apple', b: 'apple', c: 'pear', d: 'pear' },
      { a: 1, b: 2, c: 5, d: 4 },
    );
    expect(earnings).toEqual({ a: frac(2), b: ZERO, c: ZERO, d: frac(8) });
  });

  it('scores a fruit with 1 or 3 sellers after a Change, inside a real game', () => {
    const game = started(8, { seed: 3 });
    const groups = sellers(game);
    const [fromFruit, toFruit] = game.activeFruits;
    const [mover, stayer] = groups[fromFruit];
    const [x, y] = groups[toFruit];
    expect(change(game, mover.id, 1, toFruit, NOW).ok).toBe(true);

    const bids = { [stayer.id]: 4, [mover.id]: 2, [x.id]: 2, [y.id]: 5 };
    for (const p of game.players) submit(game, p.id, 1, bids[p.id] ?? 5, NOW);
    const round = game.rounds[0];
    expect(round.results[fromFruit]).toEqual({ units: 1, lowest: 4, winners: 1 });
    expect(round.results[toFruit]).toEqual({ units: 3, lowest: 2, winners: 2 });
    expect(round.earnings[stayer.id]).toEqual(frac(4));
    expect(round.earnings[mover.id]).toEqual(frac(3));
    expect(round.earnings[x.id]).toEqual(frac(3));
    expect(round.earnings[y.id]).toEqual(ZERO);
  });
});

function playRandomGame(n, seed) {
  const game = started(n, { seed });
  const random = testRandom(seed * 7 + n);
  for (let r = 1; r <= 4; r++) {
    for (const p of game.players) {
      if (random() < 0.15 && p.tokens > 0) {
        const target = game.activeFruits[Math.floor(random() * game.activeFruits.length)];
        change(game, p.id, r, target, NOW);
      }
    }
    for (const p of [...game.players]) submit(game, p.id, r, 1 + Math.floor(random() * 5), NOW);
    expect(game.status).toBe('results');
    if (r < 4) nextRound(game, T0);
  }
  revealSecrets(game);
  showStandings(game);
  return game;
}

describe('final totals', () => {
  it('match the formula: half of each team\'s combined earnings', () => {
    const game = playRandomGame(12, 5);
    const standings = computeStandings(game);
    expect(standings).toHaveLength(12);

    for (const row of standings) {
      let expected = ZERO;
      for (const phase of [1, 2]) {
        const pair = game.teams[phase].find((p) => p.includes(row.id));
        let team = ZERO;
        for (const round of game.rounds.filter((r) => r.phase === phase)) {
          for (const id of pair) team = add(team, round.earnings[id]);
        }
        expected = add(expected, frac(team.n, team.d * 2));
      }
      expect(equal(row.total, expected)).toBe(true);
      expect(row.totalText).toBe(toMoney(expected));
      expect(row.totalText).toMatch(/^\d+\.\d{2}$/);
    }
  });

  it.each([4, 8, 14, 40, 60])('%i players: the sum of totals equals the sum of all earnings', (n) => {
    for (const seed of [1, 2, 3]) {
      const game = playRandomGame(n, seed);
      const totals = computeStandings(game).map((row) => row.total).reduce(add, ZERO);
      let earned = ZERO;
      for (const round of game.rounds) for (const e of Object.values(round.earnings)) earned = add(earned, e);
      expect(equal(totals, earned)).toBe(true);
      expect(earned.n).toBeGreaterThan(0);
    }
  });

  it('ranks from highest total, with tied totals sharing a rank', () => {
    const game = started(8);
    for (let r = 1; r <= 4; r++) {
      submitAll(game, () => 5);
      if (r < 4) nextRound(game, T0);
    }
    const everyoneTied = computeStandings(game);
    expect(everyoneTied.every((row) => row.rank === 1 && row.totalText === '20.00')).toBe(true);

    const mixed = computeStandings(playRandomGame(20, 9));
    for (let i = 1; i < mixed.length; i++) {
      const prev = mixed[i - 1];
      const row = mixed[i];
      expect(prev.total.n * row.total.d).toBeGreaterThanOrEqual(row.total.n * prev.total.d);
      expect(row.rank).toBe(equal(row.total, prev.total) ? prev.rank : i + 1);
    }
    expect(mixed[0].rank).toBe(1);
  });

  it('uses the fruit each player held when the round resolved', () => {
    const game = started(8, { seed: 3 });
    const [fromFruit, toFruit] = game.activeFruits;
    const mover = sellers(game)[fromFruit][0];
    submitAll(game);
    nextRound(game, T0);
    change(game, mover.id, 2, toFruit, NOW);
    expect(game.rounds[0].fruitOf[mover.id]).toBe(fromFruit);
    submitAll(game);
    expect(currentRound(game).fruitOf[mover.id]).toBe(toFruit);
  });
});
