import { Router } from 'express';

const router = Router();

router.get('/', (_req, res) => {
    res.json({
        ok: true,
        service: 'bridge',
        version: process.env.APP_VERSION?.trim() || null,
        commit: process.env.BUILD_COMMIT?.trim() || null
    });
});

export default router;
