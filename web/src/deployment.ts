// Runtime deployment configuration. The app has exactly one source of addresses, chain data,
// public RPC URLs and ABIs: `imd-deployment.json` beside index.html, produced from the workflow
// handoff by scripts/write-deployment.mjs. Nothing in src/ hard-codes an address.
import { type Abi, type Address, type Chain, type Hex, isAddress, keccak256, stringToHex } from 'viem';

export interface DeploymentContract {
  name: string;
  address: Address;
  abiHash: string;
  abiPath: string;
}

export interface DeploymentAsset {
  path: string;
  sha256: string;
}

export interface NetworkBlock {
  chainId: number;
  name: string;
  testnet: boolean;
  rpcUrls: string[];
  explorer: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  faucets?: string[];
  uniswapV4: {
    poolManager: Address;
    universalRouter: Address;
    quoter: Address;
    stateView: Address;
    positionManager: Address;
    permit2: Address;
  };
}

export interface WalletAddChain {
  chainId: Hex;
  chainName: string;
  rpcUrls: string[];
  nativeCurrency: { name: string; symbol: string; decimals: number };
  blockExplorerUrls?: string[];
  iconUrls?: string[];
}

export interface DeploymentManifest {
  version: 1;
  launchId: string;
  chainId: number;
  sourceCommit: string;
  attestationHash: string;
  contracts: DeploymentContract[];
  assets: DeploymentAsset[];
  network?: NetworkBlock;
  walletAddChain?: WalletAddChain;
}

export interface LoadedDeployment {
  manifest: DeploymentManifest;
  chain: Chain;
  /** ABI arrays keyed by contract name, exactly as loaded from the export. */
  abis: Record<string, Abi>;
  /** Contract addresses keyed by name. */
  addresses: Record<string, Address>;
  /** Contract names whose loaded ABI hashed to the attested `abiHash`. */
  verified: Record<string, boolean>;
  /** Present only when the chain is vetted by the network (network.json shipped with the handoff). */
  network?: NetworkBlock;
  walletAddChain?: WalletAddChain;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Key-sorted compact JSON, the input of the handoff's `canonicalKeccak(abi)`. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function canonicalKeccak(value: unknown): string {
  return keccak256(stringToHex(canonicalJson(value))).slice(2);
}

function isRelativePath(p: string): boolean {
  return typeof p === 'string' && p.length > 0 && !p.startsWith('/') && !p.includes('..') && !/^[a-z]+:/i.test(p);
}

export function validateManifest(input: unknown): DeploymentManifest {
  if (!input || typeof input !== 'object') throw new Error('imd-deployment.json is not an object');
  const m = input as Record<string, unknown>;
  if (m.version !== 1) throw new Error('imd-deployment.json: unsupported version');
  if (typeof m.launchId !== 'string' || !m.launchId) throw new Error('imd-deployment.json: launchId missing');
  if (typeof m.chainId !== 'number' || !Number.isInteger(m.chainId) || m.chainId <= 0) {
    throw new Error('imd-deployment.json: chainId missing');
  }
  if (typeof m.sourceCommit !== 'string' || !/^[0-9a-f]{40}$/.test(m.sourceCommit)) {
    throw new Error('imd-deployment.json: sourceCommit malformed');
  }
  if (typeof m.attestationHash !== 'string' || !HEX64.test(m.attestationHash)) {
    throw new Error('imd-deployment.json: attestationHash malformed');
  }
  if (!Array.isArray(m.contracts) || m.contracts.length === 0) throw new Error('imd-deployment.json: no contracts');
  for (const c of m.contracts as Record<string, unknown>[]) {
    if (typeof c.name !== 'string' || !isAddress(String(c.address)) || typeof c.abiHash !== 'string' || !HEX64.test(c.abiHash)) {
      throw new Error(`imd-deployment.json: contract entry malformed (${String(c.name)})`);
    }
    if (!isRelativePath(String(c.abiPath))) throw new Error(`imd-deployment.json: abiPath must be relative (${c.name})`);
  }
  if (!Array.isArray(m.assets)) throw new Error('imd-deployment.json: assets missing');
  if (m.network !== undefined) {
    const n = m.network as Record<string, unknown>;
    if (n.chainId !== m.chainId) throw new Error('imd-deployment.json: network.chainId differs from chainId');
    if (!Array.isArray(n.rpcUrls) || n.rpcUrls.length === 0) throw new Error('imd-deployment.json: network.rpcUrls missing');
    const u = n.uniswapV4 as Record<string, unknown> | undefined;
    for (const key of ['poolManager', 'universalRouter', 'quoter', 'stateView', 'positionManager', 'permit2']) {
      if (!u || !isAddress(String(u[key]))) throw new Error(`imd-deployment.json: network.uniswapV4.${key} missing`);
    }
  }
  return input as DeploymentManifest;
}

/** Builds the viem chain from the manifest's network block (or a minimal chain when the network is not vetted). */
export function chainFromManifest(m: DeploymentManifest): Chain {
  const n = m.network;
  const rpcUrls = n?.rpcUrls ?? [];
  return {
    id: m.chainId,
    name: n?.name ?? `Chain ${m.chainId}`,
    nativeCurrency: n?.nativeCurrency ?? { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: rpcUrls } },
    blockExplorers: n?.explorer ? { default: { name: 'Explorer', url: n.explorer } } : undefined,
    testnet: n?.testnet ?? true,
  };
}

export type Fetcher = (url: string) => Promise<Response>;

/**
 * Loads imd-deployment.json and every referenced ABI relative to the page. Each ABI is hashed
 * client-side; a mismatch keeps the contract's transactions disabled instead of failing the page.
 */
export async function loadDeployment(baseUrl: string, fetcher: Fetcher = (u) => fetch(u, { cache: 'no-cache' })): Promise<LoadedDeployment> {
  const manifestUrl = new URL('imd-deployment.json', baseUrl).toString();
  const res = await fetcher(manifestUrl);
  if (!res.ok) throw new Error(`Unable to load imd-deployment.json (HTTP ${res.status})`);
  const manifest = validateManifest(await res.json());
  const abis: Record<string, Abi> = {};
  const addresses: Record<string, Address> = {};
  const verified: Record<string, boolean> = {};
  for (const c of manifest.contracts) {
    const abiRes = await fetcher(new URL(c.abiPath, baseUrl).toString());
    if (!abiRes.ok) throw new Error(`Unable to load ${c.abiPath} (HTTP ${abiRes.status})`);
    const abi = (await abiRes.json()) as unknown;
    if (!Array.isArray(abi)) throw new Error(`${c.abiPath} is not an ABI array`);
    abis[c.name] = abi as Abi;
    addresses[c.name] = c.address;
    verified[c.name] = canonicalKeccak(abi) === c.abiHash;
  }
  return {
    manifest,
    chain: chainFromManifest(manifest),
    abis,
    addresses,
    verified,
    network: manifest.network,
    walletAddChain: manifest.walletAddChain,
  };
}
