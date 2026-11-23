#!/bin/bash
# Smoke check for mac/Dekki.app. Uses its own port (default 4391) and a temp state dir; never touches the user's deck on 4317.
#   scripts/mac-app-check.sh [shot-dir]
# Covers: build, owned-server start, window + page loaded, screenshot (in-process), Cmd+W closes only the window (app + server stay),
# reopen brings the window back, Cmd+Q quit leaves no server/children, attach path (window close and quit leave the external
# server running), Finder-style minimal-env launch finds node via the login shell, failure page when node/claude is missing.
set -u
cd "$(dirname "$0")/.."
REPO="$(pwd)"
export PORT="${PORT:-4391}"
[ "$PORT" = 4317 ] && { echo "refusing to test on 4317"; exit 2; }
SHOTS="${1:-$(mktemp -d)}"; mkdir -p "$SHOTS"
T="$(mktemp -d)"
# DEKKI_TEST_AGENTS: the server's poller reads its agents from this file (never `claude agents`) and sends no OS banners.
export DEKKI_STATE="$T/state.json" DEKKI_PROMPTS="$T/prompts" DEKKI_APP_TEST="$T" DEKKI_TEST_AGENTS="$T/agents.json"
echo '[]' > "$T/agents.json"
BIN="$REPO/mac/build/Dekki.app/Contents/MacOS/Dekki"
FAILS=0
ok()   { echo "PASS  $*"; }
bad()  { echo "FAIL  $*"; FAILS=$((FAILS+1)); }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi; }
hook() { rm -f "$T/out"; printf '%s\n' "$1" > "$T/cmd"; for _ in $(seq 1 50); do [ -f "$T/out" ] && { cat "$T/out"; return; }; sleep 0.2; done; echo TIMEOUT; }
health() { curl -s -m 2 -H "Origin: http://127.0.0.1:$PORT" "http://127.0.0.1:$PORT/api/config" | grep -q rootReady; }
waitfor() { for _ in $(seq 1 $2); do eval "$1" && return 0; sleep 0.5; done; return 1; }
gone() { ! kill -0 "$1" 2>/dev/null; }

health && { echo "something already answers on $PORT; pick another PORT"; exit 2; }

echo "== build"
mac/build.sh >/dev/null 2>&1; check "build produced the app" '[ -x "$BIN" ]'
check "ad-hoc signature valid" 'codesign --verify "$REPO/mac/build/Dekki.app" 2>/dev/null'

