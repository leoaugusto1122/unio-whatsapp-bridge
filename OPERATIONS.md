# Unio WhatsApp Bridge — Guia de Operações

**VPS:** `47.79.36.116` (claw.cloud)
**Acesso:** `ssh root@47.79.36.116`
**Bridge:** `http://47.79.36.116:3000`
**Evolution API:** `http://47.79.36.116:8080`

---

## Índice

1. [Credenciais e autenticação](#1-credenciais-e-autenticação)
2. [Gerenciar números do pool](#2-gerenciar-números-do-pool)
3. [Deploy — atualizar o bridge](#3-deploy--atualizar-o-bridge)
4. [Deploy do zero (nova VPS)](#4-deploy-do-zero-nova-vps)
5. [Variáveis de ambiente](#5-variáveis-de-ambiente)
6. [Monitoramento](#6-monitoramento)
7. [Troubleshooting](#7-troubleshooting)

---

## 1. Credenciais e autenticação

Todos os endpoints (exceto `/health`) exigem:

```
apikey: unioescala_whatsapp
```

Endpoints `/admin/*` exigem também:

```
x-admin-key: unio_admin_2026
```

---

## 2. Gerenciar números do pool

### Listar números do pool

```bash
curl http://47.79.36.116:3000/admin/pool \
  -H "apikey: unioescala_whatsapp" \
  -H "x-admin-key: unio_admin_2026"
```

**Resposta:**
```json
{
  "numbers": [
    {
      "numberId": "2SNlqphmgZCt3zwVuDgn",
      "phoneNumber": "5544988097414",
      "instanceId": "unio_pool_2SNlqphmgZCt3zwVuDgn",
      "status": "connected",
      "messagesToday": 0,
      "totalMessages": 340,
      "lastUsedAt": "2026-03-18T17:45:00Z"
    }
  ],
  "summary": { "total": 1, "connected": 1, "disconnected": 0 }
}
```

---

### Adicionar um número ao pool

**Formato do número:** sempre com DDI + DDD + número, sem espaços ou símbolos.
Exemplo: `+55 (44) 98809-7414` → `5544988097414`

```bash
curl -X POST http://47.79.36.116:3000/admin/pool/add \
  -H "apikey: unioescala_whatsapp" \
  -H "x-admin-key: unio_admin_2026" \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber": "55XXXXXXXXXXX", "notes": "descrição do chip"}'
```

**Resposta:**
```json
{
  "numberId": "abc123",
  "instanceId": "unio_pool_abc123",
  "qrCode": "base64...",
  "qrCodeExpiry": 60
}
```

**Após receber a resposta:**
1. Copie o `qrCode` (base64) e converta para imagem, **ou**
2. Acesse o painel da Evolution API em `http://47.79.36.116:8080` e escaneie o QR da instância criada
3. Abra o WhatsApp no celular do chip → Dispositivos conectados → Conectar dispositivo → Escaneie
4. Aguarde a confirmação de conexão

---

### Verificar status de um número

Substitua `{numberId}` pelo ID retornado no `/admin/pool`:

```bash
curl http://47.79.36.116:3000/admin/pool/{numberId}/status \
  -H "apikey: unioescala_whatsapp" \
  -H "x-admin-key: unio_admin_2026"
```

---

### Regenerar QR code (número desconectado)

Se o WhatsApp desconectou e precisa reconectar:

```bash
curl http://47.79.36.116:3000/admin/pool/{numberId}/qr \
  -H "apikey: unioescala_whatsapp" \
  -H "x-admin-key: unio_admin_2026"
```

---

### Remover um número do pool

```bash
curl -X DELETE http://47.79.36.116:3000/admin/pool/{numberId} \
  -H "apikey: unioescala_whatsapp" \
  -H "x-admin-key: unio_admin_2026"
```

Remove a instância da Evolution API e do Firestore.

---

## 3. Deploy — atualizar o bridge

Usado quando há mudanças no código (novo commit no GitHub).

**1. SSH na VPS:**
```bash
ssh root@47.79.36.116
```

**2. Entrar na pasta e puxar as atualizações:**
```bash
cd /root/unio-bridge-new
git pull
```

**3. Rebuild e restart do container:**
```bash
docker compose up -d --build
```

**4. Verificar logs:**
```bash
docker logs unio-bridge --tail 40
```

**5. Testar health:**
```bash
curl http://localhost:3000/health
```

---

## 4. Deploy do zero (nova VPS)

Caso precise subir o bridge em uma VPS nova do zero.

**Pré-requisitos na VPS:** Docker instalado (`docker --version`)

**1. Clonar o repositório:**
```bash
cd /root
git clone https://github.com/leoaugusto1122/unio-whatsapp-bridge.git unio-bridge-new
cd unio-bridge-new
```

**2. Criar o arquivo de variáveis de ambiente:**
```bash
nano .env.bridge
```

Conteúdo (preencha os valores):
```env
PORT=3000
NODE_ENV=production
TZ=America/Sao_Paulo
API_KEY=unioescala_whatsapp
ADMIN_KEY=unio_admin_2026
EVOLUTION_BASE_URL=http://localhost:8080
EVOLUTION_API_KEY=unioescala_whatsapp
FIREBASE_PROJECT_ID=unioescala
FIREBASE_SERVICE_ACCOUNT={"type":"service_account",...}
SCHEDULER_IDLE_DELAY_MINUTES=5
SCHEDULER_ACTIVE_DELAY_MINUTES=1
SCHEDULER_PENDING_BATCH_LIMIT=10
SCHEDULER_LOOKBACK_HOURS=24
MAX_DAILY_PER_NUMBER=150
```

> `FIREBASE_SERVICE_ACCOUNT` deve ser o JSON inteiro em uma única linha.

**3. Subir o container:**
```bash
docker compose up -d --build
```

**4. Verificar:**
```bash
docker logs unio-bridge --tail 30
curl http://localhost:3000/health
```

---

## 5. Variáveis de ambiente

| Variável | Valor atual | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta do servidor |
| `NODE_ENV` | `production` | Ambiente |
| `TZ` | `America/Sao_Paulo` | Fuso horário |
| `API_KEY` | `unioescala_whatsapp` | Chave de autenticação padrão |
| `ADMIN_KEY` | `unio_admin_2026` | Chave extra para `/admin/*` |
| `EVOLUTION_BASE_URL` | `http://47.79.36.116:8080` | URL da Evolution API |
| `EVOLUTION_API_KEY` | `unioescala_whatsapp` | API key da Evolution |
| `FIREBASE_PROJECT_ID` | `unioescala` | ID do projeto Firebase |
| `FIREBASE_SERVICE_ACCOUNT` | `{...json...}` | Credencial Firebase (JSON) |
| `SCHEDULER_IDLE_DELAY_MINUTES` | `5` | Espera quando o ciclo nao encontra `items` |
| `SCHEDULER_ACTIVE_DELAY_MINUTES` | `1` | Espera quando o ciclo encontra `items` para avaliar |
| `SCHEDULER_PENDING_BATCH_LIMIT` | `10` | Limite de `items` lidos por ciclo |
| `SCHEDULER_LOOKBACK_HOURS` | `24` | Janela principal por `createdAt` na fila de `items` |
| `MAX_DAILY_PER_NUMBER` | `150` | Limite de mensagens por número por dia |

**Para editar uma variável na VPS:**
```bash
nano /root/unio-bridge-new/.env.bridge
# após salvar:
docker compose up -d
```

---

## 6. Monitoramento

### Ver containers rodando
```bash
docker ps
```

### Ver logs em tempo real
```bash
docker logs unio-bridge -f
```

### Ver últimas 50 linhas de log
```bash
docker logs unio-bridge --tail 50
```

### Health check
```bash
curl http://localhost:3000/health
```

### Jobs automáticos em execução
| Job | Cron | Função |
|---|---|---|
| Scheduler de notificações | A cada 60min | Dispara mensagens das escalas |
| Monitor do pool | A cada 15min | Atualiza status connected/disconnected |
| Reset de contadores | 00:00 diário | Zera `messagesToday` de todos os números |

---

## 7. Troubleshooting

### Container não sobe
```bash
docker logs unio-bridge --tail 50
# Verifique erros de variável de ambiente ou Firebase
```

### Número aparece como disconnected
```bash
# Forçar verificação imediata:
curl http://47.79.36.116:3000/admin/pool/{numberId}/status \
  -H "apikey: unioescala_whatsapp" \
  -H "x-admin-key: unio_admin_2026"

# Se desconectado, regenerar QR e reconectar:
curl http://47.79.36.116:3000/admin/pool/{numberId}/qr \
  -H "apikey: unioescala_whatsapp" \
  -H "x-admin-key: unio_admin_2026"
```

### Nenhum número disponível para envio
O endpoint `/send` retorna `503` com `"reason": "no_sender_available"` quando:
- Todos os números estão desconectados, ou
- Todos atingiram o limite diário (`MAX_DAILY_PER_NUMBER`)

Solução: verificar status dos números via `/admin/pool` e reconectar ou adicionar novo número.

### Scheduler não está disparando
```bash
docker logs unio-bridge | grep "scheduler\|batch\|job"
```
Verifique se há igrejas com `whatsappAutomation.enabled: true` no Firestore e escalas com `status: "publicada"`.

### Indexes obrigatorios do Firestore
O scheduler de notificacoes depende de um indice manual para `collectionGroup('items')`:

- Indice definitivo da Fase 2: `notificado ASC` + `createdAt ASC`
- Indice legado temporario: `notificado ASC` + `dataCulto ASC`, mantido apenas pelo fallback de transicao e removivel apos 15 dias estaveis

Sem esse indice, o loop vai registrar erro de `FAILED_PRECONDITION` ao consultar a fila.

Atualizacao da Fase 2:

- O scheduler usa `createdAt` como filtro principal da fila.
- O fallback por `dataCulto` e temporario, apenas para itens legados sem `createdAt`.
- O indice definitivo requerido e `notificado ASC` + `createdAt ASC`.
- O indice `notificado ASC` + `dataCulto ASC` permanece apenas durante a transicao e pode ser removido apos 15 dias estaveis.

### Reiniciar o container sem rebuild
```bash
docker restart unio-bridge
```

---

## Referência rápida de endpoints

```
GET    /health                        — sem auth
POST   /send                          — apikey
POST   /automation/register           — apikey
POST   /automation/unregister         — apikey
GET    /automation/status/:churchId   — apikey
GET    /admin/pool                    — apikey + x-admin-key
POST   /admin/pool/add                — apikey + x-admin-key
GET    /admin/pool/:numberId/qr       — apikey + x-admin-key
GET    /admin/pool/:numberId/status   — apikey + x-admin-key
DELETE /admin/pool/:numberId          — apikey + x-admin-key
```
