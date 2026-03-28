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
    telefoneResponsavel?: string;
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

function getLocationMapsUrl(location?: EventLocation | null): string | null {
    const resolved = getValidLocation(location);
    if (resolved?.lat == null || resolved?.lng == null) return null;
    return buildMapsUrl(resolved.lat, resolved.lng);
}

export function buildAutoMessage(params: MessageParams): string {
    const timeZone = getTimeZone();
    const normalized = normalizeSegmento(params.segmento);

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
    const mapsUrl = getLocationMapsUrl(params.location);
    const telefone = params.telefoneResponsavel?.trim() || '';
    const phoneBlock = telefone ? `\n📞 ${telefone}` : '';
    const dataHora = `${diaSemana}, ${data} às ${horario}`;

    if (normalized === 'igreja') {
        const locationBlock = mapsUrl ? `\n\n📍 *Local do culto:*\n${mapsUrl}` : '';
        return `Olá, *${params.nomeDoMembro}*! 🙌

Você está escalado(a) para o próximo culto:

🏛 *${params.nomeIgreja}*
🎉 *Evento:* ${params.nomeCulto}
📅 *${dataHora}*

🧩 *Escalação:*
${params.local}

👉 Confirme em menos de 10 segundos:
${linkConfirmacao}${locationBlock}

⚠️ Este número é automático e não recebe respostas.
Dúvidas? Procure o responsável pela escala.${phoneBlock}

Deus abençoe! 🙏`;
    }

    const locationBlock = mapsUrl ? `\n\n📍 *Local do evento:*\n${mapsUrl}` : '';
    return `Olá, *${params.nomeDoMembro}*!

Você está escalado(a) para o próximo evento:

🏢 *${params.nomeIgreja}*
🎉 *Evento:* ${params.nomeCulto}
📅 *${dataHora}*

🧩 *Escalação:*
${params.local}

👉 Confirme em menos de 10 segundos:
${linkConfirmacao}${locationBlock}

⚠️ Este número é automático e não recebe respostas.
Dúvidas? Entre em contato com o responsável.${phoneBlock}

Obrigado.`;
}

export function formatarLocal(item: Record<string, unknown>): string {
    const setor = String(item?.setorNome || '').trim();
    const corredor = String(item?.corredorNome || '').trim();
    const funcao = String(item?.funcaoNaEscala || '').trim();

    if (corredor && corredor !== setor) {
        return `${setor} → ${corredor}`;
    }

    if (setor) return setor;

    return funcao;
}
