// The round 2 background: fruit emojis that drift past behind the game.
// Secret fruits turn up more often, which is the only hint anyone gets.
//
// The server builds the whole spawn sequence up front and sends just that,
// so the secret list itself never leaves the server. Each entry is exactly
// { emoji, delay, duration }: what to show, and timing in milliseconds.

import { nextRandom } from './rng.js';

export const AMBIENT_LENGTH = 240; // clients loop the sequence when it runs out
export const AMBIENT_DELAY_MS = 2000; // delay is 0..this; clients scale it to their own pace
export const AMBIENT_MIN_MS = 20_000; // one pass across the screen takes 20-40 s
export const AMBIENT_MAX_MS = 40_000;

// `fruits` are the ids in play; any id in `secret` gets `secretWeight`, the
// rest get 1. Fruits outside `fruits` are never used.
export function ambientSequence(state, fruits, secret, config, length = AMBIENT_LENGTH) {
  const emojiOf = Object.fromEntries(config.fruits.map((f) => [f.id, f.emoji]));
  const hidden = new Set(secret);
  const weights = fruits.map((id) => (hidden.has(id) ? config.ambientSecretWeight : 1));
  const total = weights.reduce((sum, w) => sum + w, 0);
  const sequence = [];
  if (!fruits.length) return sequence;

  for (let i = 0; i < length; i++) {
    let roll = nextRandom(state) * total;
    let pick = fruits.length - 1;
    for (let f = 0; f < fruits.length; f++) {
      roll -= weights[f];
      if (roll < 0) {
        pick = f;
        break;
      }
    }
    sequence.push({
      emoji: emojiOf[fruits[pick]],
      delay: Math.floor(nextRandom(state) * AMBIENT_DELAY_MS),
      duration: AMBIENT_MIN_MS + Math.floor(nextRandom(state) * (AMBIENT_MAX_MS - AMBIENT_MIN_MS)),
    });
  }
  return sequence;
}
