// In-memory JSON-RPC chain and EIP-1193 wallet used by the interaction tests and the browser
// harness. It models only what the site touches: PepeJackpot reads/writes, ERC-20 tokens, the
// Uniswap v4 quoter, StateView, Permit2 and the universal router. No real network is involved.
import {
  type Abi,
  type Address,
  type Hex,
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  getAddress,
  hexToBigInt,
  keccak256,
  numberToHex,
  parseAbiItem,
  toHex,
  zeroAddress,
} from 'viem';
import { erc20Abi, permit2Abi, quoterAbi, stateViewAbi, universalRouterAbi } from '../abis/uniswap';
import jackpotAbiJson from '../../deployment/PepeJackpot.abi.json';
import tokenAbiJson from '../../deployment/LaunchToken.abi.json';
import handoff from '../../deployment/handoff.json';
import networkFile from '../../deployment/network.json';

export const jackpotAbi = jackpotAbiJson as Abi;
export const launchTokenAbi = tokenAbiJson as Abi;

const lower = (a: string) => a.toLowerCase() as Address;

export const ADDR = {
  jackpot: lower(handoff.contracts.find((c) => c.name === 'PepeJackpot')!.address),
  pjack: lower(handoff.contracts.find((c) => c.name === 'LaunchToken')!.address),
  poolManagerMainnet: lower(handoff.manifest.contracts[0].constructorArgs[0]),
  ice: lower(handoff.manifest.contracts[0].constructorArgs[1]),
  iceHook: lower(handoff.manifest.contracts[0].constructorArgs[2]),
  imd: lower(handoff.manifest.contracts[0].constructorArgs[3]),
  vrfWrapper: lower(handoff.manifest.contracts[0].constructorArgs[4]),
  quoter: lower(networkFile.network.uniswapV4.quoter),
  stateView: lower(networkFile.network.uniswapV4.stateView),
  router: lower(networkFile.network.uniswapV4.universalRouter),
  permit2: lower(networkFile.network.uniswapV4.permit2),
  poolManager: lower(networkFile.network.uniswapV4.poolManager),
};

export const PLAYER: Address = '0x1111111111111111111111111111111111111111';
export const CHAIN_ID = handoff.chainId;

class RpcError extends Error {
  constructor(
    message: string,
    public code: number,
    public data?: Hex,
  ) {
    super(message);
  }
}

interface Ticket {
  player: Address;
  issuedAt: bigint;
  roll: number;
  status: number;
  fee: bigint;
  payout: bigint;
}

interface Log {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
}

export interface MockChainOptions {
  /** 'sepolia' mirrors the real deployment: the jackpot's mainnet dependencies have no code. */
  scenario: 'sepolia' | 'dependencies-live';
  /** Chain id the wallet reports initially. */
  walletChainId?: number;
  /** Wallet throws 4902 on the first switch (unknown chain) until wallet_addEthereumChain was called. */
  walletKnowsChain?: boolean;
  rejectSend?: boolean;
}

const ONE = 10n ** 18n;

export class MockChain {
  blockNumber = 11_812_500n;
  balances = new Map<string, bigint>();
  tokens: Record<string, { balances: Map<string, bigint>; allowances: Map<string, bigint>; nonces: Map<string, bigint>; name: string; symbol: string; totalSupply: bigint }> = {};
  permit2 = new Map<string, { amount: bigint; expiration: number }>();
  pot = 250_000n * ONE;
  totalClaimable = 0n;
  claimable = new Map<string, bigint>();
  tickets = new Map<bigint, Ticket>();
  logs: Log[] = [];
  nextRequestId = 1n;
  txCount = 0;
  calls: { method: string; params: unknown }[] = [];
  sentTransactions: { to: Address; data: Hex; value: bigint }[] = [];
  vrfFee = 3n * 10n ** 15n;
  /** PJACK per ETH in the launch pool. */
  poolRate = 50_000n;
  poolSqrtPriceX96 = 560227709747861399187319382274582n;
  poolLiquidity = 0n;
  readonly scenario: MockChainOptions['scenario'];

