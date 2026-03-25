import cron from 'node-cron';
import admin from 'firebase-admin';
import {
    db,
    listEnabledChurches,
    listPoolNumbers,
    updatePoolNumber,
    resetDailyMessageCounts,
    incrementNumberMessageCount
} from './firestore.js';
import { sendBatchText, getInstanceStatus } from './evolution.js';
import { selectSenderForChurch } from './pool.js';
import { buildAutoMessage, formatarLocal, resolveEventLocation } from './messageBuilder.js';

const DEFAULT_IDLE_DELAY_MINUTES = 5;
const DEFAULT_ACTIVE_DELAY_MINUTES = 1;
const DEFAULT_PENDING_BATCH_LIMIT = 10;
const DEFAULT_LOOKBACK_HOURS = 24;
const DEFAULT_ADVANCE_HOURS = 24;
const DEFAULT_SILENCE_START = '22:00';
const DEFAULT_SILENCE_END = '07:00';
const ELIGIBLE_ESCALA_STATUSES = new Set(['publicada', 'agendado']);

let monitorRunning = false;

function getTimeZone() {
    return process.env.TZ || 'America/Sao_Paulo';
}

function parsePositiveInt(raw: string | undefined, fallback: number, min = 1) {
    const parsed = Number.parseInt(raw || '', 10);
    if (!Number.isFinite(parsed) || parsed < min) return fallback;
    return parsed;
}

function getIdleDelayMinutes() {
    return parsePositiveInt(process.env.SCHEDULER_IDLE_DELAY_MINUTES, DEFAULT_IDLE_DELAY_MINUTES);
}

function getActiveDelayMinutes() {
    return parsePositiveInt(process.env.SCHEDULER_ACTIVE_DELAY_MINUTES, DEFAULT_ACTIVE_DELAY_MINUTES);
}

function getPendingBatchLimit() {
    return parsePositiveInt(process.env.SCHEDULER_PENDING_BATCH_LIMIT, DEFAULT_PENDING_BATCH_LIMIT);
}

function getLookbackHours() {
    return parsePositiveInt(process.env.SCHEDULER_LOOKBACK_HOURS, DEFAULT_LOOKBACK_HOURS);
}

function getCurrentMinutesInTimeZone(timeZone: string) {
    const formatter = new Intl.DateTimeFormat('pt-BR', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    });

    const parts = formatter.formatToParts(new Date());
    const hour = Number(parts.find(p => p.type === 'hour')?.value || '0');
    const minute = Number(parts.find(p => p.type === 'minute')?.value || '0');
    return hour * 60 + minute;
}

function parseMinutes(hhmm: string) {
    const [hStr, mStr] = (hhmm || '').split(':');
    const h = Number(hStr);
    const m = Number(mStr);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;
    return h * 60 + m;
}

function isInsideSilenceWindow(silenceStart: string, silenceEnd: string, timeZone: string) {
    const startMinutes = parseMinutes(silenceStart);
    const endMinutes = parseMinutes(silenceEnd);
    if (startMinutes === null || endMinutes === null) return false;

    const currentMinutes = getCurrentMinutesInTimeZone(timeZone);

    if (startMinutes < endMinutes) {
        return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
    }

    return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
}

function resolveAdvanceHours(config: { advanceType?: string; advanceValue?: number; advanceHours?: number }): number {
    if (config.advanceType && config.advanceValue != null) {
        if (config.advanceType === 'days') return config.advanceValue * 24;
        return config.advanceValue;
    }
    return config.advanceHours || DEFAULT_ADVANCE_HOURS;
}

function isInsideAdvanceWindow(cultDataHora: Date | null | undefined, advanceHours: number) {
    if (!cultDataHora || Number.isNaN(cultDataHora.getTime())) return false;
    const cultTimeMs = cultDataHora.getTime();
    const startMs = cultTimeMs - (advanceHours * 60 * 60 * 1000);
    const nowMs = Date.now();
    return nowMs >= startMs && nowMs <= cultTimeMs;
}

