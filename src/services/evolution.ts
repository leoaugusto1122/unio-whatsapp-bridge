import { normalizePhoneDigits, PhoneValidationError } from '../utils/phone.js';

const DEFAULT_BATCH_MIN_DELAY_MS = 15_000;
const DEFAULT_BATCH_MAX_DELAY_MS = 45_000;

type ConnectionStatePayload = {
    instance?: {
        state?: string;
        status?: string;
    };
    state?: string;
    status?: string;
};

type EvolutionRequestOptions = {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: unknown;
};

type SendResult = {
    to: string;
    status: 'sent' | 'failed';
    failReason: string | null;
    message?: string;
    timestamp?: string;
};

export type CreateInstanceResult = {
    instanceId: string;
    qrCode: string | null;
    qrCodeExpiry: number;
};

class EvolutionApiError extends Error {
    readonly statusCode: number;
    readonly payload: unknown;

    constructor(statusCode: number, payload: unknown, message: string) {
        super(message);
        this.name = 'EvolutionApiError';
        this.statusCode = statusCode;
        this.payload = payload;
    }
}

function getRequiredEnv(name: string) {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

function getBaseUrl() {
    return getRequiredEnv('EVOLUTION_BASE_URL').replace(/\/+$/, '');
}

function getApiKey() {
    return getRequiredEnv('EVOLUTION_API_KEY');
}

async function parseResponseBody(response: Response) {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
        try {
            return await response.json();
        } catch {
            return null;
        }
    }

    try {
        return await response.text();
    } catch {
        return null;
    }
}

function getPayloadMessage(payload: unknown) {
    if (!payload) return '';
    if (typeof payload === 'string') return payload;
    if (typeof payload !== 'object') return String(payload);

    const candidates = [
        (payload as any).message,
        (payload as any).error,
        (payload as any).response?.message,
        (payload as any).response?.error,
        (payload as any).details
    ];

    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
            return candidate;
        }
    }

    try {
        return JSON.stringify(payload);
    } catch {
        return String(payload);
    }
}

async function evolutionRequest<T>(path: string, options: EvolutionRequestOptions = {}) {
    const response = await fetch(`${getBaseUrl()}${path}`, {
        method: options.method || 'GET',
        headers: {
            apikey: getApiKey(),
            'Content-Type': 'application/json'
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });

    const payload = await parseResponseBody(response);
    if (!response.ok) {
        throw new EvolutionApiError(
            response.status,
            payload,
            `Evolution API request failed (${response.status}): ${getPayloadMessage(payload) || response.statusText}`
        );
    }

    return payload as T;
}

function parseConnectionState(payload: ConnectionStatePayload | null | undefined) {
    return payload?.instance?.state || payload?.state || payload?.instance?.status || payload?.status;
}

function inferFailureReason(error: unknown): 'numero_invalido' | 'send_error' {
    const message = getPayloadMessage(error instanceof EvolutionApiError ? error.payload : error).toLowerCase();
    const invalidNumberMarkers = ['invalid', 'invalido', 'numero', 'phone', 'jid', 'exists', 'not exist'];

    if (invalidNumberMarkers.some(marker => message.includes(marker))) {
        return 'numero_invalido';
    }

    return 'send_error';
}

function randomDelay() {
    return Math.floor(Math.random() * (DEFAULT_BATCH_MAX_DELAY_MS - DEFAULT_BATCH_MIN_DELAY_MS + 1)) + DEFAULT_BATCH_MIN_DELAY_MS;
}

function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function validateEvolutionConfig() {
    getBaseUrl();
    getApiKey();
}

export async function getInstanceStatus(instanceName: string) {
    const payload = await evolutionRequest<ConnectionStatePayload>(`/instance/connectionState/${encodeURIComponent(instanceName)}`);
    const state = parseConnectionState(payload);

    return {
        instanceName,
        status: state === 'open' ? 'connected' as const : 'disconnected' as const,
        state,
        connectedSince: null as string | null
    };
}

export async function createInstance(instanceName: string): Promise<CreateInstanceResult> {
    const payload = await evolutionRequest<any>('/instance/create', {
        method: 'POST',
        body: {
            instanceName,
            qrcode: true,
            integration: 'WHATSAPP-BAILEYS'
        }
    });

    const qrCode = payload?.qrcode?.base64 || payload?.base64 || null;

    return {
        instanceId: instanceName,
        qrCode,
        qrCodeExpiry: 60
    };
}

export async function getQRCode(instanceName: string): Promise<{ qrCode: string | null; qrCodeExpiry: number }> {
    const payload = await evolutionRequest<any>(`/instance/connect/${encodeURIComponent(instanceName)}`);
    const qrCode = payload?.base64 || payload?.qrcode?.base64 || null;

    return {
        qrCode,
        qrCodeExpiry: 60
    };
}

export async function deleteInstance(instanceName: string): Promise<void> {
    await evolutionRequest(`/instance/delete/${encodeURIComponent(instanceName)}`, {
        method: 'DELETE'
    });
}

export async function checkNumberOnWhatsApp(instanceName: string, phone: string): Promise<boolean> {
    try {
        const number = normalizePhoneDigits(phone);
        const payload = await evolutionRequest<any>(`/chat/whatsappNumbers/${encodeURIComponent(instanceName)}`, {
            method: 'POST',
            body: { numbers: [number] }
        });

        const results: any[] = Array.isArray(payload) ? payload : (payload?.data || []);
        const entry = results.find((r: any) => r.exists !== undefined);
        return entry?.exists === true;
    } catch {
        return true; // on error assume exists to avoid silent drops
    }
}

export async function sendText(instanceName: string, to: string, message: string): Promise<SendResult> {
    let number: string;
    try {
        number = normalizePhoneDigits(to);
    } catch (error) {
        if (error instanceof PhoneValidationError) {
            return { to, status: 'failed', failReason: error.code, message: error.message };
        }
        return { to, status: 'failed', failReason: 'telefone_invalido', message: 'Telefone invalido.' };
    }

    try {
        await evolutionRequest(`/message/sendText/${encodeURIComponent(instanceName)}`, {
            method: 'POST',
            body: {
                number,
                textMessage: {
                    text: message
                }
            }
        });

        return {
            to: number,
            status: 'sent',
            failReason: null,
            timestamp: new Date().toISOString()
        };
    } catch (error) {
        return {
            to: number,
            status: 'failed',
            failReason: inferFailureReason(error),
            message: error instanceof Error ? error.message : 'Evolution API send failure'
        };
    }
}

export async function sendBatchText(instanceName: string, messages: { to: string; message: string; }[]) {
    const results: SendResult[] = [];
    let sent = 0;
    let failed = 0;

    for (let idx = 0; idx < messages.length; idx++) {
        const item = messages[idx];
        const result = await sendText(instanceName, item.to, item.message);
        results.push(result);

        if (result.status === 'sent') {
            sent++;
        } else {
            failed++;
        }

        if (idx < messages.length - 1) {
            await delay(randomDelay());
        }
    }

    return {
        total: messages.length,
        sent,
        failed,
        results
    };
}
