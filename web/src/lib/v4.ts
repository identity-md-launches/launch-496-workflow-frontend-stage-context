// Uniswap v4 helpers: pool key derivation, pool id and universal-router calldata for a single
// exact-input swap (commands 0x10 V4_SWAP; actions SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL).
import { type Address, type Hex, encodeAbiParameters, encodeFunctionData, keccak256, toHex, zeroAddress } from 'viem';
import { universalRouterAbi } from '../abis/uniswap';
import { UNIVERSAL_ROUTER } from '../config';

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

const POOL_KEY_COMPONENTS = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
] as const;

/** Launch pool key: paired currency vs token sorted ascending (native ETH is always currency0). */
export function launchPoolKey(pairedCurrency: Address, token: Address, fee: number, tickSpacing: number, hooks: Address = zeroAddress): PoolKey {
  const a = pairedCurrency.toLowerCase();
  const b = token.toLowerCase();
  const [currency0, currency1] = a === zeroAddress || BigInt(a) < BigInt(b) ? [pairedCurrency, token] : [token, pairedCurrency];
  return { currency0, currency1, fee, tickSpacing, hooks };
}

export function poolId(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { name: 'currency0', type: 'address' },
        { name: 'currency1', type: 'address' },
        { name: 'fee', type: 'uint24' },
        { name: 'tickSpacing', type: 'int24' },
        { name: 'hooks', type: 'address' },
      ],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

/** Applies a slippage tolerance in basis points to a quoted output. */
export function applySlippage(amountOut: bigint, slippageBps: number): bigint {
  const bps = BigInt(Math.max(0, Math.min(10_000, Math.round(slippageBps))));
  return (amountOut * (10_000n - bps)) / 10_000n;
}

export interface SwapExactInSingle {
  poolKey: PoolKey;
  zeroForOne: boolean;
  amountIn: bigint;
  amountOutMinimum: bigint;
  deadline: bigint;
  hookData?: Hex;
}

/** `inputs[0]` of `execute`: abi.encode(actions, params[]). */
export function encodeV4SwapInput(p: SwapExactInSingle): Hex {
  const inputCurrency = p.zeroForOne ? p.poolKey.currency0 : p.poolKey.currency1;
  const outputCurrency = p.zeroForOne ? p.poolKey.currency1 : p.poolKey.currency0;
  const actions = toHex(new Uint8Array([UNIVERSAL_ROUTER.SWAP_EXACT_IN_SINGLE, UNIVERSAL_ROUTER.SETTLE_ALL, UNIVERSAL_ROUTER.TAKE_ALL]));
  const swapParams = encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          { name: 'poolKey', type: 'tuple', components: POOL_KEY_COMPONENTS },
          { name: 'zeroForOne', type: 'bool' },
          { name: 'amountIn', type: 'uint128' },
          { name: 'amountOutMinimum', type: 'uint128' },
          { name: 'hookData', type: 'bytes' },
        ],
      },
    ],
    [
      {
        poolKey: p.poolKey,
        zeroForOne: p.zeroForOne,
        amountIn: p.amountIn,
        amountOutMinimum: p.amountOutMinimum,
        hookData: p.hookData ?? '0x',
      },
    ],
  );
  const settle = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [inputCurrency, p.amountIn]);
  const take = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [outputCurrency, p.amountOutMinimum]);
  return encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, [swapParams, settle, take]]);
}

export function buildUniversalRouterSwap(p: SwapExactInSingle): { commands: Hex; inputs: Hex[]; deadline: bigint; value: bigint; data: Hex } {
  const commands = toHex(new Uint8Array([UNIVERSAL_ROUTER.V4_SWAP]));
  const inputs = [encodeV4SwapInput(p)];
  const inputCurrency = p.zeroForOne ? p.poolKey.currency0 : p.poolKey.currency1;
  const value = inputCurrency === zeroAddress ? p.amountIn : 0n;
  const data = encodeFunctionData({ abi: universalRouterAbi, functionName: 'execute', args: [commands, inputs, p.deadline] });
  return { commands, inputs, deadline: p.deadline, value, data };
}
