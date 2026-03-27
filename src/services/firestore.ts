import admin from 'firebase-admin';
import dotenv from 'dotenv';

if (process.env.NODE_ENV !== 'production') {
    dotenv.config();
}

if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
                projectId: process.env.FIREBASE_PROJECT_ID
            });
        }
    } catch (error) {
        console.error('Failed to initialize Firebase Admin:', error);
    }
} else {
    console.warn('Firebase config missing. Firestore features will not work.');
}

export const db = admin.apps.length > 0 ? admin.firestore() : null;

export type ChurchWhatsappAutomation = {
    enabled?: boolean;
    connected?: boolean;
    advanceType?: 'hours' | 'days';
    advanceValue?: number;
    advanceHours?: number;
    silenceStart?: string;
    silenceEnd?: string;
};

export type ChurchDoc = {
    id: string;
    data: FirebaseFirestore.DocumentData;
};

export type PoolNumberStatus = 'connected' | 'disconnected' | 'banned';

export type PoolNumberAntiBan = {
    hourWindowStartedAt: string | null;
    hourCount: number;
    lastHourlyBlockAt: string | null;
};

export type PoolNumber = {
    numberId: string;
    phoneNumber: string;
    instanceId: string;
    status: PoolNumberStatus;
    addedAt: string;
    connectedAt: string | null;
    lastUsedAt: string | null;
    messagesToday: number;
    totalMessages: number;
    notes: string;
    antiBan: PoolNumberAntiBan;
};

type ChurchUsage = {
    waSentThisMonth?: number;
    waMonthKey?: string;
    [key: string]: unknown;
};

function getChurchRef(churchId: string) {
    if (!db) return null;
    return db.collection('igrejas').doc(churchId);
}

export function getCurrentUsageMonthKey(now = new Date()) {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
}

export function buildNextChurchWhatsappUsageState(
    usage: ChurchUsage | null | undefined,
    incrementBy = 1,
    now = new Date()
) {
    const safeUsage = (usage && typeof usage === 'object') ? usage : {};
    const currentMonthKey = getCurrentUsageMonthKey(now);
    const storedMonthKey = String(safeUsage.waMonthKey || '').trim();
    const currentCount = storedMonthKey === currentMonthKey
        ? Math.max(0, Number(safeUsage.waSentThisMonth || 0))
        : 0;
    const nextIncrement = Math.max(0, Number(incrementBy || 0));

    return {
        ...safeUsage,
        waSentThisMonth: currentCount + nextIncrement,
        waMonthKey: currentMonthKey
    };
}

export async function getChurchWhatsappAutomation(churchId: string): Promise<ChurchWhatsappAutomation | null> {
    const churchRef = getChurchRef(churchId);
    if (!churchRef) return null;

    const snapshot = await churchRef.get();
    if (!snapshot.exists) return null;

    const data = snapshot.data();
    return (data?.whatsappAutomation || null) as ChurchWhatsappAutomation | null;
}

export async function updateChurchWhatsappConnected(churchId: string, connected: boolean) {
    const churchRef = getChurchRef(churchId);
    if (!churchRef) return false;

    await churchRef.update({
        'whatsappAutomation.connected': connected
    });

    return true;
}

export async function incrementChurchWhatsappUsage(churchId: string, incrementBy = 1, now = new Date()) {
    if (!db) return false;

    const churchRef = getChurchRef(churchId);
    if (!churchRef) return false;

    await db.runTransaction(async transaction => {
        const snapshot = await transaction.get(churchRef);
        const currentData = snapshot.data() || {};
        const nextUsage = buildNextChurchWhatsappUsageState(currentData.usage, incrementBy, now);

        transaction.set(churchRef, {
            usage: nextUsage
        }, { merge: true });
    });

    return true;
}

export async function updateEscalaAllItemsNotificados(churchId: string, escalaId: string) {
    if (!db) return false;

    const escalaRef = db.collection(`igrejas/${churchId}/escalas`).doc(escalaId);
    const itemsSnapshot = await escalaRef.collection('items').get();
    const allItemsNotificados = !itemsSnapshot.empty
        && itemsSnapshot.docs.every(doc => doc.data()?.notificado === true);

    await escalaRef.set({
        allItemsNotificados
    }, { merge: true });

    return allItemsNotificados;
}

export async function listEnabledChurches(): Promise<ChurchDoc[]> {
    if (!db) return [];

    try {
        const snapshot = await db.collection('igrejas')
            .where('whatsappAutomation.enabled', '==', true)
            .get();

        return snapshot.docs.map(doc => ({ id: doc.id, data: doc.data() }));
    } catch (error: any) {
        const code = String(error?.code || error?.details || error?.message || 'unknown');
        console.warn('Enabled churches query failed; falling back to full scan:', code);
        const snapshot = await db.collection('igrejas').get();
        return snapshot.docs
            .map(doc => ({ id: doc.id, data: doc.data() }))
            .filter(doc => doc.data?.whatsappAutomation?.enabled === true);
    }
}

function getPoolRef(numberId: string) {
    if (!db) return null;
    return db.collection('whatsappPool').doc(numberId);
}

