import {
    listConnectedPoolNumbers,
    reserveHourlyMessageSlots,
    resolveHourlyWindowState,
    type PoolNumber
} from './firestore.js';

const DEFAULT_MAX_DAILY = 150;
const DEFAULT_MAX_HOURLY = 80;

function getMaxDailyPerNumber(): number {
    const raw = Number.parseInt(process.env.MAX_DAILY_PER_NUMBER || '', 10);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_DAILY;
}

export function getMaxHourlyPerNumber(): number {
    const raw = Number.parseInt(process.env.MAX_HOURLY_PER_NUMBER || '', 10);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_HOURLY;
}

export function getRemainingHourlyCapacity(number: PoolNumber, now = new Date()) {
    const state = resolveHourlyWindowState(number.antiBan, now);
    return Math.max(0, getMaxHourlyPerNumber() - state.hourCount);
}

/**
 * Selects the best available pool number for sending a message.
 *
 * Algorithm:
 * 1. Fetch all connected numbers
 * 2. Exclude numbers at or above MAX_DAILY_PER_NUMBER
 * 3. Exclude numbers at or above MAX_HOURLY_PER_NUMBER for the requested batch
 * 4. Sort by messagesToday ASC (prefer least used today)
 * 5. Tie-break by lastUsedAt ASC (round-robin)
 */
export async function selectSenderForChurch(_churchId: string, requestedSlots = 1): Promise<PoolNumber | null> {
    const maxDaily = getMaxDailyPerNumber();
    const maxHourly = getMaxHourlyPerNumber();
    const now = new Date();
    const connected = await listConnectedPoolNumbers();

    const eligible = connected.filter(number =>
        number.messagesToday < maxDaily && getRemainingHourlyCapacity(number, now) >= requestedSlots
    );
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

    for (const sender of eligible) {
        const reservation = await reserveHourlyMessageSlots(sender.numberId, requestedSlots, maxHourly, now);
        if (reservation.allowed) {
            console.log(JSON.stringify({
                timestamp: new Date().toISOString(),
                event: 'sender_reserved_hourly_slot',
                numberId: sender.numberId,
                instanceId: sender.instanceId,
                reservedSlots: reservation.reservedSlots,
                remainingSlots: reservation.remainingSlots,
                requestedSlots
            }));
            return sender;
        }

        console.warn(JSON.stringify({
            timestamp: new Date().toISOString(),
            event: 'hourly_rate_limit_blocked',
            numberId: sender.numberId,
            instanceId: sender.instanceId,
            requestedSlots,
            remainingSlots: reservation.remainingSlots
        }));
    }

    return null;
}
