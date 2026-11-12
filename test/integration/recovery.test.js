import { describe, it, expect, afterEach } from 'vitest';
import { startServer, startGame, submitAll, FakeClock, PASSWORD } from './helpers.js';

const open = [];
const track = (t) => {
  open.push(t);
  return t;
};
afterEach(async () => {
  while (open.length) await open.pop().close();
});

describe('reconnecting', () => {
  it('a returning token gets its seat back with a full resync', async () => {
    const t = track(await startGame(6));
    const [bot] = t.bots;
    await t.call(bot.socket, 'player:select', { round: 1, price: 2 });
    const target = bot.socket.state.changeTargets[0];
    await t.call(bot.socket, 'player:change', { round: 1, fruit: target });
    await t.settle();
    const before = bot.socket.state;

    bot.socket.disconnect();
    await t.settle();
    expect(t.host.state.players.find((p) => p.id === bot.playerId).connected).toBe(false);

    const phone = await t.connect();
    expect(await t.call(phone, 'player:resume', { code: t.code, token: bot.token })).toEqual({
      ok: true, code: t.code, playerId: bot.playerId,
    });
    await t.settle();
    expect(phone.log.map((e) => e.event).slice(0, 2)).toEqual(['config', 'state']);
    expect(phone.state).toEqual(before);
    expect(phone.state.me).toMatchObject({ fruit: target, selection: 2, changeTokens: 0 });
    expect(t.host.state.players.find((p) => p.id === bot.playerId).connected).toBe(true);

    // And it can carry on playing.
    expect((await t.call(phone, 'player:submit', { round: 1 })).ok).toBe(true);
  });

  it('an unknown token is told to join again', async () => {
    const t = track(await startGame(4));
    const phone = await t.connect();
    expect((await t.call(phone, 'player:resume', { code: t.code, token: 'made-up' })).error).toBe('unknown_token');
    expect((await t.call(phone, 'player:resume', { code: t.code })).error).toBe('unknown_token');
    expect((await t.call(phone, 'player:submit', { round: 1, price: 1 })).error).toBe('not_seated');
  });

  it('a rejoin code from the host moves the seat to a new browser', async () => {
    const t = track(await startGame(4));
    const [bot] = t.bots;
    await t.call(bot.socket, 'player:select', { round: 1, price: 4 });
    const rejoinCode = t.host.state.players.find((p) => p.id === bot.playerId).rejoinCode;
    expect(rejoinCode).toMatch(/^[A-Z2-9]{4}$/);

    const phone = await t.connect();
    expect((await t.call(phone, 'player:rejoin', { code: t.code, rejoinCode: 'XXXX1' })).error).toBe('bad_rejoin_code');
    const reply = await t.call(phone, 'player:rejoin', { code: t.code, rejoinCode: rejoinCode.toLowerCase() });
    expect(reply.ok).toBe(true);
    expect(reply.token).not.toBe(bot.token);
    await t.settle();
    expect(phone.state.me).toMatchObject({ name: bot.name, selection: 4 });

    const stale = await t.connect();
    expect((await t.call(stale, 'player:resume', { code: t.code, token: bot.token })).error).toBe('unknown_token');
    expect((await t.call(stale, 'player:resume', { code: t.code, token: reply.token })).ok).toBe(true);
  });
});

