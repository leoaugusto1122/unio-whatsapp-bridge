# PRD — unio-whatsapp-bridge

**Repositório:** `unio-whatsapp-bridge`  
**Tipo:** Microserviço independente  
**Stack:** Node.js + TypeScript + Express + Baileys (`baileys`)  
**Hospedagem:** Back4App Containers  
**Status:** Pronto para Desenvolvimento  

---

## 1. Contexto

O app Unio (`unio-app-core`) já possui a funcionalidade de disparo manual de mensagens via WhatsApp — o app monta o texto e abre o WhatsApp do gestor para envio. O objetivo deste microserviço é substituir esse processo manual por um **envio automático e agendado**, sem intervenção humana.

O `unio-whatsapp-bridge` é um serviço isolado e independente, responsável por:

- Manter sessões WhatsApp ativas por igreja via Baileys
- Receber requisições autenticadas do `unio-app-core` e enviar mensagens de texto
- Persistir as sessões para sobreviver a reinicializações do container no Back4App
- Aplicar proteções básicas anti-banimento
- **Verificar automaticamente o Firestore de hora em hora e disparar escalas publicadas** dentro da janela de antecedência configurada por cada igreja

### Por que o agendamento ficou no bridge?

O Firebase Cloud Functions exige o plano Blaze (pago). Como o bridge já roda 24h no Back4App, faz sentido centralizar aqui o agendamento também — usando `node-cron` internamente, sem nenhum custo adicional e sem dependência do plano pago do Firebase.

---

## 2. Stack Técnica

| Camada | Tecnologia |
|---|---|
| Runtime | Node.js 20+ |
| Linguagem | TypeScript |
| Framework HTTP | Express |
| WhatsApp | `baileys` (npm install baileys) |
| Agendamento interno | `node-cron` |
| Leitura do Firestore | Firebase Admin SDK |
| Persistência de sessão | Sistema de arquivos com volume persistente do Back4App |
| Hospedagem | Back4App Containers (plano gratuito) |
| Autenticação da API | API Key estática via header `Authorization: Bearer` |

### Observação crítica sobre o Baileys

A documentação oficial alerta que o `useMultiFileAuthState` — função built-in de persistência de sessão — **não deve ser usada em produção**, pois é ineficiente e serve apenas para demonstração. O agente deve implementar uma estratégia de persistência adequada para o ambiente do Back4App, usando o volume persistente do container para salvar os arquivos de sessão de forma confiável.

O Baileys requer **Node.js 17 ou superior**. O agente deve garantir que o Dockerfile ou configuração do Back4App use Node 20.

---

## 3. Conceito de Instância por Igreja

Cada igreja cadastrada no Unio terá sua própria sessão WhatsApp ativa no bridge, identificada pelo `churchId` do Firebase. Isso garante:

- O número conectado é o da própria igreja
- O banimento ou desconexão de uma instância não afeta outras igrejas
- O histórico de mensagens fica no WhatsApp da própria igreja

Cada instância corresponde a uma conexão Baileys (`makeWASocket`) independente, com seu próprio diretório de arquivos de sessão.

---

## 4. Conexão via Pairing Code

O Baileys suporta dois modos de conexão: QR Code e Pairing Code. Este serviço deve usar **exclusivamente o Pairing Code**, pois o gestor usa um único celular e não conseguiria escanear um QR Code na própria tela do app.

O fluxo de conexão via Pairing Code funciona assim:

1. O serviço inicializa o socket Baileys com `printQRInTerminal: false`
2. Verifica se `sock.authState.creds.registered` é falso (instância nova)
3. Chama `sock.requestPairingCode(phoneNumber)` com o número no formato internacional sem caracteres especiais (ex: `5544999990000`)
4. Retorna o código de 8 dígitos para o app exibir ao gestor
5. O gestor abre o WhatsApp no celular → Dispositivos conectados → Conectar com número de telefone → digita o código
6. O evento `connection.update` do Baileys dispara com `connection: 'open'` quando a conexão é estabelecida

