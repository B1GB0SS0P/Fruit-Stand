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

  sellersPerFruit: 2, // target sellers per fruit; must be 2 or more
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
};

export function resolveConfig(overrides = {}) {
  const c = structuredClone({ ...defaultConfig, ...overrides });
  const int = (v) => Number.isInteger(v);
  const problems = [];
  if (!Array.isArray(c.fruits) || c.fruits.length < 2) problems.push('fruits needs at least 2 entries');
  if (new Set(c.fruits.map((f) => f.id)).size !== c.fruits.length) problems.push('fruit ids must be unique');
  if (!Array.isArray(c.avatars) || c.avatars.length < 1) problems.push('avatars is empty');
  if (!int(c.sellersPerFruit) || c.sellersPerFruit < 2) problems.push('sellersPerFruit must be a whole number, 2 or more');
  if (!['active', 'any'].includes(c.changeTargets)) problems.push('changeTargets must be "active" or "any"');
  if (!int(c.minPrice) || !int(c.maxPrice) || c.minPrice < 0 || c.minPrice > c.maxPrice) problems.push('minPrice/maxPrice are invalid');
  if (!int(c.totalRounds) || c.totalRounds < 1) problems.push('totalRounds must be 1 or more');
  if (!int(c.phase1LastRound) || c.phase1LastRound < 0) problems.push('phase1LastRound is invalid');
  if (!int(c.secretRound) || c.secretRound < 0) problems.push('secretRound is invalid');
  if (typeof c.secretShare !== 'number' || c.secretShare < 0 || c.secretShare > 1) problems.push('secretShare must be between 0 and 1');
  if (!int(c.changeTokens) || c.changeTokens < 0) problems.push('changeTokens is invalid');
  if (typeof c.bidSeconds !== 'number' || c.bidSeconds <= 0) problems.push('bidSeconds must be above 0');
  if (!int(c.maxPlayers) || c.maxPlayers < 0) problems.push('maxPlayers is invalid');
  if (problems.length) throw new Error(`Invalid config: ${problems.join('; ')}`);
  return c;
}
