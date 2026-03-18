import type { Request, Response, NextFunction } from 'express';

export function requireAdminKey(req: Request, res: Response, next: NextFunction) {
    const adminKey = process.env.ADMIN_KEY?.trim();
    if (!adminKey) {
        res.status(500).json({ error: 'server_misconfiguration', message: 'Admin key not configured' });
        return;
    }

    const provided = String(req.headers['x-admin-key'] || '').trim();
    if (!provided || provided !== adminKey) {
        res.status(403).json({ error: 'forbidden', message: 'Invalid or missing x-admin-key' });
        return;
    }

    next();
}
