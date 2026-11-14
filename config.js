// All game settings live here. Edit the defaults below to change the game.

export const defaultConfig = {
  // Fruit pool. The number in play scales with the player count.
  // Blueberry and Olive need Android 11 or later; the rest work on older phones.
  fruits: [
    { id: 'apple', name: 'Apple', emoji: '🍎' },
    { id: 'grape', name: 'Grape', emoji: '🍇' },
    { id: 'melon', name: 'Melon', emoji: '🍈' },
    { id: 'tangerine', name: 'Tangerine', emoji: '🍊' },
    { id: 'strawberry', name: 'Strawberry', emoji: '🍓' },
    { id: 'watermelon', name: 'Watermelon', emoji: '🍉' },
    { id: 'banana', name: 'Banana', emoji: '🍌' },
    { id: 'pineapple', name: 'Pineapple', emoji: '🍍' },
    { id: 'mango', name: 'Mango', emoji: '🥭' },
    { id: 'peach', name: 'Peach', emoji: '🍑' },
    { id: 'pear', name: 'Pear', emoji: '🍐' },
    { id: 'cherry', name: 'Cherry', emoji: '🍒' },
    { id: 'lemon', name: 'Lemon', emoji: '🍋' },
    { id: 'kiwi', name: 'Kiwi', emoji: '🥝' },
    { id: 'coconut', name: 'Coconut', emoji: '🥥' },
    { id: 'blueberry', name: 'Blueberry', emoji: '🫐' },
    { id: 'greenapple', name: 'Green Apple', emoji: '🍏' },
    { id: 'tomato', name: 'Tomato', emoji: '🍅' },
    { id: 'olive', name: 'Olive', emoji: '🫒' },
    { id: 'avocado', name: 'Avocado', emoji: '🥑' },
  ],

  // Player avatars. Animals only, so an avatar is never mistaken for a fruit.
  avatars: [
    '🐶', '🐱', '🐼', '🦊', '🐸', '🐧', '🐨', '🐯',
    '🦁', '🐮', '🐷', '🐵', '🐰', '🐻', '🐹', '🐭',
    '🐔', '🦄', '🐙', '🐢', '🐝', '🦉', '🐳', '🦋',
  ],

  // The market grows with the room:
  //   sellers per fruit = max(minSellersPerFruit, ceil(players / sellersDivisor))
  // With the defaults: 2 sellers up to 20 players, 3 up to 30, 4 up to 40.
  minSellersPerFruit: 2, // must be 2 or more
  sellersDivisor: 10,

  // Predictors watch the game and guess how it ends. The host predicts too.
  maxPredictors: 3, // predictors per room, not counting the host
  predictionLockRound: 3, // predictions lock when this round starts

  changeTargets: 'active', // 'active' = fruits in play, 'any' = whole pool
  minPrice: 1,
  maxPrice: 5,
  totalRounds: 4,
  phase1LastRound: 2, // rounds after this one are Phase 2
  secretRound: 2, // 0 turns the Secret Market off
  secretShare: 0.25, // share of active fruits that are secret
  changeTokens: 1, // Change tokens per player for the whole game
  bidSeconds: 300, // bidding timer per round
  maxPlayers: 0, // 0 = no limit

  // Round 2 background fruit. Secret fruits drift past this many times as
  // often as the others. 1 removes the tell.
  ambientSecretWeight: 3,
  ambientCountProjector: 10, // fruit on the big screen at once (8-12 looks right)
  ambientCountPhone: 5, // fruit on a phone at once (4-6 looks right)

  // Avatar ring colours. Each player gets the first one that is free for
  // their animal, so no two players look the same.
  avatarRingColors: [
    '#e2552d', '#2ba39b', '#f7bb3d', '#5b6ee1', '#d9527f', '#3d9a5c',
    '#8e5bd0', '#f08a24', '#1d8fd1', '#8d5a2b', '#96c93d', '#e84a8a',
    '#2c4a7c', '#19b5c8', '#b03a2e', '#c9a227', '#6b7a8f', '#b76fe0',
    '#0f7d5c', '#ff8f73',
  ],

  // Sky colours for each part of the game, top to bottom. Two or more
  // colour stops each. The reveal and final standings both use `final`.
  skyTheme: {
    lobby: ['#bfe3f5', '#fde6d2', '#ffd9b8'], // early morning: light blue over pale peach
    round1: ['#8fd0f5', '#c9eafb', '#eef8fd'], // bright morning: soft blue
    round2: ['#a9d6ea', '#f3ecd2', '#fbe7b8'], // midday: hazy and warm
    round3: ['#f5c860', '#fbdf9a', '#fdeec8'], // afternoon: golden
    round4: ['#f08a4b', '#f4a07a', '#f3a6c0'], // sunset: orange to pink
    final: ['#4a2d7a', '#33286b', '#1b2452'], // dusk: deep purple to navy
  },
};

