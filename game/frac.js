// Exact fractions, so split earnings like $5 ÷ 3 never lose cents.

function gcd(a, b) {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

export function frac(n, d = 1) {
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}

export const ZERO = frac(0, 1);

export function add(a, b) {
  return frac(a.n * b.d + b.n * a.d, a.d * b.d);
}

export function div(a, k) {
  return frac(a.n, a.d * k);
}

export function compare(a, b) {
  return a.n * b.d - b.n * a.d;
}

export function equal(a, b) {
  return compare(a, b) === 0;
}

export function toNumber(a) {
  return a.n / a.d;
}

export function toMoney(a) {
  return toNumber(a).toFixed(2);
}
