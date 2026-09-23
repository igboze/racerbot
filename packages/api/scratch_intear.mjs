async function callRaw(accountId, methodName, argsObj = {}) {
  const rpc = 'https://rpc.mainnet.fastnear.com';
  const argsBase64 = Buffer.from(JSON.stringify(argsObj)).toString('base64');
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
          args_base64: argsBase64
        }
      })
    }).then(r => r.json());
    return res;
  } catch (err) {
    return { fetchError: err.message };
  }
}

async function main() {
  console.log('Fetching on-chain metadata for ic-1.launch.intear.near...');
  const meta = await callRaw('ic-1.launch.intear.near', 'ft_metadata', {});
  if (meta.result?.result) {
    console.log('ft_metadata:', Buffer.from(meta.result.result).toString());
  }

  // Let's test on launch.intear.near
  const tests = [
    { target: 'launch.intear.near', method: 'get_token', args: { token_id: 'ic-1.launch.intear.near' } },
    { target: 'launch.intear.near', method: 'get_token', args: { account_id: 'ic-1.launch.intear.near' } },
    { target: 'launch.intear.near', method: 'get_tokens', args: { from_index: 0, limit: 5 } },
    { target: 'launch.intear.near', method: 'get_launch', args: { token_id: 'ic-1.launch.intear.near' } },
    { target: 'launch.intear.near', method: 'get_config', args: {} },
    { target: 'ic-1.launch.intear.near', method: 'get_token_info', args: {} },
    { target: 'ic-1.launch.intear.near', method: 'get_stats', args: {} },
    { target: 'ic-1.launch.intear.near', method: 'get_info', args: {} },
  ];

  for (const t of tests) {
    const res = await callRaw(t.target, t.method, t.args);
    if (res.result?.result) {
      console.log(`[SUCCESS] ${t.target}::${t.method}:`, Buffer.from(res.result.result).toString());
    } else {
      console.log(`[ERROR] ${t.target}::${t.method}:`, res.error?.data || res.error?.message || JSON.stringify(res));
    }
  }
}

main().catch(console.error);
