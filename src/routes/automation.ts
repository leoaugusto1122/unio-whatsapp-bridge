import { Router } from 'express';
import { getChurchWhatsappAutomation, db } from '../services/firestore.js';
import { listConnectedPoolNumbers } from '../services/firestore.js';
import { buildLogMeta } from '../utils/logger.js';

const router = Router();

function getErrorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

async function setChurchAutomationEnabled(churchId: string, enabled: boolean) {
    if (!db) return;

    await db.collection('igrejas').doc(churchId).set({
        whatsappAutomation: { enabled }
    }, { merge: true });
}

function parseCultoDate(value: any): Date | null {
    if (value instanceof Date) return value;
    if (typeof value?.toDate === 'function') {
        const converted = value.toDate();
        return converted instanceof Date ? converted : null;
    }
    if (typeof value === 'string') {
        const parsed = new Date(value);
        return Number.isFinite(parsed.getTime()) ? parsed : null;
    }
    return null;
}

async function resetChurchDisabledItems(churchId: string) {
    if (!db) return;

    const startedAt = new Date();
    const disabledItems = await db.collectionGroup('items')
        .where('notificadoErro', '==', 'church_disabled')
        .get();

    const resetPromises: Promise<unknown>[] = [];
    for (const itemDoc of disabledItems.docs) {
        const parts = itemDoc.ref.path.split('/');
        if (parts[1] !== churchId) continue;

        const item = itemDoc.data();
        const dataCulto = parseCultoDate(item.dataCulto);
        if (dataCulto && dataCulto.getTime() > startedAt.getTime()) {
            resetPromises.push(itemDoc.ref.update({ notificado: false, notificadoErro: null }));
        }
    }

    if (resetPromises.length === 0) return;

    await Promise.all(resetPromises);
    console.log(JSON.stringify({
        ...buildLogMeta(startedAt),
        event: 'automation_register_items_reset',
        churchId,
        resetCount: resetPromises.length
    }));
}

router.post('/register', async (req, res) => {
    const { churchId } = req.body || {};

    if (!churchId) {
        res.status(400).json({ error: 'bad_request', message: 'churchId is required' });
        return;
    }

    const startedAt = new Date();
    console.log(JSON.stringify({
        ...buildLogMeta(startedAt),
        event: 'automation_register_start',
        churchId
    }));

    try {
        const connected = await listConnectedPoolNumbers();
        const serviceStatus = connected.length > 0 ? 'operational' : 'unavailable';

        await setChurchAutomationEnabled(churchId, true);

        void resetChurchDisabledItems(churchId).catch((error) => {
            console.error(JSON.stringify({
                ...buildLogMeta(),
                event: 'automation_register_items_reset_error',
                churchId,
                message: getErrorMessage(error)
            }));
        });

        const payload = connected.length === 0
            ? {
                churchId,
                registered: false,
                active: false,
                serviceStatus,
                senderAssigned: false,
                reason: 'no_numbers_available'
            }
            : {
                churchId,
                registered: true,
                active: true,
                serviceStatus,
                senderAssigned: true
            };

        console.log(JSON.stringify({
            ...buildLogMeta(),
            event: 'automation_register_success',
            churchId,
            registered: payload.registered,
            active: payload.active,
            senderAssigned: payload.senderAssigned,
            serviceStatus
        }));

        res.json(payload);
    } catch (error) {
        console.error(JSON.stringify({
            ...buildLogMeta(),
            event: 'automation_register_error',
            churchId,
            message: getErrorMessage(error)
        }));
        res.status(500).json({
            error: 'automation_register_failed',
            message: 'Failed to register church automation',
            churchId
        });
    }
});

router.post('/unregister', async (req, res) => {
    const { churchId } = req.body || {};

    if (!churchId) {
        res.status(400).json({ error: 'bad_request', message: 'churchId is required' });
        return;
    }

    try {
        await setChurchAutomationEnabled(churchId, false);
        console.log(JSON.stringify({
            ...buildLogMeta(),
            event: 'automation_unregister_success',
            churchId
        }));
        res.json({ unregistered: true, churchId });
    } catch (error) {
        console.error(JSON.stringify({
            ...buildLogMeta(),
            event: 'automation_unregister_error',
            churchId,
            message: getErrorMessage(error)
        }));
        res.status(500).json({
            error: 'automation_unregister_failed',
            message: 'Failed to unregister church automation',
            churchId
        });
    }
});

router.get('/status/:churchId', async (req, res) => {
    const { churchId } = req.params;

    try {
        const config = await getChurchWhatsappAutomation(churchId);
        const enabled = config?.enabled === true;

        const connected = await listConnectedPoolNumbers();
        const hasConnectedSender = connected.length > 0;
        const active = enabled && hasConnectedSender;
        const registered = enabled;
        const serviceStatus = hasConnectedSender
            ? 'operational'
            : (enabled ? 'degraded' : 'unavailable');

        res.json({
            churchId,
            enabled,
            registered,
            active,
            senderAssigned: hasConnectedSender,
            serviceStatus
        });
    } catch (error) {
        console.error(JSON.stringify({
            ...buildLogMeta(),
            event: 'automation_status_error',
            churchId,
            message: getErrorMessage(error)
        }));
        res.status(500).json({
            error: 'automation_status_failed',
            message: 'Failed to load automation status',
            churchId
        });
    }
});

export default router;
