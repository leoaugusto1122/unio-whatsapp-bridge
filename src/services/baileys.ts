import makeWASocket, { DisconnectReason, WASocket } from '@whiskeysockets/baileys';
import { useCustomFileAuthState, clearSession } from './session';
import path from 'path';
import pino from 'pino';
import { Boom } from '@hapi/boom';

const SESSIONS_DIR = process.env.SESSIONS_DIR || path.join(__dirname, '../../sessions');

interface InstanceData {
    sock: WASocket;
    phoneNumber?: string;
    connectedSince: string;
}

const instances = new Map<string, InstanceData>();
const connectingInstances = new Set<string>();
const logger = pino({ level: 'silent' });

export function normalizeToJid(phone: string) {
    const digits = phone.replace(/\D/g, '');
    let finalPhone = digits;
    if (!finalPhone.startsWith('55')) {
        finalPhone = '55' + finalPhone;
    }
    return `${finalPhone}@s.whatsapp.net`;
}

export function getConnectedInstancesCount() {
    return instances.size;
}

export async function connectInstance(churchId: string, phoneNumber: string) {
    if (instances.has(churchId)) {
        return { status: 'connected', phoneNumber };
    }

    if (connectingInstances.has(churchId)) {
        return { status: 'connecting', phoneNumber };
    }

    connectingInstances.add(churchId);

    const { state, saveCreds } = await useCustomFileAuthState(churchId, SESSIONS_DIR);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger,
        syncFullHistory: false,
        markOnlineOnConnect: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            instances.set(churchId, {
                sock,
                phoneNumber,
                connectedSince: new Date().toISOString()
            });
            connectingInstances.delete(churchId);
        } else if (connection === 'close') {
            const error = (lastDisconnect?.error as Boom)?.output?.statusCode;
            const shouldReconnect = error !== DisconnectReason.loggedOut;

            instances.delete(churchId);

            if (shouldReconnect) {
                // try to reconnect
                setTimeout(() => connectInstance(churchId, phoneNumber), 5000);
            } else {
                connectingInstances.delete(churchId);
                clearSession(churchId, SESSIONS_DIR);
            }
        }
    });

    if (!sock.authState.creds.registered) {
        // Small delay as recommended when requesting pairing code
        await new Promise(resolve => setTimeout(resolve, 1500));
        try {
            const code = await sock.requestPairingCode(phoneNumber);
            return { status: 'pending', pairingCode: code, expiresIn: 60 };
        } catch (error) {
            connectingInstances.delete(churchId);
            throw error;
        }
    } else {
        return { status: 'connecting', phoneNumber };
    }
}

export async function getInstanceStatus(churchId: string) {
    if (instances.has(churchId)) {
        const data = instances.get(churchId);
        return {
            churchId,
            status: 'connected',
            phoneNumber: data?.phoneNumber,
            connectedSince: data?.connectedSince
        };
    }
    if (connectingInstances.has(churchId)) {
        return { churchId, status: 'connecting' };
    }
    return { churchId, status: 'disconnected' };
}

export async function disconnectInstance(churchId: string) {
    if (instances.has(churchId)) {
        const { sock } = instances.get(churchId)!;
        sock.logout();
        instances.delete(churchId);
    }
    connectingInstances.delete(churchId);
    await clearSession(churchId, SESSIONS_DIR);
    return { status: 'disconnected', churchId };
}

export async function sendIndividualMessage(churchId: string, to: string, message: string) {
    const data = instances.get(churchId);
    if (!data) {
        return { status: 'failed', reason: 'instance_disconnected', message: `A instância da igreja ${churchId} não está conectada` };
    }

    const jid = normalizeToJid(to);

    try {
        await data.sock.sendMessage(jid, { text: message });
        return { status: 'sent', to: jid, timestamp: new Date().toISOString() };
    } catch (error: any) {
        return { status: 'failed', reason: 'send_error', message: error.message };
    }
}

export async function sendBatchMessages(churchId: string, messages: { to: string, message: string }[]) {
    const data = instances.get(churchId);
    if (!data) {
        throw new Error('instance_disconnected');
    }

    const sock = data.sock;
    const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

    let sent = 0;
    let failed = 0;
    const results = [];

    for (const item of messages) {
        const jid = normalizeToJid(item.to);
        try {
            await sock.sendMessage(jid, { text: item.message });
            results.push({ to: item.to, status: 'sent', failReason: null });
            sent++;

            if (sent + failed < messages.length) {
                // Random delay between 15s and 45s
                const randomDelay = Math.floor(Math.random() * (45000 - 15000 + 1)) + 15000;
                await delay(randomDelay);
            }
        } catch (error: any) {
            results.push({ to: item.to, status: 'failed', failReason: error.message });
            failed++;
        }
    }

    return { total: messages.length, sent, failed, results };
}