describe('snapshots', () => {
  it('restores a game mid-round 2 on a fresh server, with the same time left', async () => {
    // ----- the first server -----
    const a = await startGame(8);
    await submitAll(a, (bot) => (bot.name === 'Bot 1' ? 2 : 5));
    await a.call(a.host, 'host:next');
    await a.settle();
    const [b1, b2, b3] = a.bots;
    await a.call(b1.socket, 'player:select', { round: 2, price: 3 });
    await a.call(b2.socket, 'player:submit', { round: 2, price: 4 });
    const target = b3.socket.state.changeTargets[0];
    await a.call(b3.socket, 'player:change', { round: 2, fruit: target });
    a.clock.advance(100_000);

    const exported = await a.call(a.host, 'host:export');
    expect(exported.ok).toBe(true);
    expect(exported.filename).toBe(`fruit-stand-${a.code}-snapshot.json`);
    await a.settle();
    const secretFruits = b1.socket.state.secretFruits;
    expect(secretFruits.length).toBe(1);
    const before = Object.fromEntries(a.bots.map((bot) => [bot.name, bot.socket.state]));
    const stateBefore = structuredClone(a.room.state);
    await a.close(); // the server "restarts"

    // ----- a brand new server, with a different clock -----
    const b = track(await startServer({ clock: new FakeClock(5_000_000) }));

    // A phone reconnects before the host has restored the game.
    const early = await b.connect();
    expect((await b.call(early, 'player:resume', { code: a.code, token: b1.token })).error).toBe('no_room');

    const host = await b.host();
    expect((await b.call(host, 'host:import', { file: 'not json' })).error).toBe('bad_snapshot');
    const imported = await b.call(host, 'host:import', { file: exported.file });
    expect(imported).toEqual({ ok: true, code: a.code });
    await b.settle();

    // The waiting phone is told the room is back.
    expect(early.log.some((e) => e.event === 'room:restored' && e.payload.code === a.code)).toBe(true);

    // Every player gets their seat back with their old token.
    const phones = {};
    for (const bot of a.bots) {
      const phone = bot === b1 ? early : await b.connect();
      expect((await b.call(phone, 'player:resume', { code: a.code, token: bot.token })).ok).toBe(true);
      phones[bot.name] = phone;
    }
    await b.settle();

    // Same game, same remaining time, timer paused until the host resumes.
    expect(host.state).toMatchObject({ status: 'bidding', round: 2, bidsIn: 1, playerCount: 8 });
    for (const bot of a.bots) {
      const view = phones[bot.name].state;
      expect(view.timer).toEqual({ remainingMs: 200_000, running: false, serverNow: b.clock.now() });
      expect({ ...view, timer: null }).toEqual({ ...before[bot.name], timer: null });
    }
    expect(phones['Bot 1'].state.me).toMatchObject({ selection: 3, submitted: false });
    expect(phones['Bot 2'].state.me).toMatchObject({ selection: 4, submitted: true });
    expect(phones['Bot 3'].state.me).toMatchObject({ fruit: target, changeTokens: 0 });
    expect(phones['Bot 1'].state.secretFruits).toEqual(secretFruits);

    const room = b.server.store.get(a.code);
    expect({ ...room.state, timer: null }).toEqual({ ...stateBefore, timer: null });

    // Nothing happens while paused; after resume the round runs out on time.
    b.clock.advance(10 * 60_000);
    await b.settle();
    expect(host.state.status).toBe('bidding');
    await b.call(host, 'host:resume');
    b.clock.advance(199_999);
    await b.settle();
    expect(host.state.status).toBe('bidding');
    b.clock.advance(1);
    await b.settle();
    expect(host.state.status).toBe('results');
    expect(room.state.rounds[1].selections[b1.playerId]).toBe(3);
    expect(room.state.rounds[1].bidType[b1.playerId]).toBe('auto_selected');

    // The game then plays to the end.
    for (const round of [3, 4]) {
      await b.call(host, 'host:next');
      for (const bot of a.bots) await b.call(phones[bot.name], 'player:submit', { round, price: 5 });
    }
    await b.call(host, 'host:reveal');
    await b.call(host, 'host:standings');
    await b.settle();
    expect(phones['Bot 1'].state.standings).toHaveLength(8);
    expect((await b.call(host, 'host:csv')).ok).toBe(true);
  });

  it('the autosave restores the game too', async () => {
    const a = await startGame(4);
    await a.call(a.bots[0].socket, 'player:select', { round: 1, price: 1 });
    a.clock.advance(60_000);
    await a.call(a.bots[1].socket, 'player:submit', { round: 1, price: 2 });
    await a.settle();
    const autosave = a.host.log.filter((e) => e.event === 'autosave').at(-1).payload.file;
    await a.close();

    const b = track(await startServer());
    const host = await b.host();
    expect((await b.call(host, 'host:import', { file: autosave })).ok).toBe(true);
    await b.settle();
    expect(host.state).toMatchObject({ status: 'bidding', round: 1, bidsIn: 1 });
    expect(host.state.timer).toMatchObject({ remainingMs: 240_000, running: false });
    const phone = await b.connect();
    await b.call(phone, 'player:resume', { code: a.code, token: a.bots[0].token });
    expect(phone.state.me.selection).toBe(1);
  });

  it('cannot be opened with a different host password', async () => {
    const a = await startGame(4);
    const { file } = await a.call(a.host, 'host:export');
    await a.close();

    const b = track(await startServer({ hostPassword: 'another-password' }));
    const host = await b.connect();
    await b.call(host, 'host:login', { password: 'another-password' });
    const reply = await b.call(host, 'host:import', { file });
    expect(reply.error).toBe('bad_snapshot');
    expect(reply.message).toMatch(/different host password/);
    expect(PASSWORD).not.toBe('another-password');
  });

  it('replaces a live room with the same code', async () => {
    const t = track(await startGame(4));
    const { file } = await t.call(t.host, 'host:export');
    await submitAll(t);
    expect(t.host.state.status).toBe('results');
    expect((await t.call(t.host, 'host:import', { file })).ok).toBe(true);
    await t.settle();
    for (const client of [t.host, ...t.bots.map((b) => b.socket)]) {
      expect(client.state).toMatchObject({ status: 'bidding', round: 1, bidsIn: 0 });
    }
  });
});

describe('room cleanup', () => {
  it('deletes a room after 3 hours without activity', async () => {
    const t = track(await startServer());
    const idle = await t.createRoom();
    const busy = await t.createRoom();
    const [bot] = await t.joinBots(idle.code, 1);

    t.clock.advance(2 * 60 * 60 * 1000);
    await t.joinBots(busy.code, 1); // activity in one room only
    expect(t.server.sweep()).toEqual([]);

    t.clock.advance(60 * 60 * 1000 + 1);
    expect(t.server.sweep()).toEqual([idle.code]);
    await t.settle();

    const checker = await t.connect();
    expect((await t.call(checker, 'room:check', { code: idle.code })).error).toBe('no_room');
    expect((await t.call(checker, 'room:check', { code: busy.code })).ok).toBe(true);
    expect(bot.socket.log.at(-1)).toMatchObject({ event: 'left', payload: { reason: 'closed' } });
    expect(idle.host.log.at(-1)).toMatchObject({ event: 'left', payload: { reason: 'closed' } });
  });
});
