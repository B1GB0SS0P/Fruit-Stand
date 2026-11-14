// Fruit Stand game rules. Plain functions over a state object: no sockets,
// no timers, no clock. Callers pass `now` (ms) wherever time matters.
//
// Every function mutates `state` and returns { ok: true, ... } or
// { ok: false, error, message }.

import { resolveConfig } from '../config.js';
import { seedFrom, sample } from './rng.js';
import { makePairs, makePhase2Pairs, dealFruits, activeFruitCount } from './deal.js';
import { scoreRound } from './scoring.js';
import { ambientSequence } from './ambient.js';

const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (error, message) => ({ ok: false, error, message });

export function createGame({ code, seed = Date.now(), config = {} }) {
  return {
    code,
    config: resolveConfig(config),
    rngState: seedFrom(seed),
    status: 'lobby', // lobby | bidding | results | reveal | final
    locked: false,
    players: [], // { id, token, rejoinCode, name, avatar, ring, fruit, tokens }
    // Predictors hold a seat like a player (same id, token, name, avatar)
    // but are never dealt a fruit, never bid and are in no team.
    predictors: [], // { id, token, rejoinCode, name, avatar, ring }
    predictions: {}, // predictor id or 'host' -> { medianCents, winner, middle }
    predictionsLocked: false,
    hostPlaying: false, // the host says they are also a player
    nextPlayerNumber: 1,
    revokedTokens: [],
    round: 0,
    activeFruits: [],
    teams: {}, // { 1: [[idA, idB], ...], 2: [...] }
    rounds: [],
    announcements: [],
    nextAnnouncementId: 1,
    timer: { remainingMs: 0, runningSince: null },
  };
}

// ---------- lookups ----------

export const phaseOf = (config, round) => (round <= config.phase1LastRound ? 1 : 2);
export const currentRound = (state) => state.rounds[state.round - 1] || null;
export const findPlayer = (state, id) => state.players.find((p) => p.id === id) || null;
export const findPlayerByToken = (state, token) => state.players.find((p) => p.token === token) || null;
export const findPredictor = (state, id) => state.predictors.find((p) => p.id === id) || null;
// Everyone holding a seat in the room: players and predictors.
export const seats = (state) => [...state.players, ...state.predictors];
export const findSeatByToken = (state, token) => seats(state).find((p) => p.token === token) || null;
export const HOST_ID = 'host';
export const isRevoked =(state, token) => state.revokedTokens.includes(token);
export const fruitName = (config, id) => config.fruits.find((f) => f.id === id)?.name ?? id;

export function teammateOf(state, playerId, phase) {
  const pair = (state.teams[phase] || []).find((p) => p.includes(playerId));
  return pair ? findPlayer(state, pair.find((id) => id !== playerId)) : null;
}

export function changeTargetsFor(state, player) {
  const pool = state.config.changeTargets === 'any' ? state.config.fruits.map((f) => f.id) : state.activeFruits;
  return pool.filter((fruit) => fruit !== player.fruit);
}

// ---------- avatars ----------

// The first ring colour nobody else with this animal has. If the config list
// runs out, further colours are made up, so every animal + ring pair in the
// room stays unique however many players pick the same animal.
export function freeRing(state, avatar) {
  const listed = state.config.avatarRingColors.map((color) => color.toLowerCase());
  const taken = new Set(seats(state).filter((p) => p.avatar === avatar).map((p) => p.ring));
  for (const ring of listed) {
    if (!taken.has(ring)) return ring;
  }
  for (let i = 0; ; i++) {
    const ring = spareRing(i);
    if (!taken.has(ring) && !listed.includes(ring)) return ring;
  }
}

