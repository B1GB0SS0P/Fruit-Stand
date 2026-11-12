// What each recipient is allowed to see. Nothing leaves the engine except
// through these functions, so this file is the privacy boundary:
//   - nobody receives another player's selection or any earnings mid-game;
//   - which fruits are secret is withheld until the secret round resolves
//     (the ambient sequence, emojis and timing only, is the one hint);
//   - secret fruits' prices are withheld until the end reveal;
//   - the host view carries no prices at all (it does show who sells what).

import { currentRound, findPlayer, teammateOf, changeTargetsFor, timeLeft, startCheck } from './engine.js';
import { computeStandings } from './scoring.js';
import { toMoney, ZERO } from './frac.js';

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
    ambientCountProjector: c.ambientCountProjector,
    ambientCountPhone: c.ambientCountPhone,
    skyTheme: c.skyTheme,
  };
}

// Each resolved round's lowest price per sold fruit. No names, no earnings.
// Only the secret round's entries carry a `secret` flag, and a round only
// appears here once it has resolved, so nothing labels a fruit as secret
// (or as not secret) before then.
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
          const { lowest } = round.results[fruit];
          if (!round.secret.length) return { fruit, price: lowest };
          const secret = round.secret.includes(fruit);
          return { fruit, secret, price: secret && !revealed ? null : lowest };
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
    ring: row.ring,
    total: row.totalText,
  }));
}

// One player's own receipt: what they earned each round, half of each
// team's total, and where they finished. Only at the final standings, and
// only ever sent to that player.
function receiptView(state, playerId) {
  if (state.status !== 'final') return null;
  const standings = computeStandings(state);
  const row = standings.find((entry) => entry.id === playerId);
  if (!row) return null;
  return {
    lines: state.rounds.filter((round) => round.resolved).map((round) => ({
      round: round.n,
      earned: toMoney(round.earnings[playerId] || ZERO),
    })),
    shares: Object.keys(row.shares).sort().map((phase) => ({
      phase: Number(phase),
      partner: row.partners[phase],
      teamTotal: toMoney(row.teamTotals[phase]),
      half: toMoney(row.shares[phase]),
    })),
    total: row.totalText,
    rank: row.rank,
    tied: standings.filter((entry) => entry.rank === row.rank).length > 1,
    of: standings.length,
  };
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
  const secretRoundOpen = Boolean(round) && state.status === 'bidding' && round.n === state.config.secretRound;
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
    // While the secret round is being played every stand is curtained, and
    // the background fruit drifts past. Neither says which fruits are secret.
    curtained: secretRoundOpen,
    ambient: secretRoundOpen && round.ambient
      ? round.ambient.map(({ emoji, delay, duration }) => ({ emoji, delay, duration }))
      : null,
    announcements: state.announcements.map(({ id, round: n, name, avatar, ring, from, to, text }) => ({
      id, round: n, name, avatar, ring, from, to, text,
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
      ring: player.ring,
      fruit: player.fruit,
      changeTokens: player.tokens,
      selection: round ? round.selections[player.id] ?? null : null,
      submitted: round ? Boolean(round.submitted[player.id]) : false,
    },
    teammate: mate ? { name: mate.name, avatar: mate.avatar, ring: mate.ring, fruit: mate.fruit } : null,
    rivals: inGame ? state.players.filter((p) => p.id !== player.id && p.fruit === player.fruit).length : 0,
    changeTargets: inGame ? changeTargetsFor(state, player) : [],
    receipt: receiptView(state, player.id),
  };
}

export function screenView(state, now) {
  return {
    role: 'screen',
    ...shared(state, now),
    results: publicResults(state),
    players: state.status === 'lobby' ? state.players.map((p) => ({ name: p.name, avatar: p.avatar, ring: p.ring })) : [],
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
      ring: p.ring,
      rejoinCode: p.rejoinCode,
      fruit: p.fruit,
      submitted: round ? Boolean(round.submitted[p.id]) : false,
    })),
  };
}
