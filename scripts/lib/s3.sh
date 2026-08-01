#!/usr/bin/env bash
#
# s3.sh — shared S3-compatible object transfer for backup.sh and restore.sh.
#
# Sourced, not executed. Provides three functions:
#
#   s3_client        echo the client this host will use ("aws" or "mc"), or
#                    return 1 with nothing on stdout when neither is installed.
#   s3_put  SRC KEY  upload a local file to $S3_BUCKET at object key KEY.
#   s3_get  KEY DST  download object key KEY from $S3_BUCKET to a local path.
#
# Configuration is read from the environment, and the variable names are exactly
# the contract packages/helm/templates/cronjob-backup.yaml already injects, so
# the chart needs no translation layer:
#
#   S3_BUCKET             destination bucket (required for put/get)
#   S3_ENDPOINT           S3-compatible endpoint URL. OPTIONAL — empty means the
#                         AWS public endpoint for AWS_DEFAULT_REGION.
#   AWS_DEFAULT_REGION    region; defaults to us-east-1, which is what MinIO
#                         reports unless it has been configured otherwise.
#   AWS_ACCESS_KEY_ID     credentials. Never placed in a URL — see below.
#   AWS_SECRET_ACCESS_KEY
#   TRUEPPM_S3_CLIENT     force "aws" or "mc" instead of autodetecting.
#   TRUEPPM_S3_ALLOW_PLAINTEXT
#                         set to "1" or "true" to silence the plaintext-endpoint
#                         warning below for an operator who has verified the
#                         network path is trusted ("true" so the same value
#                         works whether it's exported by hand or injected as a
#                         Helm-quoted boolean, backup.s3.allowPlaintext). Does
#                         not change any behavior other than the warning —
#                         S3_ENDPOINT's scheme is still passed through
#                         verbatim either way.
#
# ---------------------------------------------------------------------------
# Why path-style addressing
#
# Virtual-hosted-style puts the bucket in the hostname (bucket.s3.example.com).
# A self-hosted MinIO is typically reached by IP or by a single hostname with no
# wildcard DNS and no wildcard TLS SAN, so virtual-hosted requests resolve to
# nothing. Path-style (s3.example.com/bucket) is what such a deployment can
# actually serve, so we force it whenever a custom endpoint is configured.
#
# Why credentials never go in a URL
#
# `mc` also accepts a MC_HOST_<alias>=proto://ACCESS:SECRET@host URL, which is
# tempting because it needs no config file. It is unusable here: a real 40-char
# AWS secret key is base64 and routinely contains "/", "+", and ":", and such a
# secret fails through MC_HOST both raw (the ":" splits the userinfo in the
# wrong place) and percent-encoded (the signature is then computed over the
# still-encoded value). Verified against MinIO with the secret "ab/cd+ef:gh...":
# raw returns "The security token included in the request is invalid",
# percent-encoded returns "The request signature we calculated does not match".
# So credentials reach `aws` through its own environment variables and reach
# `mc` through `mc alias set` argv — neither path parses a URL.
# ---------------------------------------------------------------------------

# Resolve the transfer client once. Prefers the AWS CLI: it consumes
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY directly, which is the same contract
# the chart injects, so there is nothing to re-encode.
s3_client() {
  if [ -n "${TRUEPPM_S3_CLIENT:-}" ]; then
    command -v "$TRUEPPM_S3_CLIENT" >/dev/null 2>&1 \
      || return 1
    printf '%s' "$TRUEPPM_S3_CLIENT"
    return 0
  fi
  if command -v aws >/dev/null 2>&1; then
    printf 'aws'
    return 0
  fi
  if command -v mc >/dev/null 2>&1; then
    printf 'mc'
    return 0
  fi
  return 1
}

# Human-readable install hint, used in the error message when no client is found.
s3_client_hint() {
  echo "install the AWS CLI (aws) or the MinIO client (mc), or set TRUEPPM_S3_CLIENT"
}

# Configure an `mc` alias named "trueppm" in a private, writable config dir.
#
# MC_CONFIG_DIR is redirected into the scratch dir because the backup job runs
# with readOnlyRootFilesystem, so mc cannot write its default ~/.mc. The alias is
# set through argv rather than a URL for the encoding reason documented above.
_s3_mc_alias() {
  : "${S3_ENDPOINT:?mc requires an explicit S3_ENDPOINT}"
  MC_CONFIG_DIR="${MC_CONFIG_DIR:-${TMPDIR:-/tmp}/trueppm-mc-$$}"
  export MC_CONFIG_DIR
  mkdir -p "$MC_CONFIG_DIR"
  mc --quiet alias set trueppm "$S3_ENDPOINT" \
    "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID is required for the mc client}" \
    "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY is required for the mc client}" \
    >/dev/null
}

