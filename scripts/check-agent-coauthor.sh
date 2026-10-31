#!/usr/bin/env bash
# Reject agent commits that lack the session's local audit trailer.
set -euo pipefail

msg_file="${1:-}"
if [[ -z "$msg_file" || ! -f "$msg_file" ]]; then
  echo "check-agent-coauthor: usage: $0 <commit-msg-file>" >&2
  exit 2
fi

if [[ -z "${MINIMAL_AGENT_SESSION_ID:-}" ]]; then
  exit 0
fi

sid="$MINIMAL_AGENT_SESSION_ID"
short_sid="${sid:0:8}"
if [[ ! "$short_sid" =~ ^[0-9a-f]{8}$ ]]; then
  echo "check-agent-coauthor: MINIMAL_AGENT_SESSION_ID short prefix is not 8 lowercase hex: '$short_sid'" >&2
  exit 1
fi

expected_email="${short_sid}@minimal-agent"
trailers="$(git interpret-trailers --parse "$msg_file" 2>/dev/null || true)"
matched_line="$(
  printf '%s\n' "$trailers" |
    grep -Ei '^Co-authored-by: .+ <[0-9a-f]{8}@minimal-agent>$' |
    head -n 1 || true
)"

if [[ -z "$matched_line" ]]; then
  name_hint="${MINIMAL_AGENT_AGENT_NAME:-Name}"
  cat >&2 <<EOF
check-agent-coauthor: agent commit is missing a valid Co-authored-by trailer.

Required (blank line before the trailer block):
  Co-authored-by: ${name_hint} <${expected_email}>
EOF
  exit 1
fi

email="$(printf '%s\n' "$matched_line" | sed -n 's/.*<\([^>]*\)>/\1/p')"
if [[ "$email" != "$expected_email" ]]; then
  echo "check-agent-coauthor: trailer session id does not match this session." >&2
  echo "  found:    <$email>" >&2
  echo "  expected: <$expected_email>" >&2
  exit 1
fi

if [[ -n "${MINIMAL_AGENT_AGENT_NAME:-}" ]]; then
  name="$(printf '%s\n' "$matched_line" | sed -n 's/^[Cc][Oo]-[Aa][Uu][Tt][Hh][Oo][Rr][Ee][Dd]-[Bb][Yy]: \(.*\) <.*/\1/p')"
  if [[ "$name" != "$MINIMAL_AGENT_AGENT_NAME" ]]; then
    echo "check-agent-coauthor: trailer name does not match MINIMAL_AGENT_AGENT_NAME." >&2
    echo "  found:    $name" >&2
    echo "  expected: $MINIMAL_AGENT_AGENT_NAME" >&2
    exit 1
  fi
fi
