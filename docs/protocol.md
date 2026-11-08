# The desktop link

Protocol 2. This is what goes between a page and Shinonome's desktop server, for anyone writing another client. The
server is [`Server.java`](../android/app/src/main/java/com/wonderhoylabs/shinonome/server/Server.java), and the page's side
is [`@wonderhoy-labs/shinonome`](../packages/shinonome/src/session/desktop-session.ts), which most clients should just use.

## Getting there

**Over USB,** the server listens on the abstract Unix socket `shinonome`, and a page reaches it by opening
`localabstract:shinonome` through `adb`. The server runs as the shell user, started by
[`start.sh`](../android/app/src/main/assets/start.sh) from the installed app or from a copy of the APK pushed to
`/data/local/tmp/shinonome/`. It writes its log to `/data/local/tmp/shinonome/server.log`, and a page only connects once
that log has `usb protocol: 2` and `listening` in it, so that another app holding the name first can't fool it. The server
also refuses connections from anyone but the shell user, which is what `adbd` runs as. Each message is a 4-byte big-endian
length, then the message.

**Over Wi-Fi,** the page the phone serves opens a WebSocket at `/ws` on the same HTTPS port, and each binary WebSocket
message is one message. The server first sends AUTH_CHALLENGE, and the page answers with an HMAC-SHA256 of the nonce, keyed
with the pairing code.

## Messages

A type byte, then its fields. Numbers are big-endian, except the sound's samples.

| Type | Name | From | Fields |
| --- | --- | --- | --- |
| 1 | VIDEO | Server | Flags in 1 byte (1 is codec config, 2 is a key frame), capture, encode and send times in microseconds in 8 bytes each, then H.264 in Annex B form |
| 2 | STATUS | Server | JSON: `displayId`, `width`, `height`, `dpi`, `locked`, `usable`, `desktop`, `encoder`, `audio` (`off`, `on` or `failed`), `clipboard` and `dropped` |
| 3 | PONG | Server | The PING's 8 bytes back, then the server's clock in microseconds in 8 bytes |
| 4 | AUTH_CHALLENGE | Server | Wi-Fi only: a 32-byte nonce |
| 5 | AUTH_RESULT | Server | 1 byte: 1 is in, 0 a wrong code, 2 locked out for 30 seconds. Over USB it's sent first, always 1 |
| 6 | REPLACED | Server | Nothing. Another page took the desktop, and this one must not take it back |
| 7 | AUDIO | Server | When the packet's first sample was recorded, in microseconds in 8 bytes, then 10 ms of 16-bit little-endian stereo PCM at 48 kHz |
| 8 | CLIPBOARD | Server | UTF-8 text: what the phone's clipboard holds now |
| 16 | MOUSE | Page | Action in 1 byte (0 move, 1 press, 2 release), button in 1 (1, 2 or 4), then x and y in 4 each |
| 17 | SCROLL | Page | x and y in 4 bytes each, then horizontal and vertical amounts as 4-byte floats |
| 18 | KEY | Page | Action in 1 byte (0 down, 1 up), Android keycode in 4, then Android meta state in 4 |
| 19 | PING | Page | The page's clock in microseconds, as an 8-byte float |
| 20 | STOP | Page | Nothing. Ends the desktop for good |
| 21 | AUTH_RESPONSE | Page | Wi-Fi only: the 32-byte HMAC |
| 22 | KEY_FRAME | Page | Nothing. Asks for a key frame |
| 23 | RESIZE | Page | Width and height in 4 bytes each, then optionally flags in 1 byte (1 is sharp mode). The desktop takes that shape, between 480 and 2560 a side. In sharp mode it takes the phone's density, and as many more pixels as that density shows at 240 dpi, up to 3840 a side |
| 24 | AUDIO_CONTROL | Page | 1 byte: 1 moves the phone's sound to the page, 0 gives it back to the phone |
| 25 | SET_CLIPBOARD | Page | Flags in 1 byte (1 is paste it straight away, with Ctrl+V), then UTF-8 text, up to 1 MiB |

## How a session goes

The page sends PING every 2 seconds, which keeps the session alive and lets it line up the two clocks. If the server hears
nothing for 8 seconds it drops the connection, and if nobody connects for 2 minutes after the last one went, it ends the
desktop. The server keeps at most a few frames queued for a slow link, and skips to a fresh key frame rather than fall behind.

Sound only flows while a page has asked for it, and recording it moves the phone's sound off its speaker. Silence isn't sent.
The phone sends CLIPBOARD whenever something on it changes the clipboard, except to a change the page made itself.

Keys, mouse, scrolls and SET_CLIPBOARD are ignored while the phone is locked, unless the session started unlocked and the
server was told to keep it usable, which is the default.
