# Pool Centralizado de Números — Changelog de Implementação

**Data:** 2026-03-18
**Branch:** main
**Commits base:** eb12706 (Group scheduler notifications by member)

---

## Visão Geral

Refatoração do bridge de proxy simples para gerenciador de pool centralizado de números WhatsApp. O gestor da igreja não conecta mais nenhum número — o Unio mantém um pool próprio de instâncias na Evolution API e distribui a carga automaticamente.

---

## Dependências Adicionadas

| Pacote | Versão | Motivo |
|---|---|---|
| `express` | ^5.x | Framework HTTP para suportar 10+ rotas |
| `@types/express` | ^5.x | Tipos TypeScript para Express |

---

## Arquivos Criados

### `src/middleware/auth.ts`
Middleware de autenticação padrão. Aceita `apikey` header ou `Authorization: Bearer <token>`. Lê a chave de `API_KEY` (ou `EVOLUTION_API_KEY` como fallback).

### `src/middleware/adminAuth.ts`
Middleware de autenticação extra para endpoints `/admin/*`. Valida o header `x-admin-key` contra a variável de ambiente `ADMIN_KEY`.

### `src/services/pool.ts`
Serviço de seleção de número do pool.

**Função exportada:** `selectSenderForChurch(churchId)`

Algoritmo:
1. Busca todos os números com `status === "connected"` no Firestore
2. Filtra números com `messagesToday >= MAX_DAILY_PER_NUMBER`
3. Ordena por `messagesToday ASC`
4. Tie-break: `lastUsedAt ASC` (round-robin)
5. Retorna o primeiro, ou `null` se nenhum disponível

### `src/services/messageBuilder.ts`
Montagem do template de mensagem automática. Extraído do `scheduler.ts`.

**Funções exportadas:**
- `buildAutoMessage(params)` — retorna string com o template do PRD (usando `*negrito*` do WhatsApp)
- `formatarLocal(item)` — formata setor + corredor do item de escala

### `src/routes/health.ts`
`GET /health` — sem autenticação. Retorna `ok`, `service`, `version`, `commit`.

### `src/routes/send.ts`
`POST /send` — autenticação padrão.

Mudança de comportamento: ao invés de usar a instância da igreja, chama `selectSenderForChurch(churchId)` para obter um número do pool. Se nenhum disponível, retorna `503` com `reason: "no_sender_available"`.

### `src/routes/automation.ts`
Três endpoints — autenticação padrão:

| Método | Path | Função |
|---|---|---|
| POST | `/automation/register` | Habilita automação (`whatsappAutomation.enabled = true`). Retorna `registered: false` se pool vazio. |
| POST | `/automation/unregister` | Desabilita automação (`enabled = false`). |
| GET | `/automation/status/:churchId` | Retorna `active` e `serviceStatus` (`operational` / `degraded` / `unavailable`). |

### `src/routes/admin.ts`
Cinco endpoints — autenticação padrão + `x-admin-key`:

| Método | Path | Função |
|---|---|---|
| GET | `/admin/pool` | Lista todos os números com resumo (`total`, `connected`, `disconnected`). |
| POST | `/admin/pool/add` | Cria instância na Evolution API e registra no Firestore. Retorna QR code. |
| GET | `/admin/pool/:numberId/qr` | Regenera QR code de um número. |
| DELETE | `/admin/pool/:numberId` | Faz logout na Evolution API e remove do Firestore. |
| GET | `/admin/pool/:numberId/status` | Verifica estado em tempo real e sincroniza com Firestore. |

---

## Arquivos Modificados

### `src/server.ts`
- **Migrado** de `node:http` raw para Express
- Todas as rotas registradas com middleware de auth
- `/sync/:churchId` mantido para backward compatibility
- Logger de requests adicionado via middleware

### `src/services/evolution.ts`
Quatro funções novas:

