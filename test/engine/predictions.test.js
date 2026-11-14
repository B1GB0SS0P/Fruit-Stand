import { describe, it, expect } from 'vitest';
import {
  startGame, startCheck, makePredictor, makePlayer, removePlayer, addPlayer, claimSeat, reset,
  submit, select, change, hostSetBid, nextRound, revealSecrets, revealPredictions, showStandings,
  savePrediction, setHostPlaying, parseCents, predictionOf, findSeatByToken, isRevoked, currentRound, HOST_ID,
} from '../../game/engine.js';
import {
  medianTotal, medianPoints, winnerPoints, middleDistance, middlePoints, scorePredictions,
} from '../../game/predictions.js';
import { playerView, predictorView, screenView, hostView } from '../../game/views.js';
import { computeStandings } from '../../game/scoring.js';
import { exportSnapshot, importSnapshot } from '../../game/snapshot.js';
import { resultsCsv } from '../../game/csv.js';
import { frac, toMoney } from '../../game/frac.js';
import { lobby, submitAll, allKeys, testRandom, T0 } from './helpers.js';

const NOW = T0 + 1000;

// A lobby of `n` people where the last `predictors` of them are predictors.
function lobbyWith(n, predictors, options) {
  const game = lobby(n + predictors, options);
  for (const p of game.players.slice(n)) expect(makePredictor(game, p.id).ok).toBe(true);
  return game;
}

function startedWith(n, predictors, options) {
  const game = lobbyWith(n, predictors, options);
  expect(startGame(game, T0)).toEqual({ ok: true });
  return game;
}

function playToEnd(game, seed = 3) {
  const random = testRandom(seed);
  for (let r = game.round; r <= 4; r++) {
    for (const p of [...game.players]) {
      if (!currentRound(game).submitted[p.id]) submit(game, p.id, r, 1 + Math.floor(random() * 5), NOW);
    }
    expect(game.status).toBe('results');
    if (r < 4) expect(nextRound(game, T0).ok).toBe(true);
  }
}

// Standings rows with the given totals (in dollars), ranked like the game.
function standingsOf(totals) {
  const rows = totals.map((dollars, i) => ({
    id: `p${i + 1}`, name: `Player ${i + 1}`, avatar: '🐼', ring: '#e2552d', total: frac(Math.round(dollars * 100), 100),
  }));
  rows.sort((a, b) => b.total.n * a.total.d - a.total.n * b.total.d);
  rows.forEach((row, i) => {
    const prev = rows[i - 1];
    row.rank = prev && prev.total.n * row.total.d === row.total.n * prev.total.d ? prev.rank : i + 1;
    row.totalText = toMoney(row.total);
  });
  return rows;
}

// A state holding only what scoring reads: predictors and their answers.
function scoringState(predictions, names = Object.keys(predictions).filter((id) => id !== HOST_ID)) {
  return {
    predictors: names.map((id) => ({ id, name: id, avatar: '🦉', ring: '#2ba39b' })),
    predictions,
  };
}

