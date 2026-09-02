# Third-party notices

Grapevine is licensed under Apache-2.0 (see [LICENSE](LICENSE)). The pieces
below carry their own terms. Nothing is modified except where noted.

## Vendored in this repository

| What | Where | License | Source |
|---|---|---|---|
| Mapbox agent skills (five of them) | `.agents/skills/mapbox-*` | MIT | github.com/mapbox/mapbox-agent-skills |
| Supabase agent skills (two) | `.agents/skills/supabase*` | MIT | github.com/supabase/agent-skills |
| Langfuse `docker-compose.yml` | `observability/langfuse/docker-compose.yml` | MIT | github.com/langfuse/langfuse, unmodified; the override file next to it is ours |
| Langfuse managed evaluator templates | `server/scripts/langfuse/managed-templates.json` | MIT | captured from the managed library in the Langfuse UI |

## Fetched at run time or install time

| What | Used by | License | Notes |
|---|---|---|---|
| Llama Prompt Guard 2 (86M), ONNX port | the input and content rails, `server/src/agent/guardrails.ts` | Llama 4 Community License | The weights download from Hugging Face on first run (`gravitee-io/Llama-Prompt-Guard-2-86M-onnx`, an ungated int8 port of `meta-llama/Llama-Prompt-Guard-2-86M`). Meta's license governs the weights; read it before redistributing them or a build that bundles them. |
| PyRIT | the red-team eval suite, `server/redteam/` | MIT | Microsoft. Installed into a local virtualenv from `requirements.txt`, never vendored. |
| models.dev catalog | Admin, Models, `server/src/catalog.ts` | MIT | Fetched from models.dev/api.json at run time; provider logos come from the same site. |
| npm and PyPI dependencies | everything | each its own | See each `package.json` and `server/redteam/requirements.txt`. |
