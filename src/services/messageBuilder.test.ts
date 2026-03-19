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
                lat: -23.4,
                lng: -51.9
            }
        },
        {
            enderecoMaps: {
                name: 'Sede',
                formatted_address: 'Rua Sede, 2',
                lat: -23.5,
                lng: -52.0
            }
        }
    );

    assert.deepEqual(location, {
        name: 'Evento',
        formatted_address: 'Rua Evento, 1',
        lat: -23.4,
        lng: -51.9
    });
});

test('resolveEventLocation falls back to igreja.enderecoMaps when evento location is absent', () => {
    const location = resolveEventLocation(
        { localEvento: null },
        {
            enderecoMaps: {
                name: 'Sede',
                formatted_address: 'Rua Sede, 2',
                lat: -23.5,
                lng: -52.0
            }
        }
    );

    assert.deepEqual(location, {
        name: 'Sede',
        formatted_address: 'Rua Sede, 2',
        lat: -23.5,
        lng: -52.0
    });
});

test('resolveEventLocation returns null when no lat/lng exists', () => {
    const location = resolveEventLocation(
        {
            localEvento: {
                name: 'Evento',
                formatted_address: 'Rua Evento, 1'
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

test('buildAutoMessage uses PUBLIC_URL for maps link when set', () => {
    process.env.TZ = 'America/Sao_Paulo';
    process.env.PUBLIC_URL = 'http://47.79.36.116:3000';

    const message = buildAutoMessage({
        ...baseParams,
        location: {
            name: 'Sitio Primavera',
            formatted_address: 'Rod. PR-317, Km 12, Maringa - PR',
            lat: -23.4,
            lng: -51.9
        }
    });

    assert.match(
        message,
        /\*Função:\* Louvor\n\*Local:\* Sitio Primavera — Rod\. PR-317, Km 12, Maringa - PR\n📍 http:\/\/47\.79\.36\.116:3000\/maps\?lat=-23\.4&lng=-51\.9/
    );

    delete process.env.PUBLIC_URL;
});

test('buildAutoMessage falls back to geo: URI when PUBLIC_URL is not set', () => {
    process.env.TZ = 'America/Sao_Paulo';
    delete process.env.PUBLIC_URL;

    const message = buildAutoMessage({
        ...baseParams,
        location: {
            name: '',
            formatted_address: 'Rua da Sede, 123',
            lat: -23.5,
            lng: -52.0
        }
    });

    assert.match(
        message,
        /\*Função:\* Louvor\n\*Local:\* Rua da Sede, 123\n📍 geo:-23\.5,-52/
    );
});
