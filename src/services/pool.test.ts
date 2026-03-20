import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveHourlyWindowState } from './firestore.js';
import { getRemainingHourlyCapacity } from './pool.js';

test('resolveHourlyWindowState keeps the current window when still inside 60 minutes', () => {
    const now = new Date('2026-03-22T12:00:00.000Z');
    const state = resolveHourlyWindowState({
        hourWindowStartedAt: '2026-03-22T11:30:00.000Z',
        hourCount: 40
    }, now);

    assert.equal(state.windowStartedAt, '2026-03-22T11:30:00.000Z');
    assert.equal(state.hourCount, 40);
});

test('resolveHourlyWindowState resets the window after 60 minutes', () => {
    const now = new Date('2026-03-22T12:00:00.000Z');
    const state = resolveHourlyWindowState({
        hourWindowStartedAt: '2026-03-22T10:00:00.000Z',
        hourCount: 40
    }, now);

    assert.equal(state.windowStartedAt, '2026-03-22T12:00:00.000Z');
    assert.equal(state.hourCount, 0);
});

test('getRemainingHourlyCapacity uses the current antiBan hourCount', () => {
    process.env.MAX_HOURLY_PER_NUMBER = '80';

    const remaining = getRemainingHourlyCapacity({
        numberId: 'n1',
        phoneNumber: '5544999999999',
        instanceId: 'instance-a',
        status: 'connected',
        addedAt: '2026-03-22T10:00:00.000Z',
        connectedAt: '2026-03-22T10:00:00.000Z',
        lastUsedAt: '2026-03-22T11:00:00.000Z',
        messagesToday: 10,
        totalMessages: 200,
        notes: '',
        antiBan: {
            hourWindowStartedAt: '2026-03-22T11:30:00.000Z',
            hourCount: 65,
            lastHourlyBlockAt: null
        }
    }, new Date('2026-03-22T12:00:00.000Z'));

    assert.equal(remaining, 15);
});
