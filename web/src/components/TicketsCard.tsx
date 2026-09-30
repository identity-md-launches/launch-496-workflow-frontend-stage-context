// The connected player's tickets, results, claimable winnings, claim() and expire().
import { useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import { useContractRef, useDeployment } from '../DeploymentContext';
import { useGate } from '../hooks/useGate';
import { type DependencyStatus, useClaimable } from '../hooks/useJackpot';
import { useTickets } from '../hooks/useTickets';
import { useTx } from '../hooks/useTx';
import { explorerTxUrl, formatAmount, formatCountdown, formatDateTime } from '../lib/format';
import { canExpire, describeOutcome, ticketOutcome, type TicketRecord } from '../lib/tickets';
import { ActionButton, Card, Notice, TxStatusLine } from './ui';

function useNowSeconds(): bigint {
  const [now, setNow] = useState(() => BigInt(Math.floor(Date.now() / 1000)));
  useEffect(() => {
    const t = setInterval(() => setNow(BigInt(Math.floor(Date.now() / 1000))), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function TicketItem({ ticket, now, disabledReason }: { ticket: TicketRecord; now: bigint; disabledReason?: string }) {
  const dep = useDeployment();
  const jackpot = useContractRef('PepeJackpot');
  const tx = useTx();
  const outcome = ticketOutcome(ticket, now);
  const badge =
    outcome.kind === 'jackpot' ? 'win' : outcome.kind === 'prize' ? 'win' : outcome.kind === 'pending' ? 'accent' : outcome.kind === 'expired' ? 'danger' : '';
  const txLink = ticket.txHash ? explorerTxUrl(dep.network?.explorer, ticket.txHash) : undefined;
  return (
    <li className="ticket">
      <div className="ticket-head">
        <span>
          <strong>Ticket</strong> <span className="mono">#{ticket.id.toString().slice(0, 10)}…</span>
        </span>
        <span className={`badge ${badge}`}>
          {outcome.kind === 'pending' ? 'Pending' : outcome.kind === 'expired' ? 'Expired' : outcome.kind === 'lost' ? 'No prize' : outcome.kind === 'jackpot' ? 'Jackpot' : 'Prize'}
        </span>
      </div>
      <p className="small">{describeOutcome(outcome)}</p>
      <dl className="kv">
        <dt>Issued</dt>
        <dd>{formatDateTime(ticket.issuedAt)}</dd>
        <dt>Ticket fee</dt>
        <dd className="num">{formatAmount(ticket.fee, 18, 2)} ICE</dd>
        {outcome.kind === 'pending' ? (
          <>
            <dt>Draw window</dt>
            <dd>{formatCountdown(outcome.expiresAt, Number(now) * 1000)}</dd>
          </>
        ) : null}
        {(outcome.kind === 'jackpot' || outcome.kind === 'prize') ? (
          <>
            <dt>Payout</dt>
            <dd className="num">
              {formatAmount(outcome.payout, 18, 2)} ICE{ticket.deferred ? ' (held for claim)' : ''}
            </dd>
          </>
        ) : null}
        {txLink ? (
          <>
            <dt>Transaction</dt>
            <dd>
              <a href={txLink} target="_blank" rel="noreferrer">
                View on the explorer
              </a>
            </dd>
          </>
        ) : null}
      </dl>
      {canExpire(ticket, now) ? (
        <>
          <ActionButton
            variant="secondary"
            small
            pending={tx.inFlight}
            pendingLabel="Marking expired…"
            disabledReason={disabledReason}
            onClick={() => tx.run({ address: jackpot.address, abi: jackpot.abi, functionName: 'expire', args: [ticket.id], label: 'Expire ticket' })}
          >
            Mark ticket expired
          </ActionButton>
          <TxStatusLine state={tx.state} />
        </>
      ) : null}
    </li>
  );
}

export function TicketsCard({ status }: { status: DependencyStatus }) {
  const { address, isConnected } = useAccount();
  const jackpot = useContractRef('PepeJackpot');
  const gate = useGate('PepeJackpot');
  const claimable = useClaimable();
  const tickets = useTickets();
  const claimTx = useTx();
  const now = useNowSeconds();
  const claimableAmount = (claimable.data as bigint | undefined) ?? 0n;
  const claimReason = gate.reason ?? status.reason ?? (claimableAmount === 0n ? 'Nothing is held for claim on this address.' : undefined);

  return (
    <Card title="Your tickets" lede="Tickets issued to the connected address, their draws and any winnings held for claim." className="span-2">
      {!isConnected || !address ? (
        <Notice>Connect a wallet to see its tickets and results.</Notice>
      ) : (
        <>
          <div className="stat-row">
            <div className="stat">
              <span className="label">Held for claim</span>
              <span className="value num" style={{ fontSize: 'var(--text-h2)' }}>
                {claimable.isLoading ? '…' : formatAmount(claimableAmount, 18, 2)}
                <small>ICE</small>
              </span>
            </div>
            <div className="stat" style={{ justifyContent: 'end' }}>
              <ActionButton
                pending={claimTx.inFlight}
                pendingLabel="Claiming…"
                disabledReason={claimReason}
                onClick={() => claimTx.run({ address: jackpot.address, abi: jackpot.abi, functionName: 'claim', label: 'Claim winnings' })}
              >
                Claim winnings
              </ActionButton>
            </div>
          </div>
          <TxStatusLine state={claimTx.state} />
          {tickets.isLoading ? (
            <p className="small muted" role="status">
              Loading tickets…
            </p>
          ) : tickets.isError ? (
            <Notice kind="danger">Unable to load tickets from the RPC endpoint. Retry in a moment.</Notice>
          ) : tickets.data && tickets.data.length > 0 ? (
            <ul className="ticket-list" aria-label="Tickets">
              {tickets.data.map((t) => (
                <TicketItem key={t.id.toString()} ticket={t} now={now} disabledReason={gate.reason ?? status.reason} />
              ))}
            </ul>
          ) : (
            <div>
              <p style={{ fontWeight: 600 }}>No tickets yet</p>
              <p className="small muted">A fridge swap or golden throne trade at or above its threshold issues a ticket to the trading address.</p>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
