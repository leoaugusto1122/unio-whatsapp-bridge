import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createAdaptiveJobLoop,
    groupItemDocsByMember,
    listPendingNotificationItems,
    parseItemDocumentPath
} from './scheduler.js';

test('parseItemDocumentPath extracts church and escala identifiers from item path', () => {
    assert.deepEqual(
        parseItemDocumentPath('igrejas/igreja-a/escalas/escala-b/items/item-c'),
        {
            churchId: 'igreja-a',
            escalaId: 'escala-b',
            itemId: 'item-c'
        }
    );
});

test('parseItemDocumentPath returns null for unexpected paths', () => {
    assert.equal(parseItemDocumentPath('igrejas/igreja-a/items/item-c'), null);
});

test('groupItemDocsByMember consolidates multiple items of the same member inside one escala', () => {
    function makeDoc(membroId: string, suffix: string) {
        return {
            ref: { path: `igrejas/a/escalas/1/items/${suffix}` },
            data() {
                return { membroId };
            }
        };
    }

    const groups = groupItemDocsByMember([
        makeDoc('m1', 'a') as any,
        makeDoc('m1', 'b') as any,
        makeDoc('m2', 'c') as any
    ]);

    assert.equal(groups.size, 2);
    assert.equal(groups.get('m1')?.length, 2);
    assert.equal(groups.get('m2')?.length, 1);
});

test('listPendingNotificationItems applies collectionGroup, cutoff and limit', async () => {
    const calls: Array<{
        collectionGroup?: string;
        wheres: Array<[string, string, unknown]>;
        limit?: number;
    }> = [];

    const database = {
        collectionGroup(name: string) {
            const call = {
                collectionGroup: name,
                wheres: [] as Array<[string, string, unknown]>,
                limit: undefined as number | undefined
            };
            calls.push(call);

            return {
                where(field: string, operator: string, value: unknown) {
                    call.wheres.push([field, operator, value]);
                    return this;
                },
                limit(value: number) {
                    call.limit = value;
                    return this;
                },
                async get() {
                    return { docs: [], empty: true, size: 0 };
                }
            };
        }
    };

    const now = new Date('2026-03-19T12:00:00.000Z');
    const result = await listPendingNotificationItems(database as any, {
        now,
        lookbackHours: 24,
        limit: 10
    });

    assert.equal(result?.filterMode, 'createdAt+legacy');
    assert.equal(calls[0].collectionGroup, 'items');
    assert.equal(calls[0].limit, 10);
    assert.deepEqual(calls[0].wheres[0], ['notificado', '==', false]);

    const [, operator, cutoff] = calls[0].wheres[1];
    assert.equal(operator, '>=');
    assert.equal((cutoff as any).toDate().toISOString(), '2026-03-18T12:00:00.000Z');
    assert.equal(calls[0].wheres[1][0], 'createdAt');
    assert.equal(calls[1].wheres[1][0], 'dataCulto');
});

test('listPendingNotificationItems keeps createdAt docs as primary source and uses fallback only for legacy docs', async () => {
    const calls: Array<{
        wheres: Array<[string, string, unknown]>;
        limit?: number;
    }> = [];

    function makeDoc(path: string, data: Record<string, unknown>) {
        return {
            ref: { path },
            data() {
                return data;
            }
        };
    }

    const primaryDocs = [
        makeDoc('igrejas/a/escalas/1/items/alpha', {
            createdAt: { toDate: () => new Date('2026-03-19T11:00:00.000Z') }
        }),
        makeDoc('igrejas/a/escalas/1/items/beta', {
            createdAt: { toDate: () => new Date('2026-03-19T10:00:00.000Z') }
        })
    ];

    const legacyDocs = [
        makeDoc('igrejas/a/escalas/1/items/beta', {}),
        makeDoc('igrejas/a/escalas/1/items/gamma', {}),
        makeDoc('igrejas/a/escalas/1/items/delta', {
            createdAt: { toDate: () => new Date('2026-03-19T09:00:00.000Z') }
        }),
        makeDoc('igrejas/a/escalas/1/items/epsilon', {})
    ];

    let invocation = 0;
    const database = {
        collectionGroup() {
            const call = {
                wheres: [] as Array<[string, string, unknown]>,
                limit: undefined as number | undefined
            };
            calls.push(call);

            return {
                where(field: string, operator: string, value: unknown) {
                    call.wheres.push([field, operator, value]);
                    return this;
                },
                limit(value: number) {
                    call.limit = value;
                    return this;
                },
                async get() {
                    invocation += 1;
                    const docs = invocation === 1 ? primaryDocs : legacyDocs;
                    return {
                        docs,
                        empty: docs.length === 0,
                        size: docs.length
                    };
                }
            };
        }
    };

    const result = await listPendingNotificationItems(database as any, {
        now: new Date('2026-03-19T12:00:00.000Z'),
        lookbackHours: 24,
        limit: 4
    });

    assert.equal(result?.filterMode, 'createdAt+legacy');
    assert.equal(result?.size, 4);
    assert.deepEqual(
        result?.docs.map(doc => doc.ref.path),
        [
            'igrejas/a/escalas/1/items/alpha',
            'igrejas/a/escalas/1/items/beta',
            'igrejas/a/escalas/1/items/gamma',
            'igrejas/a/escalas/1/items/epsilon'
        ]
    );
    assert.equal(calls[0].wheres[1][0], 'createdAt');
    assert.equal(calls[1].wheres[1][0], 'dataCulto');
    assert.equal(calls[1].limit, 2);
});

