import { describe, it, expect, afterEach } from 'vitest';
import { startGame, submitAll, allKeys } from './helpers.js';

let t;
afterEach(async () => {
  await t?.close();
  t = null;
});

const MIN = 60_000;

describe('bidding over sockets', () => {
  it('sends each player their own stand', async () => {
    t = await startGame(8);
    for (const bot of t.bots) {
      const view = bot.socket.state;
      expect(view).toMatchObject({ role: 'player', status: 'bidding', round: 1, phase: 1, rivals: 1, bidsIn: 0 });
      expect(view.me).toMatchObject({ name: bot.name, changeTokens: 1, selection: null, submitted: false });
      expect(view.activeFruits).toHaveLength(4);
      expect(view.teammate.name).not.toBe(bot.name);
      expect(view.teammate.fruit).not.toBe(view.me.fruit);
      expect(view.timer).toEqual({ remainingMs: 300_000, running: true, serverNow: t.clock.now() });
    }
  });

  it('rejects bad prices and stale rounds, and never fails silently', async () => {
    t = await startGame(4);
    const [bot] = t.bots;
    for (const price of [0, 6, 2.5, '3', null]) {
      const reply = await t.call(bot.socket, 'player:select', { round: 1, price });
      expect(reply).toMatchObject({ ok: false, error: 'bad_price' });
      expect(reply.message).toBeTruthy();
    }
    expect((await t.call(bot.socket, 'player:submit', { round: 1 })).error).toBe('no_selection');
    expect((await t.call(bot.socket, 'player:select', { round: 2, price: 3 })).error).toBe('stale_round');
    expect((await t.call(bot.socket, 'player:submit', { price: 3 })).error).toBe('stale_round');
    expect((await t.call(bot.socket, 'player:submit', 'garbage')).error).toBe('stale_round');
    expect(t.room.state.rounds[0].selections).toEqual({});
  });

  it('keeps a selection private, and counts a submit for everyone', async () => {
    t = await startGame(4);
    const [a, b] = t.bots;
    expect(await t.call(a.socket, 'player:select', { round: 1, price: 4 })).toEqual({ ok: true, price: 4 });
    expect(await t.call(a.socket, 'player:select', { round: 1, price: 2 })).toEqual({ ok: true, price: 2 });
    await t.settle();
    expect(a.socket.state.me).toMatchObject({ selection: 2, submitted: false });
    expect(b.socket.state.me.selection).toBeNull();
    expect(b.socket.state.bidsIn).toBe(0);
    expect(t.host.state.players.every((p) => p.submitted === false)).toBe(true);

    expect(await t.call(a.socket, 'player:submit', { round: 1 })).toEqual({ ok: true, price: 2 });
    await t.settle();
    expect(a.socket.state.me).toMatchObject({ selection: 2, submitted: true });
    expect(b.socket.state.bidsIn).toBe(1);
    expect(t.host.state.players.find((p) => p.id === a.playerId).submitted).toBe(true);

    // Locked in: no more changes, and a repeat tap does nothing.
    expect((await t.call(a.socket, 'player:select', { round: 1, price: 5 })).error).toBe('already_submitted');
    expect((await t.call(a.socket, 'player:submit', { round: 1, price: 5 })).error).toBe('already_submitted');
    expect((await t.call(a.socket, 'player:submit', { round: 1, price: 2 })).ok).toBe(true);
    expect(t.room.state.rounds[0].selections[a.playerId]).toBe(2);
  });

  it('resolves exactly once, on the last submit', async () => {
    t = await startGame(6);
    const last = t.bots[5];
    for (const bot of t.bots.slice(0, 5)) await t.call(bot.socket, 'player:submit', { round: 1, price: 4 });
    await t.settle();
    expect(t.host.state.status).toBe('bidding');
    expect(t.host.state.bidsIn).toBe(5);

    // The last player double-taps Submit.
    const replies = await Promise.all([
      t.call(last.socket, 'player:submit', { round: 1, price: 3 }),
      t.call(last.socket, 'player:submit', { round: 1, price: 3 }),
    ]);
    await t.settle();
    expect(replies[0].ok).toBe(true);
    expect(replies[1].error).toBe('round_closed');
    expect(t.room.state.rounds).toHaveLength(1);
    expect(t.room.state.rounds[0].resolved).toBe(true);

    for (const client of [...t.bots.map((b) => b.socket), t.host]) {
      const statuses = client.log.filter((e) => e.event === 'state').map((e) => e.payload.status);
      expect(statuses.at(-1)).toBe('results');
      expect(statuses.filter((s, i) => s === 'results' && statuses[i - 1] !== 'results')).toHaveLength(1);
    }
    expect(last.socket.state.results).toHaveLength(1);
    expect((await t.call(t.host, 'host:next')).ok).toBe(true);
    expect((await t.call(last.socket, 'player:submit', { round: 1, price: 3 })).error).toBe('stale_round');
  });

  it('Next round only works after the round resolves', async () => {
    t = await startGame(4);
    expect((await t.call(t.host, 'host:next')).error).toBe('round_not_resolved');
    await submitAll(t);
    expect((await t.call(t.host, 'host:next')).ok).toBe(true);
    await t.settle();
    expect(t.bots[0].socket.state).toMatchObject({ round: 2, status: 'bidding' });
    expect(t.bots[0].socket.state.me).toMatchObject({ selection: null, submitted: false });
  });

  it('lets the host set a bid blind, and remind players who have not bid', async () => {
    t = await startGame(4);
    const [a, b, c] = t.bots;
    await t.call(a.socket, 'player:submit', { round: 1, price: 2 });
    expect((await t.call(t.host, 'host:setBid', { playerId: b.playerId, round: 1, price: 9 })).error).toBe('bad_price');
    expect((await t.call(t.host, 'host:setBid', { playerId: b.playerId, round: 1, price: 4 })).ok).toBe(true);
    await t.settle();
    expect(b.socket.state.me).toMatchObject({ selection: 4, submitted: true });

    expect(await t.call(t.host, 'host:remind')).toEqual({ ok: true, count: 2 });
    await t.settle();
    const nudged = t.bots.filter((bot) => bot.socket.log.some((e) => e.event === 'nudge'));
    expect(nudged.map((bot) => bot.name)).toEqual([c.name, t.bots[3].name]);
  });
});