O número de telefone fornecido para o `requestPairingCode` não pode conter `+`, `()`, `-` ou espaços — apenas dígitos, incluindo o código do país.

---

## 5. Persistência de Sessão

A sessão do Baileys contém as credenciais de autenticação e as chaves de signal. Ela deve ser persistida para que o serviço não precise reconectar a cada reinicialização do container.

O agente deve implementar a persistência usando o **volume persistente do Back4App**, salvando os arquivos de sessão em um diretório mapeado como volume (ex: `/app/sessions/{churchId}/`). Cada instância tem seu próprio diretório isolado.

### Evento crítico para persistência

O Baileys emite o evento `creds.update` sempre que as credenciais são atualizadas — inclusive a cada mensagem enviada ou recebida, pois as chaves Signal precisam ser atualizadas. O agente **deve** escutar esse evento e salvar as credenciais imediatamente:

```
sock.ev.on('creds.update', saveCreds)
```

Não salvar as credenciais a cada atualização impedirá que mensagens cheguem ao destinatário e causará comportamentos inesperados.

---

## 6. Reconexão Automática

O Baileys emite o evento `connection.update` com o estado da conexão. O agente deve implementar a lógica de reconexão automática quando a conexão cair por motivos recuperáveis (queda de rede, timeout), mas **não reconectar** quando o motivo for logout (`DisconnectReason.loggedOut`), pois nesse caso as credenciais foram invalidadas e o gestor precisa reconectar manualmente pelo app.

Referência do comportamento esperado segundo a documentação do Baileys:

```
if (connection === 'close') {
  const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut
  if (shouldReconnect) {
    // reconectar
  }
}
```

---

## 7. Endpoints da API

### Autenticação

Todas as requisições devem incluir no header:

```
Authorization: Bearer {API_KEY}
```

A `API_KEY` é configurada como variável de ambiente no serviço. Requisições sem o header ou com chave inválida devem retornar HTTP 401.

---

### 7.1 Solicitar Pairing Code — conectar instância

**POST** `/instance/connect`

Inicia o processo de conexão de um número WhatsApp para uma igreja. Se a instância já existir e estiver conectada, retorna o status atual sem gerar novo código.

**Request body:**
```json
{
  "churchId": "abc123",
  "phoneNumber": "5544999990000"
}
```

**Response — código gerado (instância nova):**
```json
{
  "status": "pending",
  "pairingCode": "ABCD-1234",
  "expiresIn": 60
}
```

**Response — já conectado:**
```json
{
  "status": "connected",
  "phoneNumber": "5544999990000"
}
```

---

### 7.2 Verificar status da instância

**GET** `/instance/status/:churchId`

Retorna o estado atual da sessão WhatsApp de uma igreja.

**Response:**
```json
{
  "churchId": "abc123",
  "status": "connected",
  "phoneNumber": "5544999990000",
  "connectedSince": "2026-03-01T10:00:00Z"
}
```

**Valores possíveis de `status`:** `connected` / `disconnected` / `connecting`

---

### 7.3 Desconectar instância

**POST** `/instance/disconnect`

Encerra a sessão WhatsApp de uma igreja, remove os arquivos de sessão persistidos e libera os recursos do socket Baileys.

**Request body:**
```json
{
  "churchId": "abc123"
}
```

**Response:**
```json
{
  "status": "disconnected",
  "churchId": "abc123"
}
```

---

### 7.4 Enviar mensagem individual

**POST** `/send`

Envia uma mensagem de texto para um número. Chamado pelo `unio-app-core` para disparos individuais imediatos.

O número de destino deve estar no formato `{JID}` do WhatsApp: `{ddi}{ddd}{numero}@s.whatsapp.net`. O agente deve realizar a conversão internamente a partir do número recebido.

