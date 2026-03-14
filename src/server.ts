import dotenv from 'dotenv';
import http, { IncomingMessage, ServerResponse } from 'node:http';
import { startScheduler } from './services/scheduler.js';
import { validateEvolutionConfig } from './services/evolution.js';
import { startPeriodicConnectionStatusSyncJob, syncChurchConnectionStatus } from './services/connection-sync.js';

if (process.env.NODE_ENV !== 'production') {
    dotenv.config();
}

if (!process.env.TZ) {
    process.env.TZ = 'America/Sao_Paulo';
}

function registerSignalHandlers() {
    const shutdown = (signal: NodeJS.Signals) => {
        console.log(`Received ${signal}. Shutting down WhatsApp bridge.`);
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

function getPort() {
    const rawPort = Number.parseInt(process.env.PORT || '', 10);
    return Number.isFinite(rawPort) && rawPort > 0 ? rawPort : 3000;
}

function getBridgeApiKey() {
    const explicitApiKey = process.env.API_KEY?.trim();
    if (explicitApiKey) return explicitApiKey;
    return process.env.EVOLUTION_API_KEY?.trim() || '';
}

function logHttp(payload: Record<string, unknown>) {
    console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        ...payload
    }));
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
    response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(payload));
}

function getChurchIdFromPath(pathname: string) {
    const match = pathname.match(/^\/sync\/([^/]+)$/);
    if (!match) return '';
    return decodeURIComponent(match[1] || '').trim();
}

function authenticate(request: IncomingMessage) {
    const expectedApiKey = getBridgeApiKey();
    const providedApiKey = String(request.headers.apikey || '').trim();
    return Boolean(expectedApiKey) && providedApiKey === expectedApiKey;
}

async function handleSyncRequest(request: IncomingMessage, response: ServerResponse, pathname: string) {
    const churchId = getChurchIdFromPath(pathname);

    if (!churchId) {
        logHttp({
            event: 'http_sync_invalid_request',
            path: pathname,
            method: request.method
        });
        sendJson(response, 400, { error: 'churchId is required' });
        return;
    }

    if (!authenticate(request)) {
        logHttp({
            event: 'http_sync_unauthorized',
            churchId,
            path: pathname,
            method: request.method
        });
        sendJson(response, 401, { error: 'unauthorized' });
        return;
    }

    try {
        const result = await syncChurchConnectionStatus(churchId, 'config_screen');
        logHttp({
            event: 'http_sync_completed',
            churchId,
            origin: result.origin,
            updated: result.updated,
            statusAnterior: result.statusAnterior,
            statusNovo: result.statusNovo,
            error: result.error || null
        });
        sendJson(response, 200, result);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        logHttp({
            event: 'http_sync_failed',
            churchId,
            path: pathname,
            method: request.method,
            error: message
        });
        sendJson(response, 500, { error: message });
    }
}

function createServer() {
    return http.createServer(async (request, response) => {
        const method = String(request.method || 'GET').toUpperCase();
        const pathname = new URL(request.url || '/', 'http://localhost').pathname;

        if (method === 'POST' && pathname.startsWith('/sync/')) {
            await handleSyncRequest(request, response, pathname);
            return;
        }

        if (method === 'GET' && pathname === '/health') {
            sendJson(response, 200, { ok: true });
            return;
        }

        sendJson(response, 404, { error: 'not_found' });
    });
}

function bootstrap() {
    validateEvolutionConfig();
    registerSignalHandlers();

    const port = getPort();
    const server = createServer();

    console.log(`Starting WhatsApp bridge on port ${port}`);
    startScheduler();
    startPeriodicConnectionStatusSyncJob();
    server.listen(port);
}

bootstrap();
