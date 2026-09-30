// Jackpot actions: fridge swap, golden throne, tank fill (EIP-2612 permit) and seed.
// Every control is gated on wallet, network, ABI verification and dependency code.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { type Address, type Hex, parseSignature } from 'viem';
import { useAccount, usePublicClient, useSignTypedData } from 'wagmi';
import { erc20Abi } from '../abis/uniswap';
import { useContractRef, useDeployment } from '../DeploymentContext';
import { DEADLINE_SECONDS, DEFAULT_SLIPPAGE_BPS, VRF_FEE_HEADROOM_BPS } from '../config';
import { useGate } from '../hooks/useGate';
import { type DependencyStatus, type JackpotDependencies, useJackpotState, useTokenAccount } from '../hooks/useJackpot';
import { useTx } from '../hooks/useTx';
import { describeError } from '../lib/errors';
import { formatAmount, parseAmountInput } from '../lib/format';
import { applySlippage } from '../lib/v4';
import { ActionButton, Card, Field, TxStatusLine } from './ui';

interface ActionProps {
  deps: JackpotDependencies | undefined;
  status: DependencyStatus;
}

function SlippageField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const invalid = value !== '' && (Number.isNaN(Number(value)) || Number(value) < 0 || Number(value) > 50);
  return (
    <Field label="Slippage tolerance" unit="%" error={invalid ? 'Enter a percentage between 0 and 50.' : undefined}>
      {({ id, describedBy, invalid: inv }) => (
        <input id={id} className="input" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} aria-describedby={describedBy} aria-invalid={inv || undefined} />
      )}
    </Field>
  );
}

function slippageBps(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 50 ? Math.round(n * 100) : DEFAULT_SLIPPAGE_BPS;
}

function deadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS);
}

function vrfBudget(fee: bigint | undefined): bigint {
  if (fee === undefined) return 0n;
  return (fee * (10_000n + BigInt(VRF_FEE_HEADROOM_BPS))) / 10_000n;
}

/** ERC-20 approval step (ICE or IMD to the jackpot) shown as its own action. */
function ApproveStep({ token, symbol, amount, spender, onDone, disabledReason }: { token: Address; symbol: string; amount: bigint; spender: Address; onDone?: () => void; disabledReason?: string }) {
  const tx = useTx();
  return (
    <>
      <ActionButton
        pending={tx.inFlight}
        pendingLabel="Approving…"
        disabledReason={disabledReason}
        onClick={async () => {
          const hash = await tx.run({ address: token, abi: erc20Abi, functionName: 'approve', args: [spender, amount], label: 'Approve' });
          if (hash) onDone?.();
        }}
      >
        Approve {formatAmount(amount, 18, 4)} {symbol}
      </ActionButton>
      <TxStatusLine state={tx.state} />
    </>
  );
}

