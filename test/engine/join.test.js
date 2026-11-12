import { describe, it, expect } from 'vitest';
import {
  createGame, addPlayer, removePlayer, setLocked, startGame, startCheck, claimSeat,
  findPlayerByToken, isRevoked, reset,
} from '../../game/engine.js';
import { playerView } from '../../game/views.js';
import { lobby, started, T0 } from './helpers.js';

const join = (game, name, extra = {}) =>
  addPlayer(game, { name, avatar: '🐶', token: `t-${name}-${Math.random()}`, ...extra });

describe('joining', () => {
  it('rejects names that are empty or longer than 20 characters', () => {
    const game = createGame({ code: 'A', seed: 1 });
    expect(join(game, '').error).toBe('bad_name');
    expect(join(game, '    ').error).toBe('bad_name');
    expect(join(game, 'x'.repeat(21)).error).toBe('bad_name');
    expect(join(game, undefined).error).toBe('bad_name');
    expect(join(game, 'x'.repeat(20)).ok).toBe(true);
    expect(join(game, ' Sam ').player.name).toBe('Sam');
  });

  it('rejects duplicate names in any letter case', () => {
    const game = createGame({ code: 'A', seed: 1 });
    expect(join(game, 'Ben').ok).toBe(true);
    expect(join(game, 'ben').error).toBe('name_taken');
    expect(join(game, ' BEN ').error).toBe('name_taken');
    expect(game.players).toHaveLength(1);
  });

  it('requires an avatar from the animal set', () => {
    const game = createGame({ code: 'A', seed: 1 });
    expect(addPlayer(game, { name: 'Ann', token: 't1' }).error).toBe('bad_avatar');
    expect(addPlayer(game, { name: 'Ann', avatar: '🍎', token: 't1' }).error).toBe('bad_avatar');
    expect(addPlayer(game, { name: 'Ann', avatar: '🐼', token: 't1' }).ok).toBe(true);
  });

  it('allows duplicate avatars', () => {
    const game = createGame({ code: 'A', seed: 1 });
    expect(join(game, 'A').ok).toBe(true);
    expect(join(game, 'B').ok).toBe(true);
  });

  it('gives 40 players who pick the same animal 40 different looks', () => {
    const game = createGame({ code: 'A', seed: 1 });
    for (let i = 0; i < 40; i++) expect(join(game, `Panda ${i}`, { avatar: '🐼' }).ok).toBe(true);
    const looks = game.players.map((p) => `${p.avatar} ${p.ring}`);
    expect(new Set(looks).size).toBe(40);
    for (const p of game.players) expect(p.ring).toMatch(/^#[0-9a-f]{6}$/);
    // The first players get the colours from the config list, in order.
    const listed = game.config.avatarRingColors;
    expect(game.players.slice(0, listed.length).map((p) => p.ring)).toEqual(listed);
  });

  it('assigns the first free colour for each animal, and frees it when a player is removed', () => {
    const game = createGame({ code: 'A', seed: 1 });
    const [first, second] = game.config.avatarRingColors;
    join(game, 'A', { avatar: '🐼' });
    join(game, 'B', { avatar: '🦊' });
    join(game, 'C', { avatar: '🐼' });
    expect(game.players.map((p) => p.ring)).toEqual([first, first, second]);
    removePlayer(game, game.players[0].id);
    join(game, 'D', { avatar: '🐼' });
    expect(game.players.find((p) => p.name === 'D').ring).toBe(first);
    const looks = game.players.map((p) => `${p.avatar} ${p.ring}`);
    expect(new Set(looks).size).toBe(looks.length);
  });

  it('refuses joins while the lobby is locked', () => {
    const game = lobby(2);
    setLocked(game, true);
    expect(join(game, 'Late').error).toBe('locked');
    setLocked(game, false);
    expect(join(game, 'Late').ok).toBe(true);
  });

  it('returns the same seat for a returning token', () => {
    const game = lobby(4);
    const again = addPlayer(game, { name: 'Other', avatar: '🐶', token: 'token-2' });
    expect(again.existing).toBe(true);
    expect(again.player.name).toBe('Player 2');
    expect(game.players).toHaveLength(4);
  });

  it('has no player cap by default', () => {
    const game = lobby(60);
    expect(game.players).toHaveLength(60);
    expect(startGame(game, T0).ok).toBe(true);
  });

  it('enforces maxPlayers when one is set', () => {
    const game = lobby(4, { config: { maxPlayers: 4 } });
    expect(join(game, 'Fifth').error).toBe('room_full');
  });

  it("revokes a removed player's token", () => {
    const game = lobby(5);
    const removed = game.players[4];
    expect(removePlayer(game, removed.id).ok).toBe(true);
    expect(isRevoked(game, 'token-5')).toBe(true);
    expect(findPlayerByToken(game, 'token-5')).toBeNull();
    expect(playerView(game, removed.id, T0)).toBeNull();
    expect(game.players).toHaveLength(4);
  });

  it('lets a removed player rejoin only while the lobby is unlocked', () => {
    const game = lobby(5);
    removePlayer(game, game.players[4].id);
    setLocked(game, true);
    expect(addPlayer(game, { name: 'Player 5', avatar: '🐶', token: 'token-5' }).error).toBe('locked');
    setLocked(game, false);
    expect(addPlayer(game, { name: 'Player 5', avatar: '🐶', token: 'token-5' }).ok).toBe(true);
    expect(isRevoked(game, 'token-5')).toBe(false);
  });

  it('refuses to remove players or accept joins once the game is running', () => {
    const game = started(4);
    expect(removePlayer(game, game.players[0].id).error).toBe('in_progress');
    expect(join(game, 'Late').error).toBe('in_progress');
  });
});

describe('starting', () => {
  it('is refused with fewer than 4 players', () => {
    for (const n of [0, 1, 2, 3]) {
      const game = lobby(n);
      expect(startGame(game, T0).error).toBe('too_few');
      expect(game.status).toBe('lobby');
    }
  });

  it('is refused with an odd count, with a hint for the host', () => {
    const game = lobby(11);
    const result = startGame(game, T0);
    expect(result.error).toBe('odd_count');
    expect(startCheck(game).hint).toBe('11 players: remove 1 to start');
    expect(game.status).toBe('lobby');
  });

  it('works with 4 players and cannot be done twice', () => {
    const game = lobby(4);
    expect(startGame(game, T0).ok).toBe(true);
    expect(game.status).toBe('bidding');
    expect(game.round).toBe(1);
    expect(startGame(game, T0).error).toBe('in_progress');
  });
});

describe('rejoin codes', () => {
  it('move a seat to a new token', () => {
    const game = started(4);
    const seat = game.players[2];
    expect(claimSeat(game, 'nope', 'new-token').error).toBe('bad_rejoin_code');
    expect(claimSeat(game, '', 'new-token').error).toBe('bad_rejoin_code');
    expect(claimSeat(game, ' r3 ', 'new-token').player.id).toBe(seat.id);
    expect(findPlayerByToken(game, 'new-token').id).toBe(seat.id);
    expect(findPlayerByToken(game, 'token-3')).toBeNull();
  });
});

describe('reset', () => {
  it('keeps players when asked, and returns to the lobby', () => {
    const game = started(6);
    reset(game, { keepPlayers: true });
    expect(game.status).toBe('lobby');
    expect(game.players).toHaveLength(6);
    expect(game.players.every((p) => p.fruit === null)).toBe(true);
    expect(game.rounds).toEqual([]);
    expect(startGame(game, T0).ok).toBe(true);
  });

  it('wipes players when asked', () => {
    const game = started(6);
    reset(game, { keepPlayers: false });
    expect(game.players).toEqual([]);
    expect(game.status).toBe('lobby');
  });
});