**Request body:**
```json
{
  "churchId": "abc123",
  "to": "5544999990000",
  "message": "Olá Dc. Alex Sandro, a Paz do Senhor! 👋\n\nVocê está escalado(a) para:\n🏛️ IEADM Sarandi\n📅 Culto de Oração — domingo, 08 de mar.\n📋 Função: Apoio / Recepção\n\nConfirme sua presença pelo link abaixo:\n🔗 https://unioescala.web.app/confirmar?token=abc123\n\nObrigado! 🙏"
}
```

**Response — sucesso:**
```json
{
  "status": "sent",
  "to": "5544999990000",
  "timestamp": "2026-03-01T10:00:00Z"
}
```

**Response — instância não conectada:**
```json
{
  "status": "failed",
  "reason": "instance_disconnected",
  "message": "A instância da igreja abc123 não está conectada"
}
```

---

### 7.5 Enviar lote de mensagens

**POST** `/send-batch`

Envia mensagens para múltiplos destinatários de uma mesma igreja, aplicando delay aleatório entre cada envio para proteção anti-banimento.

**Request body:**
```json
{
  "churchId": "abc123",
  "messages": [
    {
      "to": "5544999990000",
      "message": "Mensagem para membro 1..."
    },
    {
      "to": "5544888880000",
      "message": "Mensagem para membro 2..."
    }
  ]
}
```

**Response:**
```json
{
  "total": 2,
  "sent": 2,
  "failed": 0,
  "results": [
    { "to": "5544999990000", "status": "sent" },
    { "to": "5544888880000", "status": "sent", "failReason": null }
  ]
}
```

O endpoint deve retornar HTTP 200 mesmo se alguns envios falharem individualmente — o `unio-app-core` consulta o array `results` para saber o status de cada um.

---

## 8. Regras de Negócio do Serviço

### 8.1 Delay Anti-Banimento

Entre cada mensagem enviada em um lote via `/send-batch`, o serviço deve aguardar um tempo **aleatório entre 15 e 45 segundos**. Isso simula comportamento humano e reduz o risco de banimento do número pelo WhatsApp.

O `/send` individual não aplica delay.

### 8.2 Formato do Número de Telefone

Todos os números recebidos nos endpoints devem ser normalizados internamente:

- Remover todos os caracteres não numéricos: espaços, traços, parênteses, `+`
- Garantir o código do país: se não começar com `55`, adicionar automaticamente
- Converter para JID do WhatsApp: `{numero}@s.whatsapp.net`
- Exemplo: `(44) 9 9999-0000` → `554499999000@s.whatsapp.net`

Números que, após normalização, não tiverem entre 12 e 13 dígitos devem ser rejeitados com erro descritivo.

### 8.3 Instância não conectada

Se o `churchId` recebido não tiver uma sessão ativa no momento do envio, retornar erro `instance_disconnected` imediatamente. O serviço não deve tentar reconectar automaticamente nesse caso — a reconexão é responsabilidade do gestor via app.

### 8.4 Verificação de número no WhatsApp

Antes de enviar, o agente pode — opcionalmente — usar `sock.onWhatsApp(jid)` do Baileys para verificar se o número existe no WhatsApp. Se não existir, retornar erro descritivo em vez de tentar enviar para um JID inválido.

---

## 9. Variáveis de Ambiente

Nenhuma configuração sensível deve estar no código. Tudo via variáveis de ambiente:

| Variável | Descrição | Obrigatória |
|---|---|---|
| `API_KEY` | Chave de autenticação exigida em todas as requisições | ✅ |
| `PORT` | Porta do servidor Express (padrão: 3000) | ✅ |
| `SESSIONS_DIR` | Caminho do diretório de sessões no volume persistente (padrão: `/app/sessions`) | ✅ |
| `NODE_ENV` | `production` ou `development` | ✅ |
| `FIREBASE_PROJECT_ID` | ID do projeto Firebase para leitura do Firestore | ✅ |
| `FIREBASE_SERVICE_ACCOUNT` | Credenciais do Firebase Admin SDK em JSON (service account) | ✅ |
| `SCHEDULER_INTERVAL` | Intervalo do cron em minutos (padrão: `60`) | ✅ |