const SKY_STATES = ['lobby', 'round1', 'round2', 'round3', 'round4', 'final'];
const isColor = (value) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);

export function resolveConfig(overrides = {}) {
  const c = structuredClone({ ...defaultConfig, ...overrides });
  // A partial skyTheme only replaces the states it names.
  c.skyTheme = { ...structuredClone(defaultConfig.skyTheme), ...(overrides.skyTheme || {}) };
  const int = (v) => Number.isInteger(v);
  const problems = [];
  if (!Array.isArray(c.fruits) || c.fruits.length < 2) problems.push('fruits needs at least 2 entries');
  if (new Set(c.fruits.map((f) => f.id)).size !== c.fruits.length) problems.push('fruit ids must be unique');
  if (!Array.isArray(c.avatars) || c.avatars.length < 1) problems.push('avatars is empty');
  delete c.sellersPerFruit; // the old fixed setting, still present in older snapshots
  if (!int(c.minSellersPerFruit) || c.minSellersPerFruit < 2) problems.push('minSellersPerFruit must be a whole number, 2 or more');
  if (!int(c.sellersDivisor) || c.sellersDivisor < 1) problems.push('sellersDivisor must be a whole number, 1 or more');
  if (!int(c.maxPredictors) || c.maxPredictors < 0) problems.push('maxPredictors must be a whole number, 0 or more');
  if (!int(c.predictionLockRound) || c.predictionLockRound < 2) problems.push('predictionLockRound must be a whole number, 2 or more');
  if (!['active', 'any'].includes(c.changeTargets)) problems.push('changeTargets must be "active" or "any"');
  if (!int(c.minPrice) || !int(c.maxPrice) || c.minPrice < 0 || c.minPrice > c.maxPrice) problems.push('minPrice/maxPrice are invalid');
  if (!int(c.totalRounds) || c.totalRounds < 1) problems.push('totalRounds must be 1 or more');
  if (!int(c.phase1LastRound) || c.phase1LastRound < 0) problems.push('phase1LastRound is invalid');
  if (!int(c.secretRound) || c.secretRound < 0) problems.push('secretRound is invalid');
  if (typeof c.secretShare !== 'number' || c.secretShare < 0 || c.secretShare > 1) problems.push('secretShare must be between 0 and 1');
  if (!int(c.changeTokens) || c.changeTokens < 0) problems.push('changeTokens is invalid');
  if (typeof c.bidSeconds !== 'number' || c.bidSeconds <= 0) problems.push('bidSeconds must be above 0');
  if (!int(c.maxPlayers) || c.maxPlayers < 0) problems.push('maxPlayers is invalid');
  if (typeof c.ambientSecretWeight !== 'number' || !(c.ambientSecretWeight >= 1)) problems.push('ambientSecretWeight must be 1 or more');
  if (!int(c.ambientCountProjector) || c.ambientCountProjector < 0) problems.push('ambientCountProjector is invalid');
  if (!int(c.ambientCountPhone) || c.ambientCountPhone < 0) problems.push('ambientCountPhone is invalid');
  if (!Array.isArray(c.avatarRingColors) || c.avatarRingColors.length < 1 || !c.avatarRingColors.every(isColor)
    || new Set(c.avatarRingColors.map((v) => v.toLowerCase())).size !== c.avatarRingColors.length) {
    problems.push('avatarRingColors must be a list of different #rrggbb colours');
  }
  for (const state of SKY_STATES) {
    const stops = c.skyTheme[state];
    if (!Array.isArray(stops) || stops.length < 2 || !stops.every(isColor)) {
      problems.push(`skyTheme.${state} needs 2 or more #rrggbb colours`);
    }
  }
  if (problems.length) throw new Error(`Invalid config: ${problems.join('; ')}`);
  return c;
}
