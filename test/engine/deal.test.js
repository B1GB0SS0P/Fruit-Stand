import { describe, it, expect } from 'vitest';
import { lobby, started, advanceTo, sellers, T0 } from './helpers.js';
import { startGame } from '../../game/engine.js';

const COUNTS = [];
for (let n = 4; n <= 60; n += 2) COUNTS.push(n);
const SEEDS = [1, 2, 3, 4, 5];

describe('dealing', () => {
  it.each(COUNTS)('%i players: valid deal', (n) => {
    for (const seed of SEEDS) {
      const game = started(n, { seed });
      const expectedFruits = Math.min(20, Math.floor(n / 2));
      expect(game.activeFruits).toHaveLength(expectedFruits);
      expect(new Set(game.activeFruits).size).toBe(expectedFruits);

      // Each player has exactly one fruit, and it is an active one.
      for (const player of game.players) expect(game.activeFruits).toContain(player.fruit);

      // Every active fruit has at least 2 sellers, spread as evenly as possible.
      const groups = sellers(game);
      const sizes = game.activeFruits.map((fruit) => (groups[fruit] || []).length);
      expect(Math.min(...sizes)).toBeGreaterThanOrEqual(2);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);

      // Phase 1 teammates never share a fruit.
      const fruitOf = Object.fromEntries(game.players.map((p) => [p.id, p.fruit]));
      expect(game.teams[1]).toHaveLength(n / 2);
      for (const [a, b] of game.teams[1]) expect(fruitOf[a]).not.toBe(fruitOf[b]);
    }
  });

  it('gives 4 fruits to 8 players and 20 fruits to 40 players', () => {
    expect(started(8).activeFruits).toHaveLength(4);
    expect(started(40).activeFruits).toHaveLength(20);
  });

  it('follows sellersPerFruit from config', () => {
    const game = started(12, { config: { sellersPerFruit: 3 } });
    expect(game.activeFruits).toHaveLength(4);
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
    const game = lobby(4, { config: { sellersPerFruit: 3 } });
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
