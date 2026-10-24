#!/usr/bin/env bash
# Build and deploy the tool server to Azure Container Apps (one small replica).
# Idempotent: re-run it to ship a new version. Reads secrets from .env.
set -euo pipefail
cd "$(dirname "$0")/.."

[[ -f .env ]] || { echo "Missing .env (copy .env.example)"; exit 1; }
# Load .env without overriding variables already set in the shell.
while IFS='=' read -r key value; do
  [[ "$key" =~ ^[A-Z0-9_]+$ ]] || continue
  [[ -n "$(printenv "$key" || true)" ]] || export "$key=$value"
done < .env
[[ "${PAYSTACK_SECRET_KEY:-}" == sk_test_* ]] || { echo "PAYSTACK_SECRET_KEY in .env must be a Paystack test key (sk_test_...)"; exit 1; }

SUBSCRIPTION="${AZURE_SUBSCRIPTION_ID:-$(az account show --query id -o tsv)}"
# westeurope rejected new resources on our sponsorship subscription ("region not accepting new customers").
LOCATION="${AZURE_LOCATION:-southafricanorth}"
RG="${AZURE_RESOURCE_GROUP:-monaliza-pizza-zan-rg}"
ENV_NAME="${AZURE_CONTAINERAPP_ENV:-monaliza-pizza-env}"
APP="${AZURE_CONTAINERAPP_NAME:-monaliza-pizza-tools}"
# ACR names are global; derive a stable suffix from the subscription.
ACR="${AZURE_ACR_NAME:-monalizapizza$(echo -n "$SUBSCRIPTION" | shasum | cut -c1-6)}"
TAG="$(git rev-parse --short HEAD 2>/dev/null || date +%s)$(git diff --quiet 2>/dev/null || echo "-dirty$(date +%s)")"
IMAGE="$ACR.azurecr.io/monaliza-pizza:$TAG"

az account set --subscription "$SUBSCRIPTION"
az extension add --name containerapp --upgrade --only-show-errors >/dev/null
for ns in Microsoft.App Microsoft.OperationalInsights Microsoft.ContainerRegistry; do
  az provider register --namespace "$ns" --only-show-errors >/dev/null
done

echo "==> Resource group $RG ($LOCATION)"
az group create -n "$RG" -l "$LOCATION" -o none

echo "==> Container registry $ACR"
az acr show -n "$ACR" -g "$RG" -o none 2>/dev/null || az acr create -n "$ACR" -g "$RG" -l "$LOCATION" --sku Basic --admin-enabled true -o none

echo "==> Building $IMAGE in ACR"
az acr build -r "$ACR" -t "$IMAGE" . --no-logs -o none

echo "==> Container Apps environment $ENV_NAME"
az containerapp env show -n "$ENV_NAME" -g "$RG" -o none 2>/dev/null \
  || az containerapp env create -n "$ENV_NAME" -g "$RG" -l "$LOCATION" -o none

ACR_USER=$(az acr credential show -n "$ACR" --query username -o tsv)
ACR_PASS=$(az acr credential show -n "$ACR" --query 'passwords[0].value' -o tsv)

SECRETS=(
  "paystack-secret=$PAYSTACK_SECRET_KEY"
  "mcp-token=$MCP_AUTH_TOKEN"
  "kitchen-password=$KITCHEN_PASSWORD"
)
ENVS=(
  "PAYSTACK_SECRET_KEY=secretref:paystack-secret"
  "MCP_AUTH_TOKEN=secretref:mcp-token"
  "KITCHEN_PASSWORD=secretref:kitchen-password"
  "PAYMENT_EXPIRY_MINUTES=${PAYMENT_EXPIRY_MINUTES:-30}"
  "CHORD_BASE_URL=${CHORD_BASE_URL:-https://api.chordhq.xyz}"
  # Secret changes alone don't restart a Container App; a changed env var forces a new revision.
  "DEPLOYED_AT=$(date +%s)"
)
if [[ -n "${CHORD_API_KEY:-}" && -n "${CHORD_WORKSPACE_ID:-}" ]]; then
  SECRETS+=("chord-api-key=$CHORD_API_KEY")
  ENVS+=("CHORD_API_KEY=secretref:chord-api-key" "CHORD_WORKSPACE_ID=$CHORD_WORKSPACE_ID")
fi

if az containerapp show -n "$APP" -g "$RG" -o none 2>/dev/null; then
  echo "==> Updating $APP"
  az containerapp secret set -n "$APP" -g "$RG" --secrets "${SECRETS[@]}" -o none
  az containerapp update -n "$APP" -g "$RG" --image "$IMAGE" --set-env-vars "${ENVS[@]}" -o none
else
  echo "==> Creating $APP"
  # min = max = 1: the order store lives in memory, so there must be exactly one always-on replica.
  az containerapp create -n "$APP" -g "$RG" --environment "$ENV_NAME" \
    --image "$IMAGE" --registry-server "$ACR.azurecr.io" --registry-username "$ACR_USER" --registry-password "$ACR_PASS" \
    --ingress external --target-port 8080 --transport auto \
    --cpu 0.25 --memory 0.5Gi --min-replicas 1 --max-replicas 1 \
    --secrets "${SECRETS[@]}" --env-vars "${ENVS[@]}" -o none
fi

FQDN=$(az containerapp show -n "$APP" -g "$RG" --query properties.configuration.ingress.fqdn -o tsv)
az containerapp update -n "$APP" -g "$RG" --set-env-vars "PUBLIC_BASE_URL=https://$FQDN" -o none

echo
echo "Deployed: https://$FQDN"
echo "  MCP endpoint (register in Chord): https://$FQDN/mcp"
echo "  Paystack webhook URL:             https://$FQDN/webhooks/paystack"
echo "  Kitchen board:                    https://$FQDN/kitchen"
curl -fsS "https://$FQDN/healthz" && echo
