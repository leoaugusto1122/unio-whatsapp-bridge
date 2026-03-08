import { makeWASocket, Browsers, DisconnectReason, WASocket } from 'baileys';
import { useCustomFileAuthState, clearSession } from './session.js';
import path from 'path';
import { fileURLToPath } from 'url';
import pino from 'pino';
import type { Boom } from '@hapi/boom';
import QRCode from 'qrcode';
import fs from 'fs/promises';
import { normalizePhoneToJid, PhoneValidationError } from '../utils/phone.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_SESSIONS_DIR = path.join(__dirname, '../../sessions');
function getSessionsDir() {
    return process.env.SESSIONS_DIR || DEFAULT_SESSIONS_DIR;
}

const PAIRING_CODE_TTL_MS = 60_000; // ~60 segundos (janela de validade do código)
const PAIRING_CODE_RETRY_COOLDOWN_MS = 5_000; // evita rajadas de requestPairingCode em sequência
const PAIRING_CODE_TIMEOUT = PAIRING_CODE_TTL_MS; // tempo máximo para gerar o primeiro código nesta chamada

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
    phoneNumber?: string;
    sessionsDir: string;
    startedAt: string;
    attemptId: string;
    pairingCode?: string;
    pairingCodeExpiresAt?: string;
    pairingCodeRequestInFlight: boolean;
    pairingCodeLastRequestedAt?: number;
    pairingCodeRefreshTimer?: ReturnType<typeof setTimeout>;
    qr?: string;
    qrPngBase64?: string;
    qrUpdatedAt?: string;
}

type ConnectOptions = {
    /**
     * When an instance is already "connecting":
     * - "return": keep existing attempt & return { status: 'connecting' }
     * - "reset": destroy socket, wipe session dir, start a fresh connection
     */
    ifConnecting?: 'return' | 'reset';
    /**
     * Internal option used by reconnect logic to avoid churning pairing codes.
     */
    preservePairing?: Pick<ConnectingInstanceData, 'pairingCode' | 'pairingCodeExpiresAt'>;
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
    if (connecting.pairingCodeRefreshTimer) {
        clearTimeout(connecting.pairingCodeRefreshTimer);
    }
    destroySock(connecting.sock, 'connecting_instance_reset');
    await clearSession(churchId, connecting.sessionsDir);
    return true;
}

function makeAttemptId() {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function toQrPngBase64(qr: string) {
    if (!qr) return null;
    if (qr.startsWith('data:image/')) {
        const idx = qr.indexOf(',');
        if (idx >= 0) return qr.slice(idx + 1);
        return null;
    }

    const dataUrl = await QRCode.toDataURL(qr, {
        type: 'image/png',
        margin: 1,
        scale: 6,
        errorCorrectionLevel: 'M'
    });
    const idx = dataUrl.indexOf(',');
    if (idx < 0) return null;
    return dataUrl.slice(idx + 1);
}

function getPairingExpiresInSeconds(expiresAt?: string) {
    if (!expiresAt) return null;
    const ms = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(ms)) return null;
    if (ms <= 0) return 0;
    return Math.max(1, Math.ceil(ms / 1000));
}

