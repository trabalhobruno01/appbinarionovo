# ChartPulse AI — Analista Financeiro por Fotografia

Aplicativo mobile-first (Web + Android APK via Capacitor WebView) para análise técnica de gráficos financeiros a partir de fotografias da tela do computador ou celular, com cotações reais e horários sincronizados no fuso de Brasília (`America/Sao_Paulo`).

## Variáveis de Ambiente

Configure no painel de Secrets (ou no Netlify em **Site settings > Environment variables**):

- `GEMINI_API_KEY` *(obrigatória)*: Chave da API Gemini usada exclusivamente no backend (`/api/analyze` e `/api/chat`).
- `TWELVE_DATA_API_KEY` *(opcional)*: Chave adicional para ações globais e forex. Criptomoedas (Binance Spot API) e ações/índices/forex (Yahoo Finance) funcionam sem chave adicional.
- `CAPACITOR_SERVER_URL` *(opcional para APK)*: URL HTTPS publicada na Netlify (ex.: `https://seu-app.netlify.app`) para o APK abrir diretamente sua versão em produção.

## Deploy na Netlify

1. Envie o repositório para o GitHub.
2. Conecte o repositório na Netlify (`netlify.toml` já configura `npm run build`, `dist` e as Netlify Functions em `netlify/functions/`).
3. Cadastre `GEMINI_API_KEY` nas variáveis de ambiente da Netlify.

## Gerar APK Android (GitHub Actions)

1. (Opcional) Defina a variável de repositório `CAPACITOR_SERVER_URL` no GitHub com sua URL HTTPS da Netlify.
2. Execute a action **Build Android APK** na aba **Actions** do GitHub (ou faça push na branch `main`).
3. Baixe o artefato `chartpulse-ai-debug-apk` (`app-debug.apk`) e instale no Android.
