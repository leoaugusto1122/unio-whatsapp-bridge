import dotenv from 'dotenv';
import express from 'express';
import { startScheduler } from './services/scheduler.js';
import { validateEvolutionConfig } from './services/evolution.js';
import { syncChurchConnectionStatus } from './services/connection-sync.js';
import { requireApiKey } from './middleware/auth.js';
import { requireAdminKey } from './middleware/adminAuth.js';
import healthRouter from './routes/health.js';
import sendRouter from './routes/send.js';
import automationRouter from './routes/automation.js';
import adminRouter from './routes/admin.js';

if (process.env.NODE_ENV !== 'production') {
    dotenv.config();
}

if (!process.env.TZ) {
    process.env.TZ = 'America/Sao_Paulo';
}

function getPort() {
    const rawPort = Number.parseInt(process.env.PORT || '', 10);
    return Number.isFinite(rawPort) && rawPort > 0 ? rawPort : 3000;
}

function createApp() {
    const app = express();

    app.use(express.json());

    // Request logger
    app.use((req, _res, next) => {
        console.log(JSON.stringify({
            timestamp: new Date().toISOString(),
            event: 'http_request',
            method: req.method,
            path: req.path
        }));
        next();
    });

    // Public
    app.use('/health', healthRouter);

    // Maps redirect — opens native navigation app chooser on device
    app.get('/maps', (req, res) => {
        const lat = parseFloat(String(req.query.lat || ''));
        const lng = parseFloat(String(req.query.lng || ''));

        if (!isFinite(lat) || !isFinite(lng)) {
            return res.status(400).send('Invalid coordinates');
        }

        const geoUri = `geo:${lat},${lng}`;
        res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Localização do Evento</title>
  <meta property="og:title" content="Localização do Evento">
  <meta property="og:description" content="Toque para abrir no seu app de navegação">
  <meta http-equiv="refresh" content="0;url=${geoUri}">
</head>
<body>
  <p>Abrindo app de navegação...</p>
  <p><a href="${geoUri}">Toque aqui se não abrir automaticamente</a></p>
  <script>window.location.href = '${geoUri}';</script>
</body>
</html>`);
    });

    // Authenticated routes
    app.use('/send', requireApiKey, sendRouter);
    app.use('/automation', requireApiKey, automationRouter);

    // Legacy sync endpoint (kept for backward compatibility)
    app.post('/sync/:churchId', requireApiKey, async (req, res) => {
        const churchId = String(req.params.churchId);
        try {
            const result = await syncChurchConnectionStatus(churchId, 'config_screen');
            res.json(result);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            res.status(500).json({ error: message });
        }
    });

    // Admin routes — require both apikey + x-admin-key
    app.use('/admin', requireApiKey, requireAdminKey, adminRouter);

    // 404
    app.use((_req, res) => {
        res.status(404).json({ error: 'not_found' });
    });

    return app;
}

function registerSignalHandlers() {
    const shutdown = (signal: NodeJS.Signals) => {
        console.log(`Received ${signal}. Shutting down WhatsApp bridge.`);
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

function bootstrap() {
    validateEvolutionConfig();
    registerSignalHandlers();

    const port = getPort();
    const app = createApp();

    startScheduler();

    app.listen(port, () => {
        console.log(`WhatsApp bridge listening on port ${port}`);
    });
}

bootstrap();
