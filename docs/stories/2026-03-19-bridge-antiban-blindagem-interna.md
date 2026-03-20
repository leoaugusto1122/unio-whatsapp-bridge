# Story 2026-03-19: Bridge blindagem antiban e agrupamento interno

**Epic:** WhatsApp Automation
**Story ID:** 2026-03-19-bridge-antiban-blindagem-interna
**Sprint:** Bootstrap
**Priority:** High
**Points:** 5
**Effort:** 1d
**Status:** Ready for Review
**Type:** Reliability

---

## Cross-Story Decisions

| Decision | Source | Impact on This Story |
|----------|--------|----------------------|
| O agrupamento continua restrito a `churchId + escalaId + membroId` | PRD 4 | Evita mistura de igrejas e preserva o link de confirmacao por escala |
| `igrejas.segmento` define apenas o tipo de saudacao | Confirmacao do usuario via App Expo | O corpo da mensagem permanece intacto |
| `igreja` ou vazio usam saudacoes religiosas | Confirmacao do usuario | Cadastros antigos continuam no comportamento esperado |
| Qualquer outro valor usa saudacoes neutras | Confirmacao do usuario | `empresa`, `staff`, `empresa_staff`, `outro` e labels futuros nao quebram a regra |
| Presence sera enviado pelo contrato oficial do `sendText` da Evolution (`options.presence` + `options.delay`) | Verificacao tecnica desta entrega | Blindagem antiban nao depende de endpoint extra nao comprovado |
| `lint` continua indisponivel no repo | Analise local de `package.json` | Validacao usa `typecheck` e `test`, com debito registrado |

---

## User Story

**Como** operador do bridge central de WhatsApp,
**Quero** que os envios simulem comportamento humano e respeitem limites de vazao por chip,
**Para** reduzir o risco de bloqueio do numero central sem alterar a regra de negocio das escalas.

---

## Objective

Adicionar blindagem antiban no envio automatico com `presence: "composing"`, atraso de digitacao, jitter entre mensagens, limite horario por numero do pool e saudacoes variaveis por `igrejas.segmento`, mantendo o agrupamento estritamente por igreja e escala.

---

## Tasks

### Phase 1: Story bootstrap

- [x] **1.1** Criar story local para o PRD 4
- [x] **1.2** Registrar a decisao de usar `sendText.options.presence` como contrato suportado da Evolution

### Phase 2: Antiban transport and pool

- [x] **2.1** Serializar envios por `instanceId`
- [x] **2.2** Adicionar `presence: "composing"` e `delay` no envio para a Evolution API
- [x] **2.3** Tornar jitter configuravel em `15s-30s`
- [x] **2.4** Persistir contador horario antiban no Firestore
- [x] **2.5** Reservar slot horario antes do envio e bloquear numeros acima de `80/h`

### Phase 3: Scheduler and template

- [x] **3.1** Manter agrupamento por `churchId + escalaId + membroId`
- [x] **3.2** Passar `church.data.segmento` para o builder sem leitura extra
- [x] **3.3** Variar apenas a saudacao inicial por segmento
- [x] **3.4** Preservar corpo, ordem dos blocos e link de confirmacao

### Phase 4: Docs and quality

- [x] **4.1** Atualizar README e OPERATIONS com envs, logs e monitoramento antiban
- [x] **4.2** Adicionar testes para greetings, presence/jitter e capacidade horaria
- [x] **4.3** Executar `npm run lint` e registrar o debito do script ausente
- [x] **4.4** Executar `npm run typecheck`
- [x] **4.5** Executar `npm test`

---

## Acceptance Criteria

