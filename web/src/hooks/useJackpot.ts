// Live PepeJackpot reads and the dependency check that gates every jackpot action.
import { useQuery } from '@tanstack/react-query';
import { type Address, zeroAddress } from 'viem';
import { useAccount, usePublicClient, useReadContract, useReadContracts } from 'wagmi';
import { useContractRef } from '../DeploymentContext';
import { POLL_INTERVAL_MS } from '../config';
import { erc20Abi } from '../abis/uniswap';

export interface JackpotDependencies {
  poolManager: Address;
  ice: Address;
  imd: Address;
  iceHook: Address;
  vrfWrapper: Address;
}

export function useJackpotImmutables() {
  const jackpot = useContractRef('PepeJackpot');
  const contracts = (['poolManager', 'ice', 'imd', 'iceHook', 'vrfWrapper'] as const).map((functionName) => ({
    address: jackpot.address,
    abi: jackpot.abi,
    functionName,
  }));
  const q = useReadContracts({ contracts, query: { staleTime: Infinity } });
  const deps: JackpotDependencies | undefined = q.data?.every((r) => r.status === 'success')
    ? {
        poolManager: q.data[0].result as Address,
        ice: q.data[1].result as Address,
        imd: q.data[2].result as Address,
        iceHook: q.data[3].result as Address,
        vrfWrapper: q.data[4].result as Address,
      }
    : undefined;
  return { ...q, deps };
}

export interface DependencyStatus {
  checked: boolean;
  missing: { name: string; address: Address }[];
  /** Reason jackpot actions are unavailable, or undefined when every dependency has code. */
  reason?: string;
}

/** Checks that each immutable dependency has code on the configured chain. */
export function useDependencyStatus(deps: JackpotDependencies | undefined, chainName: string): DependencyStatus {
  const client = usePublicClient();
  const q = useQuery({
    queryKey: ['dependency-code', deps],
    enabled: Boolean(client && deps),
    staleTime: Infinity,
    queryFn: async () => {
      if (!client || !deps) return [];
      const entries = Object.entries(deps) as [keyof JackpotDependencies, Address][];
      const codes = await Promise.all(entries.map(([, address]) => client.getCode({ address }).catch(() => undefined)));
      return entries.filter(([, address], i) => address === zeroAddress || !codes[i] || codes[i] === '0x').map(([name, address]) => ({ name, address }));
    },
  });
  if (!q.data) return { checked: false, missing: [] };
  if (q.data.length === 0) return { checked: true, missing: [] };
  const names = q.data.map((m) => m.name).join(', ');
  return {
    checked: true,
    missing: q.data,
    reason: `The jackpot's immutable dependencies (${names}) have no contract code on ${chainName}, so every jackpot action reverts on this network.`,
  };
}

export function useJackpotState() {
  const jackpot = useContractRef('PepeJackpot');
  const base = { address: jackpot.address, abi: jackpot.abi } as const;
  const live = useReadContracts({
    contracts: [
      { ...base, functionName: 'pot' },
      { ...base, functionName: 'totalClaimable' },
      { ...base, functionName: 'vrfFee' },
    ],
    query: { refetchInterval: POLL_INTERVAL_MS },
  });
  const constants = useReadContracts({
    contracts: [
      { ...base, functionName: 'ICE_TICKET_MIN' },
      { ...base, functionName: 'IMD_TICKET_MIN' },
      { ...base, functionName: 'ETH_TICKET_MIN' },
      { ...base, functionName: 'ICE_PER_PEE' },
      { ...base, functionName: 'TICKET_LIFETIME' },
    ],
    query: { staleTime: Infinity },
  });
  const pick = (r: { status: string; result?: unknown } | undefined) => (r?.status === 'success' ? (r.result as bigint) : undefined);
  return {
    pot: pick(live.data?.[0]),
    potError: live.data?.[0]?.status === 'failure' ? live.data[0].error : undefined,
    totalClaimable: pick(live.data?.[1]),
    vrfFee: pick(live.data?.[2]),
    iceTicketMin: pick(constants.data?.[0]),
    imdTicketMin: pick(constants.data?.[1]),
    ethTicketMin: pick(constants.data?.[2]),
    icePerPee: pick(constants.data?.[3]),
    ticketLifetime: pick(constants.data?.[4]),
    isLoading: live.isLoading,
    refetch: live.refetch,
  };
}

export function useClaimable() {
  const jackpot = useContractRef('PepeJackpot');
  const { address } = useAccount();
  return useReadContract({
    address: jackpot.address,
    abi: jackpot.abi,
    functionName: 'claimable',
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address), refetchInterval: POLL_INTERVAL_MS },
  });
}

/** ERC-20 balance and allowance for the connected account, tolerant of codeless tokens. */
export function useTokenAccount(token: Address | undefined, spender: Address | undefined) {
  const { address } = useAccount();
  const enabled = Boolean(token && address && token !== zeroAddress);
  const q = useReadContracts({
    contracts:
      token && address
        ? [
            { address: token, abi: erc20Abi, functionName: 'balanceOf', args: [address] },
            { address: token, abi: erc20Abi, functionName: 'allowance', args: [address, spender ?? zeroAddress] },
            { address: token, abi: erc20Abi, functionName: 'decimals' },
            { address: token, abi: erc20Abi, functionName: 'symbol' },
          ]
        : [],
    query: { enabled, refetchInterval: POLL_INTERVAL_MS },
  });
  const result = (i: number): unknown => {
    const r = q.data?.[i];
    return r && r.status === 'success' ? r.result : undefined;
  };
  return {
    balance: result(0) as bigint | undefined,
    allowance: result(1) as bigint | undefined,
    decimals: result(2) === undefined ? undefined : Number(result(2)),
    symbol: result(3) as string | undefined,
    unavailable: q.data !== undefined && result(0) === undefined,
    isLoading: q.isLoading,
  };
}
