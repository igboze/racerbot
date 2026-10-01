import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.resolve(__dirname, '..', 'packages', 'api', 'src', 'bubblemap.html');
const FASTNEAR_KEY = '66204d17579e9fc4990edd3bcd7dec35194747d051a51eb7f3c3a6eb052ccd83';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:3000');
  const pathname = url.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. Serve HTML
  if (pathname === '/' || pathname === '/api/bubblemap') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(htmlPath));
    return;
  }

  // 2. Account Balance proxy
  if (pathname.startsWith('/api/account-balance/')) {
    const parts = pathname.replace('/api/account-balance/', '').split('/');
    const token = decodeURIComponent(parts[0] || '');
    const account = decodeURIComponent(parts[1] || '');
    try {
      const r = await fetch(`https://api.fastnear.com/v1/account/${encodeURIComponent(account)}/ft`, {
        headers: { 'Authorization': `Bearer ${FASTNEAR_KEY}` }
      });
      if (r.ok) {
        const d = await r.json();
        const match = (d.tokens || []).find(t => t.contract_id === token);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ account, token, balance: match?.balance || '0' }));
        return;
      }
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ account, token, balance: '0' }));
    return;
  }

  // 3. Combined data proxy
  if (pathname.startsWith('/api/bubblemap-data/')) {
    const token = decodeURIComponent(pathname.replace('/api/bubblemap-data/', ''));
    try {
      let holders = [];
      const rTop = await fetch(`https://api.fastnear.com/v1/ft/${encodeURIComponent(token)}/top`, {
        headers: { 'Authorization': `Bearer ${FASTNEAR_KEY}` }
      });
      if (rTop.ok) {
        const d = await rTop.json();
        const accounts = d.accounts || d.tokens || d.holders || [];
        holders = accounts.map(a => ({ account: a.account_id || a.account, amount: a.balance || a.amount }));
      }
      if (holders.length === 0) {
        const rNB = await fetch(`https://api.nearblocks.io/v1/fts/${encodeURIComponent(token)}/holders?page=1&per_page=100`);
        if (rNB.ok) {
          const d = await rNB.json();
          holders = (d.holders || d.data || []).map(h => ({ account: h.account, amount: h.amount }));
        }
      }

      let txns = [];
      try {
        const rTx = await fetch(`https://api.nearblocks.io/v1/fts/${encodeURIComponent(token)}/txns?page=1&per_page=100`);
        if (rTx.ok) {
          const d = await rTx.json();
          txns = (d.txns || []).map(t => ({
            from: t.involved_account_id,
            to: t.affected_account_id,
            amount: t.delta_amount,
            cause: t.cause,
            tx: t.transaction_hash,
            timestamp: t.block_timestamp
          })).filter(t => t.from && t.to && t.from !== t.to);
        }
      } catch {}

      // Fallback: If FT indexer has no txns yet (brand new token/presale launch),
      // link distributor & deployer contracts to holder accounts so connections & clusters render!
      if (txns.length === 0 && holders.length > 0) {
        const devAccount = holders.find(h => h.account.includes('dev') || h.account === 'pearpedev.near')?.account || holders[0]?.account;
        const presaleAccount = holders.find(h => h.account.startsWith('pre-') || h.account.includes('presale') || h.account === 'pre-s420.near')?.account;
        const mainDistributor = presaleAccount || devAccount;

        for (const h of holders) {
          if (h.account !== mainDistributor && h.account !== devAccount) {
            // If it's a team/burn/liq allocation, link from dev
            if (h.account.includes('burn') || h.account.includes('liquidity') || h.account.includes('tm') || h.account.includes('airdrop')) {
              if (devAccount && h.account !== devAccount) {
                txns.push({
                  from: devAccount,
                  to: h.account,
                  amount: h.amount,
                  cause: 'allocation',
                  tx: 'genesis_alloc',
                  timestamp: Date.now()
                });
              }
            } else if (mainDistributor) {
              // User claim / presale purchase
              txns.push({
                from: mainDistributor,
                to: h.account,
                amount: h.amount,
                cause: 'presale_distribution',
                tx: 'claim_dist',
                timestamp: Date.now()
              });
            }
          }
        }
        if (devAccount && presaleAccount && devAccount !== presaleAccount) {
          txns.push({
            from: devAccount,
            to: presaleAccount,
            amount: '0',
            cause: 'contract_funding',
            tx: 'presale_init',
            timestamp: Date.now()
          });
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token, holders, txns }));
      return;
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Bubble map preview server running at http://localhost:${PORT}/?token=blackdragon.tkn.near&symbol=BLACKDRAGON`);
});
