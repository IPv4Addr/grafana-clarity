# Changelog

## 1.0.0

Initial release.

- Ask questions about your metrics, logs, traces and alerts in plain language. The model writes and runs PromQL, LogQL and TraceQL and reads alert rules through Grafana's API with your permissions.
- Every query is shown inline as a native Grafana panel with an Explore link.
- Works with OpenAI, Azure OpenAI, Anthropic, and OpenAI-compatible APIs such as Ollama and OpenRouter, through Grafana's LLM app (`grafana-llm-app`): the model is set up once there, and its key stays in the LLM app's encrypted settings on the Grafana server. Clarity has no settings of its own and shows what is missing until the LLM app works.
- Its own page, and **Ask Clarity** in every panel menu to explain a panel and check it for problems.
- `?q=` links that open Clarity and ask a question, e.g. from alert notifications.
- Suggested follow-up questions, **Copy as Markdown**, and **Continue** after a stop or an error.
- The model, model calls and tokens (cached ones included) under every answer; reasoning shown as progress notes where the provider streams it.
