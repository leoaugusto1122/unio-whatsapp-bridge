import { Router } from 'express';
import { getChurchWhatsappAutomation, db } from '../services/firestore.js';
import { listConnectedPoolNumbers } from '../services/firestore.js';

const router = Router();

// POST /automation/register
router.post('/register', async (req, res) => {
    const { churchId } = req.body || {};

    if (!churchId) {
        res.status(400).json({ error: 'bad_request', message: 'churchId is required' });
        return;
    }

    const connected = await listConnectedPoolNumbers();
    if (connected.length === 0) {
        res.json({ registered: false, reason: 'no_numbers_available' });
        return;
    }

    if (db) {
        await db.collection('igrejas').doc(churchId).update({
            'whatsappAutomation.enabled': true
        });
    }

    res.json({ registered: true, churchId });
});

// POST /automation/unregister
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

// GET /automation/status/:churchId
router.get('/status/:churchId', async (req, res) => {
    const { churchId } = req.params;

    const config = await getChurchWhatsappAutomation(churchId);
    const active = config?.enabled === true;

    const connected = await listConnectedPoolNumbers();
    const serviceStatus = connected.length > 0
        ? 'operational'
        : (active ? 'degraded' : 'unavailable');

    res.json({ churchId, active, serviceStatus });
});

export default router;
