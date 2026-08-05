#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <tweet-url-or-id> [output-directory]" >&2
}

die() {
  echo "Error: $*" >&2
  exit 1
}

for required_command in npx jq curl file mktemp; do
  command -v "$required_command" >/dev/null 2>&1 ||
    die "required command not found: $required_command"
done

TWEET_INPUT=${1:-}
OUTPUT_DIR=${2:-.}
[ -n "$TWEET_INPUT" ] || {
  usage
  exit 2
}
[ -d "$OUTPUT_DIR" ] || die "output directory does not exist: $OUTPUT_DIR"
OUTPUT_DIR=$(cd "$OUTPUT_DIR" && pwd -P)

if [[ "$TWEET_INPUT" =~ ^https://((www|mobile)\.)?(x\.com|twitter\.com)/[^/]+/status/([0-9]+) ]]; then
  TWEET_ID=${BASH_REMATCH[4]}
elif [[ "$TWEET_INPUT" =~ ^[0-9]+$ ]]; then
  TWEET_ID=$TWEET_INPUT
else
  die "expected a numeric tweet ID or an x.com/twitter.com status URL"
fi

SCHEMA=$(npx xapi-to get twitter.tweet_detail --format json)
printf '%s' "$SCHEMA" | jq -e '
  .output.properties.data.properties.tweet.properties.media
  .items.properties.video_url.type == "string"
' >/dev/null || die "twitter.tweet_detail video_url is not deployed on this xAPI backend"

INPUT=$(jq -nc --arg tweet_id "$TWEET_ID" '{tweet_id:$tweet_id}')
RESPONSE=$(npx xapi-to call twitter.tweet_detail --input "$INPUT" --format json)

DOWNLOADS=$(printf '%s' "$RESPONSE" | jq -cer '
  def tweet_tree:
    .,
    (
      (.quoted_tweet?, .retweeted_tweet?)
      | select(type == "object")
      | tweet_tree
    );

  if .success != true then
    error("xAPI call failed")
  elif (.data.tweet | type) != "object" then
    error("tweet detail returned no main tweet")
  else
    [
      .data.tweet
      | tweet_tree
      | .media[]?
      | select(.type == "video" or .type == "animated_gif")
      | select((.video_url? | type) == "string" and (.video_url | length) > 0)
      | {url: .video_url}
    ]
    | unique_by(.url)
    | if length == 0 then error("tweet has no downloadable MP4") else . end
  end
')

COUNT=$(printf '%s' "$DOWNLOADS" | jq -r 'length')
URLS=()
OUTPUTS=()
TEMP_FILES=()

for ((INDEX = 0; INDEX < COUNT; INDEX++)); do
  VIDEO_URL=$(printf '%s' "$DOWNLOADS" | jq -r --argjson index "$INDEX" '.[$index].url')
  [[ "$VIDEO_URL" =~ ^https://video\.twimg\.com/ ]] ||
    die "refusing unexpected media URL outside https://video.twimg.com/"
  URLS+=("$VIDEO_URL")
  if ((COUNT == 1)); then
    OUTPUT="$OUTPUT_DIR/tweet-$TWEET_ID.mp4"
  else
    OUTPUT="$OUTPUT_DIR/tweet-$TWEET_ID-$((INDEX + 1)).mp4"
  fi
  [ ! -e "$OUTPUT" ] || die "output already exists: $OUTPUT"
  OUTPUTS+=("$OUTPUT")
done

cleanup() {
  if ((${#TEMP_FILES[@]})); then
    for temporary_file in "${TEMP_FILES[@]}"; do
      [ -z "$temporary_file" ] || rm -f -- "$temporary_file"
    done
  fi
}
trap cleanup EXIT

for ((INDEX = 0; INDEX < COUNT; INDEX++)); do
  OUTPUT=${OUTPUTS[$INDEX]}
  TEMP_FILE=$(mktemp "$OUTPUT.part.XXXXXX")
  TEMP_FILES+=("$TEMP_FILE")

  curl --proto '=https' --proto-redir '=https' \
    --fail --location --silent --show-error \
    --output "$TEMP_FILE" "${URLS[$INDEX]}"

  MIME_TYPE=$(file --brief --mime-type "$TEMP_FILE")
  [ "$MIME_TYPE" = 'video/mp4' ] ||
    die "downloaded content is not video/mp4 (got $MIME_TYPE)"

  if command -v ffprobe >/dev/null 2>&1; then
    ffprobe -v error "$TEMP_FILE" >/dev/null ||
      die "ffprobe rejected the downloaded MP4"
  fi
done

# Publish files only after every download has passed validation.
for ((INDEX = 0; INDEX < COUNT; INDEX++)); do
  mv -- "${TEMP_FILES[$INDEX]}" "${OUTPUTS[$INDEX]}"
  TEMP_FILES[$INDEX]=''
  echo "Downloaded: ${OUTPUTS[$INDEX]}"
done

trap - EXIT
