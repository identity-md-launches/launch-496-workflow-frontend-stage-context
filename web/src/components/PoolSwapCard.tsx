// ETH <-> PJACK swaps in the launch's Uniswap v4 pool via the network's vetted quoter, Permit2 and
// universal router. Addresses come only from the manifest's `network` block.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { type Address, zeroAddress } from 'viem';
import { useAccount, useBalance, usePublicClient, useReadContracts } from 'wagmi';
import { erc20Abi, permit2Abi, quoterAbi, stateViewAbi, universalRouterAbi } from '../abis/uniswap';
import { useContractRef, useDeployment } from '../DeploymentContext';
import { DEADLINE_SECONDS, DEFAULT_SLIPPAGE_BPS, LAUNCH_POOL, PERMIT2_EXPIRATION_SECONDS, POLL_INTERVAL_MS } from '../config';
import { useGate } from '../hooks/useGate';
import { useTx } from '../hooks/useTx';
import { describeError } from '../lib/errors';
import { explorerAddressUrl, formatAmount, parseAmountInput, priceFromSqrtX96 } from '../lib/format';
import { applySlippage, buildUniversalRouterSwap, launchPoolKey, poolId } from '../lib/v4';
import { ActionButton, Card, Field, Notice, TxStatusLine } from './ui';

const MAX_UINT160 = (1n << 160n) - 1n;

