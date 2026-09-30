import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { WagmiProvider } from 'wagmi';
import { DeploymentContext, useDeployment } from './DeploymentContext';
import { FridgeCard, SeedCard, TankCard, ThroneCard } from './components/JackpotActions';
import { PoolSwapCard } from './components/PoolSwapCard';
import { PotCard } from './components/PotCard';
import { TicketsCard } from './components/TicketsCard';
import { TokenCard } from './components/TokenCard';
import { Notice } from './components/ui';
import { WalletBar } from './components/WalletBar';
import { GAME_URL } from './config';
import { type Fetcher, type LoadedDeployment, loadDeployment } from './deployment';
import { useDependencyStatus, useJackpotImmutables } from './hooks/useJackpot';
import { explorerAddressUrl } from './lib/format';
import { createAppWagmiConfig, type WagmiOverrides } from './wallet';

function Page() {
  const dep = useDeployment();
  const { deps, isError: immutablesError } = useJackpotImmutables();
  const status = useDependencyStatus(deps, dep.chain.name);
  const unverified = dep.manifest.contracts.filter((c) => !dep.verified[c.name]).map((c) => c.name);
  return (
    <div className="page">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <div className="brand">
          <img src="./favicon.svg" alt="" width="40" height="40" />
          <div>
            <h1>PepeJackpot</h1>
            <p className="subtitle">
              ICE jackpot for{' '}
              <a href={GAME_URL} target="_blank" rel="noreferrer">
                Pepe's armed with AI
              </a>
              {' · '}
              {dep.chain.name}
              {dep.chain.testnet ? ' testnet' : ''}
            </p>
          </div>
        </div>
        <WalletBar />
      </header>

      <main id="main" tabIndex={-1}>
        {unverified.length > 0 ? (
          <Notice kind="danger" title="ABI verification failed">
            The loaded ABI for {unverified.join(', ')} does not hash to the attested value. Reads continue; transactions for those contracts are disabled.
          </Notice>
        ) : null}
        {immutablesError ? <Notice kind="danger">Unable to read the jackpot contract. Check the RPC connection and reload.</Notice> : null}

        <section className="block" aria-labelledby="pot-heading">
          <h2 id="pot-heading" className="section-title">
            Pot and tickets
          </h2>
          <div className="grid">
            <PotCard deps={deps} status={status} />
            <TicketsCard status={status} />
          </div>
        </section>

        <section className="block" aria-labelledby="actions-heading">
          <h2 id="actions-heading" className="section-title">
            Play
          </h2>
          <p className="section-lede">
            Fridge and throne trades at or above their threshold issue a ticket. Show the expected amounts, approve where needed, then confirm in the wallet. Nothing is
            sent before you confirm.
          </p>
          <div className="grid">
            <FridgeCard deps={deps} status={status} />
            <ThroneCard deps={deps} status={status} />
            <TankCard deps={deps} status={status} />
            <SeedCard deps={deps} status={status} />
          </div>
        </section>

        <section className="block" aria-labelledby="token-heading">
          <h2 id="token-heading" className="section-title">
            PJACK launch token and pool
          </h2>
          <p className="section-lede">The launch protocol requires a separate fixed-supply token and pool. PJACK is not the jackpot's asset; the pot is ICE.</p>
          <div className="grid">
            <TokenCard />
            <PoolSwapCard />
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <p>
          Launch {dep.manifest.launchId} · chain {dep.manifest.chainId} · source commit <span className="mono">{dep.manifest.sourceCommit}</span>
        </p>
        <p>
          Attestation <span className="mono">{dep.manifest.attestationHash}</span>
        </p>
        <p>
          Contracts:{' '}
          {dep.manifest.contracts.map((c, i) => (
            <span key={c.name}>
              {i > 0 ? ' · ' : ''}
              <a href={explorerAddressUrl(dep.network?.explorer, c.address) ?? '#'} target="_blank" rel="noreferrer">
                {c.name}
              </a>
            </span>
          ))}
        </p>
        {dep.network?.faucets?.length ? (
          <p>
            Test ETH:{' '}
            {dep.network.faucets.map((f, i) => (
              <span key={f}>
                {i > 0 ? ' · ' : ''}
                <a href={f} target="_blank" rel="noreferrer">
                  {new URL(f).hostname}
                </a>
              </span>
            ))}
          </p>
        ) : null}
        <p>Reads use the network's public RPC list; transactions are signed by your wallet. This site holds no keys and no private endpoints.</p>
      </footer>
    </div>
  );
}

export interface AppProps {
  baseUrl?: string;
  fetcher?: Fetcher;
  wagmi?: WagmiOverrides;
  deployment?: LoadedDeployment;
}

export function App({ baseUrl, fetcher, wagmi, deployment }: AppProps) {
  const [dep, setDep] = useState<LoadedDeployment | undefined>(deployment);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (deployment) return;
    let cancelled = false;
    loadDeployment(baseUrl ?? document.baseURI, fetcher)
      .then((d) => {
        if (!cancelled) setDep(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [baseUrl, fetcher, deployment]);
  const config = useMemo(() => (dep ? createAppWagmiConfig(dep, wagmi) : undefined), [dep, wagmi]);
  const queryClient = useMemo(() => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }), []);
  if (error) {
    return (
      <div className="page">
        <h1>PepeJackpot</h1>
        <div style={{ marginTop: 16 }}>
          <Notice kind="danger" title="Unable to load the deployment configuration">
            {error}
          </Notice>
        </div>
      </div>
    );
  }
  if (!dep || !config) {
    return (
      <div className="loading-page" role="status">
        Loading deployment configuration…
      </div>
    );
  }
  return (
    <DeploymentContext.Provider value={dep}>
      <WagmiProvider config={config}>
        <QueryClientProvider client={queryClient}>
          <Page />
        </QueryClientProvider>
      </WagmiProvider>
    </DeploymentContext.Provider>
  );
}
