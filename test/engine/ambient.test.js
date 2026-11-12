import { describe, it, expect } from 'vitest';
import { createGame, currentRound, nextRound, change, revealSecrets, showStandings } from '../../game/engine.js';
import { ambientSequence, AMBIENT_LENGTH, AMBIENT_DELAY_MS, AMBIENT_MIN_MS, AMBIENT_MAX_MS } from '../../game/ambient.js';
import { playerView, screenView, hostView } from '../../game/views.js';
import { computeStandings } from '../../game/scoring.js';
import { toMoney, add, ZERO } from '../../game/frac.js';
import { started, submitAll, advanceTo, sellers, testRandom, T0 } from './helpers.js';
import { submit } from '../../game/engine.js';

const NOW = T0 + 1000;
const emojiOf = (game, id) => game.config.fruits.find((f) => f.id === id).emoji;

describe('round 2 ambience', () => {
  it('is a list of emojis and timing, and nothing else', () => {
    const game = started(40, { seed: 5 });
    advanceTo(game, 2);
    const round = currentRound(game);
    expect(round.ambient).toHaveLength(AMBIENT_LENGTH);

    for (const view of [playerView(game, game.players[0].id, NOW), screenView(game, NOW), hostView(game, NOW)]) {
      expect(view.ambient).toHaveLength(AMBIENT_LENGTH);
      for (const item of view.ambient) {
        expect(Object.keys(item).sort()).toEqual(['delay', 'duration', 'emoji']);
        expect(typeof item.emoji).toBe('string');
        expect(Number.isInteger(item.delay)).toBe(true);
        expect(item.delay).toBeGreaterThanOrEqual(0);
        expect(item.delay).toBeLessThan(AMBIENT_DELAY_MS);
        expect(Number.isInteger(item.duration)).toBe(true);
        expect(item.duration).toBeGreaterThanOrEqual(AMBIENT_MIN_MS);
        expect(item.duration).toBeLessThanOrEqual(AMBIENT_MAX_MS);
      }
      // No ids, names or flags anywhere in it.
      const text = JSON.stringify(view.ambient);
      for (const fruit of game.config.fruits) expect(text).not.toContain(`"${fruit.id}"`);
      expect(text).not.toMatch(/secret|true|false/i);
    }
  });

  it('is the same sequence for every recipient', () => {
    const game = started(12, { seed: 2 });
    advanceTo(game, 2);
    const onScreen = screenView(game, NOW).ambient;
    for (const p of game.players) expect(playerView(game, p.id, NOW).ambient).toEqual(onScreen);
    expect(hostView(game, NOW).ambient).toEqual(onScreen);
  });

  it('uses only fruits that are in play', () => {
    const game = started(8, { seed: 7 });
    advanceTo(game, 2);
    const inPlay = game.activeFruits.map((id) => emojiOf(game, id));
    expect(inPlay).toHaveLength(4);
    const seen = new Set(currentRound(game).ambient.map((item) => item.emoji));
    for (const emoji of seen) expect(inPlay).toContain(emoji);
    expect(seen.size).toBe(4); // every fruit in play turns up
  });

  it('includes a fruit from outside the active set once somebody sells it', () => {
    const game = started(8, { seed: 7, config: { changeTargets: 'any' } });
    const outsider = game.config.fruits.map((f) => f.id).find((id) => !game.activeFruits.includes(id));
    expect(change(game, game.players[0].id, 1, outsider, NOW).ok).toBe(true);
    advanceTo(game, 2);
    const seen = new Set(currentRound(game).ambient.map((item) => item.emoji));
    expect(seen.has(emojiOf(game, outsider))).toBe(true);
    const allowed = [...game.activeFruits, outsider].map((id) => emojiOf(game, id));
    for (const emoji of seen) expect(allowed).toContain(emoji);
  });

  it('exists only while round 2 is being played', () => {
    const game = started(8);
    expect(currentRound(game).ambient).toBeNull();
    expect(screenView(game, NOW).ambient).toBeNull();
    advanceTo(game, 2);
    expect(screenView(game, NOW).ambient).not.toBeNull();
    submitAll(game);
    expect(screenView(game, NOW).ambient).toBeNull(); // fades out with the results
    nextRound(game, T0);
    expect(currentRound(game).ambient).toBeNull();
    expect(playerView(game, game.players[0].id, NOW).ambient).toBeNull();
  });

  it('matches the weights over many samples', () => {
    const game = createGame({ code: 'AMB', seed: 123 });
    const fruits = game.config.fruits.slice(0, 20).map((f) => f.id);
    const secret = fruits.slice(0, 5);
    const samples = 60_000;
    const counts = {};
    for (const item of ambientSequence(game, fruits, secret, game.config, samples)) {
      counts[item.emoji] = (counts[item.emoji] || 0) + 1;
    }
    // 5 secret fruits at weight 3 and 15 others at weight 1: 30 in all.
    const totalWeight = 5 * 3 + 15;
    for (const id of fruits) {
      const share = counts[emojiOf(game, id)] / samples;
      const expected = (secret.includes(id) ? 3 : 1) / totalWeight;
      expect(Math.abs(share - expected)).toBeLessThan(0.006);
    }
    const secretShare = secret.reduce((sum, id) => sum + counts[emojiOf(game, id)], 0) / samples;
    expect(secretShare).toBeCloseTo(0.5, 1);
  });

  it('follows ambientSecretWeight, and a weight of 1 removes the tell', () => {
    const fruits = ['apple', 'grape', 'melon', 'banana'];
    const shareOf = (weight) => {
      const game = createGame({ code: 'AMB', seed: 9, config: { ambientSecretWeight: weight } });
      const items = ambientSequence(game, fruits, ['apple'], game.config, 40_000);
      return items.filter((item) => item.emoji === '🍎').length / items.length;
    };
    expect(shareOf(1)).toBeCloseTo(1 / 4, 1);
    expect(shareOf(3)).toBeCloseTo(3 / 6, 1);
    expect(shareOf(9)).toBeCloseTo(9 / 12, 1);
  });

  it('in a real round the secret fruits drift past about 3 times as often', () => {
    // Pooled over many games, since one 240-item sequence is noisy.
    let secretSeen = 0;
    let plainSeen = 0;
    let secretFruits = 0;
    let plainFruits = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const game = started(40, { seed });
      advanceTo(game, 2);
      const round = currentRound(game);
      const hidden = new Set(round.secret.map((id) => emojiOf(game, id)));
      secretFruits += hidden.size;
      plainFruits += game.activeFruits.length - hidden.size;
      for (const item of round.ambient) {
        if (hidden.has(item.emoji)) secretSeen += 1;
        else plainSeen += 1;
      }
    }
    const ratio = (secretSeen / secretFruits) / (plainSeen / plainFruits);
    expect(ratio).toBeGreaterThan(2.7);
    expect(ratio).toBeLessThan(3.3);
  });

  it('is deterministic for a seed', () => {
    const make = (seed) => {
      const game = started(16, { seed });
      advanceTo(game, 2);
      return JSON.stringify(currentRound(game).ambient);
    };
    expect(make(4)).toBe(make(4));
    expect(make(4)).not.toBe(make(5));
  });
});

