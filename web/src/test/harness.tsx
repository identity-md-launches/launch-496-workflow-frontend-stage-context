// Test harness: renders the real App against the mock chain and wallet, loading the committed
// deployment files from web/public so the runtime configuration path is exercised end to end.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from '@testing-library/react';
import { custom } from 'viem';
import { injected } from 'wagmi/connectors';
import { App } from '../App';
import type { Fetcher } from '../deployment';
import { createMocks, type MockChainOptions } from './mockChain';

const publicDir = join(__dirname, '..', '..', 'public');

export function fileFetcher(overrides: Record<string, string> = {}): Fetcher {
  return async (url: string) => {
    const path = new URL(url).pathname.replace(/^\/+/, '');
    if (overrides[path] !== undefined) return new Response(overrides[path], { status: 200 });
    try {
      const bytes = readFileSync(join(publicDir, path));
      return new Response(bytes, { status: 200 });
    } catch {
      return new Response('not found', { status: 404 });
    }
  };
}

export function renderApp(options: MockChainOptions, fetcherOverrides: Record<string, string> = {}) {
  const mocks = createMocks(options);
  const connector = injected({ target: { id: 'mock', name: 'Mock Wallet', provider: mocks.wallet as never }, shimDisconnect: false });
  const view = render(
    <App
      baseUrl="http://site.test/"
      fetcher={fileFetcher(fetcherOverrides)}
      wagmi={{ connectors: [connector], transport: custom({ request: mocks.chain.request }) }}
    />,
  );
  return { ...mocks, ...view };
}
