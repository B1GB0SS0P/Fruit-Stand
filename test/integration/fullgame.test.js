import { describe, it, expect, afterEach } from 'vitest';
import { startServer, allKeys, ambientOf, testRandom } from './helpers.js';
import { defaultConfig } from '../../config.js';

let t;
afterEach(async () => {
  await t?.close();
  t = null;
});

const PLAYER_FORBIDDEN = ['selections', 'earnings', 'bidType', 'fruitOf', 'lowest', 'winners', 'units', 'token', 'rejoinCode', 'rngState', 'teams', 'rounds'];
const HOST_FORBIDDEN = ['selections', 'selection', 'earnings', 'price', 'results', 'total', 'lowest', 'token', 'rngState', 'rounds'];

const fruitEmojis = defaultConfig.fruits.map((fruit) => fruit.emoji);

// Checks every message a client ever received.
function audit(client, role) {
  let sawReveal = false;
  let ambientSends = 0;
  for (const { event, payload } of client.log) {
    if (event === 'autosave') {
      expect(role).toBe('host');
      expect(Object.keys(JSON.parse(payload.file)).sort()).toEqual(['data', 'format', 'iv', 'tag', 'version']);
      continue;
    }
    if (event === 'config') {
      for (const key of allKeys(payload)) expect(key).not.toMatch(/secret|weight/i);
      continue;
    }
    if (event !== 'state') {
      // Announcements, nudges and the rest never mention secret fruits.
      for (const key of allKeys(payload)) expect(key).not.toMatch(/secret/i);
      continue;
    }
    const keys = allKeys(payload);

    // Until round 2 resolves, nothing says which fruits are secret: no
    // flag, no list, no field. The ambient sequence is emojis and timing.
    const beforeSecretsKnown = payload.round < 2 || (payload.round === 2 && payload.status === 'bidding');
    if (beforeSecretsKnown) {
      for (const key of keys) expect(key, `${role} got "${key}" too early`).not.toMatch(/secret/i);
    }
    const playingRound2 = payload.round === 2 && payload.status === 'bidding';
    expect(payload.curtained).toBe(playingRound2);
    // Sent once per round 2, then left out of later updates.
    if (!playingRound2) expect(payload.ambient).toBeNull();
    else if (payload.ambient) ambientSends += 1;
    for (const item of payload.ambient ?? []) {
      expect(Object.keys(item).sort()).toEqual(['delay', 'duration', 'emoji']);
      expect(fruitEmojis).toContain(item.emoji);
    }
    if (role === 'player') expect(payload.receipt === null).toBe(payload.status !== 'final');
    else expect(keys.has('receipt')).toBe(false);
    const ended = payload.status === 'reveal' || payload.status === 'final';
    if (ended) sawReveal = true;

    if (role === 'host') {
      if (!ended) for (const key of HOST_FORBIDDEN) expect(keys.has(key), `host got "${key}"`).toBe(false);
      continue;
    }
    for (const key of PLAYER_FORBIDDEN) expect(keys.has(key), `${role} got "${key}"`).toBe(false);
    if (payload.status !== 'final') expect(payload.standings).toBeNull();
    for (const round of payload.results) {
      expect(Object.keys(round).sort()).toEqual(['fruits', 'phase', 'round']);
      for (const entry of round.fruits) {
        expect(Object.keys(entry).sort()).toEqual(round.round === 2 ? ['fruit', 'price', 'secret'] : ['fruit', 'price']);
        if (entry.secret && !ended) expect(entry.price).toBeNull();
        else expect(entry.price).toBeGreaterThanOrEqual(1);
        if (entry.secret) expect(round.round).toBe(2);
      }
    }
  }
  expect(sawReveal).toBe(true);
  expect(ambientSends).toBe(1);
}