describe('receipt', () => {
  function finished(n, seed) {
    const game = started(n, { seed });
    const random = testRandom(seed);
    for (let r = 1; r <= 4; r++) {
      for (const p of [...game.players]) submit(game, p.id, r, 1 + Math.floor(random() * 5), NOW);
      if (r < 4) nextRound(game, T0);
    }
    return game;
  }

  it('is not sent before the final standings', () => {
    const game = finished(8, 3);
    const [p] = game.players;
    expect(playerView(game, p.id, NOW).receipt).toBeNull();
    revealSecrets(game);
    expect(playerView(game, p.id, NOW).receipt).toBeNull();
    showStandings(game);
    expect(playerView(game, p.id, NOW).receipt).not.toBeNull();
    expect(screenView(game, NOW).receipt).toBeUndefined();
    expect(hostView(game, NOW).receipt).toBeUndefined();
  });

  it("lists the player's own round earnings, each team's half, the total and the rank", () => {
    const game = finished(12, 6);
    revealSecrets(game);
    showStandings(game);
    const standings = computeStandings(game);

    for (const p of game.players) {
      const { receipt } = playerView(game, p.id, NOW);
      const row = standings.find((entry) => entry.id === p.id);

      expect(receipt.lines).toEqual(game.rounds.map((round) => ({ round: round.n, earned: toMoney(round.earnings[p.id]) })));
      expect(receipt.shares.map((team) => team.phase)).toEqual([1, 2]);
      for (const team of receipt.shares) {
        const pair = game.teams[team.phase].find((ids) => ids.includes(p.id));
        const mate = game.players.find((other) => other.id === pair.find((id) => id !== p.id));
        let sum = ZERO;
        for (const round of game.rounds.filter((entry) => entry.phase === team.phase)) {
          for (const id of pair) sum = add(sum, round.earnings[id]);
        }
        expect(team.partner).toBe(mate.name);
        expect(team.teamTotal).toBe(toMoney(sum));
        expect(team.half).toBe(toMoney(row.shares[team.phase]));
      }
      expect(receipt.total).toBe(row.totalText);
      expect(receipt.rank).toBe(row.rank);
      expect(receipt.of).toBe(12);
      expect(receipt.tied).toBe(standings.filter((entry) => entry.rank === row.rank).length > 1);
      // Nothing about anyone else's bids.
      expect(JSON.stringify(receipt)).not.toMatch(/selection|bid/i);
    }
  });

  it('marks tied ranks', () => {
    const game = started(4, { seed: 1 });
    for (let r = 1; r <= 4; r++) {
      submitAll(game, () => 5);
      if (r < 4) nextRound(game, T0);
    }
    revealSecrets(game);
    showStandings(game);
    // Everyone bid the same, so every fruit split evenly: a four-way tie.
    expect(Object.keys(sellers(game)).length).toBeGreaterThan(0);
    for (const p of game.players) {
      expect(playerView(game, p.id, NOW).receipt).toMatchObject({ rank: 1, tied: true, of: 4 });
    }
  });
});
