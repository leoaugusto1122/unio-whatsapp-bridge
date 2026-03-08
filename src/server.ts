import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authMiddleware from './middleware/auth';
import instanceRoutes from './routes/instance';
import sendRoutes from './routes/send';
import healthRoutes from './routes/health';
import { startScheduler } from './services/scheduler';
import { bootstrapInstancesFromSessions } from './services/baileys';

if (process.env.NODE_ENV !== 'production') {
    dotenv.config();
}

if (!process.env.TZ) {
    process.env.TZ = 'America/Sao_Paulo';
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Public routes
app.use('/health', healthRoutes);

// Protected routes
app.use('/instance', authMiddleware, instanceRoutes);
app.use('/', authMiddleware, sendRoutes);

app.listen(PORT, async () => {
    console.log(`Server is running on port ${PORT}`);

    try {
        await bootstrapInstancesFromSessions();
    } catch (error) {
        console.error('Failed to bootstrap instances from sessions:', error);
    }

    startScheduler();
});

export default app;
