#!/usr/bin/env bash
# Start Triton's OpenAI-compatible frontend over its vLLM backend.
#
# The frontend renders the chat template itself and accepts no template arguments, so
# two things the gate relies on are fixed here instead of per request:
#   - thinking is off, as chat_template_kwargs does on the plain vLLM path;
#   - the tool list is not rendered into the prompt. Grapevine sends its JSON Schema as
#     the parameters of one named tool because that is the only way this frontend
#     constrains decoding; the schema is already in the system message, and the model
#     should see the same prompt it sees on vLLM.
#
# The KServe HTTP endpoint is on only so the pin check can read the server version
# and the model's backend (llm/grapevine_llm/pins.py). Compose publishes the two HTTP
# ports on loopback and nothing else.
set -euo pipefail

MODEL_DIR="${TRITON_MODEL_PATH:-/models/RedHatAI/Qwen3.8-27B-INT4}"
TEMPLATE=/tmp/grapevine_chat_template.jinja
{
  printf '%s\n' '{%- set tools = none -%}{%- set enable_thinking = false -%}'
  cat "$MODEL_DIR/chat_template.jinja"
} > "$TEMPLATE"

cd /opt/tritonserver/python/openai
exec python3 openai_frontend/main.py \
  --model-repository /triton/model_repository \
  --tokenizer "$MODEL_DIR" \
  --chat-template "$TEMPLATE" \
  --host 0.0.0.0 \
  --openai-port 9000 \
  --enable-kserve-frontends \
  --kserve-http-port 9001 \
  --kserve-grpc-port 9002 \
  --default-max-tokens 4096
