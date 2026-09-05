#!/bin/sh
set -eu
: "${XRAY_UUID:?XRAY_UUID is required (copy .env.example to .env)}"
: "${SS_PASSWORD:?SS_PASSWORD is required (copy .env.example to .env)}"
sed -e "s/__UUID__/${XRAY_UUID}/" \
    -e "s/__SS_PASSWORD__/${SS_PASSWORD}/" \
    -e "s/__SS_METHOD__/${SS_METHOD:-aes-256-gcm}/" \
    -e "s|__WS_PATH__|${WS_PATH:-/tunnel}|" \
    -e "s|__SS_PATH__|${SS_PATH:-/ss}|" \
    /etc/xray/config.template.json > /etc/xray/config.json
exec xray run -config /etc/xray/config.json
