#!/system/bin/sh
# Starts the server and prints how to connect. Options are passed to the server.
# Runs as the shell user, from either adb or Shizuku.
DIR=/data/local/tmp/shinonome
# The USB site pushes its own copy of the server and names it here, so the app needn't be installed.
APK=${SHINONOME_APK:-$(pm path com.wonderhoylabs.shinonome | head -n 1 | cut -d: -f2)}
if [ -z "$APK" ]; then
    echo "incompatible: The Shinonome app is not installed."
    exit 1
fi

# The log and the directory hold the pairing code, so keep them to the shell user.
umask 077
mkdir -p "$DIR"
chmod 700 "$DIR"
cd "$DIR" || exit 1

# Android leaves a second virtual desktop without title bars, so only one can run at a time. Ending
# the helper ends the desktop on the phone, and its windows return to the phone. When the app runs
# this script it has already ended that desktop, and the helper is what is running the script.
HELPER=$(pidof com.wonderhoylabs.shinonome:shell)
if [ -n "$HELPER" ] && [ "$HELPER" != "$PPID" ] && dumpsys display | grep -q '"shinonome-app"'; then
    echo "Closing the desktop on this phone, because a session replaces it."
    kill "$HELPER"
    sleep 1
fi

if pidof shinonome-server >/dev/null; then
    touch stop
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        pidof shinonome-server >/dev/null || break
        sleep 1
    done
fi
rm -f stop server.log

CLASSPATH="$APK" nohup app_process / --nice-name=shinonome-server com.wonderhoylabs.shinonome.server.Main --dir "$DIR" \
    --adb-port "$(getprop service.adb.tls.port)" "$@" \
    >"$DIR/server.log" 2>&1 </dev/null &

for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
    grep -qE '^(listening|incompatible:)' server.log 2>/dev/null && break
    sleep 1
done
cat server.log
