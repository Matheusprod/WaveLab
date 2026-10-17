# WaveLab — Scrolling Waveform

Projeto simples em HTML, CSS e JavaScript puro. Não precisa instalar dependências.

## Abrir no VS Code
1. Extraia `wavelab_project.zip`.
2. Abra a pasta `wavelab_project` no VS Code (`File > Open Folder`).
3. Abra `index.html`.
4. Para executar, use a extensão **Live Server** (botão direito em `index.html` → **Open with Live Server**) ou abra o arquivo diretamente no Chrome.

## Como usar
- Importe um arquivo de áudio WAV ou MP3.
- Opcionalmente, importe uma imagem para o fundo.
- Em "Pick the waveform shape", escolha "Spinning disc" para o disco girando (a imagem do item 2 vira a capa do disco).
- Escolha o formato do vídeo: 9:16 (Reels/Stories/TikTok), 4:5 ou 1:1 (Feed) ou 16:9 (YouTube).
- Ajuste as cores, espessura, velocidade e texto.
- Clique em **Gravar vídeo**, depois em **Parar gravação**.
- Clique em **Baixar vídeo** para salvar o vídeo gravado (`.mp4` no Chrome/Edge atualizados).

## Observações
- Feito com HTML, CSS e JavaScript nativos, sem bibliotecas externas.
- A gravação usa as APIs `MediaRecorder`, `HTMLCanvasElement.captureStream()` e `HTMLMediaElement.captureStream()`. O suporte pode variar conforme o navegador.
- O vídeo sai direto em MP4 (H.264 + AAC, ~4–5 Mbps) quando o navegador suporta. Em navegadores que não gravam MP4, ele cai para WebM.