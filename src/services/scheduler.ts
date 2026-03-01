import cron from 'node-cron';
import { db } from './firestore';
import { getInstanceStatus, sendBatchMessages } from './baileys';
import * as admin from 'firebase-admin';

const SCHEDULER_INTERVAL = process.env.SCHEDULER_INTERVAL || '60';

export function startScheduler() {
    console.log(`Starting scheduler with interval of ${SCHEDULER_INTERVAL} minutes`);

    // Convert configuration into valid cron (every X minutes)
    const expression = `*/${SCHEDULER_INTERVAL} * * * *`;

    cron.schedule(expression, async () => {
        console.log('Running scheduled job for WhatsApp automation');
        await runBatchJob();
    });
}

function calculateIfInAdvanceHours(cultDataHora: any, advanceHours: number) {
    if (!cultDataHora) return false;
    const cultTime = cultDataHora.toDate().getTime();
    const targetTime = cultTime - (advanceHours * 60 * 60 * 1000);
    const now = Date.now();
    return targetTime <= now;
}

function isInsideSilenceWindow(silenceStart: string, silenceEnd: string) {
    if (!silenceStart || !silenceEnd) return false;

    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    let [startH, startM] = silenceStart.split(':').map(Number);
    let [endH, endM] = silenceEnd.split(':').map(Number);

    const startMinutes = (startH || 0) * 60 + (startM || 0);
    const endMinutes = (endH || 0) * 60 + (endM || 0);

    if (startMinutes < endMinutes) {
        return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
    } else {
        return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
    }
}

function formatMessage(name: string, churchName: string, cultName: string, cultDate: Date, role: string, token: string) {
    const days = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
    const diaSemana = days[cultDate.getDay()];
    const dateFormatted = cultDate.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }).replace('.', '');

    return `Olá ${name}, a Paz do Senhor! 👋

Você está escalado(a) para:
🏛️ ${churchName}
📅 ${cultName} — ${diaSemana}, ${dateFormatted}
📋 Função: ${role}

Confirme sua presença pelo link abaixo:
🔗 https://unioescala.web.app/confirmar?token=${token}

Obrigado! 🙏`;
}

async function runBatchJob() {
    if (!db) return;

    try {
        const churchesSnapshot = await db.collection('igrejas').get();

        for (const doc of churchesSnapshot.docs) {
            const data = doc.data();
            const config = data.whatsappAutomation || {};

            if (config.enabled && config.connected) {
                const churchId = doc.id;

                const status = await getInstanceStatus(churchId);
                if (status.status !== 'connected') {
                    console.log(`Church ${churchId} disconnected. Job skipped.`);
                    continue;
                }

                const advanceHours = config.advanceHours || 24;
                const silenceStart = config.silenceStart;
                const silenceEnd = config.silenceEnd;

                if (isInsideSilenceWindow(silenceStart, silenceEnd)) {
                    console.log(`Church ${churchId} in silence window.`);
                    continue;
                }

                // Query root collection `escalas` pointing to this churchId, assuming denormalized structure
                // Fallback to subcollection if you prefer. Using root is more common when querying across or specific.
                // It specifies 'Membro dentro de uma escala' implying subcollection or array. Let's assume nested.
                const escalasSnapshot = await db.collection(`igrejas/${churchId}/escalas`)
                    .where('status', '==', 'publicada')
                    .get();

                for (const escalaDoc of escalasSnapshot.docs) {
                    const escala = escalaDoc.data();

                    if (!calculateIfInAdvanceHours(escala.dataHoraCulto, advanceHours)) {
                        continue;
                    }

                    const membrosSnapshot = await db.collection(`igrejas/${churchId}/escalas/${escalaDoc.id}/membros`)
                        .where('notificado', '==', false)
                        .get();

                    if (membrosSnapshot.empty) continue;

                    const batchToaster = [];
                    const memberDocsList = [];

                    for (const membroDoc of membrosSnapshot.docs) {
                        const membro = membroDoc.data();

                        if (!membro.telefone) {
                            await membroDoc.ref.update({
                                notificado: false,
                                notificadoErro: 'sem_telefone'
                            });
                            continue;
                        }

                        const msg = formatMessage(
                            membro.nomeDoMembro,
                            escala.nomeIgreja || data.nome || 'Igreja',
                            escala.nomeCulto,
                            escala.dataHoraCulto.toDate(),
                            membro.setor,
                            membro.token
                        );

                        batchToaster.push({ to: membro.telefone, message: msg });
                        memberDocsList.push(membroDoc);
                    }

                    if (batchToaster.length === 0) continue;

                    try {
                        const result = await sendBatchMessages(churchId, batchToaster);

                        for (let i = 0; i < batchToaster.length; i++) {
                            const sendResult = result.results[i];
                            const docRef = memberDocsList[i].ref;

                            if (sendResult.status === 'sent') {
                                await docRef.update({
                                    notificado: true,
                                    notificadoEm: admin.firestore.FieldValue.serverTimestamp()
                                });
                            } else {
                                await docRef.update({
                                    notificado: false,
                                    notificadoErro: sendResult.failReason || 'numero_invalido'
                                });
                            }
                        }
                    } catch (error) {
                        console.error(`Error sending batch for church ${churchId} escala ${escalaDoc.id}`, error);
                    }
                }
            }
        }
    } catch (error) {
        console.error('Error in batch job:', error);
    }
}
