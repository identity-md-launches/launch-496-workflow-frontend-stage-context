// Contract and wallet error translation (frontend-ux rule 7). Never shows a raw selector.
import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from 'viem';

const CUSTOM_ERRORS: Record<string, string> = {
  InvalidConfiguration: 'The jackpot refused the request because its configuration is invalid.',
  InvalidAmount: 'Enter an amount greater than zero and within the contract limits.',
  ExpiredDeadline: 'The deadline passed before the transaction was mined. Request a new quote and try again.',
  ReentrantCall: 'Another jackpot action is still running. Try again.',
  UnauthorizedCallback: 'The jackpot rejected an unauthorized call.',
  Slippage: 'The output fell below your minimum. Increase the slippage tolerance or try a smaller amount.',
  PartialFill: 'The pool could not fill the whole input. Try a smaller amount.',
  TokenTransferFailed: 'The token transfer failed. Check the balance and allowance, then try again.',
  InsufficientVRFFee: 'Not enough ETH was sent for the randomness fee. Increase the fee headroom.',
  RefundFailed: 'The ETH refund to your address failed.',
  NothingToClaim: 'There is nothing to claim for this address.',
  TicketNotPending: 'This ticket is no longer pending.',
  TicketNotExpired: 'This ticket has not expired yet.',
  ERC20InsufficientBalance: 'Insufficient token balance for this transfer.',
  ERC20InsufficientAllowance: 'The spender allowance is too small. Approve a larger amount first.',
  ERC20InvalidReceiver: 'Enter a valid recipient address.',
  ERC20InvalidSpender: 'Enter a valid spender address.',
  ERC20InvalidSender: 'Invalid sender.',
};

export function describeError(error: unknown): string {
  if (!error) return 'Unknown error.';
  if (error instanceof BaseError) {
    if (error instanceof UserRejectedRequestError || error.walk((e) => e instanceof UserRejectedRequestError)) {
      return 'Request rejected in the wallet.';
    }
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (reverted) {
      const name = reverted.data?.errorName ?? reverted.reason;
      if (name && CUSTOM_ERRORS[name]) return CUSTOM_ERRORS[name];
      if (reverted.reason) return `Transaction would revert: ${reverted.reason}`;
      if (name) return `Transaction would revert with ${name}.`;
      return 'Transaction would revert. The contract rejected the request.';
    }
    const msg = error.shortMessage || error.message;
    if (/returned no data \("0x"\)/i.test(msg) || /is not a contract|no code/i.test(msg)) {
      return 'The call reached an address with no contract code on this network.';
    }
    if (/insufficient funds/i.test(msg)) return 'Insufficient ETH for value plus gas.';
    if (/chain mismatch|does not match the target chain/i.test(msg)) return 'Wallet is on another network. Switch network and retry.';
    if (/HTTP request failed|fetch failed|Failed to fetch|timeout/i.test(msg)) return 'Unable to reach the RPC endpoint. Check the connection and retry.';
    return msg.replace(/\s+Version: viem@[\d.]+$/, '');
  }
  if (error instanceof Error) {
    if ((error as { code?: number }).code === 4001) return 'Request rejected in the wallet.';
    return error.message;
  }
  return String(error);
}
