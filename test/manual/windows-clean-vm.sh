#!/usr/bin/env bash
# W4: clean Windows release check for the managed embedding runtime.
#
# Creates a throw-away Alibaba Cloud Windows Server 2022 VM (no Visual C++ runtime installed),
# runs the bundled harness through Cloud Assistant and deletes every resource it created.
# Run it before publishing any runtime release and paste the summary into the release record.
#
#   test/manual/windows-clean-vm.sh --dry-run      # validate inputs and print the plan only
#   test/manual/windows-clean-vm.sh                # create, test, delete (billed, ~CNY 2/hour)
#
# Scenarios (all on the candidate runtime from dist/runtime unless noted):
#   S1 clean      no VC++ runtime, Defender real-time protection on, profile path "C:\Users\测试 用户"
#   S2 onedrive   same, vault data under "...\OneDrive\Analogy 库"
#   S3 upgrade    installs the VC++ runtime, then the superseded v1 runtime, and upgrades it to the candidate
#
# Requirements: aliyun CLI with a configured profile, jq, node; account balance >= CNY 100.
# Environment overrides: ALIYUN_REGION (cn-hongkong), ALIYUN_ZONE, ALIYUN_INSTANCE_TYPE (ecs.c7.large),
#   ALIYUN_IMAGE_ID, RUNTIME_STAGING (dist/runtime), FROM_REF (1.2.7), AUTO_RELEASE_HOURS (3).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REGION="${ALIYUN_REGION:-cn-hongkong}"
INSTANCE_TYPE="${ALIYUN_INSTANCE_TYPE:-ecs.c7.large}"
RUNTIME_STAGING="${RUNTIME_STAGING:-$REPO_ROOT/dist/runtime}"
FROM_REF="${FROM_REF:-1.2.7}"
AUTO_RELEASE_HOURS="${AUTO_RELEASE_HOURS:-3}"
RUN_ID="w4-$(date -u +%Y%m%d%H%M%S)-$RANDOM"
WORK_DIR="$REPO_ROOT/artifacts/windows-clean-vm/$RUN_ID"
RESULT_FILE="$WORK_DIR/result.json"
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

VPC_ID="" VSWITCH_ID="" SG_ID="" INSTANCE_ID="" BUCKET=""
OSS_ENDPOINT="oss-$REGION.aliyuncs.com"

log() { printf '[windows-clean-vm] %s\n' "$*" >&2; }
fail() { log "ERROR: $*"; exit 1; }

# The Alibaba Cloud API must bypass the local proxy (it breaks request signing and Cloud Assistant polling).
# Connections to the Hong Kong endpoints drop now and then (EOF / reset); those are retried. Every create
# call carries a ClientToken, so a retried create returns the same resource instead of a duplicate.
ali() {
  local attempt status output errors
  errors=$(mktemp)
  for attempt in 1 2 3 4 5; do
    status=0
    output=$(env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy \
      aliyun "$@" 2>"$errors") || status=$?
    if (( status == 0 )) || ! grep -qiE "EOF|timeout|connection reset|TLS handshake|no such host|broken pipe" <<<"$output$(cat "$errors")"; then
      break
    fi
    sleep $(( attempt * 5 ))
  done
  cat "$errors" >&2
  rm -f "$errors"
  printf '%s\n' "$output"
  return "$status"
}

retry() {
  local attempts="$1" delay="$2"; shift 2
  local n=1
  until "$@"; do
    (( n >= attempts )) && return 1
    sleep "$delay"; n=$((n + 1))
  done
}

