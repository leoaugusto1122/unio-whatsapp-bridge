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
- `SCHEDULER_INTERVAL`: intervalo do job de envio automatico em minutos. Padrao `60`.
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
- `SYNC_PERIODIC_JOB_ENABLED=true` se quiser reconciliacao periodica
- `SYNC_PERIODIC_JOB_CRON=0 * * * *` para rodar a cada 1 hora

## Fluxo de integracao

1. O app `unio` abre a tela de Configuracoes da sede.
2. O app chama `POST /sync/:churchId` com timeout curto.
3. O bridge consulta a Evolution, compara com `whatsappAutomation.connected` e atualiza o Firestore se houver divergencia.
4. O app faz `refreshIgrejas()` e renderiza o valor ja reconciliado.
5. Se a sync falhar, o app continua usando o valor atual do Firestore e registra log.

## Logs

O bridge emite logs estruturados para:

- sincronizacao (`connection_sync_check`, `connection_sync_noop`, `connection_sync_updated`, `connection_sync_error`)
- acesso HTTP (`http_sync_completed`, `http_sync_unauthorized`, `http_sync_invalid_request`, `http_sync_failed`)

Monitore esses eventos apos ativar o scheduler ou a sync sob demanda para validar atualizacoes e impacto operacional.