describe('making predictors in the lobby', () => {
  it('turns a player into a predictor and back', () => {
    const game = lobby(6);
    const target = game.players[2];
    const before = { ...target };

    const made = makePredictor(game, target.id);
    expect(made.ok).toBe(true);
    expect(game.players).toHaveLength(5);
    expect(game.players.some((p) => p.id === target.id)).toBe(false);
    expect(game.predictors).toEqual([
      { id: before.id, token: before.token, rejoinCode: before.rejoinCode, name: before.name, avatar: before.avatar, ring: before.ring },
    ]);

    // Their seat still works: same token, and the name stays taken.
    expect(findSeatByToken(game, before.token).id).toBe(before.id);
    expect(addPlayer(game, { name: before.name.toUpperCase(), avatar: '🐶', token: 'other' }).error).toBe('name_taken');
    expect(claimSeat(game, before.rejoinCode, 'new-token').ok).toBe(true);
    expect(game.predictors[0].token).toBe('new-token');

    expect(makePlayer(game, target.id).ok).toBe(true);
    expect(game.predictors).toHaveLength(0);
    expect(game.players).toHaveLength(6);
    expect(game.players.find((p) => p.id === target.id)).toMatchObject({ name: before.name, fruit: null, tokens: 0 });
  });

  it('does not count predictors towards the even-count check or the player count', () => {
    const game = lobby(7);
    expect(startCheck(game)).toMatchObject({ canStart: false, error: 'odd_count' });
    expect(makePredictor(game, game.players[6].id).ok).toBe(true);
    expect(startCheck(game)).toMatchObject({ canStart: true, hint: '6 players: ready to start' });
    expect(hostView(game, T0).playerCount).toBe(6);
    expect(screenView(game, T0)).toMatchObject({ playerCount: 6, predictorCount: 1 });

    // 4 players and 1 predictor is enough; 3 players and 2 predictors is not.
    const small = lobbyWith(4, 1);
    expect(startCheck(small).canStart).toBe(true);
    expect(startCheck(lobbyWith(3, 2))).toMatchObject({ canStart: false, error: 'too_few' });
  });

  it('allows at most maxPredictors (3 by default)', () => {
    const game = lobby(10);
    for (const p of game.players.slice(0, 3)) expect(makePredictor(game, p.id).ok).toBe(true);
    const fourth = makePredictor(game, game.players[0].id);
    expect(fourth.error).toBe('too_many_predictors');
    expect(game.predictors).toHaveLength(3);
    expect(game.players).toHaveLength(7);

    const one = lobby(6, { config: { maxPredictors: 1 } });
    expect(makePredictor(one, one.players[0].id).ok).toBe(true);
    expect(makePredictor(one, one.players[0].id).error).toBe('too_many_predictors');
    const none = lobby(6, { config: { maxPredictors: 0 } });
    expect(makePredictor(none, none.players[0].id).error).toBe('too_many_predictors');
  });

  it('only works in the lobby, and only on real seats', () => {
    const game = lobbyWith(4, 1);
    expect(makePredictor(game, 'nobody').error).toBe('unknown_player');
    expect(makePlayer(game, game.players[0].id).error).toBe('unknown_player');
    startGame(game, T0);
    expect(makePredictor(game, game.players[0].id).error).toBe('in_progress');
    expect(makePlayer(game, game.predictors[0].id).error).toBe('in_progress');
  });

  it('lets the host remove a predictor, which revokes their token', () => {
    const game = lobbyWith(4, 2);
    const [gone] = game.predictors;
    expect(removePlayer(game, gone.id).ok).toBe(true);
    expect(game.predictors).toHaveLength(1);
    expect(isRevoked(game, gone.token)).toBe(true);
  });

  it('keeps predictors through a reset that keeps players, and wipes them otherwise', () => {
    const game = startedWith(4, 2);
    savePrediction(game, HOST_ID, { median: '5' });
    reset(game, { keepPlayers: true });
    expect(game.predictors).toHaveLength(2);
    expect(game.predictions).toEqual({});
    expect(game.predictionsLocked).toBe(false);
    reset(game, { keepPlayers: false });
    expect(game.predictors).toHaveLength(0);
  });
});

describe('a predictor is not a player', () => {
  it('gets no fruit, no team and no Change token', () => {
    const game = startedWith(8, 2);
    expect(game.players).toHaveLength(8);
    expect(game.players.every((p) => p.fruit && p.tokens === 1)).toBe(true);
    for (const predictor of game.predictors) {
      expect(predictor).not.toHaveProperty('fruit');
      expect(predictor).not.toHaveProperty('tokens');
      expect(game.teams[1].flat()).not.toContain(predictor.id);
      expect(playerView(game, predictor.id, T0)).toBeNull();
    }
    expect(game.teams[1]).toHaveLength(4);
    expect(game.activeFruits).toHaveLength(4);
  });

  it("can't bid, select, Change or be given a bid by the host", () => {
    const game = startedWith(4, 1);
    const [predictor] = game.predictors;
    const target = game.activeFruits[0];
    expect(select(game, predictor.id, 1, 3, NOW).error).toBe('is_predictor');
    expect(submit(game, predictor.id, 1, 3, NOW).error).toBe('is_predictor');
    expect(change(game, predictor.id, 1, target, NOW).error).toBe('is_predictor');
    expect(hostSetBid(game, predictor.id, 1, 3, NOW).error).toBe('is_predictor');
    expect(currentRound(game).selections).toEqual({});
    expect(game.announcements).toHaveLength(0);

    // The round resolves on the players alone, and nothing is scored for the predictor.
    submitAll(game);
    expect(Object.keys(currentRound(game).earnings).sort()).toEqual(game.players.map((p) => p.id).sort());
    playToEnd(game);
    revealSecrets(game);
    showStandings(game);
    expect(computeStandings(game).map((row) => row.id)).not.toContain(predictor.id);
  });

  it('sees the public game: teams, announcements, results, timer and bids in', () => {
    const game = startedWith(8, 1);
    const [predictor] = game.predictors;
    const mover = game.players[0];
    change(game, mover.id, 1, game.activeFruits.find((f) => f !== mover.fruit), NOW);
    submit(game, game.players[1].id, 1, 4, NOW);

    const view = predictorView(game, predictor.id, NOW);
    expect(view).toMatchObject({ role: 'predictor', status: 'bidding', round: 1, bidsIn: 1, playerCount: 8 });
    expect(view.timer.remainingMs).toBe(299_000);
    expect(view.announcements).toHaveLength(1);
    expect(view.pairs).toEqual(game.teams[1]);
    expect(view.players.map((p) => p.id)).toEqual(game.players.map((p) => p.id));
    expect(Object.keys(view.players[0]).sort()).toEqual(['avatar', 'id', 'name', 'ring']);
    expect(view.me).toEqual({ id: predictor.id, name: predictor.name, avatar: predictor.avatar, ring: predictor.ring });

    // No bids, earnings, totals, fruits per player or secret list.
    const keys = allKeys(view);
    for (const key of ['selections', 'selection', 'earnings', 'token', 'rejoinCode', 'fruitOf', 'bidType', 'rounds', 'receipt', 'changeTargets']) {
      expect(keys.has(key), key).toBe(false);
    }
    expect(view.standings).toBeNull();
    expect(view.predictionReveal).toBeNull();

    submitAll(game);
    nextRound(game, T0);
    const round2 = predictorView(game, predictor.id, NOW);
    expect(round2.curtained).toBe(true);
    expect(round2.results).toHaveLength(1);
    for (const key of allKeys(round2)) expect(key).not.toMatch(/secret/i);
  });
});

