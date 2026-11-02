import { escapeHtml } from './buyAlerts.js';

/**
 * Telegram text for AI Swarm plans. One place, so every screen says the same
 * true things: who planned it, what it will trade, and that it trades from the
 * user's own RacerBot wallet. No enclave or attestation claims: none is verified.
 */

interface PlanLike {
  action?: 'buy' | 'sell';
  strategy?: string;
  strategyTitle?: string;
  tokenSymbol?: string;
  tokenAddress?: string;
  totalNear?: number;
  sellPct?: number;
  droneCount?: number;
  tranches?: any[];
  exitTrigger?: { targetDisplay?: string; targetValue?: number } | null;
  exit_trigger?: { targetDisplay?: string; targetValue?: number } | null;
  planner?: { label?: string } | null;
  stealthMode?: boolean;
  analysis?: string;
  reasoning?: string;
}

/** Planner line for old plans too: anything without an honest planner field is unlabelled. */
export function plannerLabel(plan: PlanLike): string {
  return plan.planner?.label || 'Unknown planner (created before this update)';
}

function trancheLine(t: any, i: number, action: 'buy' | 'sell'): string {
  const delay = t.delaySec !== undefined ? t.delaySec : (t.delayMs ? Math.round(t.delayMs / 1000) : 0);
  const size = action === 'sell'
    ? `${Number(t.sellPct || 0).toFixed(1)}% of position`
    : `${Number(t.amountNear || 0).toFixed(2)} NEAR`;
  return `• Tranche ${i + 1}: <b>${size}</b> (+${delay}s)`;
}

export function swarmPlanText(plan: PlanLike, heading: string, extra?: string): string {
  const action = plan.action === 'sell' ? 'sell' : 'buy';
  const tranches = plan.tranches || [];
  const count = plan.droneCount || tranches.length;
  const list = tranches.slice(0, 5).map((t, i) => trancheLine(t, i, action)).join('\n')
    + (tranches.length > 5 ? `\n• …and ${tranches.length - 5} more` : '');
  const trig = plan.exitTrigger || plan.exit_trigger;
  const size = action === 'sell'
    ? `Sell: <b>${Number(plan.sellPct || 100)}% of your position</b> in ${count} tranches`
    : `Buy: <b>${Number(plan.totalNear || 0).toFixed(2)} NEAR</b> in ${count} tranches`;
  const route = plan.stealthMode
    ? 'Confidential executors (your wallet never appears in the trade)'
    : 'Your RacerBot wallet';
  const lines = [
    `🤖 <b>${escapeHtml(heading)}</b>`,
    '━━━━━━━━━━━━━━━━━━━━',
    `Strategy: <b>${escapeHtml(plan.strategyTitle || String(plan.strategy || 'Swarm'))}</b>`,
    `Token: <b>${escapeHtml(plan.tokenSymbol || 'TOKEN')}</b> (<code>${escapeHtml(plan.tokenAddress || '')}</code>)`,
    size,
    `Trades from: ${route}`,
    `🧠 Planned by: ${escapeHtml(plannerLabel(plan))}`,
  ];
  if (trig) lines.push(`🎯 Exit trigger: <b>${escapeHtml(String(trig.targetDisplay || trig.targetValue))}</b>`);
  lines.push('', `<b>Tranches:</b>`, list);
  const why = plan.analysis || plan.reasoning;
  if (why) lines.push('', `<i>${escapeHtml(why)}</i>`);
  if (extra) lines.push('', extra);
  return lines.join('\n');
}

export const SWARM_INTRO =
  `🤖 <b>Racer AI Swarm</b>\n` +
  `━━━━━━━━━━━━━━━━━━━━\n` +
  `Describe a trade and an AI planner (NEAR AI Cloud) splits it into staggered tranches with randomized sizes and timing. ` +
  `You review the plan before anything trades.\n\n` +
  `Trades run from your RacerBot wallet.\n\n` +
  `Select a strategy preset or enter a custom prompt:`;
