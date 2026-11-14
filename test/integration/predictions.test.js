import { describe, it, expect, afterEach } from 'vitest';
import { startServer, allKeys, testRandom } from './helpers.js';
import { scorePredictions, medianPoints } from '../../game/predictions.js';

let t;
afterEach(async () => {
  await t?.close();
  t = null;
});

// A room with `players` bots plus `predictors` more who are made predictors.
async function roomWith(players, predictors) {
  t = await startServer();
  const { host, code } = await t.createRoom();
  const screen = await t.connect();
  await t.call(screen, 'screen:watch', { code });
  const everyone = await t.joinBots(code, players + predictors);
  const bots = everyone.slice(0, players);
  const seers = everyone.slice(players);
  for (const seer of seers) {
    expect((await t.call(host, 'host:makePredictor', { playerId: seer.playerId })).ok).toBe(true);
  }
  await t.settle();
  return { host, code, screen, bots, seers, room: t.server.store.get(code) };
}

describe('predictors in the lobby', () => {
  it('lets the host make a predictor and turn them back into a player', async () => {
    const { host, screen, bots, seers } = await roomWith(6, 1);
    const [seer] = seers;

    // The predictor's phone, the host and the projector all see the change.
    expect(seer.socket.state).toMatchObject({ role: 'predictor', status: 'lobby', playerCount: 6, prediction: null });
    expect(seer.socket.state.me).toMatchObject({ id: seer.playerId, name: seer.name });
    expect(host.state.players.map((p) => p.id)).not.toContain(seer.playerId);
    expect(host.state.predictors).toEqual([expect.objectContaining({ id: seer.playerId, name: seer.name, connected: true })]);
    expect(host.state).toMatchObject({ playerCount: 6, canStart: true, maxPredictors: 3 });
    expect(screen.state.players).toHaveLength(6);
    expect(screen.state.predictors).toEqual([{ name: seer.name, avatar: '🐼', ring: expect.any(String) }]);
    expect(bots[0].socket.state).toMatchObject({ role: 'player', playerCount: 6, predictorCount: 1 });

    // Back to a player: 7 players is odd, so the game cannot start.
    expect((await t.call(host, 'host:makePlayer', { predictorId: seer.playerId })).ok).toBe(true);
    await t.settle();
    expect(seer.socket.state).toMatchObject({ role: 'player', playerCount: 7 });
    expect(host.state).toMatchObject({ playerCount: 7, canStart: false, predictors: [] });
    expect((await t.call(host, 'host:start')).error).toBe('odd_count');
  });

  it('does not count predictors towards the even number of players', async () => {
    const { host, bots, seers } = await roomWith(6, 1);
    expect(host.state.startHint).toBe('6 players: ready to start');
    expect((await t.call(host, 'host:start')).ok).toBe(true);
    await t.settle();
    expect(bots[0].socket.state).toMatchObject({ status: 'bidding', playerCount: 6 });
    expect(seers[0].socket.state).toMatchObject({ role: 'predictor', status: 'bidding', playerCount: 6 });
    expect(seers[0].socket.state.pairs).toHaveLength(3);
    expect(seers[0].socket.state.prediction).toEqual({ median: null, winner: null, middle: null });
  });

  it('allows at most 3 predictors, and only the host can choose them', async () => {
    const { host, bots, seers } = await roomWith(5, 3);
    expect(host.state.predictors).toHaveLength(3);
    const fourth = await t.call(host, 'host:makePredictor', { playerId: bots[0].playerId });
    expect(fourth).toMatchObject({ ok: false, error: 'too_many_predictors' });
    expect(fourth.message).toMatch(/at most 3/);
    await t.settle();
    expect(host.state.playerCount).toBe(5);

    for (const socket of [bots[0].socket, seers[0].socket]) {
      expect((await t.call(socket, 'host:makePredictor', { playerId: bots[1].playerId })).error).toBe('not_host');
      expect((await t.call(socket, 'host:makePlayer', { predictorId: seers[1].playerId })).error).toBe('not_host');
      expect((await t.call(socket, 'host:predict', { median: '5' })).error).toBe('not_host');
      expect((await t.call(socket, 'host:predictions')).error).toBe('not_host');
    }
  });

  it('removes a predictor like a player, and keeps their seat across a reconnect', async () => {
    const { host, code, seers } = await roomWith(4, 2);
    const [stays, goes] = seers;

    // A predictor who reloads the page gets the predictor view back.
    const again = await t.connect();
    expect((await t.call(again, 'player:resume', { code, token: stays.token })).ok).toBe(true);
    expect(again.state).toMatchObject({ role: 'predictor', me: { id: stays.playerId } });

    expect((await t.call(host, 'host:remove', { playerId: goes.playerId })).ok).toBe(true);
    await t.settle();
    expect(goes.socket.log.at(-1)).toMatchObject({ event: 'left', payload: { reason: 'removed' } });
    expect(host.state.predictors.map((p) => p.id)).toEqual([stays.playerId]);
    const back = await t.connect();
    expect((await t.call(back, 'player:resume', { code, token: goes.token })).error).toBe('removed');
  });
});

