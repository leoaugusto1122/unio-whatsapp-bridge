import test from 'node:test';
import assert from 'node:assert/strict';
import {
    getBatchDelayMs,
    getPresenceDelayMs,
    resetInstanceSendQueueForTests,
    sendText
} from './evolution.js';

const originalFetch = global.fetch;

test('getPresenceDelayMs respects configured range', () => {
    process.env.PRESENCE_MIN_DELAY_MS = '3000';
    process.env.PRESENCE_MAX_DELAY_MS = '6000';

    const delay = getPresenceDelayMs(() => 0);
    assert.equal(delay, 3000);
});

test('getBatchDelayMs respects configured range', () => {
    process.env.BATCH_MIN_DELAY_MS = '15000';
    process.env.BATCH_MAX_DELAY_MS = '30000';

    const delay = getBatchDelayMs(() => 0.999999);
    assert.equal(delay, 30000);
});

test('sendText includes composing presence and delay in the Evolution payload', async () => {
    process.env.EVOLUTION_BASE_URL = 'http://localhost:8080';
    process.env.EVOLUTION_API_KEY = 'test-key';
    process.env.PRESENCE_MIN_DELAY_MS = '3000';
    process.env.PRESENCE_MAX_DELAY_MS = '3000';
    process.env.BATCH_MIN_DELAY_MS = '0';
    process.env.BATCH_MAX_DELAY_MS = '0';
    resetInstanceSendQueueForTests();

    const requests: Array<{ url: string; body: any; }> = [];
    global.fetch = (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
        requests.push({
            url: String(input),
            body: init?.body ? JSON.parse(String(init.body)) : null
        });

        return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
        });
    }) as any;

    const result = await sendText('instance-a', '5544999999999', 'Teste');

    assert.equal(result.status, 'sent');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.options.presence, 'composing');
    assert.equal(requests[0].body.options.delay, 3000);
    assert.equal(requests[0].body.textMessage.text, 'Teste');

    global.fetch = originalFetch;
});

test('sendText serializes messages for the same instanceId', async () => {
    process.env.EVOLUTION_BASE_URL = 'http://localhost:8080';
    process.env.EVOLUTION_API_KEY = 'test-key';
    process.env.PRESENCE_MIN_DELAY_MS = '0';
    process.env.PRESENCE_MAX_DELAY_MS = '0';
    process.env.BATCH_MIN_DELAY_MS = '0';
    process.env.BATCH_MAX_DELAY_MS = '0';
    resetInstanceSendQueueForTests();

    const callOrder: string[] = [];
    let releaseFirst: (() => void) | undefined;

    global.fetch = (async (_input: string | URL | globalThis.Request, init?: RequestInit) => {
        const payload = init?.body ? JSON.parse(String(init.body)) : null;
        const text = payload?.textMessage?.text;
        callOrder.push(`start:${text}`);

        if (text === 'primeira') {
            await new Promise<void>(resolve => {
                releaseFirst = () => resolve();
            });
        }

        callOrder.push(`finish:${text}`);

        return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
        });
    }) as any;

    const firstPromise = sendText('instance-a', '5544999999999', 'primeira');
    const secondPromise = sendText('instance-a', '5544999999998', 'segunda');

    for (let attempt = 0; attempt < 10 && callOrder.length === 0; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 0));
    }

    assert.deepEqual(callOrder, ['start:primeira']);

    if (!releaseFirst) {
        throw new Error('expected first request blocker to be initialized');
    }

    releaseFirst();

    await Promise.all([firstPromise, secondPromise]);

    assert.deepEqual(callOrder, [
        'start:primeira',
        'finish:primeira',
        'start:segunda',
        'finish:segunda'
    ]);

    global.fetch = originalFetch;
});
