// Player tickets: TicketIssued logs indexed by player, then each ticket's current storage.
import { useQuery } from '@tanstack/react-query';
import { type Address, type Hash, parseAbiItem } from 'viem';
import { useAccount, usePublicClient } from 'wagmi';
import { useContractRef } from '../DeploymentContext';
import { POLL_INTERVAL_MS } from '../config';
import { DEPLOYMENT_BLOCK } from '../generated/pool';
import { STATUS_BY_CODE, type TicketRecord } from '../lib/tickets';

const ticketIssued = parseAbiItem('event TicketIssued(uint256 indexed requestId, address indexed player, uint256 fee, uint256 expiresAt)');
const drawn = parseAbiItem('event Drawn(uint256 indexed requestId, address indexed player, uint8 roll, uint256 payout, bool deferred)');

const CHUNK = 10_000n;

export function useTickets() {
  const jackpot = useContractRef('PepeJackpot');
  const client = usePublicClient();
  const { address } = useAccount();
  return useQuery({
    queryKey: ['tickets', jackpot.address, address],
    enabled: Boolean(client && address),
    refetchInterval: POLL_INTERVAL_MS,
    queryFn: async (): Promise<TicketRecord[]> => {
      if (!client || !address) return [];
      const latest = await client.getBlockNumber();
      const from = BigInt(DEPLOYMENT_BLOCK);
      const getLogs = (event: typeof ticketIssued | typeof drawn, fromBlock: bigint, toBlock: bigint) =>
        client.getLogs({ address: jackpot.address, event, args: { player: address }, fromBlock, toBlock });
      // One query for the whole range first; chunk only when the endpoint refuses wide ranges.
      let issued: Awaited<ReturnType<typeof getLogs>> = [];
      let drawnLogs: Awaited<ReturnType<typeof getLogs>> = [];
      try {
        [issued, drawnLogs] = await Promise.all([getLogs(ticketIssued, from, latest), getLogs(drawn, from, latest)]);
      } catch {
        for (let start = from; start <= latest; start += CHUNK) {
          const end = start + CHUNK - 1n < latest ? start + CHUNK - 1n : latest;
          const [a, b] = await Promise.all([getLogs(ticketIssued, start, end), getLogs(drawn, start, end)]);
          issued = issued.concat(a);
          drawnLogs = drawnLogs.concat(b);
        }
      }
      const deferredById = new Map<bigint, boolean>();
      for (const log of drawnLogs) {
        const a = log.args as { requestId?: bigint; deferred?: boolean };
        if (a.requestId !== undefined) deferredById.set(a.requestId, Boolean(a.deferred));
      }
      const ids = [...new Set(issued.map((l) => (l.args as { requestId?: bigint }).requestId).filter((x): x is bigint => x !== undefined))];
      const records = await Promise.all(
        ids.map(async (id): Promise<TicketRecord> => {
          const t = (await client.readContract({ address: jackpot.address, abi: jackpot.abi, functionName: 'tickets', args: [id] })) as readonly [
            Address,
            bigint,
            number,
            number,
            bigint,
            bigint,
          ];
          const txHash = issued.find((l) => (l.args as { requestId?: bigint }).requestId === id)?.transactionHash as Hash | undefined;
          return {
            id,
            player: t[0],
            issuedAt: BigInt(t[1]),
            roll: Number(t[2]),
            status: STATUS_BY_CODE[Number(t[3])] ?? 'none',
            fee: t[4],
            payout: t[5],
            deferred: deferredById.get(id),
            txHash,
          };
        }),
      );
      return records.sort((a, b) => (a.issuedAt > b.issuedAt ? -1 : a.issuedAt < b.issuedAt ? 1 : 0));
    },
  });
}
