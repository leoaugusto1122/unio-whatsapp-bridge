# unio-whatsapp-bridge

Bridge responsavel por reconciliar o estado da conexao WhatsApp com a Evolution API e executar os jobs de automacao.

## Endpoints

### `GET /health`

Retorna `200` com `{ "ok": true }`.

### `POST /sync/:churchId`

Forca a reconciliacao da conexao WhatsApp de uma igreja e atualiza o Firestore antes da proxima leitura do app.

- Header obrigatorio: `apikey: <API_KEY>`
- Resposta `200`:

```json
{
  "churchId": "igreja-demo",
  "statusAnterior": false,
  "statusNovo": true,
  "updated": true,
  "origin": "config_screen",
  "error": null
}
```

- Resposta `401`: `{"error":"unauthorized"}`
- Resposta `400`: `{"error":"churchId is required"}`
- Resposta `500`: erro inesperado fora do fluxo normal de sincronizacao

## Variaveis de ambiente

Obrigatorias:

- `PORT`: porta HTTP do bridge. Em Railway normalmente vem do ambiente; localmente use `3000`.
- `API_KEY`: chave exigida dos clientes que chamam o bridge via header `apikey`.
- `EVOLUTION_BASE_URL`: URL base da Evolution API.
- `EVOLUTION_API_KEY`: chave usada pelo bridge para autenticar na Evolution API.
- `FIREBASE_PROJECT_ID`: projeto Firebase.
- `FIREBASE_SERVICE_ACCOUNT`: JSON serializado da service account.

Opcionais:

- `TZ`: fuso horario. Padrao `America/Sao_Paulo`.
- `SCHEDULER_IDLE_DELAY_MINUTES`: atraso quando nao ha itens pendentes. Padrao `5`.
- `SCHEDULER_ACTIVE_DELAY_MINUTES`: atraso quando o ciclo encontra itens. Padrao `1`.
- `SCHEDULER_PENDING_BATCH_LIMIT`: maximo de `items` avaliados por ciclo. Padrao `10`.
- `SCHEDULER_LOOKBACK_HOURS`: janela principal por `createdAt` usada pela fila. Padrao `24`.
- `MAX_DAILY_PER_NUMBER`: limite diario por numero do pool. Padrao `150`.
- `MAX_HOURLY_PER_NUMBER`: limite horario antiban por numero do pool. Padrao `80`.
- `PRESENCE_MIN_DELAY_MS`: atraso minimo de digitacao enviado para a Evolution API. Padrao `3000`.
- `PRESENCE_MAX_DELAY_MS`: atraso maximo de digitacao enviado para a Evolution API. Padrao `6000`.
- `BATCH_MIN_DELAY_MS`: jitter minimo entre envios do mesmo numero. Padrao `15000`.
- `BATCH_MAX_DELAY_MS`: jitter maximo entre envios do mesmo numero. Padrao `30000`.
- `SYNC_PERIODIC_JOB_ENABLED`: habilita reconciliacao periodica de conexao. Use `true` para ativar.
- `SYNC_PERIODIC_JOB_CRON`: cron do job de reconciliacao periodica. Exemplo: `0 * * * *`.

## Deploy

### Railway

Configure no servico:

- `PORT` conforme o provider informar
- `API_KEY`
- `EVOLUTION_BASE_URL`
- `EVOLUTION_API_KEY`
- `FIREBASE_PROJECT_ID`
- `FIREBASE_SERVICE_ACCOUNT`
- `TZ=America/Sao_Paulo`
- `SCHEDULER_IDLE_DELAY_MINUTES=5`
- `SCHEDULER_ACTIVE_DELAY_MINUTES=1`
- `SCHEDULER_PENDING_BATCH_LIMIT=10`
- `SCHEDULER_LOOKBACK_HOURS=24`
- `MAX_DAILY_PER_NUMBER=150`
- `MAX_HOURLY_PER_NUMBER=80`
- `PRESENCE_MIN_DELAY_MS=3000`
- `PRESENCE_MAX_DELAY_MS=6000`
- `BATCH_MIN_DELAY_MS=15000`
- `BATCH_MAX_DELAY_MS=30000`
- `SYNC_PERIODIC_JOB_ENABLED=true` se quiser reconciliacao periodica
- `SYNC_PERIODIC_JOB_CRON=0 * * * *` para rodar a cada 1 hora

## Firestore indexes

O scheduler usa `collectionGroup('items')` com `notificado == false` e `createdAt >= cutoff` como source of truth da fila.

- Indice definitivo da Fase 2: `notificado ASC` + `createdAt ASC`.
- Indice legado temporario: `notificado ASC` + `dataCulto ASC`, mantido apenas para o fallback de transicao e removivel apos 15 dias estaveis.

## Fluxo de integracao

1. O app `unio` abre a tela de Configuracoes da sede.
2. O app chama `POST /sync/:churchId` com timeout curto.
3. O bridge consulta a Evolution, compara com `whatsappAutomation.connected` e atualiza o Firestore se houver divergencia.
4. O app faz `refreshIgrejas()` e renderiza o valor ja reconciliado.
5. Se a sync falhar, o app continua usando o valor atual do Firestore e registra log.

## Automacao antiban

- O scheduler continua agrupando estritamente por `churchId + escalaId + membroId`. Nao ha consolidacao entre igrejas nem entre escalas diferentes.
- A saudacao inicial da mensagem usa `igrejas.segmento`:
  - `igreja` ou valor vazio -> saudacoes religiosas
  - qualquer outro valor -> saudacoes neutras
- O bridge envia `presence: "composing"` e `delay` no proprio `sendText` da Evolution API antes de cada mensagem.
- Todo envio passa por uma fila serial por `instanceId`, entao o mesmo numero respeita a mesma cadencia mesmo quando batches diferentes concorrem no mesmo ciclo.
- O pool aplica dois limites antes do envio:
  - diario por `messagesToday`
  - horario por `antiBan.hourCount` em janela movel de 60 minutos
- Quando um numero atinge o limite horario, o bridge tenta outro remetente elegivel. Se nenhum existir, o grupo e pulado naquele ciclo.

## Logs

O bridge emite logs estruturados para:

- sincronizacao (`connection_sync_check`, `connection_sync_noop`, `connection_sync_updated`, `connection_sync_error`)
- acesso HTTP (`http_sync_completed`, `http_sync_unauthorized`, `http_sync_invalid_request`, `http_sync_failed`)
- automacao (`scheduler_cycle_complete`, `scheduler_no_sender`)
- antiban (`presence_sent`, `sender_reserved_hourly_slot`, `hourly_rate_limit_blocked`)

Monitore esses eventos apos ativar o scheduler ou a sync sob demanda para validar atualizacoes e impacto operacional.
