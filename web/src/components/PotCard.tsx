// Pot, reserved winnings, VRF fee and the ticket rules, read live from PepeJackpot.
import { useContractRef, useDeployment } from '../DeploymentContext';
import { type DependencyStatus, type JackpotDependencies, useJackpotState } from '../hooks/useJackpot';
import { formatAmount } from '../lib/format';
import { AddressDisplay, Card, Notice } from './ui';

export function PotCard({ deps, status }: { deps: JackpotDependencies | undefined; status: DependencyStatus }) {
  const dep = useDeployment();
  const jackpot = useContractRef('PepeJackpot');
  const s = useJackpotState();
  const potUnavailable = s.potError !== undefined;
  return (
    <Card title="Jackpot pot" lede="ICE held by the jackpot, minus winnings reserved for claims. Leaves only as payouts." className="span-2">
      <div className="stat-row">
        <div className="stat">
          <span className="label">Available pot</span>
          <span className="value num" aria-live="polite">
            {potUnavailable ? 'Unavailable' : s.isLoading ? '…' : formatAmount(s.pot, 18, 2)}
            {!potUnavailable && !s.isLoading ? <small>ICE</small> : null}
          </span>
        </div>
        <div className="stat">
          <span className="label">Reserved for claims</span>
          <span className="value num" style={{ fontSize: 'var(--text-h2)' }}>
            {s.totalClaimable === undefined ? '—' : formatAmount(s.totalClaimable, 18, 2)}
            <small>ICE</small>
          </span>
        </div>
        <div className="stat">
          <span className="label">Randomness fee per ticket</span>
          <span className="value num" style={{ fontSize: 'var(--text-h2)' }}>
            {s.vrfFee === undefined ? 'Unavailable' : formatAmount(s.vrfFee, 18, 6)}
            {s.vrfFee !== undefined ? <small>{dep.chain.nativeCurrency.symbol}</small> : null}
          </span>
        </div>
      </div>

      {status.reason ? (
        <Notice kind="danger" title="Jackpot actions are unavailable on this network">
          <p>{status.reason}</p>
          <p>
            The contract was built for Ethereum mainnet dependencies; on {dep.chain.name} the pot, quotes and every trade revert. Reads of the
            token balance and the ticket rules still work, and the PJACK launch pool below is live.
          </p>
        </Notice>
      ) : potUnavailable ? (
        <Notice kind="danger">Unable to read the pot from the RPC endpoint. Check the connection and retry.</Notice>
      ) : null}

      <div className="table-wrap">
        <table className="table">
          <caption className="sr-only">Ticket rules read from the contract</caption>
          <thead>
            <tr>
              <th scope="col">Trade</th>
              <th scope="col" className="num">
                Ticket threshold
              </th>
              <th scope="col">Pot contribution</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Fridge: sell ICE for IMD</td>
              <td className="num">{formatAmount(s.iceTicketMin, 18, 0)} ICE in</td>
              <td>1% of the ICE sold</td>
            </tr>
            <tr>
              <td>Fridge: buy ICE with IMD</td>
              <td className="num">{formatAmount(s.imdTicketMin, 18, 4)} IMD in</td>
              <td>1% of the ICE bought</td>
            </tr>
            <tr>
              <td>Golden throne: ETH to IMD</td>
              <td className="num">
                {formatAmount(s.ethTicketMin, 18, 4)} {dep.chain.nativeCurrency.symbol} in
              </td>
              <td>1% of the ETH buys ICE for the pot</td>
            </tr>
            <tr>
              <td>Tank fill</td>
              <td className="num">No ticket</td>
              <td>{formatAmount(s.icePerPee, 18, 0)} ICE per pee</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="small muted">
        Each eligible trade issues one ticket. The draw rolls 1–100: 77 pays 90% of the pot; 20, 40, 60, 80 or 100 pays 20× the ticket fee,
        capped at 10% of the pot. A ticket not drawn within {s.ticketLifetime ? `${Number(s.ticketLifetime) / 3600} hours` : '24 hours'} expires
        unpaid.
      </p>

      <dl className="kv">
        <dt>PepeJackpot</dt>
        <dd>
          <AddressDisplay address={jackpot.address} label="PepeJackpot address" full />
        </dd>
        {deps ? (
          <>
            <dt>ICE token</dt>
            <dd>
              <AddressDisplay address={deps.ice} label="ICE address" full />
              {status.missing.some((m) => m.name === 'ice') ? <span className="badge danger" style={{ marginInlineStart: 8 }}>no code</span> : null}
            </dd>
            <dt>IMD token</dt>
            <dd>
              <AddressDisplay address={deps.imd} label="IMD address" full />
              {status.missing.some((m) => m.name === 'imd') ? <span className="badge danger" style={{ marginInlineStart: 8 }}>no code</span> : null}
            </dd>
            <dt>VRF wrapper</dt>
            <dd>
              <AddressDisplay address={deps.vrfWrapper} label="VRF wrapper address" full />
              {status.missing.some((m) => m.name === 'vrfWrapper') ? <span className="badge danger" style={{ marginInlineStart: 8 }}>no code</span> : null}
            </dd>
            <dt>Pool manager</dt>
            <dd>
              <AddressDisplay address={deps.poolManager} label="jackpot pool manager address" full />
              {status.missing.some((m) => m.name === 'poolManager') ? <span className="badge danger" style={{ marginInlineStart: 8 }}>no code</span> : null}
            </dd>
          </>
        ) : null}
      </dl>
    </Card>
  );
}