# _s3_endpoint_looks_incluster HOST — best-effort heuristic: succeeds when HOST
# looks like it resolves inside the cluster or on a private network, i.e.
# plaintext to it is the documented, expected shape (docs/administration/
# backup-restore.md and configuration.md both show http://minio:9000 as the
# in-cluster default). Fails otherwise, including for anything this heuristic
# cannot classify — a false "in-cluster" verdict silences the warning that
# _s3_warn_if_remote_plaintext exists to give (the bug it fixes), while a false
# "remote" verdict only costs an operator one extra log line. Bias accordingly.
#
# Recognized as in-cluster/local:
#   - a bare, dot-free short name (Kubernetes Service DNS, e.g. "minio")
#   - a name ending in .svc (Kubernetes Service DNS, partially qualified)
#   - a name ending in .local — this also covers .svc.cluster.local and
#     .cluster.local (fully-qualified Kubernetes Service DNS), and mDNS / a
#     private lab domain
#   - "localhost", a loopback literal (127.0.0.0/8, ::1), or an RFC1918 IPv4
#     literal (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
#
# NOT attempted: DNS resolution, /etc/hosts, or knowledge of your VPC/peering
# topology. A privately-routed FQDN, or a public-DNS name that happens to
# resolve to a private IP, is not recognized here and WILL warn — deliberately
# (see TRUEPPM_S3_ALLOW_PLAINTEXT above for that operator's opt-out).
_s3_endpoint_looks_incluster() {
  case "$1" in
    # *.local also matches *.svc.cluster.local and *.cluster.local (both end in
    # ".local"), so only the bare ".svc" suffix needs its own arm.
    localhost | ::1 | *.local | *.svc) return 0 ;;
    127.*.*.* | 10.*.*.* | 192.168.*.*) return 0 ;;
    172.1[6-9].*.* | 172.2[0-9].*.* | 172.3[01].*.*) return 0 ;;
    *.*) return 1 ;; # dotted name/IP not matched above → treat as remote
    *) return 0 ;;   # no dot at all → bare short name → treat as in-cluster
  esac
}

# Warn — never block — when S3_ENDPOINT is unencrypted (http://) and does not
# look in-cluster. The upload artifact is a full PostgreSQL dump (every
# project, task, and user email in the deployment); plaintext to a remote
# endpoint puts that dump on the wire in the clear, and nothing else in this
# path objects. In-cluster plaintext (the documented http://minio:9000
# default) is fine and must stay silent — see _s3_endpoint_looks_incluster.
_s3_warn_if_remote_plaintext() {
  case "${S3_ENDPOINT:-}" in
    http://*) ;;
    *) return 0 ;; # empty, or already https:// (or another scheme) — nothing to warn about
  esac
  case "${TRUEPPM_S3_ALLOW_PLAINTEXT:-}" in
    1 | true) return 0 ;;
  esac
  _host="${S3_ENDPOINT#http://}"
  _host="${_host%%/*}"
  _host="${_host%%:*}"
  if ! _s3_endpoint_looks_incluster "$_host"; then
    echo "WARNING: S3_ENDPOINT ($S3_ENDPOINT) is plaintext (http://) and does not" \
      "look like an in-cluster or private-network address — the backup" \
      "artifact (a full database dump) will cross the network unencrypted." \
      "Use https:// for any off-cluster endpoint, or set" \
      "TRUEPPM_S3_ALLOW_PLAINTEXT=1 if this path is known-trusted." >&2
  fi
}

