import { describe, it, expect } from 'vitest';
import {
  select, submit, change, expire, deadline, nextRound, revealSecrets, showStandings, currentRound,
} from '../../game/engine.js';
import { playerView } from '../../game/views.js';
import { computeStandings } from '../../game/scoring.js';
import { resultsCsv } from '../../game/csv.js';
import { resolveConfig, defaultConfig } from '../../config.js';
import { started, testRandom, T0 } from './helpers.js';

function play(n, seed) {
  const game = started(n, { seed });
  const random = testRandom(seed + n);
  let clock = T0;
  for (let r = 1; r <= 4; r++) {
    expect(game.round).toBe(r);
    expect(currentRound(game).phase).toBe(r <= 2 ? 1 : 2);
    for (const p of game.players) {
      const roll = random();
      const price = 1 + Math.floor(random() * 5);
      if (roll < 0.1 && p.tokens > 0) {
        const targets = playerView(game, p.id, clock).changeTargets;
        change(game, p.id, r, targets[Math.floor(random() * targets.length)], clock);
      }
      if (roll < 0.8) submit(game, p.id, r, price, clock + 1000);
      else if (roll < 0.9) select(game, p.id, r, price, clock + 1000);
    }
    if (game.status === 'bidding') expect(expire(game, r, deadline(game)).ok).toBe(true);
    expect(game.status).toBe('results');
    clock += 400_000;
    if (r < 4) expect(nextRound(game, clock).ok).toBe(true);
  }
  expect(revealSecrets(game).ok).toBe(true);
  expect(showStandings(game).ok).toBe(true);
  return game;
}

describe('full games on the engine', () => {
  it.each([4, 8, 22, 40, 60])('%i players from start to final standings', (n) => {
    const game = play(n, 17);
    expect(game.rounds).toHaveLength(4);
    expect(game.rounds.every((round) => round.resolved)).toBe(true);
    for (const round of game.rounds) {
      expect(Object.keys(round.selections)).toHaveLength(n);
      expect(Object.keys(round.earnings)).toHaveLength(n);
    }
    const standings = computeStandings(game);
    expect(standings).toHaveLength(n);
    expect(standings[0].rank).toBe(1);
    expect(resultsCsv(game).split('\r\n').length).toBeGreaterThan(n * 5);
    expect(game.players.every((p) => p.tokens === 0 || p.tokens === 1)).toBe(true);
  });

  it('plays out identically for the same seed', () => {
    expect(JSON.stringify(play(20, 5))).toBe(JSON.stringify(play(20, 5)));
    expect(JSON.stringify(play(20, 5))).not.toBe(JSON.stringify(play(20, 6)));
  });
});

describe('config', () => {
  it('has the defaults from the spec', () => {
    expect(defaultConfig).toMatchObject({
      minSellersPerFruit: 2,
      sellersDivisor: 10,
      maxPredictors: 3,
      predictionLockRound: 3,
      changeTargets: 'active',
      minPrice: 1,
      maxPrice: 5,
      totalRounds: 4,
      phase1LastRound: 2,
      secretRound: 2,
      secretShare: 0.25,
      changeTokens: 1,
      bidSeconds: 300,
      ambientSecretWeight: 3,
      ambientCountProjector: 10,
      ambientCountPhone: 5,
    });
    expect(Object.keys(defaultConfig.skyTheme).sort()).toEqual(['final', 'lobby', 'round1', 'round2', 'round3', 'round4']);
    expect(defaultConfig).not.toHaveProperty('sellersPerFruit');
    // An older snapshot may still carry the removed setting; it is dropped.
    expect(resolveConfig({ sellersPerFruit: 2 })).not.toHaveProperty('sellersPerFruit');
    expect(defaultConfig.avatarRingColors.length).toBeGreaterThanOrEqual(12);
    expect(defaultConfig.fruits).toHaveLength(20);
    expect(defaultConfig.avatars).toHaveLength(24);
    const fruitEmoji = defaultConfig.fruits.map((f) => f.emoji);
    expect(defaultConfig.avatars.some((a) => fruitEmoji.includes(a))).toBe(false);
  });

  it('rejects settings that cannot work', () => {
    expect(() => resolveConfig({ minSellersPerFruit: 1 })).toThrow(/minSellersPerFruit/);
    expect(() => resolveConfig({ sellersDivisor: 0 })).toThrow(/sellersDivisor/);
    expect(() => resolveConfig({ maxPredictors: -1 })).toThrow(/maxPredictors/);
    expect(() => resolveConfig({ predictionLockRound: 1 })).toThrow(/predictionLockRound/);
    expect(() => resolveConfig({ changeTargets: 'all' })).toThrow(/changeTargets/);
    expect(() => resolveConfig({ minPrice: 6 })).toThrow(/minPrice/);
    expect(() => resolveConfig({ secretShare: 2 })).toThrow(/secretShare/);
    expect(() => resolveConfig({ ambientSecretWeight: 0 })).toThrow(/ambientSecretWeight/);
    expect(() => resolveConfig({ avatarRingColors: ['red'] })).toThrow(/avatarRingColors/);
    expect(() => resolveConfig({ skyTheme: { final: ['#000000'] } })).toThrow(/skyTheme\.final/);
  });

  it('lets one sky state be changed without restating the rest', () => {
    const config = resolveConfig({ skyTheme: { round4: ['#ff0000', '#00ff00'] } });
    expect(config.skyTheme.round4).toEqual(['#ff0000', '#00ff00']);
    expect(config.skyTheme.lobby).toEqual(defaultConfig.skyTheme.lobby);
  });

  it('respects a different price range', () => {
    const game = started(4, { config: { minPrice: 2, maxPrice: 9 } });
    const [p] = game.players;
    expect(submit(game, p.id, 1, 1, T0).error).toBe('bad_price');
    expect(submit(game, p.id, 1, 9, T0).ok).toBe(true);
    expect(expire(game, 1, deadline(game)).ok).toBe(true);
    expect(game.rounds[0].selections[game.players[1].id]).toBe(9);
  });
});
