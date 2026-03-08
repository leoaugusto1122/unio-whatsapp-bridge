import { Router } from 'express';
import { connectInstance, getInstanceStatus, disconnectInstance } from '../services/baileys.js';
import { normalizePhoneDigits, PhoneValidationError } from '../utils/phone.js';

const router = Router();

router.post('/connect', async (req, res) => {
    try {
        const { churchId, phoneNumber } = req.body;
        if (!churchId || !phoneNumber) {
            return res.status(400).json({ error: 'churchId and phoneNumber are required' });
        }

        const finalPhone = normalizePhoneDigits(phoneNumber);
        const result = await connectInstance(churchId, finalPhone, { ifConnecting: 'reset' });
        res.json(result);
    } catch (error: any) {
        if (error instanceof PhoneValidationError) {
            return res.status(400).json({ error: error.code, message: error.message });
        }
        res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
});

router.get('/status/:churchId', async (req, res) => {
    try {
        const { churchId } = req.params;
        const result = await getInstanceStatus(churchId);
        res.json(result);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/disconnect', async (req, res) => {
    try {
        const { churchId } = req.body;
        if (!churchId) {
            return res.status(400).json({ error: 'churchId is required' });
        }
        const result = await disconnectInstance(churchId);
        res.json(result);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

export default router;
