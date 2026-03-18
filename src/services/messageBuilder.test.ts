import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAutoMessage, resolveEventLocation } from './messageBuilder.js';

const baseParams = {
    nomeDoMembro: 'Nome',
    nomeIgreja: 'Igreja',
    nomeCulto: 'Culto',
    nomeEscala: 'Escala',
    dataHoraCulto: new Date('2026-03-22T22:00:00.000Z'),
    local: 'Louvor',
    token: 'TOKEN'
};

test('resolveEventLocation prioritizes culto.localEvento over igreja.enderecoMaps', () => {
    const location = resolveEventLocation(
        {
            localEvento: {
                name: 'Evento',
                formatted_address: 'Rua Evento, 1',
                maps_url: 'https://maps.example/evento'
            }
        },
        {
            enderecoMaps: {
                name: 'Sede',
                formatted_address: 'Rua Sede, 2',
                maps_url: 'https://maps.example/sede'
            }
        }
    );

    assert.deepEqual(location, {
        name: 'Evento',
        formatted_address: 'Rua Evento, 1',
        maps_url: 'https://maps.example/evento'
    });
});

test('resolveEventLocation falls back to igreja.enderecoMaps when evento location is absent', () => {
    const location = resolveEventLocation(
        { localEvento: null },
        {
            enderecoMaps: {
                name: 'Sede',
                formatted_address: 'Rua Sede, 2',
                maps_url: 'https://maps.example/sede'
            }
        }
    );

    assert.deepEqual(location, {
        name: 'Sede',
        formatted_address: 'Rua Sede, 2',
        maps_url: 'https://maps.example/sede'
    });
});

test('resolveEventLocation returns null when no valid maps url exists', () => {
    const location = resolveEventLocation(
        {
            localEvento: {
                name: 'Evento',
                formatted_address: 'Rua Evento, 1',
                maps_url: '   '
            }
        },
        {
            enderecoMaps: {
                name: 'Sede',
                formatted_address: 'Rua Sede, 2'
            }
        }
    );

    assert.equal(location, null);
});

test('buildAutoMessage preserves the current message when location is null', () => {
    process.env.TZ = 'America/Sao_Paulo';

    const message = buildAutoMessage({ ...baseParams, location: null });

    assert.equal(
        message,
        `Olá, *Nome*.

Você está escalado(a) para:
🏛 *Igreja*
*EVENTO:* Culto
*ESCALA:* Escala

*Data:* Domingo, 22/03/2026
*Horário:* 19:00
*Função:* Louvor

✅ *Confirme sua presença pelo link abaixo:*
https://unioescala.web.app/confirmar?token=TOKEN

Obrigado!`
    );
});

test('buildAutoMessage appends event location block when localEvento wins', () => {
    process.env.TZ = 'America/Sao_Paulo';

    const message = buildAutoMessage({
        ...baseParams,
        location: {
            name: 'Sitio Primavera',
            formatted_address: 'Rod. PR-317, Km 12, Maringa - PR',
            maps_url: 'https://maps.example/evento'
        }
    });

    assert.match(
        message,
        /\*Função:\* Louvor\n\*Local:\* Sitio Primavera — Rod\. PR-317, Km 12, Maringa - PR\n📍 https:\/\/maps\.example\/evento/
    );
});

test('buildAutoMessage appends church location block when fallback location is used', () => {
    process.env.TZ = 'America/Sao_Paulo';

    const message = buildAutoMessage({
        ...baseParams,
        location: {
            name: '',
            formatted_address: 'Rua da Sede, 123',
            maps_url: 'https://maps.example/sede'
        }
    });

    assert.match(
        message,
        /\*Função:\* Louvor\n\*Local:\* Rua da Sede, 123\n📍 https:\/\/maps\.example\/sede/
    );
});
