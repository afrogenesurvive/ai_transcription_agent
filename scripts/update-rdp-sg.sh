#!/usr/bin/env bash
#
# update-rdp-sg.sh
#
# Keeps RDP access to a Windows EC2 test instance working:
#   • resolves your current public IP
#   • inspects the security group's inbound TCP rules
#   • adds your IP only if it isn't already allowed (idempotent)
#   • optionally starts the instance and waits for Windows to boot
#   • optionally writes/refreshes an .rdp config file for the macOS
#     Remote Desktop app with the instance's live public DNS
#
# Why this exists: the instance is launched with "Port 3389 from your IP
# only". ISPs hand out dynamic IPs, so the SG source can drift — and a
# stopped instance gets a NEW public IPv4 + DNS name on restart, so RDP
# suddenly stops connecting (error 0x204). Run this after a stop/start
# and you're back in without touching the AWS console.
#
# Usage:
#   ./scripts/update-rdp-sg.sh --instance-id i-0abc123
#   ./scripts/update-rdp-sg.sh -i i-0abc123 --start --rdp
#   ./scripts/update-rdp-sg.sh --group-id sg-0abc123 --region us-east-1
#
# Options:
#   -i, --instance-id ID   EC2 instance ID (resolves its security group)
#   -g, --group-id ID      Security group ID (alternative to --instance-id)
#   -r, --region REGION    AWS region (default: your AWS CLI default)
#   -p, --port PORT        TCP port to authorize (default: 3389)
#   -u, --user NAME        OS username written into the .rdp (default: Administrator)
#       --start            Start the instance first and wait for status checks
#       --replace          When adding your IP, also revoke stale /32 sources
#   -o, --rdp [PATH]       Write/refresh an .rdp file for the macOS RDP app
#                          (default: ~/Desktop/Transcription-Agent-Win-Test.rdp)
#       --dry-run          Preview changes without applying them
#   -h, --help             Show this help
#
# Prerequisites:
#   - AWS CLI installed and authenticated (aws sts get-caller-identity)
#   - IAM: ec2:StartInstances (only with --start), ec2:DescribeInstances,
#          ec2:DescribeSecurityGroups, ec2:RevokeSecurityGroupIngress,
#          ec2:AuthorizeSecurityGroupIngress
#
set -euo pipefail

INSTANCE_ID=""
GROUP_ID=""
REGION=""
PORT="3389"
DRY_RUN=false
DO_START=false
REPLACE=false
RDP_ENABLED=false
RDP_PATH="$HOME/Desktop/Transcription-Agent-Win-Test.rdp"
RDP_USER="Administrator"

usage() {
    cat <<'EOF'
Usage:
  update-rdp-sg.sh --instance-id i-0abc123
  update-rdp-sg.sh -i i-0abc123 --start --rdp
  update-rdp-sg.sh --group-id sg-0abc123 --region us-east-1

Options:
  -i, --instance-id ID   EC2 instance ID (resolves its security group)
  -g, --group-id ID      Security group ID (alternative to --instance-id)
  -r, --region REGION    AWS region (default: your AWS CLI default)
  -p, --port PORT        TCP port to authorize (default: 3389)
  -u, --user NAME        OS username written into the .rdp (default: Administrator)
      --start            Start the instance first and wait for status checks
      --replace          When adding your IP, also revoke stale /32 sources
  -o, --rdp [PATH]       Write/refresh an .rdp file for the macOS RDP app
                         (default: ~/Desktop/Transcription-Agent-Win-Test.rdp)
      --dry-run          Preview changes without applying them
  -h, --help             Show this help
EOF
}

