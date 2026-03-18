import type { Request, Response, NextFunction } from 'express';

function getBridgeApiKey() {
    const explicitApiKey = process.env.API_KEY?.trim();
    if (explicitApiKey) return explicitApiKey;
    return process.env.EVOLUTION_API_KEY?.trim() || '';
}

function extractToken(req: Request): string {
    const authHeader = String(req.headers.authorization || '').trim();
    if (authHeader.toLowerCase().startsWith('bearer ')) {
        return authHeader.slice(7).trim();
    }
    return String(req.headers.apikey || '').trim();
}

export function requireApiKey(req: Request, res: Response, next: NextFunction) {
    const expected = getBridgeApiKey();
    if (!expected) {
        res.status(500).json({ error: 'server_misconfiguration', message: 'API key not configured' });
        return;
    }

    const token = extractToken(req);
    if (!token || token !== expected) {
        res.status(401).json({ error: 'unauthorized' });
        return;
    }

    next();
}
