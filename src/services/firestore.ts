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
    advanceHours?: number;
    silenceStart?: string;
    silenceEnd?: string;
};

export type ChurchDoc = {
    id: string;
    data: FirebaseFirestore.DocumentData;
};

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
            .where('whatsappAutomation.connected', '==', true)
            .get();

        return snapshot.docs.map(doc => ({ id: doc.id, data: doc.data() }));
    } catch (error) {
        console.warn('Enabled+connected churches query failed; falling back to full scan:', error);
        const snapshot = await db.collection('igrejas').get();
        return snapshot.docs
            .map(doc => ({ id: doc.id, data: doc.data() }))
            .filter(doc =>
                doc.data?.whatsappAutomation?.enabled === true
                && doc.data?.whatsappAutomation?.connected === true
            );
    }
}