| Função | Evolution API endpoint | Descrição |
|---|---|---|
| `createInstance(instanceName)` | `POST /instance/create` | Cria instância com QR code |
| `getQRCode(instanceName)` | `GET /instance/connect/:name` | Regenera QR code |
| `deleteInstance(instanceName)` | `DELETE /instance/delete/:name` | Logout e remoção |
| `checkNumberOnWhatsApp(instanceName, phone)` | `POST /chat/whatsappNumbers/:name` | Verifica se número existe no WhatsApp |

`getInstanceStatus` atualizado: campo `churchId` renomeado para `instanceName` no retorno.

### `src/services/firestore.ts`
**Tipo `ChurchWhatsappAutomation` atualizado:**
- `connected` mantido como deprecated (usado pelo `connection-sync.ts`)
- Adicionado `advanceType: 'hours' | 'days'` e `advanceValue: number` (novo formato do PRD)
- `advanceHours` marcado como deprecated

**Nova coleção `whatsappPool` — tipo `PoolNumber`:**
```
whatsappPool/{numberId}
├── phoneNumber: string
├── instanceId: string
├── status: "connected" | "disconnected" | "banned"
├── addedAt: string (ISO)
├── connectedAt: string | null
├── lastUsedAt: string | null
├── messagesToday: number
├── totalMessages: number
└── notes: string
```

**Novas funções exportadas:**
- `addPoolNumber(data)` → `string` (numberId)
- `getPoolNumber(numberId)` → `PoolNumber | null`
- `listPoolNumbers()` → `PoolNumber[]`
- `listConnectedPoolNumbers()` → `PoolNumber[]`
- `updatePoolNumber(numberId, fields)`
- `deletePoolNumber(numberId)`
- `incrementNumberMessageCount(numberId)` — incrementa `messagesToday`, `totalMessages`, `lastUsedAt`
- `resetDailyMessageCounts()` — zera `messagesToday` de todos os números (job 00:00)

**`listEnabledChurches` atualizado:** removida a condição `connected === true`. Agora retorna todas as igrejas com `enabled === true`.

### `src/services/scheduler.ts`
**Mudanças principais:**

1. **Pool ao invés de instância da igreja:** `sendBatchText(churchId, ...)` → `sendBatchText(sender.instanceId, ...)` onde `sender` vem de `selectSenderForChurch(churchId)`

2. **Sem sync de conexão por igreja:** removida a chamada a `syncChurchConnectionStatus` no loop do batch job. A saúde do pool é monitorada separadamente.

3. **`resolveAdvanceHours`:** suporta novo formato `advanceType + advanceValue` com fallback para `advanceHours` antigo.

4. **`incrementNumberMessageCount`:** chamado para cada mensagem enviada com sucesso.

5. **Dois novos cron jobs:**
   - `*/15 * * * *` — `monitorPool()`: verifica estado de conexão de cada número e sincroniza com Firestore
   - `0 0 * * *` — `resetDailyMessageCounts()`: zera `messagesToday` à meia-noite

6. **`buildAutoMessage` / `formatarLocal`:** extraídos para `messageBuilder.ts`.

---

## Variáveis de Ambiente Novas

| Variável | Descrição | Padrão |
|---|---|---|
| `ADMIN_KEY` | Chave extra para endpoints `/admin/*` | — (obrigatória para usar admin) |
| `MAX_DAILY_PER_NUMBER` | Máximo de mensagens por número por dia | `150` |

---

## Rotas Completas

```
GET  /health                          — sem auth
POST /send                            — apikey
POST /automation/register             — apikey
POST /automation/unregister           — apikey
GET  /automation/status/:churchId     — apikey
POST /sync/:churchId                  — apikey (legacy, mantido)
GET  /admin/pool                      — apikey + x-admin-key
POST /admin/pool/add                  — apikey + x-admin-key
GET  /admin/pool/:numberId/qr         — apikey + x-admin-key
DELETE /admin/pool/:numberId          — apikey + x-admin-key
GET  /admin/pool/:numberId/status     — apikey + x-admin-key
```

---

## Arquivos Não Alterados

- `src/services/connection-sync.ts` — mantido intacto (suporta `/sync/:churchId` legacy)
- `src/utils/phone.ts` — mantido intacto
- `tsconfig.json` — mantido intacto
- `Dockerfile` — mantido intacto
