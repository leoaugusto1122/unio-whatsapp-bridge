# Story 2026-03-18: Bridge localizacao do evento na mensagem automatica

**Epic:** WhatsApp Automation
**Story ID:** 2026-03-18-bridge-localizacao-evento-mensagem-automatica
**Sprint:** Bootstrap
**Priority:** High
**Points:** 2
**Effort:** 2h
**Status:** Ready for Review
**Type:** Feature

---

## Cross-Story Decisions

| Decision | Source | Impact on This Story |
|----------|--------|----------------------|
| Resolver localizacao no proprio bridge para disparos automaticos | PRD 2026-03-18 | Mantem o app fora do fluxo automatico |
| `POST /send` fica fora de escopo | PRD 2026-03-18 + decisao de implementacao | Nenhuma mudanca de API HTTP nesta story |
| Preservar o template atual da mensagem | Decisao de implementacao | Somente acrescentar linhas de localizacao |
| `lint` continua como debito pre-existente | Analise do repo em 2026-03-18 | Validacao desta story usa `build`, `typecheck` e `test` |

---

## User Story

**Como** igreja que usa automacao WhatsApp,
**Quero** que a mensagem automatica inclua o local correto do evento quando houver URL de mapas,
**Para** orientar o membro sem depender do envio manual pelo app.

---

## Objective

Adicionar a resolucao de localizacao efetiva no scheduler automatico com prioridade para `culto.localEvento` e fallback para `igreja.enderecoMaps`, sem regressao quando os campos estiverem ausentes. A mensagem atual do bridge deve permanecer identica quando nenhuma localizacao estiver configurada.

---

## Tasks

### Phase 1: Story bootstrap

- [x] **1.1** Criar story local em `docs/stories/`
- [x] **1.2** Registrar PRD de 2026-03-18 como fonte canonica e documentar ausencia de `docs/whatsapp-automacao-centralizada.md`

### Phase 2: Message resolution

- [x] **2.1** Adicionar `resolveEventLocation(culto, igreja)` em `src/services/messageBuilder.ts`
- [x] **2.2** Estender `buildAutoMessage` para aceitar `location` opcional
- [x] **2.3** Inserir bloco `*Local:*` + `maps_url` somente quando houver URL valida

### Phase 3: Scheduler integration

- [x] **3.1** Reutilizar `church.data` como fonte de `enderecoMaps`
- [x] **3.2** Resolver localizacao efetiva no scheduler e repassar ao builder
- [x] **3.3** Preservar selecao de sender, agrupamento e marcacoes `notificado*`

### Phase 4: Quality gates

- [x] **4.1** Atualizar `package.json` com `typecheck` e `test`
- [x] **4.2** Adicionar testes automatizados para `resolveEventLocation` e `buildAutoMessage`
- [x] **4.3** Executar `npm run build`
- [x] **4.4** Executar `npm run typecheck`
- [x] **4.5** Executar `npm test`

---

## Acceptance Criteria

```gherkin
GIVEN um culto com `localEvento.maps_url`
WHEN o scheduler montar a mensagem automatica
THEN a localizacao usada deve ser `culto.localEvento`
AND a mensagem deve incluir `*Local:*` e a URL de mapas

GIVEN um culto sem `localEvento.maps_url` e uma igreja com `enderecoMaps.maps_url`
WHEN o scheduler montar a mensagem automatica
THEN a localizacao usada deve ser `igreja.enderecoMaps`
AND a mensagem deve incluir `*Local:*` e a URL de mapas

GIVEN um culto e uma igreja sem URL de mapas
WHEN o scheduler montar a mensagem automatica
THEN a mensagem enviada deve permanecer identica ao template atual
AND o envio nao deve falhar por ausencia de localizacao
```

---

## CodeRabbit Integration

### Story Type Analysis

| Attribute | Value | Rationale |
|-----------|-------|-----------|
| Type | Feature | Altera comportamento do scheduler automatico |
| Complexity | Low | Mudanca localizada em builder, scheduler e testes |
| Test Requirements | Unit | Regras de prioridade e montagem de mensagem sao puramente deterministicas |
| Review Focus | Logic | Prioridade correta e ausencia de regressao textual |

