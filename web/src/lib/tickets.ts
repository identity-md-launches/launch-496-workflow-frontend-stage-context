// Ticket state derivation mirroring PepeJackpot: status enum, 24 h lifetime, roll outcomes.
export const TICKET_LIFETIME_SECONDS = 24n * 60n * 60n;

export type TicketStatusName = 'none' | 'pending' | 'drawn' | 'expired';

export const STATUS_BY_CODE: Record<number, TicketStatusName> = { 0: 'none', 1: 'pending', 2: 'drawn', 3: 'expired' };

export interface TicketRecord {
  id: bigint;
  player: `0x${string}`;
  issuedAt: bigint;
  roll: number;
  status: TicketStatusName;
  fee: bigint;
  payout: bigint;
  deferred?: boolean;
  txHash?: `0x${string}`;
}

export type TicketOutcome =
  | { kind: 'pending'; expiresAt: bigint }
  | { kind: 'expired' }
  | { kind: 'jackpot'; roll: number; payout: bigint }
  | { kind: 'prize'; roll: number; payout: bigint }
  | { kind: 'lost'; roll: number };

/** Shows a stale pending ticket as expired even before anyone calls `expire()`. */
export function ticketOutcome(t: TicketRecord, nowSeconds: bigint): TicketOutcome {
  const expiresAt = t.issuedAt + TICKET_LIFETIME_SECONDS;
  if (t.status === 'expired') return { kind: 'expired' };
  if (t.status === 'pending') {
    if (nowSeconds >= expiresAt) return { kind: 'expired' };
    return { kind: 'pending', expiresAt };
  }
  if (t.roll === 77) return { kind: 'jackpot', roll: t.roll, payout: t.payout };
  if (t.roll % 20 === 0) return { kind: 'prize', roll: t.roll, payout: t.payout };
  return { kind: 'lost', roll: t.roll };
}

/** True when anyone may call `expire(id)` for this ticket. */
export function canExpire(t: TicketRecord, nowSeconds: bigint): boolean {
  return t.status === 'pending' && nowSeconds >= t.issuedAt + TICKET_LIFETIME_SECONDS;
}

export function describeOutcome(o: TicketOutcome): string {
  switch (o.kind) {
    case 'pending':
      return 'Waiting for the random draw';
    case 'expired':
      return 'Expired unpaid (no draw within 24 h)';
    case 'jackpot':
      return `Roll ${o.roll}: jackpot, 90% of the pot`;
    case 'prize':
      return `Roll ${o.roll}: prize, 20× the ticket fee`;
    case 'lost':
      return `Roll ${o.roll}: no prize`;
  }
}