describe('making predictions', () => {
  it('reads dollar amounts to 2 decimal places', () => {
    expect(parseCents('14.50')).toBe(1450);
    expect(parseCents('$14.5')).toBe(1450);
    expect(parseCents(' 7 ')).toBe(700);
    expect(parseCents(0)).toBe(0);
    expect(parseCents(12.25)).toBe(1225);
    for (const bad of ['', 'abc', '-3', '1.234', '1,50', '1e3', null, undefined, {}, '99999999']) {
      expect(parseCents(bad), String(bad)).toBeNull();
    }
  });

  it('opens when the game starts and can be edited until the lock round starts', () => {
    const game = lobbyWith(6, 1);
    const [predictor] = game.predictors;
    const [a, b, c] = game.players;
    expect(savePrediction(game, predictor.id, { median: '10' }).error).toBe('not_started');
    startGame(game, T0);

    expect(savePrediction(game, predictor.id, { median: '10', winner: a.id, middle: b.id }).ok).toBe(true);
    expect(predictionOf(game, predictor.id)).toEqual({ medianCents: 1000, winner: a.id, middle: b.id });
    // Edit, including clearing an answer.
    expect(savePrediction(game, predictor.id, { median: '12.75', winner: c.id, middle: null }).ok).toBe(true);
    expect(predictionOf(game, predictor.id)).toEqual({ medianCents: 1275, winner: c.id, middle: null });
    expect(predictorView(game, predictor.id, NOW).prediction).toEqual({ median: '12.75', winner: c.id, middle: null });

    // Still open through round 2 and its results.
    submitAll(game);
    nextRound(game, T0);
    expect(game.predictionsLocked).toBe(false);
    expect(savePrediction(game, predictor.id, { median: '11', winner: c.id, middle: a.id }).ok).toBe(true);
    submitAll(game);
    expect(savePrediction(game, HOST_ID, { median: '9.5', winner: b.id, middle: a.id }).ok).toBe(true);

    // The host starts round 3: locked for everyone, host included.
    nextRound(game, T0);
    expect(game.round).toBe(3);
    expect(game.predictionsLocked).toBe(true);
    expect(savePrediction(game, predictor.id, { median: '1', winner: a.id, middle: a.id }).error).toBe('predictions_locked');
    expect(savePrediction(game, HOST_ID, { median: '1' }).error).toBe('predictions_locked');
    expect(predictionOf(game, predictor.id)).toEqual({ medianCents: 1100, winner: c.id, middle: a.id });
    expect(predictionOf(game, HOST_ID)).toEqual({ medianCents: 950, winner: b.id, middle: a.id });
    expect(predictorView(game, predictor.id, NOW).predicting).toEqual({ locked: true, lockRound: 3 });
  });

  it('follows predictionLockRound from config', () => {
    const game = startedWith(4, 1, { config: { predictionLockRound: 2 } });
    expect(savePrediction(game, HOST_ID, { median: '3' }).ok).toBe(true);
    submitAll(game);
    nextRound(game, T0);
    expect(savePrediction(game, HOST_ID, { median: '4' }).error).toBe('predictions_locked');
  });

  it('rejects answers that make no sense and keeps the old ones', () => {
    const game = startedWith(4, 1);
    const [predictor] = game.predictors;
    const [a] = game.players;
    savePrediction(game, predictor.id, { median: '8', winner: a.id, middle: a.id });
    expect(savePrediction(game, predictor.id, { median: 'lots', winner: a.id }).error).toBe('bad_median');
    expect(savePrediction(game, predictor.id, { median: '-1' }).error).toBe('bad_median');
    expect(savePrediction(game, predictor.id, { median: '8', winner: 'p999' }).error).toBe('bad_pick');
    expect(savePrediction(game, predictor.id, { median: '8', middle: predictor.id }).error).toBe('bad_pick');
    expect(savePrediction(game, a.id, { median: '8' }).error).toBe('not_predictor');
    expect(savePrediction(game, 'nobody', { median: '8' }).error).toBe('not_predictor');
    expect(predictionOf(game, predictor.id)).toEqual({ medianCents: 800, winner: a.id, middle: a.id });
  });

  it('shows the host who has submitted all three, by name only', () => {
    const game = startedWith(6, 2);
    const [ruth, silas] = game.predictors;
    const [a, b] = game.players;
    savePrediction(game, ruth.id, { median: '7.77', winner: a.id, middle: b.id });
    savePrediction(game, silas.id, { median: '8.88', winner: b.id });
    const view = hostView(game, NOW);
    expect(view.predictionStatus).toEqual([
      { id: ruth.id, name: ruth.name, done: true },
      { id: silas.id, name: silas.name, done: false },
      { id: HOST_ID, name: 'You (host)', done: false },
    ]);
    expect(view.prediction).toEqual({ median: null, winner: null, middle: null });
    expect(JSON.stringify(view)).not.toMatch(/7\.77|8\.88/);
  });

  it("records the host's 'I'm also playing' flag", () => {
    const game = startedWith(4, 0);
    expect(hostView(game, NOW).hostPlaying).toBe(false);
    setHostPlaying(game, true);
    expect(hostView(game, NOW).hostPlaying).toBe(true);
    expect(allKeys(screenView(game, NOW)).has('hostPlaying')).toBe(false);
  });
});