cleanup() {
  local status=$?
  set +e
  log "cleaning up run $RUN_ID"
  if [[ -n "$INSTANCE_ID" ]]; then
    ali ecs DeleteInstance --RegionId "$REGION" --InstanceId "$INSTANCE_ID" --Force true >/dev/null
    for _ in $(seq 1 60); do
      local count
      count=$(ali ecs DescribeInstances --RegionId "$REGION" --InstanceIds "[\"$INSTANCE_ID\"]" | jq '.TotalCount')
      [[ "$count" == "0" ]] && break
      sleep 10
    done
  fi
  [[ -n "$SG_ID" ]] && retry 30 10 ali ecs DeleteSecurityGroup --RegionId "$REGION" --SecurityGroupId "$SG_ID" >/dev/null
  [[ -n "$VSWITCH_ID" ]] && retry 30 10 ali vpc DeleteVSwitch --RegionId "$REGION" --VSwitchId "$VSWITCH_ID" >/dev/null
  [[ -n "$VPC_ID" ]] && retry 30 10 ali vpc DeleteVpc --RegionId "$REGION" --VpcId "$VPC_ID" >/dev/null
  if [[ -n "$BUCKET" ]]; then
    # -a also aborts unfinished multipart uploads, which otherwise block bucket deletion.
    ali oss rm "oss://$BUCKET" -a -r -f -e "$OSS_ENDPOINT" >/dev/null
    ali oss rm "oss://$BUCKET" -b -f -e "$OSS_ENDPOINT" >/dev/null
  fi
  # Re-check that nothing tagged with this run survives.
  local leftovers
  leftovers=$(ali ecs DescribeInstances --RegionId "$REGION" --Tag.1.Key analogy-w4 --Tag.1.Value "$RUN_ID" | jq '.TotalCount')
  local vpcs=0 buckets=0
  [[ -n "$VPC_ID" ]] && vpcs=$(ali vpc DescribeVpcs --RegionId "$REGION" --VpcId "$VPC_ID" | jq '.TotalCount')
  [[ -n "$BUCKET" ]] && buckets=$(ali oss ls -e "$OSS_ENDPOINT" 2>/dev/null | grep -c "oss://$BUCKET" || true)
  if [[ "$leftovers" == "0" && "$vpcs" == "0" && "$buckets" == "0" ]]; then
    log "cleanup verified: 0 instances, 0 VPCs and 0 buckets left for $RUN_ID"
  else
    log "WARNING: leftovers for $RUN_ID (instances=$leftovers vpcs=$vpcs buckets=$buckets); the instance auto-releases after ${AUTO_RELEASE_HOURS}h"
    status=1
  fi
  exit "$status"
}

# ---------- preflight (also the whole --dry-run) ----------
command -v aliyun >/dev/null || fail "aliyun CLI is required"
command -v jq >/dev/null || fail "jq is required"
command -v node >/dev/null || fail "node is required"
mkdir -p "$WORK_DIR"
TO_ARCHIVE=$(node "$REPO_ROOT/scripts/runtime-platform-versions.mjs" archive --platform win32-x64)
[[ -f "$RUNTIME_STAGING/$TO_ARCHIVE" ]] || fail "candidate runtime $RUNTIME_STAGING/$TO_ARCHIVE is missing (build it with the runtime matrix workflow)"
node "$REPO_ROOT/test/manual/build-windows-harness.mjs" --output "$WORK_DIR/harness" \
  --runtime-staging "$RUNTIME_STAGING" --from-ref "$FROM_REF" >/dev/null
FROM_ARCHIVE_NAME=$(jq -r '.from.fileName' "$WORK_DIR/harness/assets.json")
FROM_URL=$(jq -r '.from.url' "$WORK_DIR/harness/assets.json")
log "run $RUN_ID: $REGION $INSTANCE_TYPE, candidate $TO_ARCHIVE, upgrade from $FROM_ARCHIVE_NAME"

if (( DRY_RUN )); then
  log "dry run: would create VPC + vSwitch + security group + 1 PostPaid instance (auto-release ${AUTO_RELEASE_HOURS}h) + 1 private OSS bucket, tagged analogy-w4=$RUN_ID"
  log "dry run: harness bundled at $WORK_DIR/harness/harness.cjs; nothing was created"
  exit 0
fi

BALANCE=$(ali bssopenapi QueryAccountBalance | jq -r '.Data.AvailableAmount' | tr -d ',')
node -e "process.exit(Number(process.argv[1]) >= 100 ? 0 : 1)" "$BALANCE" \
  || fail "account balance ${BALANCE} is below CNY 100; pay-as-you-go instances cannot be created"


