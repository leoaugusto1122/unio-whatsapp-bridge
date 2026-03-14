import dotenv from 'dotenv';
import { startScheduler } from './services/scheduler.js';
import { validateEvolutionConfig } from './services/evolution.js';

if (process.env.NODE_ENV !== 'production') {
    dotenv.config();
}

if (!process.env.TZ) {
    process.env.TZ = 'America/Sao_Paulo';
}

function registerSignalHandlers() {
    const shutdown = (signal: NodeJS.Signals) => {
        console.log(`Received ${signal}. Shutting down scheduler worker.`);
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

function bootstrap() {
    validateEvolutionConfig();
    registerSignalHandlers();

    console.log('Starting WhatsApp scheduler worker');
    startScheduler();
}

bootstrap();
