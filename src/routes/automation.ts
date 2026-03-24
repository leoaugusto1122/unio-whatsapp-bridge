import { Router } from 'express';
import { getChurchWhatsappAutomation, db } from '../services/firestore.js';
import { listConnectedPoolNumbers } from '../services/firestore.js';

const router = Router();

router.post('/register', async (req, res) => {
    const { churchId } = req.body || {};

    if (!churchId) {
        res.status(400).json({ error: 'bad_request', message: 'churchId is required' });
        return;
    }

    const connected = await listConnectedPoolNumbers();
    const serviceStatus = connected.length > 0 ? 'operational' : 'unavailable';

    if (db) {
        await db.collection('igrejas').doc(churchId).update({
            'whatsappAutomation.enabled': true
        });
    }

    if (connected.length === 0) {
        res.json({
            churchId,
            registered: false,
            active: false,
            serviceStatus,
            senderAssigned: false,
            reason: 'no_numbers_available'
        });
        return;
    }

    res.json({
        churchId,
        registered: true,
        active: true,
        serviceStatus,
        senderAssigned: true
    });
});

router.post('/unregister', async (req, res) => {
    const { churchId } = req.body || {};

    if (!churchId) {
        res.status(400).json({ error: 'bad_request', message: 'churchId is required' });
        return;
    }

    if (db) {
        await db.collection('igrejas').doc(churchId).update({
            'whatsappAutomation.enabled': false
        });
    }

    res.json({ unregistered: true, churchId });
});

router.get('/status/:churchId', async (req, res) => {
    const { churchId } = req.params;

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
});

export default router;