export function PoolSwapCard() {
  const dep = useDeployment();
  const token = useContractRef('LaunchToken');
  const gate = useGate('LaunchToken');
  const client = usePublicClient();
  const { address } = useAccount();
  const network = dep.network;
  const uni = network?.uniswapV4;
  const key = launchPoolKey(LAUNCH_POOL.pairedCurrency as Address, token.address, LAUNCH_POOL.fee, LAUNCH_POOL.tickSpacing, zeroAddress);
  const id = poolId(key);
  const nativeSymbol = dep.chain.nativeCurrency.symbol;
  const tokenSymbol = LAUNCH_POOL.tokenSymbol || 'PJACK';
  const tokenDecimals = LAUNCH_POOL.tokenDecimals;
  const tokenIsCurrency1 = key.currency1.toLowerCase() === token.address.toLowerCase();

  const [direction, setDirection] = useState<'buy' | 'sell'>('buy');
  const [amountText, setAmountText] = useState('');
  const [slippage, setSlippage] = useState('1');
  const buying = direction === 'buy';
  const inputDecimals = buying ? dep.chain.nativeCurrency.decimals : tokenDecimals;
  const outputDecimals = buying ? tokenDecimals : dep.chain.nativeCurrency.decimals;
  const inputSymbol = buying ? nativeSymbol : tokenSymbol;
  const outputSymbol = buying ? tokenSymbol : nativeSymbol;
  const amount = parseAmountInput(amountText, inputDecimals);
  // Buying the token means selling the paired currency: zeroForOne when the paired currency is currency0.
  const zeroForOne = buying ? tokenIsCurrency1 : !tokenIsCurrency1;
  const bpsValue = Number(slippage);
  const bps = Number.isFinite(bpsValue) && bpsValue >= 0 && bpsValue <= 50 ? Math.round(bpsValue * 100) : DEFAULT_SLIPPAGE_BPS;

  const pool = useReadContracts({
    contracts: uni
      ? [
          { address: uni.stateView, abi: stateViewAbi, functionName: 'getSlot0', args: [id] },
          { address: uni.stateView, abi: stateViewAbi, functionName: 'getLiquidity', args: [id] },
        ]
      : [],
    query: { enabled: Boolean(uni), refetchInterval: POLL_INTERVAL_MS },
  });
  const slot0 = pool.data?.[0]?.status === 'success' ? (pool.data[0].result as readonly [bigint, number, number, number]) : undefined;
  const liquidity = pool.data?.[1]?.status === 'success' ? (pool.data[1].result as bigint) : undefined;
  const initialized = slot0 !== undefined && slot0[0] !== 0n;
  const price = slot0 && initialized ? priceFromSqrtX96(slot0[0], tokenIsCurrency1 ? dep.chain.nativeCurrency.decimals : tokenDecimals, tokenIsCurrency1 ? tokenDecimals : dep.chain.nativeCurrency.decimals) : undefined;

  const ethBalance = useBalance({ address, query: { enabled: Boolean(address), refetchInterval: POLL_INTERVAL_MS } });
  const tokenState = useReadContracts({
    contracts:
      address && uni
        ? [
            { address: token.address, abi: erc20Abi, functionName: 'balanceOf', args: [address] },
            { address: token.address, abi: erc20Abi, functionName: 'allowance', args: [address, uni.permit2] },
            { address: uni.permit2, abi: permit2Abi, functionName: 'allowance', args: [address, token.address, uni.universalRouter] },
          ]
        : [],
    query: { enabled: Boolean(address && uni), refetchInterval: POLL_INTERVAL_MS },
  });
  const tokenBalance = tokenState.data?.[0]?.status === 'success' ? (tokenState.data[0].result as bigint) : undefined;
  const permit2Allowance = tokenState.data?.[1]?.status === 'success' ? (tokenState.data[1].result as bigint) : undefined;
  const routerAllowance = tokenState.data?.[2]?.status === 'success' ? (tokenState.data[2].result as readonly [bigint, number, number]) : undefined;

  const quote = useQuery({
    queryKey: ['quoteV4', id, direction, amount?.toString()],
    enabled: Boolean(client && uni && amount && amount > 0n && initialized),
    refetchInterval: 15_000,
    queryFn: async () => {
      const { result } = await client!.simulateContract({
        address: uni!.quoter,
        abi: quoterAbi,
        functionName: 'quoteExactInputSingle',
        args: [{ poolKey: key, zeroForOne, exactAmount: amount!, hookData: '0x' }],
      });
      return { amountOut: result[0], gasEstimate: result[1] };
    },
  });
  const minOut = quote.data ? applySlippage(quote.data.amountOut, bps) : undefined;

  const nowSec = Math.floor(Date.now() / 1000);
  const needsTokenApproval = !buying && amount !== undefined && permit2Allowance !== undefined && permit2Allowance < amount;
  const needsPermit2 = !buying && amount !== undefined && routerAllowance !== undefined && (routerAllowance[0] < amount || Number(routerAllowance[1]) <= nowSec);

  const approveTx = useTx();
  const permit2Tx = useTx();
  const swapTx = useTx();

  let reason = !network ? 'This chain is not vetted by the network; swaps stay disabled.' : gate.reason;
  if (!reason && !initialized) reason = pool.isLoading ? 'Reading the pool…' : 'The launch pool is not initialized.';
  else if (!reason && (amount === undefined || amount === 0n)) reason = `Enter the ${inputSymbol} amount.`;
  else if (!reason && buying && ethBalance.data && amount !== undefined && ethBalance.data.value < amount) reason = `Balance is ${formatAmount(ethBalance.data.value, 18, 4)} ${nativeSymbol}.`;
  else if (!reason && !buying && tokenBalance !== undefined && amount !== undefined && tokenBalance < amount) reason = `Balance is ${formatAmount(tokenBalance, tokenDecimals, 4)} ${tokenSymbol}.`;
  else if (!reason && !quote.data) reason = quote.isError ? `Quote failed: ${describeError(quote.error)}` : 'Waiting for a quote…';
  else if (!reason && minOut === 0n) reason = 'Quoted output rounds to zero. Increase the amount.';

  const swap = () => {
    if (!uni || amount === undefined || minOut === undefined) return;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS);
    const built = buildUniversalRouterSwap({ poolKey: key, zeroForOne, amountIn: amount, amountOutMinimum: minOut, deadline });
    void swapTx.run({
      address: uni.universalRouter,
      abi: universalRouterAbi,
      functionName: 'execute',
      args: [built.commands, built.inputs, built.deadline],
      value: built.value,
      label: 'Swap',
    });
  };

  const amountError = amountText !== '' && amount === undefined ? `Enter a decimal amount with at most ${inputDecimals} fraction digits.` : undefined;
  const slippageInvalid = slippage !== '' && (!Number.isFinite(bpsValue) || bpsValue < 0 || bpsValue > 50);

  return (
    <Card title={`${nativeSymbol}/${tokenSymbol} launch pool`} lede={`Uniswap v4 pool from the attested manifest: fee ${LAUNCH_POOL.fee / 10_000}%, tick spacing ${LAUNCH_POOL.tickSpacing}, no hook.`}>
      {!network ? (
        <Notice kind="danger">This chain is not vetted by the network, so no router, quoter or Permit2 address is configured. Swaps are disabled.</Notice>
      ) : null}
      <dl className="kv">
        <dt>Pool state</dt>
        <dd>
          {pool.isLoading ? 'Reading…' : !initialized ? 'Not initialized' : `Tick ${slot0![1]}, liquidity in range ${liquidity !== undefined ? liquidity.toString() : '—'}`}
        </dd>
        {price ? (
          <>
            <dt>Spot price</dt>
            <dd className="num">
              {tokenIsCurrency1 ? `${price.token1PerToken0} ${tokenSymbol} per ${nativeSymbol}` : `${price.token0PerToken1} ${tokenSymbol} per ${nativeSymbol}`}
            </dd>
          </>
        ) : null}
        {uni ? (
          <>
            <dt>Router</dt>
            <dd>
              <a href={explorerAddressUrl(network?.explorer, uni.universalRouter)} target="_blank" rel="noreferrer" className="mono">
                {uni.universalRouter}
              </a>
            </dd>
          </>
        ) : null}
      </dl>
      <p className="caption">USD context is unavailable: this site reads no price oracle.</p>
      <fieldset>
        <legend>Direction</legend>
        <div className="segmented" role="radiogroup" aria-label="Swap direction">
          <label>
            <input type="radio" name="pool-direction" value="buy" checked={buying} onChange={() => setDirection('buy')} />
            {nativeSymbol} → {tokenSymbol}
          </label>
          <label>
            <input type="radio" name="pool-direction" value="sell" checked={!buying} onChange={() => setDirection('sell')} />
            {tokenSymbol} → {nativeSymbol}
          </label>
        </div>
      </fieldset>
      <div className="form-grid two">
        <Field
          label="Amount to swap"
          unit={inputSymbol}
          hint={
            address
              ? buying
                ? ethBalance.data
                  ? `Balance ${formatAmount(ethBalance.data.value, 18, 4)} ${nativeSymbol}.`
                  : undefined
                : tokenBalance !== undefined
                  ? `Balance ${formatAmount(tokenBalance, tokenDecimals, 4)} ${tokenSymbol}.`
                  : undefined
              : undefined
          }
          error={amountError}
        >
          {({ id: fid, describedBy, invalid }) => (
            <input id={fid} className="input" inputMode="decimal" placeholder="0.0" value={amountText} onChange={(e) => setAmountText(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid || undefined} autoComplete="off" />
          )}
        </Field>
        <Field label="Slippage tolerance" unit="%" error={slippageInvalid ? 'Enter a percentage between 0 and 50.' : undefined}>
          {({ id: fid, describedBy, invalid }) => (
            <input id={fid} className="input" inputMode="decimal" value={slippage} onChange={(e) => setSlippage(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid || undefined} />
          )}
        </Field>
      </div>
      {quote.data && minOut !== undefined && amount ? (
        <div className="quote" aria-live="polite">
          <dl>
            <dt>Quoted output</dt>
            <dd>
              {formatAmount(quote.data.amountOut, outputDecimals, 6)} {outputSymbol}
            </dd>
            <dt>Minimum after slippage</dt>
            <dd>
              {formatAmount(minOut, outputDecimals, 6)} {outputSymbol}
            </dd>
            <dt>Rate</dt>
            <dd>
              1 {inputSymbol} ≈ {formatAmount((quote.data.amountOut * 10n ** BigInt(inputDecimals)) / amount, outputDecimals, 6)} {outputSymbol}
            </dd>
          </dl>
        </div>
      ) : null}
      {!reason && needsTokenApproval && uni ? (
        <>
          <ActionButton
            pending={approveTx.inFlight}
            pendingLabel="Approving…"
            onClick={() => approveTx.run({ address: token.address, abi: erc20Abi, functionName: 'approve', args: [uni.permit2, amount!], label: 'Approve Permit2' })}
          >
            Step 1 of 3: approve {formatAmount(amount, tokenDecimals, 4)} {tokenSymbol} for Permit2
          </ActionButton>
          <TxStatusLine state={approveTx.state} />
        </>
      ) : !reason && needsPermit2 && uni ? (
        <>
          <ActionButton
            pending={permit2Tx.inFlight}
            pendingLabel="Approving…"
            onClick={() =>
              permit2Tx.run({
                address: uni.permit2,
                abi: permit2Abi,
                functionName: 'approve',
                args: [token.address, uni.universalRouter, amount! > MAX_UINT160 ? MAX_UINT160 : amount!, nowSec + PERMIT2_EXPIRATION_SECONDS],
                label: 'Approve router in Permit2',
              })
            }
          >
            Step 2 of 3: allow the router to spend {tokenSymbol} via Permit2
          </ActionButton>
          <TxStatusLine state={permit2Tx.state} />
        </>
      ) : (
        <>
          <ActionButton pending={swapTx.inFlight} pendingLabel="Swapping…" disabledReason={reason} onClick={swap}>
            {buying ? `Swap ${nativeSymbol} for ${tokenSymbol}` : `Step 3 of 3: swap ${tokenSymbol} for ${nativeSymbol}`}
          </ActionButton>
          <TxStatusLine state={swapTx.state} />
        </>
      )}
    </Card>
  );
}