  constructor(options: MockChainOptions) {
    this.scenario = options.scenario;
    this.balances.set(PLAYER, 5n * ONE);
    this.tokens[ADDR.pjack] = this.token('PepeJackpot', 'PJACK', 1_000_000_000n * ONE, 1_000n * ONE);
    this.tokens[ADDR.ice] = this.token('ICE', 'ICE', 0n, 50_000n * ONE);
    this.tokens[ADDR.imd] = this.token('IMD', 'IMD', 0n, 10n * ONE);
  }

  private token(name: string, symbol: string, totalSupply: bigint, playerBalance: bigint) {
    const balances = new Map<string, bigint>([[PLAYER, playerBalance]]);
    return { balances, allowances: new Map(), nonces: new Map(), name, symbol, totalSupply };
  }

  hasCode(address: Address): boolean {
    const a = lower(address);
    if ([ADDR.jackpot, ADDR.pjack, ADDR.quoter, ADDR.stateView, ADDR.router, ADDR.permit2, ADDR.poolManager].includes(a)) return true;
    if ([ADDR.ice, ADDR.imd, ADDR.iceHook, ADDR.vrfWrapper, ADDR.poolManagerMainnet].includes(a)) return this.scenario === 'dependencies-live';
    return false;
  }

  issueTicket(player: Address, fee: bigint, status = 1, roll = 0, payout = 0n, ageSeconds = 60): bigint {
    const id = this.nextRequestId++;
    const issuedAt = BigInt(Math.floor(Date.now() / 1000) - ageSeconds);
    this.tickets.set(id, { player, issuedAt, roll, status, fee, payout });
    const txHash = keccak256(toHex(`ticket-${id}`));
    this.logs.push({
      address: ADDR.jackpot,
      topics: encodeEventTopics({ abi: jackpotAbi, eventName: 'TicketIssued', args: { requestId: id, player } }) as Hex[],
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [fee, issuedAt + 86_400n]),
      blockNumber: this.blockNumber,
      transactionHash: txHash,
      logIndex: this.logs.length,
    });
    if (status === 2) {
      this.logs.push({
        address: ADDR.jackpot,
        topics: encodeEventTopics({ abi: jackpotAbi, eventName: 'Drawn', args: { requestId: id, player } }) as Hex[],
        data: encodeAbiParameters([{ type: 'uint8' }, { type: 'uint256' }, { type: 'bool' }], [roll, payout, false]),
        blockNumber: this.blockNumber,
        transactionHash: txHash,
        logIndex: this.logs.length,
      });
    }
    return id;
  }

  /** JSON-RPC entry point (single or batched). */
  async rpc(body: unknown): Promise<unknown> {
    if (Array.isArray(body)) return Promise.all(body.map((b) => this.rpc(b)));
    const { id, method, params } = body as { id: number; method: string; params: unknown[] };
    this.calls.push({ method, params });
    try {
      const result = await this.handle(method, params ?? []);
      return { jsonrpc: '2.0', id, result };
    } catch (e) {
      if (e instanceof RpcError) return { jsonrpc: '2.0', id, error: { code: e.code, message: e.message, data: e.data } };
      return { jsonrpc: '2.0', id, error: { code: -32000, message: (e as Error).message } };
    }
  }

  /** viem `custom()` transport shape. */
  request = async ({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> => {
    const res = (await this.rpc({ id: 1, method, params })) as { result?: unknown; error?: { code: number; message: string; data?: Hex } };
    if (res.error) {
      const err = new Error(res.error.message) as Error & { code: number; data?: Hex };
      err.code = res.error.code;
      err.data = res.error.data;
      throw err;
    }
    return res.result;
  };

  private async handle(method: string, params: unknown[]): Promise<unknown> {
    switch (method) {
      case 'eth_chainId':
        return numberToHex(CHAIN_ID);
      case 'net_version':
        return String(CHAIN_ID);
      case 'eth_blockNumber':
        return numberToHex(this.blockNumber);
      case 'eth_gasPrice':
      case 'eth_maxPriorityFeePerGas':
        return numberToHex(1_000_000_000n);
      case 'eth_feeHistory':
        return { oldestBlock: numberToHex(this.blockNumber), baseFeePerGas: [numberToHex(1_000_000_000n), numberToHex(1_000_000_000n)], gasUsedRatio: [0.5], reward: [[numberToHex(1_000_000_000n)]] };
      case 'eth_getBlockByNumber':
        return { number: numberToHex(this.blockNumber), hash: keccak256(toHex(this.blockNumber)), timestamp: numberToHex(BigInt(Math.floor(Date.now() / 1000))), baseFeePerGas: numberToHex(1_000_000_000n), gasLimit: numberToHex(30_000_000n), gasUsed: '0x0', transactions: [], parentHash: keccak256('0x01'), miner: zeroAddress, nonce: '0x0000000000000000', difficulty: '0x0', extraData: '0x', logsBloom: `0x${'0'.repeat(512)}`, mixHash: keccak256('0x02'), receiptsRoot: keccak256('0x03'), sha3Uncles: keccak256('0x04'), size: '0x0', stateRoot: keccak256('0x05'), totalDifficulty: '0x0', transactionsRoot: keccak256('0x06'), uncles: [] };
      case 'eth_getBalance':
        return numberToHex(this.balances.get(lower((params as [Address])[0])) ?? 0n);
      case 'eth_getTransactionCount':
        return numberToHex(BigInt(this.txCount));
      case 'eth_getCode':
        return this.hasCode((params as [Address])[0]) ? '0x6080' : '0x';
      case 'eth_estimateGas':
        this.simulate((params as [{ to: Address; data: Hex; value?: Hex; from?: Address }])[0]);
        return numberToHex(150_000n);
      case 'eth_call': {
        const tx = (params as [{ to: Address; data: Hex; value?: Hex; from?: Address }])[0];
        return this.simulate(tx);
      }
      case 'eth_getLogs':
        return this.getLogs((params as [{ address?: Address; topics?: (Hex | null)[]; fromBlock?: Hex; toBlock?: Hex }])[0]);
      case 'eth_sendTransaction': {
        const tx = (params as [{ to: Address; data: Hex; value?: Hex; from: Address }])[0];
        return this.sendTransaction(tx);
      }
      case 'eth_sendRawTransaction':
        throw new RpcError('raw transactions are not supported by the mock', -32601);
      case 'eth_getTransactionReceipt': {
        const hash = (params as [Hex])[0];
        return { transactionHash: hash, blockNumber: numberToHex(this.blockNumber), blockHash: keccak256(hash), status: '0x1', from: PLAYER, to: ADDR.jackpot, gasUsed: '0x5208', cumulativeGasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', logs: [], logsBloom: `0x${'0'.repeat(512)}`, transactionIndex: '0x0', type: '0x2', contractAddress: null };
      }
      case 'eth_getTransactionByHash': {
        const hash = (params as [Hex])[0];
        return { hash, blockNumber: numberToHex(this.blockNumber), blockHash: keccak256(hash), from: PLAYER, to: ADDR.jackpot, gas: '0x5208', gasPrice: '0x3b9aca00', input: '0x', nonce: '0x0', value: '0x0', transactionIndex: '0x0', type: '0x2', v: '0x0', r: '0x0', s: '0x0', chainId: numberToHex(CHAIN_ID) };
      }
      default:
        throw new RpcError(`Method ${method} not supported by the mock`, -32601);
    }
  }

  private getLogs(filter: { address?: Address; topics?: (Hex | null)[]; fromBlock?: Hex; toBlock?: Hex }): unknown[] {
    return this.logs
      .filter((l) => !filter.address || lower(filter.address) === l.address)
      .filter((l) => !filter.topics || filter.topics.every((t, i) => t === null || t === undefined || (Array.isArray(t) ? t.includes(l.topics[i]) : l.topics[i] === t)))
      .map((l) => ({ ...l, blockNumber: numberToHex(l.blockNumber), logIndex: numberToHex(BigInt(l.logIndex)), transactionIndex: '0x0', blockHash: keccak256(toHex(l.blockNumber)), removed: false }));
  }

  private revert(abi: Abi, errorName: string): never {
    throw new RpcError('execution reverted', 3, encodeErrorResult({ abi, errorName }));
  }

  private simulate(tx: { to: Address; data: Hex; value?: Hex; from?: Address }): Hex {
    const to = lower(tx.to);
    if (!this.hasCode(to)) return '0x';
    const value = tx.value ? hexToBigInt(tx.value) : 0n;
    const from = tx.from ? lower(tx.from) : PLAYER;
    if (to === ADDR.jackpot) return this.jackpotCall(tx.data, from, value, false);
    if (this.tokens[to]) return this.erc20Call(to, tx.data, from, false);
    if (to === ADDR.quoter) return this.quoterCall(tx.data);
    if (to === ADDR.stateView) return this.stateViewCall(tx.data);
    if (to === ADDR.permit2) return this.permit2Call(tx.data, from, false);
    if (to === ADDR.router) return this.routerCall(tx.data, from, value, false);
    return '0x';
  }

  private sendTransaction(tx: { to: Address; data: Hex; value?: Hex; from: Address }): Hex {
    const to = lower(tx.to);
    const value = tx.value ? hexToBigInt(tx.value) : 0n;
    const from = lower(tx.from);
    this.sentTransactions.push({ to, data: tx.data, value });
    if (to === ADDR.jackpot) this.jackpotCall(tx.data, from, value, true);
    else if (this.tokens[to]) this.erc20Call(to, tx.data, from, true);
    else if (to === ADDR.permit2) this.permit2Call(tx.data, from, true);
    else if (to === ADDR.router) this.routerCall(tx.data, from, value, true);
    else throw new RpcError('execution reverted', 3);
    this.txCount += 1;
    this.blockNumber += 1n;
    return keccak256(toHex(`tx-${this.txCount}`));
  }

  private jackpotCall(data: Hex, from: Address, value: bigint, apply: boolean): Hex {
    const { functionName, args } = decodeFunctionData({ abi: jackpotAbi, data });
    const result = (r: unknown) => encodeFunctionResult({ abi: jackpotAbi, functionName, result: r as never });
    const depsLive = this.scenario === 'dependencies-live';
    const requireDeps = () => {
      if (!depsLive) throw new RpcError('execution reverted', 3, '0x');
    };
    switch (functionName) {
      case 'poolManager':
        return result(getAddress(ADDR.poolManagerMainnet));
      case 'ice':
        return result(getAddress(ADDR.ice));
      case 'imd':
        return result(getAddress(ADDR.imd));
      case 'iceHook':
        return result(getAddress(ADDR.iceHook));
      case 'vrfWrapper':
        return result(getAddress(ADDR.vrfWrapper));
      case 'ICE_TICKET_MIN':
        return result(10_000n * ONE);
      case 'IMD_TICKET_MIN':
        return result(ONE / 10n);
      case 'ETH_TICKET_MIN':
        return result(ONE / 1000n);
      case 'ICE_PER_PEE':
        return result(1_000n * ONE);
      case 'TICKET_LIFETIME':
        return result(86_400n);
      case 'totalClaimable':
        return result(this.totalClaimable);
      case 'pot':
        requireDeps();
        return result(this.pot);
      case 'vrfFee':
        requireDeps();
        return result(this.vrfFee);
      case 'claimable':
        return result(this.claimable.get(lower((args as [Address])[0])) ?? 0n);
      case 'tickets': {
        const t = this.tickets.get((args as [bigint])[0]);
        if (!t) return result([zeroAddress, 0n, 0, 0, 0n, 0n]);
        return result([t.player, t.issuedAt, t.roll, t.status, t.fee, t.payout]);
      }
      case 'quoteFridgeSwap': {
        requireDeps();
        const [iceToImd, amountIn] = args as [boolean, bigint];
        if (amountIn === 0n) this.revert(jackpotAbi, 'InvalidAmount');
        // 1 ICE = 0.00001 IMD in this mock.
        if (iceToImd) return result([(amountIn * 99n) / 100n / 100_000n, amountIn / 100n]);
        const gross = amountIn * 100_000n;
        return result([gross - gross / 100n, gross / 100n]);
      }
      case 'quoteGoldenThrone': {
        requireDeps();
        const [ethIn] = args as [bigint];
        if (ethIn === 0n) this.revert(jackpotAbi, 'InvalidAmount');
        return result([(ethIn - ethIn / 100n) * 1_000n, (ethIn / 100n) * 20_000_000n]);
      }
      case 'fridgeSwap': {
        requireDeps();
        const [iceToImd, amountIn, minOut] = args as [boolean, bigint, bigint, bigint];
        const token = iceToImd ? ADDR.ice : ADDR.imd;
        if ((this.tokens[token].allowances.get(`${from}:${ADDR.jackpot}`) ?? 0n) < amountIn) this.revert(jackpotAbi, 'TokenTransferFailed');
        const eligible = amountIn >= (iceToImd ? 10_000n * ONE : ONE / 10n);
        if (eligible && value < this.vrfFee) this.revert(jackpotAbi, 'InsufficientVRFFee');
        if (minOut === 0n) this.revert(jackpotAbi, 'InvalidAmount');
        if (apply) {
          const bal = this.tokens[token].balances;
          bal.set(from, (bal.get(from) ?? 0n) - amountIn);
          const fee = iceToImd ? amountIn / 100n : (amountIn * 100_000n) / 100n;
          this.pot += fee;
          if (eligible) this.issueTicket(from, fee);
        }
        return result([minOut, eligible ? this.nextRequestId : 0n]);
      }
      case 'goldenThrone': {
        requireDeps();
        const [ethIn, minImdOut, minIceFee] = args as [bigint, bigint, bigint, bigint];
        if (minImdOut === 0n || minIceFee === 0n) this.revert(jackpotAbi, 'InvalidAmount');
        if (value < ethIn) this.revert(jackpotAbi, 'InsufficientVRFFee');
        const eligible = ethIn >= ONE / 1000n;
        if (eligible && value - ethIn < this.vrfFee) this.revert(jackpotAbi, 'InsufficientVRFFee');
        if (apply) {
          this.balances.set(from, (this.balances.get(from) ?? 0n) - ethIn - (eligible ? this.vrfFee : 0n));
          const fee = (ethIn / 100n) * 20_000_000n;
          this.pot += fee;
          if (eligible) this.issueTicket(from, fee);
        }
        return result([minImdOut, eligible ? this.nextRequestId : 0n]);
      }
      case 'seed': {
        requireDeps();
        const [amount] = args as [bigint];
        if (amount === 0n) this.revert(jackpotAbi, 'InvalidAmount');
        if ((this.tokens[ADDR.ice].allowances.get(`${from}:${ADDR.jackpot}`) ?? 0n) < amount) this.revert(jackpotAbi, 'TokenTransferFailed');
        if (apply) {
          const bal = this.tokens[ADDR.ice].balances;
          bal.set(from, (bal.get(from) ?? 0n) - amount);
          this.pot += amount;
        }
        return '0x';
      }
      case 'fillTank': {
        requireDeps();
        const [pees] = args as [bigint, unknown];
        if (pees === 0n) this.revert(jackpotAbi, 'InvalidAmount');
        if (apply) {
          const bal = this.tokens[ADDR.ice].balances;
          bal.set(from, (bal.get(from) ?? 0n) - pees * 1_000n * ONE);
          this.pot += pees * 1_000n * ONE;
        }
        return '0x';
      }
      case 'claim': {
        requireDeps();
        const amount = this.claimable.get(from) ?? 0n;
        if (amount === 0n) this.revert(jackpotAbi, 'NothingToClaim');
        if (apply) {
          this.claimable.set(from, 0n);
          this.totalClaimable -= amount;
          const bal = this.tokens[ADDR.ice].balances;
          bal.set(from, (bal.get(from) ?? 0n) + amount);
        }
        return '0x';
      }
      case 'expire': {
        const [id] = args as [bigint];
        const t = this.tickets.get(id);
        if (!t || t.status !== 1) this.revert(jackpotAbi, 'TicketNotPending');
        if (BigInt(Math.floor(Date.now() / 1000)) < t.issuedAt + 86_400n) this.revert(jackpotAbi, 'TicketNotExpired');
        if (apply) t.status = 3;
        return '0x';
      }
      default:
        throw new RpcError(`jackpot.${functionName} not mocked`, -32000);
    }
  }

  private erc20Call(token: Address, data: Hex, from: Address, apply: boolean): Hex {
    const abi = token === ADDR.pjack ? launchTokenAbi : erc20Abi;
    const t = this.tokens[token];
    const { functionName, args } = decodeFunctionData({ abi, data });
    const result = (r: unknown) => encodeFunctionResult({ abi, functionName, result: r as never });
    switch (functionName) {
      case 'name':
        return result(t.name);
      case 'symbol':
        return result(t.symbol);
      case 'decimals':
        return result(18);
      case 'totalSupply':
        return result(t.totalSupply);
      case 'balanceOf':
        return result(t.balances.get(lower((args as [Address])[0])) ?? 0n);
      case 'allowance': {
        const [owner, spender] = args as [Address, Address];
        return result(t.allowances.get(`${lower(owner)}:${lower(spender)}`) ?? 0n);
      }
      case 'nonces':
        return result(t.nonces.get(lower((args as [Address])[0])) ?? 0n);
      case 'eip712Domain':
        return result(['0x0f', t.name, '1', BigInt(CHAIN_ID), getAddress(token), `0x${'0'.repeat(64)}`, []]);
      case 'approve': {
        const [spender, amount] = args as [Address, bigint];
        if (apply) t.allowances.set(`${from}:${lower(spender)}`, amount);
        return result(true);
      }
      case 'transfer': {
        const [to, amount] = args as [Address, bigint];
        const bal = t.balances.get(from) ?? 0n;
        if (bal < amount) throw new RpcError('execution reverted', 3, encodeErrorResult({ abi: launchTokenAbi, errorName: 'ERC20InsufficientBalance', args: [from, bal, amount] }));
        if (apply) {
          t.balances.set(from, bal - amount);
          t.balances.set(lower(to), (t.balances.get(lower(to)) ?? 0n) + amount);
        }
        return result(true);
      }
      default:
        throw new RpcError(`erc20.${functionName} not mocked`, -32000);
    }
  }

  private quoterCall(data: Hex): Hex {
    const { functionName, args } = decodeFunctionData({ abi: quoterAbi, data });
    const [p] = args as unknown as [{ poolKey: { currency0: Address; currency1: Address }; zeroForOne: boolean; exactAmount: bigint }];
    const out = p.zeroForOne ? p.exactAmount * this.poolRate : p.exactAmount / this.poolRate;
    return encodeFunctionResult({ abi: quoterAbi, functionName, result: [out, 90_000n] });
  }

  private stateViewCall(data: Hex): Hex {
    const { functionName } = decodeFunctionData({ abi: stateViewAbi, data });
    if (functionName === 'getSlot0') return encodeFunctionResult({ abi: stateViewAbi, functionName, result: [this.poolSqrtPriceX96, 177_284, 0, 3000] });
    return encodeFunctionResult({ abi: stateViewAbi, functionName: 'getLiquidity', result: this.poolLiquidity });
  }

  private permit2Call(data: Hex, from: Address, apply: boolean): Hex {
    const { functionName, args } = decodeFunctionData({ abi: permit2Abi, data });
    if (functionName === 'allowance') {
      const [user, token, spender] = args as [Address, Address, Address];
      const a = this.permit2.get(`${lower(user)}:${lower(token)}:${lower(spender)}`);
      return encodeFunctionResult({ abi: permit2Abi, functionName, result: [a?.amount ?? 0n, a?.expiration ?? 0, 0] });
    }
    const [token, spender, amount, expiration] = args as [Address, Address, bigint, number];
    if (apply) this.permit2.set(`${from}:${lower(token)}:${lower(spender)}`, { amount, expiration });
    return '0x';
  }

  private routerCall(data: Hex, from: Address, value: bigint, apply: boolean): Hex {
    const { args } = decodeFunctionData({ abi: universalRouterAbi, data });
    const [commands, inputs, deadline] = args as [Hex, Hex[], bigint];
    if (commands !== '0x10') throw new RpcError('execution reverted: unexpected command', 3);
    if (deadline < BigInt(Math.floor(Date.now() / 1000))) throw new RpcError('execution reverted: deadline', 3);
    const [actions, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], inputs[0]);
    if (actions !== '0x060c0f') throw new RpcError('execution reverted: unexpected actions', 3);
    const [swap] = decodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [
            { name: 'poolKey', type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] },
            { name: 'zeroForOne', type: 'bool' },
            { name: 'amountIn', type: 'uint128' },
            { name: 'amountOutMinimum', type: 'uint128' },
            { name: 'hookData', type: 'bytes' },
          ],
        },
      ],
      params[0],
    );
    const pjack = this.tokens[ADDR.pjack];
    if (swap.zeroForOne) {
      if (value !== swap.amountIn) throw new RpcError('execution reverted: value mismatch', 3);
      const out = swap.amountIn * this.poolRate;
      if (out < swap.amountOutMinimum) throw new RpcError('execution reverted: V4TooLittleReceived', 3);
      if (apply) {
        this.balances.set(from, (this.balances.get(from) ?? 0n) - value);
        pjack.balances.set(from, (pjack.balances.get(from) ?? 0n) + out);
      }
    } else {
      const p2 = this.permit2.get(`${from}:${ADDR.pjack}:${ADDR.router}`);
      if (!p2 || p2.amount < swap.amountIn) throw new RpcError('execution reverted: AllowanceExpired', 3);
      if ((pjack.allowances.get(`${from}:${ADDR.permit2}`) ?? 0n) < swap.amountIn) throw new RpcError('execution reverted: TRANSFER_FROM_FAILED', 3);
      const out = swap.amountIn / this.poolRate;
      if (out < swap.amountOutMinimum) throw new RpcError('execution reverted: V4TooLittleReceived', 3);
      if (apply) {
        pjack.balances.set(from, (pjack.balances.get(from) ?? 0n) - swap.amountIn);
        this.balances.set(from, (this.balances.get(from) ?? 0n) + out);
      }
    }
    return '0x';
  }
}

