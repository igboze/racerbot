import { Buffer } from 'buffer';

const RPC_LIST = [
  'https://free.rpc.fastnear.com',
  'https://rpc.mainnet.near.org',
  'https://1rpc.io/near',
  'https://near.lava.build',
];

export function parseIntearPool(rawBytes) {
  if (!rawBytes || rawBytes.length < 5 || rawBytes[0] !== 1) return null;
  let offset = 1;

  // Asset 1
  const asset1Type = rawBytes.readUInt8(offset);
  offset += 1;
  let asset1 = 'near';
  if (asset1Type === 1) {
    const len = rawBytes.readUInt32LE(offset);
    offset += 4;
    asset1 = rawBytes.toString('utf8', offset, offset + len);
    offset += len;
  }
  // Reserve 1 (u128)
  const r1Buf = rawBytes.subarray(offset, offset + 16);
  offset += 16;
  let reserve1 = 0n;
  for (let i = 0; i < 16; i++) {
    reserve1 |= BigInt(r1Buf[i]) << BigInt(8 * i);
  }

  // Asset 2
  const asset2Type = rawBytes.readUInt8(offset);
  offset += 1;
  let asset2 = 'near';
  if (asset2Type === 1) {
    const len = rawBytes.readUInt32LE(offset);
    offset += 4;
    asset2 = rawBytes.toString('utf8', offset, offset + len);
    offset += len;
  }
  // Reserve 2 (u128)
  const r2Buf = rawBytes.subarray(offset, offset + 16);
  offset += 16;
  let reserve2 = 0n;
  for (let i = 0; i < 16; i++) {
    reserve2 |= BigInt(r2Buf[i]) << BigInt(8 * i);
  }

  return { asset1, reserve1: reserve1.toString(), asset2, reserve2: reserve2.toString() };
}

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

async function main() {
  console.log('Testing pool 170 directly...');
  const buf170 = Buffer.alloc(4);
  buf170.writeUInt32LE(170, 0);

  const res170 = await callRpc('dex.intear.near', 'dex_view', {
    dex_id: 'slimedragon.near/xyk',
    method: 'get_pool',
    args: buf170.toString('base64'),
  });

  const rawBytes = Buffer.from(res170, 'base64');
  const pool = parseIntearPool(rawBytes);
  console.log('Parsed Pool 170:', pool);

  const reserveNear = BigInt(pool.reserve1);
  const reserveToken = BigInt(pool.reserve2);
  const nearDecimals = 24;
  const tokenDecimals = 24; // IC decimals

  const nearAmt = Number(reserveNear) / 1e24;
  const tokenAmt = Number(reserveToken) / 1e24;
  const price = nearAmt / tokenAmt;
  const liquidity = nearAmt * 2;
  console.log({
    nearAmt: nearAmt.toFixed(4) + ' NEAR',
    tokenAmt: tokenAmt.toFixed(2) + ' IC',
    price: price.toFixed(10) + ' NEAR',
    liquidity: liquidity.toFixed(4) + ' NEAR',
  });
}

main().catch(console.error);
