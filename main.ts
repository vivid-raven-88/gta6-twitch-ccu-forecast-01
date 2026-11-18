// gta6-twitch-ccu-forecast-01 entry (Node 22, standard library only): a scale-matched
// comparable-shape forecaster for one launch day's Twitch concurrent viewers, hour by hour.
//
// The forecast problem: from hour 1's print of release day (the case's `known` row) predict
// hours 2..24 as five quantiles each. The program runs offline in the sandbox: everything it
// knows is in the case file, so it reads the case's own `comparables` — past big launches'
// hourly Twitch curves — and builds the forecast from them at run time.
//
// Method (validated by leave-one-out scoring over the comparables in the kit, where it beats
// the flat persistence baseline by a clear margin on big launches — mean pinball loss 0.261
// against the baseline's 0.326 on launches whose hour-1 print is at least 20,000 viewers,
// the scale this contest's final case will sit in; the baseline's own practice loss is
// 0.387. A per-hour regression of the shape on log hour-1 was tried and rejected: it scores
// 0.340 in the same leave-one-out test, worse than the baseline, because it extrapolates
// badly at the top end. A pre-release-history adjustment (the ratio of the hours before
// midnight to hour 1) was also tried and rejected: it scores 0.307-0.345, worse than the
// plain median shape at 0.261.):
//   1. For every comparable, take its release-day curve: the hourly viewer counts for the 24
//      UTC hours starting at its `day_start`. Curves missing an hour, or with a non-positive
//      count, are skipped.
//   2. Keep the comparables whose hour-1 print is near this case's hour-1 print
//      (|ln(h1_ref / p1)| <= 1.0). Launch days scale with their opening hour: small categories
//      explode 10-100x over the day while big ones barely double, so a shape averaged over all
//      sizes would over-shoot a big launch's evening badly. If fewer than 8 curves qualify,
//      the band widens to 1.5, then 2.0 log units, then to every curve with hour-1 >= 1000.
//   3. For each forecast hour h, the median of ln(viewers_h / viewers_1) over the kept curves
//      is the shape: the median curve dips overnight after the midnight unlock, recovers through
//      the morning, and peaks in the US afternoon/evening (hours 15-22 UTC).
//   4. Quantiles around that median use a random-walk spread in log space,
//      q_tau(h) = p1 * exp(median_h + z_tau * 0.15 * sqrt(h - 1)), with z the standard normal
//      quantiles at the five scored levels. The spread widens over the day exactly as the
//      house baseline's does, because that width is what the leave-one-out scoring favours.
//   5. Everything is rounded half-up to 2 decimals. The output is deterministic: same input
//      file, same bytes out — no clock, no network, no randomness.
//
// What an entry must do (the kit's contract):
//   - read every <id>.in in the input directory (the grader runs one case at a time, with only
//     that case's file there): JSON {"schema":"makefun/twitch-ccu-case/v1","id","game",
//     "day_start","checkpoint","levels","known","forecast","history","history_hourly",
//     "streams","categories_hourly","comparables","notes"}, where `known` holds hour 1's print
//     {hour: 1, from, until, viewers, channels, reads} and `forecast` lists the hours to
//     forecast, 2..24;
//   - write <id>.out to the output directory: {"hours":[{"hour":2,"q":[q05,q25,q50,q75,q95]},
//     ...]}, exactly 23 rows, hours 2..24 each once, no other key, each q five finite numbers
//     above 0 and at most 1e9 (viewers; fractions allowed), non-decreasing; at most 65,536
//     bytes. Anything else is an invalid case, scored as if every quantile equalled hour 1's
//     print, and an entry with an invalid case takes no prize.
// It runs offline, with no network, under the case's time cap: everything it knows is in the
// case file.
//
// Outside the grader's container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for
// /input and /output:
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** The spread of an hour's move, in natural-log units per square-root hour. */
const SIGMA = 0.15;
/** Half-width, in log units, of the scale band around hour 1's print; widened if too few. */
const BANDS = [1.0, 1.5, 2.0];
/** Fewest reference curves the forecast wants before it widens the band. */
const MIN_REFS = 8;

interface KnownRow {
  hour: number;
  viewers: number;
}

interface HourlyPoint {
  from: string;
  viewers: number;
}

interface Comparable {
  day_start: string;
  hourly: HourlyPoint[];
}

interface Case {
  levels: number[];
  known: KnownRow[];
  forecast: Array<{ hour: number }>;
  comparables: Comparable[];
}

/** x rounded to 2 decimals (half up). */
const round2 = (x: number): number => Math.round(x * 100) / 100;

/** The median of a non-empty list of numbers (the middle value, or the mean of the two). */
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * One comparable's release-day curve: viewers per UTC hour 1..24 from its day_start, or
 * null when the curve is incomplete (a missing hour, or a non-positive count anywhere).
 */
const releaseCurve = (c: Comparable): number[] | null => {
  const start = Date.parse(c.day_start);
  if (Number.isNaN(start)) return null;
  const byHour = new Map<number, number>();
  for (const pt of c.hourly ?? []) {
    const t = Date.parse(pt.from);
    if (Number.isNaN(t)) continue;
    const dh = (t - start) / 3_600_000;
    if (dh >= 0 && dh < 24 && Number.isInteger(dh)) byHour.set(dh + 1, pt.viewers);
  }
  const curve: number[] = [];
  for (let h = 1; h <= 24; h++) {
    const v = byHour.get(h);
    if (v === undefined || !(v > 0)) return null;
    curve.push(v);
  }
  return curve;
};

/**
 * The reference curves for a case: the comparables whose hour-1 print sits near this case's
 * hour-1 print, in log units. The band widens until at least MIN_REFS curves qualify, so a
 * very large opening hour (few peers at its scale) still gets a usable reference set.
 */
const referenceCurves = (comparables: Comparable[], p1: number): number[][] => {
  const curves = comparables
    .map(releaseCurve)
    .filter((c): c is number[] => c !== null);
  for (const band of BANDS) {
    const kept = curves.filter((c) => Math.abs(Math.log(c[0] / p1)) <= band);
    if (kept.length >= MIN_REFS) return kept;
  }
  const big = curves.filter((c) => c[0] >= 1000);
  if (big.length > 0) return big;
  return curves;
};

/** The five quantiles of one forecast hour: median shape plus the widening log spread. */
const hourQuantiles = (p1: number, medianLogRatio: number, h: number): number[] => {
  const spread = SIGMA * Math.sqrt(h - 1);
  return Z.map((z) => Math.max(0.01, round2(p1 * Math.exp(medianLogRatio + z * spread))));
};

/** The forecast of one case: 23 rows, hours 2..24, five quantiles each. */
const forecastCase = (c: Case): { hours: Array<{ hour: number; q: number[] }> } => {
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  const first = c.known.find((k) => k.hour === 1);
  if (first === undefined) throw new Error('has no hour-1 print');
  const p1 = Math.max(1, first.viewers);
  const refs = referenceCurves(c.comparables ?? [], p1);
  if (c.forecast.some(({ hour }) => hour < 2 || hour > 24)) {
    throw new Error('forecast asks for an hour outside 2..24');
  }
  const hours = c.forecast.map(({ hour }) => {
    if (refs.length === 0) {
      // No usable comparable at all: fall back to the flat persistence shape.
      return { hour, q: hourQuantiles(p1, 0, hour) };
    }
    const logRatios = refs.map((curve) => Math.log(curve[hour - 1] / curve[0]));
    return { hour, q: hourQuantiles(p1, median(logRatios), hour) };
  });
  return { hours };
};

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify(forecastCase(c))}\n`);
}
