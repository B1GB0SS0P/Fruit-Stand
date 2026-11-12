import { fruitName, teammateOf, findPlayer } from './engine.js';
import { computeStandings } from './scoring.js';
import { toMoney, ZERO } from './frac.js';

const BID_TYPES = {
  submitted: 'submitted',
  host: 'set by host',
  auto_selected: 'auto (selected but not submitted)',
  auto_max: 'auto (no bid so max price)',
};

function cell(value) {
  let text = String(value ?? '');
  // Stop spreadsheet apps treating a player's name as a formula.
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const line = (values) => values.map(cell).join(',');

// Full results. Only available once the final standings are showing.
export function resultsCsv(state) {
  if (state.status !== 'final') throw new Error('Results are only available after the game ends.');
  const { config } = state;
  const lines = [];

  lines.push(line(['Round', 'Phase', 'Player', 'Teammate', 'Fruit', 'Secret fruit', 'Bid', 'Bid type', 'Fruit lowest price', 'Earnings']));
  for (const round of state.rounds) {
    for (const player of state.players) {
      const fruit = round.fruitOf[player.id];
      lines.push(line([
        round.n,
        round.phase,
        player.name,
        teammateOf(state, player.id, round.phase)?.name ?? '',
        fruitName(config, fruit),
        round.secret.includes(fruit) ? 'yes' : 'no',
        round.selections[player.id],
        BID_TYPES[round.bidType[player.id]],
        round.results[fruit].lowest,
        toMoney(round.earnings[player.id]),
      ]));
    }
  }

  lines.push('');
  lines.push(line(['Secret fruits']));
  lines.push(line(['Round', 'Fruit', 'Lowest price']));
  for (const round of state.rounds) {
    for (const fruit of round.secret) {
      lines.push(line([round.n, fruitName(config, fruit), round.results[fruit]?.lowest ?? 'no sellers']));
    }
  }

  lines.push('');
  lines.push(line(['Final standings']));
  lines.push(line(['Rank', 'Player', 'Phase 1 partner', 'Phase 1 share', 'Phase 2 partner', 'Phase 2 share', 'Total']));
  for (const row of computeStandings(state)) {
    lines.push(line([
      row.rank,
      findPlayer(state, row.id).name,
      row.partners[1] ?? '',
      toMoney(row.shares[1] ?? ZERO),
      row.partners[2] ?? '',
      toMoney(row.shares[2] ?? ZERO),
      row.totalText,
    ]));
  }
  return lines.join('\r\n') + '\r\n';
}
