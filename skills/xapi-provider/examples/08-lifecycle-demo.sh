#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <service.json>" >&2
  exit 2
fi

SERVICE_FILE=$1

# This example intentionally stops after creation. Read IDs from the output and
# inspect them before performing publication or live-routing mutations.
npx xapi-to provider create --file "$SERVICE_FILE"
npx xapi-to provider list

cat <<'NEXT'
Continue with the IDs returned above:
  npx xapi-to provider get <service-id>
  npx xapi-to provider versions <service-id>
  npx xapi-to provider diff <service-id> <major>
  npx xapi-to provider publish <service-id> <revision-id> --changelog-file ./CHANGELOG.md
  npx xapi-to provider review <service-id> <revision-id>
NEXT