async function playFullGame(count) {
  t = await startServer();
  const { host, code } = await t.createRoom();
  const screen = await t.connect();
  await t.call(screen, 'screen:watch', { code });
  const bots = await t.joinBots(code, count);
  await t.settle();
  expect(screen.state.players).toHaveLength(count);

  expect((await t.call(host, 'host:start')).ok).toBe(true);
  await t.settle();
  const room = t.server.store.get(code);
  const random = testRandom(count);
  const expectedFruits = Math.min(20, Math.floor(count / Math.max(2, Math.ceil(count / 10))));
  expect(screen.state.activeFruits).toHaveLength(expectedFruits);

  for (let round = 1; round <= 4; round++) {
    await t.settle();
    expect(screen.state).toMatchObject({ status: 'bidding', round, bidsIn: 0, playerCount: count });
    if (round === 2) {
      // Everyone gets the same curtains and the same ambient sequence, made
      // only from fruits in play. The secret list itself stays on the server.
      const expectedSecret = Math.max(1, Math.floor(expectedFruits * 0.25 + 0.5));
      expect(room.state.rounds[1].secret).toHaveLength(expectedSecret);
      const inPlay = room.state.activeFruits.map((id) => defaultConfig.fruits.find((f) => f.id === id).emoji);
      for (const client of [screen, host, ...bots.map((b) => b.socket)]) {
        expect(client.state.curtained).toBe(true);
        expect(ambientOf(client)).toEqual(ambientOf(screen));
      }
      expect(ambientOf(screen).length).toBeGreaterThan(100);
      for (const item of ambientOf(screen)) expect(inPlay).toContain(item.emoji);
    } else {
      expect(screen.state.curtained).toBe(false);
      expect(screen.state.ambient).toBeNull();
    }

    for (const bot of bots) {
      // A few players use their Change token along the way.
      if (random() < 0.1 && bot.socket.state.me.changeTokens > 0) {
        const targets = bot.socket.state.changeTargets;
        const reply = await t.call(bot.socket, 'player:change', { round, fruit: targets[Math.floor(random() * targets.length)] });
        expect(reply.ok).toBe(true);
      }
      const price = 1 + Math.floor(random() * 5);
      expect((await t.call(bot.socket, 'player:select', { round, price })).ok).toBe(true);
      expect((await t.call(bot.socket, 'player:submit', { round })).ok).toBe(true);
    }
    await t.settle();

    for (const client of [screen, ...bots.map((b) => b.socket)]) {
      expect(client.state.status).toBe('results');
      expect(client.state.results).toHaveLength(round);
    }
    expect(host.state).toMatchObject({ status: 'results', bidsIn: count });
    if (round < 4) expect((await t.call(host, 'host:next')).ok).toBe(true);
  }

  // The finale: secrets first, then standings.
  expect((await t.call(host, 'host:standings')).error).toBe('not_revealed');
  expect((await t.call(host, 'host:reveal')).ok).toBe(true);
  await t.settle();
  const round2 = screen.state.results.find((r) => r.round === 2);
  const secrets = round2.fruits.filter((f) => f.secret);
  expect(secrets.length).toBeGreaterThan(0);
  for (const entry of secrets) expect(entry.price).toBe(room.state.rounds[1].results[entry.fruit].lowest);
  expect(screen.state.standings).toBeNull();

  expect((await t.call(host, 'host:standings')).ok).toBe(true);
  await t.settle();
  for (const client of [screen, host, ...bots.map((b) => b.socket)]) {
    expect(client.state.status).toBe('final');
    expect(client.state.standings).toHaveLength(count);
  }
  const standings = screen.state.standings;
  expect(standings[0].rank).toBe(1);

  // Every avatar is an animal in a ring, and no two players look the same.
  expect(new Set(standings.map((row) => `${row.avatar} ${row.ring}`)).size).toBe(count);

  // Each phone gets its own receipt, and it adds up to that player's total.
  for (const bot of bots) {
    const { receipt, me } = bot.socket.state;
    const row = standings.find((entry) => entry.id === me.id);
    expect(receipt.lines.map((line) => line.round)).toEqual([1, 2, 3, 4]);
    expect(receipt.shares.map((team) => team.phase)).toEqual([1, 2]);
    expect(receipt).toMatchObject({ total: row.total, rank: row.rank, of: count });
    const halves = receipt.shares.reduce((sum, team) => sum + Number(team.half), 0);
    expect(Math.abs(halves - Number(receipt.total))).toBeLessThan(0.02);
  }
  expect(new Set(standings.map((row) => row.name))).toEqual(new Set(bots.map((b) => b.name)));
  for (let i = 1; i < standings.length; i++) {
    expect(Number(standings[i - 1].total)).toBeGreaterThanOrEqual(Number(standings[i].total));
    expect(standings[i].rank).toBe(standings[i].total === standings[i - 1].total ? standings[i - 1].rank : i + 1);
  }

  // The CSV agrees with the standings.
  const { csv, ok } = await t.call(host, 'host:csv');
  expect(ok).toBe(true);
  const lines = csv.trim().split('\r\n');
  const bidRows = lines.slice(1, 1 + count * 4).map((line) => line.split(','));
  const earned = bidRows.reduce((sum, row) => sum + Number(row[9]), 0);
  const totalled = standings.reduce((sum, row) => sum + Number(row.total), 0);
  expect(Math.abs(earned - totalled)).toBeLessThan(0.01 * count);
  expect(earned).toBeGreaterThan(0);
  expect(bidRows.some((row) => row[5] === 'yes')).toBe(true);

  // Nothing private leaked to anyone at any point in the game.
  audit(host, 'host');
  audit(screen, 'screen');
  for (const bot of bots) audit(bot.socket, 'player');
}

describe('full games over Socket.IO', () => {
  it('8 bots from join to final standings', async () => {
    await playFullGame(8);
  });

  it('40 bots from join to final standings', async () => {
    await playFullGame(40);
  }, 60_000);

  it('60 bots, above the old 40-player cap', async () => {
    await playFullGame(60);
  }, 90_000);
});
