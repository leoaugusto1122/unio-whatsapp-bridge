# Unio WhatsApp Bridge - Guia de Operacoes

**VPS:** `47.79.36.116` (claw.cloud)  
**Acesso:** `ssh root@47.79.36.116`  
**Bridge:** `http://47.79.36.116:3000`  
**Evolution API:** `http://47.79.36.116:8080`

---

## Indice

1. [Credenciais e autenticacao](#1-credenciais-e-autenticacao)
2. [Gerenciar numeros do pool](#2-gerenciar-numeros-do-pool)
3. [Deploy - atualizar o bridge](#3-deploy---atualizar-o-bridge)
4. [Deploy do zero](#4-deploy-do-zero)
5. [Variaveis de ambiente](#5-variaveis-de-ambiente)
6. [Monitoramento](#6-monitoramento)
7. [Firestore indexes](#7-firestore-indexes)
8. [Blindagem antiban](#8-blindagem-antiban)
9. [Troubleshooting](#9-troubleshooting)
10. [Referencia rapida de endpoints](#10-referencia-rapida-de-endpoints)

---

## 1. Credenciais e autenticacao

Todos os endpoints, exceto `/health`, exigem:

```text
apikey: unioescala_whatsapp
```

Os endpoints `/admin/*` exigem tambem:

```text
x-admin-key: unio_admin_2026
```

---

## 2. Gerenciar numeros do pool

### Listar numeros do pool

```bash
curl http://47.79.36.116:3000/admin/pool \
  -H "apikey: unioescala_whatsapp" \
  -H "x-admin-key: unio_admin_2026"
```

### Adicionar um numero ao pool

Formato do numero: sempre com DDI + DDD + numero, sem espacos ou simbolos.  
Exemplo: `+55 (44) 98809-7414` -> `5544988097414`

```bash
curl -X POST http://47.79.36.116:3000/admin/pool/add \
  -H "apikey: unioescala_whatsapp" \
  -H "x-admin-key: unio_admin_2026" \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber": "55XXXXXXXXXXX", "notes": "descricao do chip"}'
```

Depois de adicionar:

1. Copie o `qrCode` retornado e converta para imagem, ou abra a Evolution UI.
2. No celular do chip, abra WhatsApp -> Dispositivos conectados -> Conectar dispositivo.
3. Escaneie o QR da instancia criada.
4. Aguarde a confirmacao de conexao.

### Verificar status de um numero

```bash
curl http://47.79.36.116:3000/admin/pool/{numberId}/status \
  -H "apikey: unioescala_whatsapp" \
  -H "x-admin-key: unio_admin_2026"
```

### Regenerar QR Code

```bash
curl http://47.79.36.116:3000/admin/pool/{numberId}/qr \
  -H "apikey: unioescala_whatsapp" \
  -H "x-admin-key: unio_admin_2026"
```

### Remover um numero do pool

```bash
curl -X DELETE http://47.79.36.116:3000/admin/pool/{numberId} \
  -H "apikey: unioescala_whatsapp" \
  -H "x-admin-key: unio_admin_2026"
```

---

## 3. Deploy - atualizar o bridge

Usado quando ha mudancas no codigo ja publicadas no GitHub.

```bash
ssh root@47.79.36.116
cd /root/unio-bridge-new
git pull
docker compose up -d --build
docker logs unio-bridge --tail 40
curl http://localhost:3000/health
```

---

## 4. Deploy do zero

Pre-requisito: Docker instalado na VPS.

```bash
cd /root
git clone https://github.com/leoaugusto1122/unio-whatsapp-bridge.git unio-bridge-new
cd unio-bridge-new
```

Crie `.env.bridge`:

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
MAX_HOURLY_PER_NUMBER=80
PRESENCE_MIN_DELAY_MS=3000
PRESENCE_MAX_DELAY_MS=6000
BATCH_MIN_DELAY_MS=15000
BATCH_MAX_DELAY_MS=30000
```

Depois:

```bash
docker compose up -d --build
docker logs unio-bridge --tail 30
curl http://localhost:3000/health
```

---

## 5. Variaveis de ambiente

| Variavel | Valor padrao | Descricao |
|---|---|---|
| `PORT` | `3000` | Porta do servidor |
| `NODE_ENV` | `production` | Ambiente |
| `TZ` | `America/Sao_Paulo` | Fuso horario |
| `API_KEY` | n/a | Chave exigida pelos clientes |
| `ADMIN_KEY` | n/a | Chave extra para `/admin/*` |
| `EVOLUTION_BASE_URL` | n/a | URL base da Evolution API |
| `EVOLUTION_API_KEY` | n/a | API key da Evolution |
| `FIREBASE_PROJECT_ID` | n/a | Projeto Firebase |
| `FIREBASE_SERVICE_ACCOUNT` | n/a | JSON da service account |
| `SCHEDULER_IDLE_DELAY_MINUTES` | `5` | Espera quando a fila nao encontra itens |
| `SCHEDULER_ACTIVE_DELAY_MINUTES` | `1` | Espera quando a fila encontra itens |
| `SCHEDULER_PENDING_BATCH_LIMIT` | `10` | Limite de `items` por ciclo |
| `SCHEDULER_LOOKBACK_HOURS` | `24` | Janela principal da fila por `createdAt` |
| `MAX_DAILY_PER_NUMBER` | `150` | Limite diario por numero do pool |
| `MAX_HOURLY_PER_NUMBER` | `80` | Limite horario antiban por numero |
| `PRESENCE_MIN_DELAY_MS` | `3000` | Delay minimo de digitacao enviado para a Evolution |
| `PRESENCE_MAX_DELAY_MS` | `6000` | Delay maximo de digitacao enviado para a Evolution |
| `BATCH_MIN_DELAY_MS` | `15000` | Jitter minimo entre mensagens do mesmo numero |
| `BATCH_MAX_DELAY_MS` | `30000` | Jitter maximo entre mensagens do mesmo numero |

Para editar na VPS:

```bash
nano /root/unio-bridge-new/.env.bridge
docker compose up -d
```

---

## 6. Monitoramento

### Containers rodando

```bash
docker ps
```

### Logs em tempo real

```bash
docker logs -f unio-bridge
```

### Ultimas 50 linhas

```bash
docker logs unio-bridge --tail 50
```

### Health check

```bash
curl http://localhost:3000/health
```

### Logs principais

Procure por:

- `scheduler_cycle_complete`
- `scheduler_no_sender`
- `presence_sent`
- `sender_reserved_hourly_slot`
- `hourly_rate_limit_blocked`
- `[Scheduler] Processados`

### Jobs automaticos

| Job | Disparo | Funcao |
|---|---|---|
| Scheduler de notificacoes | loop adaptativo | Processa `items` pendentes |
| Monitor do pool | a cada 15 min | Atualiza status connected/disconnected |
| Reset diario | 00:00 | Zera `messagesToday` |

---

## 7. Firestore indexes

O scheduler usa `collectionGroup('items')`.

Obrigatorios:

- Indice definitivo: `notificado ASC` + `createdAt ASC`
- Indice legado temporario: `notificado ASC` + `dataCulto ASC`

O indice legado existe apenas para o fallback de transicao da Fase 2 e pode ser removido apos 15 dias estaveis.

Sem esses indexes, o bridge registra erro `FAILED_PRECONDITION` ao consultar a fila.

---

## 8. Blindagem antiban

### Regras de negocio preservadas

- O agrupamento continua estritamente por `churchId + escalaId + membroId`.
- Nunca misture itens de igrejas diferentes.
- Nunca misture itens de escalas diferentes.
- O link de confirmacao permanece isolado por escala.

### Segmentacao por `igrejas.segmento`

- `igreja` ou valor vazio -> saudacoes religiosas
- qualquer outro valor -> saudacoes neutras

O corpo da mensagem nao muda. Apenas a primeira linha varia.

### Presence e pacing

- Cada envio usa `presence: "composing"` e `delay` no proprio `sendText` da Evolution API.
- O atraso de digitacao fica entre `3s` e `6s`.
- Depois de cada envio, o mesmo `instanceId` aguarda um jitter entre `15s` e `30s`.
- Os envios do mesmo `instanceId` passam por fila serial unica, mesmo que venham de batches diferentes.

### Limite horario por numero

- Estado persistido em `whatsappPool.antiBan`
- Campos usados:
  - `antiBan.hourWindowStartedAt`
  - `antiBan.hourCount`
  - `antiBan.lastHourlyBlockAt`
- O bridge reserva slots antes do envio.
- Ao atingir `80/h`, o numero fica indisponivel ate a janela mover.
- Se houver outro numero elegivel, o scheduler tenta esse remetente.
- Se nenhum numero estiver elegivel, o grupo e pulado e o log `scheduler_no_sender` e emitido.

### Validacao operacional recomendada

1. Fazer um envio de teste e confirmar no celular do chip que o chat mostra `digitando...` antes da mensagem.
2. Confirmar que `presence_sent` aparece antes do envio correspondente.
3. Confirmar que `sender_reserved_hourly_slot` registra a reserva da janela.
4. Monitorar `hourly_rate_limit_blocked` caso algum numero atinja `80/h`.

---

## 9. Troubleshooting

### Container nao sobe

```bash
docker logs unio-bridge --tail 50
```

Verifique variaveis de ambiente e credenciais Firebase.

### Numero aparece como disconnected

```bash
curl http://47.79.36.116:3000/admin/pool/{numberId}/status \
  -H "apikey: unioescala_whatsapp" \
  -H "x-admin-key: unio_admin_2026"
```

Se continuar desconectado, regenere o QR:

```bash
curl http://47.79.36.116:3000/admin/pool/{numberId}/qr \
  -H "apikey: unioescala_whatsapp" \
  -H "x-admin-key: unio_admin_2026"
```

### Nenhum numero disponivel para envio

O endpoint `/send` retorna `503` com `reason: "no_sender_available"` quando todos os numeros estao sem capacidade de envio. As causas tipicas sao:

- numeros desconectados
- limite diario atingido (`MAX_DAILY_PER_NUMBER`)
- limite horario atingido (`MAX_HOURLY_PER_NUMBER`)

Monitore `hourly_rate_limit_blocked` e `scheduler_no_sender`.

### Scheduler nao esta disparando

```bash
docker logs unio-bridge | grep "scheduler\|batch\|job"
```

Verifique:

- igrejas com `whatsappAutomation.enabled: true`
- escalas com `status: "publicada"`
- indexes do Firestore criados

### Reiniciar o container sem rebuild

```bash
docker restart unio-bridge
```

---

## 10. Referencia rapida de endpoints

```text
GET    /health                        - sem auth
POST   /send                          - apikey
POST   /automation/register           - apikey
POST   /automation/unregister         - apikey
GET    /automation/status/:churchId   - apikey
GET    /admin/pool                    - apikey + x-admin-key
POST   /admin/pool/add                - apikey + x-admin-key
GET    /admin/pool/:numberId/qr       - apikey + x-admin-key
GET    /admin/pool/:numberId/status   - apikey + x-admin-key
DELETE /admin/pool/:numberId          - apikey + x-admin-key
```