function docToPoolNumber(doc: FirebaseFirestore.DocumentSnapshot): PoolNumber {
    const d = doc.data() || {};
    const antiBan = d.antiBan || {};
    return {
        numberId: doc.id,
        phoneNumber: d.phoneNumber || '',
        instanceId: d.instanceId || '',
        status: d.status || 'disconnected',
        addedAt: d.addedAt || '',
        connectedAt: d.connectedAt || null,
        lastUsedAt: d.lastUsedAt || null,
        messagesToday: d.messagesToday || 0,
        totalMessages: d.totalMessages || 0,
        notes: d.notes || '',
        antiBan: {
            hourWindowStartedAt: antiBan.hourWindowStartedAt || null,
            hourCount: antiBan.hourCount || 0,
            lastHourlyBlockAt: antiBan.lastHourlyBlockAt || null
        }
    };
}

export async function addPoolNumber(data: Omit<PoolNumber, 'numberId'>): Promise<string> {
    if (!db) throw new Error('Firestore not initialized');
    const ref = await db.collection('whatsappPool').add(data);
    return ref.id;
}

export async function getPoolNumber(numberId: string): Promise<PoolNumber | null> {
    const ref = getPoolRef(numberId);
    if (!ref) return null;
    const doc = await ref.get();
    if (!doc.exists) return null;
    return docToPoolNumber(doc);
}

export async function listPoolNumbers(): Promise<PoolNumber[]> {
    if (!db) return [];
    const snapshot = await db.collection('whatsappPool').orderBy('addedAt', 'asc').get();
    return snapshot.docs.map(docToPoolNumber);
}

export async function listConnectedPoolNumbers(): Promise<PoolNumber[]> {
    if (!db) return [];
    const snapshot = await db.collection('whatsappPool')
        .where('status', '==', 'connected')
        .get();
    return snapshot.docs.map(docToPoolNumber);
}

export async function updatePoolNumber(numberId: string, fields: Partial<Omit<PoolNumber, 'numberId'>>): Promise<void> {
    const ref = getPoolRef(numberId);
    if (!ref) throw new Error('Firestore not initialized');
    await ref.update(fields as FirebaseFirestore.UpdateData<any>);
}

export type HourlyReservationResult = {
    allowed: boolean;
    reservedSlots: number;
    remainingSlots: number;
    hourCount: number;
    windowStartedAt: string;
};

export function resolveHourlyWindowState(
    antiBan: Partial<PoolNumberAntiBan> | null | undefined,
    now: Date
) {
    const startedAt = antiBan?.hourWindowStartedAt ? new Date(antiBan.hourWindowStartedAt) : null;
    const currentCount = Number(antiBan?.hourCount || 0);
    const isValidStart = startedAt && Number.isFinite(startedAt.getTime());
    const isSameWindow = Boolean(isValidStart && (now.getTime() - startedAt.getTime()) < (60 * 60 * 1000));

    if (isSameWindow && startedAt) {
        return {
            windowStartedAt: startedAt.toISOString(),
            hourCount: currentCount
        };
    }

    return {
        windowStartedAt: now.toISOString(),
        hourCount: 0
    };
}

export async function reserveHourlyMessageSlots(
    numberId: string,
    requestedSlots: number,
    maxHourly: number,
    now = new Date()
): Promise<HourlyReservationResult> {
    if (!db) throw new Error('Firestore not initialized');

    const ref = getPoolRef(numberId);
    if (!ref) throw new Error('Firestore not initialized');

    return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) {
            throw new Error(`Pool number ${numberId} not found`);
        }

        const data = snapshot.data() || {};
        const antiBan = resolveHourlyWindowState(data.antiBan || {}, now);
        const nextCount = antiBan.hourCount + requestedSlots;

        if (nextCount > maxHourly) {
            transaction.update(ref, {
                'antiBan.lastHourlyBlockAt': now.toISOString()
            });

            return {
                allowed: false,
                reservedSlots: 0,
                remainingSlots: Math.max(0, maxHourly - antiBan.hourCount),
                hourCount: antiBan.hourCount,
                windowStartedAt: antiBan.windowStartedAt
            };
        }

        transaction.update(ref, {
            'antiBan.hourWindowStartedAt': antiBan.windowStartedAt,
            'antiBan.hourCount': nextCount
        });

        return {
            allowed: true,
            reservedSlots: requestedSlots,
            remainingSlots: Math.max(0, maxHourly - nextCount),
            hourCount: nextCount,
            windowStartedAt: antiBan.windowStartedAt
        };
    });
}

export async function deletePoolNumber(numberId: string): Promise<void> {
    const ref = getPoolRef(numberId);
    if (!ref) throw new Error('Firestore not initialized');
    await ref.delete();
}

export async function incrementNumberMessageCount(numberId: string): Promise<void> {
    const ref = getPoolRef(numberId);
    if (!ref) return;
    await ref.update({
        messagesToday: admin.firestore.FieldValue.increment(1),
        totalMessages: admin.firestore.FieldValue.increment(1),
        lastUsedAt: new Date().toISOString()
    });
}

export async function resetDailyMessageCounts(): Promise<void> {
    if (!db) return;
    const snapshot = await db.collection('whatsappPool').get();
    const batch = db.batch();
    for (const doc of snapshot.docs) {
        batch.update(doc.ref, { messagesToday: 0 });
    }
    await batch.commit();
}
