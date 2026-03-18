function getTimeZone() {
    return process.env.TZ || 'America/Sao_Paulo';
}

function capitalizeFirst(text: string) {
    if (!text) return text;
    return text.charAt(0).toUpperCase() + text.slice(1);
}

export type MessageParams = {
    nomeDoMembro: string;
    nomeIgreja: string;
    nomeCulto: string;
    nomeEscala: string;
    dataHoraCulto: Date;
    local: string;
    token: string;
};

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

    return `Olá, *${params.nomeDoMembro}*.

Você está escalado(a) para:
🏛 *${params.nomeIgreja}*
*EVENTO:* ${params.nomeCulto}
*ESCALA:* ${params.nomeEscala}

*Data:* ${diaSemana}, ${data}
*Horário:* ${horario}
*Função:* ${params.local}

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
