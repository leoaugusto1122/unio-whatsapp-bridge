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
            ? `${resolved.name} — ${address}`
            : resolved.name
        : address;

    if (!label) {
        return `\n📍 ${mapsUrl}`;
    }

    return `\n*Local:* ${label}\n📍 ${mapsUrl}`;
}

export function buildAutoMessage(params: MessageParams): string {
    const timeZone = getTimeZone();

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

    return `Olá, *${params.nomeDoMembro}*.

Você está escalado(a) para:
🏛 *${params.nomeIgreja}*
*EVENTO:* ${params.nomeCulto}
*ESCALA:* ${params.nomeEscala}

*Data:* ${diaSemana}, ${data}
*Horário:* ${horario}
*Função:* ${params.local}${locationBlock}

✅ *Confirme sua presença pelo link abaixo:*
${linkConfirmacao}

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
