#!/bin/bash
# ============================
# WhatsApp Bot - Deploy Script
# Para Hetzner Cloud (Ubuntu)
# ============================

set -e

echo "🔧 Instalando dependências do sistema..."
sudo apt update
sudo apt install -y curl git ufw

# Firewall (UFW)
echo "🛡️  Configurando Firewall..."
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP
sudo ufw allow 443/tcp   # HTTPS
sudo ufw --force enable
echo "✅ Firewall ativo: SSH, HTTP, HTTPS liberados"

# Node.js 20 LTS
if ! command -v node &> /dev/null; then
    echo "📦 Instalando Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt install -y nodejs
fi

echo "Node.js: $(node -v)"
echo "NPM: $(npm -v)"

# Chromium (necessário pro WPPConnect/Puppeteer)
echo "🌐 Instalando Chromium..."
sudo apt install -y chromium-browser || sudo apt install -y chromium
sudo apt install -y \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
    libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 \
    libxshmfence1 fonts-liberation

# PM2
if ! command -v pm2 &> /dev/null; then
    echo "⚡ Instalando PM2..."
    sudo npm install -g pm2
fi

# Nginx (para HTTPS/proxy)
echo "🌐 Instalando Nginx..."
sudo apt install -y nginx

# Dependências do projeto
echo "📦 Instalando dependências do projeto..."
npm install --production

# Criar diretórios
mkdir -p logs
mkdir -p tokens
mkdir -p backups

# Iniciar com PM2
echo "🚀 Iniciando bot com PM2..."
pm2 start ecosystem.config.js
pm2 save
pm2 startup

echo ""
echo "========================================="
echo "✅ Deploy concluído!"
echo "========================================="
echo ""
echo "📊 PM2 Commands:"
echo "   pm2 status                 | Ver status"
echo "   pm2 logs whatsapp-bot      | Ver logs"
echo "   pm2 restart whatsapp-bot   | Reiniciar"
echo "   pm2 stop whatsapp-bot      | Parar"
echo ""
echo "🌐 Acesse: http://$(curl -s ifconfig.me):3000"
echo ""
echo "========================================="
echo "📝 Para HTTPS com domínio:"
echo "========================================="
echo "1. Apontar domínio para este IP"
echo "2. Rodar: bash setup-ssl.sh"
echo "   (script interativo que configura tudo automaticamente)"
echo ""