describe('prediction privacy', () => {
  it('sends a prediction to nobody but its owner before the reveal', () => {
    const game = startedWith(8, 2);
    const [ruth, silas] = game.predictors;
    const [a, b, c, d] = game.players;
    savePrediction(game, ruth.id, { median: '71.11', winner: a.id, middle: b.id });
    savePrediction(game, silas.id, { median: '72.22', winner: c.id, middle: d.id });
    savePrediction(game, HOST_ID, { median: '73.33', winner: d.id, middle: a.id });

    const check = () => {
      const ruthView = predictorView(game, ruth.id, NOW);
      const silasView = predictorView(game, silas.id, NOW);
      const host = hostView(game, NOW);
      expect(ruthView.prediction).toEqual({ median: '71.11', winner: a.id, middle: b.id });
      expect(silasView.prediction).toEqual({ median: '72.22', winner: c.id, middle: d.id });
      expect(host.prediction).toEqual({ median: '73.33', winner: d.id, middle: a.id });

      const leaks = (view, amounts) => amounts.some((amount) => JSON.stringify(view).includes(amount));
      expect(leaks(ruthView, ['72.22', '73.33'])).toBe(false);
      expect(leaks(silasView, ['71.11', '73.33'])).toBe(false);
      expect(leaks(host, ['71.11', '72.22'])).toBe(false);

      const others = [screenView(game, NOW), ...game.players.map((p) => playerView(game, p.id, NOW))];
      for (const view of others) {
        const keys = allKeys(view);
        expect(keys.has('prediction')).toBe(false);
        expect(keys.has('predictions')).toBe(false);
        expect(keys.has('predictionStatus')).toBe(false);
        expect(view.predictionReveal).toBeNull();
        expect(view.predicting).toEqual({ locked: game.predictionsLocked, lockRound: 3 });
        expect(leaks(view, ['71.11', '72.22', '73.33'])).toBe(false);
      }
      for (const view of [ruthView, silasView, host]) expect(view.predictionReveal).toBeNull();
    };

    check();
    playToEnd(game);
    check();
    revealSecrets(game);
    check(); // the secret reveal comes first; predictions are still private

    expect(revealPredictions(game).ok).toBe(true);
    for (const view of [screenView(game, NOW), hostView(game, NOW), predictorView(game, ruth.id, NOW), playerView(game, a.id, NOW)]) {
      expect(view.predictionReveal.entries.map((entry) => entry.median.guess)).toEqual(['71.11', '72.22', '73.33']);
      expect(view.standings).toBeNull(); // the podium comes after
    }
  });

  it('runs the reveal after the secret stands and before the standings', () => {
    const game = startedWith(4, 1);
    playToEnd(game);
    expect(revealPredictions(game).error).toBe('not_revealed');
    revealSecrets(game);
    expect(game.predictionsLocked).toBe(true);
    expect(revealPredictions(game).ok).toBe(true);
    expect(game.status).toBe('predictions');
    expect(revealPredictions(game).error).toBe('not_revealed');
    expect(showStandings(game).ok).toBe(true);
    expect(game.status).toBe('final');
    expect(screenView(game, NOW).predictionReveal).not.toBeNull();
  });
});