export async function connectInstance(churchId: string, phoneNumber?: string, options: ConnectOptions = {}) {
    return runExclusive(churchId, async () => {
        if (instances.has(churchId)) {
            const data = instances.get(churchId);
            return { status: 'connected', phoneNumber: data?.phoneNumber };
        }

        const ifConnecting = options.ifConnecting ?? 'return';
        if (connectingInstances.has(churchId)) {
            const current = connectingInstances.get(churchId);
            if (current && phoneNumber && !current.phoneNumber) {
                current.phoneNumber = phoneNumber;
                connectingInstances.set(churchId, current);
            }
            const expiresIn = getPairingExpiresInSeconds(current?.pairingCodeExpiresAt);
            if (current?.pairingCode && expiresIn && expiresIn > 0) {
                return { status: 'pending', pairingCode: current.pairingCode, expiresIn };
            }
            if (ifConnecting === 'reset') {
                await resetConnectingInstance(churchId);
            } else {
                return { status: 'connecting', phoneNumber: connectingInstances.get(churchId)?.phoneNumber };
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
        const preservedPairing = options.preservePairing;
        connectingInstances.set(churchId, {
            sock,
            phoneNumber,
            sessionsDir,
            startedAt: new Date().toISOString(),
            attemptId,
            pairingCode: preservedPairing?.pairingCode,
            pairingCodeExpiresAt: preservedPairing?.pairingCodeExpiresAt,
            pairingCodeRequestInFlight: false,
            pairingCodeLastRequestedAt: preservedPairing?.pairingCode ? Date.now() : undefined,
            pairingCodeRefreshTimer: undefined,
            qr: undefined,
            qrPngBase64: undefined,
            qrUpdatedAt: undefined
        });

        const needsPairing = !sock.authState.creds.registered;
        let pairingCodeResolve: ((code: string) => void) | null = null;
        const pairingCodePromise = needsPairing
            ? new Promise<string>((resolve, reject) => {
                pairingCodeResolve = resolve;
            })
            : null;

        sock.ev.on('creds.update', saveCreds);

        const maybeRequestPairingCode = async (update: any) => {
            if (!needsPairing || !phoneNumber) return;

            const current = connectingInstances.get(churchId);
            if (!current || current.attemptId !== attemptId) return;

            const expiresIn = getPairingExpiresInSeconds(current.pairingCodeExpiresAt);
            if (current.pairingCode && expiresIn && expiresIn > 0) {
                pairingCodeResolve?.(current.pairingCode);
                return;
            }

            if (current.pairingCodeRequestInFlight) return;

            const now = Date.now();
            if (current.pairingCodeLastRequestedAt && (now - current.pairingCodeLastRequestedAt) < PAIRING_CODE_RETRY_COOLDOWN_MS) {
                return;
            }

            // requestPairingCode requires an open WS connection; avoid calling too early (causes "Connection Closed")
            if (!sock.ws?.isOpen) return;

            const { connection } = update as { connection?: string };
            const qr = update?.qr as string | undefined;
            if (connection !== 'connecting' && !qr) return;

            current.pairingCodeRequestInFlight = true;
            current.pairingCodeLastRequestedAt = now;
            connectingInstances.set(churchId, current);
            try {
                console.log('Requesting pairing code for number:', phoneNumber);
                const code = await sock.requestPairingCode(phoneNumber);
                console.log('Pairing code generated:', code);

                current.pairingCode = code;
                current.pairingCodeExpiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS).toISOString();
                current.pairingCodeRequestInFlight = false;

                if (current.pairingCodeRefreshTimer) {
                    clearTimeout(current.pairingCodeRefreshTimer);
                }
                const refreshInMs = Math.max(1_000, Date.parse(current.pairingCodeExpiresAt) - Date.now() + 250);
                current.pairingCodeRefreshTimer = setTimeout(() => {
                    const latest = connectingInstances.get(churchId);
                    if (!latest || latest.attemptId !== attemptId) return;
                    void maybeRequestPairingCode({ connection: 'connecting' });
                }, refreshInMs);

                connectingInstances.set(churchId, current);

                pairingCodeResolve?.(code);
            } catch (err) {
                console.error('Pairing code error:', err);
                current.pairingCodeRequestInFlight = false;
                connectingInstances.set(churchId, current);
                // never allow errors to escape the event handler; keep waiting for another attempt
            }
        };

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;

            if (!isCurrentSock(churchId, sock)) {
                return;
            }

            if (typeof update?.qr === 'string' && update.qr) {
                const qr = update.qr;
                const current = connectingInstances.get(churchId);
                if (current?.attemptId === attemptId && current.qr !== qr) {
                    current.qr = qr;
                    current.qrUpdatedAt = new Date().toISOString();
                    current.qrPngBase64 = undefined;
                    connectingInstances.set(churchId, current);

                    void (async () => {
                        try {
                            const pngBase64 = await toQrPngBase64(qr);
                            if (!pngBase64) return;

                            const latest = connectingInstances.get(churchId);
                            if (!latest || latest.attemptId !== attemptId) return;
                            if (latest.qr !== qr) return;

                            latest.qrPngBase64 = pngBase64;
                            connectingInstances.set(churchId, latest);
                        } catch (error) {
                            console.warn('Failed to generate QR PNG base64:', error);
                        }
                    })();
                }
            }

            void maybeRequestPairingCode(update);

            if (connection === 'open') {
                const current = connectingInstances.get(churchId);
                if (current?.attemptId === attemptId) {
                    if (current.pairingCodeRefreshTimer) {
                        clearTimeout(current.pairingCodeRefreshTimer);
                    }
                    instances.set(churchId, {
                        sock,
                        phoneNumber: current.phoneNumber,
                        connectedSince: new Date().toISOString()
                    });
                    connectingInstances.delete(churchId);
                }
            } else if (connection === 'close') {
                const error = (lastDisconnect?.error as Boom)?.output?.statusCode;
                const shouldReconnect = error !== DisconnectReason.loggedOut;

                const preservedPairing = (() => {
                    const current = connectingInstances.get(churchId);
                    if (!current || current.attemptId !== attemptId) return undefined;
                    const expiresIn = getPairingExpiresInSeconds(current.pairingCodeExpiresAt);
                    if (!current.pairingCode || !expiresIn || expiresIn <= 0) return undefined;
                    return { pairingCode: current.pairingCode, pairingCodeExpiresAt: current.pairingCodeExpiresAt };
                })();

                if (instances.get(churchId)?.sock === sock) {
                    instances.delete(churchId);
                }
                if (connectingInstances.get(churchId)?.sock === sock) {
                    const current = connectingInstances.get(churchId);
                    connectingInstances.delete(churchId);
                    if (current?.pairingCodeRefreshTimer) {
                        clearTimeout(current.pairingCodeRefreshTimer);
                    }
                }

                if (shouldReconnect) {
                    setTimeout(() => {
                        void connectInstance(churchId, phoneNumber, { preservePairing: preservedPairing }).catch(err => {
                            console.error(`Reconnect failed for church ${churchId}:`, err);
                        });
                    }, 5000);
                } else {
                    clearSession(churchId, sessionsDir);
                }
            }
        });

        // Some environments emit "connecting" updates before WS is actually open.
        // Trigger another attempt when the underlying WS opens.
        sock.ws.on('open', () => {
            if (!isCurrentSock(churchId, sock)) return;
            void maybeRequestPairingCode({ connection: 'connecting' });
        });

        if (!sock.authState.creds.registered) {
            if (!phoneNumber) {
                // QR mode: keep socket alive and let the client fetch the QR via /instance/qrcode/:churchId
                return { status: 'connecting', phoneNumber };
            }

            try {
                const code = await Promise.race([
                    pairingCodePromise!,
                    new Promise<string>((_, reject) => setTimeout(() => reject(new Error('pairing_code_timeout')), PAIRING_CODE_TIMEOUT))
                ]);
                const current = connectingInstances.get(churchId);
                const expiresIn = getPairingExpiresInSeconds(current?.pairingCodeExpiresAt) ?? 60;
                return { status: 'pending', pairingCode: code, expiresIn };
            } catch (error) {
                console.error('Pairing code wait error (non-fatal):', error);
                // Keep the socket alive; the code may be generated later and can be polled via /instance/status
                return { status: 'connecting', phoneNumber };
            }
        }

        return { status: 'connecting', phoneNumber };
    });
}

