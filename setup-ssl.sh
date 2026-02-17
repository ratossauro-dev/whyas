#!/bin/bash
# ============================
# SSL/HTTPS Setup — Let's Encrypt
# ============================

set -e

echo ""
echo "============================================"
echo "  🔒 Setup SSL/HTTPS com Let's Encrypt"
echo "============================================"
echo ""

# Ask for domain
read -p "🌐 Digite seu domínio (ex: meusite.com): " DOMAIN

if [ -z "$DOMAIN" ]; then
    echo "❌ Domínio não informado!"
    exit 1
fi

echo ""
echo "📋 Configurando para: $DOMAIN"
echo ""

# Install certbot
echo "📦 Instalando Certbot..."
sudo apt update
sudo apt install -y certbot python3-certbot-nginx

# Create certbot webroot
sudo mkdir -p /var/www/certbot

# Update nginx config with the domain
echo "📝 Atualizando nginx.conf com domínio..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
sed -i "s/SEU_DOMINIO.COM/$DOMAIN/g" "$SCRIPT_DIR/nginx.conf"

# Copy nginx config
echo "🔧 Copiando configuração nginx..."
sudo cp "$SCRIPT_DIR/nginx.conf" /etc/nginx/sites-available/whatsapp
sudo ln -sf /etc/nginx/sites-available/whatsapp /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default

# Test nginx config (HTTP only first)
sudo nginx -t

# Restart nginx for HTTP
sudo systemctl restart nginx

# Get SSL certificate
echo "🔐 Obtendo certificado SSL..."
sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email

# Restart nginx with SSL
sudo systemctl restart nginx

# Setup auto-renewal cron
echo "⏰ Configurando renovação automática..."
(crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet --post-hook 'systemctl restart nginx'") | sort -u | crontab -

echo ""
echo "============================================"
echo "  ✅ SSL configurado com sucesso!"
echo "============================================"
echo ""
echo "🌐 Acesse: https://$DOMAIN"
echo "🔐 Admin:  https://$DOMAIN/admin/login"
echo "❤️  Health: https://$DOMAIN/health"
echo ""
echo "🔄 Renovação automática: todo dia às 3:00 AM"
echo ""