# Shared preamble for every call: default the region and force path-style
# addressing when a custom endpoint is configured.
#
# Path-style is forced ONLY for a custom endpoint — against real AWS,
# virtual-hosted is correct and path-style is deprecated. The export has to
# happen in the calling function's own shell, not inside a command
# substitution, which would set it in a subshell that exits before aws runs.
#
# Each caller then builds the endpoint flags with `set -- --endpoint-url "$X"`
# in its own body. That is deliberate: the tempting `aws $(args) ...` form needs
# an UNQUOTED command substitution to split the flag pair into two words, which
# re-splits the endpoint value too — so an endpoint containing whitespace would
# inject extra argv into the aws call. Positional parameters keep the value
# exactly one word whatever it contains, and `set --` inside a function is local
# to that function.
_s3_prepare() {
  AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"
  export AWS_DEFAULT_REGION
  if [ -n "${S3_ENDPOINT:-}" ]; then
    AWS_S3_ADDRESSING_STYLE=path
    export AWS_S3_ADDRESSING_STYLE
  fi
}

# s3_put <local-file> <object-key>
s3_put() {
  _src="$1"
  _key="$2"
  : "${S3_BUCKET:?S3_BUCKET is required to upload}"
  _s3_warn_if_remote_plaintext
  _s3_prepare

  case "$(s3_client)" in
    aws)
      if [ -n "${S3_ENDPOINT:-}" ]; then set -- --endpoint-url "$S3_ENDPOINT"; else set --; fi
      aws "$@" s3 cp "$_src" "s3://${S3_BUCKET}/${_key}" >/dev/null
      ;;
    mc)
      _s3_mc_alias
      mc --quiet cp "$_src" "trueppm/${S3_BUCKET}/${_key}" >/dev/null
      ;;
    *)
      return 127
      ;;
  esac
}

# s3_latest_key [key-prefix] — echo the newest trueppm-backup-*.tar.gz key under
# the prefix, or return 1 when the bucket holds none.
#
# Artifact names embed a UTC timestamp (trueppm-backup-YYYYmmddTHHMMSSZ.tar.gz)
# and so sort lexicographically in chronological order, which is why a plain
# `sort | tail -1` is a correct "newest" and no date parsing is needed.
s3_latest_key() {
  _prefix="$(printf '%s' "${1:-}" | sed 's#^/*##; s#/*$##')"
  : "${S3_BUCKET:?S3_BUCKET is required to list}"
  _s3_prepare
  _found=""

  case "$(s3_client)" in
    aws)
      if [ -n "${S3_ENDPOINT:-}" ]; then set -- --endpoint-url "$S3_ENDPOINT"; else set --; fi
      # "$@" carries GLOBAL options only. --prefix is an option of the
      # `s3api list-objects-v2` subcommand and must follow it: placed before the
      # subcommand the CLI rejects the call, and with stderr discarded that
      # failure looks exactly like an empty bucket.
      #
      # An empty prefix is passed as the empty string rather than omitted, which
      # matches every key — appending "/" to an empty prefix would instead search
      # for keys beginning with a literal slash and always find nothing.
      _found="$(aws "$@" s3api list-objects-v2 \
        --bucket "$S3_BUCKET" \
        --prefix "${_prefix:+$_prefix/}" \
        --query 'Contents[].Key' --output text 2>/dev/null \
        | tr '\t' '\n')"
      ;;
    mc)
      _s3_mc_alias
      # mc ls --recursive prints the object path in the final column, relative to
      # the listed directory, so re-attach the prefix to rebuild the full key.
      _found="$(mc --quiet ls --recursive "trueppm/${S3_BUCKET}/${_prefix}" 2>/dev/null \
        | awk '{print $NF}' \
        | sed "s#^#${_prefix:+$_prefix/}#")"
      ;;
    *)
      return 127
      ;;
  esac

  _found="$(printf '%s\n' "$_found" \
    | grep -E 'trueppm-backup-[0-9TZ]+\.tar\.gz$' \
    | sort \
    | tail -n 1)"
  [ -n "$_found" ] || return 1
  printf '%s' "$_found"
}

# s3_get <object-key> <local-file>
s3_get() {
  _key="$1"
  _dst="$2"
  : "${S3_BUCKET:?S3_BUCKET is required to download}"
  _s3_prepare

  case "$(s3_client)" in
    aws)
      if [ -n "${S3_ENDPOINT:-}" ]; then set -- --endpoint-url "$S3_ENDPOINT"; else set --; fi
      aws "$@" s3 cp "s3://${S3_BUCKET}/${_key}" "$_dst" >/dev/null
      ;;
    mc)
      _s3_mc_alias
      mc --quiet cp "trueppm/${S3_BUCKET}/${_key}" "$_dst" >/dev/null
      ;;
    *)
      return 127
      ;;
  esac
}
