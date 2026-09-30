// One transaction lifecycle per action (frontend-ux rule 1): simulate, ask the wallet, wait for the
// receipt, then refresh reads. Each card owns its own instance so pending states never collide.
import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Abi, Address, Hash } from 'viem';
import { useAccount, usePublicClient, useWalletClient } from 'wagmi';
import { describeError } from '../lib/errors';

export type TxPhase = 'idle' | 'simulating' | 'wallet' | 'pending' | 'confirmed' | 'error';

export interface TxState {
  phase: TxPhase;
  hash?: Hash;
  error?: string;
  label?: string;
}

export interface TxRequest {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
  /** Shown while the action runs, e.g. "Approving". */
  label: string;
}

export function useTx() {
  const [state, setState] = useState<TxState>({ phase: 'idle' });
  const { address: account } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const queryClient = useQueryClient();
  const busy = useRef(false);

  const run = useCallback(
    async (req: TxRequest): Promise<Hash | undefined> => {
      if (busy.current) return undefined;
      if (!publicClient || !walletClient || !account) {
        setState({ phase: 'error', error: 'Connect a wallet first.' });
        return undefined;
      }
      busy.current = true;
      setState({ phase: 'simulating', label: req.label });
      try {
        const { request } = await publicClient.simulateContract({
          account,
          address: req.address,
          abi: req.abi,
          functionName: req.functionName,
          args: req.args as never,
          value: req.value,
        });
        setState({ phase: 'wallet', label: req.label });
        const hash = await walletClient.writeContract(request as never);
        setState({ phase: 'pending', hash, label: req.label });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== 'success') {
          setState({ phase: 'error', hash, error: 'The transaction was mined but reverted.' });
          return hash;
        }
        setState({ phase: 'confirmed', hash, label: req.label });
        await queryClient.invalidateQueries();
        return hash;
      } catch (e) {
        setState({ phase: 'error', error: describeError(e) });
        return undefined;
      } finally {
        busy.current = false;
      }
    },
    [account, publicClient, walletClient, queryClient],
  );

  const reset = useCallback(() => setState({ phase: 'idle' }), []);
  const inFlight = state.phase === 'simulating' || state.phase === 'wallet' || state.phase === 'pending';
  return { state, run, reset, inFlight };
}
