import { createContext, useContext } from 'react';
import type { Abi, Address } from 'viem';
import type { LoadedDeployment } from './deployment';

export const DeploymentContext = createContext<LoadedDeployment | null>(null);

export function useDeployment(): LoadedDeployment {
  const dep = useContext(DeploymentContext);
  if (!dep) throw new Error('DeploymentContext missing');
  return dep;
}

export interface ContractRef {
  address: Address;
  abi: Abi;
  verified: boolean;
}

export function useContractRef(name: string): ContractRef {
  const dep = useDeployment();
  const address = dep.addresses[name];
  const abi = dep.abis[name];
  if (!address || !abi) throw new Error(`Contract ${name} is not in imd-deployment.json`);
  return { address, abi, verified: dep.verified[name] === true };
}
