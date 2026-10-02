<div align="center">

<pre align="center">
███████╗ █████╗ ██████╗ ██╗     ███████╗ ██████╗██╗   ██╗████████╗
██╔════╝██╔══██╗██╔══██╗██║     ██╔════╝██╔════╝██║   ██║╚══██╔══╝
█████╗  ███████║██████╔╝██║     █████╗  ██║     ██║   ██║   ██║   
██╔══╝  ██╔══██║██╔══██╗██║     ██╔══╝  ██║     ██║   ██║   ██║   
██║     ██║  ██║██████╔╝███████╗███████╗╚██████╗╚██████╔╝   ██║   
╚═╝     ╚═╝  ╚═╝╚═════╝ ╚══════╝╚══════╝ ╚═════╝ ╚═════╝    ╚═╝   
</pre>

**Um editor de vídeo no navegador que agentes de IA conseguem operar.**

<a href="https://trendshift.io/repositories/77702?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-77702" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/77702/daily?language=JavaScript" alt="ronak-create%2FFableCut | Trendshift" width="250" height="55"/></a>

[![Hacker News — front page](https://img.shields.io/badge/Hacker%20News-front%20page-ff6600?logo=ycombinator&logoColor=white)](https://news.ycombinator.com/item?id=48845422)
[![DEV — Top 7 of the week](https://img.shields.io/badge/DEV-Top%207%20of%20the%20week-0A0A0A?logo=devdotto&logoColor=white)](https://dev.to/devteam/top-7-featured-dev-posts-of-the-week-815)
[![Official MCP registry](https://img.shields.io/badge/MCP%20registry-io.github.ronak--create%2Ffablecut-7b6cff?logo=modelcontextprotocol&logoColor=white)](https://registry.modelcontextprotocol.io/v0/servers?search=fablecut)
[![Mentioned in Awesome MCP Servers](https://awesome.re/mentioned-badge.svg)](https://github.com/punkpeye/awesome-mcp-servers)
[![Glama score](https://glama.ai/mcp/servers/ronak-create/FableCut/badges/score.svg)](https://glama.ai/mcp/servers/ronak-create/FableCut)
[![Glama — #18 Best Browser Automation MCP Servers](https://img.shields.io/badge/Glama-%2318%20Best%20Browser%20Automation-0e1618)](https://glama.ai/mcp/best/browser-automation)
[![Docs](https://img.shields.io/badge/Docs-fablecut.space%2Fdocs-7b6cff)](https://fablecut.space/docs/)
[![Discord](https://img.shields.io/badge/Discord-join%20the%20community-5865F2?logo=discord&logoColor=white)](https://discord.gg/EFMQH7d6Tv)

[English](../../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Español](README.es.md) · **Português (BR)**

</div>

<https://github.com/user-attachments/assets/2430b854-168b-4a9a-af2e-489e5efa7543>

O FableCut é um editor de vídeo não linear no estilo Premiere que roda
inteiramente no navegador — e expõe toda a linha do tempo como **um único
documento JSON**. Edite na mão, pela interface, ou deixe um agente de IA (Claude
Code, Claude Desktop ou qualquer coisa que fale MCP/REST) montar o vídeo para
você enquanto acompanha a timeline se atualizar ao vivo.

Zero dependências de npm. Um `node server.js`. É só isso.

![O editor FableCut](../screenshot.png)

## Por que isso é interessante

A maioria das ferramentas de "vídeo com IA" esconde a edição atrás de uma API. O
FableCut inverte isso: **o arquivo de projeto é a interface**. O `project.json`
descreve mídias, clipes, trilhas, efeitos, keyframes e transições — qualquer
processo capaz de escrever JSON consegue editar vídeo, e a interface aberta no
navegador recarrega em cerca de 150 ms via server-sent events. Uma pessoa e um
agente podem trabalhar na mesma timeline ao mesmo tempo.

## Recursos

**Edição**

- 3 trilhas de vídeo + 4 de áudio, arrastar/aparar/dividir/encaixar, desfazer e
  refazer
- **Configurações** (a engrenagem na barra superior) — preferências opcionais
  guardadas neste navegador via `localStorage`. Ative **Vincular a seleção da
  timeline e do painel Project** para que escolher um clipe destaque a mídia dele
  no Project, e clicar em um item do Project selecione todos os clipes que o
  utilizam (desligado por padrão).
- **Manipulação direta no monitor** — clique em um clipe ou título na prévia para
  mover, redimensionar (alças de canto) ou girar (alça superior, com Shift para
  encaixar) na hora
- **Seleção múltipla na timeline** — laço retangular (arraste numa área vazia da
  trilha), <kbd>Ctrl/Cmd/Shift+clique</kbd> para incluir ou tirar clipes,
  <kbd>Ctrl+A</kbd> para selecionar tudo e <kbd>Esc</kbd> para limpar a seleção.
  Arraste qualquer clipe selecionado e o grupo inteiro se move; <kbd>Delete</kbd>
  apaga todos os selecionados; <kbd>S</kbd> divide todos eles no cabeçote de
  reprodução. O inspetor mostra um aviso de "N clips selected".
- Marcadores de batida e de referência (toque <kbd>⇧m</kbd> no ritmo durante a
  reprodução), com as bordas dos clipes encaixando neles
- Pressione <kbd>Alt+t</kbd> para adicionar uma transição de entrada ou saída
  conforme a posição do cabeçote sobre o clipe selecionado. A última transição
  usada fica guardada como padrão. Arraste o triângulo sobreposto para ajustar a
  duração; <kbd>Delete</kbd> remove a transição em foco.
- Formas de onda reais, decodificadas, sobre os clipes
- **Pastas no painel Project** — visão em árvore que abre e fecha; arraste mídias
  ou pastas para aninhar; clique com o botão direito na aba **Project** → Nova
  pasta; solte arquivos sobre uma pasta para importar direto nela
- **Audio Hold** — um botão na barra da timeline: com a reprodução pausada,
  repete em loop **um frame** de áudio no cabeçote (útil ao avançar frame a
  frame). Ao arrastar o cabeçote ou pular frames, o trecho retido acompanha; os
  medidores continuam ativos. **Play** ou **Pause** desligam o recurso.
- Predefinições de proporção da tela (16:9, 9:16 para reels, 4:5, 1:1) + seletor
  de FPS do projeto (24 / 25 / 30 / 50 / 60; taxas fora da lista aparecem como
  Custom) + guias de área segura
- **Zoom do monitor de programa** — a roda do mouse sobre a prévia amplia a
  composição na direção do cursor (do ajuste à tela até **2 pixels de tela por
  pixel do canvas**). Ampliado, usa **barras de rolagem nativas** para que o que
  transborda continue acessível; clique do meio ou <kbd>Alt</kbd>+arrastar faz o
  pan. O botão **Fit** (que aparece com o zoom ativo) volta ao ajuste padrão.
- Velocidade de reprodução da prévia — percorra 1× / 1,5× / 2× / 4× com **J** /
  **K** / **L** (parado, <kbd>J</kbd> e <kbd>L</kbd> iniciam a reprodução; em
  movimento, <kbd>L</kbd> acelera e <kbd>J</kbd> desacelera, e <kbd>K</kbd>
  alterna reproduzir/pausar voltando para 1×). Afeta apenas o player de prévia,
  nunca a exportação.
- Espaço de trabalho redimensionável: arraste o divisor entre o monitor e a
  timeline (clique duplo para restaurar), além das predefinições de altura de
  trilha S/M/L (S esconde as miniaturas para trilhas compactas)
- **Zoom na seleção** (<kbd>⇧Z</kbd>) enquadra todos os clipes selecionados, não
  apenas um
- **Área de trabalho IN/OUT** — marque com <kbd>i</kbd> e <kbd>o</kbd>
  (<kbd>⇧I</kbd> / <kbd>⇧O</kbd> limpam). Ativar o **Limit** restringe a
  reprodução ao intervalo marcado e faz <kbd>Home</kbd> / <kbd>End</kbd> pularem
  para as posições IN e OUT em vez das pontas da timeline. <kbd>t</kbd> divide os
  clipes nos marcadores; <kbd>⇧t</kbd> apara os clipes à área de trabalho (entre
  o marcador de entrada e o de saída).
- **Localizar e fechar buracos** — um buraco é um trecho em que todas as trilhas
  ativas estão vazias (frames pretos). <kbd>g</kbd> leva o cabeçote ao próximo
  buraco comum (dá a volta no fim; respeita IN/OUT quando os dois estão
  definidos). <kbd>⇧G</kbd> fecha o buraco sob o cabeçote puxando para a esquerda
  os clipes seguintes em todas as trilhas ativas.
- **Redefinir uma propriedade** — <kbd>Ctrl/Cmd+clique</kbd> em um **rótulo** do
  inspetor devolve aquele efeito ou propriedade ao padrão (campos em par, como
  Crop L/R, voltam juntos). Os keyframes daquela propriedade também são apagados;
  nos rótulos de transição, isso limpa as transições de entrada e saída.
- **Substituir a mídia** — o botão **Source** do inspetor (em qualquer clipe de
  vídeo, áudio, imagem ou svg) troca o arquivo de origem preservando posição,
  aparo, keyframes, transições e todos os efeitos. Escolha outro item que já
  esteja no painel ou use **Browse file…** para importar e substituir de uma vez.
  O áudio L/R vinculado a um vídeo é trocado junto; se a nova mídia for mais
  curta, o aparo é ajustado para caber e um aviso informa isso.
- **Áudio de vídeo multicanal** — um vídeo com mais de 2 canais de áudio ganha um
  clipe de áudio vinculado **por canal**, não só L/R (5.1, 7.1…). Trilhas de
  áudio extras (A5, A6, …, até 16) são criadas automaticamente conforme a
  necessidade; ao substituir a mídia de um clipe, os clipes de canal vinculados
  são ressincronizados com a contagem de canais da nova origem, criando ou
  removendo clipes e trilhas conforme o caso.

- **Edições pelo agente** — dividir, exclusão em cascata, levantar / extrair,
  inserir / sobrescrever, aparo em cascata / rolagem / slip / slide e crossfade
  são operações de `fablecut_patch_project` que rodam o mesmo código dos atalhos
  do editor.

**Áudio**

- **Mixer** — a aba **Mixer** ao lado do Inspector tem uma faixa por trilha de
  áudio (fader, pan, mudo, solo e medidor) e um fader master com leitura LUFS ao
  vivo. Pré-visualização e exportação usam a mesma mixagem.
- **Barramentos de submix** — **+ Bus** cria um barramento com efeitos, fader,
  pan, mudo e medidor próprios; o menu sob o nome de cada trilha a envia para um
  barramento (por exemplo, todos os diálogos num único compressor).
- **Ganho, canais e Normalizar** — ganho por clipe (dB), modo de canais (estéreo,
  mono, esquerda, direita, inverter) e **Normalizar** para −14 / −16 / −23 LUFS
  ou −1 dBFS de pico.
- **Linha de volume, fades e crossfades** — arraste a linha de volume de cada
  clipe, as alças dos cantos criam fades e **Shift+D** faz o crossfade no corte.
- **Auto-duck** — a música abaixa sozinha quando alguém fala.
- **Efeitos e presets** — EQ, passa-altas / passa-baixas, compressor, limitador,
  noise gate, delay, reverb, distorção, largura estéreo e mudança de tom, por
  clipe, trilha, barramento e no master. Presets: Clean voice, Podcast, Radio,
  Deep voice, Telephone, Cinematic, Wide e Muffled.
- **Automação de efeitos** — o ◆ ao lado de cada parâmetro marca uma chave no
  cursor, como os keyframes dos clipes.
- **Redução de ruído** — o controle **Noise** do inspector (Light / Medium /
  Strong) mede o ruído de fundo do arquivo e gera uma cópia limpa com o ffmpeg;
  **Off** volta ao original.

**Visual**

- 14 predefinições de filtro em um clique (cinematic, teal-orange, noir, vintage,
  cyberpunk, sunset, midnight…)
- **Camadas de ajuste** — um clipe corrige tudo o que está abaixo dele, no estilo
  Premiere
- Controles completos de cor: brilho/contraste/saturação/matiz, **temperatura e
  tonalidade**, desfoque, escala de cinza/sépia/inverter, **vinheta** e **grão de
  filme** animado
- Modos de mesclagem (screen, multiply, overlay…), modos de encaixe (contain /
  cover / stretch), corte por borda, raio de canto e espelhamento horizontal ou
  vertical
- **Chroma key** (fundo verde) com tolerância e suavização + supressão de
  vazamento de cor
- **Remoção de fundo com IA** (recorte de pessoas, no próprio navegador via
  MediaPipe)

**Movimento**

- Animação por keyframes em cerca de 25 propriedades, com easing
- **Marcadores de keyframe nos clipes** — um losango no corpo do clipe em cada
  instante com keyframes (a dica lista os canais; um contador aparece quando
  vários coincidem no mesmo instante). <kbd>Ctrl/Cmd+←</kbd> /
  <kbd>Ctrl/Cmd+→</kbd> levam o cabeçote ao keyframe anterior ou seguinte
  (primeiro nos clipes selecionados; senão, nos que estiverem sob o cabeçote)
- **Gráficos de keyframe** — ative a curva de uma propriedade no inspetor para
  ver, ao lado do monitor de programa, o gráfico de valores interpolados; clique
  no gráfico para navegar
- **Rampas de velocidade** — coloque keyframes em `speed` e o motor remapeia o
  tempo do vídeo *e* da mixagem de áudio exportada (aquele movimento de reel:
  rápido e então câmera lenta)
- **Tremor de câmera** e **separação RGB / aberração cromática**, ambos animáveis
- 17 transições: fades, slides, wipes (4 direções), zoom, íris, giro, desfoque,
  whip-pan, **glitch** e **pop**

**Texto**

- **Estilos de título** — visuais coesos com um toque (Impact, Elegant, Kinetic
  cut, Neon, Handwritten, Luxury e outros); títulos novos variam sozinhos a
  fonte, a posição e a animação em vez de cair sempre no mesmo padrão sem graça
- Legendas cinéticas: typewriter, word-pop, word-slide, karaoke, **letter-pop**,
  **wave**, **bounce**, **shake**, **clip-reveal**, **zoom-in**, **font-cut**
  (trocas rítmicas de tipografia) e **rise-mask**
- **Brilho neon** para aquele visual de legenda de TikTok
- Editor de fontes: fontes do sistema, fontes próprias que basta soltar em
  `library/fonts/` e **qualquer Google Font pelo nome** — carregada
  automaticamente
- Preenchimento em gradiente, contorno, pílulas de fundo, espaçamento entre
  letras, entrelinha, pesos, itálico, caixa alta e sombras suaves
- **Layout do texto** — alinhamento horizontal: esquerda / centro / direita /
  **justificado** (acrescenta espaços entre as palavras). Arraste as alças de
  canto de um título para criar uma **caixa de texto** (`boxW` / `boxH`); os
  arrastes seguintes a redimensionam (o canto oposto fica fixo;
  <kbd>Ctrl/Cmd</kbd> redimensiona pelo centro e <kbd>Shift</kbd> trava a
  proporção). Dentro da caixa, o texto quebra mantendo o corpo da fonte por
  padrão; ative **Scale to fit** para reduzir a fonte até o bloco inteiro caber.
  O **V-align** (topo / meio / base) posiciona o bloco verticalmente na caixa.
  Defina Box W/H como `0` para voltar ao tamanho que acompanha o conteúdo.

**Clipes SVG animados**

- Um tipo de clipe `svg` de primeira classe: SVGs animados com `@keyframes` do
  CSS são renderizados **com precisão de frame** tanto na prévia quanto na
  exportação (o compositor congela a animação em qualquer instante). Agentes
  podem criar as próprias sobreposições vetoriais — lower thirds, confete,
  brilhos — como arquivos `.svg` comuns. Exemplos iniciais vêm inclusos.

**Refazer um vídeo de referência**

- Entregue uma edição de referência (um reel de que você gostou) e receba de
  volta um **blueprint de edição**: os limites de cada plano, as batidas da
  música e o BPM, uma curva de intensidade, a energia de cada plano, o drop —
  além da **trilha da referência extraída** para as suas mídias, pronta para
  reconstruir a mesma ideia com seu próprio material. Sem dependências extras (o
  ffmpeg cuida da decodificação; a detecção de ataques e de andamento é Node
  puro). Use `node analyze.js ref.mp4`, `POST /api/analyze` ou a ferramenta MCP
  `fablecut_analyze_reference`.

**Biblioteca de recursos**

- As pastas de `library/` aparecem como abas na interface: **Elements** (arte de
  sobreposição), **Sound FX** e **SVG** — solte arquivos ali e o editor aberto se
  atualiza na hora

**Exportação**

- Agentes também exportam: `fablecut_export` roda a exportação rápida no editor
  aberto ou num Chrome / Edge sem janela e devolve o caminho do arquivo
- Exportação rápida: o navegador renderiza cada frame e uma mixagem de áudio
  offline, e o ffmpeg codifica um MP4 CRF-18 com precisão de frame (continua
  renderizando mesmo se você trocar de aba)
- Alternativa em tempo real com MediaRecorder quando o ffmpeg não está disponível

## Começando

```bash
git clone https://github.com/ronak-create/FableCut.git
cd FableCut
node server.js        # → http://localhost:7777
```

Requisitos: **Node 18+** e um navegador baseado em Chromium. Ter o **ffmpeg no
PATH** é opcional, mas recomendado (exportação rápida e remux dos uploads). A
remoção de fundo com IA baixa o modelo de uma CDN no primeiro uso.

O servidor escuta **apenas em 127.0.0.1** (a partir da v1.3.1). Para acessá-lo de
outro dispositivo na sua rede local, habilite explicitamente:
`HOST=0.0.0.0 FABLECUT_ALLOWED_HOSTS=<seu-ip> node server.js`.

Arraste as mídias para a janela (ou coloque em `./media/`), leve os clipes para a
timeline, edite e exporte.

## Operando com um agente de IA

Tudo o que um agente precisa está no **[CLAUDE.md](../../CLAUDE.md)** — o schema
completo, a semântica e um livro de receitas. Aponte qualquer modelo competente
para esse arquivo e ele opera o editor de ponta a ponta.

> 📖 **Documentação navegável:** o mesmo manual em páginas web, uma por tema
> (ferramentas MCP, o schema do `project.json`, propriedades de clipe, receitas,
> API REST, exportação): **[fablecut.space/docs](https://fablecut.space/docs/)**.

Três superfícies de controle equivalentes:

1. **MCP** (melhor opção para Claude Code / Claude Desktop) — registre uma única
   vez o servidor MCP embutido, que não tem dependências:

   ```bash
   claude mcp add -s user fablecut -- node "<caminho-para>/fablecut/mcp-server.js"
   ```

   Ferramentas: `fablecut_status` (inicia o editor sozinho), `fablecut_docs`,
   `fablecut_get_project`, `fablecut_set_project`, `fablecut_patch_project`,
   `fablecut_import_media`, `fablecut_analyze_reference`,
   `fablecut_encode_profiles`, `fablecut_normalize_audio`, `fablecut_auto_duck`,
   `fablecut_denoise`, `fablecut_export`.

   O FableCut também está publicado no **registro oficial de MCP** como
   [`io.github.ronak-create/fablecut`](https://registry.modelcontextprotocol.io/v0/servers?search=fablecut)
   — cada release traz um pacote MCPB (`fablecut.mcpb`) que clientes compatíveis
   com MCPB instalam diretamente.

   A superfície é **econômica em tokens por design**: os agentes aplicam
   alterações na timeline com operações pequenas (`fablecut_patch_project`) em vez
   de mandar o documento inteiro de ida e volta, leem um resumo compacto de uma
   linha por clipe (`fablecut_get_project {compact:true}`) e buscam apenas as
   seções do manual de que precisam (`fablecut_docs {section:"props"}`).
2. **O arquivo** — leia o `project.json`, modifique, incremente o `revision` e
   grave. A interface recarrega sozinha.
3. **REST** — `GET/PUT /api/project`, `POST /api/upload`, `GET /api/library` e
   SSE em `/api/events`. A lista completa está no CLAUDE.md.

Exemplo: peça ao Claude Code *"corte estes seis clipes nos marcadores de batida,
aplique uma correção teal-orange, coloque uma legenda word-pop por cima e um
whoosh em cada corte"* — e veja a timeline se reconstruir.

Ou entregue uma referência: *"gostei deste reel — analise e refaça com os meus
clipes, mantendo a música"*. O agente chama `fablecut_analyze_reference`, recebe
o blueprint da edição (cortes, batidas, BPM, energia, o drop e a trilha extraída)
e reconstrói a estrutura plano a plano com o seu material.

**Edição simultânea sem sobrescrita**: a interface, as ferramentas MCP e a
escrita direta no `project.json` seguem o mesmo contador `revision`. Se você
mexer em um clipe pela interface enquanto o agente trabalha, a próxima escrita
dele é recusada (409 na API REST, ou erro de conflito no
`fablecut_set_project`) em vez de apagar a sua alteração silenciosamente. A
interface também percebe quando uma escrita do agente passa por cima de um ajuste
local ainda não salvo e avisa você, em vez de descartá-lo sem dizer nada.

## Estrutura do projeto

```
server.js        servidor HTTP sem dependências: arquivos estáticos, API REST,
                 SSE e o pipeline de exportação com ffmpeg
app.js           o editor: interface da timeline, compositor, keyframes, motor
                 de texto, rasterizador de SVG, chroma key, exportadores
index.html       interface de página única
style.css        tema escuro do editor
mcp-server.js    servidor MCP por stdio que expõe o editor aos agentes de IA
analyze.js       analisador de vídeo de referência: planos, batidas/BPM,
                 energia, drop e extração de música (módulo e CLI)
CLAUDE.md        o manual do agente (schema + receitas) — também servido pelo
                 fablecut_docs
project.json     a sua timeline (criada no primeiro uso; no .gitignore)
media/           material do projeto (no .gitignore)
analysis/        blueprints de edição em cache do /api/analyze (no .gitignore)
library/         recursos padrão: elements/ sfx/ svg/ fonts/
exports/         renders finalizados (no .gitignore)
```

## Criando sobreposições SVG animadas

Os SVGs animam com `@keyframes` de CSS puro. Só existe uma convenção: nunca
escreva `animation-delay` fixo — defina `--d: 0.4s` no lugar, e o compositor
conduz o tempo pausando todas as animações e recalculando os atrasos delas. As
regras completas e um esqueleto estão no
[CLAUDE.md](../../CLAUDE.md#authoring-animated-svgs-the-svg-clip-kind); exemplos
funcionais em [`library/svg/`](../../library/svg/).

## Observações

- O repositório inclui **20 Google Fonts** (`library/fonts/`, licença OFL — veja
  o `LICENSES.md` lá dentro) e um conjunto autoral de sobreposições SVG e
  elementos animados (`library/elements/`, `library/svg/`, MIT como o resto do
  repositório).
- A pasta `library/sfx/` é sua para preencher (está no .gitignore): sites de
  efeitos sonoros normalmente não permitem redistribuir os arquivos em um
  repositório público, então o FableCut não o faz — o
  `library/sfx/README.md` lista boas fontes gratuitas.
- A exportação roda no navegador porque o compositor *é* o navegador; os agentes
  pedem que você clique em Export (ou renderizam direto com ffmpeg a partir de
  `media/`).

## Comunidade

Dúvidas, ideias, quer mostrar uma edição ou ajudar a decidir o que vem a seguir?
Entre no **[Discord do FableCut](https://discord.gg/EFMQH7d6Tv)**. Bugs e pedidos
de recurso continuam melhor como
[issues no GitHub](https://github.com/ronak-create/FableCut/issues).

## Licença

[MIT](../../LICENSE)

---

<sub>Tradução sincronizada com o <a href="../../README.md">README.md</a> em
<code>3dd1d55</code>. O README em inglês é a referência; se algo ficar
desatualizado, abra uma issue ou um PR.</sub>