describe('Change over sockets', () => {
  it('announces a Change to every phone, the screen and the host', async () => {
    t = await startGame(8);
    const screen = await t.connect();
    await t.call(screen, 'screen:watch', { code: t.code });
    const [bot] = t.bots;
    const target = bot.socket.state.changeTargets[0];
    expect(await t.call(bot.socket, 'player:change', { round: 1, fruit: target })).toEqual({ ok: true, fruit: target });
    await t.settle();

    for (const client of [...t.bots.map((b) => b.socket), screen, t.host]) {
      const events = client.log.filter((e) => e.event === 'announcement');
      expect(events).toHaveLength(1);
      expect(events[0].payload.text).toMatch(/^Bot 1 changed .+ → .+$/);
      expect(events[0].payload.playerId).toBeUndefined();
      expect(client.state.announcements).toHaveLength(1);
    }
    expect(bot.socket.state.me).toMatchObject({ fruit: target, changeTokens: 0 });
  });

  it('refuses a Change after submitting and explains why', async () => {
    t = await startGame(8);
    const [bot] = t.bots;
    const target = bot.socket.state.changeTargets[0];
    await t.call(bot.socket, 'player:submit', { round: 1, price: 3 });
    const reply = await t.call(bot.socket, 'player:change', { round: 1, fruit: target });
    expect(reply.error).toBe('already_submitted');
    expect(reply.message).toMatch(/locked in/);
    await t.settle();
    expect(bot.socket.state.me.changeTokens).toBe(1);
    expect((await t.call(t.bots[1].socket, 'player:change', { round: 1, fruit: 'durian' })).error).toBe('bad_fruit');
  });
});

