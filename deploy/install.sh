#!/usr/bin/env bash
# UniAssist one-command installer / updater for a Linux server.
#
#   curl -fsSL https://raw.githubusercontent.com/mohamedstar19/uniassist/main/deploy/install.sh | sudo bash
#
# Safe to run again: it updates the code and restarts, keeping data and settings.
set -euo pipefail

REPO_URL="${UNIASSIST_REPO:-https://github.com/mohamedstar19/uniassist.git}"
DIR="${UNIASSIST_DIR:-/opt/uniassist}"
DEFAULT_DOMAIN="${UNIASSIST_DOMAIN:-uni.darwish-tech.com}"

green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
red() { printf '\033[31m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }

# Prompts read from the terminal even when the script is piped into bash.
if { : </dev/tty; } 2>/dev/null; then HAS_TTY=1; else HAS_TTY=""; fi
ask() { # ask VAR "question" [secret]
  local __var=$1 __q=$2 __secret=${3:-} __val=""
  if [ -n "$HAS_TTY" ]; then
    if [ -n "$__secret" ]; then read -r -s -p "$__q: " __val </dev/tty; echo >/dev/tty; else read -r -p "$__q: " __val </dev/tty; fi
  fi
  printf -v "$__var" '%s' "$__val"
}

env_get() { grep -E "^$1=" "$DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2- || true; }
env_set() { # replaces the line without sed, so any character in tokens is safe
  local key=$1 val=$2 tmp
  tmp=$(mktemp)
  grep -vE "^$key=" "$DIR/.env" >"$tmp" || true
  printf '%s=%s\n' "$key" "$val" >>"$tmp"
  cat "$tmp" >"$DIR/.env" && rm -f "$tmp"
}
port_busy() { ss -ltnH "( sport = :$1 )" 2>/dev/null | grep -q .; }

if [ "$(id -u)" -ne 0 ]; then
  red "شغّل السكربت بـ sudo:  curl -fsSL https://raw.githubusercontent.com/mohamedstar19/uniassist/main/deploy/install.sh | sudo bash"
  exit 1
fi

step "1/7 المتطلبات (Docker و git)"
if ! command -v git >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  if command -v apt-get >/dev/null; then apt-get update -qq && apt-get install -y -qq git curl openssl iproute2 >/dev/null
  elif command -v dnf >/dev/null; then dnf install -y -q git curl openssl iproute
  else red "ثبّت git و curl يدوي وشغّل السكربت تاني"; exit 1; fi
fi
if ! command -v docker >/dev/null 2>&1; then
  yellow "Docker مش متثبت، بثبّته…"
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker compose version >/dev/null 2>&1 || { red "docker compose plugin مش موجود. ثبّت docker-compose-plugin."; exit 1; }
green "✓ Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null)"

step "2/7 الكود في $DIR"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  git clone "$REPO_URL" "$DIR"
fi
cd "$DIR"
green "✓ $(git log -1 --format='%h %s')"

step "3/7 الإعدادات (.env)"
[ -f .env ] || cp .env.example .env
chmod 600 .env

[ -n "$(env_get POSTGRES_PASSWORD)" ] || env_set POSTGRES_PASSWORD "$(openssl rand -hex 24)"
[ -n "$(env_get DOMAIN)" ] || env_set DOMAIN "$DEFAULT_DOMAIN"
DOMAIN=$(env_get DOMAIN)
env_set PUBLIC_URL "https://$DOMAIN"

TOKEN=$(env_get TELEGRAM_BOT_TOKEN)
while :; do
  if [ -z "$TOKEN" ]; then ask TOKEN "توكن بوت تيليجرام (من @BotFather)" secret; fi
  BOT_USER=$(curl -fsS "https://api.telegram.org/bot$TOKEN/getMe" 2>/dev/null | grep -o '"username":"[^"]*"' | cut -d'"' -f4 || true)
  if [ -n "$BOT_USER" ]; then green "✓ البوت: @$BOT_USER"; env_set TELEGRAM_BOT_TOKEN "$TOKEN"; break; fi
  red "التوكن ده مش شغال، جرب تاني."; TOKEN=""
  [ -n "$HAS_TTY" ] || { red "مفيش terminal للأسئلة: حط القيمة في $DIR/.env وشغّل تاني"; exit 1; }
done

KEY=$(env_get ANTHROPIC_API_KEY)
while :; do
  if [ -z "$KEY" ]; then ask KEY "مفتاح Claude API (من console.anthropic.com)" secret; fi
  CODE=$(curl -s -o /dev/null -w '%{http_code}' https://api.anthropic.com/v1/models -H "x-api-key: $KEY" -H "anthropic-version: 2023-06-01" || true)
  if [ "$CODE" = "200" ]; then green "✓ مفتاح Claude شغال"; env_set ANTHROPIC_API_KEY "$KEY"; break; fi
  red "المفتاح ده مش شغال (HTTP $CODE)، جرب تاني."; KEY=""
  [ -n "$HAS_TTY" ] || { red "مفيش terminal للأسئلة: حط القيمة في $DIR/.env وشغّل تاني"; exit 1; }
done

ADMINS=$(env_get ADMIN_TELEGRAM_IDS)
while [ -z "$ADMINS" ]; do
  ask ADMINS "الـTelegram ID بتاعك (أرقام). مش عارفه؟ دوس Enter وكمّل، وبعدين ابعت /myid للبوت"
  ADMINS=$(echo "$ADMINS" | tr -d ' ')
  [ -z "$ADMINS" ] && { yellow "تمام، هنكمل من غير أدمن دلوقتي."; break; }
  if ! echo "$ADMINS" | grep -qE '^[0-9]+(,[0-9]+)*$'; then red "لازم أرقام بس."; ADMINS=""; [ -n "$HAS_TTY" ] || break; fi
done
env_set ADMIN_TELEGRAM_IDS "$ADMINS"

step "4/7 البورت والوصول من الإنترنت"
APP_PORT=$(env_get APP_PORT); APP_PORT=${APP_PORT:-3100}
RUNNING_APP=$(docker compose ps -q app 2>/dev/null || true)
if [ -z "$RUNNING_APP" ] && port_busy "$APP_PORT"; then
  for p in $(seq 3100 3199); do port_busy "$p" || { APP_PORT=$p; break; }; done
fi
env_set APP_PORT "$APP_PORT"

PROFILES=$(env_get COMPOSE_PROFILES)
if [ -z "$PROFILES" ]; then
  TUNNEL=$(env_get CLOUDFLARE_TUNNEL_TOKEN)
  if [ -n "$TUNNEL" ]; then
    PROFILES=tunnel
  elif ! port_busy 80 && ! port_busy 443; then
    PROFILES=https
  else
    yellow "البورتات 80/443 مستخدمة على السيرفر ده (غالباً nginx تاني شغال)."
    yellow "اختار: لو الدومين على Cloudflare الصق توكن الـTunnel دلوقتي، أو سيبه فاضي وهنستخدم الـnginx الموجود."
    ask TUNNEL "Cloudflare Tunnel token (اختياري)" secret
    if [ -n "$TUNNEL" ]; then env_set CLOUDFLARE_TUNNEL_TOKEN "$TUNNEL"; PROFILES=tunnel; else PROFILES=none; fi
  fi
fi
env_set COMPOSE_PROFILES "$PROFILES"   # "none" = no extra service (kept so re-runs don't ask again)
green "✓ الويب على البورت $APP_PORT، والوصول من بره: ${PROFILES}"

step "5/7 التشغيل (أول مرة بياخد كام دقيقة)"
docker compose up -d --build --remove-orphans

step "6/7 التأكد إن كل حاجة شغالة"
ok=""
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$APP_PORT/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 3
done
if [ -z "$ok" ]; then
  red "الخدمة ما ردتش. آخر اللوجز:"
  docker compose logs --tail 60 app
  exit 1
fi
green "✓ الخدمة شغالة"
docker compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'

step "7/7 النسخ الاحتياطي اليومي"
chmod +x deploy/backup.sh
CRON_LINE="15 4 * * * $DIR/deploy/backup.sh >> /var/log/uniassist-backup.log 2>&1"
{ { crontab -l 2>/dev/null || true; } | { grep -v 'uniassist/deploy/backup.sh' || true; }; echo "$CRON_LINE"; } | crontab -
green "✓ نسخة كل يوم 4:15 الصبح في /var/backups/uniassist"

LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo
green "════════════════════ UniAssist شغال ✅ ════════════════════"
echo "• البوت:            https://t.me/$BOT_USER  (ابعتله /adminhelp)"
echo "• الويب على الشبكة:  http://$LAN_IP:$APP_PORT/health"
echo "• الويب من بره:      https://$DOMAIN"
echo
case "$PROFILES" in
  https)
    yellow "عشان https://$DOMAIN يشتغل من بره:"
    echo "  1) في إعدادات الدومين: A record لـ ${DOMAIN%%.*} ← الـIP العام بتاع الإنترنت عندك"
    echo "     (تعرفه بـ: curl -s https://api.ipify.org)"
    echo "  2) في الراوتر: Port forwarding للبورتات 80 و 443 ← $LAN_IP"
    echo "  الشهادة (HTTPS) بتطلع أوتوماتيك أول ما الاتنين دول يشتغلوا."
    ;;
  tunnel)
    yellow "في Cloudflare Zero Trust ← Tunnels ← Public Hostname:"
    echo "  $DOMAIN  ←  http://app:3000"
    ;;
  *)
    sed -e "s|__DOMAIN__|$DOMAIN|g" -e "s|__UPSTREAM__|$LAN_IP:$APP_PORT|g" deploy/nginx-uniassist.conf.template >deploy/nginx-uniassist.conf
    yellow "ضيف ملف deploy/nginx-uniassist.conf للـnginx الموجود (الـserver block فيه جاهز)، واعمل reload،"
    echo "  وطلّع شهادة: certbot --nginx -d $DOMAIN  (أو استخدم Cloudflare Tunnel)."
    ;;
esac
echo
if [ -z "$ADMINS" ]; then
  yellow "⚠️ لسه مفيش أدمن: ابعت /myid للبوت https://t.me/$BOT_USER ، وبعدين شغّل:"
  echo "   sudo $DIR/deploy/install.sh   (هيسألك عن الـID بس ويكمل)"
fi
echo "البوت شغال دلوقتي حتى قبل ما الدومين يشتغل (تيليجرام مش محتاج بورتات مفتوحة)."
echo "الخطوة الجاية: افتح البوت وابعت /newbatch ← والباقي في الـREADME (قسم: تجهيز أول دفعة)."
