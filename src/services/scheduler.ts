import cron from 'node-cron';
import admin from 'firebase-admin';
import { db, listEnabledChurches, listPoolNumbers, updatePoolNumber, resetDailyMessageCounts, incrementNumberMessageCount } from './firestore.js';
import { sendBatchText, getInstanceStatus } from './evolution.js';
import { selectSenderForChurch } from './pool.js';
import { buildAutoMessage, formatarLocal, resolveEventLocation } from './messageBuilder.js';

const DEFAULT_INTERVAL_MINUTES = 60;
const DEFAULT_ADVANCE_HOURS = 24;
const DEFAULT_SILENCE_START = '22:00';
const DEFAULT_SILENCE_END = '07:00';

function getTimeZone() {
    return process.env.TZ || 'America/Sao_Paulo';
}

let jobRunning = false;
let monitorRunning = false;

function parseIntervalMinutes(raw: string | undefined) {
    const parsed = Number.parseInt(raw || '', 10);
    if (!Number.isFinite(parsed)) return DEFAULT_INTERVAL_MINUTES;
    if (parsed === 60) return 60;
    if (parsed >= 1 && parsed <= 59) return parsed;
    return DEFAULT_INTERVAL_MINUTES;
}

function toCronExpression(intervalMinutes: number) {
    if (intervalMinutes === 60) return '0 * * * *';
    return `*/${intervalMinutes} * * * *`;
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
    // backward compat: old advanceHours field
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
    // Firestore Timestamp object
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

export function startScheduler() {
    const intervalMinutes = parseIntervalMinutes(process.env.SCHEDULER_INTERVAL);
    const expression = toCronExpression(intervalMinutes);
    const timeZone = getTimeZone();

    console.log(`Starting scheduler with interval of ${intervalMinutes} minutes (cron="${expression}", tz="${timeZone}")`);

    cron.schedule(expression, async () => {
        if (jobRunning) {
            console.log('Scheduled job already running; skipping this tick.');
            return;
        }
        jobRunning = true;
        try {
            await runBatchJob();
        } finally {
            jobRunning = false;
        }
    }, { timezone: timeZone } as any);

    // Pool health monitor — every 15 minutes
    cron.schedule('*/15 * * * *', async () => {
        if (monitorRunning) return;
        monitorRunning = true;
        try {
            await monitorPool();
        } finally {
            monitorRunning = false;
        }
    }, { timezone: timeZone } as any);

    // Daily message counter reset — midnight
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

async function runBatchJob() {
    if (!db) return;

    try {
        const timeZone = getTimeZone();
        const churches = await listEnabledChurches();

        for (const church of churches) {
            const churchId = church.id;
            const churchData = church.data;
            const config = churchData?.whatsappAutomation || {};
            const cultCache = new Map<string, FirebaseFirestore.DocumentData | null>();
            const memberCache = new Map<string, FirebaseFirestore.DocumentData | null>();

            const silenceStart = config.silenceStart || DEFAULT_SILENCE_START;
            const silenceEnd = config.silenceEnd || DEFAULT_SILENCE_END;

            if (isInsideSilenceWindow(silenceStart, silenceEnd, timeZone)) {
                console.log(`Church ${churchId} in silence window. Skipping.`);
                continue;
            }

            const advanceHours = resolveAdvanceHours(config);

            const escalasSnapshot = await db.collection(`igrejas/${churchId}/escalas`)
                .where('status', 'in', ['publicada', 'agendado'])
                .get();

            for (const escalaDoc of escalasSnapshot.docs) {
                const escala = escalaDoc.data();
                const cultoId = String(escala.cultoId || '').trim();

                if (!cultoId) continue;

                let culto = cultCache.get(cultoId);
                if (culto === undefined) {
                    const cultoDoc = await db.collection(`igrejas/${churchId}/cultos`).doc(cultoId).get();
                    culto = cultoDoc.exists ? (cultoDoc.data() || null) : null;
                    cultCache.set(cultoId, culto);
                }

                if (!culto) continue;

                const dataHoraCulto = parseIsoDate(culto.data);

                // Rejeitar eventos passados
                if (!isEventInFuture(dataHoraCulto)) continue;

                // Verificar janela de antecedência
                if (!isInsideAdvanceWindow(dataHoraCulto, advanceHours)) continue;

                const itemsSnapshot = await db.collection(`igrejas/${churchId}/escalas/${escalaDoc.id}/items`)
                    .where('notificado', '==', false)
                    .get();

                if (itemsSnapshot.empty) continue;

                // Select a pool number for this batch
                const sender = await selectSenderForChurch(churchId);
                if (!sender) {
                    console.warn(JSON.stringify({
                        timestamp: new Date().toISOString(),
                        event: 'scheduler_no_sender',
                        churchId,
                        escalaId: escalaDoc.id
                    }));
                    continue;
                }

                const nomeIgreja = churchData.nome || 'Igreja';
                const nomeCulto = culto.nome || escala.titulo || 'Culto';
                const nomeEscala = escala.titulo || nomeCulto;
                const location = resolveEventLocation(culto, churchData);

                const pendingItems: PendingItem[] = [];
                const membroMap = new Map<string, FirebaseFirestore.QueryDocumentSnapshot[]>();

                for (const itemDoc of itemsSnapshot.docs) {
                    const item = itemDoc.data();
                    const membroId = String(item.membroId || '').trim();

                    if (!membroId) {
                        if (item.notificadoErro !== 'sem_telefone') {
                            await itemDoc.ref.update({ notificado: false, notificadoErro: 'sem_telefone' });
                        }
                        continue;
                    }

                    if (!membroMap.has(membroId)) {
                        membroMap.set(membroId, []);
                    }
                    membroMap.get(membroId)?.push(itemDoc);
                }

                for (const [membroId, itemDocs] of membroMap.entries()) {
                    let membro = memberCache.get(membroId);
                    if (membro === undefined) {
                        const membroDoc = await db.collection(`igrejas/${churchId}/membros`).doc(membroId).get();
                        membro = membroDoc.exists ? (membroDoc.data() || null) : null;
                        memberCache.set(membroId, membro);
                    }

                    const telefone = getPhoneFromMember(membro);
                    if (!telefone) {
                        await updateNotificationError(itemDocs, 'sem_telefone');
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
                        location
                    });

                    pendingItems.push({
                        refs: itemDocs.map(doc => doc.ref),
                        to: telefone,
                        message: msg
                    });
                }

                if (pendingItems.length === 0) continue;

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
                    console.error(`Error sending batch for church ${churchId} escala ${escalaDoc.id}:`, error);
                }
            }
        }
    } catch (error) {
        console.error('Error in batch job:', error);
    }
}
