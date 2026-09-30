// Prerequisites shared by every transaction control (frontend-ux rule 2, in this order):
// wallet connected -> correct network -> ABI verified -> feature-specific checks by the caller.
import { useAccount, useChainId } from 'wagmi';
import { useDeployment } from '../DeploymentContext';

export interface Gate {
  connected: boolean;
  wrongNetwork: boolean;
  /** First unmet prerequisite, or undefined when transactions may proceed. */
  reason?: string;
}

export function useGate(contractName: string): Gate {
  const dep = useDeployment();
  const { isConnected, chainId: accountChainId } = useAccount();
  const fallbackChainId = useChainId();
  const current = accountChainId ?? fallbackChainId;
  const wrongNetwork = isConnected && current !== dep.chain.id;
  let reason: string | undefined;
  if (!isConnected) reason = 'Connect a wallet to use this action.';
  else if (wrongNetwork) reason = `Switch the wallet to ${dep.chain.name} first.`;
  else if (!dep.verified[contractName]) reason = `The ${contractName} ABI does not match the attested hash; transactions stay disabled.`;
  return { connected: isConnected, wrongNetwork, reason };
}
