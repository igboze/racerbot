import { Buffer } from 'buffer';

const RPC_LIST = [
  'https://free.rpc.fastnear.com',
  'https://rpc.mainnet.near.org',
  'https://1rpc.io/near',
  'https://near.lava.build',
  'https://rpc.mainnet.fastnear.com',
];

async function callRpc(accountId, methodName, argsObj) {
  const argsB64 = Buffer.from(JSON.stringify(argsObj)).toString('base64');
  let lastErr;
  for (const rpc of RPC_LIST) {
    try {
      const res = await fetch(rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: '1',
          method: 'query',
          params: {
            request_type: 'call_function',
            finality: 'final',
            account_id: accountId,
            method_name: methodName,
            args_base64: argsB64,
          },
        }),
      }).then((r) => r.json());

      if (res.result?.result) {
        const raw = Buffer.from(res.result.result).toString('utf8');
        try {
          return JSON.parse(raw);
        } catch {
          return raw;
        }
      }
      if (res.error) {
        lastErr = new Error(res.error.data || res.error.message || JSON.stringify(res.error));
        continue;
      }
    } catch (e) {
      lastErr = e;
      continue;
    }
  }
  throw lastErr || new Error('All RPCs failed');
}

async function test() {
  console.log('Testing simulate_swap_simple for ic-1.launch.intear.near...');
  const poolBuf = Buffer.alloc(4);
  poolBuf.writeUInt32LE(170, 0);
  const poolMsg = poolBuf.toString('base64');

  const simBuy = await callRpc('dex.intear.near', 'simulate_swap_simple', {
    dex_id: 'slimedragon.near/xyk',
    message: poolMsg,
    trader: 'racerbot.near',
    asset_in: 'near',
    asset_out: 'nep141:ic-1.launch.intear.near',
    amount: { ExactIn: '1000000000000000000000000' }, // 1 NEAR
    referrer: null,
  });
  console.log('Simulate Buy 1 NEAR -> IC:', simBuy);

  const tokenAmount = simBuy[1];
  const simSell = await callRpc('dex.intear.near', 'simulate_swap_simple', {
    dex_id: 'slimedragon.near/xyk',
    message: poolMsg,
    trader: 'racerbot.near',
    asset_in: 'nep141:ic-1.launch.intear.near',
    asset_out: 'near',
    amount: { ExactIn: tokenAmount },
    referrer: null,
  });
  console.log('Simulate Sell all received IC -> NEAR:', simSell);

  const launchData = await callRpc('launch.intear.near', 'get_launch_data', {
    token_account_id: 'ic-1.launch.intear.near',
  });
  console.log('Launch data:', launchData);
}

test().catch(console.error);
