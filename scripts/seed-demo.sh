#!/usr/bin/env bash
#
# Seed a fresh stack with demo data: two approved KB documents and a support
# ticket that should classify/route (and, with the support-autoreply profile,
# produce a grounded reply when a generator is running).
#
#   scripts/seed-demo.sh
#   API_URL=http://localhost:3000 TOKEN="<admin token>" scripts/seed-demo.sh
#
# TOKEN is only needed when AUTH_MODE=required. The script is safe to re-run:
# tickets use a timestamped idempotency key and repeated KB docs are allowed.
set -euo pipefail

API_URL="${API_URL:-http://localhost:3000}"

json() {
  python3 -c "import json,sys; print(json.load(sys.stdin)$1)"
}

api() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "${TOKEN:-}" ]]; then
    if [[ -n "$body" ]]; then
      curl -fsS -X "$method" "${API_URL}${path}" \
        -H 'content-type: application/json' -H "authorization: Bearer ${TOKEN}" -d "$body"
    else
      curl -fsS -X "$method" "${API_URL}${path}" -H "authorization: Bearer ${TOKEN}"
    fi
  else
    if [[ -n "$body" ]]; then
      curl -fsS -X "$method" "${API_URL}${path}" \
        -H 'content-type: application/json' -d "$body"
    else
      curl -fsS -X "$method" "${API_URL}${path}"
    fi
  fi
}

echo "→ waiting for ${API_URL}/readyz"
for _ in $(seq 1 60); do
  if curl -fsS "${API_URL}/readyz" >/dev/null 2>&1; then break; fi
  sleep 2
done

echo "→ creating and approving KB document (refund policy)"
REFUND_ID="$(api POST /api/v1/kb/documents '{
  "title": "Refund policy",
  "body": "Duplicate charges are refunded to the original payment method within 5 business days. Customers should not be charged twice for the same invoice.",
  "source": "seed"
}' | json "['document']['id']")"
api POST "/api/v1/kb/documents/${REFUND_ID}/approve" >/dev/null

echo "→ creating and approving KB document (password reset)"
RESET_ID="$(api POST /api/v1/kb/documents '{
  "title": "Password reset",
  "body": "If you cannot sign in, use the Forgot password link on the login page. The reset email arrives within 10 minutes; check spam before retrying.",
  "source": "seed"
}' | json "['document']['id']")"
api POST "/api/v1/kb/documents/${RESET_ID}/approve" >/dev/null

echo "→ creating a support ticket"
TICKET="$(api POST /api/v1/support/tickets "{
  \"subject\": \"Charged twice for the same invoice\",
  \"body\": \"I was billed twice for invoice INV-1042 yesterday. Please refund the duplicate charge.\",
  \"requester\": \"demo-customer@example.dev\",
  \"idempotencyKey\": \"seed-$(date -u +%Y%m%dT%H%M%S)\"
}")"
echo "$TICKET" | python3 -m json.tool

echo
echo "Seed complete. Open /support to inspect the ticket, or /runs for the trace."
