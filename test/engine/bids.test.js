import { describe, it, expect } from 'vitest';
import {
  select, submit, hostSetBid, expire, nextRound, currentRound,
  timeLeft, deadline, pauseTimer, resumeTimer, addTime,
} from '../../game/engine.js';
import { started, submitAll, T0, MIN } from './helpers.js';

const NOW = T0 + 1000;

describe('selecting and submitting', () => {
  it('rejects out-of-range and non-integer prices', () => {
    const game = started(4);
    const [p] = game.players;
    for (const bad of [0, 6, -1, 2.5, '3', null, NaN, Infinity]) {
      expect(select(game, p.id, 1, bad, NOW).error).toBe('bad_price');
    }
    for (const bad of [0, 6, 2.5, '3']) expect(submit(game, p.id, 1, bad, NOW).error).toBe('bad_price');
    expect(currentRound(game).selections[p.id]).toBeUndefined();
    for (const good of [1, 2, 3, 4, 5]) expect(select(game, p.id, 1, good, NOW).ok).toBe(true);
  });

  it('lets a player change their selection until they submit', () => {
    const game = started(4);
    const [p] = game.players;
    select(game, p.id, 1, 4, NOW);
    select(game, p.id, 1, 2, NOW);
    expect(currentRound(game).selections[p.id]).toBe(2);
    expect(currentRound(game).submitted[p.id]).toBeUndefined();
  });

  it('locks the price on submit', () => {
    const game = started(4);
    const [p] = game.players;
    select(game, p.id, 1, 3, NOW);
    expect(submit(game, p.id, 1, undefined, NOW)).toMatchObject({ ok: true, price: 3 });
    expect(select(game, p.id, 1, 1, NOW).error).toBe('already_submitted');
    expect(submit(game, p.id, 1, 1, NOW).error).toBe('already_submitted');
    expect(currentRound(game).selections[p.id]).toBe(3);
  });

  it('treats a repeated identical submit as a harmless duplicate', () => {
    const game = started(4);
    const [p] = game.players;
    submit(game, p.id, 1, 3, NOW);
    expect(submit(game, p.id, 1, 3, NOW)).toMatchObject({ ok: true, duplicate: true });
    expect(submit(game, p.id, 1, undefined, NOW)).toMatchObject({ ok: true, duplicate: true });
  });

  it('refuses to submit with nothing selected', () => {
    const game = started(4);
    expect(submit(game, game.players[0].id, 1, undefined, NOW).error).toBe('no_selection');
  });

  it('rejects a stale or future round number', () => {
    const game = started(4);
    submitAll(game);
    nextRound(game, T0);
    const [p] = game.players;
    expect(select(game, p.id, 1, 3, NOW).error).toBe('stale_round');
    expect(submit(game, p.id, 1, 3, NOW).error).toBe('stale_round');
    expect(submit(game, p.id, 3, 3, NOW).error).toBe('stale_round');
    expect(submit(game, p.id, undefined, 3, NOW).error).toBe('stale_round');
    expect(currentRound(game).selections[p.id]).toBeUndefined();
  });

  it('rejects unknown players', () => {
    const game = started(4);
    expect(submit(game, 'nobody', 1, 3, NOW).error).toBe('unknown_player');
  });

  it('resolves exactly once, on the last submit', () => {
    const game = started(6);
    const last = game.players[5];
    for (const p of game.players.slice(0, 5)) {
      expect(submit(game, p.id, 1, 4, NOW).resolved).toBe(false);
      expect(game.status).toBe('bidding');
    }
    select(game, last.id, 1, 2, NOW); // selecting alone does not resolve
    expect(game.status).toBe('bidding');
    expect(submit(game, last.id, 1, undefined, NOW).resolved).toBe(true);
    expect(game.status).toBe('results');

    const snapshot = JSON.stringify(game);
    expect(submit(game, last.id, 1, 2, NOW).error).toBe('round_closed');
    expect(select(game, last.id, 1, 1, NOW).error).toBe('round_closed');
    expect(expire(game, 1, T0 + 10 * MIN).error).toBe('round_closed');
    expect(JSON.stringify(game)).toBe(snapshot);
  });

  it('only moves to the next round after the current one resolves', () => {
    const game = started(4);
    expect(nextRound(game, NOW).error).toBe('round_not_resolved');
    submitAll(game);
    expect(nextRound(game, NOW).ok).toBe(true);
    expect(game.round).toBe(2);
  });

  it('stops after the last round', () => {
    const game = started(4);
    for (let r = 1; r <= 4; r++) {
      submitAll(game);
      if (r < 4) nextRound(game, T0);
    }
    expect(nextRound(game, T0).error).toBe('no_more_rounds');
  });

  it('lets the host lock in a bid for a player', () => {
    const game = started(4);
    const [a, b, c, d] = game.players;
    expect(hostSetBid(game, a.id, 1, 9, NOW).error).toBe('bad_price');
    expect(hostSetBid(game, a.id, 1, 2, NOW).ok).toBe(true);
    expect(currentRound(game).bidType[a.id]).toBe('host');
    expect(hostSetBid(game, a.id, 1, 3, NOW).error).toBe('already_submitted');
    expect(select(game, a.id, 1, 3, NOW).error).toBe('already_submitted');
    submit(game, b.id, 1, 5, NOW);
    submit(game, c.id, 1, 5, NOW);
    expect(hostSetBid(game, d.id, 1, 5, NOW).resolved).toBe(true);
    expect(game.status).toBe('results');
  });
});