---

## 10. Agendamento Automático de Escalas

Esta é a segunda grande responsabilidade do bridge além do envio sob demanda. O bridge usa `node-cron` para verificar o Firestore periodicamente e disparar as escalas no momento correto, sem nenhuma intervenção do gestor.

### 10.1 Dependências necessárias

- `node-cron` — agendamento interno do job de verificação
- `firebase-admin` — leitura e escrita no Firestore do projeto Unio

### 10.2 Fluxo do Job Automático

O job executa a cada 60 minutos (configurável via `SCHEDULER_INTERVAL`):

**Passo 1 — Buscar igrejas elegíveis**
Consultar no Firestore todas as igrejas onde `whatsappAutomation.enabled == true` e `whatsappAutomation.connected == true`.

**Passo 2 — Buscar escalas elegíveis por igreja**
Para cada igreja elegível, buscar escalas onde:
- `status == "publicada"`
- Existe pelo menos um membro com `notificado == false`

**Passo 3 — Verificar janela de antecedência**
Para cada escala elegível, calcular se:
```
(horário do culto - advanceHours) <= agora
```
Se a condição não for atendida ainda, ignorar e aguardar o próximo ciclo.

**Passo 4 — Verificar janela de silêncio**
Se o horário atual estiver dentro da janela de silêncio configurada pela igreja (ex: entre 22:00 e 07:00), **não disparar**. Aguardar o próximo ciclo que cair fora da janela.

**Passo 5 — Montar e enviar o lote**
Para cada escala que passou em todas as verificações, montar a lista de membros com `notificado == false` que possuem telefone cadastrado e chamar internamente o mesmo serviço de `/send-batch` já implementado — aproveitando o delay anti-banimento e a lógica de envio existente.

**Passo 6 — Atualizar o Firestore**
Após cada envio bem-sucedido, atualizar no Firestore:
- `notificado: true`
- `notificadoEm: timestamp atual`

Em caso de falha de envio por número inválido ou inexistente no WhatsApp:
- `notificado: false`
- `notificadoErro: "sem_telefone"` ou `"numero_invalido"`

### 10.3 Montagem da mensagem

O bridge é responsável por montar o texto da mensagem para o disparo automático, pois nesse fluxo não há intervenção do app-core. O formato deve seguir exatamente o padrão já utilizado no disparo manual:

```
Olá {nomeDoMembro}, a Paz do Senhor! 👋

Você está escalado(a) para:
🏛️ {nomeIgreja}
📅 {nomeCulto} — {diaSemana}, {data}
📋 Função: {setor}

Confirme sua presença pelo link abaixo:
🔗 {linkConfirmacao}

Obrigado! 🙏
```

O `linkConfirmacao` deve ser gerado com o token único do membro já existente no Firestore (campo `token` gerado pelo `unio-app-core`).

### 10.4 Controle de duplicidade

O campo `notificado: true` é a trava principal. O job nunca processa membros com `notificado: true`, mesmo que o job rode múltiplas vezes antes do culto.

### 10.5 Instância desconectada durante o job

Se durante a execução do job a instância da igreja estiver com status `disconnected`, o bridge deve:
- Registrar a tentativa com log de erro
- Não marcar `notificado: true` — os membros permanecem com `false` para nova tentativa no próximo ciclo
- Não lançar exceção que quebre o job para as outras igrejas

### 10.6 Estrutura de dados esperada no Firestore

O agente deve ler os seguintes campos do Firestore. O agente do `unio-app-core` é responsável por gravá-los — este PRD documenta apenas o contrato de leitura:

**Configurações da igreja** (`whatsappAutomation`):
```
enabled: boolean
connected: boolean
advanceHours: number
silenceStart: string  // ex: "22:00"
silenceEnd: string    // ex: "07:00"
```