echo "== owned server"
"$BIN" >"$T/app.log" 2>&1 & APP=$!
check "server healthy after launch" 'waitfor health 60'
SRV=$(pgrep -P $APP | head -1)
check "node server is a child of the app" '[ -n "$SRV" ] && ps -p $SRV -o command= | grep -q "server/start.js"'
check "spawn-helper is executable (node-pty)" 'ls node_modules/node-pty/prebuilds/*/spawn-helper >/dev/null 2>&1 && [ -x "$(ls node_modules/node-pty/prebuilds/*/spawn-helper | head -1)" ]'
sleep 2
check "page loaded in the window (agent list rendered)" '[[ "$(hook "js return document.title + \"|\" + location.href")" == "Dekki|http://127.0.0.1:$PORT/"* ]]'
check "window visible, titled Dekki" 'hook win | grep -q "visible=true title=Dekki"'
check "web view snapshot" 'hook "snap $SHOTS/window.png" | grep -q "^ok"'
check "fetch /api/config works from the page (Origin accepted)" '[[ "$(hook "js const r = await fetch(\"/api/config\"); return r.status")" == 200 ]]'
check "WebSocket upgrade accepted from the page" '[[ "$(hook "js return await new Promise(r => { const w = new WebSocket(\"ws://127.0.0.1:$PORT/ws/history?id=00000000\"); w.onopen = () => r(\"open\"); w.onclose = e => r(\"closed\"); w.onerror = () => r(\"error\"); setTimeout(() => r(\"timeout\"), 4000); })")" == open ]]'
echo "== close window (Cmd+W through the menu): app and server stay"
FRAME1=$(hook win | sed 's/ visible.*//')
hook "key w" >/dev/null; sleep 1
check "window hidden after Cmd+W" 'hook win | grep -q "visible=false"'
check "app process still running" 'kill -0 $APP 2>/dev/null'
check "owned server still running" 'kill -0 $SRV 2>/dev/null'
check "server port healthy after window close" 'health'
echo "== reopen (Dock click path, then Window menu)"
hook reopen >/dev/null; sleep 1
check "window visible again after reopen" 'hook win | grep -q "visible=true title=Dekki"'
check "page still loaded after reopen" '[[ "$(hook "js return document.title + \"|\" + location.href")" == "Dekki|http://127.0.0.1:$PORT/"* ]]'
check "frame kept across close and reopen" '[ "$(hook win | sed "s/ visible.*//")" = "$FRAME1" ]'
hook "snap $SHOTS/reopened.png" >/dev/null
hook "key w" >/dev/null; sleep 1
check "window hidden again" 'hook win | grep -q "visible=false"'
check "Window menu item Show Dekki reopens" 'hook "menu Show Dekki" | grep -q ok && sleep 1 && hook win | grep -q "visible=true"'
echo "== menu-bar item (fake login item: a test run never registers a real one)"
SM=$(hook status-menu)
check "status item has Show Dekki, Start at login, Quit (no count at 0)" 'echo "$SM" | grep -q "^Show Dekki|" && echo "$SM" | grep -q "^Start at login|off|enabled" && echo "$SM" | grep -q "^Quit Dekki|" && ! echo "$SM" | grep -q "need"'
check "glyph is a template image, Dock icon kept" 'echo "$SM" | grep -q "template=true" && echo "$SM" | grep -q "dock=true"'
check "glyph renders (light and dark preview)" 'hook "status-shot $SHOTS/menubar-glyph.png" | grep -q ok'
# manager agents as the server's poller sees them (shape of server/agents.js rows); only managers that need input count
agent() { printf '{"id":"%s","name":"%s","state":"%s","status":"busy","needsInput":%s,"stalled":false,"parent":null,"mine":%s,"startedAtRoot":true}' "$1" "$2" "$3" "$4" "${5:-true}"; }
setagents() { printf '[%s]\n' "$1" > "$T/agents.json"; }
counted() { waitfor "hook poll | grep -q \"count=$1 badge=$2\$\"" 30; }   # server poller (3 s) then the app's poll
check "Dock badge empty and no count line with nothing waiting" 'counted 0 "" && ! hook status-menu | grep -q need'
setagents "$(agent aaaaaaa1 plan blocked true),$(agent aaaaaaa2 build working false),$(agent aaaaaaa3 other blocked true false)"
check "badge 1: one manager needs input (a working manager and an Other agent do not count)" 'counted 1 1'
check "menu: singular count line, glyph shows 1" 'SM=$(hook status-menu); echo "$SM" | grep -q "^1 agent needs input|" && echo "$SM" | grep -q "^button= 1|"'
setagents "$(agent aaaaaaa1 plan blocked true),$(agent aaaaaaa2 build blocked true)"
check "badge 2 and the menu line follow" 'counted 2 2 && hook status-menu | grep -q "^2 agents need input|"'
hook "snap $SHOTS/badge-2.png" >/dev/null
setagents ""
check "badge cleared when nothing waits" 'counted 0 "" && ! hook status-menu | grep -q need'

