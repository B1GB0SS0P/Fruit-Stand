import { randomInt, randomBytes } from 'node:crypto';

// No I or O, so codes are easy to read off a projector.
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const REJOIN_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const ROOM_TTL_MS = 3 * 60 * 60 * 1000;

const randomText = (alphabet, length) =>
  Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join('');

export const normalizeCode = (code) => (typeof code === 'string' ? code.trim().toUpperCase() : '');
export const newToken = () => randomBytes(16).toString('hex');
export const newSeed = () => randomInt(2 ** 32);

export function newRejoinCode(state) {
  const taken = new Set([...state.players, ...(state.predictors || [])].map((p) => p.rejoinCode));
  for (;;) {
    const code = randomText(REJOIN_CHARS, 4);
    if (!taken.has(code)) return code;
  }
}

// All live rooms, keyed by code. A room is { code, state, lastActivity,
// timer, sockets }.
export class RoomStore {
  constructor() {
    this.rooms = new Map();
  }

  newCode() {
    for (;;) {
      const code = randomText(CODE_LETTERS, 4);
      if (!this.rooms.has(code)) return code;
    }
  }

  add(state, now) {
    const room = { code: state.code, state, lastActivity: now, timer: null, sockets: new Set() };
    this.rooms.set(room.code, room);
    return room;
  }

  get(code) {
    return this.rooms.get(normalizeCode(code)) || null;
  }

  // Rooms untouched for longer than the TTL.
  stale(now) {
    return [...this.rooms.values()].filter((room) => now - room.lastActivity > ROOM_TTL_MS);
  }

  delete(code) {
    this.rooms.delete(code);
  }
}
