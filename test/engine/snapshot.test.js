import { describe, it, expect } from 'vitest';
import {
  select, submit, change, expire, nextRound, revealSecrets, showStandings,
  timeLeft, deadline, pauseTimer, resumeTimer, currentRound,
} from '../../game/engine.js';
import { exportSnapshot, importSnapshot } from '../../game/snapshot.js';
import { playerView, screenView, hostView } from '../../game/views.js';
import { computeStandings } from '../../game/scoring.js';
import { resultsCsv } from '../../game/csv.js';
import { started, lobby, advanceTo, testRandom, T0 } from './helpers.js';

// Plays from mid-round 2 to the end with fixed choices.
function finish(game, clock) {
  const random = testRandom(42);
  for (let r = game.round; r <= 4; r++) {
    for (const p of [...game.players]) {
      if (currentRound(game).submitted[p.id]) continue;
      if (random() < 0.2 && p.tokens > 0) {
        change(game, p.id, r, game.activeFruits[Math.floor(random() * game.activeFruits.length)], clock);
      }
      submit(game, p.id, r, 1 + Math.floor(random() * 5), clock);
    }
    expect(game.status).toBe('results');
    if (r < 4) nextRound(game, clock);
  }
  revealSecrets(game);
  showStandings(game);
}

describe('snapshots', () => {
  function midRoundTwo() {
    const game = started(12, { seed: 8 });
    const [a, b, c] = game.players;
    change(game, a.id, 1, game.activeFruits.find((f) => f !== a.fruit), T0 + 500);
    advanceTo(game, 2, (p) => (p.id === b.id ? 2 : 5));
    // Round 2 opened at T0. Some activity, then export 100 s in.
    select(game, a.id, 2, 3, T0 + 10_000);
    submit(game, b.id, 2, 4, T0 + 20_000);
    select(game, c.id, 2, 1, T0 + 30_000);
    return game;
  }

  it('export mid-round 2, import, and the game carries on identically', () => {
    const original = midRoundTwo();
    const exportAt = T0 + 100_000;
    expect(currentRound(original).secret.length).toBeGreaterThan(0);
    expect(deadline(original)).not.toBeNull(); // timer running
    expect(timeLeft(original, exportAt)).toBe(200_000);

    // Through JSON, as it would be when downloaded and uploaded.
    const file = JSON.parse(JSON.stringify(exportSnapshot(original, exportAt)));
    expect(file.timerWasRunning).toBe(true);

    // Loaded much later, on a server with a different clock.
    const laterClock = 9_000_000_000;
    const restored = importSnapshot(file);

    // Same remaining time, paused until the host resumes.
    expect(timeLeft(restored, laterClock)).toBe(200_000);
    expect(deadline(restored)).toBeNull();
    expect(timeLeft(restored, laterClock + 60_000)).toBe(200_000);

    // Same game: secret fruits, selections, tokens, announcements, views.
    expect(currentRound(restored).secret).toEqual(currentRound(original).secret);
    expect(currentRound(restored).selections).toEqual(currentRound(original).selections);
    expect(restored.players).toEqual(original.players);
    expect(restored.announcements).toEqual(original.announcements);

    pauseTimer(original, exportAt);
    const strip = (view) => ({ ...view, timer: { ...view.timer, serverNow: 0 } });
    for (const p of original.players) {
      expect(strip(playerView(restored, p.id, laterClock))).toEqual(strip(playerView(original, p.id, exportAt)));
    }
    expect(strip(screenView(restored, laterClock))).toEqual(strip(screenView(original, exportAt)));
    expect(strip(hostView(restored, laterClock))).toEqual(strip(hostView(original, exportAt)));

    // Resume both and check the clocks agree.
    resumeTimer(original, exportAt);
    resumeTimer(restored, laterClock);
    expect(timeLeft(restored, laterClock + 50_000)).toBe(timeLeft(original, exportAt + 50_000));
    expect(deadline(restored)).toBe(laterClock + 200_000);

    // Play both to the end with the same choices: same teams, same results.
    finish(original, exportAt + 60_000);
    finish(restored, laterClock + 60_000);
    expect(restored.teams).toEqual(original.teams);
    expect(restored.rounds).toEqual(original.rounds);
    expect(computeStandings(restored)).toEqual(computeStandings(original));
    expect(resultsCsv(restored)).toBe(resultsCsv(original));
  });

  it('the restored timer still expires the round', () => {
    const game = midRoundTwo();
    const restored = importSnapshot(exportSnapshot(game, T0 + 100_000));
    const clock = 5_000_000;
    resumeTimer(restored, clock);
    expect(expire(restored, 2, clock + 199_999).error).toBe('not_expired');
    expect(expire(restored, 2, clock + 200_000).ok).toBe(true);
    const round = restored.rounds[1];
    expect(round.bidType[restored.players[0].id]).toBe('auto_selected');
    expect(round.bidType[restored.players[1].id]).toBe('submitted');
    expect(round.bidType[restored.players[5].id]).toBe('auto_max');
  });

  it('does not change the game it was exported from', () => {
    const game = midRoundTwo();
    const before = JSON.stringify(game);
    const snapshot = exportSnapshot(game, T0 + 100_000);
    snapshot.state.players[0].name = 'Changed';
    expect(JSON.stringify(game)).toBe(before);
  });

  it('works in the lobby and after the game ends', () => {
    const waiting = lobby(5);
    const restoredLobby = importSnapshot(exportSnapshot(waiting, T0));
    expect(restoredLobby.players).toEqual(waiting.players);
    expect(restoredLobby.status).toBe('lobby');

    const done = started(8);
    finish(done, T0 + 1000);
    const restoredDone = importSnapshot(JSON.parse(JSON.stringify(exportSnapshot(done, T0 + 2000))));
    expect(restoredDone.status).toBe('final');
    expect(resultsCsv(restoredDone)).toBe(resultsCsv(done));
  });

  it('rejects files that are not snapshots', () => {
    expect(() => importSnapshot(null)).toThrow(/not a Fruit Stand snapshot/);
    expect(() => importSnapshot({ hello: 'world' })).toThrow(/not a Fruit Stand snapshot/);
    const good = exportSnapshot(started(4), T0);
    expect(() => importSnapshot({ ...good, version: 99 })).toThrow(/not supported/);
    expect(() => importSnapshot({ ...good, state: { ...good.state, players: 'x' } })).toThrow(/damaged/);
    expect(() => importSnapshot({ ...good, state: { ...good.state, status: 'weird' } })).toThrow(/damaged/);
  });
});
