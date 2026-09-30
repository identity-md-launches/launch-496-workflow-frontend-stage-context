// Wallet connection, network state and the single "Switch to <network>" control.
import { useState } from 'react';
import { useAccount, useChainId, useConnect, useDisconnect } from 'wagmi';
import { useDeployment } from '../DeploymentContext';
import { describeError } from '../lib/errors';
import { switchOrAddChain } from '../wallet';
import { AddressDisplay, Spinner } from './ui';

export function useWrongNetwork(): boolean {
  const dep = useDeployment();
  const { isConnected, chainId: accountChainId } = useAccount();
  const chainId = useChainId();
  const current = accountChainId ?? chainId;
  return isConnected && current !== dep.chain.id;
}

export function WalletBar() {
  const dep = useDeployment();
  const { address, isConnected, connector } = useAccount();
  const { connectors, connectAsync, isPending: connecting } = useConnect();
  const { disconnect } = useDisconnect();
  const wrongNetwork = useWrongNetwork();
  const [error, setError] = useState<string>();
  const [switching, setSwitching] = useState(false);

  const connect = async (c: (typeof connectors)[number]) => {
    setError(undefined);
    try {
      await connectAsync({ connector: c });
    } catch (e) {
      setError(describeError(e));
    }
  };

  const switchNetwork = async () => {
    if (!connector) return;
    setError(undefined);
    setSwitching(true);
    try {
      const provider = (await connector.getProvider()) as { request(a: { method: string; params?: unknown[] }): Promise<unknown> };
      await switchOrAddChain(provider, dep.chain.id, dep.walletAddChain);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setSwitching(false);
    }
  };

  const visibleConnectors = connectors.filter((c, i, all) => all.findIndex((x) => x.name === c.name) === i);

  return (
    <div className="wallet-bar" aria-label="Wallet">
      {isConnected && address ? (
        <>
          <span className={`badge ${wrongNetwork ? 'danger' : 'accent'}`}>{wrongNetwork ? 'Wrong network' : dep.chain.name}</span>
          <AddressDisplay address={address} label="connected address" />
          {wrongNetwork ? (
            <button type="button" className="btn primary" onClick={switchNetwork} disabled={switching} aria-busy={switching || undefined}>
              {switching ? <Spinner /> : null}
              {switching ? 'Switching…' : `Switch to ${dep.chain.name}`}
            </button>
          ) : null}
          <button type="button" className="btn small" onClick={() => disconnect()}>
            Disconnect
          </button>
        </>
      ) : visibleConnectors.length === 0 ? (
        <p className="small muted">No browser wallet detected. Install a wallet extension, then reload this page.</p>
      ) : (
        visibleConnectors.map((c) => (
          <button key={c.uid} type="button" className="btn primary" onClick={() => connect(c)} disabled={connecting} aria-busy={connecting || undefined}>
            {connecting ? <Spinner /> : null}
            {visibleConnectors.length === 1 ? 'Connect wallet' : `Connect ${c.name}`}
          </button>
        ))
      )}
      {error ? (
        <p className="small" style={{ color: 'var(--color-danger-text)', width: '100%' }} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