describe('predicting during the game', () => {
  it("refuses a predictor's bid or Change, and a player's prediction", async () => {
    const { host, bots, seers, room } = await roomWith(4, 1);
    await t.call(host, 'host:start');
    await t.settle();
    const [seer] = seers;
    const fruit = room.state.activeFruits[0];
    expect((await t.call(seer.socket, 'player:select', { round: 1, price: 3 })).error).toBe('is_predictor');
    expect((await t.call(seer.socket, 'player:submit', { round: 1, price: 3 })).error).toBe('is_predictor');
    expect((await t.call(seer.socket, 'player:change', { round: 1, fruit })).error).toBe('is_predictor');
    expect((await t.call(host, 'host:setBid', { playerId: seer.playerId, round: 1, price: 3 })).error).toBe('is_predictor');
    expect((await t.call(bots[0].socket, 'predictor:save', { median: '5' })).error).toBe('not_predictor');
    expect(room.state.rounds[0].selections).toEqual({});
    expect(room.state.predictions).toEqual({});
    expect(seer.socket.state.me).not.toHaveProperty('fruit');

    // Reminders go to players who have not bid, never to the predictor.
    expect(await t.call(host, 'host:remind')).toMatchObject({ ok: true, count: 4 });
    await t.settle();
    expect(seer.socket.log.some((entry) => entry.event === 'nudge')).toBe(false);
  });

  it('saves edits until round 3 starts, then rejects them', async () => {
    const { host, bots, seers } = await roomWith(4, 1);
    await t.call(host, 'host:start');
    await t.settle();
    const [seer] = seers;
    const [a, b] = bots.map((bot) => bot.playerId);
    const playRound = async (round) => {
      for (const bot of bots) await t.call(bot.socket, 'player:submit', { round, price: 5 });
    };

    expect((await t.call(seer.socket, 'predictor:save', { median: '12.5', winner: a, middle: null })).ok).toBe(true);
    await t.settle();
    expect(seer.socket.state.prediction).toEqual({ median: '12.50', winner: a, middle: null });
    expect(host.state.predictionStatus).toEqual([
      { id: seer.playerId, name: seer.name, done: false },
      { id: 'host', name: 'You (host)', done: false },
    ]);
    expect((await t.call(seer.socket, 'predictor:save', { median: 'abc' })).error).toBe('bad_median');
    expect((await t.call(seer.socket, 'predictor:save', { median: '3', winner: 'p99' })).error).toBe('bad_pick');

    await playRound(1);
    await t.call(host, 'host:next');
    expect((await t.call(seer.socket, 'predictor:save', { median: '20', winner: b, middle: a })).ok).toBe(true);
    expect((await t.call(host, 'host:predict', { median: '18', winner: a, middle: b })).ok).toBe(true);
    await t.settle();
    expect(host.state.prediction).toEqual({ median: '18.00', winner: a, middle: b });
    expect(host.state.predictionStatus.map((p) => p.done)).toEqual([true, true]);
    expect(seer.socket.state.predicting).toEqual({ locked: false, lockRound: 3 });

    await playRound(2);
    await t.call(host, 'host:next');
    await t.settle();
    for (const client of [seer.socket, host, bots[0].socket]) {
      expect(client.state.predicting).toEqual({ locked: true, lockRound: 3 });
    }
    expect(await t.call(seer.socket, 'predictor:save', { median: '1', winner: a, middle: a })).toMatchObject({ ok: false, error: 'predictions_locked' });
    expect((await t.call(host, 'host:predict', { median: '1' })).error).toBe('predictions_locked');
    await t.settle();
    expect(seer.socket.state.prediction).toEqual({ median: '20.00', winner: b, middle: a });
    expect(host.state.prediction).toEqual({ median: '18.00', winner: a, middle: b });
  });

  it("keeps the host's 'I'm also playing' flag on host screens only", async () => {
    const { host, bots } = await roomWith(4, 0);
    await t.call(host, 'host:start');
    expect((await t.call(host, 'host:playing', { playing: true })).ok).toBe(true);
    await t.settle();
    expect(host.state.hostPlaying).toBe(true);
    expect(allKeys(bots[0].socket.state).has('hostPlaying')).toBe(false);
    expect((await t.call(bots[0].socket, 'host:playing', { playing: true })).error).toBe('not_host');
  });
});

