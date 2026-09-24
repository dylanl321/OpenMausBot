# Amazon Bedrock

Amazon Bedrock is a cloud engine in **Settings → Engines**. It supports
conversational models on Bedrock Runtime and Bedrock Mantle, including
Anthropic, Amazon, Meta, Mistral, OpenAI and other providers exposed by the
selected endpoint. The catalog comes from AWS, rather than a bundled list of
model names. Embedding, reranking, image-generation and speech models are not
bot engines.

Bedrock conversations use the same threads, rooms, streaming, approvals and
MCP integrations as other engines. Models with tool support can use agent,
connected-app, browser, computer, phone and custom MCP tools when those
capabilities are enabled for the bot. Models without tools remain available
for chat; image inputs and tool controls follow the selected model's
capabilities. Bedrock does not provide a local CLI's filesystem or shell by
itself; connect the appropriate tools when the bot needs them.

## Connect in Settings

1. Expand **Amazon Bedrock** in **Settings → Engines**.
2. Leave authentication on **Automatic — prefer Bedrock token** and enter a
   Bedrock token, or select an AWS profile, access keys, or the AWS credential
   chain. A Bedrock token means a Bedrock API key, including short-term keys;
   it is different from an AWS session token.
3. Enter the AWS region, or leave it blank to use the environment or profile.
   Choose **Bedrock Runtime** for native Converse and inference profiles, or
   **Bedrock Mantle** for its regional catalog.
4. Select **Test connection / load models**. Check the resolved region,
   credential source and model list. This reads the catalog without sending a
   prompt, invoking a model, or saving the draft. Inference permissions are
   checked when you send a message.
5. Set access controls and **Save**. Choose the connection and model in the
   conversation's model picker.

All models, including Claude, are allowed by default. Clear **Allow Anthropic
and Claude models** to block the entire provider. Clear a model's checkbox to
block that model. Blocking a foundation model also blocks its geographic
profiles and application-profile aliases. The advanced blocked-model list
accepts one ID or ARN per line.

The model list shows regional models and profile destinations separately.
Changing the region, endpoint, profile or credentials clears the draft
catalog until you load it again. A late response for an older draft cannot
replace the new region's list. Search includes underlying model IDs for
application profiles. A partially accessible catalog is labeled incomplete;
an empty list does not silently substitute another region's models.

Saved credentials are write-only: responses expose configured flags and
sources, never their values. Leave a secret input blank to keep its saved
value. Use the separate removal checkbox to clear saved credentials and use
the environment. Set both AWS access keys together; replacing them clears an
old session token unless you supply a new one. Secrets are stored as plaintext
in the private `config.json` file (`0600` on Unix), like other API credentials.
The environment or AWS profiles can keep credentials outside that file.

## Environment and profiles

Set environment variables on the **OpenMausBot server process**. A desktop
application launched from a dock may not inherit a terminal's environment;
use Settings or a profile available to the server's OS account in that case.

| Setting | Source |
| --- | --- |
| Preferred Bedrock token | `OMB_BEDROCK_API_KEY`, then `AWS_BEARER_TOKEN_BEDROCK`, then legacy `BEDROCK_API_KEY` |
| Region | `AWS_REGION`, then `AWS_DEFAULT_REGION` |
| Named profile | `AWS_PROFILE`, then `AWS_DEFAULT_PROFILE` |
| Static AWS credentials | `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` |
| Temporary AWS credentials | Both keys above plus `AWS_SESSION_TOKEN` |
| Shared profile files | `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE`, or the SDK's usual `~/.aws` paths |

For example, start the server from a terminal with a token already supplied
by your environment:

```sh
export AWS_REGION=us-east-1
# Supply AWS_BEARER_TOKEN_BEDROCK through your environment or secret manager.
pnpm dev:server
```

Or select a profile in Settings, or in the server's environment:

```sh
aws sso login --profile work
export AWS_PROFILE=work
pnpm dev:server
```

Profiles support the AWS SDK's shared configuration, SSO, assumed roles,
`credential_process` and credential sources. Expiring profile and workload
credentials refresh through the SDK. An explicitly selected profile that
fails does not fall through to an unrelated account. Renew an expired SSO
login with `aws sso login --profile NAME`. Short-term **Bedrock tokens** must
be replaced when they expire; they are not refreshable AWS role credentials.

