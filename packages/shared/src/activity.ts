export type ActivityEventType = 'trade.buy' | 'trade.sell' | 'snipe.executed';

export interface ActivityEventParams {
  eventType: ActivityEventType;
  actor: string;
  idempotencyKey: string;
  payload?: Record<string, any>;
  occurredAt?: string;
}

/**
 * Publishes an on-chain activity event to NEAR Builders Activity (https://activity.nearbuilders.org).
 * Non-blocking, completely fire-and-forget, with fallback safety so failures never impede bot execution.
 */
export async function publishActivityEvent(
  params: ActivityEventParams
): Promise<{ eventId?: string; success: boolean }> {
  const apiKey = (process.env.NEAR_ACTIVITY_API_KEY || process.env.ACTIVITY_API_KEY || '').trim();
  if (!apiKey) {
    return { success: false };
  }

  const actor = params.actor?.trim();
  if (!actor || !actor.includes('.')) {
    // Activity requires a valid NEAR account ID
    return { success: false };
  }

  const baseUrl = (process.env.ACTIVITY_API_BASE_URL || 'https://activity.nearbuilders.org/api').replace(/\/+$/, '');
  const url = `${baseUrl}/v1/events`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        eventType: params.eventType,
        actor,
        idempotencyKey: params.idempotencyKey,
        payload: params.payload ?? {},
        ...(params.occurredAt ? { occurredAt: params.occurredAt } : {}),
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (res.ok) {
      const data = (await res.json().catch(() => ({}))) as { eventId?: string };
      console.log(`[ACTIVITY] Published '${params.eventType}' for ${actor} (id: ${data.eventId || 'ok'})`);
      return { eventId: data.eventId, success: true };
    } else {
      const errText = await res.text().catch(() => '');
      console.warn(`[ACTIVITY] Failed to publish '${params.eventType}' (${res.status}): ${errText.slice(0, 200)}`);
      return { success: false };
    }
  } catch (err: any) {
    console.warn(`[ACTIVITY] Error publishing '${params.eventType}':`, err?.message || err);
    return { success: false };
  }
}
