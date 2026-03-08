import { makeWASocket, Browsers, DisconnectReason, WASocket } from 'baileys';
import { useCustomFileAuthState, clearSession } from './session.js';
import path from 'path';
import { fileURLToPath } from 'url';
import pino from 'pino';
import type { Boom } from '@hapi/boom';
import fs from 'fs/promises';
import { normalizePhoneToJid, PhoneValidationError } from '../utils/phone.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_SESSIONS_DIR = path.join(__dirname, '../../sessions');
function getSessionsDir() {
    return process.env.SESSIONS_DIR || DEFAULT_SESSIONS_DIR;
}

const QR_CODE_MAX_AGE_MS = 25_000;

const UNHANDLED_REJECTION_HANDLER_KEY = '__unio_whatsapp_bridge_unhandled_rejection_handler__';
if (!(globalThis as any)[UNHANDLED_REJECTION_HANDLER_KEY]) {
    (globalThis as any)[UNHANDLED_REJECTION_HANDLER_KEY] = true;
    // Nunca deixar erros do Baileys propagarem para process level
    process.on('unhandledRejection', (err) => {
        console.error('Unhandled rejection (suppressed):', err);
    });
}

interface InstanceData {
    sock: WASocket;
    phoneNumber?: string;
    connectedSince: string;
}

interface ConnectingInstanceData {
    sock: WASocket;
    sessionsDir: string;
    startedAt: string;
    attemptId: string;
    qrCode?: string;
    qrCodeUpdatedAt?: number;
}

type ConnectOptions = {
    /**
     * When an instance is already "connecting":
     * - "return": keep existing attempt & return { status: 'connecting' }
     * - "reset": destroy socket, wipe session dir, start a fresh connection
     */
    ifConnecting?: 'return' | 'reset';
};

const instances = new Map<string, InstanceData>();
const connectingInstances = new Map<string, ConnectingInstanceData>();
const churchQueues = new Map<string, Promise<unknown>>();
const logger = pino({ level: 'silent' });

export function normalizeToJid(phone: string) {
    return normalizePhoneToJid(phone).jid;
}

export function getConnectedInstancesCount() {
    return instances.size;
}

async function isOnWhatsApp(sock: WASocket, jid: string) {
    const result = await sock.onWhatsApp(jid);
    const entry = Array.isArray(result) ? result[0] : null;
    return !!entry?.exists;
}

function runExclusive<T>(churchId: string, task: () => Promise<T>) {
    const prev = churchQueues.get(churchId) ?? Promise.resolve();
    const next = prev.then(task, task);
    churchQueues.set(
        churchId,
        next.finally(() => {
            if (churchQueues.get(churchId) === next) {
                churchQueues.delete(churchId);
            }
        })
    );
    return next;
}

function isCurrentSock(churchId: string, sock: WASocket) {
    return instances.get(churchId)?.sock === sock || connectingInstances.get(churchId)?.sock === sock;
}

function destroySock(sock: WASocket, reason: string) {
    try {
        sock.end(new Error(reason));
    } catch { }
    try {
        sock.ws.close();
    } catch { }
}

async function resetConnectingInstance(churchId: string) {
    const connecting = connectingInstances.get(churchId);
    if (!connecting) return false;

    connectingInstances.delete(churchId);
    destroySock(connecting.sock, 'connecting_instance_reset');
    await clearSession(churchId, connecting.sessionsDir);
    return true;
}

function makeAttemptId() {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function extractPhoneNumberFromUserId(userId?: string) {
    if (!userId) return undefined;
    const beforeAt = userId.split('@')[0] || userId;
    const beforeColon = beforeAt.split(':')[0] || beforeAt;
    const digits = beforeColon.replace(/\D/g, '');
    return digits || undefined;
}

export function getFreshQrCode(churchId: string, maxAgeMs = QR_CODE_MAX_AGE_MS) {
    const latest = getLatestQrCode(churchId);
    if (!latest) return null;
    if (latest.ageMs > maxAgeMs) return null;
    return latest;
}

export function getLatestQrCode(churchId: string) {
    const instance = connectingInstances.get(churchId);
    if (!instance?.qrCode) return null;
    const updatedAt = instance.qrCodeUpdatedAt ?? 0;
    const ageMs = Date.now() - updatedAt;
    if (!Number.isFinite(ageMs)) return null;
    return { qrCode: instance.qrCode, ageMs };
}

export async function connectInstance(churchId: string, options: ConnectOptions = {}) {
    return runExclusive(churchId, async () => {
        if (instances.has(churchId)) {
            const data = instances.get(churchId);
            return { status: 'connected', phoneNumber: data?.phoneNumber };
        }

        const ifConnecting = options.ifConnecting ?? 'return';
        if (connectingInstances.has(churchId)) {
            if (ifConnecting === 'reset') {
                await resetConnectingInstance(churchId);
            } else {
                const qrAvailable = !!getFreshQrCode(churchId);
                return { status: qrAvailable ? 'pending' : 'connecting', qrAvailable };
            }
        }

        const sessionsDir = getSessionsDir();
        const { state, saveCreds } = await useCustomFileAuthState(churchId, sessionsDir);

        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: ["Ubuntu", "Chrome", "20.0.04"],
            logger,
            syncFullHistory: false,
            markOnlineOnConnect: false
        });

        const attemptId = makeAttemptId();
        connectingInstances.set(churchId, {
            sock,
            sessionsDir,
            startedAt: new Date().toISOString(),
            attemptId
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update as { connection?: string; lastDisconnect?: any; qr?: string };

            if (!isCurrentSock(churchId, sock)) {
                return;
            }

            if (qr) {
                const current = connectingInstances.get(churchId);
                if (current?.attemptId === attemptId) {
                    current.qrCode = qr;
                    current.qrCodeUpdatedAt = Date.now();
                    connectingInstances.set(churchId, current);
                    console.log(`QR Code updated for church ${churchId}`);
                }
            }

            if (connection === 'open') {
                const current = connectingInstances.get(churchId);
                if (current?.attemptId === attemptId) {
                    const derivedPhone = extractPhoneNumberFromUserId(sock.user?.id);
                    instances.set(churchId, {
                        sock,
                        phoneNumber: derivedPhone,
                        connectedSince: new Date().toISOString()
                    });
                    connectingInstances.delete(churchId);
                }
            } else if (connection === 'close') {
                const error = (lastDisconnect?.error as Boom)?.output?.statusCode;
                const shouldReconnect = error !== DisconnectReason.loggedOut;

                if (instances.get(churchId)?.sock === sock) {
                    instances.delete(churchId);
                }
                if (connectingInstances.get(churchId)?.sock === sock) {
                    connectingInstances.delete(churchId);
                }

                if (shouldReconnect) {
                    setTimeout(() => {
                        void connectInstance(churchId).catch(err => {
                            console.error(`Reconnect failed for church ${churchId}:`, err);
                        });
                    }, 5000);
                } else {
                    clearSession(churchId, sessionsDir);
                }
            }
        });

        const qrAvailable = !!getFreshQrCode(churchId);
        return { status: qrAvailable ? 'pending' : 'connecting', qrAvailable };
    });
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
        const data = connectingInstances.get(churchId);
        const qrAvailable = !!getFreshQrCode(churchId);
        return {
            churchId,
            status: 'connecting',
            startedAt: data?.startedAt,
            qrAvailable
        };
    }
    return { churchId, status: 'disconnected' };
}