**Membro dentro de uma escala**:
```
notificado: boolean
notificadoEm: timestamp | null
notificadoErro: string | null
telefone: string
token: string
nomeDoMembro: string
setor: string
```

**Escala**:
```
status: string  // "publicada" | "rascunho" | "arquivada"
dataHoraCulto: timestamp
nomeCulto: string
nomeIgreja: string
```

---

## 11. Hospedagem no Back4App Containers

### Limitação de RAM — ponto crítico

O plano gratuito do Back4App oferece **256MB de RAM**. O Baileys com uma sessão ativa consome entre 150–250MB. O agente deve:

- Evitar carregar o histórico completo de mensagens (`syncFullHistory: false`)
- Não usar `makeInMemoryStore` em produção — conforme alertado na documentação do Baileys, armazenar todo o histórico de chats em memória é desperdício de RAM
- Configurar `markOnlineOnConnect: false` para reduzir tráfego de presença
- Monitorar o consumo de memória e documentar se o limite for atingido

### Volume persistente

O Back4App Containers suporta volumes persistentes para manter arquivos entre reinicializações. O diretório `SESSIONS_DIR` deve ser mapeado como volume nas configurações do Back4App para que as sessões do Baileys sobrevivam a deploys e reinicializações.

### Dockerfile

O agente deve criar um `Dockerfile` adequado para o Back4App com:

- Imagem base Node.js 20 Alpine (menor footprint de memória)
- Build TypeScript antes de iniciar
- Usuário não-root para segurança
- Health check endpoint (`GET /health`) para o Back4App monitorar o serviço

---

## 12. Health Check

**GET** `/health`

Endpoint sem autenticação, usado pelo Back4App para verificar se o serviço está ativo.

**Response:**
```json
{
  "status": "ok",
  "uptime": 3600,
  "instances": {
    "connected": 1,
    "disconnected": 0
  }
}
```

---

## 13. Contrato com o unio-app-core

O `unio-app-core` é o único cliente deste serviço. O contrato entre eles:

- O app-core decide **quando e para quem enviar** — o bridge só executa
- O app-core envia o texto da mensagem **já montado e formatado** — o bridge não monta nada
- O app-core trata os erros retornados (ex: `instance_disconnected` → alerta o gestor no app)
- A URL base do bridge e a `API_KEY` devem ser armazenadas no **Firebase Secret Manager** do app-core e nunca expostas no código

---

## 14. Estrutura de Arquivos Sugerida

O agente tem autonomia para organizar o projeto como julgar melhor. A estrutura abaixo é uma sugestão de referência:

```
unio-whatsapp-bridge/
├── src/
│   ├── server.ts           # Entry point — Express app + inicializa o scheduler
│   ├── routes/
│   │   ├── instance.ts     # /instance/connect, /instance/status, /instance/disconnect
│   │   ├── send.ts         # /send e /send-batch
│   │   └── health.ts       # /health
│   ├── services/
│   │   ├── baileys.ts      # Gerenciamento de instâncias e conexões Baileys
│   │   ├── session.ts      # Persistência de sessão no volume
│   │   ├── scheduler.ts    # node-cron — job de verificação automática de escalas
│   │   └── firestore.ts    # Firebase Admin SDK — leitura e escrita no Firestore
│   └── middleware/
│       └── auth.ts         # Validação da API_KEY
├── Dockerfile
├── package.json
└── tsconfig.json
```

---

## 15. Fora do Escopo deste PRD

- Envio de mensagens com mídia (imagens, áudios, documentos)
- Recebimento e processamento de mensagens recebidas pelo WhatsApp
- Múltiplos números por igreja
- Interface administrativa web para o bridge
- Logs e métricas avançadas
- Suporte a WhatsApp Business API oficial da Meta
- Notificações de status de entrega de volta ao app-core (pode ser PRD futuro)