```gherkin
GIVEN varios itens do mesmo `membroId` dentro da mesma `escalaId`
WHEN o scheduler montar o envio
THEN deve gerar apenas uma mensagem para aquele membro
AND o link de confirmacao daquela escala deve permanecer inalterado

GIVEN envios consecutivos do mesmo `instanceId`
WHEN o bridge chamar a Evolution API
THEN cada mensagem deve incluir `presence: "composing"` e um `delay` de digitacao
AND o mesmo numero deve respeitar jitter entre mensagens mesmo vindo de batches diferentes

GIVEN um numero do pool com 80 mensagens reservadas na janela de 60 minutos
WHEN o scheduler tentar usar esse numero novamente
THEN ele deve ser bloqueado para esse ciclo
AND o bridge deve tentar outro remetente elegivel
```

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| O mesmo numero disparar batches paralelos sem pacing unico | High | Fila serial por `instanceId` em `evolution.ts` |
| Bloqueio horario gerar falso `no sender` | Medium | Reserva transacional com log estruturado por numero bloqueado |
| Saudacao dinamica alterar o corpo da mensagem | Medium | Variar apenas a primeira linha e manter testes do corpo/link |
| Ausencia de script `lint` esconder debito de qualidade | Low | Registrar explicitamente o debito na story e no fechamento |

---

## Definition of Done

- [x] Acceptance criteria verificados
- [x] `npm run lint` executado e debito registrado
- [x] `npm run typecheck` concluido
- [x] `npm test` concluido
- [x] Story atualizada com checklist e file list

---

## Dev Notes

### Source of truth

- PRD 4 fornecido pelo usuario em 2026-03-19
- Confirmacao do usuario sobre `igrejas.segmento`

### Key Files

```text
src/services/evolution.ts
src/services/pool.ts
src/services/firestore.ts
src/services/messageBuilder.ts
src/services/scheduler.ts
```

### Technical Notes

- A blindagem usa o contrato oficial do `sendText` da Evolution com `options.presence` e `options.delay`.
- O campo `igrejas.segmento` so altera a saudacao inicial.
- O contador horario fica em `whatsappPool.antiBan`.
- O limite horario e por numero do pool, nao por igreja.

### Testing Checklist

- [x] `presence` e `delay` no payload de envio
- [x] fila serial por `instanceId`
- [x] saudacoes religiosas e neutras por segmento
- [x] agrupamento de itens por `membroId` dentro da mesma escala
- [x] calculo de capacidade horaria

---

## Dev Agent Record

### Execution Log

| Timestamp | Phase | Action | Result |
|-----------|-------|--------|--------|
| 2026-03-19 | Bootstrap | Story do PRD 4 criada a partir do plano do usuario | Done |
| 2026-03-19 | Transport | `sendText` passou a usar `presence` + `delay` com fila serial por `instanceId` | Done |
| 2026-03-19 | Pool | Limite horario persistido e reserva de slots adicionados ao fluxo de selecao de remetente | Done |
| 2026-03-19 | Quality gates | `npm run lint` falhou por script ausente; `npm run typecheck` e `npm test` passaram | Done |

### Completion Notes

- O bridge agora simula digitacao usando `presence: "composing"` e atraso configuravel no proprio envio para a Evolution.
- A cadencia do mesmo numero foi centralizada em uma fila serial por `instanceId`, com jitter configuravel entre mensagens.
- O pool passou a bloquear numeros que estourarem `80/h` e registra eventos estruturados de reserva e bloqueio.
- A mensagem automatica varia apenas a saudacao inicial com base em `igrejas.segmento`.
- `npm run lint` continua indisponivel porque o repo nao define esse script.

### File List

- docs/stories/2026-03-19-bridge-antiban-blindagem-interna.md
- OPERATIONS.md
- README.md
- package.json
- src/routes/admin.ts
- src/routes/send.ts
- src/services/evolution.test.ts
- src/services/evolution.ts
- src/services/firestore.ts
- src/services/messageBuilder.test.ts
- src/services/messageBuilder.ts
- src/services/pool.test.ts
- src/services/pool.ts
- src/services/scheduler.test.ts
- src/services/scheduler.ts

### Change Log

- 2026-03-19: Blindagem antiban implementada com `presence`, `delay`, jitter configuravel e limite horario por numero.