### Agent Assignment

| Role | Agent | Responsibility |
|------|-------|----------------|
| Primary | @dev | Implementar feature e testes |
| Secondary | @sm | Manter story local consistente |
| Review | @qa | Validar prioridade e regressao |

### Focus Areas

- [x] Prioridade `localEvento` sobre `enderecoMaps`
- [x] Nenhuma regressao no texto quando `location` for nulo
- [x] Nenhuma mudanca de comportamento em `POST /send`

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Alterar texto atual da mensagem sem necessidade | Medium | Teste de snapshot textual com `location: null` |
| Ler documento adicional da igreja sem necessidade | Low | Reusar `church.data` ja carregado |
| Interpretar docs ausentes como requisito | Low | Tratar o PRD de 2026-03-18 como referencia canonica |

---

## Definition of Done

- [x] Acceptance criteria verificados
- [x] `npm run build` concluido
- [x] `npm run typecheck` concluido
- [x] `npm test` concluido
- [x] Story atualizada com checklist e file list
- [x] Debito de `lint` registrado como fora de escopo desta story

---

## Dev Notes

### Source of truth

- PRD do usuario datado de 2026-03-18 nesta conversa
- O arquivo `docs/whatsapp-automacao-centralizada.md` nao existe neste workspace

### Key Files

```text
src/services/messageBuilder.ts
src/services/scheduler.ts
package.json
```

### Technical Notes

- Nao criar nova leitura de `igrejas/{igrejaId}` no scheduler.
- Nao alterar o endpoint `POST /send`.
- A localizacao e opcional; ausencia dos campos nao deve interromper o envio.

### Testing Checklist

#### Resolution priority
- [x] Usa `culto.localEvento` quando presente
- [x] Usa `igreja.enderecoMaps` como fallback
- [x] Retorna `null` quando nenhuma URL existir

#### Message rendering
- [x] Mantem a mensagem atual quando `location` for nulo
- [x] Renderiza `name + formatted_address` quando houver `name`
- [x] Renderiza apenas `formatted_address` quando `name` estiver vazio

#### Validation
- [x] `npm run build`
- [x] `npm run typecheck`
- [x] `npm test`

---

## Dev Agent Record

### Execution Log

| Timestamp | Phase | Action | Result |
|-----------|-------|--------|--------|
| 2026-03-18 | Bootstrap | Story criada a partir do PRD | Done |
| 2026-03-18 | Message resolution | `resolveEventLocation` e renderizacao opcional de localizacao adicionados ao builder | Done |
| 2026-03-18 | Scheduler integration | Scheduler passou a reutilizar `church.data` e enviar `location` ao builder | Done |
| 2026-03-18 | Quality gates | `npm run build`, `npm run typecheck` e `npm test` executados com sucesso | Done |

### Completion Notes

- `buildAutoMessage` agora aceita `location` opcional e adiciona `*Local:*` + `maps_url` somente quando houver URL valida.
- `resolveEventLocation(culto, igreja)` aplica a prioridade `culto.localEvento` -> `igreja.enderecoMaps` -> `null`.
- O scheduler automatico reutiliza `church.data` para `enderecoMaps` e nao faz leitura extra da igreja.
- `POST /send` permaneceu inalterado.
- O script `test` usa execucao direta do arquivo compilado porque `node --test` falhou neste ambiente com `spawn EPERM`.
- `lint` continua como debito pre-existente fora de escopo desta story.

### File List

- docs/stories/2026-03-18-bridge-localizacao-evento-mensagem-automatica.md
- package.json
- src/services/messageBuilder.ts
- src/services/messageBuilder.test.ts
- src/services/scheduler.ts

### Change Log

- 2026-03-18: Story criada para implementar localizacao opcional na mensagem automatica do scheduler.
- 2026-03-18: Builder e scheduler atualizados para resolver localizacao efetiva com fallback para a sede.
- 2026-03-18: Testes automatizados adicionados para prioridade e regressao textual da mensagem.
