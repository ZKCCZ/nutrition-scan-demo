#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
deploy_dir="$(mktemp -d "${TMPDIR:-/tmp}/nutrition-fc.XXXXXX")"
package_path="${deploy_dir}/nutrition-fc.zip"
trap 'rm -rf "$deploy_dir"' EXIT

for file in index.js worker-logic.js package.json; do
  cp "$repo_root/aliyun/web/$file" "$deploy_dir/$file"
done

(cd "$deploy_dir" && zip -q "$package_path" index.js worker-logic.js package.json)
zip_base64="$(base64 < "$package_path" | tr -d '\n')"

aliyun fc update-function \
  --profile "${ALIYUN_PROFILE:-nutrition-deploy}" \
  --region "${ALIYUN_REGION:-cn-hangzhou}" \
  --function-name "${ALIYUN_FUNCTION:-nutrition-scan-demo}" \
  --code "zipFile=$zip_base64" \
  --quiet

printf 'Deployed %s to Alibaba Cloud FC (%s)\n' "${ALIYUN_FUNCTION:-nutrition-scan-demo}" "${ALIYUN_REGION:-cn-hangzhou}"