describe('prediction scoring', () => {
  it('takes the median as the average of the two middle totals', () => {
    // 6 players: positions 3 and 4 are $9 and $6.
    expect(toMoney(medianTotal(standingsOf([20, 12, 9, 6, 2, 1])))).toBe('7.50');
    // The outliers at either end do not matter.
    expect(toMoney(medianTotal(standingsOf([900, 12, 9, 6, 2, 0])))).toBe('7.50');
    expect(toMoney(medianTotal(standingsOf([5, 5, 5, 5])))).toBe('5.00');
    expect(toMoney(medianTotal(standingsOf([10, 8, 7.5, 7, 6.5, 6, 3, 1])))).toBe('6.75');
    const reveal = scorePredictions(scoringState({}), standingsOf([20, 12, 9, 6, 2, 1]));
    expect(reveal.actual.median).toBe('7.50');
    expect(reveal.actual.middlePositions).toEqual([3, 4]);
  });

  it('scores the median guess: 5 minus the rounded distance in dollars', () => {
    const actual = 1450;
    expect(medianPoints(1450, actual)).toBe(5);
    expect(medianPoints(1300, actual)).toBe(3); // $1.50 off rounds to 2
    expect(medianPoints(1499, actual)).toBe(5); // $0.49 rounds to 0
    expect(medianPoints(1500, actual)).toBe(4); // $0.50 rounds up to 1
    expect(medianPoints(1400, actual)).toBe(4);
    expect(medianPoints(1301, actual)).toBe(4); // $1.49 rounds to 1
    expect(medianPoints(1899, actual)).toBe(1); // $4.49 rounds to 4
    expect(medianPoints(1900, actual)).toBe(0); // $4.50 rounds up to 5
    expect(medianPoints(9999, actual)).toBe(0);
    expect(medianPoints(0, actual)).toBe(0);
    expect(medianPoints(null, actual)).toBe(0);
  });

  it('scores the winner pick by final rank', () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(winnerPoints)).toEqual([5, 4, 3, 2, 1, 0, 0]);
    expect(winnerPoints(null)).toBe(0);
  });

  it('counts everyone tied for 1st as rank 1', () => {
    // p1 and p2 tie for 1st, so p3 is 3rd.
    const standings = standingsOf([15, 15, 11, 9, 8, 7, 3, 1]);
    const state = scoringState({
      a: { medianCents: null, winner: 'p1', middle: null },
      b: { medianCents: null, winner: 'p2', middle: null },
      c: { medianCents: null, winner: 'p3', middle: null },
      d: { medianCents: null, winner: 'p7', middle: null },
    });
    const reveal = scorePredictions(state, standings);
    expect(reveal.actual.first.map((p) => p.id)).toEqual(['p1', 'p2']);
    const points = Object.fromEntries(reveal.entries.map((entry) => [entry.id, entry.winner.points]));
    expect(points).toMatchObject({ a: 5, b: 5, c: 3, d: 0, [HOST_ID]: 0 });
    expect(reveal.entries[0].winner.pick).toMatchObject({ id: 'p1', rank: 1, tied: true });
    expect(reveal.entries[2].winner.pick).toMatchObject({ id: 'p3', rank: 3, tied: false });
  });

  it('scores the middle pick: exact on either middle rank, then one point per position away', () => {
    // 20 players, no ties: the middle ranks are 10 and 11.
    const n = 20;
    expect(middleDistance(10, 1, n)).toBe(0);
    expect(middleDistance(11, 1, n)).toBe(0);
    expect(middleDistance(9, 1, n)).toBe(1);
    expect(middleDistance(12, 1, n)).toBe(1);
    expect(middleDistance(8, 1, n)).toBe(2);
    expect(middleDistance(13, 1, n)).toBe(2);
    expect(middleDistance(4, 1, n)).toBe(6);
    expect(middleDistance(17, 1, n)).toBe(6);
    expect(middleDistance(1, 1, n)).toBe(9);
    expect([0, 1, 2, 3, 4, 5, 6, 9].map(middlePoints)).toEqual([5, 4, 3, 2, 1, 0, 0, 0]);
    expect(middlePoints(null)).toBe(0);

    const totals = Array.from({ length: n }, (_, i) => 40 - i); // p1 is 1st ... p20 is 20th
    const pick = (id) => ({ medianCents: null, winner: null, middle: id });
    const reveal = scorePredictions(scoringState({
      exactUpper: pick('p10'), exactLower: pick('p11'), off1: pick('p12'), off2: pick('p8'), off6: pick('p17'), top: pick('p1'),
    }), standingsOf(totals));
    const got = Object.fromEntries(reveal.entries.map((entry) => [entry.id, [entry.middle.away, entry.middle.points]]));
    expect(got).toMatchObject({ exactUpper: [0, 5], exactLower: [0, 5], off1: [1, 4], off2: [2, 3], off6: [6, 0], top: [9, 0] });
    expect(reveal.actual.middle.map((p) => p.id)).toEqual(['p10', 'p11']);
    expect(got[HOST_ID]).toEqual([null, 0]);
  });

  it('treats a tied group as filling its positions when scoring the middle pick', () => {
    // 8 players, middle positions 4 and 5.
    // Three tied at rank 3 fill positions 3, 4 and 5: all of them are middle.
    expect(middleDistance(3, 3, 8)).toBe(0);
    // Two tied at rank 5 fill 5 and 6.
    expect(middleDistance(5, 2, 8)).toBe(0);
    // Two tied at rank 2 fill 2 and 3: one away from position 4.
    expect(middleDistance(2, 2, 8)).toBe(1);
    // Two tied at rank 6 fill 6 and 7: one away from position 5.
    expect(middleDistance(6, 2, 8)).toBe(1);
    // Everyone tied: everyone is in the middle.
    expect(middleDistance(1, 8, 8)).toBe(0);

    const standings = standingsOf([20, 15, 9, 9, 9, 4, 4, 1]);
    const reveal = scorePredictions(scoringState({
      a: { medianCents: null, winner: null, middle: 'p3' },
      b: { medianCents: null, winner: null, middle: 'p2' },
      c: { medianCents: null, winner: null, middle: 'p7' },
    }), standings);
    expect(reveal.actual.middle.map((p) => p.id)).toEqual(['p3', 'p4', 'p5']);
    expect(reveal.entries.map((entry) => entry.middle.points)).toEqual([5, 3, 4, 0]);
  });

  it('gives 0 for every missing answer', () => {
    const standings = standingsOf([12, 10, 8, 6, 4, 2]);
    const reveal = scorePredictions(scoringState({
      full: { medianCents: 700, winner: 'p1', middle: 'p3' },
      partial: { medianCents: 700, winner: null, middle: null },
      nothing: { medianCents: null, winner: null, middle: null },
    }, ['full', 'partial', 'nothing', 'never']), standings);
    const byId = Object.fromEntries(reveal.entries.map((entry) => [entry.id, entry]));
    expect(byId.full.score).toBe(15);
    expect(byId.partial).toMatchObject({ score: 5, winner: { pick: null, points: 0 }, middle: { pick: null, away: null, points: 0 } });
    expect(byId.nothing).toMatchObject({ score: 0, median: { guess: null, off: null, points: 0 } });
    expect(byId.never.score).toBe(0); // never opened the form
    expect(byId[HOST_ID].score).toBe(0);
    expect(reveal.maxScore).toBe(15);
  });

  it('gives the win to the highest total', () => {
    const standings = standingsOf([12, 10, 8, 6, 4, 2]);
    const reveal = scorePredictions(scoringState({
      a: { medianCents: 700, winner: 'p2', middle: 'p3' }, // 5 + 4 + 5
      b: { medianCents: 700, winner: 'p1', middle: 'p3' }, // 15
      [HOST_ID]: { medianCents: 900, winner: 'p1', middle: 'p1' }, // 3 + 5 + 3
    }), standings);
    expect(reveal.entries.map((entry) => [entry.id, entry.score, entry.place, entry.won])).toEqual([
      ['a', 14, 2, false], ['b', 15, 1, true], [HOST_ID, 11, 3, false],
    ]);
    expect(reveal).toMatchObject({ champions: ['b'], draw: false, tieBroken: false });
    expect(reveal.entries[2]).toMatchObject({ isHost: true, name: 'Host' });
  });

  it('breaks a tie on points by who was closer on the median, else calls a draw', () => {
    const standings = standingsOf([12, 10, 8, 6, 4, 2]); // median $7.00
    // Both score 9: a is $1.00 off (4 + 5), b is $0.40 off (5 + 4).
    const broken = scorePredictions(scoringState({
      a: { medianCents: 800, winner: 'p1', middle: null },
      b: { medianCents: 740, winner: 'p2', middle: null },
    }), standings);
    expect(broken.entries.map((entry) => entry.score)).toEqual([9, 9, 0]);
    expect(broken).toMatchObject({ champions: ['b'], draw: false, tieBroken: true });
    expect(broken.entries.map((entry) => entry.place)).toEqual([2, 1, 3]);

    // Same points and same distance (one above, one below): a draw.
    const drawn = scorePredictions(scoringState({
      a: { medianCents: 760, winner: 'p1', middle: null },
      b: { medianCents: 640, winner: 'p1', middle: null },
    }), standings);
    expect(drawn).toMatchObject({ champions: ['a', 'b'], draw: true, tieBroken: false });
    expect(drawn.entries.map((entry) => [entry.won, entry.place])).toEqual([[true, 1], [true, 1], [false, 3]]);

    // No median guess counts as furthest away.
    const missing = scorePredictions(scoringState({
      a: { medianCents: null, winner: 'p1', middle: 'p3' }, // 10
      b: { medianCents: 1150, winner: 'p1', middle: 'p4' }, // 0 + 5 + 5
    }), standings);
    expect(missing).toMatchObject({ champions: ['b'], tieBroken: true });

    // Nobody answered anything: everyone draws on 0.
    expect(scorePredictions(scoringState({}, ['a', 'b']), standings)).toMatchObject({ champions: ['a', 'b', HOST_ID], draw: true });
  });

  it('scores a real finished game from its own standings', () => {
    const game = startedWith(12, 2);
    const [ruth, silas] = game.predictors;
    const ids = game.players.map((p) => p.id);
    savePrediction(game, ruth.id, { median: '6', winner: ids[0], middle: ids[1] });
    savePrediction(game, silas.id, { median: '9.5', winner: ids[2] });
    playToEnd(game);
    revealSecrets(game);
    revealPredictions(game);

    const standings = computeStandings(game);
    const reveal = screenView(game, NOW).predictionReveal;
    const expectedMedian = (Number(standings[5].totalText) + Number(standings[6].totalText)) / 2;
    expect(Math.abs(Number(reveal.actual.median) - expectedMedian)).toBeLessThan(0.006);
    expect(reveal.playerCount).toBe(12);
    expect(reveal.actual.first.map((p) => p.id)).toEqual(standings.filter((row) => row.rank === 1).map((row) => row.id));

    const [first, second, host] = reveal.entries;
    const rankOf = (id) => standings.find((row) => row.id === id).rank;
    expect(first.winner).toEqual({
      pick: expect.objectContaining({ id: ids[0], rank: rankOf(ids[0]) }),
      points: Math.max(0, 6 - rankOf(ids[0])),
    });
    expect(first.median.points).toBe(medianPoints(600, Math.round(Number(reveal.actual.median) * 100)));
    expect(second.middle).toEqual({ pick: null, away: null, points: 0 });
    expect(host).toMatchObject({ id: HOST_ID, score: 0 });
    for (const entry of reveal.entries) {
      expect(entry.score).toBe(entry.median.points + entry.winner.points + entry.middle.points);
    }
  });
});

