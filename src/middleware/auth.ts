import { Request, Response, NextFunction } from 'express';

export default function authMiddleware(req: Request, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;
    const expectedApiKey = process.env.API_KEY;

    if (!expectedApiKey) {
        console.error('API_KEY environment variable is not set!');
        return res.status(500).json({ error: 'Internal Server Error' });
    }

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: Missing or invalid Authorization header' });
    }

    const token = authHeader.split(' ')[1];

    if (token !== expectedApiKey) {
        return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
    }

    next();
}
