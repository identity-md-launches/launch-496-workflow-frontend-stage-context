// Build-time application constants. Addresses, chain id, RPC URLs and ABIs are NOT here: they are
// read at runtime from imd-deployment.json (see deployment.ts). This file holds only behaviour
// settings and the launch-pool parameters generated from the attested handoff.
export { LAUNCH_POOL } from './generated/pool';

/** Default slippage tolerance applied to quoted outputs, in basis points. */
export const DEFAULT_SLIPPAGE_BPS = 100;
/** Seconds added to the current time for swap deadlines. */
export const DEADLINE_SECONDS = 20 * 60;
/** Polling interval for live contract reads, in milliseconds (Sepolia blocks are ~12 s). */
export const POLL_INTERVAL_MS = 12_000;
/** Headroom applied to the on-chain VRF fee quote when funding a ticket (basis points). */
export const VRF_FEE_HEADROOM_BPS = 2_000;
/** Permit2 allowance lifetime granted to the universal router, in seconds. */
export const PERMIT2_EXPIRATION_SECONDS = 30 * 24 * 60 * 60;
/** Optional WalletConnect project id. Empty: browser wallets only (see README). */
export const WALLETCONNECT_PROJECT_ID = '';

/** Universal router / v4 router constants (Uniswap universal-router `Commands` and v4-periphery `Actions`). */
export const UNIVERSAL_ROUTER = {
  V4_SWAP: 0x10,
  SWAP_EXACT_IN_SINGLE: 0x06,
  SETTLE_ALL: 0x0c,
  TAKE_ALL: 0x0f,
} as const;

/** Game site this launch belongs to (from the approved workflow). */
export const GAME_URL = 'https://pepes-armed.site.identitymd.eth.limo';
