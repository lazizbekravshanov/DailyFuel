// Money formatting. Prices come in dollars with up to 4 decimals.
// All rounding happens on integers so float noise never flips a digit.
//
// How money prints on the paper terminal:
//   a price in a heading      $6.285      formatPrice
//   a price in a table cell   6.285       formatQuote (the column head says $)
//   a change                  +31.8¢ +5.3%   formatMove, or formatSignedCents
//                             and formatPct on their own
//   a change in a table cell  +31.8 and +5.3    signedCents and signedPct
// The sign carries the direction, so nothing else has to. A real minus sign,
// not a hyphen. A price is one string: the raised tenth of a cent went with
// the road sign, and priceParts (its "$6.28" and "5") with it.

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

/** "$6.285": dollars to the tenth of a cent, rounded half away from zero. */
export function formatPrice(price: number): string {
  const mills = toMills(price);
  if (mills < 0) throw new RangeError(`negative price ${price}`);
  return `$${Math.floor(mills / 1000)}.${String(mills % 1000).padStart(3, "0")}`;
}

/** "6.285": a price in a table cell, where the column head says it is dollars. */
export function formatQuote(price: number): string {
  return formatPrice(price).slice(1);
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

/** The sign a change in cents wears: "+", "−", or none when it rounds to 0.0¢. */
export function centsSign(change: number): string {
  const t = changeTenths(change);
  return t > 0 ? "+" : t < 0 ? MINUS : "";
}

/** Signed change in cents: "+31.8¢", "−12.0¢", "0.0¢". */
export function formatSignedCents(change: number): string {
  return `${centsSign(change)}${formatCents(change)}`;
}

/** Signed cents with no unit, for a table cell under a "CHG ¢" head: "+31.8", "−4.2", "0.0". */
export function signedCents(change: number): string {
  return `${centsSign(change)}${tenthsString(changeTenths(change))}`;
}

/** The class a change wears: "up" when it rose, "down" when it fell, none when it rounds to 0.0¢ or there is no change. */
export function changeClass(change: number | null): "up" | "down" | "" {
  if (change === null) return "";
  const t = changeTenths(change);
  return t > 0 ? "up" : t < 0 ? "down" : "";
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

/** Signed percent with no unit, for a table cell under a "%CHG" head: "+5.3", "−2.1", "0.0". */
export function signedPct(pct: number): string {
  return formatPct(pct).slice(0, -1);
}

/** Percent change from the raw numbers when the data file has none. */
export function pctFrom(change: number, prev: number): number {
  return (toUnits(change) / toUnits(prev)) * 100;
}

/**
 * "+31.8¢ +5.3%": a change the way the paper terminal prints it. The sign
 * carries the direction, so a move too small for the percent to show one
 * still says which way it went: "+0.1¢ 0.0%". Without a percent, "+31.8¢".
 */
export function formatMove(change: number, pct: number | null): string {
  const cents = formatSignedCents(change);
  return pct === null ? cents : `${cents} ${formatPct(pct)}`;
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
