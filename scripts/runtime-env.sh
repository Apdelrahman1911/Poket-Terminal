#!/usr/bin/env bash
# Sourced once by the foreground launcher. No private provider/KMP profile is read.
# Set optional JAVA_HOME/ANDROID_HOME/PATH in the operator's private env file.
export HOME="${HOME:-/root}"
export PATH="${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"
export LANG="${LANG:-C.UTF-8}"
for _pt_path in "$HOME/.local/bin" "$HOME/.npm-global/bin" /usr/local/sbin /usr/local/bin /usr/sbin /usr/bin /sbin /bin; do
  case ":$PATH:" in *":$_pt_path:"*) ;; *) PATH="$_pt_path:$PATH" ;; esac
done
export PATH
unset _pt_path
