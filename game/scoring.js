import { frac, ZERO, add, div, compare, equal, toMoney } from './frac.js';

// Scores one round.
//   fruitOf: { playerId: fruitId }   bids: { playerId: price }
// Returns per-fruit results and per-player earnings (exact fractions).
export function scoreRound(fruitOf, bids) {
  const sellers = {};
  for (const [id, fruit] of Object.entries(fruitOf)) (sellers[fruit] ||= []).push(id);

  const results = {};
  const earnings = {};
  for (const [fruit, ids] of Object.entries(sellers)) {
    const units = ids.length;
    const lowest = Math.min(...ids.map((id) => bids[id]));
    const winners = ids.filter((id) => bids[id] === lowest);
    results[fruit] = { units, lowest, winners: winners.length };
    for (const id of ids) earnings[id] = ZERO;
    for (const id of winners) earnings[id] = frac(lowest * units, winners.length);
  }
  return { results, earnings };
}

// Final standings. Each player's total is half of their Phase 1 team's
// combined earnings plus half of their Phase 2 team's.
export function computeStandings(state) {
  const byId = Object.fromEntries(state.players.map((p) => [p.id, p]));
  const rows = Object.fromEntries(
    state.players.map((p) => [p.id, { id: p.id, name: p.name, avatar: p.avatar, ring: p.ring, shares: {}, partners: {}, teamTotals: {} }]),
  );

  for (const [phase, pairs] of Object.entries(state.teams)) {
    for (const pair of pairs) {
      let sum = ZERO;
      for (const round of state.rounds) {
        if (!round.resolved || String(round.phase) !== phase) continue;
        for (const id of pair) sum = add(sum, round.earnings[id] || ZERO);
      }
      const half = div(sum, 2);
      for (const id of pair) {
        rows[id].shares[phase] = half;
        rows[id].teamTotals[phase] = sum;
        rows[id].partners[phase] = byId[pair.find((other) => other !== id)]?.name ?? '';
      }
    }
  }

  const list = Object.values(rows).map((row) => {
    const total = Object.values(row.shares).reduce(add, ZERO);
    return { ...row, total, totalText: toMoney(total) };
  });
  list.sort((a, b) => compare(b.total, a.total) || a.name.localeCompare(b.name));
  list.forEach((row, i) => {
    row.rank = i > 0 && equal(row.total, list[i - 1].total) ? list[i - 1].rank : i + 1;
  });
  return list;
}