Authentication modes are explicit:

| Mode | Behavior |
| --- | --- |
| `auto` (default) | Saved token, then `OMB_BEDROCK_API_KEY`, `AWS_BEARER_TOKEN_BEDROCK`, and legacy `BEDROCK_API_KEY`. Without a token, use the selected profile; otherwise use configured AWS keys or the standard AWS credential chain. An explicit token environment variable or header selects token authentication even if the token is missing. |
| `api-key` (also `bearer`) | Require a Bedrock token from Settings/config or the environment. |
| `profile` | Use the named profile, falling back to the `default` profile name. Ignore Bedrock tokens and saved access keys. |
| `access-keys` | Use a complete saved AWS key pair or a complete environment pair, with its optional session token. Never combine halves from different sources. |
| `aws` | Use AWS credentials, ignoring saved Bedrock tokens and saved access keys. The selected profile or standard SDK chain can resolve workload roles. |

An instance's token variables take precedence over all ambient token aliases.
If an instance explicitly binds an empty token variable, token authentication
reports that missing value instead of using another account's process token.
An explicit `apiKeyEnv` selects only its named variable. Saved `apiKey` values
take precedence over either environment source.

Region resolution is independent of authentication, in this order:

1. The connection's `region` setting.
2. `AWS_REGION`.
3. `AWS_DEFAULT_REGION`.
4. The selected profile's region in the shared AWS config file.
5. `us-east-1`.

Settings and the model picker display the resolved region. Regional model
ARNs must match it. The app does not scan all regions or move a request to
another region after a failure.

For containers, explicitly pass these variables to the server container, or
use Settings/config inside its persistent data volume. Compose's `.env` file
alone does not forward arbitrary variables into a container. Profile files
and any SSO cache must be available to the server inside that container.

## US-only models and inference

Enable **US-only models and inference**, or set `usOnly: true`. This permits
US regional endpoints and inference destinations, including US geographic
profiles. It rejects:

- A non-US source region or regional model ARN.
- Global profiles, even if their currently reported destinations are in the US.
- Non-US geographic profiles, or any application/provisioned/custom model
  whose backing metadata includes a non-US destination.
- A restricted opaque model whose backing metadata cannot be read and verified.
- Endpoint overrides that are not regional AWS Bedrock endpoints in the
  selected region. Regional Bedrock PrivateLink endpoints are supported.

Access policy is enforced before every inference request, including helper
responses and continuation after a tool call. It is not just a model-picker
filter. Profile metadata is resolved again before inference, so a profile's
changed backing model cannot bypass a provider or region restriction.
Mantle serves models in the selected endpoint's region and does not accept
Runtime inference-profile IDs or ARNs.

Use separate Bedrock connections for different regions or accounts. These
settings govern requests made by this connection; use AWS IAM/SCP policies
when restrictions must apply to other clients or prevent an administrator
from changing application settings. AWS's geography rules are described in
[cross-Region inference](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html).

## Configuration file

Configure connections in the data directory's `config.json`. Merge these
entries with your existing configuration:

```json
{
  "instances": {
    "bedrock": {
      "driver": "bedrock",
      "displayName": "Bedrock US",
      "config": {
        "auth": "profile",
        "profile": "work",
        "region": "us-east-1",
        "endpoint": "runtime",
        "usOnly": true,
        "allowAnthropic": false,
        "blockedModels": []
      }
    },
    "bedrock-mantle": {
      "driver": "bedrock",
      "displayName": "Bedrock Mantle",
      "config": {
        "auth": "api-key",
        "region": "us-west-2",
        "endpoint": "mantle"
      }
    }
  }
}
```

The Mantle connection above uses an environment token. Alternatively, its
`config` may contain `apiKey`, or `accessKeyId`, `secretAccessKey` and optional
`sessionToken` with `auth: "access-keys"`. Each instance may also have an
`environment` map of the variables above. Per-instance settings take
precedence over the optional workspace-wide `bedrock` defaults.

Optional advanced settings:

