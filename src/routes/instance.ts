import { Router } from 'express';
import QRCode from 'qrcode';
import { connectInstance, getInstanceStatus, disconnectInstance, getLatestQrCode } from '../services/baileys.js';

const router = Router();

router.post('/connect', async (req, res) => {
    try {
        const { churchId } = req.body;
        if (!churchId) {
            return res.status(400).json({ error: 'churchId is required' });
        }

        const result = await connectInstance(churchId);
        res.json(result);
    } catch (error: any) {
        res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
});

router.get('/qrcode/:churchId', async (req, res) => {
    try {
        const { churchId } = req.params;
        const latest = getLatestQrCode(churchId);

        if (!latest?.qrCode) {
            return res.status(404).json({ error: 'qr_not_available' });
        }

        // Verificar se o QR não está muito antigo (>25s já expirou)
        const ageMs = latest.ageMs ?? Number.POSITIVE_INFINITY;
        if (!Number.isFinite(ageMs) || ageMs > 25_000) {
            return res.status(404).json({ error: 'qr_expired' });
        }

        const qrImageBase64 = await QRCode.toDataURL(latest.qrCode);
        return res.json({
            qrCode: qrImageBase64,
            expiresIn: Math.max(0, 25 - Math.floor(ageMs / 1000)),
        });
    } catch (err) {
        console.error('QR generation failed:', err);
        return res.status(500).json({ error: 'qr_generation_failed' });
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
