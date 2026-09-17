// Money formatting. Prices come in dollars with up to 4 decimals.
// All rounding happens on integers so float noise never flips a digit.

/** Integer ten thousandths of a dollar. Safe for inputs with at most 4 decimals. */
export function toUnits(dollars: number): number {
  return Math.round(dollars * 10000);
}

/** Round a non negative integer by a power of ten step, half up. */
function roundHalfUp(units: number, step: number): number {
  return Math.floor((units + step / 2) / step);
}

/** Price rounded to thousandths of a dollar (tenths of a cent), half away from zero. */
export function toMills(price: number): number {
  const units = toUnits(price);
  const sign = units < 0 ? -1 : 1;
  return sign * roundHalfUp(Math.abs(units), 10);
}

export interface PriceParts {
  /** "$6.28" */
  main: string;
  /** "5", the raised tenth of a cent */
  tenth: string;
  /** "$6.285" */
  plain: string;
}

export function priceParts(price: number): PriceParts {
  const mills = toMills(price);
  if (mills < 0) throw new RangeError(`negative price ${price}`);
  const dollars = Math.floor(mills / 1000);
  const cents = Math.floor((mills % 1000) / 10);
  const tenth = mills % 10;
  const main = `$${dollars}.${String(cents).padStart(2, "0")}`;
  return { main, tenth: String(tenth), plain: `${main}${tenth}` };
}

/** "$6.285" */
export function formatPrice(price: number): string {
  return priceParts(price).plain;
}

/** "$6.285 per gallon" for screen readers. */
export function spokenPrice(price: number): string {
  return `${formatPrice(price)} per gallon`;
}

const MINUS = "−";

/** Signed change in tenths of a cent, rounded half away from zero. 0.318 -> 318. */
export function changeTenths(change: number): number {
  const units = toUnits(change); // hundredths of a cent
  const sign = units < 0 ? -1 : 1;
  const t = roundHalfUp(Math.abs(units), 10);
  return t === 0 ? 0 : sign * t;
}

function tenthsString(t: number): string {
  const a = Math.abs(t);
  return `${Math.floor(a / 10)}.${a % 10}`;
}

/** Absolute change in cents with one decimal: "31.8¢". */
export function formatCents(change: number): string {
  return `${tenthsString(changeTenths(change))}¢`;
}

/** Signed change in cents: "+31.8¢", "−12.0¢", "0.0¢". */
export function formatSignedCents(change: number): string {
  const t = changeTenths(change);
  const sign = t > 0 ? "+" : t < 0 ? MINUS : "";
  return `${sign}${tenthsString(t)}¢`;
}

/** Percent with one decimal and a sign: "+5.3%", "−2.1%", "0.0%". */
export function formatPct(pct: number): string {
  const sign = pct < 0 ? -1 : 1;
  // One rounding, straight to tenths of a percent, half away from zero. Rounding
  // twice (to hundredths and then to tenths) pushes an x.xx45 percent up a whole
  // 0.1pp. The epsilon absorbs binary representation slop so an exact x.x5 tie,
  // which a double can hold just under, still rounds up.
  const t = Math.floor(Math.abs(pct) * 10 + 0.5 + 1e-9);
  const s = t === 0 ? "" : sign > 0 ? "+" : MINUS;
  return `${s}${Math.floor(t / 10)}.${t % 10}%`;
}

/** Percent change from the raw numbers when the data file has none. */
export function pctFrom(change: number, prev: number): number {
  return (toUnits(change) / toUnits(prev)) * 100;
}

/** "31.8¢ (+5.3%)". The glyph carries direction, the percent carries the sign. */
export function formatChange(change: number, pct: number | null): string {
  const cents = formatCents(change);
  return pct === null ? cents : `${cents} (${formatPct(pct)})`;
}

/** "up 31.8 cents", "down 12.0 cents", "no change". */
export function spokenChange(change: number): string {
  const t = changeTenths(change);
  if (t === 0) return "no change";
  return `${t > 0 ? "up" : "down"} ${tenthsString(t)} cents`;
}

/** "rose 31.8¢" style verb for sentences. */
export function changeVerb(change: number): string {
  const t = changeTenths(change);
  if (t === 0) return "held steady";
  return `${t > 0 ? "rose" : "fell"} ${formatCents(change)}`;
}

/** Axis tick label: "$6.00", "$5.50". */
export function formatTick(price: number): string {
  const cents = Math.round(price * 100);
  return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