write_rdp() {
    if [ -z "$CUR_PUB_DNS" ] || [ "$CUR_PUB_DNS" = "None" ]; then
        echo "❌ Instance is not running — no public DNS to write into the .rdp file." >&2
        echo "   Run with --start, or launch the instance first." >&2
        exit 1
    fi
    RDP_PATH="${RDP_PATH/#\~/$HOME}"
    mkdir -p "$(dirname "$RDP_PATH")"
    cat > "$RDP_PATH" <<EOF
full address:s:${CUR_PUB_DNS}
username:s:${RDP_USER}
prompt for credentials:i:1
screen mode id:i:1
desktopwidth:i:1920
desktopheight:i:1080
session bpp:i:32
EOF
    echo "✅ Wrote RDP config: $RDP_PATH"
    echo "   Server: $CUR_PUB_DNS"
    echo "   OS user: $RDP_USER"
    echo "   Credentials: on first connect, select your saved User Account"
    echo "   (e.g. testing_rdp) so the app remembers it for this PC name."
    echo "   Connect:  open \"$RDP_PATH\""
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        -i|--instance-id) INSTANCE_ID="${2:?missing value for $1}"; shift 2 ;;
        -g|--group-id)    GROUP_ID="${2:?missing value for $1}"; shift 2 ;;
        -r|--region)      REGION="${2:?missing value for $1}"; shift 2 ;;
        -p|--port)        PORT="${2:?missing value for $1}"; shift 2 ;;
        -u|--user)        RDP_USER="${2:?missing value for $1}"; shift 2 ;;
        --start)          DO_START=true; shift ;;
        --replace)        REPLACE=true; shift ;;
        -o|--rdp)
            RDP_ENABLED=true
            if [ "$#" -gt 1 ] && ! [[ "$2" =~ ^- ]]; then
                RDP_PATH="$2"
                shift
            fi
            shift
            ;;
        --dry-run)        DRY_RUN=true; shift ;;
        -h|--help)        usage; exit 0 ;;
        *) echo "❌ Unknown option: $1" >&2; usage >&2; exit 2 ;;
    esac
done

if [ -z "$INSTANCE_ID" ] && [ -z "$GROUP_ID" ]; then
    echo "❌ Provide either --instance-id or --group-id." >&2
    usage >&2
    exit 2
fi

if [ "$DO_START" = true ] && [ -z "$INSTANCE_ID" ]; then
    echo "❌ --start requires --instance-id." >&2
    exit 2
fi

REGION_ARGS=()
if [ -n "$REGION" ]; then
    REGION_ARGS=(--region "$REGION")
fi

# ── Optional: start the instance and wait for Windows to boot ──
if [ "$DO_START" = true ]; then
    if [ "$DRY_RUN" = true ]; then
        echo "🚀 Would start instance $INSTANCE_ID (dry run — skipped)."
    else
        echo "🚀 Starting instance $INSTANCE_ID…"
        aws ec2 start-instances --instance-ids "$INSTANCE_ID" "${REGION_ARGS[@]}" >/dev/null
        echo "⏳ Waiting for status checks to pass (Windows boot)…"
        aws ec2 wait instance-status-ok --instance-ids "$INSTANCE_ID" "${REGION_ARGS[@]}"
        echo "   ✅ Instance is running and healthy."
    fi
fi

echo "📡 Resolving your current public IP…"
MY_IP="$(curl -s4 --max-time 10 https://checkip.amazonaws.com | tr -d '[:space:]' || true)"
if [ -z "$MY_IP" ]; then
    echo "❌ Could not determine your public IP (checkip.amazonaws.com unreachable)." >&2
    exit 1
fi
echo "   Your public IP: ${MY_IP}/32"

# ── Resolve the security group ──
SG_ID="$GROUP_ID"
if [ -z "$SG_ID" ]; then
    echo "📡 Resolving security group for instance $INSTANCE_ID…"
    SG_ID="$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" "${REGION_ARGS[@]}" \
        --query 'Reservations[0].Instances[0].SecurityGroups[0].GroupId' \
        --output text 2>/dev/null || true)"
    if [ -z "$SG_ID" ] || [ "$SG_ID" = "None" ]; then
        echo "❌ Could not resolve a security group for $INSTANCE_ID." >&2
        echo "   Verify the ID and that the AWS CLI is authenticated." >&2
        exit 1
    fi
fi
echo "   Security group: $SG_ID"

