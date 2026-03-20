import { Router } from 'express';
import {
    listPoolNumbers,
    getPoolNumber,
    addPoolNumber,
    updatePoolNumber,
    deletePoolNumber
} from '../services/firestore.js';
import {
    createInstance,
    getQRCode,
    deleteInstance,
    getInstanceStatus
} from '../services/evolution.js';

const router = Router();

// GET /admin/pool
router.get('/pool', async (_req, res) => {
    const numbers = await listPoolNumbers();

    const connected = numbers.filter(n => n.status === 'connected').length;
    const disconnected = numbers.filter(n => n.status === 'disconnected').length;

    res.json({
        numbers,
        summary: {
            total: numbers.length,
            connected,
            disconnected
        }
    });
});

// POST /admin/pool/add
router.post('/pool/add', async (req, res) => {
    const { phoneNumber, notes } = req.body || {};

    if (!phoneNumber) {
        res.status(400).json({ error: 'bad_request', message: 'phoneNumber is required' });
        return;
    }

    const now = new Date().toISOString();
    const numberId = await addPoolNumber({
        phoneNumber,
        instanceId: '', // set after instance creation
        status: 'disconnected',
        addedAt: now,
        connectedAt: null,
        lastUsedAt: null,
        messagesToday: 0,
        totalMessages: 0,
        notes: notes || '',
        antiBan: {
            hourWindowStartedAt: null,
            hourCount: 0,
            lastHourlyBlockAt: null
        }
    });

    const instanceId = `unio_pool_${numberId}`;

    try {
        const result = await createInstance(instanceId);
        await updatePoolNumber(numberId, { instanceId });

        res.json({
            numberId,
            instanceId,
            qrCode: result.qrCode,
            qrCodeExpiry: result.qrCodeExpiry
        });
    } catch (error) {
        // Clean up Firestore entry if Evolution API fails
        await deletePoolNumber(numberId);
        const message = error instanceof Error ? error.message : 'Failed to create instance';
        res.status(500).json({ error: 'instance_creation_failed', message });
    }
});

// GET /admin/pool/:numberId/qr
router.get('/pool/:numberId/qr', async (req, res) => {
    const { numberId } = req.params;

    const number = await getPoolNumber(numberId);
    if (!number) {
        res.status(404).json({ error: 'not_found', message: `Number ${numberId} not found` });
        return;
    }

    const result = await getQRCode(number.instanceId);
    res.json({ qrCode: result.qrCode, qrCodeExpiry: result.qrCodeExpiry });
});

// DELETE /admin/pool/:numberId
router.delete('/pool/:numberId', async (req, res) => {
    const { numberId } = req.params;

    const number = await getPoolNumber(numberId);
    if (!number) {
        res.status(404).json({ error: 'not_found', message: `Number ${numberId} not found` });
        return;
    }

    try {
        await deleteInstance(number.instanceId);
    } catch (error) {
        console.warn(`Failed to delete Evolution instance ${number.instanceId}:`, error);
        // Continue with Firestore deletion even if Evolution fails
    }

    await deletePoolNumber(numberId);
    res.json({ removed: true, numberId });
});

// GET /admin/pool/:numberId/status
router.get('/pool/:numberId/status', async (req, res) => {
    const { numberId } = req.params;

    const number = await getPoolNumber(numberId);
    if (!number) {
        res.status(404).json({ error: 'not_found', message: `Number ${numberId} not found` });
        return;
    }

    const statusResult = await getInstanceStatus(number.instanceId);

    // Sync status back to Firestore
    if (statusResult.status !== number.status) {
        await updatePoolNumber(numberId, { status: statusResult.status });
    }

    res.json({
        numberId,
        instanceId: number.instanceId,
        status: statusResult.status,
        connectedSince: number.connectedAt
    });
});

export default router;
