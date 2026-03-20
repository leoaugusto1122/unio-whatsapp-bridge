import { Router } from 'express';
import { selectSenderForChurch } from '../services/pool.js';
import { sendText } from '../services/evolution.js';
import { incrementNumberMessageCount } from '../services/firestore.js';

const router = Router();

router.post('/', async (req, res) => {
    const { churchId, to, message } = req.body || {};

    if (!churchId || !to || !message) {
        res.status(400).json({ error: 'bad_request', message: 'churchId, to and message are required' });
        return;
    }

    const sender = await selectSenderForChurch(churchId, 1);
    if (!sender) {
        res.status(503).json({
            status: 'failed',
            reason: 'no_sender_available',
            message: 'Nenhum número do pool está disponível no momento'
        });
        return;
    }

    const result = await sendText(sender.instanceId, to, message);

    if (result.status === 'sent') {
        await incrementNumberMessageCount(sender.numberId);
        res.json({ status: 'sent', to: result.to, timestamp: result.timestamp });
    } else {
        res.status(500).json({
            status: 'failed',
            reason: result.failReason,
            message: result.message
        });
    }
});

export default router;
