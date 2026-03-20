import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAutoMessage, normalizeSegmento, resolveEventLocation, resolveGreeting } from './messageBuilder.js';

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

test('buildAutoMessage keeps the body and confirmation link while varying the greeting', () => {
    process.env.TZ = 'America/Sao_Paulo';

    const message = buildAutoMessage({
        ...baseParams,
        location: null,
        segmento: 'igreja',
        randomFn: () => 0
    });

    assert.equal(
        message,
        `Olá, irmão *Nome*.

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

test('buildAutoMessage puts location block after confirmation link', () => {
    process.env.TZ = 'America/Sao_Paulo';

    const message = buildAutoMessage({
        ...baseParams,
        location: {
            name: 'Sitio Primavera',
            formatted_address: 'Rod. PR-317, Km 12, Maringa - PR',
            lat: -23.4,
            lng: -51.9
        },
        segmento: 'igreja',
        randomFn: () => 0
    });

    const confirmIdx = message.indexOf('unioescala.web.app');
    const mapsIdx = message.indexOf('maps.google.com');
    assert.ok(confirmIdx < mapsIdx, 'confirmation link should precede maps URL');

    assert.match(
        message,
        /https:\/\/unioescala\.web\.app\/confirmar\?token=TOKEN\n\*Local:\* Sitio Primavera - Rod\. PR-317, Km 12, Maringa - PR\n📍 https:\/\/maps\.google\.com\/\?q=-23\.4,-51\.9/
    );
});

test('buildAutoMessage appends church location block when fallback location is used', () => {
    process.env.TZ = 'America/Sao_Paulo';

    const message = buildAutoMessage({
        ...baseParams,
        location: {
            name: '',
            formatted_address: 'Rua da Sede, 123',
            lat: -23.5,
            lng: -52.0
        },
        segmento: 'igreja',
        randomFn: () => 0
    });

    assert.match(
        message,
        /https:\/\/unioescala\.web\.app\/confirmar\?token=TOKEN\n\*Local:\* Rua da Sede, 123\n📍 https:\/\/maps\.google\.com\/\?q=-23\.5,-52/
    );
});

test('normalizeSegmento maps igreja and empty values to religious greetings', () => {
    assert.equal(normalizeSegmento('igreja'), 'igreja');
    assert.equal(normalizeSegmento(''), 'igreja');
    assert.equal(normalizeSegmento(undefined), 'igreja');
});

test('normalizeSegmento maps any non-igreja value to neutral greetings', () => {
    assert.equal(normalizeSegmento('empresa'), 'neutro');
    assert.equal(normalizeSegmento('staff'), 'neutro');
    assert.equal(normalizeSegmento('empresa_staff'), 'neutro');
    assert.equal(normalizeSegmento('outro'), 'neutro');
});

test('resolveGreeting uses religious set for igreja', () => {
    const greeting = resolveGreeting('igreja', {
        randomFn: () => 0,
        now: new Date('2026-03-22T10:00:00.000Z'),
        timeZone: 'America/Sao_Paulo'
    });

    assert.equal(greeting, 'Olá, irmão');
});

test('resolveGreeting uses neutral greetings for non-igreja values', () => {
    const greeting = resolveGreeting('empresa', {
        randomFn: () => 0.3,
        now: new Date('2026-03-22T10:00:00.000Z'),
        timeZone: 'America/Sao_Paulo'
    });

    assert.equal(greeting, 'Oi,');
});

test('resolveGreeting falls back from Boa tarde to Olá outside the compatible hour', () => {
    const greeting = resolveGreeting('staff', {
        randomFn: () => 0.99,
        now: new Date('2026-03-22T10:00:00.000Z'),
        timeZone: 'America/Sao_Paulo'
    });

    assert.equal(greeting, 'Olá,');
});
