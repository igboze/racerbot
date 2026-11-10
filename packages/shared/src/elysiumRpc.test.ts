import { describe, it, expect, vi, afterEach } from 'vitest';
import { ethers } from 'ethers';
import { FailoverJsonRpcProvider, getElysiumMainnetRpcUrls } from './evm.js';

const network = new ethers.Network('elysium', 99901);
const make = () => new FailoverJsonRpcProvider(['https://a.example', 'https://b.example'], network, { staticNetwork: network, batchMaxCount: 1 });
const backends = (p: FailoverJsonRpcProvider) => (p as any).backends as ethers.JsonRpcProvider[];
const ok = (id: number, result: unknown) => [{ id, result }] as any;

afterEach(() => {
  delete process.env.ELYSIUM_MAINNET_RPC_URL;
  vi.restoreAllMocks();
});

describe('Elysium RPC failover', () => {
  it('tries the configured RPC first, then Kinetiq and Kleos', () => {
    process.env.ELYSIUM_MAINNET_RPC_URL = 'https://mine.example';
    expect(getElysiumMainnetRpcUrls()).toEqual(['https://mine.example', 'https://rpc.elysium.kinetiq.xyz', 'https://rpc.thekleos.xyz/']);
    delete process.env.ELYSIUM_MAINNET_RPC_URL;
    expect(getElysiumMainnetRpcUrls()).toEqual(['https://rpc.elysium.kinetiq.xyz', 'https://rpc.thekleos.xyz/']);
  });

  it('moves to the next RPC when one cannot answer, and keeps using it', async () => {
    const p = make();
    const [a, b] = backends(p);
    const sendA = vi.spyOn(a, '_send').mockRejectedValue(new Error('fetch failed'));
    const sendB = vi.spyOn(b, '_send').mockImplementation(async (payload: any) => ok(payload.id, '0x10'));
    expect(await p.send('eth_blockNumber', [])).toBe('0x10');
    expect(await p.send('eth_blockNumber', [])).toBe('0x10');
    expect(sendA).toHaveBeenCalledTimes(1); // the second call went straight to the RPC that answered
    expect(sendB).toHaveBeenCalledTimes(2);
  });

  it('treats a rate-limit answer as busy, but returns a real revert as it is', async () => {
    const p = make();
    const [a, b] = backends(p);
    vi.spyOn(a, '_send').mockImplementation(async (payload: any) => [{ id: payload.id, error: { code: 429, message: 'Too Many Requests' } }] as any);
    vi.spyOn(b, '_send').mockImplementation(async (payload: any) => [{ id: payload.id, error: { code: 3, message: 'execution reverted', data: '0x8698bf37' } }] as any);
    await expect(p.send('eth_call', [{ to: ethers.ZeroAddress, data: '0x' }, 'latest'])).rejects.toMatchObject({ info: { error: { message: 'execution reverted' } } });
  });

  it('sends log searches to the first RPC first, and moves on when a node caps the block range', async () => {
    const p = make();
    const [a, b] = backends(p);
    // b becomes the preferred RPC for ordinary calls
    vi.spyOn(a, '_send').mockImplementationOnce(async () => { throw new Error('fetch failed'); });
    vi.spyOn(b, '_send').mockImplementation(async (payload: any) => [{ id: payload.id, result: '0x1' }] as any);
    await p.send('eth_blockNumber', []);
    // A log search still starts at a; a's range cap sends it to b
    vi.spyOn(a, '_send').mockImplementation(async (payload: any) => [{ id: payload.id, error: { code: -32602, message: 'Log range exceeds 10,000 blocks; ask for it in pieces' } }] as any);
    vi.spyOn(b, '_send').mockImplementation(async (payload: any) => [{ id: payload.id, result: [] }] as any);
    expect(await p.send('eth_getLogs', [{ fromBlock: '0x0', toBlock: '0x30000' }])).toEqual([]);
    expect(a._send).toHaveBeenCalled();
  });
});

