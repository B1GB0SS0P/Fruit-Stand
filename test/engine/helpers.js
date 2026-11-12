import { expect } from 'vitest';
import { createGame, addPlayer, startGame, submit, nextRound, currentRound } from '../../game/engine.js';

export const T0 = 1_000_000;
export const MIN = 60_000;

export function lobby(n, { seed = 1, config = {} } = {}) {
  const game = createGame({ code: 'TEST', seed, config });
  for (let i = 0; i < n; i++) {
    const result = addPlayer(game, {
      name: `Player ${i + 1}`,
      avatar: game.config.avatars[i % game.config.avatars.length],
      token: `token-${i + 1}`,
      rejoinCode: `R${i + 1}`,
    });
    expect(result.ok).toBe(true);
  }
  return game;
}

export function started(n, options) {
  const game = lobby(n, options);
  expect(startGame(game, T0)).toEqual({ ok: true });
  return game;
}

// Everyone who has not locked in submits `priceOf(player)`.
export function submitAll(game, priceOf = () => 5, now = T0 + 1000) {
  const round = game.round;
  for (const player of [...game.players]) {
    if (currentRound(game).submitted[player.id]) continue;
    const result = submit(game, player.id, round, priceOf(player), now);
    expect(result.ok).toBe(true);
  }
  expect(game.status).toBe('results');
}

// Plays rounds until `round` is open for bidding.
export function advanceTo(game, round, priceOf = () => 5) {
  while (game.round < round) {
    submitAll(game, priceOf);
    expect(nextRound(game, T0).ok).toBe(true);
  }
}

export function sellers(game) {
  const map = {};
  for (const player of game.players) (map[player.fruit] ||= []).push(player);
  return map;
}

export function allKeys(value, found = new Set()) {
  if (Array.isArray(value)) value.forEach((item) => allKeys(item, found));
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      found.add(key);
      allKeys(inner, found);
    }
  }
  return found;
}

// Small deterministic generator for test choices.
export function testRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
