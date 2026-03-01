import { Router } from 'express';
import { getConnectedInstancesCount } from '../services/baileys';

const router = Router();

router.get('/', (req, res) => {
    const instances = getConnectedInstancesCount();
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        instances: {
            connected: instances,
            disconnected: 0 // In a distributed environment or keeping track of total, but here we just return connected count
        }
    });
});

export default router;
