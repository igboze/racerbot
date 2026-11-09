/**
 * Test double for NEAR AI Cloud private inference. It behaves like the real
 * service: attestation reports bind a signing key and the caller's nonce,
 * answers are signed with a real secp256k1 key (EIP-191), and the signature
 * covers sha256 of the exact request and response bytes. Each `break` option
 * spoils one link of that chain so tests can prove the check notices.
 */

import { createHash } from 'node:crypto';
import { Wallet } from 'ethers';
import type { TeeDeps, TdxQuoteResult } from '../nearAiTee.js';

export type TeeBreak =
  | 'none'
  | 'no-attestation'      // report has no model_attestations
  | 'wrong-nonce'         // quote's report_data carries another nonce
  | 'wrong-address'       // quote binds a different signing address
  | 'debug-td'            // TDX debug mode on
  | 'bad-tcb'             // TDX status Revoked
  | 'wrong-compose'       // mr_config does not match the app compose
  | 'gpu-fail'            // NVIDIA rejects the GPU evidence
  | 'tampered-response'   // signature covers other response bytes
  | 'other-signer'        // answer signed by a key that was never attested
  | 'gateway-signature'   // signature_kind gateway instead of provider_tee
  | 'no-signature'        // signature endpoint keeps answering 404
  | 'model-down';         // completion answers 503

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

export function fakeNearAiTee(opts: { content: unknown; model?: string; break?: TeeBreak; chatId?: string }) {
  const brk = opts.break ?? 'none';
  const teeWallet = Wallet.createRandom();
  const strangerWallet = Wallet.createRandom();
  const appCompose = JSON.stringify({ docker_compose_file: 'services:\n  vllm:\n    image: vllm@sha256:' + 'ab'.repeat(32) + '\n' });
  const chatId = opts.chatId ?? 'chatcmpl-test-1';
  const calls: { url: string; init?: any }[] = [];
  let lastRequest: Buffer | null = null;
  let lastResponse: Buffer | null = null;

  const fakeQuote = (nonce: string): string => {
    const addr = brk === 'wrong-address' ? strangerWallet.address : teeWallet.address;
    const first = Buffer.concat([Buffer.from(addr.slice(2), 'hex'), Buffer.alloc(12)]);
    const second = Buffer.from(brk === 'wrong-nonce' ? 'ff'.repeat(32) : nonce, 'hex');
    const compose = brk === 'wrong-compose' ? appCompose + ' ' : appCompose;
    const mrConfig = Buffer.concat([Buffer.from([1]), createHash('sha256').update(compose).digest(), Buffer.alloc(15)]);
    const fields = {
      status: brk === 'bad-tcb' ? 'Revoked' : 'UpToDate',
      reportData: Buffer.concat([first, second]).toString('hex'),
      mrConfigId: mrConfig.toString('hex'),
      tdAttributes: brk === 'debug-td' ? '0100000000000000' : '0000001000000000',
    };
    return Buffer.from(JSON.stringify(fields)).toString('hex');
  };

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  const fetchImpl = async (input: any, init?: any): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    const u = new URL(url);

    if (u.pathname === '/v1/attestation/report') {
      const nonce = u.searchParams.get('nonce') || '';
      if (brk === 'no-attestation') return json({ gateway_attestation: {}, model_attestations: [] });
      return json({
        model_attestations: [{
          signing_address: teeWallet.address,
          signing_algo: 'ecdsa',
          intel_quote: fakeQuote(nonce),
          nvidia_payload: JSON.stringify({ nonce, evidence_list: [], arch: 'HOPPER' }),
          info: { tcb_info: JSON.stringify({ app_compose: appCompose }) },
        }],
      });
    }

    if (u.pathname === '/v1/chat/completions') {
      if (brk === 'model-down') return json({ error: 'busy' }, 503);
      lastRequest = Buffer.from(init.body);
      const content = typeof opts.content === 'string' ? opts.content : JSON.stringify(opts.content);
      const raw = Buffer.from(JSON.stringify({ id: chatId, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content } }] }));
      lastResponse = raw;
      return new Response(raw, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (u.pathname.startsWith('/v1/signature/')) {
      if (brk === 'no-signature' || !lastRequest || !lastResponse) return json({ error: 'not found' }, 404);
      const model = u.searchParams.get('model') || '';
      const responseHash = brk === 'tampered-response' ? sha('something else') : sha(lastResponse);
      const text = `${model}:${sha(lastRequest)}:${responseHash}`;
      const signer = brk === 'other-signer' ? strangerWallet : teeWallet;
      return json({
        text,
        signature: await signer.signMessage(text),
        signing_address: signer.address,
        signing_algo: 'ecdsa',
        signature_kind: brk === 'gateway-signature' ? 'gateway' : 'provider_tee',
      });
    }
    return json({ error: 'unexpected ' + url }, 500);
  };

  const deps: TeeDeps = {
    fetch: fetchImpl as typeof fetch,
    verifyTdxQuote: async (quoteHex: string): Promise<TdxQuoteResult> => {
      const f = JSON.parse(Buffer.from(quoteHex, 'hex').toString('utf8'));
      return {
        status: f.status,
        reportData: Buffer.from(f.reportData, 'hex'),
        mrConfigId: Buffer.from(f.mrConfigId, 'hex'),
        tdAttributes: Buffer.from(f.tdAttributes, 'hex'),
      };
    },
    verifyGpu: async (payload: Record<string, unknown>) => ({ pass: brk !== 'gpu-fail', nonce: String(payload.nonce) }),
    now: () => Date.now(),
    sleep: async () => {},
  };

  return {
    deps,
    calls,
    teeAddress: teeWallet.address.toLowerCase(),
    /** The JSON body the planner sent to the model */
    chatBody: () => (lastRequest ? JSON.parse(lastRequest.toString('utf8')) : null),
  };
}
