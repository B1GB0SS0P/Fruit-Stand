// Socket handlers. Kept thin: check the input, call the engine, then send
// each recipient their own view.

import * as engine from '../game/engine.js';
import { playerView, screenView, hostView, publicConfig } from '../game/views.js';
import { resultsCsv } from '../game/csv.js';
import { exportSnapshot, importSnapshot } from '../game/snapshot.js';
import { samePassword } from './seal.js';
import { normalizeCode, newToken, newSeed, newRejoinCode } from './rooms.js';

const MAX_LOGIN_FAILURES = 10;
const LOGIN_WINDOW_MS = 60_000;

const NO_ROOM = { ok: false, error: 'no_room', message: "We couldn't find that room. Check the code and try again." };
const NOT_HOST = { ok: false, error: 'not_host', message: 'Please log in as the host.' };
const NOT_SEATED = { ok: false, error: 'not_seated', message: 'You are not in a game right now.' };

// Engine results can hold whole player records, so only these fields go back.
const brief = (result) => (result.ok ? { ok: true } : { ok: false, error: result.error, message: result.message });

export function createGameServer({ io, store, timers, hostPassword, sealer, config }) {
  const now = () => timers.now();
  const loginFailures = new Map();

  // ---------- sending ----------

  function sendState(socket, room) {
    const { role, playerId } = socket.data;
    if (role === 'player') {
      const view = playerView(room.state, playerId, now());
      if (view) socket.emit('state', view);
      else leave(socket, { reason: 'gone', message: 'Your seat is no longer in this game.' });
    } else if (role === 'screen') {
      socket.emit('state', screenView(room.state, now()));
    } else if (role === 'host') {
      const view = hostView(room.state, now());
      const online = new Set([...room.sockets].map((s) => s.data.playerId));
      view.players = view.players.map((p) => ({ ...p, connected: online.has(p.id) }));
      socket.emit('state', view);
    }
  }

  const socketsOf = (room, role) => [...room.sockets].filter((s) => s.data.role === role);

  function broadcast(room) {
    for (const socket of [...room.sockets]) sendState(socket, room);
  }

  function notifyHosts(room) {
    for (const socket of socketsOf(room, 'host')) sendState(socket, room);
  }

  // The host's browser keeps the latest sealed snapshot, ready to restore
  // the game if the server restarts.
  function autosave(room) {
    const hosts = socketsOf(room, 'host');
    if (!hosts.length) return;
    const file = sealer.seal(exportSnapshot(room.state, now()));
    for (const socket of hosts) socket.emit('autosave', { code: room.code, file });
  }

  function syncTimer(room) {
    if (room.timer !== null) timers.clearTimeout(room.timer);
    room.timer = null;
    const due = engine.deadline(room.state);
    if (due === null) return;
    const round = room.state.round;
    room.timer = timers.setTimeout(() => {
      room.timer = null;
      if (store.get(room.code) !== room) return;
      if (engine.expire(room.state, round, now()).ok) changed(room);
      else syncTimer(room);
    }, Math.max(0, due - now()));
  }

  // Call after anything that changes what people see.
  function changed(room) {
    room.lastActivity = now();
    syncTimer(room);
    broadcast(room);
    autosave(room);
  }

  // ---------- seats ----------

  function detach(socket) {
    const room = store.get(socket.data.code);
    if (room) room.sockets.delete(socket);
    const wasPlayer = socket.data.role === 'player';
    socket.data.code = null;
    socket.data.role = null;
    socket.data.playerId = null;
    if (room && wasPlayer) notifyHosts(room);
  }

  function leave(socket, info) {
    detach(socket);
    socket.emit('left', info);
  }

  function attach(socket, room, role, playerId = null) {
    detach(socket);
    socket.data.code = room.code;
    socket.data.role = role;
    socket.data.playerId = playerId;
    room.sockets.add(socket);
    socket.leave(`wait:${room.code}`);
    socket.emit('config', publicConfig(room.state));
    sendState(socket, room);
    if (role === 'player') notifyHosts(room);
  }

  // ---------- handler helpers ----------

  function on(socket, event, handler) {
    socket.on(event, (payload, ack) => {
      if (typeof payload === 'function') [payload, ack] = [{}, payload];
      const reply = typeof ack === 'function' ? ack : () => {};
      const data = payload && typeof payload === 'object' ? payload : {};
      try {
        reply(handler(data) ?? { ok: true });
      } catch (err) {
        console.error(`Error handling ${event}:`, err);
        reply({ ok: false, error: 'server_error', message: 'Something went wrong. Please try again.' });
      }
    });
  }

  const asPlayer = (socket, event, handler) =>
    on(socket, event, (data) => {
      const room = store.get(socket.data.code);
      if (!room || socket.data.role !== 'player') return NOT_SEATED;
      return handler(room, socket.data.playerId, data);
    });

  const asHost = (socket, event, handler) =>
    on(socket, event, (data) => (socket.data.isHost ? handler(data) : NOT_HOST));

  const asRoomHost = (socket, event, handler) =>
    asHost(socket, event, (data) => {
      const room = store.get(socket.data.code);
      if (!room || socket.data.role !== 'host') return NO_ROOM;
      return handler(room, data);
    });

  // Runs an engine call and broadcasts if it worked.
  const apply = (room, result) => {
    if (result.ok) changed(room);
    return brief(result);
  };

  // ---------- connections ----------

  io.on('connection', (socket) => {
    socket.data = { isHost: false, code: null, role: null, playerId: null };

    socket.on('disconnect', () => detach(socket));

    // ----- joining -----

    on(socket, 'room:check', ({ code }) => {
      const room = store.get(code);
      if (!room) return NO_ROOM;
      const result = engine.checkJoinable(room.state);
      return result.ok ? { ok: true, code: room.code, avatars: room.state.config.avatars } : brief(result);
    });

    on(socket, 'room:checkName', ({ code, name }) => {
      const room = store.get(code);
      if (!room) return NO_ROOM;
      const joinable = engine.checkJoinable(room.state);
      if (!joinable.ok) return brief(joinable);
      const result = engine.checkName(room.state, name);
      return result.ok ? { ok: true, name: result.name } : brief(result);
    });

    on(socket, 'player:join', ({ code, name, avatar }) => {
      const room = store.get(code);
      if (!room) return NO_ROOM;
      const token = newToken();
      const result = engine.addPlayer(room.state, { name, avatar, token, rejoinCode: newRejoinCode(room.state) });
      if (!result.ok) return brief(result);
      attach(socket, room, 'player', result.player.id);
      changed(room);
      return { ok: true, code: room.code, token, playerId: result.player.id };
    });

    // A returning phone gets its seat back, with a full resync.
    on(socket, 'player:resume', ({ code, token }) => {
      const wanted = normalizeCode(code);
      const room = store.get(wanted);
      if (!room) {
        // The server may have restarted. Wait here for the host to restore.
        if (/^[A-Z]{4}$/.test(wanted)) socket.join(`wait:${wanted}`);
        return NO_ROOM;
      }
      if (engine.isRevoked(room.state, token)) {
        return { ok: false, error: 'removed', message: "You've been assigned a separate task — please see the host." };
      }
      const player = typeof token === 'string' ? engine.findPlayerByToken(room.state, token) : null;
      if (!player) return { ok: false, error: 'unknown_token', message: 'Your seat was not found. Please join again.' };
      attach(socket, room, 'player', player.id);
      room.lastActivity = now();
      return { ok: true, code: room.code, playerId: player.id };
    });

    // A player who lost their token gets a rejoin code from the host.
    on(socket, 'player:rejoin', ({ code, rejoinCode }) => {
      const room = store.get(code);
      if (!room) return NO_ROOM;
      const token = newToken();
      const result = engine.claimSeat(room.state, rejoinCode, token);
      if (!result.ok) return brief(result);
      attach(socket, room, 'player', result.player.id);
      room.lastActivity = now();
      autosave(room);
      return { ok: true, code: room.code, token, playerId: result.player.id };
    });

    // ----- playing -----

    asPlayer(socket, 'player:select', (room, playerId, { round, price }) => {
      const result = engine.select(room.state, playerId, round, price, now());
      if (!result.ok) return brief(result);
      room.lastActivity = now();
      // Nobody else can see a selection, so only this player's screens update.
      for (const s of room.sockets) if (s.data.playerId === playerId) sendState(s, room);
      autosave(room);
      return { ok: true, price: result.price };
    });

    asPlayer(socket, 'player:submit', (room, playerId, { round, price }) => {
      const result = engine.submit(room.state, playerId, round, price, now());
      if (!result.ok) return brief(result);
      if (!result.duplicate) changed(room);
      return { ok: true, price: result.price };
    });

    asPlayer(socket, 'player:change', (room, playerId, { round, fruit }) => {
      const result = engine.change(room.state, playerId, round, fruit, now());
      if (!result.ok) return brief(result);
      const { playerId: _hidden, ...announcement } = result.announcement;
      for (const s of room.sockets) s.emit('announcement', announcement);
      changed(room);
      return { ok: true, fruit };
    });

    // ----- projector -----

    on(socket, 'screen:watch', ({ code }) => {
      const room = store.get(code);
      if (!room) return NO_ROOM;
      attach(socket, room, 'screen');
      return { ok: true, code: room.code };
    });

    // ----- host -----

    on(socket, 'host:login', ({ password }) => {
      const forwarded = socket.handshake.headers['x-forwarded-for'];
      const ip = (typeof forwarded === 'string' && forwarded.split(',')[0].trim()) || socket.handshake.address;
      const record = loginFailures.get(ip);
      if (record && now() - record.since > LOGIN_WINDOW_MS) loginFailures.delete(ip);
      if ((loginFailures.get(ip)?.count ?? 0) >= MAX_LOGIN_FAILURES) {
        return { ok: false, error: 'too_many_attempts', message: 'Too many wrong passwords. Wait a minute and try again.' };
      }
      if (!samePassword(password, hostPassword)) {
        const current = loginFailures.get(ip) ?? { count: 0, since: now() };
        current.count += 1;
        loginFailures.set(ip, current);
        return { ok: false, error: 'bad_password', message: 'That password is not right.' };
      }
      socket.data.isHost = true;
      return { ok: true };
    });

    asHost(socket, 'host:rooms', () => ({
      ok: true,
      rooms: [...store.rooms.values()].map((room) => ({
        code: room.code,
        status: room.state.status,
        players: room.state.players.length,
      })),
    }));

    asHost(socket, 'host:create', () => {
      const state = engine.createGame({ code: store.newCode(), seed: newSeed(), config });
      const room = store.add(state, now());
      attach(socket, room, 'host');
      autosave(room);
      return { ok: true, code: room.code };
    });

    asHost(socket, 'host:watch', ({ code }) => {
      const room = store.get(code);
      if (!room) return NO_ROOM;
      attach(socket, room, 'host');
      autosave(room);
      return { ok: true, code: room.code };
    });

    asRoomHost(socket, 'host:remove', (room, { playerId }) => {
      const result = engine.removePlayer(room.state, playerId);
      if (!result.ok) return brief(result);
      for (const s of socketsOf(room, 'player')) {
        if (s.data.playerId === playerId) {
          leave(s, { reason: 'removed', message: "You've been assigned a separate task — please see the host." });
        }
      }
      changed(room);
      return { ok: true };
    });

    asRoomHost(socket, 'host:lock', (room, { locked }) => apply(room, engine.setLocked(room.state, locked === true)));
    asRoomHost(socket, 'host:start', (room) => apply(room, engine.startGame(room.state, now())));
    asRoomHost(socket, 'host:next', (room) => apply(room, engine.nextRound(room.state, now())));
    asRoomHost(socket, 'host:reveal', (room) => apply(room, engine.revealSecrets(room.state)));
    asRoomHost(socket, 'host:standings', (room) => apply(room, engine.showStandings(room.state)));
    asRoomHost(socket, 'host:pause', (room) => apply(room, engine.pauseTimer(room.state, now())));
    asRoomHost(socket, 'host:resume', (room) => apply(room, engine.resumeTimer(room.state, now())));
    asRoomHost(socket, 'host:addMinute', (room) => apply(room, engine.addTime(room.state, 60_000, now())));

    asRoomHost(socket, 'host:setBid', (room, { playerId, round, price }) =>
      apply(room, engine.hostSetBid(room.state, playerId, round, price, now())));

    asRoomHost(socket, 'host:reset', (room, { keepPlayers }) => {
      const keep = keepPlayers === true;
      engine.reset(room.state, { keepPlayers: keep });
      if (!keep) {
        for (const s of socketsOf(room, 'player')) {
          leave(s, { reason: 'reset', message: 'The host has reset the game. Please join again.' });
        }
      }
      changed(room);
      return { ok: true };
    });

    asRoomHost(socket, 'host:remind', (room) => {
      const round = engine.currentRound(room.state);
      if (room.state.status !== 'bidding' || !round) {
        return { ok: false, error: 'round_closed', message: 'There is no round running.' };
      }
      const waiting = room.state.players.filter((p) => !round.submitted[p.id]);
      const ids = new Set(waiting.map((p) => p.id));
      for (const s of socketsOf(room, 'player')) {
        if (ids.has(s.data.playerId)) s.emit('nudge', { message: 'The host is waiting for your price. Pick one and press Submit!' });
      }
      return { ok: true, count: waiting.length };
    });

    asRoomHost(socket, 'host:csv', (room) => {
      if (room.state.status !== 'final') {
        return { ok: false, error: 'not_finished', message: 'The results file is available once the final standings are showing.' };
      }
      return { ok: true, csv: resultsCsv(room.state), filename: `fruit-stand-${room.code}-results.csv` };
    });

    asRoomHost(socket, 'host:export', (room) => ({
      ok: true,
      file: sealer.seal(exportSnapshot(room.state, now())),
      filename: `fruit-stand-${room.code}-snapshot.json`,
    }));

    asHost(socket, 'host:import', ({ file }) => {
      let state;
      try {
        state = importSnapshot(sealer.open(file));
      } catch (err) {
        return { ok: false, error: 'bad_snapshot', message: err.message };
      }
      state.code = normalizeCode(state.code);
      let room = store.get(state.code);
      if (room) {
        if (room.timer !== null) timers.clearTimeout(room.timer);
        room.timer = null;
        room.state = state;
      } else {
        room = store.add(state, now());
      }
      attach(socket, room, 'host');
      changed(room);
      io.to(`wait:${room.code}`).emit('room:restored', { code: room.code });
      return { ok: true, code: room.code };
    });
  });

  // ---------- housekeeping ----------

  function closeRoom(room) {
    if (room.timer !== null) timers.clearTimeout(room.timer);
    room.timer = null;
    for (const socket of [...room.sockets]) {
      leave(socket, { reason: 'closed', message: 'This room has closed.' });
    }
    store.delete(room.code);
  }

  return {
    // Deletes rooms that have been idle for 3 hours.
    sweep() {
      const stale = store.stale(now());
      stale.forEach(closeRoom);
      return stale.map((room) => room.code);
    },
    stopTimers() {
      for (const room of store.rooms.values()) {
        if (room.timer !== null) timers.clearTimeout(room.timer);
        room.timer = null;
      }
    },
  };
}
