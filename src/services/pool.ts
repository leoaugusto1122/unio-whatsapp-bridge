import { listConnectedPoolNumbers, type PoolNumber } from './firestore.js';

const DEFAULT_MAX_DAILY = 150;

function getMaxDailyPerNumber(): number {
    const raw = Number.parseInt(process.env.MAX_DAILY_PER_NUMBER || '', 10);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_DAILY;
}

/**
 * Selects the best available pool number for sending a message.
 *
 * Algorithm:
 * 1. Fetch all connected numbers
 * 2. Exclude numbers at or above MAX_DAILY_PER_NUMBER
 * 3. Sort by messagesToday ASC (prefer least used today)
 * 4. Tie-break by lastUsedAt ASC (round-robin)
 */
export async function selectSenderForChurch(_churchId: string): Promise<PoolNumber | null> {
    const maxDaily = getMaxDailyPerNumber();
    const connected = await listConnectedPoolNumbers();

    const eligible = connected.filter(n => n.messagesToday < maxDaily);
    if (eligible.length === 0) return null;

    eligible.sort((a, b) => {
        if (a.messagesToday !== b.messagesToday) {
            return a.messagesToday - b.messagesToday;
        }
        // round-robin tie-break: least recently used first
        const aTime = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0;
        const bTime = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0;
        return aTime - bTime;
    });

    return eligible[0];
}
