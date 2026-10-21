import { describe, it, expect } from 'vitest';
import {
  backoffMinutes,
  bearerToken,
  buildPayload,
  classifyPushStatus,
  combineResults,
  timingSafeEqual,
  type ClaimedPush,
} from '../../supabase/functions/expiry-push/logic';

describe('expiry-push logic', () => {
  it('classifies push service responses', () => {
    expect(classifyPushStatus(201)).toBe('sent');
    expect(classifyPushStatus(404)).toBe('gone');
    expect(classifyPushStatus(410)).toBe('gone');
    for (const status of [null, undefined, 408, 429, 500, 503]) expect(classifyPushStatus(status)).toBe('retry');
    for (const status of [400, 401, 403, 413]) expect(classifyPushStatus(status)).toBe('fail');
  });

  it('backs off 5 min, 30 min, 2 h, then 6 h', () => {
    expect([1, 2, 3, 4, 5, 9].map(backoffMinutes)).toEqual([5, 30, 120, 360, 360, 360]);
    expect(backoffMinutes(0)).toBe(5);
  });

  it('builds a payload whose tag replaces the same alert instead of stacking it', () => {
    const push: ClaimedPush = {
      notification_id: 'n1',
      title: 'Expires in 7 days: Milk',
      body: '4 units, expiry 2026-10-21, batch ABCDEF (received 2026-10-01).',
      data: { batch_id: 'b1', kind: 'reminder', threshold_days: 7 },
      attempts: 1,
      subscriptions: [],
    };
    const payload = buildPayload(push);
    expect(payload).toMatchObject({ tag: 'expiry:b1:reminder:7', url: '/?tab=alerts', data: { notification_id: 'n1' } });
    expect(buildPayload({ ...push, body: null, data: { batch_id: 'b1', kind: 'expired', threshold_days: null } })).toMatchObject(
      { tag: 'expiry:b1:expired:expired', body: '' }
    );
    expect(
      buildPayload({
        ...push,
        title: 'Low stock: Bread',
        body: '2 on hand, minimum 5.',
        data: { kind: 'low_stock', product_id: 'bread' },
      })
    ).toMatchObject({ tag: 'low-stock:bread', url: '/?tab=alerts' });
  });

  it('counts delivery to any device as sent and reports gone subscriptions', () => {
    expect(
      combineResults('n1', [
        { subscriptionId: 's1', outcome: 'sent' },
        { subscriptionId: 's2', outcome: 'gone', error: '410' },
        { subscriptionId: 's3', outcome: 'retry', error: '503' },
      ])
    ).toEqual({ notification_id: 'n1', outcome: 'sent', ok_subscription_ids: ['s1'], gone_subscription_ids: ['s2'] });
  });

  it('retries when any device may still receive it, otherwise fails', () => {
    expect(
      combineResults('n1', [
        { subscriptionId: 's1', outcome: 'gone', error: '410' },
        { subscriptionId: 's2', outcome: 'retry', error: '503' },
      ])
    ).toMatchObject({ outcome: 'retry', error: '410', gone_subscription_ids: ['s1'] });
    expect(combineResults('n1', [{ subscriptionId: 's1', outcome: 'fail', error: '400' }])).toMatchObject({
      outcome: 'fail',
      error: '400',
    });
    expect(combineResults('n1', [])).toMatchObject({ outcome: 'fail', error: 'No active push subscriptions.' });
  });

  it('checks the cron secret', () => {
    expect(bearerToken('Bearer abc123')).toBe('abc123');
    expect(bearerToken('bearer  abc123 ')).toBe('abc123');
    expect(bearerToken('Basic abc123')).toBeNull();
    expect(bearerToken(null)).toBeNull();
    expect(timingSafeEqual('secret', 'secret')).toBe(true);
    expect(timingSafeEqual('secret', 'secreT')).toBe(false);
    expect(timingSafeEqual('secret', 'secret2')).toBe(false);
    expect(timingSafeEqual('', 'x')).toBe(false);
  });
});
