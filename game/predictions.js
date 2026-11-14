// Scoring for the "Predictors vs Host" side game. Pure functions over the
// final standings; nothing here is sent anywhere before the reveal.

import { HOST_ID, predictionOf } from './engine.js';
import { computeStandings } from './scoring.js';
import { add, div, toMoney } from './frac.js';

export const POINTS_PER_QUESTION = 5;
export const HOST_SEAT = { id: HOST_ID, name: 'Host', avatar: '🎤', ring: '#3a281a' };

const centsOf = (amount) => Math.round(Number(toMoney(amount)) * 100);
export const centsText = (cents) => (cents / 100).toFixed(2);

// The average of the totals at the two middle positions (N/2 and N/2+1).
export function medianTotal(standings) {
  const half = standings.length / 2;
  return div(add(standings[half - 1].total, standings[half].total), 2);
}

// 5 points for a guess within 50 cents, one fewer for each dollar further
// out. Both amounts are whole cents; a half rounds up.
export function medianPoints(guessCents, actualCents) {
  if (guessCents === null) return 0;
  const off = Math.floor((Math.abs(guessCents - actualCents) + 50) / 100);
  return Math.max(0, POINTS_PER_QUESTION - off);
}

// Rank 1 scores 5, rank 2 scores 4 ... rank 5 scores 1. Ties share a rank.
export function winnerPoints(rank) {
  return rank === null ? 0 : Math.max(0, POINTS_PER_QUESTION + 1 - rank);
}

// How far a player finished from the two middle positions. A tied group
// shares its rank and fills the positions from that rank downwards, so the
// whole group counts as being wherever any of its members is.
export function middleDistance(rank, tiedCount, playerCount) {
  const upper = playerCount / 2;
  const lower = upper + 1;
  const first = rank;
  const last = rank + tiedCount - 1;
  if (last < upper) return upper - last;
  if (first > lower) return first - lower;
  return 0;
}

export function middlePoints(distance) {
  return distance === null ? 0 : Math.max(0, POINTS_PER_QUESTION - distance);
}

// Everything the reveal needs: the actual answers, each entrant's answers
// and points, and who won. Entrants are the predictors, then the host.
export function scorePredictions(state, standings = computeStandings(state)) {
  const count = standings.length;
  const rowOf = Object.fromEntries(standings.map((row) => [row.id, row]));
  const tiedAt = (rank) => standings.filter((row) => row.rank === rank).length;
  const actualCents = centsOf(medianTotal(standings));
  const face = (row) => ({ id: row.id, name: row.name, avatar: row.avatar, ring: row.ring });
  const place = (row) => ({ ...face(row), rank: row.rank, tied: tiedAt(row.rank) > 1 });

  const entries = [...state.predictors, HOST_SEAT].map((seat) => {
    const { medianCents, winner, middle } = predictionOf(state, seat.id);
    const winnerRow = rowOf[winner] || null;
    const middleRow = rowOf[middle] || null;
    const distance = middleRow ? middleDistance(middleRow.rank, tiedAt(middleRow.rank), count) : null;
    const points = {
      median: medianPoints(medianCents, actualCents),
      winner: winnerPoints(winnerRow ? winnerRow.rank : null),
      middle: middlePoints(distance),
    };
    return {
      id: seat.id,
      name: seat.name,
      avatar: seat.avatar,
      ring: seat.ring,
      isHost: seat.id === HOST_ID,
      median: {
        guess: medianCents === null ? null : centsText(medianCents),
        off: medianCents === null ? null : centsText(Math.abs(medianCents - actualCents)),
        points: points.median,
      },
      winner: { pick: winnerRow ? place(winnerRow) : null, points: points.winner },
      middle: { pick: middleRow ? place(middleRow) : null, away: distance, points: points.middle },
      score: points.median + points.winner + points.middle,
      medianOffCents: medianCents === null ? Infinity : Math.abs(medianCents - actualCents),
    };
  });

  // Highest score wins; a tie goes to whoever was closer on the median.
  const sameSpot = (a, b) => a.score === b.score && a.medianOffCents === b.medianOffCents;
  const ordered = [...entries].sort((a, b) => b.score - a.score || a.medianOffCents - b.medianOffCents);
  const best = ordered[0];
  const champions = entries.filter((e) => sameSpot(e, best));
  const tiedOnScore = entries.filter((e) => e.score === best.score).length;
  ordered.forEach((entry, i) => {
    entry.place = i > 0 && sameSpot(entry, ordered[i - 1]) ? ordered[i - 1].place : i + 1;
  });
  for (const entry of entries) {
    entry.won = champions.includes(entry);
    delete entry.medianOffCents;
  }

  return {
    playerCount: count,
    maxScore: POINTS_PER_QUESTION * 3,
    actual: {
      median: centsText(actualCents),
      first: standings.filter((row) => row.rank === 1).map(face),
      middlePositions: [count / 2, count / 2 + 1],
      middle: standings.filter((row) => middleDistance(row.rank, tiedAt(row.rank), count) === 0).map(place),
    },
    entries,
    champions: champions.map((e) => e.id),
    draw: champions.length > 1,
    tieBroken: champions.length === 1 && tiedOnScore > 1,
  };
}