describe('a full 40-player game with 2 predictors and the host', () => {
  it('keeps every prediction private until a correct reveal', async () => {
    const { host, screen, bots, seers, room } = await roomWith(40, 2);
    const [ruth, silas] = seers;
    const ids = bots.map((bot) => bot.playerId);
    expect(host.state).toMatchObject({ playerCount: 40, canStart: true });
    expect((await t.call(host, 'host:start')).ok).toBe(true);
    await t.settle();
    expect(screen.state.activeFruits).toHaveLength(10); // 4 sellers per fruit
    expect(screen.state.playerCount).toBe(40);

    // Amounts that appear nowhere else, so a leak is easy to spot.
    const answers = {
      [ruth.playerId]: { median: '61.11', winner: ids[0], middle: ids[1] },
      [silas.playerId]: { median: '62.22', winner: ids[2], middle: null },
      host: { median: '6.33', winner: ids[4], middle: ids[5] },
    };
    const sent = {
      [ruth.playerId]: { ...answers[ruth.playerId] },
      [silas.playerId]: { ...answers[silas.playerId], median: '62.22' },
      host: { median: '6.33', winner: ids[4], middle: ids[5] },
    };
    const random = testRandom(4040);
    const playRound = async (round) => {
      for (const bot of bots) {
        expect((await t.call(bot.socket, 'player:submit', { round, price: 1 + Math.floor(random() * 5) })).ok).toBe(true);
      }
      await t.settle();
    };

    expect((await t.call(ruth.socket, 'predictor:save', { median: '1', winner: ids[9], middle: null })).ok).toBe(true);
    await playRound(1);
    expect((await t.call(host, 'host:next')).ok).toBe(true);
    // Final answers go in during round 2, the last chance before the lock.
    expect((await t.call(ruth.socket, 'predictor:save', sent[ruth.playerId])).ok).toBe(true);
    expect((await t.call(silas.socket, 'predictor:save', sent[silas.playerId])).ok).toBe(true);
    expect((await t.call(host, 'host:predict', sent.host)).ok).toBe(true);
    await playRound(2);
    expect((await t.call(host, 'host:next')).ok).toBe(true);
    expect((await t.call(silas.socket, 'predictor:save', { ...sent[silas.playerId], middle: ids[7] })).error).toBe('predictions_locked');
    await playRound(3);
    expect((await t.call(host, 'host:next')).ok).toBe(true);
    await playRound(4);

    expect((await t.call(host, 'host:predictions')).error).toBe('not_revealed');
    expect((await t.call(host, 'host:reveal')).ok).toBe(true);
    await t.settle();
    expect(screen.state).toMatchObject({ status: 'reveal', predictionReveal: null });

    // ----- before the reveal: nobody has anyone else's answers -----
    const clients = [
      { socket: host, owner: 'host' },
      { socket: screen, owner: null },
      { socket: ruth.socket, owner: ruth.playerId },
      { socket: silas.socket, owner: silas.playerId },
      ...bots.map((bot) => ({ socket: bot.socket, owner: null })),
    ];
    const secretAmounts = { [ruth.playerId]: ['61.11', '6111'], [silas.playerId]: ['62.22', '6222'], host: ['6.33', '633'] };
    for (const { socket, owner } of clients) {
      const role = socket.state.role;
      for (const { event, payload } of socket.log) {
        if (event === 'autosave') continue; // sealed with the host password
        const text = JSON.stringify(payload);
        for (const [who, [dollars]] of Object.entries(secretAmounts)) {
          if (who !== owner) expect(text.includes(`"${dollars}"`), `${role} saw ${who}'s median`).toBe(false);
        }
        if (event !== 'state') {
          expect(allKeys(payload).has('prediction')).toBe(false);
          continue;
        }
        expect(payload.predictionReveal).toBeNull();
        expect(allKeys(payload).has('predictions')).toBe(false);
        if (owner === null) {
          expect(allKeys(payload).has('prediction')).toBe(false);
          expect(allKeys(payload).has('predictionStatus')).toBe(false);
        } else if (payload.prediction && payload.prediction.median !== null) {
          // Only ever their own answers, as they stood at the time.
          const own = [answers[owner].median, '1.00', Number(answers[owner].median).toFixed(2)];
          expect(own).toContain(payload.prediction.median);
        }
        if (role === 'host') {
          for (const row of payload.predictionStatus) expect(Object.keys(row).sort()).toEqual(['done', 'id', 'name']);
        }
      }
    }
    expect(host.state.prediction).toEqual({ median: '6.33', winner: ids[4], middle: ids[5] });
    expect(ruth.socket.state.prediction).toEqual(answers[ruth.playerId]);
    expect(silas.socket.state.prediction).toEqual(answers[silas.playerId]);
    expect(host.state.predictionStatus.map((p) => p.done)).toEqual([true, false, true]);

    // ----- the reveal -----
    expect((await t.call(host, 'host:predictions')).ok).toBe(true);
    await t.settle();
    const reveal = screen.state.predictionReveal;
    for (const { socket } of clients) {
      expect(socket.state.status).toBe('predictions');
      expect(socket.state.predictionReveal).toEqual(reveal);
      expect(socket.state.standings).toBeNull(); // the podium comes after
    }
    expect(reveal).toEqual(JSON.parse(JSON.stringify(scorePredictions(room.state))));

    expect((await t.call(host, 'host:standings')).ok).toBe(true);
    await t.settle();
    const standings = screen.state.standings;
    expect(standings).toHaveLength(40);
    expect(standings.map((row) => row.id)).not.toContain(ruth.playerId);
    expect(screen.state.predictionReveal).toEqual(reveal);

    // Check the payload against the public standings, independently.
    const rowOf = Object.fromEntries(standings.map((row) => [row.id, row]));
    const tiedAt = (rank) => standings.filter((row) => row.rank === rank).length;
    const actualCents = Math.round((Number(standings[19].total) + Number(standings[20].total)) * 50);
    expect(reveal.playerCount).toBe(40);
    expect(reveal.maxScore).toBe(15);
    expect(Math.abs(Math.round(Number(reveal.actual.median) * 100) - actualCents)).toBeLessThanOrEqual(1);
    expect(reveal.actual.middlePositions).toEqual([20, 21]);
    expect(reveal.actual.first.map((p) => p.id)).toEqual(standings.filter((row) => row.rank === 1).map((row) => row.id));
    const middleIds = reveal.actual.middle.map((p) => p.id);
    expect(middleIds).toContain(standings[19].id);
    expect(middleIds).toContain(standings[20].id);

    expect(reveal.entries.map((entry) => [entry.id, entry.name, entry.isHost])).toEqual([
      [ruth.playerId, ruth.name, false], [silas.playerId, silas.name, false], ['host', 'Host', true],
    ]);
    const realCents = Math.round(Number(reveal.actual.median) * 100);
    for (const entry of reveal.entries) {
      const mine = answers[entry.id];
      expect(entry.median.guess).toBe(Number(mine.median).toFixed(2));
      expect(entry.median.points).toBe(medianPoints(Math.round(Number(mine.median) * 100), realCents));

      const winnerRank = rowOf[mine.winner].rank;
      expect(entry.winner.pick).toMatchObject({ id: mine.winner, rank: winnerRank, tied: tiedAt(winnerRank) > 1 });
      expect(entry.winner.points).toBe(Math.max(0, 6 - winnerRank));

      if (mine.middle === null) expect(entry.middle).toEqual({ pick: null, away: null, points: 0 });
      else {
        const rank = rowOf[mine.middle].rank;
        const last = rank + tiedAt(rank) - 1;
        const away = last < 20 ? 20 - last : rank > 21 ? rank - 21 : 0;
        expect(entry.middle).toMatchObject({ pick: { id: mine.middle, rank }, away, points: Math.max(0, 5 - away) });
      }
      expect(entry.score).toBe(entry.median.points + entry.winner.points + entry.middle.points);
      expect(entry.score).toBeLessThanOrEqual(15);
    }
    // Ruth and Silas guessed about $55 too high, so they score 0 on the median.
    expect(reveal.entries[0].median.points).toBe(0);
    expect(reveal.entries[1].median.points).toBe(0);
    const top = Math.max(...reveal.entries.map((entry) => entry.score));
    expect(reveal.champions.length).toBeGreaterThanOrEqual(1);
    for (const id of reveal.champions) expect(reveal.entries.find((entry) => entry.id === id).score).toBe(top);
    expect(reveal.entries.filter((entry) => entry.won).map((entry) => entry.id)).toEqual(reveal.champions);
    expect(reveal.draw).toBe(reveal.champions.length > 1);

    // Phones at the end: players get their stand receipt, predictors do not.
    expect(bots[0].socket.state.receipt).not.toBeNull();
    expect(ruth.socket.state).toMatchObject({ role: 'predictor', status: 'final' });
    expect(allKeys(ruth.socket.state).has('receipt')).toBe(false);
    expect(ruth.socket.state.standings).toHaveLength(40);

    // The CSV carries the same answers and points.
    const { csv } = await t.call(host, 'host:csv');
    const lines = csv.trim().split('\r\n');
    const rows = lines.slice(lines.indexOf('Predictions') + 6).map((line) => line.split(','));
    expect(rows.map((row) => [row[0], row[1], row[2], Number(row[11])])).toEqual([
      [ruth.name, 'predictor', '61.11', reveal.entries[0].score],
      [silas.name, 'predictor', '62.22', reveal.entries[1].score],
      ['Host', 'host', '6.33', reveal.entries[2].score],
    ]);
    expect(rows[1][8]).toBe('no answer');
  }, 60_000);
});
