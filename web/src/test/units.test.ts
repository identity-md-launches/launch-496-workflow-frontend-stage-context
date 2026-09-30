import { describe, expect, it } from 'vitest';
import { decodeAbiParameters, decodeFunctionData, parseEther, zeroAddress } from 'viem';
import { universalRouterAbi } from '../abis/uniswap';
import { canonicalKeccak, chainFromManifest, loadDeployment, validateManifest } from '../deployment';
import { describeError } from '../lib/errors';
import { formatAmount, parseAmountInput, priceFromSqrtX96, shortAddress } from '../lib/format';
import { canExpire, ticketOutcome } from '../lib/tickets';
import { applySlippage, buildUniversalRouterSwap, launchPoolKey, poolId } from '../lib/v4';
import { fileFetcher } from './harness';
import handoff from '../../deployment/handoff.json';
import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from 'viem';

const PJACK = '0xc43fbdcebf6a52d0249270718437603153b684d8';

describe('deployment manifest', () => {
  it('hashes the committed ABIs to the handoff abiHash', async () => {
    const dep = await loadDeployment('http://site.test/', fileFetcher());
    expect(dep.manifest.launchId).toBe(handoff.launchId);
    expect(dep.manifest.chainId).toBe(handoff.chainId);
    for (const c of handoff.contracts) {
      expect(dep.verified[c.name]).toBe(true);
      expect(dep.addresses[c.name]).toBe(c.address);
      expect(canonicalKeccak(dep.abis[c.name])).toBe(c.abiHash);
    }
    expect(dep.network?.uniswapV4.universalRouter).toBeTruthy();
    expect(dep.walletAddChain?.chainId).toBe('0xaa36a7');
    expect(dep.chain.rpcUrls.default.http).toEqual(dep.network?.rpcUrls);
  });

  it('flags a tampered ABI instead of trusting it', async () => {
    const dep = await loadDeployment('http://site.test/', fileFetcher({ 'abi/LaunchToken.json': '[]' }));
    expect(dep.verified.LaunchToken).toBe(false);
    expect(dep.verified.PepeJackpot).toBe(true);
  });

  it('rejects malformed manifests', () => {
    expect(() => validateManifest({ version: 2 })).toThrow(/version/);
    expect(() => validateManifest({ ...handoff, version: 1, contracts: [{ name: 'X', address: '0x1', abiHash: 'zz', abiPath: 'a' }], assets: [] })).toThrow(/malformed/);
    expect(() =>
      validateManifest({
        version: 1,
        launchId: 'x',
        chainId: 1,
        sourceCommit: handoff.sourceCommit,
        attestationHash: handoff.attestationHash,
        contracts: [{ name: 'X', address: PJACK, abiHash: handoff.contracts[0].abiHash, abiPath: '../evil.json' }],
        assets: [],
      }),
    ).toThrow(/relative/);
  });

  it('builds the chain from the network block', () => {
    const chain = chainFromManifest({ version: 1, launchId: 'l', chainId: 5, sourceCommit: handoff.sourceCommit, attestationHash: handoff.attestationHash, contracts: [], assets: [] });
    expect(chain.id).toBe(5);
    expect(chain.rpcUrls.default.http).toEqual([]);
  });
});