trap cleanup EXIT

# ---------- network ----------
ZONE="${ALIYUN_ZONE:-$(ali ecs DescribeAvailableResource --RegionId "$REGION" --DestinationResource InstanceType \
  --InstanceType "$INSTANCE_TYPE" --InstanceChargeType PostPaid \
  | jq -r '[.AvailableZones.AvailableZone[] | select(.Status == "Available")][0].ZoneId')}"
[[ -n "$ZONE" && "$ZONE" != "null" ]] || fail "no zone in $REGION offers $INSTANCE_TYPE"
VPC_ID=$(ali vpc CreateVpc --RegionId "$REGION" --CidrBlock 172.16.0.0/16 --VpcName "analogy-$RUN_ID" --ClientToken "$RUN_ID-vpc" | jq -r '.VpcId')
retry 30 5 bash -c "[[ \$(env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy aliyun vpc DescribeVpcAttribute --RegionId $REGION --VpcId $VPC_ID | jq -r .Status) == Available ]]"
VSWITCH_ID=$(ali vpc CreateVSwitch --RegionId "$REGION" --ZoneId "$ZONE" --VpcId "$VPC_ID" \
  --CidrBlock 172.16.1.0/24 --VSwitchName "analogy-$RUN_ID" --ClientToken "$RUN_ID-vsw" | jq -r '.VSwitchId')
retry 30 5 bash -c "[[ \$(env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy aliyun vpc DescribeVSwitchAttributes --RegionId $REGION --VSwitchId $VSWITCH_ID | jq -r .Status) == Available ]]"
# Cloud Assistant only needs outbound access; no inbound rule is opened.
SG_ID=$(ali ecs CreateSecurityGroup --RegionId "$REGION" --VpcId "$VPC_ID" --SecurityGroupName "analogy-$RUN_ID" \
  --Tag.1.Key analogy-w4 --Tag.1.Value "$RUN_ID" --ClientToken "$RUN_ID-sg" | jq -r '.SecurityGroupId')

# ---------- private file transfer ----------
BUCKET="analogy-$(echo "$RUN_ID" | tr '[:upper:]' '[:lower:]')"
ali oss mb "oss://$BUCKET" --acl private -e "$OSS_ENDPOINT" >/dev/null
# Only unpublished files go through OSS; the published v1 runtime is downloaded on the VM from GitHub
# and verified there by the plugin's own installer (pinned size and SHA-256).
for file in "$WORK_DIR/harness/harness.cjs" "$WORK_DIR/harness/assets.json" "$RUNTIME_STAGING/$TO_ARCHIVE"; do
  retry 3 10 ali oss cp "$file" "oss://$BUCKET/$(basename "$file")" -e "$OSS_ENDPOINT" -f >/dev/null \
    || fail "upload of $(basename "$file") to OSS failed"
done
sign() { ali oss sign "oss://$BUCKET/$1" --timeout 10800 -e "$OSS_ENDPOINT" | head -n 1; }
URL_HARNESS=$(sign harness.cjs); URL_ASSETS=$(sign assets.json)
URL_TO=$(sign "$TO_ARCHIVE"); URL_FROM="$FROM_URL"

# ---------- instance ----------
IMAGE_ID="${ALIYUN_IMAGE_ID:-$(ali ecs DescribeImages --RegionId "$REGION" --ImageOwnerAlias system --OSType windows \
  --Architecture x86_64 --ImageName 'win2022_21H2_x64_dtc_zh-cn_40G_alibase_*' --PageSize 50 \
  | jq -r '.Images.Image | sort_by(.CreationTime) | last | .ImageId')}"
