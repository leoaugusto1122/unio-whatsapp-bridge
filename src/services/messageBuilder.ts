function getTimeZone() {
    return process.env.TZ || 'America/Sao_Paulo';
}

function capitalizeFirst(text: string) {
    if (!text) return text;
    return text.charAt(0).toUpperCase() + text.slice(1);
}

export type EventLocation = {
    name?: string;
    formatted_address?: string;
    lat?: number;
    lng?: number;
};

export type SegmentoNormalizado = 'igreja' | 'neutro';

const RELIGIOUS_GREETINGS = ['Olá, irmão', 'Paz do Senhor,', 'Oi, tudo bem?'] as const;
const NEUTRAL_GREETINGS = ['Olá,', 'Oi,', 'Bom dia,', 'Boa tarde,'] as const;

export function buildMapsUrl(lat: number, lng: number): string {
    return `https://maps.google.com/?q=${lat},${lng}`;
}

export type MessageParams = {
    nomeDoMembro: string;
    nomeIgreja: string;
    nomeCulto: string;
    nomeEscala: string;
    dataHoraCulto: Date;
    local: string;
    token: string;
    location?: EventLocation | null;
    segmento?: string | null;
    now?: Date;
    randomFn?: () => number;
};

function getValidLocation(candidate: unknown): EventLocation | null {
    if (!candidate || typeof candidate !== 'object') return null;

    const loc = candidate as { name?: unknown; formatted_address?: unknown; lat?: unknown; lng?: unknown };
    const lat = Number(loc.lat);
    const lng = Number(loc.lng);
    if (!isFinite(lat) || !isFinite(lng)) return null;

    return {
        name: String(loc.name || '').trim(),
        formatted_address: String(loc.formatted_address || '').trim(),
        lat,
        lng
    };
}

export function normalizeSegmento(raw: unknown): SegmentoNormalizado {
    const value = String(raw || '').trim().toLowerCase();
    if (!value || value === 'igreja') return 'igreja';
    return 'neutro';
}

function getGreetingHour(now: Date, timeZone: string) {
    const formatter = new Intl.DateTimeFormat('pt-BR', {
        timeZone,
        hour: '2-digit',
        hour12: false
    });

    const parts = formatter.formatToParts(now);
    return Number(parts.find(part => part.type === 'hour')?.value || '0');
}

function isGreetingCompatibleWithHour(greeting: string, hour: number) {
    if (greeting === 'Bom dia,') return hour < 12;
    if (greeting === 'Boa tarde,') return hour >= 12;
    return true;
}

export function resolveGreeting(
    segmento: unknown,
    options?: {
        now?: Date;
        randomFn?: () => number;
        timeZone?: string;
    }
) {
    const timeZone = options?.timeZone || getTimeZone();
    const now = options?.now || new Date();
    const randomFn = options?.randomFn || Math.random;
    const normalized = normalizeSegmento(segmento);
    const greetings = normalized === 'igreja' ? RELIGIOUS_GREETINGS : NEUTRAL_GREETINGS;
    const idx = Math.floor(randomFn() * greetings.length);
    const picked = greetings[idx] || greetings[0];

    if (normalized === 'neutro') {
        const hour = getGreetingHour(now, timeZone);
        return isGreetingCompatibleWithHour(picked, hour) ? picked : 'Olá,';
    }

    return picked;
}

export function resolveEventLocation(culto: unknown, igreja: unknown): EventLocation | null {
    const cultoLocation = getValidLocation((culto as { localEvento?: unknown } | null | undefined)?.localEvento);
    if (cultoLocation) return cultoLocation;

    const igrejaLocation = getValidLocation((igreja as { enderecoMaps?: unknown } | null | undefined)?.enderecoMaps);
    if (igrejaLocation) return igrejaLocation;

    return null;
}

function formatLocationBlock(location?: EventLocation | null): string {
    const resolved = getValidLocation(location);
    if (resolved?.lat == null || resolved?.lng == null) return '';

    const mapsUrl = buildMapsUrl(resolved.lat, resolved.lng);
    const address = resolved.formatted_address || '';
    const label = resolved.name
        ? address
            ? `${resolved.name} - ${address}`
            : resolved.name
        : address;

    if (!label) {
        return `\n📍 ${mapsUrl}`;
    }

    return `\n*Local:* ${label}\n📍 ${mapsUrl}`;
}

export function buildAutoMessage(params: MessageParams): string {
    const timeZone = getTimeZone();
    const greeting = resolveGreeting(params.segmento, {
        now: params.now,
        randomFn: params.randomFn,
        timeZone
    });

    const diaSemana = capitalizeFirst(
        params.dataHoraCulto.toLocaleDateString('pt-BR', { weekday: 'long', timeZone })
    );
    const data = params.dataHoraCulto.toLocaleDateString('pt-BR', { timeZone });
    const horario = params.dataHoraCulto.toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone
    });

    const linkConfirmacao = `https://unioescala.web.app/confirmar?token=${params.token}`;
    const locationBlock = formatLocationBlock(params.location);

    return `${greeting} *${params.nomeDoMembro}*.

Você está escalado(a) para:
🏛 *${params.nomeIgreja}*
*EVENTO:* ${params.nomeCulto}
*ESCALA:* ${params.nomeEscala}

*Data:* ${diaSemana}, ${data}
*Horário:* ${horario}
*Função:* ${params.local}

✅ *Confirme sua presença pelo link abaixo:*
${linkConfirmacao}${locationBlock}

Obrigado!`;
}

export function formatarLocal(item: Record<string, unknown>): string {
    const setor = String(item?.setorNome || '').trim();
    const corredor = String(item?.corredorNome || '').trim();
    const funcao = String(item?.funcaoNaEscala || '').trim();

    if (corredor && corredor !== setor) {
        return `${setor} (${corredor})`;
    }

    if (setor) return setor;

    return funcao;
}
