// PJACK launch token: supply, balance, transfer and approve (the token's primary actions).
import { useState } from 'react';
import { type Address, isAddress } from 'viem';
import { useAccount, useReadContracts } from 'wagmi';
import { useContractRef } from '../DeploymentContext';
import { POLL_INTERVAL_MS } from '../config';
import { useGate } from '../hooks/useGate';
import { useTx } from '../hooks/useTx';
import { formatAmount, parseAmountInput } from '../lib/format';
import { ActionButton, AddressDisplay, Card, Field, Notice, TxStatusLine } from './ui';

export function TokenCard() {
  const token = useContractRef('LaunchToken');
  const gate = useGate('LaunchToken');
  const { address } = useAccount();
  const base = { address: token.address, abi: token.abi } as const;
  const meta = useReadContracts({
    contracts: [
      { ...base, functionName: 'name' },
      { ...base, functionName: 'symbol' },
      { ...base, functionName: 'decimals' },
      { ...base, functionName: 'totalSupply' },
    ],
    query: { staleTime: Infinity },
  });
  const balance = useReadContracts({
    contracts: address ? [{ ...base, functionName: 'balanceOf', args: [address] }] : [],
    query: { enabled: Boolean(address), refetchInterval: POLL_INTERVAL_MS },
  });
  const ok = (i: number) => meta.data?.[i]?.status === 'success';
  const name = ok(0) ? (meta.data![0].result as string) : 'PepeJackpot';
  const symbol = ok(1) ? (meta.data![1].result as string) : 'PJACK';
  const decimals = ok(2) ? Number(meta.data![2].result) : 18;
  const totalSupply = ok(3) ? (meta.data![3].result as bigint) : undefined;
  const bal = balance.data?.[0]?.status === 'success' ? (balance.data[0].result as bigint) : undefined;

  const [mode, setMode] = useState<'transfer' | 'approve'>('transfer');
  const [to, setTo] = useState('');
  const [amountText, setAmountText] = useState('');
  const amount = parseAmountInput(amountText, decimals);
  const toValid = isAddress(to.trim());
  const tx = useTx();
  let reason = gate.reason;
  if (!reason && !toValid) reason = mode === 'transfer' ? 'Enter the recipient address.' : 'Enter the spender address.';
  else if (!reason && (amount === undefined || amount === 0n)) reason = `Enter the ${symbol} amount.`;
  else if (!reason && mode === 'transfer' && bal !== undefined && amount !== undefined && bal < amount) reason = `Balance is ${formatAmount(bal, decimals, 4)} ${symbol}.`;

  return (
    <Card title={`${symbol} launch token`} lede={`${name} (${symbol}) is the fixed-supply launch token. It is separate from ICE and IMD and is not the jackpot's pot asset.`}>
      <div className="stat-row">
        <div className="stat">
          <span className="label">Your balance</span>
          <span className="value num" style={{ fontSize: 'var(--text-h2)' }}>
            {address ? formatAmount(bal, decimals, 4) : '—'}
            <small>{symbol}</small>
          </span>
        </div>
        <div className="stat">
          <span className="label">Total supply</span>
          <span className="value num" style={{ fontSize: 'var(--text-h2)' }}>
            {formatAmount(totalSupply, decimals, 0)}
            <small>{symbol}</small>
          </span>
        </div>
      </div>
      <dl className="kv">
        <dt>Contract</dt>
        <dd>
          <AddressDisplay address={token.address} label={`${symbol} token address`} full />
        </dd>
      </dl>
      {!token.verified ? <Notice kind="danger">The loaded ABI does not match the attested hash. Token transactions are disabled.</Notice> : null}
      <fieldset>
        <legend>Action</legend>
        <div className="segmented" role="radiogroup" aria-label="Token action">
          <label>
            <input type="radio" name="token-mode" value="transfer" checked={mode === 'transfer'} onChange={() => setMode('transfer')} />
            Transfer
          </label>
          <label>
            <input type="radio" name="token-mode" value="approve" checked={mode === 'approve'} onChange={() => setMode('approve')} />
            Approve spender
          </label>
        </div>
      </fieldset>
      <div className="form-grid two">
        <Field label={mode === 'transfer' ? 'Recipient address' : 'Spender address'} error={to !== '' && !toValid ? 'Enter a 42-character hex address starting with 0x.' : undefined} hint="Paste the full address; ENS names are not resolved on this network.">
          {({ id, describedBy, invalid }) => (
            <input id={id} className="input mono" value={to} onChange={(e) => setTo(e.target.value.trim())} aria-describedby={describedBy} aria-invalid={invalid || undefined} autoComplete="off" spellCheck={false} placeholder="0x…" />
          )}
        </Field>
        <Field label="Amount" unit={symbol} error={amountText !== '' && amount === undefined ? `Enter a decimal amount with at most ${decimals} fraction digits.` : undefined}>
          {({ id, describedBy, invalid }) => (
            <input id={id} className="input" inputMode="decimal" placeholder="0.0" value={amountText} onChange={(e) => setAmountText(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid || undefined} autoComplete="off" />
          )}
        </Field>
      </div>
      <ActionButton
        pending={tx.inFlight}
        pendingLabel={mode === 'transfer' ? 'Transferring…' : 'Approving…'}
        disabledReason={reason}
        onClick={() =>
          tx.run({
            address: token.address,
            abi: token.abi,
            functionName: mode,
            args: [to as Address, amount!],
            label: mode === 'transfer' ? 'Transfer' : 'Approve',
          })
        }
      >
        {mode === 'transfer' ? `Transfer ${symbol}` : `Approve ${symbol} spender`}
      </ActionButton>
      <TxStatusLine state={tx.state} />
    </Card>
  );
}