describe('predictions in the CSV and in snapshots', () => {
  it("adds everyone's answers, the actual values and the points to the CSV", () => {
    const game = startedWith(8, 2);
    const [ruth, silas] = game.predictors;
    const [a, b] = game.players;
    savePrediction(game, ruth.id, { median: '6.5', winner: a.id, middle: b.id });
    savePrediction(game, HOST_ID, { median: '4', winner: b.id });
    playToEnd(game);
    revealSecrets(game);
    revealPredictions(game);
    showStandings(game);

    const reveal = scorePredictions(game);
    const lines = resultsCsv(game).trim().split('\r\n');
    const start = lines.indexOf('Predictions');
    expect(start).toBeGreaterThan(lines.indexOf('Final standings'));
    expect(lines[start + 1]).toBe(`Actual median total,${reveal.actual.median}`);
    expect(lines[start + 2].startsWith('Actual winner,')).toBe(true);
    expect(lines[start + 3]).toBe('Middle positions,4 and 5');
    expect(lines[start + 5].split(',')).toEqual([
      'Predictor', 'Role', 'Median guess', 'Actual median', 'Median points',
      'Winner pick', 'Winner pick rank', 'Winner points',
      'Middle pick', 'Middle pick rank', 'Middle points', 'Total points', 'Result',
    ]);
    const rows = lines.slice(start + 6).map((row) => row.split(','));
    expect(rows).toHaveLength(3);
    const [ruthRow, silasRow, hostRow] = rows;
    const ruthEntry = reveal.entries[0];
    expect(ruthRow.slice(0, 6)).toEqual([ruth.name, 'predictor', '6.50', reveal.actual.median, String(ruthEntry.median.points), a.name]);
    expect(ruthRow[7]).toBe(String(ruthEntry.winner.points));
    expect(ruthRow[8]).toBe(b.name);
    expect(ruthRow[11]).toBe(String(ruthEntry.score));
    expect(silasRow.slice(0, 3)).toEqual([silas.name, 'predictor', 'no answer']);
    expect(silasRow[11]).toBe('0');
    expect(hostRow.slice(0, 3)).toEqual(['Host', 'host', '4.00']);
    expect(hostRow[8]).toBe('no answer');
    expect(rows.filter((row) => row[12] !== '').length).toBeGreaterThanOrEqual(1);
  });

  it('round-trips a snapshot taken mid-game after the predictions lock', () => {
    const original = startedWith(12, 2, { seed: 8 });
    const [ruth, silas] = original.predictors;
    const [a, b, c] = original.players;
    savePrediction(original, ruth.id, { median: '6.5', winner: a.id, middle: b.id });
    savePrediction(original, silas.id, { median: '11', winner: c.id });
    savePrediction(original, HOST_ID, { median: '4.25', winner: b.id, middle: c.id });
    setHostPlaying(original, true);
    submitAll(original);
    nextRound(original, T0);
    submitAll(original);
    nextRound(original, T0);
    submit(original, a.id, 3, 2, T0 + 5000);
    expect(original.round).toBe(3);
    expect(original.predictionsLocked).toBe(true);

    const file = JSON.parse(JSON.stringify(exportSnapshot(original, T0 + 60_000)));
    const restored = importSnapshot(file);

    expect(restored.predictors).toEqual(original.predictors);
    expect(restored.predictions).toEqual(original.predictions);
    expect(restored.predictionsLocked).toBe(true);
    expect(restored.hostPlaying).toBe(true);
    expect(restored.players).toEqual(original.players);

    // Still locked, still private, and each person still sees their own.
    expect(savePrediction(restored, ruth.id, { median: '1' }).error).toBe('predictions_locked');
    expect(predictorView(restored, ruth.id, NOW).prediction).toEqual({ median: '6.50', winner: a.id, middle: b.id });
    expect(predictorView(restored, silas.id, NOW).prediction).toEqual({ median: '11.00', winner: c.id, middle: null });
    expect(hostView(restored, NOW).prediction).toEqual({ median: '4.25', winner: b.id, middle: c.id });
    expect(hostView(restored, NOW).predictionStatus.map((p) => p.done)).toEqual([true, false, true]);
    expect(submit(restored, ruth.id, 3, 2, NOW).error).toBe('is_predictor');

    // Both play on with the same choices and reach the same reveal.
    for (const game of [original, restored]) {
      playToEnd(game, 11);
      revealSecrets(game);
      revealPredictions(game);
    }
    expect(scorePredictions(restored)).toEqual(scorePredictions(original));
    showStandings(original);
    showStandings(restored);
    expect(resultsCsv(restored)).toBe(resultsCsv(original));
  });

  it('loads a snapshot saved before predictors existed', () => {
    const game = startedWith(6, 0);
    submitAll(game);
    nextRound(game, T0);
    submitAll(game);
    nextRound(game, T0);
    const file = JSON.parse(JSON.stringify(exportSnapshot(game, NOW)));
    for (const key of ['predictors', 'predictions', 'predictionsLocked', 'hostPlaying']) delete file.state[key];
    delete file.state.config.minSellersPerFruit;
    delete file.state.config.sellersDivisor;
    delete file.state.config.maxPredictors;
    delete file.state.config.predictionLockRound;
    file.state.config.sellersPerFruit = 2;

    const restored = importSnapshot(file);
    expect(restored).toMatchObject({ predictors: [], predictions: {}, predictionsLocked: true, hostPlaying: false });
    expect(restored.config).toMatchObject({ minSellersPerFruit: 2, sellersDivisor: 10, maxPredictors: 3, predictionLockRound: 3 });
    expect(restored.config).not.toHaveProperty('sellersPerFruit');
    expect(hostView(restored, NOW).predictors).toEqual([]);
  });
});
