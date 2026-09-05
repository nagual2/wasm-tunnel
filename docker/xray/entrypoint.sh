#!/bin/sh
set -eu
: "${XRAY_UUID:?XRAY_UUID is required (copy .env.example to .env)}"
sed -e "s/__UUID__/${XRAY_UUID}/" \
    -e "s|__WS_PATH__|${WS_PATH:-/tunnel}|" \
    /etc/xray/config.template.json > /etc/xray/config.json
exec xray run -config /etc/xray/config.json