describe('timer', () => {
  it('on expiry gives $5 to players with no selection, keeps selections, and resolves', async () => {
    t = await startGame(6);
    const [a, b] = t.bots;
    await t.call(a.socket, 'player:submit', { round: 1, price: 2 });
    await t.call(b.socket, 'player:select', { round: 1, price: 3 });

    t.clock.advance(5 * MIN - 1);
    await t.settle();
    expect(t.host.state.status).toBe('bidding');

    t.clock.advance(1);
    await t.settle();
    const round = t.room.state.rounds[0];
    expect(round.resolved).toBe(true);
    expect(round.selections[a.playerId]).toBe(2);
    expect(round.selections[b.playerId]).toBe(3);
    expect(round.bidType[a.playerId]).toBe('submitted');
    expect(round.bidType[b.playerId]).toBe('auto_selected');
    for (const bot of t.bots.slice(2)) {
      expect(round.selections[bot.playerId]).toBe(5);
      expect(round.bidType[bot.playerId]).toBe('auto_max');
    }
    for (const bot of t.bots) expect(bot.socket.state.status).toBe('results');
    expect(t.host.state.status).toBe('results');
    expect(t.clock.pending).toBe(0);
  });

  it('rejects a bid that arrives after expiry', async () => {
    t = await startGame(4);
    t.clock.advance(5 * MIN);
    const [bot] = t.bots;
    expect((await t.call(bot.socket, 'player:submit', { round: 1, price: 1 })).error).toBe('round_closed');
    expect((await t.call(bot.socket, 'player:select', { round: 1, price: 1 })).error).toBe('round_closed');
    expect((await t.call(t.host, 'host:setBid', { playerId: bot.playerId, round: 1, price: 1 })).error).toBe('round_closed');
    expect(t.room.state.rounds[0].selections[bot.playerId]).toBe(5);
  });

  it('is cancelled when everyone submits early', async () => {
    t = await startGame(4);
    expect(t.clock.pending).toBe(1);
    t.clock.advance(20_000);
    await submitAll(t);
    expect(t.host.state.status).toBe('results');
    expect(t.clock.pending).toBe(0);
    t.clock.advance(10 * MIN);
    await t.settle();
    expect(t.room.state.round).toBe(1);
    expect(Object.values(t.room.state.rounds[0].bidType).every((type) => type === 'submitted')).toBe(true);
  });

  it('restarts for each new round', async () => {
    t = await startGame(4);
    t.clock.advance(4 * MIN);
    await submitAll(t);
    t.clock.advance(7 * MIN);
    await t.call(t.host, 'host:next');
    await t.settle();
    expect(t.bots[0].socket.state.timer).toEqual({ remainingMs: 300_000, running: true, serverNow: t.clock.now() });
    t.clock.advance(5 * MIN);
    await t.settle();
    expect(t.host.state).toMatchObject({ round: 2, status: 'results' });
  });

  it('+1 minute extends the round for everyone', async () => {
    t = await startGame(4);
    t.clock.advance(MIN);
    expect((await t.call(t.host, 'host:addMinute')).ok).toBe(true);
    await t.settle();
    for (const client of [t.host, ...t.bots.map((b) => b.socket)]) {
      expect(client.state.timer).toEqual({ remainingMs: 300_000, running: true, serverNow: t.clock.now() });
    }
    t.clock.advance(5 * MIN - 1);
    await t.settle();
    expect(t.host.state.status).toBe('bidding');
    t.clock.advance(1);
    await t.settle();
    expect(t.host.state.status).toBe('results');
  });

  it('pause freezes the round and resume carries on', async () => {
    t = await startGame(4);
    t.clock.advance(100_000);
    expect((await t.call(t.host, 'host:pause')).ok).toBe(true);
    await t.settle();
    expect(t.clock.pending).toBe(0);
    expect(t.bots[0].socket.state.timer).toMatchObject({ remainingMs: 200_000, running: false });

    t.clock.advance(20 * MIN);
    await t.settle();
    expect(t.host.state.status).toBe('bidding');
    // Players can still pick and lock in while paused.
    expect((await t.call(t.bots[0].socket, 'player:submit', { round: 1, price: 3 })).ok).toBe(true);

    expect((await t.call(t.host, 'host:resume')).ok).toBe(true);
    await t.settle();
    expect(t.bots[0].socket.state.timer).toEqual({ remainingMs: 200_000, running: true, serverNow: t.clock.now() });
    t.clock.advance(199_999);
    await t.settle();
    expect(t.host.state.status).toBe('bidding');
    t.clock.advance(1);
    await t.settle();
    expect(t.host.state.status).toBe('results');
  });

  it('timer controls are refused between rounds', async () => {
    t = await startGame(4);
    await submitAll(t);
    for (const event of ['host:pause', 'host:resume', 'host:addMinute', 'host:remind']) {
      expect((await t.call(t.host, event)).error).toBe('round_closed');
    }
  });
});

describe('privacy over sockets', () => {
  it('never sends the host a price, and never sends players the host tools', async () => {
    t = await startGame(8);
    await t.call(t.bots[0].socket, 'player:select', { round: 1, price: 2 });
    await submitAll(t, () => 4);
    await t.call(t.host, 'host:next');
    await t.settle();

    for (const { event, payload } of t.host.log) {
      if (event !== 'state') continue;
      const keys = allKeys(payload);
      for (const key of ['price', 'selection', 'selections', 'results', 'earnings', 'total', 'lowest']) {
        expect(keys.has(key), `host state has "${key}"`).toBe(false);
      }
    }
    for (const bot of t.bots) {
      for (const { event, payload } of bot.socket.log) {
        expect(event).not.toBe('autosave');
        if (event !== 'state') continue;
        const keys = allKeys(payload);
        for (const key of ['rejoinCode', 'token', 'selections', 'earnings', 'players', 'lowest']) {
          expect(keys.has(key), `player state has "${key}"`).toBe(false);
        }
        expect(payload.me.id).toBe(bot.playerId);
      }
    }
    expect((await t.call(t.host, 'host:csv')).error).toBe('not_finished');
  });

  it('gives the host only a sealed autosave', async () => {
    t = await startGame(4);
    await t.call(t.bots[0].socket, 'player:select', { round: 1, price: 2 });
    await t.settle();
    const saves = t.host.log.filter((e) => e.event === 'autosave');
    expect(saves.length).toBeGreaterThan(2);
    const latest = saves.at(-1).payload;
    expect(latest.code).toBe(t.code);
    const file = JSON.parse(latest.file);
    expect(Object.keys(file).sort()).toEqual(['data', 'format', 'iv', 'tag', 'version']);
    expect(latest.file).not.toContain('Bot 1');
    expect(latest.file).not.toContain('selections');
  });
});
