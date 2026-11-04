# Comandos aos pivôs (Irricontrol / AgSense)

## Situação
A tela **Ordem de irrigação** já tem os botões **Iniciar** e **Parar** por pivô, e o servidor já faz todas as
travas e a auditoria. O que falta é a chamada que cada plataforma espera para receber o comando
(`apps/api/src/comandos.ts`, objeto `drivers`). Hoje os dois drivers respondem 501 e **nada é enviado ao equipamento**.

Nenhuma das duas plataformas publica API; os conectores de leitura usam as mesmas chamadas do painel web.
Para comandar é preciso descobrir as chamadas do painel que iniciam/param a irrigação.

## O que o servidor faz antes de qualquer envio (`prepararComando`)
- Bloqueia se o pivô está em alarme, sem sinal ou já irrigando.
- Bloqueia fora das janelas de horário de energia.
- Bloqueia se o pivô não está vinculado ao mapa (não dá para saber onde estão os animais).
- Recalcula o sentido e o ângulo de parada a partir dos piquetes com animais — o que o app mostra não é aceito do cliente.
- Bloqueia se todos os piquetes têm animais, ou se o pivô está parado sobre um piquete ocupado.
- Grava toda tentativa (enviada, bloqueada ou com erro) em `comando_pivo`, visível em Relatórios.

## Como mapear (uma plataforma por vez, em um pivô de teste, sem animais, de dia e com a bomba segura)
1. Abra o painel web da plataforma no Chrome, F12 → aba **Network**, marque *Preserve log*.
2. Dê o comando **Parar** e depois **Iniciar** (sentido, % e ângulo de parada) pelo painel.
3. Salve o tráfego (botão direito → *Save all as HAR with content*) e **apague a senha/token do arquivo antes de compartilhar**.
4. Com os HARs, preencha o driver correspondente em `comandos.ts`.

Tudo isso é engenharia reversa de painel de terceiros: confirme com a Irricontrol/Valley que o uso não viola
o contrato, e prefira uma API oficial/credencial de integração se existir.

## Permissão
Só gestor e admin enviam comandos (rotas `gestor`). Para liberar ao operador, troque `gestor` por `auth` nas duas
rotas `/api/telemetria/pivos/:id/comando*` em `rotas-operacao.ts`.