export function FridgeCard({ deps, status }: ActionProps) {
  const dep = useDeployment();
  const jackpot = useContractRef('PepeJackpot');
  const gate = useGate('PepeJackpot');
  const client = usePublicClient();
  const state = useJackpotState();
  const [direction, setDirection] = useState<'iceToImd' | 'imdToIce'>('iceToImd');
  const [amountText, setAmountText] = useState('');
  const [slippage, setSlippage] = useState('1');
  const iceToImd = direction === 'iceToImd';
  const inputToken = iceToImd ? deps?.ice : deps?.imd;
  const inputSymbol = iceToImd ? 'ICE' : 'IMD';
  const outputSymbol = iceToImd ? 'IMD' : 'ICE';
  const amount = parseAmountInput(amountText, 18);
  const account = useTokenAccount(inputToken, jackpot.address);
  const tx = useTx();

  const quote = useQuery({
    queryKey: ['quoteFridge', jackpot.address, direction, amount?.toString()],
    enabled: Boolean(client && amount && amount > 0n && !status.reason),
    refetchInterval: 15_000,
    queryFn: async () => {
      const r = (await client!.readContract({ address: jackpot.address, abi: jackpot.abi, functionName: 'quoteFridgeSwap', args: [iceToImd, amount!] })) as readonly [bigint, bigint];
      return { amountOut: r[0], iceFee: r[1] };
    },
  });

  const threshold = iceToImd ? state.iceTicketMin : state.imdTicketMin;
  const eligible = amount !== undefined && threshold !== undefined && amount >= threshold;
  const minOut = quote.data ? applySlippage(quote.data.amountOut, slippageBps(slippage)) : undefined;
  const needsApproval = amount !== undefined && account.allowance !== undefined && account.allowance < amount;
  const amountError = amountText !== '' && amount === undefined ? 'Enter a decimal amount with at most 18 fraction digits.' : undefined;
  const balanceError = amount !== undefined && account.balance !== undefined && account.balance < amount ? `Balance is ${formatAmount(account.balance, 18, 4)} ${inputSymbol}.` : undefined;

  let reason = gate.reason ?? status.reason;
  if (!reason && (amount === undefined || amount === 0n)) reason = `Enter the ${inputSymbol} amount to sell.`;
  else if (!reason && balanceError) reason = balanceError;
  else if (!reason && !quote.data) reason = quote.isError ? `Quote failed: ${describeError(quote.error)}` : 'Waiting for a quote…';
  else if (!reason && minOut !== undefined && minOut === 0n) reason = 'Quoted output rounds to zero. Increase the amount.';
  else if (!reason && eligible && state.vrfFee === undefined) reason = 'Randomness fee is unavailable, so an eligible trade cannot be funded.';

  const value = eligible ? vrfBudget(state.vrfFee) : 0n;

  return (
    <Card title="Fridge swap" lede="Sell ICE for IMD, or buy ICE with IMD, through the jackpot. The pot keeps 1% of the ICE side.">
      <fieldset>
        <legend>Direction</legend>
        <div className="segmented" role="radiogroup" aria-label="Fridge swap direction">
          <label>
            <input type="radio" name="fridge-direction" value="iceToImd" checked={iceToImd} onChange={() => setDirection('iceToImd')} />
            ICE → IMD
          </label>
          <label>
            <input type="radio" name="fridge-direction" value="imdToIce" checked={!iceToImd} onChange={() => setDirection('imdToIce')} />
            IMD → ICE
          </label>
        </div>
      </fieldset>
      <div className="form-grid two">
        <Field
          label={`Amount to sell`}
          unit={inputSymbol}
          hint={threshold !== undefined ? `Ticket at or above ${formatAmount(threshold, 18, 4)} ${inputSymbol}.${account.balance !== undefined ? ` Balance ${formatAmount(account.balance, 18, 4)}.` : ''}` : undefined}
          error={amountError}
        >
          {({ id, describedBy, invalid }) => (
            <input id={id} className="input" inputMode="decimal" placeholder="0.0" value={amountText} onChange={(e) => setAmountText(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid || undefined} autoComplete="off" />
          )}
        </Field>
        <SlippageField value={slippage} onChange={setSlippage} />
      </div>
      {quote.data && minOut !== undefined ? (
        <div className="quote" aria-live="polite">
          <dl>
            <dt>Quoted output</dt>
            <dd>
              {formatAmount(quote.data.amountOut, 18, 6)} {outputSymbol}
            </dd>
            <dt>Minimum after slippage</dt>
            <dd>
              {formatAmount(minOut, 18, 6)} {outputSymbol}
            </dd>
            <dt>Pot contribution</dt>
            <dd>{formatAmount(quote.data.iceFee, 18, 4)} ICE</dd>
            <dt>Ticket</dt>
            <dd>{eligible ? `Yes, plus ${formatAmount(value, 18, 6)} ${dep.chain.nativeCurrency.symbol} sent for randomness (excess refunded)` : 'No, below the threshold'}</dd>
          </dl>
        </div>
      ) : null}
      {!reason && needsApproval && inputToken ? (
        <ApproveStep token={inputToken} symbol={inputSymbol} amount={amount!} spender={jackpot.address} />
      ) : (
        <ActionButton
          pending={tx.inFlight}
          pendingLabel="Swapping…"
          disabledReason={reason}
          onClick={() =>
            tx.run({
              address: jackpot.address,
              abi: jackpot.abi,
              functionName: 'fridgeSwap',
              args: [iceToImd, amount!, minOut!, deadline()],
              value,
              label: 'Fridge swap',
            })
          }
        >
          Swap {inputSymbol} for {outputSymbol}
        </ActionButton>
      )}
      <TxStatusLine state={tx.state} />
    </Card>
  );
}

export function ThroneCard({ status }: ActionProps) {
  const dep = useDeployment();
  const jackpot = useContractRef('PepeJackpot');
  const gate = useGate('PepeJackpot');
  const client = usePublicClient();
  const state = useJackpotState();
  const [amountText, setAmountText] = useState('');
  const [slippage, setSlippage] = useState('1');
  const amount = parseAmountInput(amountText, 18);
  const tx = useTx();
  const symbol = dep.chain.nativeCurrency.symbol;

  const quote = useQuery({
    queryKey: ['quoteThrone', jackpot.address, amount?.toString()],
    enabled: Boolean(client && amount && amount > 0n && !status.reason),
    refetchInterval: 15_000,
    queryFn: async () => {
      const r = (await client!.readContract({ address: jackpot.address, abi: jackpot.abi, functionName: 'quoteGoldenThrone', args: [amount!] })) as readonly [bigint, bigint];
      return { imdOut: r[0], iceFee: r[1] };
    },
  });
  const eligible = amount !== undefined && state.ethTicketMin !== undefined && amount >= state.ethTicketMin;
  const bps = slippageBps(slippage);
  const minImd = quote.data ? applySlippage(quote.data.imdOut, bps) : undefined;
  const minIce = quote.data ? applySlippage(quote.data.iceFee, bps) : undefined;
  const vrf = eligible ? vrfBudget(state.vrfFee) : 0n;
  const total = amount !== undefined ? amount + vrf : undefined;
  const amountError = amountText !== '' && amount === undefined ? 'Enter a decimal amount with at most 18 fraction digits.' : undefined;

  let reason = gate.reason ?? status.reason;
  if (!reason && (amount === undefined || amount === 0n)) reason = `Enter the ${symbol} amount to trade.`;
  else if (!reason && amount !== undefined && amount / 100n === 0n) reason = 'Amount is too small: 1% of it must be at least 1 wei.';
  else if (!reason && !quote.data) reason = quote.isError ? `Quote failed: ${describeError(quote.error)}` : 'Waiting for a quote…';
  else if (!reason && (minImd === 0n || minIce === 0n)) reason = 'Quoted output rounds to zero. Increase the amount.';
  else if (!reason && eligible && state.vrfFee === undefined) reason = 'Randomness fee is unavailable, so an eligible trade cannot be funded.';

  return (
    <Card title="Golden throne" lede={`Trade ${symbol} for IMD. 1% of the ${symbol} buys ICE into the pot as the ticket fee.`}>
      <div className="form-grid two">
        <Field label="Amount to trade" unit={symbol} hint={state.ethTicketMin !== undefined ? `Ticket at or above ${formatAmount(state.ethTicketMin, 18, 4)} ${symbol}.` : undefined} error={amountError}>
          {({ id, describedBy, invalid }) => (
            <input id={id} className="input" inputMode="decimal" placeholder="0.0" value={amountText} onChange={(e) => setAmountText(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid || undefined} autoComplete="off" />
          )}
        </Field>
        <SlippageField value={slippage} onChange={setSlippage} />
      </div>
      {quote.data && minImd !== undefined && minIce !== undefined ? (
        <div className="quote" aria-live="polite">
          <dl>
            <dt>Quoted IMD</dt>
            <dd>{formatAmount(quote.data.imdOut, 18, 6)} IMD</dd>
            <dt>Minimum IMD</dt>
            <dd>{formatAmount(minImd, 18, 6)} IMD</dd>
            <dt>ICE to the pot</dt>
            <dd>
              {formatAmount(quote.data.iceFee, 18, 4)} ICE (min {formatAmount(minIce, 18, 4)})
            </dd>
            <dt>Total {symbol} sent</dt>
            <dd>
              {formatAmount(total, 18, 6)} {symbol}
              {eligible ? ' incl. randomness fee, excess refunded' : ''}
            </dd>
          </dl>
        </div>
      ) : null}
      <ActionButton
        pending={tx.inFlight}
        pendingLabel="Trading…"
        disabledReason={reason}
        onClick={() =>
          tx.run({
            address: jackpot.address,
            abi: jackpot.abi,
            functionName: 'goldenThrone',
            args: [amount!, minImd!, minIce!, deadline()],
            value: total!,
            label: 'Golden throne',
          })
        }
      >
        Trade {symbol} for IMD
      </ActionButton>
      <TxStatusLine state={tx.state} />
    </Card>
  );
}

export function TankCard({ deps, status }: ActionProps) {
  const dep = useDeployment();
  const jackpot = useContractRef('PepeJackpot');
  const gate = useGate('PepeJackpot');
  const client = usePublicClient();
  const { address } = useAccount();
  const state = useJackpotState();
  const { signTypedDataAsync } = useSignTypedData();
  const [peesText, setPeesText] = useState('1');
  const [signError, setSignError] = useState<string>();
  const [signing, setSigning] = useState(false);
  const pees = /^\d+$/.test(peesText.trim()) ? BigInt(peesText.trim()) : undefined;
  const amount = pees !== undefined && state.icePerPee !== undefined ? pees * state.icePerPee : undefined;
  const ice = useTokenAccount(deps?.ice, jackpot.address);
  const tx = useTx();

  let reason = gate.reason ?? status.reason;
  if (!reason && (pees === undefined || pees === 0n)) reason = 'Enter a whole number of pees.';
  else if (!reason && amount !== undefined && ice.balance !== undefined && ice.balance < amount) reason = `Balance is ${formatAmount(ice.balance, 18, 2)} ICE; ${formatAmount(amount, 18, 0)} ICE needed.`;

  const fill = async () => {
    if (!client || !address || !deps || amount === undefined || pees === undefined) return;
    setSignError(undefined);
    setSigning(true);
    try {
      const [nonce, name, domainInfo] = await Promise.all([
        client.readContract({ address: deps.ice, abi: erc20Abi, functionName: 'nonces', args: [address] }),
        client.readContract({ address: deps.ice, abi: erc20Abi, functionName: 'name' }),
        client.readContract({ address: deps.ice, abi: erc20Abi, functionName: 'eip712Domain' }).catch(() => undefined),
      ]);
      const version = domainInfo ? domainInfo[2] : '1';
      const permitDeadline = deadline();
      const signature = await signTypedDataAsync({
        domain: { name: domainInfo ? domainInfo[1] : name, version, chainId: dep.chain.id, verifyingContract: deps.ice },
        types: {
          Permit: [
            { name: 'owner', type: 'address' },
            { name: 'spender', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'nonce', type: 'uint256' },
            { name: 'deadline', type: 'uint256' },
          ],
        },
        primaryType: 'Permit',
        message: { owner: address, spender: jackpot.address, value: amount, nonce, deadline: permitDeadline },
      });
      const { v, r, s } = parseSignature(signature as Hex);
      await tx.run({
        address: jackpot.address,
        abi: jackpot.abi,
        functionName: 'fillTank',
        args: [pees, { deadline: permitDeadline, v: Number(v ?? 27n), r, s }],
        label: 'Fill tank',
      });
    } catch (e) {
      setSignError(describeError(e));
    } finally {
      setSigning(false);
    }
  };

  return (
    <Card title="Tank fill" lede="Pay 1,000 ICE per pee into the pot in one transaction, authorised with an ICE permit signature. No ticket.">
      <Field label="Pees" hint={amount !== undefined ? `${formatAmount(amount, 18, 0)} ICE will be transferred to the pot.` : undefined} error={peesText !== '' && pees === undefined ? 'Enter a whole number.' : undefined}>
        {({ id, describedBy, invalid }) => (
          <input id={id} className="input" inputMode="numeric" value={peesText} onChange={(e) => setPeesText(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid || undefined} autoComplete="off" />
        )}
      </Field>
      <ActionButton pending={signing || tx.inFlight} pendingLabel={signing && !tx.inFlight ? 'Sign the permit…' : 'Filling…'} disabledReason={reason} onClick={fill}>
        Sign permit and fill tank
      </ActionButton>
      {signError ? (
        <div className="notice danger" role="alert">
          <p>{signError}</p>
        </div>
      ) : null}
      <TxStatusLine state={tx.state} />
    </Card>
  );
}

export function SeedCard({ deps, status }: ActionProps) {
  const jackpot = useContractRef('PepeJackpot');
  const gate = useGate('PepeJackpot');
  const [amountText, setAmountText] = useState('');
  const amount = parseAmountInput(amountText, 18);
  const ice = useTokenAccount(deps?.ice, jackpot.address);
  const tx = useTx();
  const needsApproval = amount !== undefined && ice.allowance !== undefined && ice.allowance < amount;
  let reason = gate.reason ?? status.reason;
  if (!reason && (amount === undefined || amount === 0n)) reason = 'Enter the ICE amount to add.';
  else if (!reason && amount !== undefined && ice.balance !== undefined && ice.balance < amount) reason = `Balance is ${formatAmount(ice.balance, 18, 2)} ICE.`;
  const hint = useMemo(() => (ice.balance !== undefined ? `Balance ${formatAmount(ice.balance, 18, 4)} ICE. Seeding is a gift to the pot; it issues no ticket.` : 'Seeding is a gift to the pot; it issues no ticket.'), [ice.balance]);
  return (
    <Card title="Seed the pot" lede="Anyone may add ICE to the pot. Approve the jackpot, then seed.">
      <Field label="ICE to add" unit="ICE" hint={hint} error={amountText !== '' && amount === undefined ? 'Enter a decimal amount with at most 18 fraction digits.' : undefined}>
        {({ id, describedBy, invalid }) => (
          <input id={id} className="input" inputMode="decimal" placeholder="0.0" value={amountText} onChange={(e) => setAmountText(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid || undefined} autoComplete="off" />
        )}
      </Field>
      {!reason && needsApproval && deps ? (
        <ApproveStep token={deps.ice} symbol="ICE" amount={amount!} spender={jackpot.address} />
      ) : (
        <ActionButton pending={tx.inFlight} pendingLabel="Seeding…" disabledReason={reason} onClick={() => tx.run({ address: jackpot.address, abi: jackpot.abi, functionName: 'seed', args: [amount!], label: 'Seed' })}>
          Seed {amount ? formatAmount(amount, 18, 4) : ''} ICE
        </ActionButton>
      )}
      <TxStatusLine state={tx.state} />
    </Card>
  );
}
