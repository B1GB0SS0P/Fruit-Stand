// Seedable random numbers (mulberry32). The generator's position is kept on
// the game state (`state.rngState`) so snapshots resume the same sequence.

export function seedFrom(value) {
  if (Number.isInteger(value)) return value >>> 0;
  const text = String(value);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function nextRandom(state) {
  state.rngState = (state.rngState + 0x6d2b79f5) >>> 0;
  let t = state.rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function randInt(state, n) {
  return Math.floor(nextRandom(state) * n);
}

export function shuffle(state, list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randInt(state, i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function sample(state, list, count) {
  return shuffle(state, list).slice(0, count);
}
