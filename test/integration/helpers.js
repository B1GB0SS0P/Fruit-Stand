import { io as connectClient } from 'socket.io-client';
import { createApp } from '../../server/app.js';

export const PASSWORD = 'test-host-password';

// A clock the test moves by hand. Stands in for Date.now and setTimeout on
// the server, so a 5-minute round takes no real time.
export class FakeClock {
  constructor(start = 1_700_000_000_000) {
    this.time = start;
    this.jobs = new Map();
    this.nextId = 1;
    this.now = () => this.time;
    this.setTimeout = (fn, ms) => {
      const id = this.nextId++;
      this.jobs.set(id, { at: this.time + ms, fn });
      return id;
    };
    this.clearTimeout = (id) => {
      this.jobs.delete(id);
    };
  }

  get pending() {
    return this.jobs.size;
  }

  advance(ms) {
    const end = this.time + ms;
    for (;;) {
      const due = [...this.jobs.entries()].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.jobs.delete(due[0]);
      this.time = due[1].at;
      due[1].fn();
    }
    this.time = end;
  }
}

export async function startServer(options = {}) {
  const clock = options.clock ?? new FakeClock();
  const server = createApp({ hostPassword: PASSWORD, timers: clock, ...options });
  await new Promise((resolve) => server.httpServer.listen(0, resolve));
  const url = `http://localhost:${server.httpServer.address().port}`;
  const clients = [];

  // A connected client that records everything the server sends it.
  function connect() {
    const socket = connectClient(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    socket.log = [];
    socket.state = null;
    socket.onAny((event, payload) => {
      socket.log.push({ event, payload });
      if (event === 'state') socket.state = payload;
    });
    clients.push(socket);
    return new Promise((resolve, reject) => {
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', reject);
    });
  }

  const call = (socket, event, payload = {}) => socket.emitWithAck(event, payload);

  // Waits until every message already sent by the server has arrived.
  // Messages to one socket arrive in order, so a round trip is enough.
  const settle = () =>
    Promise.all(clients.filter((c) => c.connected).map((c) => c.emitWithAck('room:check', { code: '----' })));

  async function host() {
    const socket = await connect();
    await call(socket, 'host:login', { password: PASSWORD });
    return socket;
  }

  async function createRoom() {
    const socket = await host();
    const { code } = await call(socket, 'host:create');
    return { host: socket, code };
  }

  async function joinBots(code, count, startAt = 0) {
    const bots = [];
    for (let i = 0; i < count; i++) {
      const socket = await connect();
      const name = `Bot ${startAt + i + 1}`;
      const reply = await call(socket, 'player:join', { code, name, avatar: '🐼' });
      if (!reply.ok) throw new Error(`join failed: ${reply.error}`);
      bots.push({ socket, name, token: reply.token, playerId: reply.playerId });
    }
    return bots;
  }

  async function close() {
    for (const client of clients) client.disconnect();
    await server.close();
  }

  return { server, clock, url, clients, connect, call, settle, host, createRoom, joinBots, close };
}

// A server with a room, `count` bots in it, and the game started.
export async function startGame(count, options = {}) {
  const t = await startServer(options);
  const { host, code } = await t.createRoom();
  const bots = await t.joinBots(code, count);
  const reply = await t.call(host, 'host:start');
  if (!reply.ok) throw new Error(`start failed: ${reply.error}`);
  await t.settle();
  const room = t.server.store.get(code);
  return { ...t, host, code, bots, room };
}

// Every bot that has not locked in submits `priceOf(bot)`.
export async function submitAll(t, priceOf = () => 5) {
  const round = t.room.state.round;
  for (const bot of t.bots) {
    if (t.room.state.rounds[round - 1].submitted[bot.playerId]) continue;
    const reply = await t.call(bot.socket, 'player:submit', { round, price: priceOf(bot) });
    if (!reply.ok) throw new Error(`submit failed: ${reply.error}`);
  }
  await t.settle();
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

export function testRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
