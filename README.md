<p align="center"><img src="https://raw.githubusercontent.com/IPv4Addr/grafana-clarity/main/src/img/logo.svg" width="96" alt="Clarity logo"></p>

<h1 align="center">Clarity</h1>

<p align="center">An on-prem AI assistant for Grafana, powered by the model you choose: OpenAI, Anthropic, Ollama or OpenRouter.</p>

<p align="center"><em>A question goes in, a spectrum of metrics, logs and traces comes out.<br>There is no dark side of your stack, really. Matter of fact, it's all queryable.</em></p>

Ask Grafana things like "is payments running?", "which traces are slow?" or "why is this alert firing?". Clarity has the model write and run the PromQL, LogQL and TraceQL, read the alerts and follow the trail across services, then answers. Every query it runs is shown next to the answer as a Grafana panel with an **Explore** link.

## Clarity or Grafana Assistant?

If you use Grafana Cloud, use [Grafana Assistant](https://grafana.com/docs/grafana-cloud/platform/grafana-assistant/): Grafana Labs' own assistant. It runs in Grafana Cloud, and a self-managed Grafana can only use it by connecting to a Grafana Cloud backend. Clarity is for when that is not an option: it runs entirely inside your own Grafana, needs no Grafana Cloud account, queries your own Prometheus, Loki and Tempo with each user's permissions, and uses the model you set up, including a local one through Ollama, so nothing has to leave your network.

## Requirements

- Grafana 13.2 or later (OSS or Enterprise).
- [Grafana's LLM app](https://grafana.com/grafana/plugins/grafana-llm-app/) (`grafana-llm-app`), set up with a model that supports tool calling. Clarity has no model settings of its own: it uses the LLM app, which keeps the API key on the Grafana server.
- Prometheus/Mimir, Loki and/or Tempo datasources to ask about.

## Install

Clarity has been submitted to the Grafana plugin catalog. The review is still pending, and it is not known yet whether it will be accepted. Until then, install it from a [GitHub release](https://github.com/IPv4Addr/grafana-clarity/releases). Each release has `ipv4addr-clarity-app-<version>.zip`; the Grafana CLI installs it together with the LLM app it depends on:

```bash
grafana cli --pluginUrl https://github.com/IPv4Addr/grafana-clarity/releases/download/v1.0.0/ipv4addr-clarity-app-1.0.0.zip plugins install ipv4addr-clarity-app
```

In the official Docker image: `GF_PLUGINS_PREINSTALL_SYNC=grafana-llm-app,ipv4addr-clarity-app@1.0.0@<zip URL>`. While a release is unsigned, also allow it with `GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=ipv4addr-clarity-app`.

Then restart Grafana, enable Clarity under **Administration → Plugins and data → Plugins → Clarity**, and set up the model in the LLM app (next section).

Behind a reverse proxy, allow WebSocket upgrades for `/api/live/ws`: answers stream over Grafana Live.

## Setting up the model

Open the LLM app (`/plugins/grafana-llm-app`), choose the provider, enter the URL, key and models, and click **Save & test**.

| Provider   | In the LLM app            | API URL                                            | API key  |
| ---------- | ------------------------- | -------------------------------------------------- | -------- |
| OpenAI     | OpenAI-compatible, OpenAI | (fixed)                                            | required |
| Anthropic  | Anthropic                 | empty for the default                              | required |
| Ollama     | Custom API                | `http://<ollama-host>:11434`, as seen from Grafana | none     |
| OpenRouter | Custom API                | `https://openrouter.ai/api`                        | required |

- Clarity uses the LLM app's **Large** model. For Ollama and OpenRouter, fill in both Base and Large (e.g. `qwen3`, or `openai/gpt-6-luna` on OpenRouter).
- **Ollama:** Grafana's server calls it, so the URL must work from there (`http://host.docker.internal:11434` when Grafana runs in Docker). Raise Ollama's context window (`OLLAMA_CONTEXT_LENGTH=32768`): Clarity's instructions and tool results do not fit the default, and Ollama silently cuts what does not fit. Bigger models investigate better.
- If the LLM app is missing or not working, Clarity says so and links to it.

## Using it

- **Page:** **More apps → Clarity**.
- **Panel menu:** **Extensions → Ask Clarity** explains a panel and checks it for problems.
- **Links:** `/a/ipv4addr-clarity-app?q=<question>` opens Clarity and asks right away, for example from an alert notification template:

  ```
  {{ .ExternalURL }}a/ipv4addr-clarity-app?q={{ urlquery (printf "Why is the alert %s firing?" .CommonLabels.alertname) }}
  ```

- Each answer ends with suggested follow-up questions and a usage line (model, calls, tokens). **Copy as Markdown** exports the conversation for an incident channel, and **Continue** resumes a stopped or failed run.

## Privacy and security

- **Keys** stay in the LLM app on the Grafana server; Clarity stores nothing.
- **Queries** run as the signed-in user and only read. A Viewer can query every datasource they may read, even without Explore.
- **Sent to the model:** the questions, summarized query results, the current time, the Grafana page URL (minus any `auth_token`) and your datasource names. With Ollama, it stays on your hardware.
- **Everyone who can sign in spends the LLM app's key.** Use a key with a spending limit.
- **Prompt injection:** logs and labels can contain text aimed at the model. The tools only read, and answers cannot load images or other remote content.

## Planned

Not there yet, and in no particular order:

- **Profiling:** Pyroscope. The model picks the profile type and labels, finds the functions that use the most CPU or memory, and shows them as a Grafana flame graph. From a slow trace span it can go on to that span's profile.
- **More datasources:**
  - logs: Elasticsearch and OpenSearch
  - metrics: InfluxDB and Graphite
  - SQL: PostgreSQL, MySQL, Microsoft SQL Server and ClickHouse
  - cloud: Amazon CloudWatch, Azure Monitor and Google Cloud Monitoring
  - traces: Jaeger and Zipkin

  They'll work like the ones supported today: queries only read, run as the signed-in user, and show up as Grafana panels.

## Development

```bash
npm install
npm run build
docker compose up -d        # Grafana 13.2 with Clarity, the LLM app and a HotROD demo on Prometheus, Loki and Tempo
```

Then set up the LLM app at http://localhost:3000/plugins/grafana-llm-app. Add `--profile ollama` for a local model (`docker compose exec ollama ollama pull qwen3`, then Custom API `http://ollama:11434`).

```bash
npm run dev          # rebuild on save
npm run typecheck && npm run lint && npm run test:ci
docker compose --profile e2e up -d && npm run e2e    # end-to-end, with a scripted model in place of a provider
```

Every CI run keeps the build as an artifact (`ipv4addr-clarity-app-<version>`). To release, add the version to `CHANGELOG.md`, then `npm version <x.y.z>` (updates `package.json` and tags `vX.Y.Z`) and `git push --follow-tags`: `.github/workflows/release.yml` builds the plugin, signs it once the `GRAFANA_ACCESS_POLICY_TOKEN` secret is set, and publishes a GitHub release with the zip and its SHA1.

## License

[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)
