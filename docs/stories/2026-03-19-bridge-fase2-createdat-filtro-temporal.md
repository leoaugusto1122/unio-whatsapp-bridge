# Story 2026-03-19: Bridge fase 2 do filtro temporal com createdAt

**Epic:** WhatsApp Automation
**Story ID:** 2026-03-19-bridge-fase2-createdat-filtro-temporal
**Sprint:** Bootstrap
**Priority:** High
**Points:** 3
**Effort:** 4h
**Status:** Ready for Review
**Type:** Performance

---

## Cross-Story Decisions

| Decision | Source | Impact on This Story |
|----------|--------|----------------------|
| `createdAt` vira a source of truth da fila | PRD 2026-03-19 Fase 2 | Remove dependencia operacional de `dataCulto` para itens novos |
| Fallback legado por `dataCulto` dura 15 dias | Decisao de rollout | Mantem cobertura para itens antigos sem `createdAt` |
| Sem flag de runtime para ligar/desligar fallback | PRD 2026-03-19 Fase 2 | Cleanup vira etapa posterior e simplifica o bridge |
| `lint` continua indisponivel no repo | Analise local de `package.json` | Validacao usa `typecheck` e `test` |

---

## User Story

**Como** operador do bridge de automacao,
**Quero** que a fila use `createdAt` como filtro principal,
**Para** evitar falsos negativos causados por mudancas retroativas em `dataCulto`.

---

## Objective

Migrar a fila de `items` para `createdAt >= cutoff`, mantendo um fallback temporario por `dataCulto` apenas para documentos legados sem `createdAt`, com dedupe, limite total preservado e logs explicitos do modo de filtro usado em cada ciclo.

---

## Tasks

### Phase 1: Story bootstrap

- [x] **1.1** Criar story local para a Fase 2
- [x] **1.2** Registrar a estrategia de rollout `createdAt` principal + fallback legado temporario

### Phase 2: Scheduler refinement

- [x] **2.1** Trocar a query principal para `createdAt >= cutoff`
- [x] **2.2** Adicionar fallback por `dataCulto` quando a query principal nao preencher o limite
- [x] **2.3** Deduplicar por `ref.path` e ignorar no fallback docs com `createdAt` valido
- [x] **2.4** Logar `filterMode` no ciclo e `[Scheduler] Processados X itens (Filtro: ...)`

### Phase 3: Docs and quality

- [x] **3.1** Atualizar README/OPERATIONS com `createdAt` como source of truth
- [x] **3.2** Atualizar testes do scheduler para dual-query e dedupe
- [x] **3.3** Executar `npm run typecheck`
- [x] **3.4** Executar `npm test`

---

## Acceptance Criteria

```gherkin
GIVEN novos `items` com `createdAt`
WHEN a fila for consultada
THEN o filtro principal deve usar `createdAt >= cutoff`
AND o item deve ser elegivel mesmo que `dataCulto` nao represente sua criacao real

GIVEN `items` legados sem `createdAt`
WHEN a query principal nao preencher o limite
THEN o fallback por `dataCulto` deve ser executado
AND apenas documentos sem `createdAt` valido devem entrar por esse caminho

GIVEN um documento retornado nas duas consultas
WHEN a fila consolidar os resultados
THEN ele deve aparecer apenas uma vez no ciclo
AND o total final deve respeitar `limit(10)`
```

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Falta do novo indice `notificado + createdAt` | High | Documentar criacao manual e deixar o indice legado apenas como transicao |
| Itens legados mascararem cobertura da Fase 2 | Medium | Limitar o fallback aos docs sem `createdAt` valido |
| Cleanup atrasar e manter custo extra do fallback | Medium | Registrar explicitamente a janela de 15 dias e o indice legado como temporarios |

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

- PRD do usuario datado de 2026-03-19 para a Fase 2
- Implementacao existente da Fase 1 no bridge

### Key Files

```text
src/services/scheduler.ts
src/services/scheduler.test.ts
README.md
```

### Technical Notes

- Nao adicionar backfill de `createdAt` no bridge.
- O fallback legado existe apenas para docs sem `createdAt` valido.
- O indice `notificado + dataCulto` passa a ser temporario e removivel apos estabilidade da Fase 2.

### Testing Checklist

- [x] Query principal com `createdAt >= cutoff`
- [x] Fallback por `dataCulto` usa apenas a capacidade restante
- [x] Dedupe por `ref.path`
- [x] Docs com `createdAt` ficam fora do fallback

---

## Dev Agent Record

### Execution Log

| Timestamp | Phase | Action | Result |
|-----------|-------|--------|--------|
| 2026-03-19 | Bootstrap | Story da Fase 2 criada a partir do PRD | Done |
| 2026-03-19 | Scheduler refinement | Filtro principal migrado para `createdAt` com fallback legado temporario | Done |
| 2026-03-19 | Quality gates | `npm run typecheck` e `npm test` executados com sucesso | Done |

### Completion Notes

- A fila agora usa `createdAt` como filtro principal e so cai para `dataCulto` quando faltam itens para completar o batch.
- O fallback legado aceita apenas docs sem `createdAt` valido e evita duplicidade por `ref.path`.
- O scheduler passou a registrar o `filterMode` no log estruturado e no log operacional de itens processados.
- `lint` segue como debito do repo porque `package.json` nao define esse script.

### File List

- docs/stories/2026-03-19-bridge-fase2-createdat-filtro-temporal.md
- OPERATIONS.md
- README.md
- src/services/scheduler.test.ts
- src/services/scheduler.ts

### Change Log

- 2026-03-19: Fase 2 implementada com `createdAt` como filtro principal e fallback legado temporario por `dataCulto`.