describe('timer', () => {
  it('starts at bidSeconds when a round opens', () => {
    const game = started(4);
    expect(timeLeft(game, T0)).toBe(300_000);
    expect(deadline(game)).toBe(T0 + 300_000);
    submitAll(game);
    nextRound(game, T0 + 7 * MIN);
    expect(timeLeft(game, T0 + 7 * MIN)).toBe(300_000);
  });

  it('cannot expire early', () => {
    const game = started(4);
    expect(expire(game, 1, T0 + 299_999).error).toBe('not_expired');
    expect(game.status).toBe('bidding');
  });

  it('on expiry uses selections, gives $5 to players with none, and resolves', () => {
    const game = started(6);
    const [a, b, c, d, e, f] = game.players;
    submit(game, a.id, 1, 2, NOW);
    select(game, b.id, 1, 3, NOW);
    select(game, c.id, 1, 1, NOW);
    hostSetBid(game, d.id, 1, 4, NOW);

    expect(expire(game, 1, T0 + 5 * MIN)).toMatchObject({ ok: true, resolved: true });
    const round = game.rounds[0];
    expect(game.status).toBe('results');
    expect(round.resolved).toBe(true);
    expect(round.selections).toEqual({ [a.id]: 2, [b.id]: 3, [c.id]: 1, [d.id]: 4, [e.id]: 5, [f.id]: 5 });
    expect(round.bidType).toEqual({
      [a.id]: 'submitted',
      [b.id]: 'auto_selected',
      [c.id]: 'auto_selected',
      [d.id]: 'host',
      [e.id]: 'auto_max',
      [f.id]: 'auto_max',
    });
    expect(expire(game, 1, T0 + 6 * MIN).error).toBe('round_closed');
  });

  it('rejects a bid that arrives after expiry', () => {
    const game = started(4);
    const [p] = game.players;
    const late = T0 + 5 * MIN;
    // The clock has run out but the expiry has not been processed yet.
    expect(select(game, p.id, 1, 2, late).error).toBe('time_up');
    expect(submit(game, p.id, 1, 2, late).error).toBe('time_up');
    expect(hostSetBid(game, p.id, 1, 2, late).error).toBe('time_up');
    expire(game, 1, late);
    expect(submit(game, p.id, 1, 2, late + 5).error).toBe('round_closed');
    expect(game.rounds[0].selections[p.id]).toBe(5);
  });

  it('is cancelled when everyone submits early', () => {
    const game = started(4);
    submitAll(game, () => 5, T0 + 20_000);
    expect(game.status).toBe('results');
    expect(deadline(game)).toBeNull();
    expect(game.timer).toEqual({ remainingMs: 280_000, runningSince: null });
    expect(expire(game, 1, T0 + 5 * MIN).error).toBe('round_closed');
    expect(Object.values(game.rounds[0].bidType).every((type) => type === 'submitted')).toBe(true);
  });

  it('+1 minute extends the deadline', () => {
    const game = started(4);
    expect(addTime(game, MIN, T0 + 10_000).ok).toBe(true);
    expect(timeLeft(game, T0 + 10_000)).toBe(350_000);
    expect(deadline(game)).toBe(T0 + 6 * MIN);
    expect(expire(game, 1, T0 + 5 * MIN).error).toBe('not_expired');
    expect(expire(game, 1, T0 + 6 * MIN).ok).toBe(true);
  });

  it('pause freezes the clock and resume continues it', () => {
    const game = started(4);
    const [p] = game.players;
    expect(pauseTimer(game, T0 + 100_000).ok).toBe(true);
    expect(deadline(game)).toBeNull();
    expect(timeLeft(game, T0 + 100_000)).toBe(200_000);
    expect(timeLeft(game, T0 + 900_000)).toBe(200_000);
    expect(expire(game, 1, T0 + 900_000).error).toBe('not_expired');

    // Bids still work while paused.
    expect(select(game, p.id, 1, 3, T0 + 900_000).ok).toBe(true);

    // +1 minute works while paused.
    addTime(game, MIN, T0 + 900_000);
    expect(timeLeft(game, T0 + 900_000)).toBe(260_000);

    expect(resumeTimer(game, T0 + 900_000).ok).toBe(true);
    expect(deadline(game)).toBe(T0 + 900_000 + 260_000);
    expect(timeLeft(game, T0 + 1_000_000)).toBe(160_000);
    expect(expire(game, 1, T0 + 900_000 + 260_000).ok).toBe(true);
  });

  it('pause and resume are safe to repeat', () => {
    const game = started(4);
    pauseTimer(game, T0 + 50_000);
    pauseTimer(game, T0 + 80_000);
    expect(timeLeft(game, T0 + 80_000)).toBe(250_000);
    resumeTimer(game, T0 + 100_000);
    resumeTimer(game, T0 + 150_000);
    expect(deadline(game)).toBe(T0 + 350_000);
  });

  it('timer controls are refused outside bidding', () => {
    const game = started(4);
    submitAll(game);
    expect(pauseTimer(game, NOW).error).toBe('round_closed');
    expect(resumeTimer(game, NOW).error).toBe('round_closed');
    expect(addTime(game, MIN, NOW).error).toBe('round_closed');
  });
});
