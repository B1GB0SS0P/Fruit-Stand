import { describe, it, expect } from 'vitest';
import { change, select, submit, hostSetBid, nextRound, changeTargetsFor } from '../../game/engine.js';
import { playerView, screenView, hostView } from '../../game/views.js';
import { started, submitAll, advanceTo, T0 } from './helpers.js';

const NOW = T0 + 1000;
const otherFruit = (game, player) => game.activeFruits.find((fruit) => fruit !== player.fruit);

describe('Change token', () => {
  it('switches the fruit, spends the token and is permanent', () => {
    const game = started(8);
    const [p] = game.players;
    const from = p.fruit;
    const to = otherFruit(game, p);
    expect(p.tokens).toBe(1);
    const result = change(game, p.id, 1, to, NOW);
    expect(result.ok).toBe(true);
    expect(p.fruit).toBe(to);
    expect(p.tokens).toBe(0);
    expect(result.announcement).toMatchObject({ round: 1, name: p.name, from, to });

    advanceTo(game, 4);
    expect(p.fruit).toBe(to);
  });

  it('is announced to everyone', () => {
    const game = started(8);
    const [p] = game.players;
    const { announcement } = change(game, p.id, 1, otherFruit(game, p), NOW);
    expect(announcement.text).toMatch(new RegExp(`^${p.name} changed .+ → .+$`));

    const views = [
      ...game.players.map((player) => playerView(game, player.id, NOW)),
      screenView(game, NOW),
      hostView(game, NOW),
    ];
    for (const view of views) {
      expect(view.announcements).toHaveLength(1);
      expect(view.announcements[0].text).toBe(announcement.text);
      expect(view.announcements[0].playerId).toBeUndefined();
    }
  });

  it('updates the teammate card and the rival count', () => {
    const game = started(8);
    const [p] = game.players;
    const to = otherFruit(game, p);
    change(game, p.id, 1, to, NOW);
    expect(playerView(game, p.id, NOW).rivals).toBe(2);
    const mate = game.teams[1].find((pair) => pair.includes(p.id)).find((id) => id !== p.id);
    expect(playerView(game, mate, NOW).teammate.fruit).toBe(to);
  });

  it('is refused after submitting, and the token is kept', () => {
    const game = started(8);
    const [p] = game.players;
    submit(game, p.id, 1, 3, NOW);
    const before = p.fruit;
    expect(change(game, p.id, 1, otherFruit(game, p), NOW).error).toBe('already_submitted');
    expect(p.tokens).toBe(1);
    expect(p.fruit).toBe(before);
    expect(game.announcements).toEqual([]);
  });

  it('is refused after the host locks in a bid for the player', () => {
    const game = started(8);
    const [p] = game.players;
    hostSetBid(game, p.id, 1, 3, NOW);
    expect(change(game, p.id, 1, otherFruit(game, p), NOW).error).toBe('already_submitted');
    expect(p.tokens).toBe(1);
  });

  it('is still allowed after only selecting a price', () => {
    const game = started(8);
    const [p] = game.players;
    select(game, p.id, 1, 3, NOW);
    expect(change(game, p.id, 1, otherFruit(game, p), NOW).ok).toBe(true);
  });

  it('refuses a second use', () => {
    const game = started(8);
    const [p] = game.players;
    change(game, p.id, 1, otherFruit(game, p), NOW);
    const held = p.fruit;
    expect(change(game, p.id, 1, otherFruit(game, p), NOW).error).toBe('no_token');
    submitAll(game);
    nextRound(game, T0);
    expect(change(game, p.id, 2, otherFruit(game, p), NOW).error).toBe('no_token');
    expect(p.fruit).toBe(held);
    expect(game.announcements).toHaveLength(1);
  });

  it('rejects invalid fruits and keeps the token', () => {
    const game = started(8);
    const [p] = game.players;
    for (const bad of [p.fruit, 'durian', undefined, null, 42]) {
      expect(change(game, p.id, 1, bad, NOW).error).toBe('bad_fruit');
    }
    expect(p.tokens).toBe(1);
  });

  it('rejects stale rounds, closed rounds and expired timers', () => {
    const game = started(8);
    const [p] = game.players;
    const to = otherFruit(game, p);
    expect(change(game, p.id, 2, to, NOW).error).toBe('stale_round');
    expect(change(game, p.id, 1, to, T0 + 300_000).error).toBe('time_up');
    submitAll(game);
    expect(change(game, p.id, 1, to, NOW).error).toBe('round_closed');
    expect(p.tokens).toBe(1);
  });

  it('works in Phase 2 with a carried-over token', () => {
    const game = started(8);
    const [p] = game.players;
    advanceTo(game, 3);
    expect(p.tokens).toBe(1);
    const to = otherFruit(game, p);
    expect(change(game, p.id, 3, to, NOW).ok).toBe(true);
    expect(p.fruit).toBe(to);
    expect(p.tokens).toBe(0);
  });

  it('"active" mode allows only fruits in play', () => {
    const game = started(8);
    const [p] = game.players;
    const unused = game.config.fruits.map((f) => f.id).find((id) => !game.activeFruits.includes(id));
    expect(change(game, p.id, 1, unused, NOW).error).toBe('bad_fruit');
    expect(changeTargetsFor(game, p).sort()).toEqual(game.activeFruits.filter((f) => f !== p.fruit).sort());
    expect(playerView(game, p.id, NOW).changeTargets).toHaveLength(3);
  });

  it('"any" mode allows the whole pool', () => {
    const game = started(8, { config: { changeTargets: 'any' } });
    const [p] = game.players;
    const unused = game.config.fruits.map((f) => f.id).find((id) => !game.activeFruits.includes(id));
    expect(playerView(game, p.id, NOW).changeTargets).toHaveLength(19);
    expect(change(game, p.id, 1, unused, NOW).ok).toBe(true);
    expect(p.fruit).toBe(unused);

    // The lone seller of an out-of-play fruit sells one unit at their price.
    for (const player of game.players) submit(game, player.id, 1, 4, NOW);
    expect(game.rounds[0].results[unused]).toEqual({ units: 1, lowest: 4, winners: 1 });
  });

  it('allows changing into a secret fruit in round 2', () => {
    const game = started(8);
    advanceTo(game, 2);
    const secret = game.rounds[1].secret[0];
    const p = game.players.find((player) => player.fruit !== secret);
    const view = playerView(game, p.id, NOW);
    expect(view.changeTargets).toContain(secret);
    // Plain fruit ids: nothing marks a target as secret.
    expect(view.changeTargets.every((target) => typeof target === 'string')).toBe(true);
    expect(view.changeTargets.sort()).toEqual(game.activeFruits.filter((f) => f !== p.fruit).sort());
    expect(change(game, p.id, 2, secret, NOW).ok).toBe(true);
    expect(p.fruit).toBe(secret);
  });

  it('respects changeTokens from config', () => {
    const game = started(8, { config: { changeTokens: 2 } });
    const [p] = game.players;
    expect(change(game, p.id, 1, otherFruit(game, p), NOW).ok).toBe(true);
    expect(change(game, p.id, 1, otherFruit(game, p), NOW).ok).toBe(true);
    expect(change(game, p.id, 1, otherFruit(game, p), NOW).error).toBe('no_token');
  });
});
