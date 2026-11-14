import { shuffle, sample } from './rng.js';

const MAX_ATTEMPTS = 500;

// Target sellers per fruit. It grows with the room, so a big game has fewer,
// busier markets instead of many two-seller ones.
export function sellersPerFruit(playerCount, config) {
  return Math.max(config.minSellersPerFruit, Math.ceil(playerCount / config.sellersDivisor));
}

export function activeFruitCount(playerCount, config) {
  return Math.min(config.fruits.length, Math.floor(playerCount / sellersPerFruit(playerCount, config)));
}

// Random pairs. `ids.length` must be even.
export function makePairs(state, ids) {
  const order = shuffle(state, ids);
  const pairs = [];
  for (let i = 0; i < order.length; i += 2) pairs.push([order[i], order[i + 1]]);
  return pairs;
}

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// New random pairs where nobody keeps a previous partner. If no such
// arrangement turns up, the one with the fewest repeats is used.
export function makePhase2Pairs(state, ids, previousPairs) {
  const previous = new Set(previousPairs.map(([a, b]) => pairKey(a, b)));
  let best = null;
  let bestRepeats = Infinity;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const pairs = makePairs(state, ids);
    const repeats = pairs.filter(([a, b]) => previous.has(pairKey(a, b))).length;
    if (repeats < bestRepeats) {
      best = pairs;
      bestRepeats = repeats;
      if (repeats === 0) break;
    }
  }
  return { pairs: best, repeats: bestRepeats };
}

// Picks the active fruits and deals one to each player. Returns null when no
// valid deal is found.
export function dealFruits(state, ids, pairs, config) {
  const n = ids.length;
  const k = activeFruitCount(n, config);
  if (k < 1) return null;
  const activeFruits = sample(state, config.fruits.map((f) => f.id), k);

  const base = Math.floor(n / k);
  const extra = n % k;
  const slots = [];
  activeFruits.forEach((fruit, i) => {
    const size = base + (i < extra ? 1 : 0);
    for (let s = 0; s < size; s++) slots.push(fruit);
  });
  if (base < 2) return null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const dealt = shuffle(state, slots);
    const fruitOf = {};
    ids.forEach((id, i) => {
      fruitOf[id] = dealt[i];
    });
    if (pairs.every(([a, b]) => fruitOf[a] !== fruitOf[b])) return { activeFruits, fruitOf };
  }
  return null;
}