export async function getInstanceQrCode(churchId: string) {
    if (instances.has(churchId)) {
        return { churchId, status: 'connected' as const };
    }

    const data = connectingInstances.get(churchId);
    if (!data) {
        return { churchId, status: 'disconnected' as const };
    }

    if (!data.qr) {
        return { churchId, status: 'connecting' as const, qrPngBase64: undefined as string | undefined, qrUpdatedAt: data.qrUpdatedAt };
    }

    if (!data.qrPngBase64) {
        try {
            const pngBase64 = await toQrPngBase64(data.qr);
            if (pngBase64) {
                data.qrPngBase64 = pngBase64;
                connectingInstances.set(churchId, data);
            }
        } catch (error) {
            console.warn('Failed to generate QR PNG base64 (on-demand):', error);
        }
    }

    return {
        churchId,
        status: 'connecting' as const,
        qrPngBase64: data.qrPngBase64,
        qrUpdatedAt: data.qrUpdatedAt
    };
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
        const pairingCode = data?.pairingCodeExpiresAt && Date.parse(data.pairingCodeExpiresAt) > Date.now()
            ? data?.pairingCode
            : undefined;

        return {
            churchId,
            status: 'connecting',
            phoneNumber: data?.phoneNumber,
            startedAt: data?.startedAt,
            pairingCode,
            pairingCodeExpiresAt: data?.pairingCodeExpiresAt
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
