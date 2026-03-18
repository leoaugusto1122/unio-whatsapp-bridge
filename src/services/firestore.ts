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

// ─── Church types ────────────────────────────────────────────────────────────

export type ChurchWhatsappAutomation = {
    enabled?: boolean;
    /** @deprecated pool-based architecture; kept for legacy connection-sync reads */
    connected?: boolean;
    advanceType?: 'hours' | 'days';
    advanceValue?: number;
    /** @deprecated kept for backward compat reads */
    advanceHours?: number;
    silenceStart?: string;
    silenceEnd?: string;
};

export type ChurchDoc = {
    id: string;
    data: FirebaseFirestore.DocumentData;
};

// ─── Pool types ───────────────────────────────────────────────────────────────

export type PoolNumberStatus = 'connected' | 'disconnected' | 'banned';

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
};

// ─── Church helpers ───────────────────────────────────────────────────────────

function getChurchRef(churchId: string) {
    if (!db) return null;
    return db.collection('igrejas').doc(churchId);
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

export async function listEnabledChurches(): Promise<ChurchDoc[]> {
    if (!db) return [];

    try {
        const snapshot = await db.collection('igrejas')
            .where('whatsappAutomation.enabled', '==', true)
            .get();

        return snapshot.docs.map(doc => ({ id: doc.id, data: doc.data() }));
    } catch (error) {
        console.warn('Enabled churches query failed; falling back to full scan:', error);
        const snapshot = await db.collection('igrejas').get();
        return snapshot.docs
            .map(doc => ({ id: doc.id, data: doc.data() }))
            .filter(doc => doc.data?.whatsappAutomation?.enabled === true);
    }
}

// ─── Pool helpers ─────────────────────────────────────────────────────────────

function getPoolRef(numberId: string) {
    if (!db) return null;
    return db.collection('whatsappPool').doc(numberId);
}

function docToPoolNumber(doc: FirebaseFirestore.DocumentSnapshot): PoolNumber {
    const d = doc.data() || {};
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
        notes: d.notes || ''
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