[[ -n "$IMAGE_ID" && "$IMAGE_ID" != "null" ]] || fail "no Windows Server 2022 zh-cn image found"
AUTO_RELEASE=$(date -u -v+"${AUTO_RELEASE_HOURS}"H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "+${AUTO_RELEASE_HOURS} hours" +%Y-%m-%dT%H:%M:%SZ)
INSTANCE_ID=$(ali ecs RunInstances --RegionId "$REGION" --ZoneId "$ZONE" --ImageId "$IMAGE_ID" \
  --InstanceType "$INSTANCE_TYPE" --SecurityGroupId "$SG_ID" --VSwitchId "$VSWITCH_ID" \
  --InstanceChargeType PostPaid --InternetChargeType PayByTraffic --InternetMaxBandwidthOut 100 \
  --SystemDisk.Category cloud_essd --SystemDisk.Size 60 --AutoReleaseTime "$AUTO_RELEASE" \
  --InstanceName "analogy-$RUN_ID" --Tag.1.Key analogy-w4 --Tag.1.Value "$RUN_ID" --Amount 1 --ClientToken "$RUN_ID-ecs" \
  | jq -r '.InstanceIdSets.InstanceIdSet[0]')
[[ -n "$INSTANCE_ID" && "$INSTANCE_ID" != "null" ]] || fail "instance creation failed"
log "instance $INSTANCE_ID ($ZONE, image $IMAGE_ID) auto-releases at $AUTO_RELEASE"
retry 60 10 bash -c "[[ \$(env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy aliyun ecs DescribeCloudAssistantStatus --RegionId $REGION --InstanceId.1 $INSTANCE_ID | jq -r '.InstanceCloudAssistantStatusSet.InstanceCloudAssistantStatus[0].CloudAssistantStatus') == true ]]" \
  || fail "Cloud Assistant did not come online"

# ---------- scenarios ----------
# Non-ASCII path parts are built from code points so the script survives any console code page.
read -r -d '' SCRIPT <<PWSH || true
\$ErrorActionPreference = "Stop"
\$ProgressPreference = "SilentlyContinue"
\$user = "\$([char]0x6D4B)\$([char]0x8BD5) \$([char]0x7528)\$([char]0x6237)"
\$root = "C:\\Users\\\$user\\Analogy"
\$dl = Join-Path \$root "downloads"
New-Item -ItemType Directory -Force -Path \$dl | Out-Null
function Emit(\$scenario, \$data) { Write-Output ("[" + \$scenario + "] " + (\$data | ConvertTo-Json -Compress)) }
\$vc = Test-Path "HKLM:\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64"
\$defender = \$null
try { \$defender = (Get-MpComputerStatus).RealTimeProtectionEnabled } catch { }
Emit "host" @{ step = "machine"; ok = \$true; vcRuntimeInstalled = \$vc; defenderRealTime = \$defender; os = (Get-CimInstance Win32_OperatingSystem).Caption }
Invoke-WebRequest -UseBasicParsing -Uri "$URL_HARNESS" -OutFile (Join-Path \$dl "harness.cjs")
Invoke-WebRequest -UseBasicParsing -Uri "$URL_ASSETS" -OutFile (Join-Path \$dl "assets.json")
\$sw = [Diagnostics.Stopwatch]::StartNew()
Invoke-WebRequest -UseBasicParsing -Uri "$URL_TO" -OutFile (Join-Path \$dl "$TO_ARCHIVE")
Emit "host" @{ step = "download-candidate"; ok = \$true; seconds = [int]\$sw.Elapsed.TotalSeconds }
Invoke-WebRequest -UseBasicParsing -Uri "$URL_FROM" -OutFile (Join-Path \$dl "$FROM_ARCHIVE_NAME")
Expand-Archive -Force -Path (Join-Path \$dl "$TO_ARCHIVE") -DestinationPath (Join-Path \$root "candidate")
\$pack = Get-ChildItem (Join-Path \$root "candidate") -Directory | Select-Object -First 1
\$node = Join-Path \$pack.FullName "node\\bin\\node.exe"
\$harness = Join-Path \$dl "harness.cjs"
function Run(\$scenario, [string[]]\$arguments) {
  # Windows PowerShell 5.1 turns merged native stderr into terminating errors under "Stop".
  \$ErrorActionPreference = "Continue"
  & \$node \$harness @arguments 2>&1 | ForEach-Object { Write-Output ("[" + \$scenario + "] " + \$_) }
}
Run "S1" @("full", \$pack.FullName, (Join-Path \$root "clean"))
Run "S2" @("full", \$pack.FullName, "C:\\Users\\\$user\\OneDrive\\Analogy \$([char]0x5E93)")
\$redist = Join-Path \$dl "vc_redist.x64.exe"
Invoke-WebRequest -UseBasicParsing -Uri "https://aka.ms/vs/17/release/vc_redist.x64.exe" -OutFile \$redist
\$installer = Start-Process -FilePath \$redist -ArgumentList "/install","/quiet","/norestart" -Wait -PassThru
Emit "host" @{ step = "install-vc-runtime"; ok = (\$installer.ExitCode -eq 0 -or \$installer.ExitCode -eq 3010); exitCode = \$installer.ExitCode }
Run "S3" @("upgrade", (Join-Path \$root "upgrade"), (Join-Path \$dl "assets.json"), (Join-Path \$dl "$FROM_ARCHIVE_NAME"), (Join-Path \$dl "$TO_ARCHIVE"))
PWSH
ENCODED=$(printf '%s' "$SCRIPT" | base64 | tr -d '\n')
INVOKE_ID=$(ali ecs RunCommand --RegionId "$REGION" --Type RunPowerShellScript --CommandContent "$ENCODED" \
  --ContentEncoding Base64 --Timeout 5400 --Name "analogy-$RUN_ID" --InstanceId.1 "$INSTANCE_ID" --ClientToken "$RUN_ID-cmd" | jq -r '.InvokeId')