| Key | Purpose |
| --- | --- |
| `model` | Default or manually entered model ID, inference-profile ID, or ARN. Manual entries are labeled as region-unverified until discovered. |
| `api` | `auto`, `converse`, `chat-completions`, or `messages`. Automatic uses Converse on Runtime, Chat Completions for closed-weight OpenAI/xAI models, and Messages for Claude on Mantle. Converse is unavailable on Mantle. |
| `maxTokens` | Positive output-token limit. Leave blank for the model/API default; Messages defaults to 4096. A null value in a settings PATCH clears a saved limit. |
| `tools` | Set `false` to disable all tool discovery and execution for this connection. |
| `blockedModels` | IDs/ARNs excluded from this connection, including their resolved aliases. |
| `apiKeyEnv` | Explicit token environment variable. With no saved token, only this variable is used; a missing value does not fall through to another account. |
| `apiKeyHeader` | Gateway token header. Defaults to `Authorization: Bearer …` (Messages uses `x-api-key`); nonstandard headers require an explicit URL. Protocol, signing and routing headers are rejected. |
| `url` / `controlUrl` | Runtime/Mantle and native control-plane base URLs, including gateway path prefixes. HTTPS is required, except loopback HTTP for development fixtures. Regional AWS overrides must match the configured region. |

For a token gateway, set `auth: "api-key"`, `apiKeyEnv: "GATEWAY_BEDROCK_TOKEN"`,
`url: "https://gateway.example/bedrock"` and its required `apiKeyHeader`, such
as `"x-api-key"`. A custom header also sends control-plane catalog requests to
that base URL unless `controlUrl` is supplied. Gateways using the default
Authorization header should explicitly configure `controlUrl` if discovery
also goes through the gateway. Non-AWS gateways are incompatible with
`usOnly` because their inference destinations cannot be verified.

Tokens sent in Authorization may contain a leading `Bearer` prefix; it is
normalized to one prefix. Gateway headers receive the raw token value. Named
token variables are redacted from errors and excluded from the environment
inherited by tool subprocesses unless explicitly granted to that tool server.

Use the explicit endpoint settings for private endpoints. Ambient
`AWS_ENDPOINT_URL` and service-specific endpoint overrides are ignored so
they cannot silently redirect a region-restricted connection.

The terminal wizard also offers **Amazon Bedrock** through `openmausbot setup`.
It accepts tokens, profiles and keys, loads the regional catalog, and sets US
and Anthropic access controls. Its catalog check never invokes a model.
Per-model controls are available in Settings after setup.

## AWS access and troubleshooting

Authentication and model availability are separate. A valid token or profile
does not grant model access. Runtime catalog discovery uses
`bedrock:ListFoundationModels`, `bedrock:ListInferenceProfiles` and
`bedrock:GetFoundationModelAvailability`. Inference uses
`bedrock:InvokeModel` / `bedrock:InvokeModelWithResponseStream`. Restricted
profiles and custom/provisioned models additionally need their corresponding
`GetInferenceProfile`, `GetCustomModel` or `GetProvisionedModelThroughput`
metadata permissions. Unfamiliar model namespaces use `GetFoundationModel`
metadata as well, so new geographies cannot bypass a routing restriction.
Mantle uses its own model-list and
`bedrock-mantle:CreateInference` permissions.

An account with invocation permission but limited catalog permissions can
use a manual model ID. The UI reports discovery failures and unverified
availability; it does not claim an inference test passed. A restriction that
requires unreadable backing metadata fails closed. Regional availability,
entitlement, marketplace/model access and inference quotas remain AWS checks.

Runtime discovery never calls `/models`: that endpoint does not implement
it. Mantle uses `/v1/models`, which can contain different IDs and models than
Runtime. Runtime uses native AWS Converse event streams, or
`/openai/v1/chat/completions`; Mantle uses `/v1/chat/completions`. Claude's
Messages route is `/anthropic/v1/messages` on either endpoint. New models can
be selected from the catalog without an app release, with explicit API and
tool settings available for models whose capabilities differ.

OpenAI GPT-5.6 and GPT-6 Sol/Luna Chat Completions requests use reasoning
effort `none` for tool compatibility. GPT-6 Astra uses `low` and is offered
for chat; its agent tool calling requires a Responses-capable route such as a
configured Codex provider. See [custom engine routes](custom-engines.md).

References: [AWS endpoints](https://docs.aws.amazon.com/bedrock/latest/userguide/endpoints.html),
[Bedrock API keys](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html),
[regional model availability](https://docs.aws.amazon.com/bedrock/latest/userguide/models-region-compatibility.html),
and the [isolated verification recipe](verification/bedrock.md).
