import { timeLeft, freeRing } from './engine.js';
import { resolveConfig } from '../config.js';

const FORMAT = 'fruit-stand-snapshot';
const VERSION = 1;
const STATUSES = ['lobby', 'bidding', 'results', 'reveal', 'final'];

// A complete copy of the game. The timer is stored as time remaining, so it
// does not depend on the clock of the server that later loads it.
export function exportSnapshot(state, now) {
  const copy = structuredClone(state);
  const wasRunning = state.timer.runningSince !== null;
  copy.timer = { remainingMs: Math.max(0, timeLeft(state, now)), runningSince: null };
  return { format: FORMAT, version: VERSION, exportedAt: now, timerWasRunning: wasRunning, state: copy };
}

// Rebuilds a game from a snapshot. The timer always comes back paused with
// the saved time remaining; the host resumes it once players are back.
export function importSnapshot(snapshot) {
  if (!snapshot || snapshot.format !== FORMAT) throw new Error('This file is not a Fruit Stand snapshot.');
  if (snapshot.version !== VERSION) throw new Error(`Snapshot version ${snapshot.version} is not supported.`);
  const state = structuredClone(snapshot.state);
  const shapeOk =
    state &&
    typeof state.code === 'string' &&
    STATUSES.includes(state.status) &&
    Array.isArray(state.players) &&
    Array.isArray(state.rounds) &&
    Number.isInteger(state.round) &&
    state.round === state.rounds.length &&
    Number.isInteger(state.rngState) &&
    state.timer &&
    typeof state.timer.remainingMs === 'number';
  if (!shapeOk) throw new Error('This snapshot is damaged and cannot be loaded.');
  state.config = resolveConfig(state.config);
  // Snapshots saved before avatar rings and the round 2 ambience existed.
  const players = state.players;
  state.players = [];
  for (const player of players) {
    if (!player.ring) player.ring = freeRing(state, player.avatar);
    state.players.push(player);
  }
  for (const round of state.rounds) {
    if (round.ambient === undefined) round.ambient = null;
  }
  state.timer = { remainingMs: state.timer.remainingMs, runningSince: null };
  return state;
}
