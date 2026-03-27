import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildNextChurchWhatsappUsageState,
    getCurrentUsageMonthKey
} from './firestore.js';

test('getCurrentUsageMonthKey returns YYYY-MM', () => {
    assert.equal(getCurrentUsageMonthKey(new Date('2026-03-27T12:00:00.000Z')), '2026-03');
});

test('buildNextChurchWhatsappUsageState increments inside the same month', () => {
    const next = buildNextChurchWhatsappUsageState({
        waSentThisMonth: 4,
        waMonthKey: '2026-03'
    }, 2, new Date('2026-03-27T12:00:00.000Z'));

    assert.equal(next.waSentThisMonth, 6);
    assert.equal(next.waMonthKey, '2026-03');
});

test('buildNextChurchWhatsappUsageState resets usage when the month changes', () => {
    const next = buildNextChurchWhatsappUsageState({
        waSentThisMonth: 9,
        waMonthKey: '2026-02'
    }, 1, new Date('2026-03-01T03:00:00.000Z'));

    assert.equal(next.waSentThisMonth, 1);
    assert.equal(next.waMonthKey, '2026-03');
});

test('buildNextChurchWhatsappUsageState protects against invalid counters', () => {
    const next = buildNextChurchWhatsappUsageState({
        waSentThisMonth: -5,
        waMonthKey: '2026-03'
    }, -2, new Date('2026-03-27T12:00:00.000Z'));

    assert.equal(next.waSentThisMonth, 0);
    assert.equal(next.waMonthKey, '2026-03');
});
