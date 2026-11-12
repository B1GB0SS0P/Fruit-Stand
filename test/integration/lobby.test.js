import { describe, it, expect, afterEach } from 'vitest';
import { startServer, PASSWORD } from './helpers.js';

let t;
afterEach(async () => {
  await t?.close();
  t = null;
});

describe('http', () => {
  it('answers the health check', async () => {
    t = await startServer();
    const response = await fetch(`${t.url}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });

  it('serves a QR code for the join link', async () => {
    t = await startServer({ publicUrl: 'https://example.test/' });
    const good = await fetch(`${t.url}/qr.svg?room=abcd`);
    expect(good.status).toBe(200);
    expect(good.headers.get('content-type')).toContain('image/svg+xml');
    expect(await good.text()).toContain('<svg');
    expect((await fetch(`${t.url}/qr.svg?room=../x`)).status).toBe(400);
  });
});

describe('host login', () => {
  it('needs the right password', async () => {
    t = await startServer();
    const socket = await t.connect();
    expect((await t.call(socket, 'host:create')).error).toBe('not_host');
    expect((await t.call(socket, 'host:login', { password: 'wrong' })).error).toBe('bad_password');
    expect((await t.call(socket, 'host:login', {})).error).toBe('bad_password');
    expect((await t.call(socket, 'host:create')).error).toBe('not_host');
    expect((await t.call(socket, 'host:login', { password: PASSWORD })).ok).toBe(true);
    const created = await t.call(socket, 'host:create');
    expect(created.code).toMatch(/^[A-HJ-NP-Z]{4}$/);
  });

  it('locks out after repeated wrong passwords, then recovers', async () => {
    t = await startServer();
    const socket = await t.connect();
    for (let i = 0; i < 10; i++) {
      expect((await t.call(socket, 'host:login', { password: `guess-${i}` })).error).toBe('bad_password');
    }
    expect((await t.call(socket, 'host:login', { password: PASSWORD })).error).toBe('too_many_attempts');
    t.clock.advance(61_000);
    expect((await t.call(socket, 'host:login', { password: PASSWORD })).ok).toBe(true);
  });

  it('players and screens cannot use host actions', async () => {
    t = await startServer();
    const { code } = await t.createRoom();
    const [bot] = await t.joinBots(code, 1);
    const screen = await t.connect();
    await t.call(screen, 'screen:watch', { code });
    for (const socket of [bot.socket, screen]) {
      for (const event of ['host:start', 'host:export', 'host:csv', 'host:remove', 'host:rooms', 'host:import', 'host:setBid']) {
        expect((await t.call(socket, event, {})).error).toBe('not_host');
      }
    }
  });

  it('runs several rooms at once', async () => {
    t = await startServer();
    const a = await t.createRoom();
    const b = await t.createRoom();
    expect(a.code).not.toBe(b.code);
    await t.joinBots(a.code, 3);
    await t.joinBots(b.code, 5);
    await t.settle();
    expect(a.host.state.playerCount).toBe(3);
    expect(b.host.state.playerCount).toBe(5);
    const { rooms } = await t.call(a.host, 'host:rooms');
    expect(rooms.map((r) => r.code).sort()).toEqual([a.code, b.code].sort());
  });
});

describe('joining', () => {
  it('rejects a wrong room code with a friendly message', async () => {
    t = await startServer();
    await t.createRoom();
    const socket = await t.connect();
    for (const code of ['ZZZZ', '', 'toolong', null, 42]) {
      const reply = await t.call(socket, 'room:check', { code });
      expect(reply.error).toBe('no_room');
      expect(reply.message).toMatch(/couldn't find that room/);
    }
    expect((await t.call(socket, 'player:join', { code: 'ZZZZ', name: 'A', avatar: '🐼' })).error).toBe('no_room');
  });

  it('accepts the code in any letter case', async () => {
    t = await startServer();
    const { code } = await t.createRoom();
    const socket = await t.connect();
    expect((await t.call(socket, 'room:check', { code: ` ${code.toLowerCase()} ` })).ok).toBe(true);
  });

  it('checks name length and duplicates before the avatar step', async () => {
    t = await startServer();
    const { code } = await t.createRoom();
    const first = await t.connect();
    expect((await t.call(first, 'player:join', { code, name: 'Ben', avatar: '🐼' })).ok).toBe(true);

    const second = await t.connect();
    expect((await t.call(second, 'room:checkName', { code, name: 'bEN' })).error).toBe('name_taken');
    expect((await t.call(second, 'room:checkName', { code, name: '' })).error).toBe('bad_name');
    expect((await t.call(second, 'room:checkName', { code, name: 'x'.repeat(21) })).error).toBe('bad_name');
    expect(await t.call(second, 'room:checkName', { code, name: '  Amy ' })).toEqual({ ok: true, name: 'Amy' });

    expect((await t.call(second, 'player:join', { code, name: 'BEN', avatar: '🐼' })).error).toBe('name_taken');
    expect((await t.call(second, 'player:join', { code, name: '', avatar: '🐼' })).error).toBe('bad_name');
    expect((await t.call(second, 'player:join', { code, name: 'x'.repeat(21), avatar: '🐼' })).error).toBe('bad_name');
  });

  it('requires an avatar', async () => {
    t = await startServer();
    const { code } = await t.createRoom();
    const socket = await t.connect();
    expect((await t.call(socket, 'player:join', { code, name: 'Amy' })).error).toBe('bad_avatar');
    expect((await t.call(socket, 'player:join', { code, name: 'Amy', avatar: '🍎' })).error).toBe('bad_avatar');
    expect((await t.call(socket, 'player:join', { code, name: 'Amy', avatar: '🦊' })).ok).toBe(true);
  });

  it('refuses joins to a locked lobby and says it is locked', async () => {
    t = await startServer();
    const { host, code } = await t.createRoom();
    await t.call(host, 'host:lock', { locked: true });
    const socket = await t.connect();
    const check = await t.call(socket, 'room:check', { code });
    expect(check.error).toBe('locked');
    expect(check.message).toMatch(/locked/);
    expect((await t.call(socket, 'player:join', { code, name: 'Amy', avatar: '🦊' })).error).toBe('locked');
    await t.call(host, 'host:lock', { locked: false });
    expect((await t.call(socket, 'player:join', { code, name: 'Amy', avatar: '🦊' })).ok).toBe(true);
  });

  it('shows the waiting player, the screen and the host a live lobby', async () => {
    t = await startServer();
    const { host, code } = await t.createRoom();
    const screen = await t.connect();
    await t.call(screen, 'screen:watch', { code });
    const bots = await t.joinBots(code, 3);
    await t.settle();

    expect(bots[0].socket.state).toMatchObject({ role: 'player', status: 'lobby', playerCount: 3 });
    expect(bots[0].socket.state.me).toMatchObject({ name: 'Bot 1', avatar: '🐼' });
    expect(bots[0].socket.state.players).toBeUndefined();
    expect(screen.state.players).toEqual([
      { name: 'Bot 1', avatar: '🐼', ring: '#e2552d' },
      { name: 'Bot 2', avatar: '🐼', ring: '#2ba39b' },
      { name: 'Bot 3', avatar: '🐼', ring: '#f7bb3d' },
    ]);
    expect(bots.map((bot) => bot.socket.state.me.ring)).toEqual(['#e2552d', '#2ba39b', '#f7bb3d']);
    expect(host.state.players.map((p) => p.name)).toEqual(['Bot 1', 'Bot 2', 'Bot 3']);
    expect(host.state.players.every((p) => p.connected)).toBe(true);
    expect(bots[0].socket.log.some((entry) => entry.event === 'config')).toBe(true);
  });

  it("revokes a removed player's token and tells them why", async () => {
    t = await startServer();
    const { host, code } = await t.createRoom();
    const bots = await t.joinBots(code, 5);
    const victim = bots[4];
    expect((await t.call(host, 'host:remove', { playerId: victim.playerId })).ok).toBe(true);
    await t.settle();

    const left = victim.socket.log.find((entry) => entry.event === 'left');
    expect(left.payload.reason).toBe('removed');
    expect(left.payload.message).toBe("You've been assigned a separate task — please see the host.");
    expect(host.state.playerCount).toBe(4);

    // The old token no longer opens a seat, and bids from it are ignored.
    const again = await t.connect();
    const resume = await t.call(again, 'player:resume', { code, token: victim.token });
    expect(resume.error).toBe('removed');
    expect((await t.call(victim.socket, 'player:submit', { round: 1, price: 3 })).error).toBe('not_seated');

    // They can come back only while the lobby is unlocked.
    await t.call(host, 'host:lock', { locked: true });
    expect((await t.call(again, 'player:join', { code, name: 'Bot 5', avatar: '🐼' })).error).toBe('locked');
    await t.call(host, 'host:lock', { locked: false });
    expect((await t.call(again, 'player:join', { code, name: 'Bot 5', avatar: '🐼' })).ok).toBe(true);
  });

  it('refuses to start with an odd count or fewer than 4 players', async () => {
    t = await startServer();
    const { host, code } = await t.createRoom();
    await t.joinBots(code, 3);
    await t.settle();
    expect(host.state.canStart).toBe(false);
    expect((await t.call(host, 'host:start')).error).toBe('too_few');

    await t.joinBots(code, 2, 3);
    await t.settle();
    expect(host.state.canStart).toBe(false);
    expect(host.state.startHint).toBe('5 players: remove 1 to start');
    const refused = await t.call(host, 'host:start');
    expect(refused.error).toBe('odd_count');
    expect(host.state.status).toBe('lobby');

    await t.joinBots(code, 1, 5);
    await t.settle();
    expect(host.state.canStart).toBe(true);
    expect((await t.call(host, 'host:start')).ok).toBe(true);
    await t.settle();
    expect(host.state.status).toBe('bidding');

    const late = await t.connect();
    expect((await t.call(late, 'room:check', { code })).error).toBe('in_progress');
  });

  it('lets the host reset, keeping or wiping players', async () => {
    t = await startServer();
    const { host, code } = await t.createRoom();
    const bots = await t.joinBots(code, 4);
    await t.call(host, 'host:start');
    await t.call(host, 'host:reset', { keepPlayers: true });
    await t.settle();
    expect(host.state).toMatchObject({ status: 'lobby', playerCount: 4 });
    expect(bots[0].socket.state.status).toBe('lobby');

    await t.call(host, 'host:reset', { keepPlayers: false });
    await t.settle();
    expect(host.state.playerCount).toBe(0);
    expect(bots[0].socket.log.at(-1)).toMatchObject({ event: 'left', payload: { reason: 'reset' } });
  });
});