echo "== notifications (fake notification center: no permission prompt, no real banner; the server's OS notifier is silenced by DEKKI_TEST_AGENTS)"
posted() { hook events | sed 's/.*posted=//'; }
check "app subscribed to the server's event stream" 'waitfor "hook events | grep -q \"connected=true\"" 20'
hook notif-reset >/dev/null   # the badge checks above already produced an event; start from a clean fake center
check "no permission request and nothing posted before the first event" '[ -z "$(posted)" ] && hook events | grep -q "auth=notDetermined"'
setagents "$(agent aaaaaaa1 plan working false),$(agent aaaaaaa2 build working false)"
sleep 4   # one server poll records the baseline
setagents "$(agent aaaaaaa1 plan blocked true),$(agent aaaaaaa2 build working false)"
check "needs-input event reaches the app: permission asked at first use, then posted with the server's text and link" 'waitfor "[ \"\$(posted)\" = \"auth-request;;post|Dekki|plan needs your input|#default:aaaaaaa1|dekki-default-aaaaaaa1\" ]" 30'
setagents "$(agent aaaaaaa1 plan blocked true),$(agent aaaaaaa2 build done false)"
check "finished event posts without asking again; the steady needs-input does not repeat" 'waitfor "posted | grep -q \"dekki-default-aaaaaaa2\"" 30 && [ "$(posted | grep -o "auth-request" | wc -l | tr -d " ")" = 1 ] && [ "$(posted | grep -o "post|" | wc -l | tr -d " ")" = 2 ] && posted | grep -q "post|Dekki|build finished|#default:aaaaaaa2|"'
setagents "$(agent aaaaaaa1 plan blocked true false),$(agent aaaaaaa9 other working false false)"
sleep 7
check "nothing more for non-manager agents (rules stay in server/notify.js)" '[ "$(posted | grep -o "post|" | wc -l | tr -d " ")" = 2 ]'
hook "js location.hash = \"\"; return 1" >/dev/null
hook "key w" >/dev/null; sleep 1
hook "notif-click #default:aaaaaaa1" >/dev/null
check "click: window shown again" 'sleep 1; hook win | grep -q "visible=true"'
check "click: page routes to the agent (hash #default:<id> becomes #<id>)" 'waitfor "[ \"\$(hook \"js return location.hash\")\" = \"#aaaaaaa1\" ]" 10'
hook "notif-click #default:aaaaaaa2/history" >/dev/null
check "click with the History link opens History of that agent" 'waitfor "[ \"\$(hook \"js return location.hash\")\" = \"#aaaaaaa2/history\" ]" 10'
hook "key w" >/dev/null; sleep 1
hook "notif-click #../x" >/dev/null; sleep 1
check "click with an invalid link: window shown, page hash untouched" 'hook win | grep -q "visible=true" && [ "$(hook "js return location.hash")" = "#aaaaaaa2/history" ]'
check "authorization request asked for alert + badge (no sound)" 'hook notif-options | grep -q "^options=alert,badge opened="'
echo "== Dock badge hint (fake Badge app icon setting)"
hook "notif-badge off" >/dev/null
setagents "$(agent aaaaaaa1 plan blocked true)"
counted 1 1
check "hint shown: authorized + badge off + count > 0" 'hook status-menu | grep -q "^Enable Badge app icon in System Settings > Notifications|"'
hook "status-click Enable Badge app icon in System Settings > Notifications" >/dev/null
check "hint click opens the Notifications settings pane (URL asserted, not opened)" 'hook notif-options | grep -q "opened=x-apple.systempreferences:com.apple.Notifications-Settings.extension$"'
hook "notif-badge on" >/dev/null
check "hint hidden when Badge app icon is on" '! hook status-menu | grep -q "Enable Badge app icon"'
hook "notif-badge off" >/dev/null
hook "notif-auth denied" >/dev/null
check "hint hidden when notifications are denied" '! hook status-menu | grep -q "Enable Badge app icon"'
hook "notif-auth authorized" >/dev/null
setagents ""
counted 0 ""
check "hint hidden when nothing waits" '! hook status-menu | grep -q "Enable Badge app icon"'
hook "notif-badge on" >/dev/null
hook "notif-auth denied" >/dev/null; sleep 1
check "notifications denied in System Settings: app unsubscribes (server fallback takes over)" 'hook events | grep -q "running=false"'
hook "notif-auth authorized" >/dev/null
check "allowed again: app subscribes again" 'waitfor "hook events | grep -q \"connected=true\"" 20'
setagents ""
check "badge cleared after the notification tests" 'counted 0 ""'
hook "key w" >/dev/null; sleep 1
check "status menu Show Dekki brings the window back" 'hook "status-click Show Dekki" | grep -q ok && sleep 1 && hook win | grep -q "visible=true"'
check "login: starts off, no calls yet" '[ "$(hook login)" = "status=off calls= alerts=" ]'
hook "status-click Start at login" >/dev/null
check "login: click registers (fake) and the box is checked" '[ "$(hook login)" = "status=enabled calls=register alerts=" ] && hook status-menu | grep -q "^Start at login|on|"'
hook "status-click Start at login" >/dev/null
check "login: click again unregisters, box unchecked" '[ "$(hook login)" = "status=off calls=register,unregister alerts=" ] && hook status-menu | grep -q "^Start at login|off|"'
hook "login-next requiresApproval" >/dev/null
hook "status-click Start at login" >/dev/null
check "login: requiresApproval tells the user to approve and opens Login Items settings (fake)" '[ "$(hook login)" = "status=requiresApproval calls=register,unregister,register,openSettings alerts=Start at login needs your approval" ] && hook status-menu | grep -q "^Start at login (needs approval)|mixed|"'
hook "status-click Start at login (needs approval)" >/dev/null
check "login: clicking while approval is pending re-opens settings, never registers again" 'hook login | grep -q "calls=register,unregister,register,openSettings,openSettings alerts=Start at login needs your approval;Start at login needs your approval"'
hook "login-set off" >/dev/null
check "login: status changed outside the app shows at next menu refresh" 'hook status-menu | grep -q "^Start at login|off|"'
hook "status-click Quit Dekki" >/dev/null
check "status menu Quit quits cleanly (app and owned server gone)" 'waitfor "gone $APP" 30 && gone $SRV && ! health'

