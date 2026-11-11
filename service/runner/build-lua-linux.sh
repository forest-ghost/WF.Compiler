#!/bin/sh
set -eu

output=$(realpath -m "$1")
mkdir -p "$output"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"

# Debian mirrors the same upstream archive. Bound connection time so an
# unavailable lua.org does not stall the build before reaching the mirror.
if ! curl --fail --silent --show-error --location --connect-timeout 10 --max-time 30 \
    https://www.lua.org/ftp/lua-5.1.5.tar.gz -o lua.tar.gz; then
    curl --fail --silent --show-error --location --connect-timeout 10 --max-time 30 \
        https://deb.debian.org/debian/pool/main/l/lua5.1/lua5.1_5.1.5.orig.tar.gz -o lua.tar.gz
fi
echo '2640fc56a795f29d28ef15e13c34a47e223960b0240e8cb0a82d9b0738695333  lua.tar.gz' | sha256sum -c -
tar -xzf lua.tar.gz
cd lua-5.1.5/src

# Preserve the Win32 Lua 5.1 chunk format in both directions. Keep native
# size_t for all runtime sizes and use a 32-bit integer on disk only.
sed -i 's/size_t size=0;/unsigned int size=0;/; s/size_t size=s->tsv.len+1;/unsigned int size=s->tsv.len+1;/' ldump.c
sed -i '/static TString\* LoadString/,/^}/s/size_t size;/unsigned int size;/; s/sizeof(size_t);/sizeof(unsigned int);/' lundump.c
test "$(grep -c 'unsigned int size=' ldump.c)" -eq 2
grep -q 'unsigned int size;' lundump.c
grep -q 'sizeof(unsigned int);' lundump.c

cc -std=gnu99 -O2 -fPIC -shared -Wl,--no-undefined -DLUA_USE_POSIX -DLUA_USE_DLOPEN \
    -o "$output/libwherigo-lua51.so" \
    $(find . -maxdepth 1 -name '*.c' ! -name lua.c ! -name luac.c ! -name print.c | sort) -lm -ldl
cp ../COPYRIGHT "$output/LUA-LICENSE.html"
