// What each recipient is allowed to see. Nothing leaves the engine except
// through these functions, so this file is the privacy boundary:
//   - nobody receives another player's selection or any earnings mid-game;
//   - secret fruits' prices are withheld until the end reveal;
//   - the host view carries no prices at all (it does show who sells what).

import { currentRound, findPlayer, teammateOf, changeTargetsFor, timeLeft, startCheck } from './engine.js';
import { computeStandings } from './scoring.js';

const secretsRevealed = (state) => state.status === 'reveal' || state.status === 'final';

// Static settings a client needs to draw the game. Sent once per connection.
export function publicConfig(state) {
  const c = state.config;
  return {
    fruits: c.fruits,
    avatars: c.avatars,
    minPrice: c.minPrice,
    maxPrice: c.maxPrice,
    totalRounds: c.totalRounds,
    bidSeconds: c.bidSeconds,
  };
}

// Each resolved round's lowest price per sold fruit. No names, no earnings.
export function publicResults(state) {
  const poolOrder = state.config.fruits.map((f) => f.id);
  const order = [...state.activeFruits, ...poolOrder.filter((id) => !state.activeFruits.includes(id))];
  const revealed = secretsRevealed(state);
  return state.rounds
    .filter((round) => round.resolved)
    .map((round) => ({
      round: round.n,
      phase: round.phase,
      fruits: order
        .filter((fruit) => round.results[fruit])
        .map((fruit) => {
          const secret = round.secret.includes(fruit);
          return { fruit, secret, price: secret && !revealed ? null : round.results[fruit].lowest };
        }),
    }));
}

function standingsView(state) {
  if (state.status !== 'final') return null;
  return computeStandings(state).map((row) => ({
    id: row.id,
    rank: row.rank,
    name: row.name,
    avatar: row.avatar,
    total: row.totalText,
  }));
}

function timerView(state, now) {
  return {
    remainingMs: Math.max(0, timeLeft(state, now)),
    running: state.timer.runningSince !== null,
    serverNow: now,
  };
}

function shared(state, now) {
  const round = currentRound(state);
  const live = state.status === 'bidding' || state.status === 'results';
  return {
    code: state.code,
    status: state.status,
    round: state.round,
    totalRounds: state.config.totalRounds,
    phase: round ? round.phase : null,
    timer: timerView(state, now),
    playerCount: state.players.length,
    bidsIn: round ? state.players.filter((p) => round.submitted[p.id]).length : 0,
    activeFruits: [...state.activeFruits],
    // Only present during the secret round itself.
    secretFruits: round && live ? [...round.secret] : [],
    announcements: state.announcements.map(({ id, round: n, name, avatar, from, to, text }) => ({
      id, round: n, name, avatar, from, to, text,
    })),
    standings: standingsView(state),
  };
}

export function playerView(state, playerId, now) {
  const player = findPlayer(state, playerId);
  if (!player) return null;
  const round = currentRound(state);
  const mate = round ? teammateOf(state, player.id, round.phase) : null;
  const inGame = state.status !== 'lobby';
  return {
    role: 'player',
    ...shared(state, now),
    results: publicResults(state),
    me: {
      id: player.id,
      name: player.name,
      avatar: player.avatar,
      fruit: player.fruit,
      changeTokens: player.tokens,
      selection: round ? round.selections[player.id] ?? null : null,
      submitted: round ? Boolean(round.submitted[player.id]) : false,
    },
    teammate: mate ? { name: mate.name, avatar: mate.avatar, fruit: mate.fruit } : null,
    rivals: inGame ? state.players.filter((p) => p.id !== player.id && p.fruit === player.fruit).length : 0,
    changeTargets: inGame ? changeTargetsFor(state, player) : [],
  };
}

export function screenView(state, now) {
  return {
    role: 'screen',
    ...shared(state, now),
    results: publicResults(state),
    players: state.status === 'lobby' ? state.players.map((p) => ({ name: p.name, avatar: p.avatar })) : [],
  };
}

export function hostView(state, now) {
  const round = currentRound(state);
  const check = startCheck(state);
  return {
    role: 'host',
    ...shared(state, now),
    locked: state.locked,
    canStart: state.status === 'lobby' && check.canStart,
    startHint: check.hint,
    bidMin: state.config.minPrice,
    bidMax: state.config.maxPrice,
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      rejoinCode: p.rejoinCode,
      fruit: p.fruit,
      submitted: round ? Boolean(round.submitted[p.id]) : false,
    })),
  };
}