echo "== started as a login item: window stays hidden, server and menu-bar item run, Dock click shows it"
DEKKI_TEST_LOGIN_LAUNCH=1 "$BIN" >"$T/app5.log" 2>&1 & APP=$!
check "login launch: server healthy" 'waitfor health 60'
SRV=$(pgrep -P $APP | head -1)
check "login launch: window hidden" 'hook win | grep -q "visible=false"'
check "login launch: page still loaded in the hidden window" '[[ "$(hook "js return document.title")" == "Dekki" ]]'
check "login launch: menu-bar item present" 'hook status-menu | grep -q "^Show Dekki|"'
hook reopen >/dev/null; sleep 1
check "login launch: Dock click shows the window" 'hook win | grep -q "visible=true"'
KIDS="$SRV $(pgrep -P $SRV | tr '\n' ' ')"
hook "key q" >/dev/null
check "login launch: quit clean" 'waitfor "gone $APP" 30 && gone $SRV'

echo "== owned server again (for quit checks)"
"$BIN" >"$T/app1b.log" 2>&1 & APP=$!
waitfor health 60 || bad "server did not restart"
SRV=$(pgrep -P $APP | head -1)
KIDS="$SRV $(pgrep -P $SRV | tr '\n' ' ')"
echo "== quit (Cmd+Q through the menu)"
hook "key q" >/dev/null
check "app exited" 'waitfor "gone $APP" 30'
check "owned server gone" 'gone $SRV'
check "server port closed" '! health'
LEFT=$(pgrep -f "server/start.js" | while read p; do ps -p $p -E -o command= 2>/dev/null | grep -q "PORT=$PORT" && echo $p; done)
check "no orphan node on the port" '[ -z "$LEFT" ]'

echo "== attach to an existing server"
node server/start.js >"$T/ext.log" 2>&1 & EXT=$!
waitfor health 60 || bad "external server did not start"
"$BIN" >"$T/app2.log" 2>&1 & APP=$!
sleep 4
check "app owns no child when attaching" '[ -z "$(pgrep -P $APP)" ]'
check "attached window loaded the page" '[[ "$(hook "js return document.title")" == "Dekki" ]]'
hook "key w" >/dev/null; sleep 1
check "attach: window closed, app still running" 'hook win | grep -q "visible=false" && kill -0 $APP 2>/dev/null'
check "attach: external server still running after window close" 'kill -0 $EXT 2>/dev/null && health'
hook reopen >/dev/null; sleep 1
check "attach: reopen shows the page" 'hook win | grep -q "visible=true" && [[ "$(hook "js return document.title")" == "Dekki" ]]'
hook "key q" >/dev/null
check "app exited" 'waitfor "gone $APP" 30'
check "external server still running after app quit" 'kill -0 $EXT 2>/dev/null && health'
kill $EXT 2>/dev/null; waitfor "gone $EXT" 20

echo "== Finder-style launch (minimal env, PATH only /usr/bin:/bin:/usr/sbin:/sbin): app must find node through the login shell"
env -i HOME="$HOME" USER="$USER" SHELL=/bin/zsh PATH=/usr/bin:/bin:/usr/sbin:/sbin PORT="$PORT" DEKKI_STATE="$T/state.json" DEKKI_NOTIFY=0 DEKKI_TEST_AGENTS="$T/agents.json" DEKKI_PROMPTS="$T/prompts" DEKKI_APP_TEST="$T" "$BIN" >"$T/app4.log" 2>&1 & APP=$!
check "Finder env: server healthy (node found via login shell)" 'waitfor health 60'
OUT=$(hook "js return document.body.innerText")
check "Finder env: no 'not found' error in window" '! echo "$OUT" | grep -qi "not found"'
SRV=$(pgrep -P $APP | head -1)
check "Finder env: node server is a child of the app" '[ -n "$SRV" ] && ps -p $SRV -o command= | grep -q "server/start.js"'
hook "snap $SHOTS/finder-env.png" >/dev/null
hook "key q" >/dev/null
check "Finder env: app exited on quit" 'waitfor "gone $APP" 30'
check "Finder env: server gone and port closed after quit" '[ -n "$SRV" ] && gone $SRV && ! health'

echo "== error page when claude is missing"
EMPTY="$T/emptybin"; mkdir -p "$EMPTY"
env -i SHELL=/bin/sh PATH="$EMPTY" PORT="$PORT" DEKKI_APP_TEST="$T" "$BIN" >"$T/app3.log" 2>&1 & APP=$!
sleep 4
OUT=$(hook "js return document.body.innerText")
check "in-window error names the missing tool" 'echo "$OUT" | grep -qiE "node not found|claude not found"'
hook "snap $SHOTS/error.png" >/dev/null
hook "key q" >/dev/null; waitfor "gone $APP" 30

echo
[ $FAILS = 0 ] && echo "ALL PASS (shots: $SHOTS)" || echo "$FAILS FAILED (shots: $SHOTS, temp: $T)"
[ $FAILS = 0 ]
