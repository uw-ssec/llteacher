/* --------------------------------------------------------------------------
   Probability distributions for showDistribution (#35).

   Densities and CDFs for the four families intro statistics uses, so the
   figure can state the shaded probability itself rather than repeat the
   model's. Standard numerical methods (Numerical Recipes / Abramowitz &
   Stegun): Lanczos log-gamma, the regularized incomplete beta and gamma
   functions by continued fraction and series. Accurate to ~1e-10 over the
   ranges the parser admits; lib.test.ts pins them to published table values.
   -------------------------------------------------------------------------- */

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

export function logGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let a = 0.99999999999980993;
  const t = z + 7.5;
  for (let i = 0; i < 8; i++) a += LANCZOS[i]! / (z + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Regularized lower incomplete gamma P(a, x). */
export function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  const lnPre = -x + a * Math.log(x) - logGamma(a);
  if (x < a + 1) {
    let sum = 1 / a;
    let term = sum;
    for (let n = 1; n < 500; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-15) break;
    }
    return sum * Math.exp(lnPre);
  }
  // Continued fraction for Q, Lentz's method.
  let b = x + 1 - a;
  let c = 1e300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return 1 - Math.exp(lnPre) * h;
}

function betacf(a: number, b: number, x: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < 1e-300) d = 1e-300;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 500; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
export function betaI(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

export type DistributionKind = "normal" | "t" | "binomial" | "chi-square";

export interface DistributionParams {
  mean?: number;
  sd?: number;
  df?: number;
  n?: number;
  p?: number;
}

export function pdf(kind: DistributionKind, params: DistributionParams, x: number): number {
  switch (kind) {
    case "normal": {
      const { mean = 0, sd = 1 } = params;
      const z = (x - mean) / sd;
      return Math.exp(-0.5 * z * z) / (sd * Math.sqrt(2 * Math.PI));
    }
    case "t": {
      const v = params.df!;
      return Math.exp(logGamma((v + 1) / 2) - logGamma(v / 2) - 0.5 * Math.log(v * Math.PI) - ((v + 1) / 2) * Math.log(1 + (x * x) / v));
    }
    case "chi-square": {
      const k = params.df!;
      if (x <= 0) return 0;
      return Math.exp((k / 2 - 1) * Math.log(x) - x / 2 - (k / 2) * Math.log(2) - logGamma(k / 2));
    }
    case "binomial": {
      const { n = 0, p = 0 } = params;
      if (!Number.isInteger(x) || x < 0 || x > n) return 0;
      if (p === 0) return x === 0 ? 1 : 0;
      if (p === 1) return x === n ? 1 : 0;
      return Math.exp(logGamma(n + 1) - logGamma(x + 1) - logGamma(n - x + 1) + x * Math.log(p) + (n - x) * Math.log(1 - p));
    }
  }
}

/** P(X <= x). For the binomial, x is floored (P(X <= floor(x))). */
export function cdf(kind: DistributionKind, params: DistributionParams, x: number): number {
  switch (kind) {
    case "normal": {
      const { mean = 0, sd = 1 } = params;
      const z = (x - mean) / sd;
      // Phi(z) = P(1/2, z^2/2)/2 + 1/2 for z >= 0, by symmetry otherwise.
      const half = 0.5 * gammaP(0.5, (z * z) / 2);
      return z >= 0 ? 0.5 + half : 0.5 - half;
    }
    case "t": {
      const v = params.df!;
      const tail = 0.5 * betaI(v / 2, 0.5, v / (v + x * x));
      return x >= 0 ? 1 - tail : tail;
    }
    case "chi-square":
      return x <= 0 ? 0 : gammaP(params.df! / 2, x / 2);
    case "binomial": {
      const { n = 0 } = params;
      const k = Math.floor(x);
      if (k < 0) return 0;
      if (k >= n) return 1;
      let sum = 0;
      for (let i = 0; i <= k; i++) sum += pdf("binomial", params, i);
      return Math.min(1, sum);
    }
  }
}

/** P(from <= X <= to), either end open (undefined). Inclusive integer
 *  bounds for the binomial, so P(X >= 8) includes 8. */
export function intervalProbability(kind: DistributionKind, params: DistributionParams, from?: number, to?: number): number {
  if (kind === "binomial") {
    const lo = from === undefined ? 0 : Math.ceil(from);
    const hi = to === undefined ? params.n! : Math.floor(to);
    if (hi < lo) return 0;
    return Math.max(0, cdf(kind, params, hi) - (lo > 0 ? cdf(kind, params, lo - 1) : 0));
  }
  const upper = to === undefined ? 1 : cdf(kind, params, to);
  const lower = from === undefined ? 0 : cdf(kind, params, from);
  return Math.max(0, upper - lower);
}

/** The x-range a figure should show for the family. */
export function displayDomain(kind: DistributionKind, params: DistributionParams): [number, number] {
  switch (kind) {
    case "normal": {
      const { mean = 0, sd = 1 } = params;
      return [mean - 4 * sd, mean + 4 * sd];
    }
    case "t": {
      const v = params.df!;
      const w = v <= 2 ? 8 : v <= 5 ? 6 : 4.5;
      return [-w, w];
    }
    case "chi-square": {
      const k = params.df!;
      return [0, Math.max(8, k + 5 * Math.sqrt(2 * k))];
    }
    case "binomial":
      return [0, params.n!];
  }
}

export function mean(kind: DistributionKind, params: DistributionParams): number {
  switch (kind) {
    case "normal": return params.mean ?? 0;
    case "t": return 0;
    case "chi-square": return params.df!;
    case "binomial": return params.n! * params.p!;
  }
}
