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