function parseIsoDate(value: unknown) {
    if (value && typeof value === 'object' && typeof (value as any).toDate === 'function') {
        const d = (value as any).toDate() as Date;
        return Number.isNaN(d.getTime()) ? null : d;
    }

    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value;
    }

    if (typeof value !== 'string' || !value.trim()) {
        return null;
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isEventInFuture(date: Date | null | undefined) {
    if (!date) return false;
    return date.getTime() > Date.now();
}

function getPhoneFromMember(member: FirebaseFirestore.DocumentData | null | undefined) {
    return String(member?.telefone || member?.phone || member?.celular || '').trim();
}

type PendingItem = {
    refs: FirebaseFirestore.DocumentReference[];
    to: string;
    message: string;
};

type FilterMode = 'createdAt' | 'createdAt+legacy';

export type BatchJobStats = {
    fetchedItems: number;
    eligibleItems: number;
    processedItems: number;
    filterMode: FilterMode;
};

type AdaptiveSchedulerConfig = {
    idleDelayMinutes: number;
    activeDelayMinutes: number;
};

type TimerHandle = ReturnType<typeof setTimeout>;

type AdaptiveLoopDeps = {
    executeBatchJob: () => Promise<BatchJobStats>;
    setTimer: (callback: () => void, delayMs: number) => TimerHandle;
    clearTimer: (timer: TimerHandle) => void;
    log: (message: string) => void;
    error: (message: string, error: unknown) => void;
};

type EscalaItemGroup = {
    churchId: string;
    escalaId: string;
    itemDocs: FirebaseFirestore.QueryDocumentSnapshot[];
};

function getAdaptiveSchedulerConfig(): AdaptiveSchedulerConfig {
    return {
        idleDelayMinutes: getIdleDelayMinutes(),
        activeDelayMinutes: getActiveDelayMinutes()
    };
}

export function getLookbackStartDate(now: Date, lookbackHours: number) {
    return new Date(now.getTime() - (lookbackHours * 60 * 60 * 1000));
}

export function parseItemDocumentPath(path: string) {
    const parts = path.split('/');
    if (parts.length !== 6) return null;
    if (parts[0] !== 'igrejas' || parts[2] !== 'escalas' || parts[4] !== 'items') return null;

    const churchId = String(parts[1] || '').trim();
    const escalaId = String(parts[3] || '').trim();
    const itemId = String(parts[5] || '').trim();
    if (!churchId || !escalaId || !itemId) return null;

    return { churchId, escalaId, itemId };
}

export async function listPendingNotificationItems(
    database: Pick<FirebaseFirestore.Firestore, 'collectionGroup'> | null,
    options?: {
        now?: Date;
        lookbackHours?: number;
        limit?: number;
    }
) {
    if (!database) return null;

    const now = options?.now || new Date();
    const lookbackHours = options?.lookbackHours ?? getLookbackHours();
    const limit = options?.limit ?? getPendingBatchLimit();
    const cutoff = admin.firestore.Timestamp.fromDate(getLookbackStartDate(now, lookbackHours));

    let primarySnapshot;
    try {
        primarySnapshot = await database.collectionGroup('items')
            .where('notificado', '==', false)
            .where('createdAt', '>=', cutoff)
            .limit(limit)
            .get();
    } catch (error: any) {
        const code = String(error?.code || error?.details || error?.message || 'unknown');
        if (code.includes('FAILED_PRECONDITION')) {
            console.error('[Scheduler] Missing Firestore index for pending items query (createdAt).');
        }
        throw error;
    }

    const docsByPath = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>();
    for (const itemDoc of primarySnapshot.docs) {
        docsByPath.set(itemDoc.ref.path, itemDoc);
    }

    let filterMode: FilterMode = 'createdAt';

    if (docsByPath.size < limit) {
        filterMode = 'createdAt+legacy';

        let legacySnapshot;
        try {
            legacySnapshot = await database.collectionGroup('items')
                .where('notificado', '==', false)
                .where('dataCulto', '>=', cutoff)
                .limit(limit - docsByPath.size)
                .get();
        } catch (error: any) {
            const code = String(error?.code || error?.details || error?.message || 'unknown');
            if (code.includes('FAILED_PRECONDITION')) {
                console.error('[Scheduler] Missing Firestore index for pending items legacy query (dataCulto).');
            }
            throw error;
        }

        for (const itemDoc of legacySnapshot.docs) {
            if (docsByPath.size >= limit) break;
            if (docsByPath.has(itemDoc.ref.path)) continue;
            if (parseIsoDate(itemDoc.data().createdAt)) continue;

            docsByPath.set(itemDoc.ref.path, itemDoc);
        }
    }

    const docs = Array.from(docsByPath.values()).slice(0, limit);

    return {
        docs,
        empty: docs.length === 0,
        size: docs.length,
        filterMode
    };
}

function groupItemsByEscala(items: FirebaseFirestore.QueryDocumentSnapshot[]) {
    const groups = new Map<string, EscalaItemGroup>();

    for (const itemDoc of items) {
        const parsed = parseItemDocumentPath(itemDoc.ref.path);
        if (!parsed) continue;

        const key = `${parsed.churchId}/${parsed.escalaId}`;
        let group = groups.get(key);
        if (!group) {
            group = {
                churchId: parsed.churchId,
                escalaId: parsed.escalaId,
                itemDocs: []
            };
            groups.set(key, group);
        }

        group.itemDocs.push(itemDoc);
    }

    return groups;
}

export function groupItemDocsByMember(itemDocs: FirebaseFirestore.QueryDocumentSnapshot[]) {
    const membroMap = new Map<string, FirebaseFirestore.QueryDocumentSnapshot[]>();

    for (const itemDoc of itemDocs) {
        const membroId = String(itemDoc.data().membroId || '').trim();
        if (!membroId) continue;

        if (!membroMap.has(membroId)) {
            membroMap.set(membroId, []);
        }

        membroMap.get(membroId)?.push(itemDoc);
    }

    return membroMap;
}

async function updateNotificationError(
    itemDocs: FirebaseFirestore.QueryDocumentSnapshot[],
    errorCode: 'sem_telefone' | 'send_error'
) {
    for (const itemDoc of itemDocs) {
        const item = itemDoc.data();
        if (item.notificadoErro !== errorCode) {
            await itemDoc.ref.update({ notificado: false, notificadoErro: errorCode });
        }
    }
}

export function createAdaptiveJobLoop(deps: AdaptiveLoopDeps, config: AdaptiveSchedulerConfig) {
    let started = false;
    let jobRunning = false;
    let timer: TimerHandle | null = null;

    function schedule(delayMinutes: number) {
        if (timer) {
            deps.clearTimer(timer);
        }

        timer = deps.setTimer(() => {
            void runOnce();
        }, delayMinutes * 60 * 1000);
    }

    async function runOnce() {
        if (jobRunning) {
            deps.log('Scheduled job already running; skipping this tick.');
            return config.activeDelayMinutes;
        }

        jobRunning = true;

        try {
            const stats = await deps.executeBatchJob();
            const nextDelayMinutes = stats.eligibleItems > 0
                ? config.activeDelayMinutes
                : config.idleDelayMinutes;

            if (stats.eligibleItems === 0) {
                deps.log(`Nenhum item elegível (fetched=${stats.fetchedItems}). Aguardando ${config.idleDelayMinutes} min...`);
            }

            deps.log(JSON.stringify({
                timestamp: new Date().toISOString(),
                event: 'scheduler_cycle_complete',
                ...stats,
                nextDelayMinutes
            }));

            schedule(nextDelayMinutes);
            return nextDelayMinutes;
        } catch (error) {
            deps.error('Error in batch job:', error);

            const nextDelayMinutes = config.idleDelayMinutes;
            deps.log(JSON.stringify({
                timestamp: new Date().toISOString(),
                event: 'scheduler_cycle_complete',
                fetchedItems: 0,
                eligibleItems: 0,
                processedItems: 0,
                filterMode: 'createdAt',
                nextDelayMinutes,
                failed: true
            }));

            schedule(nextDelayMinutes);
            return nextDelayMinutes;
        } finally {
            jobRunning = false;
        }
    }

    return {
        start() {
            if (started) return;
            started = true;
            void runOnce();
        },
        runOnce,
        isJobRunning() {
            return jobRunning;
        }
    };
}

export function startScheduler() {
    const timeZone = getTimeZone();
    const config = getAdaptiveSchedulerConfig();
    const pendingBatchLimit = getPendingBatchLimit();
    const lookbackHours = getLookbackHours();

    console.log(
        `Starting adaptive scheduler (idle=${config.idleDelayMinutes}m, active=${config.activeDelayMinutes}m, limit=${pendingBatchLimit}, lookback=${lookbackHours}h, tz="${timeZone}")`
    );

    createAdaptiveJobLoop({
        executeBatchJob: () => runBatchJob(),
        setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimer: timer => clearTimeout(timer),
        log: message => console.log(message),
        error: (message, error) => console.error(message, error)
    }, config).start();

    cron.schedule('*/15 * * * *', async () => {
        if (monitorRunning) return;
        monitorRunning = true;
        try {
            await monitorPool();
        } finally {
            monitorRunning = false;
        }
    }, { timezone: timeZone } as any);

    cron.schedule('0 0 * * *', async () => {
        try {
            console.log('Resetting daily message counts for pool numbers');
            await resetDailyMessageCounts();
        } catch (error) {
            console.error('Failed to reset daily message counts:', error);
        }
    }, { timezone: timeZone } as any);
}

async function monitorPool() {
    const numbers = await listPoolNumbers();
    for (const number of numbers) {
        try {
            const statusResult = await getInstanceStatus(number.instanceId);
            const isConnected = statusResult.status === 'connected';

            const updates: Record<string, unknown> = { status: isConnected ? 'connected' : 'disconnected' };

            if (isConnected && !number.connectedAt) {
                updates.connectedAt = new Date().toISOString();
            }

            if (statusResult.status !== number.status) {
                await updatePoolNumber(number.numberId, updates as any);
                console.log(JSON.stringify({
                    timestamp: new Date().toISOString(),
                    event: 'pool_status_changed',
                    numberId: number.numberId,
                    instanceId: number.instanceId,
                    from: number.status,
                    to: isConnected ? 'connected' : 'disconnected'
                }));
            }
        } catch (error) {
            console.error(`Failed to monitor pool number ${number.numberId}:`, error);
        }
    }
}

export async function runBatchJob() {
    if (!db) {
        return { fetchedItems: 0, eligibleItems: 0, processedItems: 0, filterMode: 'createdAt' as const };
    }

    const pendingItemsSnapshot = await listPendingNotificationItems(db);
    if (!pendingItemsSnapshot || pendingItemsSnapshot.empty) {
        return {
            fetchedItems: 0,
            eligibleItems: 0,
            processedItems: 0,
            filterMode: pendingItemsSnapshot?.filterMode || 'createdAt'
        };
    }

    const stats: BatchJobStats = {
        fetchedItems: pendingItemsSnapshot.size,
        eligibleItems: 0,
        processedItems: 0,
        filterMode: pendingItemsSnapshot.filterMode
    };

    const timeZone = getTimeZone();
    const churches = await listEnabledChurches();
    const churchMap = new Map(churches.map(church => [church.id, church]));
    const groupedItems = groupItemsByEscala(pendingItemsSnapshot.docs);
    const escalaCache = new Map<string, FirebaseFirestore.DocumentData | null>();
    const cultCache = new Map<string, FirebaseFirestore.DocumentData | null>();
    const memberCache = new Map<string, FirebaseFirestore.DocumentData | null>();

    for (const group of groupedItems.values()) {
        const church = churchMap.get(group.churchId);
        if (!church) {
            console.log(JSON.stringify({ timestamp: new Date().toISOString(), event: 'scheduler_skip_church_disabled', churchId: group.churchId, escalaId: group.escalaId }));
            for (const itemDoc of group.itemDocs) {
                const item = itemDoc.data();
                if (item.notificadoErro !== 'church_disabled') {
                    await itemDoc.ref.update({ notificado: true, notificadoErro: 'church_disabled' });
                }
            }
            continue;
        }

        const churchId = group.churchId;
        const churchData = church.data;
        const config = churchData?.whatsappAutomation || {};
        const silenceStart = config.silenceStart || DEFAULT_SILENCE_START;
        const silenceEnd = config.silenceEnd || DEFAULT_SILENCE_END;

        if (isInsideSilenceWindow(silenceStart, silenceEnd, timeZone)) {
            console.log(JSON.stringify({ timestamp: new Date().toISOString(), event: 'scheduler_skip_silence_window', churchId, escalaId: group.escalaId, silenceStart, silenceEnd }));
            continue;
        }

        const escalaKey = `${churchId}/${group.escalaId}`;
        let escala = escalaCache.get(escalaKey);
        if (escala === undefined) {
            const escalaDoc = await db.collection(`igrejas/${churchId}/escalas`).doc(group.escalaId).get();
            escala = escalaDoc.exists ? (escalaDoc.data() || null) : null;
            escalaCache.set(escalaKey, escala);
        }

        if (!escala) continue;
        if (!ELIGIBLE_ESCALA_STATUSES.has(String(escala.status || '').trim())) continue;

        const cultoId = String(escala.cultoId || '').trim();
        if (!cultoId) continue;

        const cultKey = `${churchId}/${cultoId}`;
        let culto = cultCache.get(cultKey);
        if (culto === undefined) {
            const cultoDoc = await db.collection(`igrejas/${churchId}/cultos`).doc(cultoId).get();
            culto = cultoDoc.exists ? (cultoDoc.data() || null) : null;
            cultCache.set(cultKey, culto);
        }

        if (!culto) continue;

        const dataHoraCulto = parseIsoDate(culto.data);
        if (!isEventInFuture(dataHoraCulto)) {
            console.log(JSON.stringify({ timestamp: new Date().toISOString(), event: 'scheduler_skip_evento_passado', churchId, escalaId: group.escalaId, cultoId, dataCulto: culto.data }));
            for (const itemDoc of group.itemDocs) {
                const item = itemDoc.data();
                if (item.notificadoErro !== 'evento_passado') {
                    await itemDoc.ref.update({ notificado: true, notificadoErro: 'evento_passado' });
                }
            }
            continue;
        }

        const advanceHours = resolveAdvanceHours(config);
        if (!isInsideAdvanceWindow(dataHoraCulto, advanceHours)) {
            console.log(JSON.stringify({ timestamp: new Date().toISOString(), event: 'scheduler_skip_advance_window', churchId, escalaId: group.escalaId, cultoId, advanceHours }));
            continue;
        }

        stats.eligibleItems += group.itemDocs.length;

        const nomeIgreja = churchData.nome || 'Igreja';
        const nomeCulto = culto.nome || escala.titulo || 'Culto';
        const nomeEscala = escala.titulo || nomeCulto;
        const location = resolveEventLocation(culto, churchData);

        const pendingItems: PendingItem[] = [];
        const membroMap = groupItemDocsByMember(group.itemDocs);

        for (const itemDoc of group.itemDocs) {
            const item = itemDoc.data();
            const membroId = String(item.membroId || '').trim();

            if (!membroId) {
                if (item.notificado !== true || item.notificadoErro !== 'sem_telefone') {
                    await itemDoc.ref.update({ notificado: true, notificadoErro: 'sem_telefone' });
                }
                continue;
            }
        }

        for (const [membroId, itemDocs] of membroMap.entries()) {
            const memberKey = `${churchId}/${membroId}`;
            let membro = memberCache.get(memberKey);
            if (membro === undefined) {
                const membroDoc = await db.collection(`igrejas/${churchId}/membros`).doc(membroId).get();
                membro = membroDoc.exists ? (membroDoc.data() || null) : null;
                memberCache.set(memberKey, membro);
            }

            const telefone = getPhoneFromMember(membro);
            if (!telefone) {
                for (const itemDoc of itemDocs) {
                    const item = itemDoc.data();
                    if (item.notificado !== true || item.notificadoErro !== 'sem_telefone') {
                        await itemDoc.ref.update({ notificado: true, notificadoErro: 'sem_telefone' });
                    }
                }
                continue;
            }

            const primeiroItemComToken = itemDocs.find(doc => String(doc.data().tokenId || '').trim());
            const tokenId = String(primeiroItemComToken?.data()?.tokenId || '').trim();
            if (!tokenId) {
                await updateNotificationError(itemDocs, 'send_error');
                continue;
            }

            const primeiroItem = itemDocs[0].data();
            const dataHoraMembro = parseIsoDate(primeiroItem.dataCulto) || dataHoraCulto;
            if (!dataHoraMembro) continue;

            const local = itemDocs
                .map(doc => formatarLocal(doc.data()))
                .filter(Boolean)
                .join(' | ');

            const msg = buildAutoMessage({
                nomeDoMembro: primeiroItem.membroNome || primeiroItem.nomeDoMembro || 'Membro',
                nomeIgreja,
                nomeCulto,
                nomeEscala,
                dataHoraCulto: dataHoraMembro,
                local,
                token: tokenId,
                location,
                segmento: churchData.segmento
            });

            pendingItems.push({
                refs: itemDocs.map(doc => doc.ref),
                to: telefone,
                message: msg
            });
        }

        if (pendingItems.length === 0) {
            console.log(JSON.stringify({ timestamp: new Date().toISOString(), event: 'scheduler_skip_no_recipients', churchId, escalaId: group.escalaId }));
            continue;
        }

        const sender = await selectSenderForChurch(churchId, pendingItems.length);
        if (!sender) {
            console.warn(JSON.stringify({
                timestamp: new Date().toISOString(),
                event: 'scheduler_no_sender',
                churchId,
                escalaId: group.escalaId,
                pendingItems: pendingItems.length
            }));
            continue;
        }

        try {
            const result = await sendBatchText(
                sender.instanceId,
                pendingItems.map(item => ({ to: item.to, message: item.message }))
            );

            for (let i = 0; i < pendingItems.length; i++) {
                const sendResult = result.results[i];
                const docRefs = pendingItems[i].refs;

                if (sendResult.status === 'sent') {
                    await incrementNumberMessageCount(sender.numberId);
                    for (const docRef of docRefs) {
                        await docRef.update({
                            notificado: true,
                            notificadoEm: admin.firestore.FieldValue.serverTimestamp(),
                            notificadoErro: null
                        });
                    }

                    stats.processedItems += docRefs.length;
                    continue;
                }

                const failReason = String(sendResult.failReason || '');
                const mappedError =
                    failReason === 'numero_invalido' || failReason === 'telefone_invalido'
                        ? 'numero_invalido'
                        : 'send_error';

                for (const docRef of docRefs) {
                    await docRef.update({ notificado: false, notificadoErro: mappedError });
                }
            }
        } catch (error) {
            console.error(`Error sending batch for church ${churchId} escala ${group.escalaId}:`, error);
        }
    }

    console.log(`[Scheduler] Processados ${stats.processedItems} itens (Filtro: ${stats.filterMode})`);

    return stats;
}





