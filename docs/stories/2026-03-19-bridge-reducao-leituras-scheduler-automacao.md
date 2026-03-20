# Story 2026-03-19: Bridge reducao de leituras do scheduler de automacao

**Epic:** WhatsApp Automation
**Story ID:** 2026-03-19-bridge-reducao-leituras-scheduler-automacao
**Sprint:** Bootstrap
**Priority:** High
**Points:** 5
**Effort:** 1d
**Status:** Ready for Review
**Type:** Performance

---

## Cross-Story Decisions

| Decision | Source | Impact on This Story |
|----------|--------|----------------------|
| Migrar de polling por escala para fila unica em `collectionGroup('items')` | PRD 2026-03-19 | Reduz a explosao de leituras vazias |
| Filtro de 24h usara `dataCulto` como aproximacao na fase 1 | PRD 2026-03-19 | Evita inventar schema no bridge |
| `createdAt` fica para fase 2 no produtor dos `items` | Decisao de implementacao | Bridge continua correto semanticamente apenas por aproximacao nesta entrega |
| `lint` continua indisponivel no repo | Analise local de `package.json` | Validacao usa `typecheck` e `test` |

---

## User Story

**Como** operador do bridge de automacao,
**Quero** reduzir consultas desperdicadas do scheduler no Firestore,
**Para** diminuir o custo diario sem alterar as rotas publicas do servico.

---

## Objective

Trocar o job de notificacoes baseado em consulta por escala por uma fila unica em `collectionGroup('items')`, com smart-delay, `limit(10)`, filtro temporal aproximado de 24h e logs operacionais explicitos para ciclos vazios e ciclos ativos.

---

## Tasks

### Phase 1: Story bootstrap

- [x] **1.1** Criar story local em `docs/stories/`
- [x] **1.2** Registrar as decisoes de fase 1 vs fase 2 para `createdAt`

### Phase 2: Scheduler refactor

- [x] **2.1** Substituir o cron principal por loop adaptativo com `setTimeout`
- [x] **2.2** Implementar helper de fila com `collectionGroup('items')`, `limit(10)` e janela de 24h
- [x] **2.3** Reagrupar `items` por igreja/escala/membro preservando as marcacoes `notificado*`
- [x] **2.4** Adicionar logs textual e estruturado do ciclo

### Phase 3: Docs and quality

- [x] **3.1** Atualizar README/OPERATIONS com novos env vars e indexes manuais
- [x] **3.2** Adicionar testes do scheduler
- [x] **3.3** Executar `npm run typecheck`
- [x] **3.4** Executar `npm test`

---

## Acceptance Criteria

```gherkin
GIVEN um ciclo sem `items` pendentes no collection group
WHEN o scheduler rodar
THEN ele deve logar "Nenhum item encontrado. Aguardando 5 min..."
AND deve reagendar o proximo ciclo para 5 minutos

GIVEN um ciclo com `items` pendentes
WHEN o scheduler rodar
THEN ele deve consultar no maximo 10 documentos
AND deve reagendar o proximo ciclo para 1 minuto

GIVEN itens fora da janela temporal aproximada de 24 horas
WHEN a fila for consultada
THEN esses itens nao devem entrar no processamento
AND nao devem ser mutados como expirados nesta fase
```

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Falta do indice de `collectionGroup('items')` | High | Documentar criacao manual em `OPERATIONS.md` e `README.md` |
| `dataCulto` nao representar criacao real do item | Medium | Registrar explicitamente como aproximacao de fase 1 |
| Sobreposicao de execucoes no loop adaptativo | Medium | Manter guarda de single-flight e teste dedicado |

---

## Definition of Done

- [x] Acceptance criteria verificados
- [x] `npm run typecheck` concluido
- [x] `npm test` concluido
- [x] Story atualizada com checklist e file list
- [x] Debito de `lint` registrado

---

## Dev Notes

### Source of truth

- PRD do usuario datado de 2026-03-19 nesta conversa
- Logs de query performance do Firestore compartilhados pelo usuario

### Key Files

```text
src/services/scheduler.ts
src/services/scheduler.test.ts
OPERATIONS.md
```

### Technical Notes

- Nao alterar rotas HTTP.
- Nao marcar itens antigos como expirados nesta fase.
- Continuar usando `dataCulto` apenas como corte operacional temporario ate existir `createdAt`.

### Testing Checklist

- [x] Delay idle de 5 minutos em ciclo vazio
- [x] Delay ativo de 1 minuto em ciclo com itens
- [x] `limit(10)` e cutoff temporal aplicados na query
- [x] Guarda `jobRunning` evita sobreposicao

---

## Dev Agent Record

### Execution Log

| Timestamp | Phase | Action | Result |
|-----------|-------|--------|--------|
| 2026-03-19 | Bootstrap | Story criada a partir do PRD de reducao de leituras | Done |
| 2026-03-19 | Scheduler refactor | Scheduler migrado para fila unica com loop adaptativo e query limitada | Done |
| 2026-03-19 | Quality gates | `npm run typecheck` e `npm test` executados com sucesso | Done |

### Completion Notes

- O scheduler principal agora consulta `collectionGroup('items')` com `notificado == false`, `dataCulto >= cutoff` e `limit(10)`.
- O loop adaptativo executa imediatamente no boot, volta em 5 minutos quando a fila esta vazia e em 1 minuto quando encontra itens.
- Os crons de monitor do pool e reset diario foram preservados.
- `lint` segue como debito do repo porque `package.json` nao define esse script.

### File List

- docs/stories/2026-03-19-bridge-reducao-leituras-scheduler-automacao.md
- OPERATIONS.md
- README.md
- package.json
- src/services/scheduler.test.ts
- src/services/scheduler.ts

### Change Log

- 2026-03-19: Story criada para migrar o scheduler de notificacoes para fila unica com smart-delay.
- 2026-03-19: Scheduler refatorado para `collectionGroup('items')`, loop adaptativo e testes dedicados.