# ── Instance's CURRENT public DNS/IP (stale-address reminder) ──
CUR_PUB_IP=""
CUR_PUB_DNS=""
if [ -n "$INSTANCE_ID" ]; then
    CUR_PUB_IP="$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" "${REGION_ARGS[@]}" \
        --query 'Reservations[0].Instances[0].PublicIpAddress' --output text 2>/dev/null || true)"
    CUR_PUB_DNS="$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" "${REGION_ARGS[@]}" \
        --query 'Reservations[0].Instances[0].PublicDnsName' --output text 2>/dev/null || true)"
    # DNS can lag a few seconds right after start — give it a moment
    tries=0
    while [ -z "$CUR_PUB_DNS" ] || [ "$CUR_PUB_DNS" = "None" ]; do
        tries=$((tries + 1))
        [ "$tries" -ge 6 ] && break
        sleep 5
        CUR_PUB_DNS="$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" "${REGION_ARGS[@]}" \
            --query 'Reservations[0].Instances[0].PublicDnsName' --output text 2>/dev/null || true)"
    done
    if [ -n "$CUR_PUB_DNS" ] && [ "$CUR_PUB_DNS" != "None" ]; then
        echo ""
        echo "💡 Instance's CURRENT public DNS — connect RDP to this:"
        echo "   $CUR_PUB_DNS"
        [ -n "$CUR_PUB_IP" ] && [ "$CUR_PUB_IP" != "None" ] && echo "   ($CUR_PUB_IP)"
        echo ""
    fi
fi

# ── Existing inbound IPv4 source CIDRs on the target TCP port ──
EXISTING="$(aws ec2 describe-security-groups --group-ids "$SG_ID" "${REGION_ARGS[@]}" \
    --query "SecurityGroups[0].IpPermissions[?IpProtocol==\`tcp\` && FromPort==\`${PORT}\`].IpRanges[].CidrIp" \
    --output text 2>/dev/null || true)"

echo "── Current inbound TCP $PORT IPv4 sources ──"
if [ -n "$EXISTING" ]; then
    for cidr in $EXISTING; do
        echo "   • $cidr"
    done
else
    echo "   (none)"
fi

# ── Idempotent: only add your IP if it isn't already allowed ──
MY_CIDR="${MY_IP}/32"
if echo "$EXISTING" | grep -Fwq "$MY_CIDR" || echo "$EXISTING" | grep -Fwq "0.0.0.0/0"; then
    echo ""
    echo "✅ ${MY_CIDR} is already allowed on TCP $PORT — no SG change needed."
else
    echo ""
    echo "── Planned SG changes ──"
    if [ "$REPLACE" = true ]; then
        for cidr in $EXISTING; do
            if [ "${cidr##*/}" = "32" ] && [ "$cidr" != "$MY_CIDR" ]; then
                echo "   Revoke    $cidr  (stale /32)"
                if [ "$DRY_RUN" = false ]; then
                    aws ec2 revoke-security-group-ingress --group-id "$SG_ID" "${REGION_ARGS[@]}" \
                        --protocol tcp --port "$PORT" --cidr "$cidr" || true
                fi
            fi
        done
    else
        echo "   (run with --replace to also drop stale /32 sources)"
    fi
    echo "   Authorize ${MY_CIDR}  (TCP $PORT)"
    if [ "$DRY_RUN" = false ]; then
        aws ec2 authorize-security-group-ingress --group-id "$SG_ID" "${REGION_ARGS[@]}" \
            --protocol tcp --port "$PORT" --cidr "$MY_CIDR"
        echo "✅ Authorized ${MY_CIDR} on TCP $PORT for $SG_ID."
    fi
fi

if [ "$DRY_RUN" = true ]; then
    echo ""
    echo "🧪 Dry run — no changes applied."
    exit 0
fi

# ── Optional: write/refresh the .rdp config file for the macOS RDP app ──
if [ "$RDP_ENABLED" = true ]; then
    write_rdp
fi

echo ""
echo "✅ Done."
if [ -n "$CUR_PUB_IP" ] && [ "$CUR_PUB_IP" != "None" ]; then
    echo "   Verify reachability: nc -vz $CUR_PUB_IP $PORT"
fi
