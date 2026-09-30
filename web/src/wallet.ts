// wagmi configuration built at runtime from the loaded deployment. Reads go through the network's
// public RPC list (fallback order as listed); signing stays with the visitor's wallet.
import { type Config, createConfig, fallback, http, type CreateConnectorFn, type Transport } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { numberToHex } from 'viem';
import type { LoadedDeployment, WalletAddChain } from './deployment';

export interface WagmiOverrides {
  connectors?: CreateConnectorFn[];
  transport?: Transport;
}

export function createAppWagmiConfig(dep: LoadedDeployment, overrides: WagmiOverrides = {}): Config {
  const rpcUrls = dep.chain.rpcUrls.default.http;
  const transport =
    overrides.transport ??
    (rpcUrls.length > 0 ? fallback(rpcUrls.map((url) => http(url, { batch: true, retryCount: 1 }))) : http());
  return createConfig({
    chains: [dep.chain],
    connectors: overrides.connectors ?? [injected()],
    multiInjectedProviderDiscovery: overrides.connectors === undefined,
    transports: { [dep.chain.id]: transport },
  });
}

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

function errorCode(e: unknown): number | undefined {
  const err = e as { code?: number; cause?: { code?: number }; data?: { originalError?: { code?: number } } } | undefined;
  return err?.code ?? err?.cause?.code ?? err?.data?.originalError?.code;
}

function looksLikeUnknownChain(e: unknown): boolean {
  const code = errorCode(e);
  if (code === 4902) return true;
  const message = String((e as { message?: string })?.message ?? e ?? '');
  return /unrecognized chain|unknown chain|chain.*not (been )?added|not configured|4902/i.test(message);
}

/**
 * wallet_switchEthereumChain; when the wallet reports the chain as unknown (4902 or an equivalent
 * message), wallet_addEthereumChain with the handoff's exact `walletAddChain` parameters, then switch again.
 */
export async function switchOrAddChain(provider: Eip1193, chainId: number, walletAddChain: WalletAddChain | undefined): Promise<void> {
  const hexId = numberToHex(chainId);
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] });
    return;
  } catch (e) {
    if (!looksLikeUnknownChain(e)) throw e;
    if (!walletAddChain) throw new Error('This wallet does not know the network and no add-chain parameters were supplied.');
    await provider.request({ method: 'wallet_addEthereumChain', params: [walletAddChain] });
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] });
  }
}
