import cron from 'node-cron';
import { db } from './firestore.js';
import { getInstanceStatus, sendBatchText } from './evolution.js';
import admin from 'firebase-admin';

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
    } else {
        return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
    }
}

function isInsideAdvanceWindow(cultDataHora: any, advanceHours: number) {
    if (!cultDataHora?.toDate) return false;
    const cultTimeMs = cultDataHora.toDate().getTime();
    const startMs = cultTimeMs - (advanceHours * 60 * 60 * 1000);
    const nowMs = Date.now();
    return nowMs >= startMs && nowMs <= cultTimeMs;
}

function formatAutoMessage(params: {
    nomeDoMembro: string;
    nomeIgreja: string;
    nomeCulto: string;
    nomeEscala: string;
    dataHoraCulto: Date;
    setor: string;
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
📍Função: ${params.setor}
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

async function runBatchJob() {
    if (!db) return;

    try {
        let churchDocs: any[] = [];
        const timeZone = getTimeZone();

        try {
            const snapshot = await db.collection('igrejas')
                .where('whatsappAutomation.enabled', '==', true)
                .where('whatsappAutomation.connected', '==', true)
                .get();
            churchDocs = snapshot.docs;
        } catch (error) {
            console.warn('Eligible churches query failed; falling back to full scan:', error);
            const snapshot = await db.collection('igrejas').get();
            churchDocs = snapshot.docs.filter((doc: any) => {
                const data = doc.data();
                const config = data?.whatsappAutomation || {};
                return config.enabled === true && config.connected === true;
            });
        }

        for (const doc of churchDocs) {
            const churchId = doc.id;
            const churchData = doc.data();
            const config = churchData?.whatsappAutomation || {};

            let status;
            try {
                status = await getInstanceStatus(churchId);
            } catch (error) {
                console.error(`Failed to read Evolution connection state for church ${churchId}:`, error);
                continue;
            }

            if (status.status !== 'connected') {
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

                if (!isInsideAdvanceWindow(escala.dataHoraCulto, advanceHours)) continue;

                const itemsSnapshot = await db.collection(`igrejas/${churchId}/escalas/${escalaDoc.id}/items`)
                    .where('notificado', '==', false)
                    .get();

                if (itemsSnapshot.empty) continue;

                const nomeIgreja = escala.nomeIgreja || churchData.nome || 'Igreja';
                const nomeCulto = escala.nomeCulto || 'Culto';
                const nomeEscala = escala.nome || escala.nomeEscala || nomeCulto;

                const batchToaster: { to: string, message: string }[] = [];
                const itemDocsList: any[] = [];

                for (const itemDoc of itemsSnapshot.docs) {
                    const item = itemDoc.data();

                    if (!item.telefone) {
                        if (item.notificadoErro !== 'sem_telefone') {
                            await itemDoc.ref.update({ notificado: false, notificadoErro: 'sem_telefone' });
                        }
                        continue;
                    }

                    if (!item.token) {
                        if (item.notificadoErro !== 'send_error') {
                            await itemDoc.ref.update({ notificado: false, notificadoErro: 'send_error' });
                        }
                        continue;
                    }

                    const msg = formatAutoMessage({
                        nomeDoMembro: item.nomeDoMembro || 'Membro',
                        nomeIgreja,
                        nomeCulto,
                        nomeEscala,
                        dataHoraCulto: escala.dataHoraCulto.toDate(),
                        setor: item.setor || '',
                        token: item.token,
                        timeZone
                    });

                    batchToaster.push({ to: item.telefone, message: msg });
                    itemDocsList.push(itemDoc);
                }

                if (batchToaster.length === 0) continue;

                try {
                    const result = await sendBatchText(churchId, batchToaster);

                    for (let i = 0; i < batchToaster.length; i++) {
                        const sendResult = result.results[i];
                        const docRef = itemDocsList[i].ref;

                        if (sendResult.status === 'sent') {
                            await docRef.update({
                                notificado: true,
                                notificadoEm: admin.firestore.FieldValue.serverTimestamp(),
                                notificadoErro: null
                            });
                            continue;
                        }

                        const failReason = String(sendResult.failReason || '');
                        const mappedError =
                            failReason === 'numero_invalido' || failReason === 'telefone_invalido'
                                ? 'numero_invalido'
                                : 'send_error';

                        await docRef.update({
                            notificado: false,
                            notificadoErro: mappedError
                        });
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
