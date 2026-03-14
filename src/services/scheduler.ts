import cron from 'node-cron';
import { db, listEnabledChurches } from './firestore.js';
import { sendBatchText } from './evolution.js';
import admin from 'firebase-admin';
import { syncChurchConnectionStatus } from './connection-sync.js';

const DEFAULT_INTERVAL_MINUTES = 60;
const DEFAULT_ADVANCE_HOURS = 24;
const DEFAULT_SILENCE_START = '22:00';
const DEFAULT_SILENCE_END = '07:00';

function getTimeZone() {
    return process.env.TZ || 'America/Sao_Paulo';
}

let jobRunning = false;

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

function capitalizeFirst(text: string) {
    if (!text) return text;
    return text.charAt(0).toUpperCase() + text.slice(1);
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

function isInsideAdvanceWindow(cultDataHora: Date | null | undefined, advanceHours: number) {
    if (!cultDataHora || Number.isNaN(cultDataHora.getTime())) return false;
    const cultTimeMs = cultDataHora.getTime();
    const startMs = cultTimeMs - (advanceHours * 60 * 60 * 1000);
    const nowMs = Date.now();
    return nowMs >= startMs && nowMs <= cultTimeMs;
}

function parseIsoDate(value: unknown) {
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value;
    }

    if (typeof value !== 'string' || !value.trim()) {
        return null;
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getPhoneFromMember(member: FirebaseFirestore.DocumentData | null | undefined) {
    return String(member?.telefone || member?.phone || member?.celular || '').trim();
}

type PendingItem = {
    refs: FirebaseFirestore.DocumentReference[];
    to: string;
    message: string;
};

function formatarLocal(item: FirebaseFirestore.DocumentData) {
    const setor = String(item?.setorNome || '').trim();
    const corredor = String(item?.corredorNome || '').trim();
    const funcao = String(item?.funcaoNaEscala || '').trim();

    if (corredor && corredor !== setor) {
        return `${setor} (${corredor})`;
    }

    if (setor) return setor;

    return funcao;
}

function formatAutoMessage(params: {
    nomeDoMembro: string;
    nomeIgreja: string;
    nomeCulto: string;
    nomeEscala: string;
    dataHoraCulto: Date;
    local: string;
    token: string;
    timeZone: string;
}) {
    const diaSemana = capitalizeFirst(params.dataHoraCulto.toLocaleDateString('pt-BR', { weekday: 'long', timeZone: params.timeZone }));
    const data = params.dataHoraCulto.toLocaleDateString('pt-BR', { timeZone: params.timeZone });
    const horario = params.dataHoraCulto.toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: params.timeZone
    });
    const linkConfirmacao = `https://unioescala.web.app/confirmar?token=${params.token}`;

    return `Olá, ${params.nomeDoMembro}.
Você está escalado(a) para:
${params.nomeIgreja}
🏢 Evento: ${params.nomeCulto}
📝 Escala: ${params.nomeEscala}
📅 Data: ${diaSemana}, ${data}
⏰ Horário: ${horario}
📍 Local: ${params.local}
✅ Confirme sua presença pelo link abaixo:
${linkConfirmacao}
Obrigado!`;
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
            console.log('Running scheduled job for WhatsApp automation');
            await runBatchJob();
        } finally {
            jobRunning = false;
        }
    }, { timezone: timeZone } as any);
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

            const syncResult = await syncChurchConnectionStatus(churchId, 'scheduler_job');

            if (syncResult.error) {
                console.error(`Failed to synchronize connection state for church ${churchId}: ${syncResult.error}`);
                continue;
            }

            if (syncResult.statusNovo !== true) {
                console.log(`Church ${churchId} disconnected. Job skipped.`);
                continue;
            }

            const advanceHours = config.advanceHours || DEFAULT_ADVANCE_HOURS;
            const silenceStart = config.silenceStart || DEFAULT_SILENCE_START;
            const silenceEnd = config.silenceEnd || DEFAULT_SILENCE_END;

            if (isInsideSilenceWindow(silenceStart, silenceEnd, timeZone)) {
                console.log(`Church ${churchId} in silence window.`);
                continue;
            }

            const escalasSnapshot = await db.collection(`igrejas/${churchId}/escalas`)
                .where('status', '==', 'publicada')
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
                if (!isInsideAdvanceWindow(dataHoraCulto, advanceHours)) continue;

                const itemsSnapshot = await db.collection(`igrejas/${churchId}/escalas/${escalaDoc.id}/items`)
                    .where('notificado', '==', false)
                    .get();

                if (itemsSnapshot.empty) continue;

                const nomeIgreja = churchData.nome || 'Igreja';
                const nomeCulto = culto.nome || escala.titulo || 'Culto';
                const nomeEscala = escala.titulo || nomeCulto;

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

                    const msg = formatAutoMessage({
                        nomeDoMembro: primeiroItem.membroNome || 'Membro',
                        nomeIgreja,
                        nomeCulto,
                        nomeEscala,
                        dataHoraCulto: dataHoraMembro,
                        local,
                        token: tokenId,
                        timeZone
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
                        churchId,
                        pendingItems.map(item => ({ to: item.to, message: item.message }))
                    );

                    for (let i = 0; i < pendingItems.length; i++) {
                        const sendResult = result.results[i];
                        const docRefs = pendingItems[i].refs;

                        if (sendResult.status === 'sent') {
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
                            await docRef.update({
                                notificado: false,
                                notificadoErro: mappedError
                            });
                        }
                    }
                } catch (error) {
                    console.error(`Error sending batch for church ${churchId} escala ${escalaDoc.id}`, error);
                }
            }
        }
    } catch (error) {
        console.error('Error in batch job:', error);
    }
}
