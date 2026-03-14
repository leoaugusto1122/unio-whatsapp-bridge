import cron from 'node-cron';
import { getInstanceStatus } from './evolution.js';
import {
    getChurchWhatsappAutomation,
    listEnabledChurches,
    updateChurchWhatsappConnected
} from './firestore.js';

export type SyncOrigin = 'config_screen' | 'scheduler_job' | 'periodic_job';

type SyncResult = {
    churchId: string;
    statusAnterior: boolean | null;
    statusNovo: boolean | null;
    updated: boolean;
    origin: SyncOrigin;
    error?: string;
};

type RetryOptions = {
    attempts: number;
    initialDelayMs: number;
};

const DEFAULT_SYNC_PERIODIC_JOB_CRON = '0 * * * *';
const DEFAULT_RETRY_OPTIONS: RetryOptions = {
    attempts: 3,
    initialDelayMs: 500
};

let periodicSyncRunning = false;

function logSync(payload: Record<string, unknown>) {
    console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        ...payload
    }));
}

function isPeriodicSyncEnabled() {
    return String(process.env.SYNC_PERIODIC_JOB_ENABLED || '').trim().toLowerCase() === 'true';
}

function getPeriodicSyncCron() {
    return process.env.SYNC_PERIODIC_JOB_CRON?.trim() || DEFAULT_SYNC_PERIODIC_JOB_CRON;
}

function wait(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry<T>(task: () => Promise<T>, retryOptions: RetryOptions) {
    let lastError: unknown;

    for (let attempt = 1; attempt <= retryOptions.attempts; attempt++) {
        try {
            return await task();
        } catch (error) {
            lastError = error;
            if (attempt >= retryOptions.attempts) {
                throw error;
            }

            const delayMs = retryOptions.initialDelayMs * (2 ** (attempt - 1));
            await wait(delayMs);
        }
    }

    throw lastError;
}

export async function syncChurchConnectionStatus(
    churchId: string,
    origin: SyncOrigin,
    retryOptions?: RetryOptions
): Promise<SyncResult> {
    const automation = await getChurchWhatsappAutomation(churchId);
    const statusAnterior = typeof automation?.connected === 'boolean' ? automation.connected : null;

    logSync({
        event: 'connection_sync_check',
        churchId,
        statusAnterior,
        statusNovo: statusAnterior,
        origin
    });

    let status;
    try {
        const readStatus = () => getInstanceStatus(churchId);
        status = retryOptions ? await withRetry(readStatus, retryOptions) : await readStatus();
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown Evolution API error';
        logSync({
            event: 'connection_sync_error',
            churchId,
            statusAnterior,
            statusNovo: statusAnterior,
            origin,
            error: message
        });

        return {
            churchId,
            statusAnterior,
            statusNovo: statusAnterior,
            updated: false,
            origin,
            error: message
        };
    }

    const statusNovo = status.status === 'connected';
    if (statusAnterior === statusNovo) {
        logSync({
            event: 'connection_sync_noop',
            churchId,
            statusAnterior,
            statusNovo,
            origin
        });

        return {
            churchId,
            statusAnterior,
            statusNovo,
            updated: false,
            origin
        };
    }

    try {
        await updateChurchWhatsappConnected(churchId, statusNovo);
        logSync({
            event: 'connection_sync_updated',
            churchId,
            statusAnterior,
            statusNovo,
            origin
        });

        return {
            churchId,
            statusAnterior,
            statusNovo,
            updated: true,
            origin
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown Firestore update error';
        logSync({
            event: 'connection_sync_update_error',
            churchId,
            statusAnterior,
            statusNovo,
            origin,
            error: message
        });

        return {
            churchId,
            statusAnterior,
            statusNovo,
            updated: false,
            origin,
            error: message
        };
    }
}

export async function syncEnabledChurchesConnectionStatus(origin: SyncOrigin = 'periodic_job') {
    const churches = await listEnabledChurches();
    const results: SyncResult[] = [];

    for (const church of churches) {
        const result = await syncChurchConnectionStatus(church.id, origin, DEFAULT_RETRY_OPTIONS);
        results.push(result);
    }

    logSync({
        event: 'connection_sync_batch_complete',
        churchCount: churches.length,
        updatedCount: results.filter(result => result.updated).length,
        errorCount: results.filter(result => Boolean(result.error)).length,
        origin
    });

    return results;
}

export function startPeriodicConnectionStatusSyncJob() {
    if (!isPeriodicSyncEnabled()) {
        return;
    }

    const cronExpression = getPeriodicSyncCron();
    const timeZone = process.env.TZ || 'America/Sao_Paulo';

    console.log(`Starting periodic connection sync job (cron="${cronExpression}", tz="${timeZone}")`);

    cron.schedule(cronExpression, async () => {
        if (periodicSyncRunning) {
            console.log('Periodic connection sync already running; skipping this tick.');
            return;
        }

        periodicSyncRunning = true;
        try {
            await syncEnabledChurchesConnectionStatus('periodic_job');
        } finally {
            periodicSyncRunning = false;
        }
    }, { timezone: timeZone } as any);
}
