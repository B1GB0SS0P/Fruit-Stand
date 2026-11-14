import { describe, it, expect } from 'vitest';
import { lobby, started, advanceTo, sellers, T0 } from './helpers.js';
import { startGame } from '../../game/engine.js';
import { sellersPerFruit, activeFruitCount } from '../../game/deal.js';
import { defaultConfig } from '../../config.js';

const COUNTS = [];
for (let n = 4; n <= 60; n += 2) COUNTS.push(n);
const SEEDS = [1, 2, 3, 4, 5];

describe('dealing', () => {
  it.each(COUNTS)('%i players: valid deal', (n) => {
    for (const seed of SEEDS) {
      const game = started(n, { seed });
      // sellersPerFruit = max(2, ceil(n / 10)); k = min(20, floor(n / sellersPerFruit)).
      const perFruit = Math.max(2, Math.ceil(n / 10));
      const expectedFruits = Math.min(20, Math.floor(n / perFruit));
      expect(sellersPerFruit(n, defaultConfig)).toBe(perFruit);
      expect(activeFruitCount(n, defaultConfig)).toBe(expectedFruits);
      expect(game.activeFruits).toHaveLength(expectedFruits);
      expect(new Set(game.activeFruits).size).toBe(expectedFruits);

      // Each player has exactly one fruit, and it is an active one.
      for (const player of game.players) expect(game.activeFruits).toContain(player.fruit);

      // Every active fruit has sellersPerFruit sellers, or one more.
      const groups = sellers(game);
      const sizes = game.activeFruits.map((fruit) => (groups[fruit] || []).length);
      expect(Math.min(...sizes)).toBeGreaterThanOrEqual(2);
      expect(Math.min(...sizes)).toBeGreaterThanOrEqual(perFruit);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(perFruit + 1);
      expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(n);

      // Phase 1 teammates never share a fruit.
      const fruitOf = Object.fromEntries(game.players.map((p) => [p.id, p.fruit]));
      expect(game.teams[1]).toHaveLength(n / 2);
      for (const [a, b] of game.teams[1]) expect(fruitOf[a]).not.toBe(fruitOf[b]);
    }
  });

  it('scales the market: 2 sellers up to 20 players, 3 up to 30, 4 up to 40', () => {
    const table = [[4, 2, 2], [8, 2, 4], [20, 2, 10], [22, 3, 7], [30, 3, 10], [32, 4, 8], [38, 4, 9], [40, 4, 10]];
    for (const [n, perFruit, fruits] of table) {
      expect(sellersPerFruit(n, defaultConfig)).toBe(perFruit);
      expect(started(n).activeFruits).toHaveLength(fruits);
    }
    // 38 players on 9 fruits: seven stands of 4 and two of 5.
    const sizes = Object.values(sellers(started(38))).map((group) => group.length).sort();
    expect(sizes).toEqual([4, 4, 4, 4, 4, 4, 4, 5, 5]);
  });

  it('follows minSellersPerFruit and sellersDivisor from config', () => {
    const game = started(12, { config: { minSellersPerFruit: 3 } });
    expect(game.activeFruits).toHaveLength(4);
    expect(Object.values(sellers(game)).every((group) => group.length === 3)).toBe(true);

    const dense = started(24, { config: { sellersDivisor: 4 } });
    expect(dense.activeFruits).toHaveLength(4);
    expect(Object.values(sellers(dense)).every((group) => group.length === 6)).toBe(true);
  });

  it('never uses more fruits than the pool holds', () => {
    const config = { sellersDivisor: 1000 };
    expect(activeFruitCount(60, { ...defaultConfig, ...config })).toBe(20);
    const game = started(60, { config });
    expect(game.activeFruits).toHaveLength(20);
    expect(Object.values(sellers(game)).every((group) => group.length === 3)).toBe(true);
  });

  it('keeps every fruit the same across all four rounds', () => {
    const game = started(10);
    const before = game.players.map((p) => p.fruit);
    advanceTo(game, 4);
    expect(game.players.map((p) => p.fruit)).toEqual(before);
  });

  it('is deterministic for a given seed', () => {
    const a = started(20, { seed: 99 });
    const b = started(20, { seed: 99 });
    const c = started(20, { seed: 100 });
    expect(a.players.map((p) => p.fruit)).toEqual(b.players.map((p) => p.fruit));
    expect(a.teams).toEqual(b.teams);
    expect(a.players.map((p) => p.fruit)).not.toEqual(c.players.map((p) => p.fruit));
  });

  it('reports an error to the host when no deal is possible', () => {
    // 4 players on a 2-fruit pool with 3 sellers per fruit: one fruit of 4,
    // so teammates must share it.
    const game = lobby(4, { config: { minSellersPerFruit: 3 } });
    const result = startGame(game, T0);
    expect(result.error).toBe('deal_failed');
    expect(game.status).toBe('lobby');
  });
});

describe('Phase 2 teams', () => {
  it.each(COUNTS)('%i players: new pairs with no repeat partners', (n) => {
    for (const seed of SEEDS) {
      const game = started(n, { seed });
      expect(game.teams[2]).toBeUndefined();
      advanceTo(game, 3);

      const seen = game.teams[2].flat();
      expect(seen).toHaveLength(n);
      expect(new Set(seen)).toEqual(new Set(game.players.map((p) => p.id)));
      for (const pair of game.teams[2]) expect(pair).toHaveLength(2);

      const key = ([a, b]) => [a, b].sort().join('|');
      const phase1 = new Set(game.teams[1].map(key));
      for (const pair of game.teams[2]) expect(phase1.has(key(pair))).toBe(false);
    }
  });

  it('keeps the same Phase 2 teams for rounds 3 and 4', () => {
    const game = started(12);
    advanceTo(game, 3);
    const teams = structuredClone(game.teams[2]);
    advanceTo(game, 4);
    expect(game.teams[2]).toEqual(teams);
  });
});
