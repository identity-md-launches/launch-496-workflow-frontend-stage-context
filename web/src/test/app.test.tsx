// Interaction tests against the real App, a mocked chain and a mocked EIP-1193 wallet.
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeFunctionData, parseEther } from 'viem';
import { ADDR, PLAYER, jackpotAbi, launchTokenAbi } from './mockChain';
import { renderApp } from './harness';

afterEach(() => cleanup());

const connect = async () => {
  const button = await screen.findByRole('button', { name: /connect wallet/i });
  fireEvent.click(button);
  await screen.findByRole('button', { name: /disconnect/i });
};

describe('PepeJackpot site', () => {
  it('loads the deployment, shows live reads and disables actions until a wallet connects', async () => {
    const { chain } = renderApp({ scenario: 'sepolia' });
    await screen.findByRole('heading', { name: 'PepeJackpot', level: 1 });
    // Constants read from the contract render even while jackpot dependencies are missing.
    await screen.findByText('10,000 ICE in');
    await screen.findByText('1,000,000,000', { exact: false });
    // Sepolia scenario: dependencies have no code, the pot is unavailable and the reason is shown.
    await screen.findAllByText(/have no contract code on Sepolia/);
    expect(screen.getByText('Unavailable', { selector: '.value' })).toBeInTheDocument();
    for (const name of [/swap ice for imd/i, /trade eth for imd/i, /sign permit and fill tank/i, /seed/i, /transfer pjack/i, /swap eth for pjack/i]) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    expect(screen.getAllByText('Connect a wallet to use this action.').length).toBeGreaterThanOrEqual(6);
    expect(chain.calls.some((c) => c.method === 'eth_getCode')).toBe(true);
    // Pool state read through StateView from the network block.
    await screen.findByText(/Tick 177284/);
  });

  it('offers a single switch control on the wrong network and adds the chain after 4902', async () => {
    const { wallet } = renderApp({ scenario: 'sepolia', walletChainId: 1, walletKnowsChain: false });
    await screen.findByRole('heading', { name: 'PepeJackpot', level: 1 });
    await connect();
    const switchButton = await screen.findByRole('button', { name: /switch to sepolia/i });
    expect(screen.getByText('Wrong network')).toBeInTheDocument();
    expect(screen.getAllByText('Switch the wallet to Sepolia first.').length).toBeGreaterThan(0);
    fireEvent.click(switchButton);
    await waitFor(() => expect(wallet.addedChains).toHaveLength(1));
    const added = wallet.addedChains[0] as { chainId: string; chainName: string; rpcUrls: string[] };
    expect(added.chainId).toBe('0xaa36a7');
    expect(added.chainName).toBe('Sepolia');
    expect(added.rpcUrls).toContain('https://ethereum-sepolia-rpc.publicnode.com');
    expect(wallet.switchRequests).toEqual(['0xaa36a7', '0xaa36a7']);
    await waitFor(() => expect(screen.queryByRole('button', { name: /switch to sepolia/i })).not.toBeInTheDocument());
    await screen.findByText('Sepolia', { selector: '.badge' });
  });

  it('shows tickets, results and claims winnings', async () => {
    const { chain } = renderApp({ scenario: 'dependencies-live' });
    chain.issueTicket(PLAYER, 100n * 10n ** 18n, 2, 77, 90_000n * 10n ** 18n, 3_600);
    chain.issueTicket(PLAYER, 100n * 10n ** 18n, 2, 41, 0n, 7_200);
    chain.issueTicket(PLAYER, 100n * 10n ** 18n, 1, 0, 0n, 100_000);
    chain.issueTicket(PLAYER, 100n * 10n ** 18n, 1, 0, 0n, 60);
    chain.claimable.set(PLAYER, 500n * 10n ** 18n);
    chain.totalClaimable = 500n * 10n ** 18n;
    await screen.findByRole('heading', { name: 'PepeJackpot', level: 1 });
    await connect();
    const list = await screen.findByRole('list', { name: 'Tickets' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(within(list).getByText('Jackpot')).toBeInTheDocument();
    expect(within(list).getByText('No prize')).toBeInTheDocument();
    expect(within(list).getByText('Expired')).toBeInTheDocument();
    expect(within(list).getByText('Pending')).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: /mark ticket expired/i })).toBeEnabled();
    const claim = screen.getByRole('button', { name: /claim winnings/i });
    expect(claim).toBeEnabled();
    fireEvent.click(claim);
    await screen.findByText('Confirmed.');
    expect(chain.sentTransactions).toHaveLength(1);
    expect(decodeFunctionData({ abi: jackpotAbi, data: chain.sentTransactions[0].data }).functionName).toBe('claim');
    await waitFor(() => expect(screen.getByRole('button', { name: /claim winnings/i })).toBeDisabled());
  });

  it('runs the fridge swap approval then swap with quote, slippage and VRF fee', async () => {
    const { chain } = renderApp({ scenario: 'dependencies-live' });
    await screen.findByRole('heading', { name: 'PepeJackpot', level: 1 });
    await connect();
    await screen.findByText('250,000', { exact: false });
    fireEvent.change(screen.getByLabelText('Amount to sell'), { target: { value: '20000' } });
    await screen.findByText('Quoted output');
    const approve = await screen.findByRole('button', { name: /approve 20,000 ICE/i });
    fireEvent.click(approve);
    await screen.findByText('Confirmed.');
    const swap = await screen.findByRole('button', { name: /^swap ice for imd$/i });
    await waitFor(() => expect(swap).toBeEnabled());
    fireEvent.click(swap);
    await waitFor(() => expect(chain.sentTransactions).toHaveLength(2));
    const decoded = decodeFunctionData({ abi: jackpotAbi, data: chain.sentTransactions[1].data });
    expect(decoded.functionName).toBe('fridgeSwap');
    const [iceToImd, amountIn, minOut] = decoded.args as [boolean, bigint, bigint, bigint];
    expect(iceToImd).toBe(true);
    expect(amountIn).toBe(parseEther('20000'));
    expect(minOut).toBe(((parseEther('20000') * 99n) / 100n / 100_000n) * 99n / 100n);
    expect(chain.sentTransactions[1].value).toBe((chain.vrfFee * 12_000n) / 10_000n);
    await waitFor(() => expect(screen.getAllByText('Confirmed.').length).toBeGreaterThan(0));
    await screen.findByRole('list', { name: 'Tickets' });
  });

  it('golden throne sends ethIn plus the randomness budget', async () => {
    const { chain } = renderApp({ scenario: 'dependencies-live' });
    await screen.findByRole('heading', { name: 'PepeJackpot', level: 1 });
    await connect();
    fireEvent.change(screen.getByLabelText('Amount to trade'), { target: { value: '0.01' } });
    const button = screen.getByRole('button', { name: /trade eth for imd/i });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(chain.sentTransactions).toHaveLength(1));
    const decoded = decodeFunctionData({ abi: jackpotAbi, data: chain.sentTransactions[0].data });
    expect(decoded.functionName).toBe('goldenThrone');
    expect((decoded.args as bigint[])[0]).toBe(parseEther('0.01'));
    expect(chain.sentTransactions[0].value).toBe(parseEther('0.01') + (chain.vrfFee * 12_000n) / 10_000n);
  });

  it('fills the tank with a signed permit and seeds after approval', async () => {
    const { chain } = renderApp({ scenario: 'dependencies-live' });
    await screen.findByRole('heading', { name: 'PepeJackpot', level: 1 });
    await connect();
    fireEvent.change(screen.getByLabelText('Pees'), { target: { value: '2' } });
    const fill = screen.getByRole('button', { name: /sign permit and fill tank/i });
    await waitFor(() => expect(fill).toBeEnabled());
    fireEvent.click(fill);
    await waitFor(() => expect(chain.sentTransactions).toHaveLength(1));
    const decoded = decodeFunctionData({ abi: jackpotAbi, data: chain.sentTransactions[0].data });
    expect(decoded.functionName).toBe('fillTank');
    expect((decoded.args as [bigint, { deadline: bigint; v: number }])[0]).toBe(2n);
    expect((decoded.args as [bigint, { deadline: bigint; v: number }])[1].v).toBe(27);

    fireEvent.change(screen.getByLabelText('ICE to add'), { target: { value: '100' } });
    const approve = await screen.findByRole('button', { name: /approve 100 ICE/i });
    fireEvent.click(approve);
    await waitFor(() => expect(chain.sentTransactions).toHaveLength(2));
    const seed = await screen.findByRole('button', { name: /^seed 100 ICE$/i });
    await waitFor(() => expect(seed).toBeEnabled());
    fireEvent.click(seed);
    await waitFor(() => expect(chain.sentTransactions).toHaveLength(3));
    expect(decodeFunctionData({ abi: jackpotAbi, data: chain.sentTransactions[2].data }).functionName).toBe('seed');
  });

  it('transfers PJACK and reports a wallet rejection without locking the button', async () => {
    const { chain } = renderApp({ scenario: 'sepolia', rejectSend: true });
    await screen.findByRole('heading', { name: 'PepeJackpot', level: 1 });
    await connect();
    fireEvent.change(screen.getByLabelText('Recipient address'), { target: { value: '0x2222222222222222222222222222222222222222' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '5' } });
    const transfer = screen.getByRole('button', { name: /transfer pjack/i });
    await waitFor(() => expect(transfer).toBeEnabled());
    fireEvent.click(transfer);
    await screen.findByText('Request rejected in the wallet.');
    expect(chain.sentTransactions).toHaveLength(0);
    await waitFor(() => expect(screen.getByRole('button', { name: /transfer pjack/i })).toBeEnabled());
    // Over-balance input shows the reason inline.
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '5000' } });
    await screen.findByText(/Balance is 1,000 PJACK/);
    expect(screen.getByRole('button', { name: /transfer pjack/i })).toBeDisabled();
  });

  it('swaps ETH for PJACK through the universal router and sells with the Permit2 steps', async () => {
    const { chain } = renderApp({ scenario: 'sepolia' });
    await screen.findByRole('heading', { name: 'PepeJackpot', level: 1 });
    await connect();
    fireEvent.change(screen.getByLabelText('Amount to swap'), { target: { value: '0.001' } });
    await screen.findByText(/50 PJACK|50 PJACK/);
    const swap = screen.getByRole('button', { name: /^swap eth for pjack$/i });
    await waitFor(() => expect(swap).toBeEnabled());
    fireEvent.click(swap);
    await waitFor(() => expect(chain.sentTransactions).toHaveLength(1));
    expect(chain.sentTransactions[0].to).toBe(ADDR.router);
    expect(chain.sentTransactions[0].value).toBe(parseEther('0.001'));
    await screen.findByText('Confirmed.');

    fireEvent.click(screen.getByLabelText('PJACK → ETH'));
    fireEvent.change(screen.getByLabelText('Amount to swap'), { target: { value: '10' } });
    const step1 = await screen.findByRole('button', { name: /step 1 of 3/i });
    fireEvent.click(step1);
    await waitFor(() => expect(chain.sentTransactions).toHaveLength(2));
    expect(decodeFunctionData({ abi: launchTokenAbi, data: chain.sentTransactions[1].data }).functionName).toBe('approve');
    const step2 = await screen.findByRole('button', { name: /step 2 of 3/i });
    fireEvent.click(step2);
    await waitFor(() => expect(chain.sentTransactions).toHaveLength(3));
    expect(chain.sentTransactions[2].to).toBe(ADDR.permit2);
    const step3 = await screen.findByRole('button', { name: /step 3 of 3/i });
    await waitFor(() => expect(step3).toBeEnabled());
    fireEvent.click(step3);
    await waitFor(() => expect(chain.sentTransactions).toHaveLength(4));
    expect(chain.sentTransactions[3].to).toBe(ADDR.router);
    expect(chain.sentTransactions[3].value).toBe(0n);
  });

  it('keeps transactions disabled when an ABI fails verification', async () => {
    renderApp({ scenario: 'sepolia' }, { 'abi/LaunchToken.json': '[]' });
    await screen.findByText(/ABI verification failed/);
    await connect();
    fireEvent.change(screen.getByLabelText('Amount to swap'), { target: { value: '0.001' } });
    expect(screen.getByRole('button', { name: /swap eth for pjack/i })).toBeDisabled();
    expect(screen.getAllByText(/LaunchToken ABI does not match/).length).toBeGreaterThan(0);
  });

  it('shows a clear error when the deployment configuration is missing', async () => {
    renderApp({ scenario: 'sepolia' }, { 'imd-deployment.json': '' });
    await screen.findByText(/Unable to load the deployment configuration/);
  });
});
