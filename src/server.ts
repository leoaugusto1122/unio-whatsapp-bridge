import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authMiddleware from './middleware/auth';
import instanceRoutes from './routes/instance';
import sendRoutes from './routes/send';
import healthRoutes from './routes/health';
import { startScheduler } from './services/scheduler';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Public routes
app.use('/health', healthRoutes);

// Protected routes
app.use('/instance', authMiddleware, instanceRoutes);
app.use('/', authMiddleware, sendRoutes);

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    startScheduler();
});

export default app;