describe('uniswap v4 helpers', () => {
  it('derives the launch pool key with native ETH as currency0', () => {
    const key = launchPoolKey(zeroAddress, PJACK, 3000, 60);
    expect(key.currency0).toBe(zeroAddress);
    expect(key.currency1).toBe(PJACK);
    expect(poolId(key)).toBe('0x1b3398d4dbc0c6cc59894e14333e81915a2571746d1be7bbca5e9e28787e1989');
  });

  it('sorts two ERC-20 currencies ascending', () => {
    const a = '0x000000000000000000000000000000000000aaaa';
    const key = launchPoolKey(PJACK, a, 500, 10);
    expect(key.currency0).toBe(a);
    expect(key.currency1).toBe(PJACK);
  });

  it('applies slippage in basis points', () => {
    expect(applySlippage(10_000n, 100)).toBe(9_900n);
    expect(applySlippage(10_000n, 0)).toBe(10_000n);
    expect(applySlippage(10_000n, 20_000)).toBe(0n);
  });

  it('encodes execute(0x10, [V4_SWAP input], deadline) with the documented actions', () => {
    const key = launchPoolKey(zeroAddress, PJACK, 3000, 60);
    const amountIn = parseEther('0.001');
    const built = buildUniversalRouterSwap({ poolKey: key, zeroForOne: true, amountIn, amountOutMinimum: 5n, deadline: 123n });
    expect(built.commands).toBe('0x10');
    expect(built.value).toBe(amountIn);
    const decoded = decodeFunctionData({ abi: universalRouterAbi, data: built.data });
    expect(decoded.functionName).toBe('execute');
    const [actions, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], built.inputs[0]);
    expect(actions).toBe('0x060c0f');
    expect(params).toHaveLength(3);
    const [settleCurrency, settleAmount] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], params[1]);
    const [takeCurrency, takeMin] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], params[2]);
    expect(settleCurrency).toBe(zeroAddress);
    expect(settleAmount).toBe(amountIn);
    expect(takeCurrency.toLowerCase()).toBe(PJACK);
    expect(takeMin).toBe(5n);
    const sell = buildUniversalRouterSwap({ poolKey: key, zeroForOne: false, amountIn, amountOutMinimum: 1n, deadline: 1n });
    expect(sell.value).toBe(0n);
  });
});

describe('formatting', () => {
  it('formats and parses amounts', () => {
    expect(formatAmount(parseEther('1234.5678'), 18, 2)).toBe('1,234.56');
    expect(formatAmount(0n, 18)).toBe('0');
    expect(formatAmount(1n, 18, 4)).toBe('<0.0001');
    expect(parseAmountInput('1.5', 18)).toBe(parseEther('1.5'));
    expect(parseAmountInput('abc', 18)).toBeUndefined();
    expect(parseAmountInput('1.0000000000000000001', 18)).toBeUndefined();
    expect(shortAddress(PJACK)).toBe('0xc43F…84d8');
  });
  it('derives a spot price from sqrtPriceX96', () => {
    const p = priceFromSqrtX96(79228162514264337593543950336n, 18, 18);
    expect(p.token1PerToken0).toBe('1');
  });
});

describe('tickets', () => {
  const base = { id: 1n, player: PJACK as `0x${string}`, fee: 10n, payout: 0n, roll: 0 } as const;
  it('shows a stale pending ticket as expired before expire() is called', () => {
    const now = 1_000_000n;
    expect(ticketOutcome({ ...base, status: 'pending', issuedAt: now - 100n }, now).kind).toBe('pending');
    expect(ticketOutcome({ ...base, status: 'pending', issuedAt: now - 90_000n }, now).kind).toBe('expired');
    expect(canExpire({ ...base, status: 'pending', issuedAt: now - 90_000n }, now)).toBe(true);
    expect(canExpire({ ...base, status: 'drawn', issuedAt: now - 90_000n }, now)).toBe(false);
  });
  it('classifies draws', () => {
    expect(ticketOutcome({ ...base, status: 'drawn', issuedAt: 0n, roll: 77, payout: 9n }, 1n)).toEqual({ kind: 'jackpot', roll: 77, payout: 9n });
    expect(ticketOutcome({ ...base, status: 'drawn', issuedAt: 0n, roll: 40, payout: 200n }, 1n).kind).toBe('prize');
    expect(ticketOutcome({ ...base, status: 'drawn', issuedAt: 0n, roll: 41 }, 1n).kind).toBe('lost');
  });
});

describe('error translation', () => {
  it('maps custom errors, rejections and codeless calls', () => {
    const reverted = new BaseError('x', { cause: new ContractFunctionRevertedError({ abi: [{ type: 'error', name: 'Slippage', inputs: [] }], functionName: 'fridgeSwap', data: '0x' }) });
    expect(describeError(new BaseError('x', { cause: new UserRejectedRequestError(new Error('no')) }))).toMatch(/rejected/);
    expect(describeError(reverted)).toMatch(/revert|Slippage|minimum/i);
    expect(describeError(new BaseError('The contract function "pot" returned no data ("0x").'))).toMatch(/no contract code/);
    expect(describeError(Object.assign(new Error('nope'), { code: 4001 }))).toMatch(/rejected/);
  });
});
