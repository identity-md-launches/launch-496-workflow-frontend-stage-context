// Completes dist/imd-deployment.json after `vite build`: records the SHA-256 of every exported file
// (except the manifest itself), re-verifies ABI hashes and the manifest shape, and rejects any
// top-level key outside the accepted schema. `--check` only verifies the committed export.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalKeccak, isAddress, isHex64, readJson, sha256Hex } from './lib.mjs';

const check = process.argv.includes('--check');
const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(web, '..', 'dist');
const manifestPath = join(dist, 'imd-deployment.json');
const handoff = readJson(join(web, 'deployment/handoff.json'));
const networkPath = join(web, 'deployment/network.json');
let networkFile;
try {
  networkFile = readJson(networkPath);
} catch {
  networkFile = undefined;
}

const problems = [];
const fail = (msg) => problems.push(msg);

const ALLOWED_KEYS = new Set([
  'version',
  'launchId',
  'chainId',
  'sourceCommit',
  'attestationHash',
  'contracts',
  'assets',
  'network',
  'walletAddChain',
]);
const MAX_ASSETS = 128;
const MAX_FILE = 8 * 1024 * 1024;
const EXPORT_BUDGET = 24 * 1024 * 1024; // well below half of the checker's 64 MiB body budget

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const manifest = readJson(manifestPath);
for (const key of Object.keys(manifest)) {
  if (!ALLOWED_KEYS.has(key)) fail(`unexpected top-level key "${key}"`);
}
if (manifest.version !== 1) fail('version must be 1');
if (manifest.launchId !== handoff.launchId) fail('launchId differs from handoff');
if (manifest.chainId !== handoff.chainId) fail('chainId differs from handoff');
if (manifest.sourceCommit !== handoff.sourceCommit) fail('sourceCommit differs from handoff');
if (manifest.attestationHash !== handoff.attestationHash) fail('attestationHash differs from handoff');

const expected = new Map(handoff.contracts.map((c) => [c.name, c]));
if (!Array.isArray(manifest.contracts) || manifest.contracts.length !== expected.size) {
  fail('contract set differs from handoff');
}
for (const c of manifest.contracts ?? []) {
  const h = expected.get(c.name);
  if (!h) {
    fail(`contract ${c.name} not in handoff`);
    continue;
  }
  if (c.address !== h.address) fail(`${c.name}: address differs from handoff`);
  if (c.abiHash !== h.abiHash) fail(`${c.name}: abiHash differs from handoff`);
  if (typeof c.abiPath !== 'string' || c.abiPath.startsWith('/') || c.abiPath.includes('..') || /^[a-z]+:/i.test(c.abiPath)) {
    fail(`${c.name}: abiPath must be relative to dist/`);
    continue;
  }
  let abi;
  try {
    abi = readJson(join(dist, c.abiPath));
  } catch {
    fail(`${c.name}: ABI file ${c.abiPath} missing from dist/`);
    continue;
  }
  if (!Array.isArray(abi)) fail(`${c.name}: ABI is not a JSON array`);
  else if (canonicalKeccak(abi) !== c.abiHash) fail(`${c.name}: ABI bytes in dist/ do not hash to abiHash`);
}

if (networkFile?.network) {
  if (JSON.stringify(manifest.network) !== JSON.stringify(networkFile.network)) fail('network block differs from network.json');
} else if ('network' in manifest) fail('network present without network.json');
if (networkFile?.walletAddChain) {
  if (JSON.stringify(manifest.walletAddChain) !== JSON.stringify(networkFile.walletAddChain)) {
    fail('walletAddChain block differs from network.json');
  }
} else if ('walletAddChain' in manifest) fail('walletAddChain present without network.json');

// Extra-key guard: no address outside the handoff/network block, no URL outside network.
const allowedAddresses = new Set([
  ...handoff.contracts.map((c) => c.address.toLowerCase()),
  ...Object.values(networkFile?.network?.uniswapV4 ?? {}).map((a) => String(a).toLowerCase()),
]);
const scan = (value, path) => {
  if (typeof value === 'string') {
    if (isAddress(value) && !allowedAddresses.has(value.toLowerCase()) && !path.startsWith('network.')) {
      fail(`address ${value} at ${path} is outside the handoff`);
    }
    if (/^https?:\/\//.test(value) && !path.startsWith('network.') && !path.startsWith('walletAddChain.')) {
      fail(`URL at ${path} outside the network block`);
    }
  } else if (Array.isArray(value)) value.forEach((v, i) => scan(v, `${path}[${i}]`));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) scan(v, path ? `${path}.${k}` : k);
  }
};
scan(manifest, '');

// Asset inventory: every exported file except the manifest.
const files = walk(dist)
  .filter((f) => f !== manifestPath)
  .map((f) => relative(dist, f).split(sep).join('/'))
  .sort();
const assets = [];
let total = 0;
for (const path of files) {
  const bytes = readFileSync(join(dist, path));
  if (bytes.length > MAX_FILE) fail(`${path} exceeds 8 MiB`);
  total += bytes.length;
  assets.push({ path, sha256: sha256Hex(bytes) });
}
if (assets.length > MAX_ASSETS) fail(`${assets.length} assets exceed the limit of ${MAX_ASSETS}`);
if (total > EXPORT_BUDGET) fail(`export is ${total} bytes, above the ${EXPORT_BUDGET}-byte budget`);
if (!assets.some((a) => a.path === 'index.html')) fail('index.html missing from export');
for (const c of manifest.contracts ?? []) {
  if (!assets.some((a) => a.path === c.abiPath)) fail(`${c.abiPath} missing from the asset inventory`);
}

if (check) {
  const declared = JSON.stringify(manifest.assets ?? []);
  if (declared !== JSON.stringify(assets)) fail('declared assets differ from the files in dist/');
  for (const a of manifest.assets ?? []) if (!isHex64(a.sha256)) fail(`${a.path}: sha256 not lowercase hex`);
} else {
  manifest.assets = assets;
  const ordered = {};
  for (const key of ALLOWED_KEYS) if (key in manifest) ordered[key] = manifest[key];
  writeFileSync(manifestPath, `${JSON.stringify(ordered, null, 2)}\n`);
}

if (problems.length) {
  for (const p of problems) console.error(`finalize-manifest: ${p}`);
  process.exit(1);
}
console.log(
  `finalize-manifest: ${check ? 'verified' : 'wrote'} ${assets.length} asset hash(es), ${total} bytes exported`,
);
