/**
 * The commission of a deal (R2-04a, PLAN §3 #9 / #10): integer cents and basis points only, never floats.
 *
 * - total = the fixed amount, or price × `commissionBp` / 10,000 rounded **half-up to the cent** (ties away from zero;
 *   every value is ≥ 0);
 * - the introducer's (collaborating agent's) share = total × `splitBp` / 10,000, half-up to the cent, from the rounded
 *   total;
 * - the owner's share = total − the introducer's share, so the two always add up to the total exactly.
 *
 * The database computes the same in the generated columns of `deals` (`(x * bp + 5000) / 10000` on bigint) — the
 * amounts a deal answers are the database's; this is the reference the tests hold both to. BigInt throughout: price ×
 * bp exceeds `Number.MAX_SAFE_INTEGER` for prices above ~9 bn cents.
 */

export interface CommissionTerms {
  commissionBp: number | null;
  commissionFixedCents: number | null;
  splitBp: number;
}

export interface CommissionAmounts {
  totalCents: number;
  introducerShareCents: number;
  ownerShareCents: number;
}

const BP = 10_000n;
const HALF = 5_000n;

/** `amount × bp / 10,000`, half-up to the cent, for `amount ≥ 0` and `0 ≤ bp ≤ 10,000`. */
export function applyBp(amountCents: bigint, bp: bigint): bigint {
  if (amountCents < 0n || bp < 0n || bp > BP) throw new RangeError('mls: commission inputs out of range');
  return (amountCents * bp + HALF) / BP;
}

export function commissionOf(priceCents: number, terms: CommissionTerms): CommissionAmounts {
  if (!Number.isSafeInteger(priceCents) || priceCents < 1) throw new RangeError('mls: price must be positive cents');
  const total =
    terms.commissionBp !== null
      ? applyBp(BigInt(priceCents), BigInt(terms.commissionBp))
      : BigInt(terms.commissionFixedCents ?? Number.NaN);
  const share = applyBp(total, BigInt(terms.splitBp));
  return {
    totalCents: Number(total),
    introducerShareCents: Number(share),
    ownerShareCents: Number(total - share),
  };
}