test('listPendingNotificationItems does not query legacy fallback when createdAt already fills the batch', async () => {
    let collectionGroupCalls = 0;

    function makeDoc(path: string) {
        return {
            ref: { path },
            data() {
                return {
                    createdAt: { toDate: () => new Date('2026-03-19T11:00:00.000Z') }
                };
            }
        };
    }

    const database = {
        collectionGroup() {
            collectionGroupCalls += 1;

            return {
                where() {
                    return this;
                },
                limit() {
                    return this;
                },
                async get() {
                    return {
                        docs: [
                            makeDoc('igrejas/a/escalas/1/items/alpha'),
                            makeDoc('igrejas/a/escalas/1/items/beta')
                        ],
                        empty: false,
                        size: 2
                    };
                }
            };
        }
    };

    const result = await listPendingNotificationItems(database as any, {
        now: new Date('2026-03-19T12:00:00.000Z'),
        lookbackHours: 24,
        limit: 2
    });

    assert.equal(result?.filterMode, 'createdAt');
    assert.equal(result?.size, 2);
    assert.equal(collectionGroupCalls, 1);
});

test('adaptive loop uses idle delay and emits empty-state logs when nothing is fetched', async () => {
    const logs: string[] = [];
    const timers: number[] = [];

    const loop = createAdaptiveJobLoop({
        executeBatchJob: async () => ({
            fetchedItems: 0,
            eligibleItems: 0,
            processedItems: 0,
            filterMode: 'createdAt'
        }),
        setTimer: (_callback, delayMs) => {
            timers.push(delayMs);
            return delayMs as any;
        },
        clearTimer: () => undefined,
        log: message => logs.push(message),
        error: () => {
            throw new Error('error logger should not be called');
        }
    }, {
        idleDelayMinutes: 5,
        activeDelayMinutes: 1
    });

    const nextDelay = await loop.runOnce();

    assert.equal(nextDelay, 5);
    assert.equal(timers[0], 300000);
    assert.equal(logs[0], 'Nenhum item encontrado. Aguardando 5 min...');
    assert.match(logs[1], /"fetchedItems":0/);
    assert.match(logs[1], /"filterMode":"createdAt"/);
    assert.match(logs[1], /"nextDelayMinutes":5/);
});

test('adaptive loop uses active delay when there are fetched items', async () => {
    const logs: string[] = [];
    const timers: number[] = [];

    const loop = createAdaptiveJobLoop({
        executeBatchJob: async () => ({
            fetchedItems: 3,
            eligibleItems: 2,
            processedItems: 1,
            filterMode: 'createdAt+legacy'
        }),
        setTimer: (_callback, delayMs) => {
            timers.push(delayMs);
            return delayMs as any;
        },
        clearTimer: () => undefined,
        log: message => logs.push(message),
        error: () => {
            throw new Error('error logger should not be called');
        }
    }, {
        idleDelayMinutes: 5,
        activeDelayMinutes: 1
    });

    const nextDelay = await loop.runOnce();

    assert.equal(nextDelay, 1);
    assert.equal(timers[0], 60000);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /"fetchedItems":3/);
    assert.match(logs[0], /"eligibleItems":2/);
    assert.match(logs[0], /"processedItems":1/);
    assert.match(logs[0], /"filterMode":"createdAt\+legacy"/);
    assert.match(logs[0], /"nextDelayMinutes":1/);
});

test('adaptive loop prevents overlapping executions while a job is still running', async () => {
    const logs: string[] = [];
    const timers: number[] = [];
    let executeCalls = 0;
    const resolveJob: { current: null | (() => void); } = { current: null };

    const loop = createAdaptiveJobLoop({
        executeBatchJob: async () => {
            executeCalls += 1;
            await new Promise<void>(resolve => {
                resolveJob.current = resolve;
            });

            return {
                fetchedItems: 1,
                eligibleItems: 1,
                processedItems: 1,
                filterMode: 'createdAt'
            };
        },
        setTimer: (_callback, delayMs) => {
            timers.push(delayMs);
            return delayMs as any;
        },
        clearTimer: () => undefined,
        log: message => logs.push(message),
        error: () => {
            throw new Error('error logger should not be called');
        }
    }, {
        idleDelayMinutes: 5,
        activeDelayMinutes: 1
    });

    const firstRun = loop.runOnce();
    const secondDelay = await loop.runOnce();

    assert.equal(secondDelay, 1);
    assert.equal(executeCalls, 1);
    assert.equal(timers.length, 0);
    assert.equal(logs[0], 'Scheduled job already running; skipping this tick.');

    if (resolveJob.current) {
        resolveJob.current();
    }
    await firstRun;

    assert.equal(timers[0], 60000);
    assert.equal(executeCalls, 1);
});
