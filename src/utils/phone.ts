export class PhoneValidationError extends Error {
    readonly code = 'telefone_invalido';

    constructor(message: string) {
        super(message);
        this.name = 'PhoneValidationError';
    }
}

export function normalizePhoneDigits(raw: string) {
    const digits = (raw || '').replace(/\D/g, '');
    if (!digits) {
        throw new PhoneValidationError('Telefone inválido: vazio.');
    }

    const phoneDigits = digits.startsWith('55') ? digits : `55${digits}`;

    if (phoneDigits.length < 12 || phoneDigits.length > 13) {
        throw new PhoneValidationError(
            `Telefone inválido: esperado 12–13 dígitos após normalização (com DDI), recebido ${phoneDigits.length}.`
        );
    }

    return phoneDigits;
}

export function normalizePhoneToJid(raw: string) {
    const phoneDigits = normalizePhoneDigits(raw);
    return {
        phoneDigits,
        jid: `${phoneDigits}@s.whatsapp.net`
    };
}