/** EIP-1193 wallet backed by a MockChain. */
export class MockWallet {
  chainId: number;
  knowsChain: boolean;
  authorized = false;
  addedChains: unknown[] = [];
  switchRequests: string[] = [];
  private listeners = new Map<string, Set<(...a: unknown[]) => void>>();

  constructor(
    private chain: MockChain,
    private options: MockChainOptions,
  ) {
    this.chainId = options.walletChainId ?? CHAIN_ID;
    this.knowsChain = options.walletKnowsChain ?? true;
  }

  on(event: string, fn: (...a: unknown[]) => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
  }

  removeListener(event: string, fn: (...a: unknown[]) => void) {
    this.listeners.get(event)?.delete(fn);
  }

  private emit(event: string, ...args: unknown[]) {
    this.listeners.get(event)?.forEach((fn) => fn(...args));
  }

  request = async ({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> => {
    switch (method) {
      case 'eth_requestAccounts':
        this.authorized = true;
        return [PLAYER];
      case 'eth_accounts':
        // Like a real wallet: no accounts until the site was authorized.
        return this.authorized ? [PLAYER] : [];
      case 'eth_chainId':
        return numberToHex(this.chainId);
      case 'wallet_switchEthereumChain': {
        const target = (params as [{ chainId: Hex }])[0].chainId;
        this.switchRequests.push(target);
        if (Number(target) === CHAIN_ID && !this.knowsChain) {
          const err = new Error('Unrecognized chain ID. Try adding the chain first.') as Error & { code: number };
          err.code = 4902;
          throw err;
        }
        this.chainId = Number(target);
        this.emit('chainChanged', numberToHex(this.chainId));
        return null;
      }
      case 'wallet_addEthereumChain':
        this.addedChains.push((params as unknown[])[0]);
        this.knowsChain = true;
        return null;
      case 'eth_signTypedData_v4':
        return `0x${'ab'.repeat(64)}1b`;
      case 'eth_sendTransaction': {
        if (this.options.rejectSend) {
          const err = new Error('User rejected the request.') as Error & { code: number };
          err.code = 4001;
          throw err;
        }
        return this.chain.request({ method, params });
      }
      default:
        return this.chain.request({ method, params });
    }
  };
}

export function createMocks(options: MockChainOptions) {
  const chain = new MockChain(options);
  const wallet = new MockWallet(chain, options);
  return { chain, wallet };
}

export const ticketIssuedEvent = parseAbiItem('event TicketIssued(uint256 indexed requestId, address indexed player, uint256 fee, uint256 expiresAt)');
