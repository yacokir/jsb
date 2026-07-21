# JSB – Stage 01 Specification

## Objetivo

O objetivo deste estágio é validar a infraestrutura mínima necessária para operar uma ação utilizando Alpaca Paper Trading, sem enviar ordens.

---

## Escopo

O sistema deverá ser capaz de:

- autenticar na Alpaca;
- conectar ao ambiente Paper Trading;
- consultar o relógio do mercado;
- verificar se o mercado está aberto;
- consultar um único símbolo escolhido manualmente;
- obter Market Data;
- exibir informações básicas da sessão.

Nenhuma ordem deverá ser enviada neste estágio.

---

## Fora do escopo

- compra;
- venda;
- estratégia;
- stop loss;
- take profit;
- gerenciamento de risco;
- seleção automática de ações;
- múltiplos ativos;
- otimizações.

---

## Premissas já definidas

- projeto independente;
- mercado de ações dos Estados Unidos;
- Alpaca Paper Trading;
- uma única ação por sessão;
- símbolo escolhido manualmente pelo operador;
- somente operações compradas;
- código mínimo;
- poucos arquivos;
- sem framework;
- sem abstrações desnecessárias;
- parâmetros visíveis e editados manualmente;
- foco inicial na validação operacional;
- nenhuma posição ou ordem deverá permanecer aberta ao final de cada sessão.

---

## Pontos ainda em aberto

Os seguintes temas ainda serão definidos:

- fonte definitiva de Market Data;
- comportamento durante o premarket;
- horário operacional;
- regra de entrada;
- regra de saída;
- tipo de ordem;
- duração máxima da sessão;
- tratamento de erros;
- estrutura mínima definitiva dos arquivos.

---

## Resultado esperado do Stage 01

Ao final deste estágio, o programa deverá apenas conseguir:

- conectar à Alpaca;
- autenticar;
- consultar o relógio do mercado;
- informar se o mercado está aberto;
- consultar uma ação escolhida manualmente;
- obter e exibir informações básicas da sessão.

Sem enviar qualquer ordem.

---

## Critérios de Conclusão

O Stage 01 será considerado concluído quando o programa for capaz de:

- autenticar com sucesso na Alpaca Paper Trading;
- verificar a conectividade com os serviços necessários;
- consultar o relógio do mercado;
- identificar corretamente se o mercado está aberto ou fechado;
- consultar um símbolo informado manualmente;
- obter e exibir Market Data desse símbolo;
- encerrar normalmente sem enviar qualquer ordem.

---

## Implementação validada

- preflight REST para conta Paper, relógio do mercado, ativo e Market Data;
- WebSocket nativo do Node.js conectado ao endpoint IEX da Alpaca;
- autenticação e assinatura de trades e quotes confirmadas explicitamente;
- observação do stream durante 30 segundos, sem polling;
- nenhuma ordem enviada.

O código 1006 somente é aceito quando o encerramento é iniciado localmente após a conclusão integral da observação, sem erro ou falha anterior e depois de conexão, autenticação e assinaturas confirmadas. Um código 1006 espontâneo ou prematuro continua sendo falha.

---