log "Cloud Assistant invocation $INVOKE_ID started; polling"
STATUS=""
for _ in $(seq 1 360); do
  RESULT=$(ali ecs DescribeInvocationResults --RegionId "$REGION" --InvokeId "$INVOKE_ID")
  STATUS=$(echo "$RESULT" | jq -r '.Invocation.InvocationResults.InvocationResult[0].InvokeRecordStatus')
  [[ "$STATUS" == "Finished" || "$STATUS" == "Failed" || "$STATUS" == "Stopped" ]] && break
  sleep 15
done
echo "$RESULT" | jq -r '.Invocation.InvocationResults.InvocationResult[0].Output' | base64 --decode > "$WORK_DIR/output.log" || true

# ---------- verdict ----------
VERDICT=0
node - "$WORK_DIR/output.log" "$RESULT_FILE" "$RUN_ID" "$STATUS" <<'NODE' || VERDICT=1
const fs = require("fs");
const [logFile, resultFile, runId, status] = process.argv.slice(2);
const steps = [];
for (const line of fs.readFileSync(logFile, "utf8").split(/\r?\n/)) {
  const match = line.match(/^\[(\w+)\] (\{.*\})$/);
  if (!match) continue;
  try { steps.push({ scenario: match[1], ...JSON.parse(match[2]) }); } catch { /* ignore partial lines */ }
}
const required = {
  S1: ["native-probe", "model-download", "worker-load-offline", "embed", "sqlite-store"],
  S2: ["native-probe", "model-download", "worker-load-offline", "embed", "sqlite-store"],
  S3: ["upgrade-install-from", "upgrade-detect-upgradable", "upgrade-install-to", "upgrade-detect-ready", "upgrade-history-trusted"],
};
const verdict = Object.fromEntries(Object.entries(required).map(([scenario, names]) => [scenario,
  names.every((name) => steps.some((step) => step.scenario === scenario && step.step === name && step.ok === true))]));
const passed = status === "Finished" && Object.values(verdict).every(Boolean);
fs.writeFileSync(resultFile, `${JSON.stringify({ runId, invocationStatus: status, passed, verdict, steps }, null, 2)}\n`);
console.log(JSON.stringify({ runId, passed, verdict }));
process.exitCode = passed ? 0 : 1;
NODE
log "result written to $RESULT_FILE"
exit "$VERDICT"