// Evenly spread extra colours: the hue steps by the golden angle, and the
// lightness cycles so near hues still differ.
function spareRing(i) {
  const hue = (i * 137.508 + 20) % 360;
  const light = [0.42, 0.62, 0.52][i % 3];
  const a = 0.7 * Math.min(light, 1 - light);
  const channel = (n) => {
    const k = (n + hue / 30) % 12;
    const value = light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(value * 255).toString(16).padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

// ---------- lobby ----------

// Can a new player join right now? Used for the first step of the join flow.
export function checkJoinable(state) {
  if (state.status !== 'lobby') return fail('in_progress', 'This game has already started.');
  if (state.locked) return fail('locked', 'This room is locked. Ask the host to let you in.');
  if (state.config.maxPlayers > 0 && state.players.length >= state.config.maxPlayers) {
    return fail('room_full', 'This room is full.');
  }
  return ok();
}

export function checkName(state, name) {
  const clean = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  const length = [...clean].length;
  if (length < 1 || length > 20) return fail('bad_name', 'Your name must be 1 to 20 characters.');
  if (seats(state).some((p) => p.name.toLowerCase() === clean.toLowerCase())) {
    return fail('name_taken', 'That name is taken. Please pick another.');
  }
  return ok({ name: clean });
}

export function addPlayer(state, { name, avatar, token, rejoinCode = null }) {
  const existing = findSeatByToken(state, token);
  if (existing) return ok({ player: existing, existing: true });

  const joinable = checkJoinable(state);
  if (!joinable.ok) return joinable;

  const named = checkName(state, name);
  if (!named.ok) return named;
  const clean = named.name;
  if (!state.config.avatars.includes(avatar)) return fail('bad_avatar', 'Please pick an avatar.');
  if (typeof token !== 'string' || !token) return fail('bad_token', 'Something went wrong. Please try again.');

  const player = {
    id: `p${state.nextPlayerNumber++}`,
    token,
    rejoinCode,
    name: clean,
    avatar,
    ring: freeRing(state, avatar),
    fruit: null,
    tokens: 0,
  };
  state.players.push(player);
  state.revokedTokens = state.revokedTokens.filter((t) => t !== token);
  return ok({ player });
}

export function removePlayer(state, playerId) {
  if (state.status !== 'lobby') return fail('in_progress', 'Players can only be removed in the lobby.');
  const player = findPlayer(state, playerId) || findPredictor(state, playerId);
  if (!player) return fail('unknown_player', 'That player is not in the room.');
  state.players = state.players.filter((p) => p.id !== playerId);
  state.predictors = state.predictors.filter((p) => p.id !== playerId);
  state.revokedTokens.push(player.token);
  return ok({ player });
}

// Turns a player into a predictor. They keep their seat, name and avatar
// but leave the player list, so they are not counted, paired or dealt a fruit.
export function makePredictor(state, playerId) {
  if (state.status !== 'lobby') return fail('in_progress', 'Predictors can only be chosen in the lobby.');
  const player = findPlayer(state, playerId);
  if (!player) return fail('unknown_player', 'That player is not in the room.');
  const max = state.config.maxPredictors;
  if (state.predictors.length >= max) {
    return fail('too_many_predictors', max === 0 ? 'Predictors are turned off.' : `A room can have at most ${max} predictor${max === 1 ? '' : 's'}.`);
  }
  state.players = state.players.filter((p) => p.id !== playerId);
  const { id, token, rejoinCode, name, avatar, ring } = player;
  const predictor = { id, token, rejoinCode, name, avatar, ring };
  state.predictors.push(predictor);
  return ok({ predictor });
}

// Turns a predictor back into a player.
export function makePlayer(state, predictorId) {
  if (state.status !== 'lobby') return fail('in_progress', 'Predictors can only be changed in the lobby.');
  const predictor = findPredictor(state, predictorId);
  if (!predictor) return fail('unknown_player', 'That predictor is not in the room.');
  if (state.config.maxPlayers > 0 && state.players.length >= state.config.maxPlayers) {
    return fail('room_full', 'The room is full of players already.');
  }
  state.predictors = state.predictors.filter((p) => p.id !== predictorId);
  const player = { ...predictor, fruit: null, tokens: 0 };
  state.players.push(player);
  return ok({ player });
}

export function setHostPlaying(state, playing) {
  state.hostPlaying = Boolean(playing);
  return ok();
}

export function setLocked(state, locked) {
  state.locked = Boolean(locked);
  return ok();
}

// Moves a seat to a new browser. Used when a player has lost their token.
export function claimSeat(state, rejoinCode, newToken) {
  const wanted = String(rejoinCode ?? '').trim().toUpperCase();
  const player = wanted && seats(state).find((p) => p.rejoinCode && p.rejoinCode.toUpperCase() === wanted);
  if (!player) return fail('bad_rejoin_code', "That rejoin code isn't right. Check with the host.");
  if (typeof newToken !== 'string' || !newToken) return fail('bad_token', 'Something went wrong. Please try again.');
  player.token = newToken;
  return ok({ player });
}

export function startCheck(state) {
  const n = state.players.length;
  if (n < 4) return { canStart: false, error: 'too_few', hint: `${n} player${n === 1 ? '' : 's'}: need at least 4 to start` };
  if (n % 2 === 1) return { canStart: false, error: 'odd_count', hint: `${n} players: remove 1 to start` };
  if (activeFruitCount(n, state.config) < 1) {
    return { canStart: false, error: 'too_few', hint: `${n} players: not enough for one fruit` };
  }
  return { canStart: true, error: null, hint: `${n} players: ready to start` };
}

export function startGame(state, now) {
  if (state.status !== 'lobby') return fail('in_progress', 'The game has already started.');
  const check = startCheck(state);
  if (!check.canStart) return fail(check.error, check.hint);

  const ids = state.players.map((p) => p.id);
  const pairs = makePairs(state, ids);
  const deal = dealFruits(state, ids, pairs, state.config);
  if (!deal) return fail('deal_failed', 'Could not deal the fruits. Press Start to try again.');

  state.teams = { 1: pairs };
  state.activeFruits = deal.activeFruits;
  for (const player of state.players) {
    player.fruit = deal.fruitOf[player.id];
    player.tokens = state.config.changeTokens;
  }
  state.round = 0;
  state.rounds = [];
  state.announcements = [];
  state.predictions = {};
  state.predictionsLocked = false;
  openRound(state, now);
  return ok();
}

export function reset(state, { keepPlayers }) {
  if (keepPlayers) {
    for (const player of state.players) {
      player.fruit = null;
      player.tokens = 0;
    }
  } else {
    state.players = [];
    state.predictors = [];
    state.revokedTokens = [];
    state.hostPlaying = false;
  }
  state.predictions = {};
  state.predictionsLocked = false;
  state.status = 'lobby';
  state.locked = false;
  state.round = 0;
  state.activeFruits = [];
  state.teams = {};
  state.rounds = [];
  state.announcements = [];
  state.timer = { remainingMs: 0, runningSince: null };
  return ok();
}

// ---------- rounds ----------

function openRound(state, now) {
  const { config } = state;
  state.round += 1;
  const n = state.round;
  const phase = phaseOf(config, n);
  if (n >= config.predictionLockRound) state.predictionsLocked = true;

  if (phase === 2 && !state.teams[2]) {
    const ids = state.players.map((p) => p.id);
    state.teams[2] = makePhase2Pairs(state, ids, state.teams[1]).pairs;
  }

  // The secret list and the ambient sequence built from it stay on the
  // server. Only the sequence (emojis and timing) is ever sent out.
  let secret = [];
  let ambient = null;
  if (n === config.secretRound) {
    const sold = new Set(state.players.map((p) => p.fruit));
    const candidates = state.activeFruits.filter((fruit) => sold.has(fruit));
    const wanted = Math.max(1, Math.floor(state.activeFruits.length * config.secretShare + 0.5));
    secret = sample(state, candidates, Math.min(wanted, candidates.length));
    const inPlay = [...state.activeFruits, ...[...sold].filter((fruit) => !state.activeFruits.includes(fruit))];
    ambient = ambientSequence(state, inPlay, secret, config);
  }

  state.rounds.push({
    n,
    phase,
    secret,
    ambient, // [{ emoji, delay, duration }] in the secret round, else null
    selections: {}, // playerId -> price (latest pick)
    submitted: {}, // playerId -> true once locked in
    bidType: {}, // playerId -> submitted | host | auto_selected | auto_max
    resolved: false,
    fruitOf: null,
    results: null,
    earnings: null,
  });
  state.status = 'bidding';
  state.timer = { remainingMs: config.bidSeconds * 1000, runningSince: now };
}

export function nextRound(state, now) {
  if (state.status !== 'results') return fail('round_not_resolved', 'The current round has not finished yet.');
  if (state.round >= state.config.totalRounds) return fail('no_more_rounds', 'That was the last round.');
  openRound(state, now);
  return ok();
}

function resolveRound(state, now) {
  const round = currentRound(state);
  if (!round || round.resolved) return false;
  round.fruitOf = Object.fromEntries(state.players.map((p) => [p.id, p.fruit]));
  const { results, earnings } = scoreRound(round.fruitOf, round.selections);
  round.results = results;
  round.earnings = earnings;
  round.resolved = true;
  state.status = 'results';
  state.timer = { remainingMs: Math.max(0, timeLeft(state, now)), runningSince: null };
  return true;
}

function resolveIfComplete(state, now) {
  const round = currentRound(state);
  if (state.players.every((p) => round.submitted[p.id])) return resolveRound(state, now);
  return false;
}

// Shared checks for anything a player does during bidding.
function biddingGuard(state, playerId, roundNumber, now) {
  const player = findPlayer(state, playerId);
  if (!player && findPredictor(state, playerId)) {
    return { error: fail('is_predictor', "Predictors watch the market. They can't bid or Change.") };
  }
  if (!player) return { error: fail('unknown_player', 'You are not in this game.') };
  if (state.status !== 'bidding') return { error: fail('round_closed', 'This round is closed.') };
  if (roundNumber !== state.round) return { error: fail('stale_round', 'That was for an earlier round.') };
  if (timeLeft(state, now) <= 0) return { error: fail('time_up', 'Time is up for this round.') };
  return { player, round: currentRound(state) };
}

const validPrice = (config, price) =>
  Number.isInteger(price) && price >= config.minPrice && price <= config.maxPrice;

const badPrice = (config) =>
  fail('bad_price', `Pick a whole-dollar price from $${config.minPrice} to $${config.maxPrice}.`);

// Pick a price. Can be changed freely until the player submits.
export function select(state, playerId, roundNumber, price, now) {
  const { error, player, round } = biddingGuard(state, playerId, roundNumber, now);
  if (error) return error;
  if (round.submitted[player.id]) return fail('already_submitted', 'Your price is locked in for this round.');
  if (!validPrice(state.config, price)) return badPrice(state.config);
  round.selections[player.id] = price;
  return ok({ price });
}

// Lock in a price. Final for the round. `price` may be omitted to lock in the
// current selection.
export function submit(state, playerId, roundNumber, price, now) {
  const { error, player, round } = biddingGuard(state, playerId, roundNumber, now);
  if (error) return error;
  const chosen = price ?? round.selections[player.id];
  if (round.submitted[player.id]) {
    if (chosen === round.selections[player.id]) return ok({ price: chosen, duplicate: true, resolved: false });
    return fail('already_submitted', 'Your price is locked in for this round.');
  }
  if (chosen === undefined) return fail('no_selection', 'Pick a price first.');
  if (!validPrice(state.config, chosen)) return badPrice(state.config);
  round.selections[player.id] = chosen;
  round.submitted[player.id] = true;
  round.bidType[player.id] = 'submitted';
  return ok({ price: chosen, resolved: resolveIfComplete(state, now) });
}

// The host locks in a price for a player who cannot do it themselves.
export function hostSetBid(state, playerId, roundNumber, price, now) {
  const { error, player, round } = biddingGuard(state, playerId, roundNumber, now);
  if (error) return error;
  if (round.submitted[player.id]) return fail('already_submitted', `${player.name} has already locked in a price.`);
  if (!validPrice(state.config, price)) return badPrice(state.config);
  round.selections[player.id] = price;
  round.submitted[player.id] = true;
  round.bidType[player.id] = 'host';
  return ok({ resolved: resolveIfComplete(state, now) });
}

// Called when the timer runs out. Unsubmitted selections are used as they
// stand; players with no selection get the max price.
export function expire(state, roundNumber, now) {
  if (state.status !== 'bidding') return fail('round_closed', 'This round is closed.');
  if (roundNumber !== state.round) return fail('stale_round', 'That was for an earlier round.');
  if (timeLeft(state, now) > 0) return fail('not_expired', 'The timer is still running.');
  const round = currentRound(state);
  for (const player of state.players) {
    if (round.submitted[player.id]) continue;
    if (round.selections[player.id] === undefined) {
      round.selections[player.id] = state.config.maxPrice;
      round.bidType[player.id] = 'auto_max';
    } else {
      round.bidType[player.id] = 'auto_selected';
    }
    round.submitted[player.id] = true;
  }
  resolveRound(state, now);
  return ok({ resolved: true });
}

// ---------- Change token ----------

export function change(state, playerId, roundNumber, fruitId, now) {
  const { error, player, round } = biddingGuard(state, playerId, roundNumber, now);
  if (error) return error;
  if (round.submitted[player.id]) {
    return fail('already_submitted', "You've already locked in your price this round, so you can't Change now.");
  }
  if (player.tokens < 1) return fail('no_token', 'You have no Change token left.');
  if (!changeTargetsFor(state, player).includes(fruitId)) {
    return fail('bad_fruit', "You can't change to that fruit.");
  }

  const from = player.fruit;
  player.fruit = fruitId;
  player.tokens -= 1;
  const announcement = {
    id: state.nextAnnouncementId++,
    round: state.round,
    playerId: player.id,
    name: player.name,
    avatar: player.avatar,
    from,
    to: fruitId,
    text: `${player.name} changed ${fruitName(state.config, from)} → ${fruitName(state.config, fruitId)}`,
  };
  state.announcements.push(announcement);
  return ok({ announcement });
}

// ---------- timer ----------

export function timeLeft(state, now) {
  const { remainingMs, runningSince } = state.timer;
  return runningSince === null ? remainingMs : remainingMs - (now - runningSince);
}

// Clock time at which the round expires, or null while paused or not bidding.
export function deadline(state) {
  const { remainingMs, runningSince } = state.timer;
  if (state.status !== 'bidding' || runningSince === null) return null;
  return runningSince + remainingMs;
}

export function pauseTimer(state, now) {
  if (state.status !== 'bidding') return fail('round_closed', 'There is no round running.');
  if (state.timer.runningSince !== null) {
    state.timer = { remainingMs: Math.max(0, timeLeft(state, now)), runningSince: null };
  }
  return ok();
}

export function resumeTimer(state, now) {
  if (state.status !== 'bidding') return fail('round_closed', 'There is no round running.');
  if (state.timer.runningSince === null) state.timer.runningSince = now;
  return ok();
}

export function addTime(state, ms, now) {
  if (state.status !== 'bidding') return fail('round_closed', 'There is no round running.');
  if (timeLeft(state, now) <= 0) return fail('time_up', 'Time is up for this round.');
  state.timer.remainingMs += ms;
  return ok();
}

// ---------- finale ----------

export function revealSecrets(state) {
  if (state.status !== 'results' || state.round < state.config.totalRounds) {
    return fail('not_finished', 'The last round has not finished yet.');
  }
  state.status = 'reveal';
  state.predictionsLocked = true;
  return ok();
}

// "Predictors vs Host": everyone's predictions and scores go public.
export function revealPredictions(state) {
  if (state.status !== 'reveal') return fail('not_revealed', 'Reveal the secret prices first.');
  state.status = 'predictions';
  return ok();
}

export function showStandings(state) {
  if (state.status !== 'reveal' && state.status !== 'predictions') {
    return fail('not_revealed', 'Reveal the secret prices first.');
  }
  state.status = 'final';
  return ok();
}

// ---------- predictions ----------

const MAX_MEDIAN_CENTS = 99_999_99;

// "$12.5", "12.50" or 12.5 -> 1250. Null for anything that is not a plain
// dollar amount with at most 2 decimal places.
export function parseCents(value) {
  const text = (typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '').trim().replace(/^\$/, '');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(text)) return null;
  const [dollars, cents = ''] = text.split('.');
  const total = Number(dollars) * 100 + Number(cents.padEnd(2, '0'));
  return total <= MAX_MEDIAN_CENTS ? total : null;
}

const emptyPrediction = () => ({ medianCents: null, winner: null, middle: null });

export function predictionOf(state, who) {
  return state.predictions[who] || emptyPrediction();
}

export const predictionComplete = (prediction) =>
  prediction.medianCents !== null && prediction.winner !== null && prediction.middle !== null;

// Saves all three answers for a predictor (by id) or the host (HOST_ID).
// Any answer may be null, meaning "not answered yet".
export function savePrediction(state, who, { median = null, winner = null, middle = null } = {}) {
  if (who !== HOST_ID && !findPredictor(state, who)) return fail('not_predictor', 'Only predictors and the host can predict.');
  if (state.status === 'lobby') return fail('not_started', 'Predictions open when the game starts.');
  if (state.predictionsLocked) return fail('predictions_locked', 'Predictions are locked.');

  const blank = median === null || median === '';
  const medianCents = blank ? null : parseCents(median);
  if (!blank && medianCents === null) {
    return fail('bad_median', 'Enter the median as dollars and cents, like 14.50.');
  }
  for (const pick of [winner, middle]) {
    if (pick !== null && !findPlayer(state, pick)) return fail('bad_pick', 'Pick a player from the list.');
  }
  state.predictions[who] = { medianCents, winner, middle };
  return ok({ prediction: state.predictions[who] });
}