export async function disconnectInstance(churchId: string) {
    return runExclusive(churchId, async () => {
        const connected = instances.get(churchId);
        if (connected) {
            try {
                connected.sock.logout();
            } catch { }
            destroySock(connected.sock, 'disconnect_requested');
            instances.delete(churchId);
        }

        const connecting = connectingInstances.get(churchId);
        if (connecting) {
            connectingInstances.delete(churchId);
            destroySock(connecting.sock, 'disconnect_requested');
        }

        await clearSession(churchId, getSessionsDir());
        return { status: 'disconnected', churchId };
    });
}

export async function sendIndividualMessage(churchId: string, to: string, message: string) {
    const data = instances.get(churchId);
    if (!data) {
        return { status: 'failed', reason: 'instance_disconnected', message: `A instância da igreja ${churchId} não está conectada` };
    }

    let jid: string;
    try {
        jid = normalizePhoneToJid(to).jid;
    } catch (error) {
        if (error instanceof PhoneValidationError) {
            return { status: 'failed', reason: error.code, message: error.message };
        }
        return { status: 'failed', reason: 'telefone_invalido', message: 'Telefone inválido.' };
    }

    try {
        try {
            const exists = await isOnWhatsApp(data.sock, jid);
            if (!exists) {
                return { status: 'failed', reason: 'numero_invalido', message: 'Número inválido ou inexistente no WhatsApp.' };
            }
        } catch (error) {
            console.warn('onWhatsApp verification failed, proceeding with send:', error);
        }

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

    for (let idx = 0; idx < messages.length; idx++) {
        const item = messages[idx];
        let jid: string;
        try {
            jid = normalizePhoneToJid(item.to).jid;
        } catch (error) {
            const reason = error instanceof PhoneValidationError ? error.code : 'telefone_invalido';
            results.push({ to: item.to, status: 'failed', failReason: reason });
            failed++;
            continue;
        }

        try {
            try {
                const exists = await isOnWhatsApp(sock, jid);
                if (!exists) {
                    results.push({ to: item.to, status: 'failed', failReason: 'numero_invalido' });
                    failed++;
                    continue;
                }
            } catch (error) {
                console.warn('onWhatsApp verification failed, proceeding with send:', error);
            }

            await sock.sendMessage(jid, { text: item.message });
            results.push({ to: item.to, status: 'sent', failReason: null });
            sent++;
        } catch (error: any) {
            results.push({ to: item.to, status: 'failed', failReason: error.message });
            failed++;
        } finally {
            // Random delay between 15s and 45s (only between actual send attempts)
            if (idx < messages.length - 1) {
                const randomDelay = Math.floor(Math.random() * (45000 - 15000 + 1)) + 15000;
                await delay(randomDelay);
            }
        }
    }

    return { total: messages.length, sent, failed, results };
}

export async function bootstrapInstancesFromSessions() {
    const sessionsDir = getSessionsDir();
    try {
        const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
        const churchIds = entries.filter(e => e.isDirectory()).map(e => e.name);

        for (const churchId of churchIds) {
            try {
                const { state } = await useCustomFileAuthState(churchId, sessionsDir);
                if (!state.creds.registered) continue;
                await connectInstance(churchId);
            } catch (error) {
                console.error(`Failed to bootstrap instance for church ${churchId}:`, error);
            }
        }
    } catch (error) {
        console.warn(`No sessions to bootstrap (dir=${sessionsDir})`, error);
    }
}
