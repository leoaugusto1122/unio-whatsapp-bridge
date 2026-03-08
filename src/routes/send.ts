import { Router } from 'express';
import { sendIndividualMessage, sendBatchMessages } from '../services/baileys.js';

const router = Router();

router.post('/send', async (req, res) => {
    try {
        const { churchId, to, message } = req.body;
        if (!churchId || !to || !message) {
            return res.status(400).json({ error: 'churchId, to, and message are required' });
        }
        const result = await sendIndividualMessage(churchId, to, message);
        if (result.status === 'failed') {
            return res.status(400).json(result);
        }
        res.json(result);
    } catch (error: any) {
        res.status(500).json({ error: error.message || 'Internal error' });
    }
});

router.post('/send-batch', async (req, res) => {
    try {
        const { churchId, messages } = req.body;
        if (!churchId || !Array.isArray(messages)) {
            return res.status(400).json({ error: 'churchId and messages array are required' });
        }

        const result = await sendBatchMessages(churchId, messages);
        res.json(result);
    } catch (error: any) {
        if (error.message === 'instance_disconnected') {
            return res.status(400).json({ error: 'instance_disconnected' });
        }
        res.status(500).json({ error: error.message });
    }
});

export default router;
