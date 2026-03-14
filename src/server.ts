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

function getBuildMetadata() {
    return {
        service: 'bridge',
        version: process.env.APP_VERSION?.trim() || null,
        commit: process.env.BUILD_COMMIT?.trim() || null,
        syncRouteEnabled: true
    };
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

function getAcceptedAuthHeader(request: IncomingMessage) {
    const authHeader = String(request.headers.authorization || '').trim();
    if (authHeader.toLowerCase().startsWith('bearer ')) {
        return {
            header: 'authorization' as const,
            token: authHeader.slice(7).trim()
        };
    }

    const apiKeyHeader = String(request.headers.apikey || '').trim();
    if (apiKeyHeader) {
        return {
            header: 'apikey' as const,
            token: apiKeyHeader
        };
    }

    return {
        header: null,
        token: ''
    };
}

function authenticate(request: IncomingMessage) {
    const expectedApiKey = getBridgeApiKey();
    const auth = getAcceptedAuthHeader(request);

    return {
        ok: Boolean(expectedApiKey) && auth.token === expectedApiKey,
        header: auth.header,
        reason: expectedApiKey
            ? (auth.token ? 'invalid_api_key' : 'missing_api_key')
            : 'missing_server_api_key'
    };
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

    const auth = authenticate(request);
    if (!auth.ok) {
        logHttp({
            event: 'http_sync_unauthorized',
            churchId,
            path: pathname,
            method: request.method,
            authHeader: auth.header,
            reason: auth.reason
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
            error: result.error || null,
            authHeader: auth.header,
            path: pathname,
            method: request.method
        });
        sendJson(response, 200, result);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        logHttp({
            event: 'http_sync_failed',
            churchId,
            path: pathname,
            method: request.method,
            error: message,
            authHeader: auth.header
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
            sendJson(response, 200, {
                ok: true,
                ...getBuildMetadata()
            });
            return;
        }

        const churchId = getChurchIdFromPath(pathname);
        const notFoundPayload = pathname.startsWith('/sync/')
            ? { error: 'not_found', message: 'Use POST /sync/:churchId' }
            : { error: 'not_found' };

        logHttp({
            event: 'http_not_found',
            path: pathname,
            method,
            churchId: churchId || null,
            reason: pathname.startsWith('/sync/') ? 'unsupported_method_or_path' : 'unknown_path'
        });

        sendJson(response, 404, notFoundPayload);
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
